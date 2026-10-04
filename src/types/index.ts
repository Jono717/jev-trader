/**
 * Core domain types for jev-trader.
 *
 * These are type-only definitions. Trading logic, order routing, and risk
 * management live in later PRs (PR 2: backtesting harness, PR 3: grid strategy).
 */

/** A single OHLCV bar from the exchange. */
export interface OhlcvBar {
  pair: string;
  interval: number; // bar width in minutes (e.g. 15)
  ts: number; // bar open time, Unix seconds (UTC)
  open: number;
  high: number;
  low: number;
  close: number;
  vwap: number; // volume-weighted average price
  volume: number; // base-currency volume traded in the bar
  count: number; // number of individual trades in the bar
}

/** Direction of a trade or order. */
export type Side = "buy" | "sell";

/**
 * Exchange order type. Limit-only by design: every entry and exit rests on the
 * order book (see README, "Design philosophy").
 */
export type OrderType = "limit";

/** Lifecycle state of an order as tracked locally. */
export type OrderStatus =
  | "pending" // created locally, not yet submitted
  | "open" // resting on the order book
  | "closed" // fully filled
  | "canceled" // canceled before full fill
  | "expired"; // time-in-force expired

/**
 * An order placed (or to be placed) on the exchange.
 * `id` is null until the exchange acknowledges submission.
 */
export interface Order {
  id: string | null; // exchange-assigned order ID
  clientOrderId?: string; // local reference for idempotency
  pair: string;
  side: Side;
  type: OrderType;
  price: number; // limit price
  volume: number; // base-currency volume requested
  filledVolume: number;
  remainingVolume: number;
  averageFillPrice: number | null;
  status: OrderStatus;
  createdAt: number; // Unix seconds (UTC)
  updatedAt: number; // Unix seconds (UTC)
}

/** A single trade execution (fill) against an order. */
export interface Fill {
  tradeId: string; // exchange-assigned trade ID
  orderId: string;
  pair: string;
  side: Side;
  price: number;
  volume: number;
  fee: number;
  feeCurrency: string;
  ts: number; // Unix seconds (UTC)
}

/**
 * Aggregated open position in a trading pair.
 * Used by the risk manager and grid strategy in later PRs.
 * Spot-only: a position is either long or flat — "flat" means no open position.
 */
export interface Position {
  pair: string;
  side: "long" | "flat";
  volume: number;
  avgEntryPrice: number;
  unrealizedPnl: number;
  realizedPnl: number;
  updatedAt: number; // Unix seconds (UTC)
}
