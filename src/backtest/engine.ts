import type { OhlcvBar } from "../types/index.ts";
import type {
  Strategy,
  OrderIntent,
  TradeRecord,
  EngineState,
  BacktestConfig,
  FeeModel,
  BacktestResult,
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
  /** Effective all-in cost per unit: (fillPrice × (1 + slippage) + fee) / volume. */
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
 * Order rejection (silent):
 *   - price × volume < minOrderCost
 *   - price ≤ 0 or volume ≤ 0
 *   - buy: estimated total (cost × (1 + makerFee)) > available cash
 *   - sell: requested volume > open position
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

      // Apply slippage to get effective fill price.
      const fillPrice =
        order.side === "buy"
          ? order.price * (1 + fee.slippage)
          : order.price * (1 - fee.slippage);

      const fillValue = fillPrice * order.volume;
      const filledFee = fillValue * fee.makerFee;

      if (order.side === "buy") {
        cash -= fillValue + filledFee;
        position += order.volume;

        // Track cost basis for FIFO round-trip PnL matching.
        const costPerUnit = (fillValue + filledFee) / order.volume;
        buyLots.push({ effectiveCostPerUnit: costPerUnit, volume: order.volume });
      } else {
        cash += fillValue - filledFee;
        position -= order.volume;
        if (position < 0) position = 0; // guard floating-point drift

        // FIFO-match against buy lots for round-trip PnL tracking.
        const netProceedsPerUnit = (fillValue - filledFee) / order.volume;
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
        price: fillPrice,
        volume: order.volume,
        fee: filledFee,
        tag: order.tag,
      });
    }

    resting.length = 0;
    for (const o of stillResting) resting.push(o);

    // ── 2. Mark-to-market equity ─────────────────────────────────────────
    const equity = cash + position * bar.close;
    equityCurve.push(equity);

    // ── 3. Strategy call ─────────────────────────────────────────────────
    const state: EngineState = { cash, position, equity, barIndex: i };
    const intents = strategy.onBar(bar, state);

    // ── 4. Validate and queue intents ────────────────────────────────────
    for (const intent of intents) {
      if (validateIntent(intent, cash, position, fee.makerFee, minOrderCost)) {
        resting.push({
          side: intent.side,
          price: intent.price,
          volume: intent.volume,
          tag: intent.tag ?? "",
          placedBarIndex: i,
        });
      }
    }
  }

  const stats = computeStats(
    equityCurve,
    trades,
    roundTripPnls,
    config.initialCash,
    config.intervalMinutes,
  );

  return { trades, equityCurve, roundTripPnls, stats };
}

// ── Validation ────────────────────────────────────────────────────────────────

function validateIntent(
  intent: OrderIntent,
  cash: number,
  position: number,
  makerFee: number,
  minOrderCost: number,
): boolean {
  if (intent.price <= 0 || intent.volume <= 0) return false;
  const cost = intent.price * intent.volume;
  if (cost < minOrderCost) return false;
  if (intent.side === "buy") {
    // Rough estimate including fee; actual fill may differ due to slippage.
    return cost * (1 + makerFee) <= cash;
  }
  return intent.volume <= position;
}
