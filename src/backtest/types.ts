/**
 * Backtest module types.
 *
 * All trades are limit orders (consistent with the PR-1 design philosophy).
 * The engine handles spot long / flat positions only — no shorts.
 */
import type { OhlcvBar } from "../types/index.ts";

// ── Order intent ──────────────────────────────────────────────────────────────

/** A limit-order intent returned by a strategy on each bar. */
export interface OrderIntent {
  /** Buy (acquire base currency) or sell (release base currency). */
  side: "buy" | "sell";
  /** Limit price in quote currency (e.g. USD). */
  price: number;
  /** Volume in base currency. */
  volume: number;
  /** Optional label written into the trade log. */
  tag?: string;
}

// ── Trade record ──────────────────────────────────────────────────────────────

/** A completed fill as recorded by the engine. */
export interface TradeRecord {
  /** Zero-based index of the bar on which the fill occurred. */
  barIndex: number;
  /** Bar open timestamp (Unix seconds UTC). */
  ts: number;
  side: "buy" | "sell";
  /** Effective fill price after slippage (quote currency). */
  price: number;
  /** Filled volume (base currency). */
  volume: number;
  /** Maker fee paid (quote currency). */
  fee: number;
  /** Strategy-supplied tag, or empty string. */
  tag: string;
}

// ── Engine state ──────────────────────────────────────────────────────────────

/** Snapshot of the engine exposed to the strategy on every bar. */
export interface EngineState {
  /** Available quote-currency balance after fills on this bar. */
  cash: number;
  /** Open base-currency position (long only; flat = 0). */
  position: number;
  /** Mark-to-market equity: cash + position × bar.close. */
  equity: number;
  /** Zero-based index of the current bar. */
  barIndex: number;
}

// ── Strategy ──────────────────────────────────────────────────────────────────

/**
 * Strategy interface consumed by the backtesting engine.
 *
 * `onBar` is called once per bar in chronological order, after any pending
 * fills have been applied.  Returning invalid intents (below minOrderCost,
 * exceeding cash or position) causes a silent rejection.
 */
export interface Strategy {
  onBar(bar: OhlcvBar, state: Readonly<EngineState>): OrderIntent[];
}

// ── Fee / slippage model ──────────────────────────────────────────────────────

/** Fee and slippage model used by the engine. */
export interface FeeModel {
  /** Maker fee fraction (default 0.0016 = 0.16 %). */
  makerFee: number;
  /**
   * Taker fee fraction (default 0.0026 = 0.26 %).
   * Reserved for future market-order support; limit orders use makerFee.
   */
  takerFee: number;
  /**
   * Slippage fraction applied to the fill price.
   * Adds to buy cost, subtracts from sell revenue.  Default 0 for limit orders.
   */
  slippage: number;
}

// ── Backtest configuration ────────────────────────────────────────────────────

/** Configuration for a single backtest run. */
export interface BacktestConfig {
  /** Starting quote-currency balance. */
  initialCash: number;
  /**
   * Bar interval in minutes.  Must match the interval of the bars supplied.
   * Used to annualise Sharpe / Sortino assuming 365-day continuous trading.
   */
  intervalMinutes: number;
  /** Override any part of the fee / slippage model. */
  fee?: Partial<FeeModel>;
  /**
   * Minimum order cost (price × volume) in quote currency.
   * Orders below this threshold are silently rejected.
   * Default 5 (Kraken's $5 minimum order cost).
   */
  minOrderCost?: number;
}

// ── Summary statistics ────────────────────────────────────────────────────────

/**
 * Summary statistics for a completed backtest run.
 *
 * Annualisation: crypto markets trade 24 / 7 continuously, so the annualisation
 * factor is derived from a 365-day year:
 *   barsPerYear = 365 × 24 × 60 / intervalMinutes
 *
 * Examples: 15 m → 35 040 bars/year; 1 h → 8 760; 1 d → 365.
 */
export interface SummaryStats {
  /** (finalEquity − initialCash) / initialCash */
  totalReturn: number;
  /**
   * Annualised Sharpe ratio (risk-free rate = 0).
   * = mean(barReturn) / σ(barReturn) × √(barsPerYear).
   */
  annualizedSharpe: number;
  /**
   * Annualised Sortino ratio (risk-free rate = 0).
   * Downside σ is computed over negative bar returns only; the denominator
   * uses the full return count (not just the negative-return count).
   * = mean(barReturn) / downsideσ × √(barsPerYear).
   */
  annualizedSortino: number;
  /**
   * Maximum peak-to-trough equity drawdown as a positive fraction,
   * e.g. 0.15 represents a 15 % drawdown.
   */
  maxDrawdown: number;
  /**
   * Fraction of completed round-trip trades (FIFO-matched buy→sell pairs)
   * with strictly positive net PnL.
   */
  winRate: number;
  /**
   * Gross gain / gross loss across all round trips.
   * Returns Infinity when there are no losing trades.
   */
  profitFactor: number;
  /** Number of completed round-trip trades. */
  numTrades: number;
  /** Total maker fees paid across all fills (quote currency). */
  totalFeesPaid: number;
  /** Human-readable note on the annualisation assumption. */
  annualizationNote: string;
}

// ── Backtest result ───────────────────────────────────────────────────────────

/** Complete result returned by `runBacktest`. */
export interface BacktestResult {
  /** All fills in chronological order. */
  trades: TradeRecord[];
  /**
   * Mark-to-market equity at the close of each bar (length = number of bars).
   * Includes unrealised PnL on any open position.
   */
  equityCurve: number[];
  /**
   * Net PnL per completed round-trip trade (FIFO-matched buy→sell pairs),
   * in quote currency.  Exposed so walk-forward can aggregate across windows.
   */
  roundTripPnls: number[];
  stats: SummaryStats;
}
