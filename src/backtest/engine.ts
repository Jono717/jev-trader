import type { OhlcvBar } from "../types/index.ts";
import type {
  Strategy,
  OrderIntent,
  TradeRecord,
  EngineState,
  BacktestConfig,
  FeeModel,
  BacktestResult,
  RejectedOrder,
  RejectionReason,
} from "./types.ts";
import { computeStats } from "./stats.ts";

// ── Internal types ────────────────────────────────────────────────────────────

interface RestingOrder {
  side: "buy" | "sell";
  price: number;
  volume: number;
  tag: string;
  placedBarIndex: number;
}

interface BuyLot {
  /** Effective all-in cost per unit: (fillValue + fee) / volume. */
  effectiveCostPerUnit: number;
  volume: number;
}

// ── Defaults ──────────────────────────────────────────────────────────────────

const DEFAULT_FEE: FeeModel = {
  makerFee: 0.0016, // 0.16 %  Kraken maker
  takerFee: 0.0026, // 0.26 %  Kraken taker (reserved)
  slippage: 0,      // limit orders have zero default slippage
};

const DEFAULT_MIN_ORDER_COST = 5; // USD — Kraken minimum

// ── Engine ────────────────────────────────────────────────────────────────────

/**
 * Event-driven backtest engine.
 *
 * Processes `bars` in chronological order.  On each bar:
 *   1. Check all resting orders for fills (orders cannot fill on the bar they
 *      were placed — only on later bars).
 *   2. Compute mark-to-market equity and append to the equity curve.
 *   3. Call `strategy.onBar`; validate and queue any returned intents.
 *
 * Fill rule (conservative, no lookahead):
 *   - Resting limit buy at P fills when a **later** bar's low ≤ P.
 *   - Resting limit sell at P fills when a **later** bar's high ≥ P.
 *
 * Slippage: buy fill = P × (1 + slippage); sell fill = P × (1 − slippage).
 * All fills use the maker fee (limit orders only).
 *
 * Order rejection (reported, never silent — see `BacktestResult.rejectedOrders`):
 *   - price × volume < minOrderCost
 *   - price ≤ 0 or volume ≤ 0
 *   - buy: all-in fill cost exceeds `EngineState.availableCash`
 *   - sell: requested volume exceeds `EngineState.availablePosition`
 *
 * Reserving the exposure of resting orders is what keeps the engine spot-only:
 * cash never goes negative and the position is never short, even when a
 * strategy rests a whole ladder of orders on one bar.  `EngineState` exposes
 * the spendable `availableCash` / `availablePosition` so a strategy can size
 * against the same figures the engine validates against.
 *
 * At end-of-backtest any unfilled resting orders are discarded; unrealised PnL
 * on open positions is captured in the final equity curve value.
 */
export function runBacktest(
  bars: readonly OhlcvBar[],
  strategy: Strategy,
  config: BacktestConfig,
): BacktestResult {
  const fee: FeeModel = {
    makerFee: config.fee?.makerFee ?? DEFAULT_FEE.makerFee,
    takerFee: config.fee?.takerFee ?? DEFAULT_FEE.takerFee,
    slippage: config.fee?.slippage ?? DEFAULT_FEE.slippage,
  };
  const minOrderCost = config.minOrderCost ?? DEFAULT_MIN_ORDER_COST;

  let cash = config.initialCash;
  let position = 0;
  const resting: RestingOrder[] = [];
  const trades: TradeRecord[] = [];
  const equityCurve: number[] = [];
  const buyLots: BuyLot[] = []; // FIFO queue for round-trip PnL tracking
  const roundTripPnls: number[] = [];
  const rejectedOrders: RejectedOrder[] = [];

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i]!;

    // ── 1. Fill check ─────────────────────────────────────────────────────
    const stillResting: RestingOrder[] = [];

    for (const order of resting) {
      // Orders cannot fill on the bar they were placed.
      if (order.placedBarIndex >= i) {
        stillResting.push(order);
        continue;
      }

      const fills =
        (order.side === "buy" && bar.low <= order.price) ||
        (order.side === "sell" && bar.high >= order.price);

      if (!fills) {
        stillResting.push(order);
        continue;
      }

      const econ = fillEconomics(
        order.side,
        order.price,
        order.volume,
        fee,
      );
      cash += econ.cashDelta;

      if (order.side === "buy") {
        position += order.volume;

        // Track cost basis for FIFO round-trip PnL matching.
        buyLots.push({
          effectiveCostPerUnit: -econ.cashDelta / order.volume,
          volume: order.volume,
        });
      } else {
        position -= order.volume;
        if (position < 0) position = 0; // guard floating-point drift

        // FIFO-match against buy lots for round-trip PnL tracking.
        const netProceedsPerUnit = econ.cashDelta / order.volume;
        let remaining = order.volume;
        while (remaining > 1e-12 && buyLots.length > 0) {
          const lot = buyLots[0]!;
          const matched = Math.min(remaining, lot.volume);
          roundTripPnls.push(
            (netProceedsPerUnit - lot.effectiveCostPerUnit) * matched,
          );
          lot.volume -= matched;
          remaining -= matched;
          if (lot.volume <= 1e-12) buyLots.shift();
        }
      }

      trades.push({
        barIndex: i,
        ts: bar.ts,
        side: order.side,
        price: econ.fillPrice,
        volume: order.volume,
        fee: econ.fee,
        tag: order.tag,
      });
    }

    resting.length = 0;
    for (const o of stillResting) resting.push(o);

    // ── 2. Mark-to-market equity ─────────────────────────────────────────
    const equity = cash + position * bar.close;
    equityCurve.push(equity);

    // ── 3. Strategy call ─────────────────────────────────────────────────
    let availableCash = cash;
    let availablePosition = position;
    for (const o of resting) {
      if (o.side === "buy") availableCash -= buyCost(o.price, o.volume, fee);
      else availablePosition -= o.volume;
    }

    const state: EngineState = {
      cash,
      availableCash,
      position,
      availablePosition,
      equity,
      barIndex: i,
      fee,
    };
    const intents = strategy.onBar(bar, state);

    // ── 4. Validate and queue intents ────────────────────────────────────
    for (const intent of intents) {
      const reason = rejectionReason(
        intent,
        availableCash,
        availablePosition,
        fee,
        minOrderCost,
      );
      if (reason !== null) {
        rejectedOrders.push({ barIndex: i, ts: bar.ts, intent, reason });
        continue;
      }

      resting.push({
        side: intent.side,
        price: intent.price,
        volume: intent.volume,
        tag: intent.tag ?? "",
        placedBarIndex: i,
      });

      if (intent.side === "buy") {
        availableCash -= buyCost(intent.price, intent.volume, fee);
      } else {
        availablePosition -= intent.volume;
      }
    }
  }

  const stats = computeStats(
    equityCurve,
    trades,
    roundTripPnls,
    config.initialCash,
    config.intervalMinutes,
    rejectedOrders.length,
  );

  return { trades, equityCurve, roundTripPnls, rejectedOrders, stats };
}

// ── Fill economics ────────────────────────────────────────────────────────────

/** What a fill of `volume` at limit `price` actually does to the account. */
export interface FillEconomics {
  /** Effective fill price after slippage. */
  fillPrice: number;
  /** fillPrice × volume, before fees. */
  fillValue: number;
  /** Maker fee paid on the fill value. */
  fee: number;
  /** Change in cash: negative for a buy outlay, positive for sell proceeds. */
  cashDelta: number;
}

/**
 * The single definition of how a limit order converts into cash movement:
 * slippage moves the fill price against the order, and the maker fee is taken
 * on the resulting fill value.  Both the fill path and the pre-trade
 * reservation derive from this, so what is reserved can never diverge from
 * what is spent.
 */
export function fillEconomics(
  side: "buy" | "sell",
  price: number,
  volume: number,
  fee: FeeModel,
): FillEconomics {
  const fillPrice =
    side === "buy" ? price * (1 + fee.slippage) : price * (1 - fee.slippage);
  const fillValue = fillPrice * volume;
  const feePaid = fillValue * fee.makerFee;
  return {
    fillPrice,
    fillValue,
    fee: feePaid,
    cashDelta: side === "buy" ? -(fillValue + feePaid) : fillValue - feePaid,
  };
}

/**
 * All-in cash a buy of `volume` at limit `price` consumes when it fills.
 * This is the figure the engine reserves and validates against
 * `EngineState.availableCash`, so a strategy sizing an order should divide its
 * budget by `buyCost(price, 1, fee)`.
 */
export function buyCost(price: number, volume: number, fee: FeeModel): number {
  return -fillEconomics("buy", price, volume, fee).cashDelta;
}

// ── Validation ────────────────────────────────────────────────────────────────

/**
 * Why `intent` cannot rest, or `null` when it can.  Balances passed in are the
 * spendable remainders, already net of every order resting at this point.
 */
function rejectionReason(
  intent: OrderIntent,
  availableCash: number,
  availablePosition: number,
  fee: FeeModel,
  minOrderCost: number,
): RejectionReason | null {
  if (
    !Number.isFinite(intent.price) ||
    !Number.isFinite(intent.volume) ||
    intent.price <= 0 ||
    intent.volume <= 0
  ) {
    return "invalid";
  }
  if (intent.price * intent.volume < minOrderCost) return "below-min-order-cost";
  if (intent.side === "buy") {
    return buyCost(intent.price, intent.volume, fee) <= availableCash
      ? null
      : "insufficient-available-cash";
  }
  return intent.volume <= availablePosition
    ? null
    : "insufficient-available-position";
}
