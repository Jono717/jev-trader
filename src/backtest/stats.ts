import type { TradeRecord, SummaryStats } from "./types.ts";

/**
 * Bars per year under the project's single annualisation convention: crypto
 * markets trade 24 / 7, so a 365-day year is assumed.
 *
 *   barsPerYear = 365 × 24 × 60 / intervalMinutes
 *
 * Examples: 15 m → 35 040 bars/year; 1 h → 8 760; 1 d → 365.
 *
 * Sole definition of the rule: `computeStats` annualises with it and
 * `deannualizeSharpe` inverts it, so the two can never drift apart.
 */
export function barsPerYear(intervalMinutes: number): number {
  if (!(intervalMinutes > 0)) {
    throw new RangeError(`intervalMinutes must be > 0, got ${intervalMinutes}`);
  }
  return (365 * 24 * 60) / intervalMinutes;
}

/**
 * Compute summary statistics from a completed backtest.
 *
 * Annualisation uses `barsPerYear(intervalMinutes)` — a 365-day year.
 *
 * Bar returns: r_i = E_i / E_{i−1} − 1 (length = equityCurve.length − 1).
 * Risk-free rate = 0 for both Sharpe and Sortino.
 */
export function computeStats(
  equityCurve: readonly number[],
  trades: readonly TradeRecord[],
  roundTripPnls: readonly number[],
  initialCash: number,
  intervalMinutes: number,
  numRejectedOrders: number,
): SummaryStats {
  const n = equityCurve.length;
  const finalEquity = n > 0 ? equityCurve[n - 1]! : initialCash;
  const totalReturn = (finalEquity - initialCash) / initialCash;

  const barsPerYearValue = barsPerYear(intervalMinutes);
  const annualizationNote =
    `Annualisation: 365-day year, continuous 24/7 crypto trading. ` +
    `barsPerYear = 365 × 24 × 60 / ${intervalMinutes} = ${barsPerYearValue.toFixed(2)}. ` +
    `Annualisation factor = √${barsPerYearValue.toFixed(2)} ≈ ${Math.sqrt(barsPerYearValue).toFixed(4)}. ` +
    `Risk-free rate = 0.`;

  // Bar returns (length n − 1).
  const returns: number[] = [];
  for (let i = 1; i < n; i++) {
    const prev = equityCurve[i - 1]!;
    if (prev !== 0) returns.push(equityCurve[i]! / prev - 1);
  }

  const annualizedSharpe = computeSharpe(returns, barsPerYearValue);
  const annualizedSortino = computeSortino(returns, barsPerYearValue);
  const maxDrawdown = computeMaxDrawdown(equityCurve);

  // Round-trip statistics.
  const totalFeesPaid = trades.reduce((s, t) => s + t.fee, 0);
  const numTrades = roundTripPnls.length;

  let winRate = 0;
  let profitFactor = 0;

  if (numTrades > 0) {
    const wins = roundTripPnls.filter((p) => p > 0);
    const losses = roundTripPnls.filter((p) => p <= 0);
    winRate = wins.length / numTrades;

    const grossGain = wins.reduce((s, p) => s + p, 0);
    const grossLoss = losses.reduce((s, p) => s + Math.abs(p), 0);
    profitFactor =
      grossGain === 0
        ? 0
        : grossLoss === 0
          ? Infinity
          : grossGain / grossLoss;
  }

  return {
    totalReturn,
    annualizedSharpe,
    annualizedSortino,
    maxDrawdown,
    winRate,
    profitFactor,
    numTrades,
    totalFeesPaid,
    numRejectedOrders,
    annualizationNote,
  };
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function mean(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}

/** Sample standard deviation (Bessel-corrected, denominator n−1). */
function sampleStd(xs: readonly number[], mu: number): number {
  if (xs.length < 2) return 0;
  const variance =
    xs.reduce((s, x) => s + (x - mu) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(variance);
}

function computeSharpe(
  returns: readonly number[],
  barsPerYear: number,
): number {
  if (returns.length < 2) return 0;
  const mu = mean(returns);
  const sigma = sampleStd(returns, mu);
  if (sigma === 0) return 0;
  return (mu / sigma) * Math.sqrt(barsPerYear);
}

function computeSortino(
  returns: readonly number[],
  barsPerYear: number,
): number {
  if (returns.length === 0) return 0;
  const mu = mean(returns);
  const negatives = returns.filter((r) => r < 0);
  if (negatives.length === 0) return mu > 0 ? Infinity : 0;

  // Downside variance: mean of squared negative returns over ALL returns.
  const downsideVariance =
    negatives.reduce((s, r) => s + r * r, 0) / returns.length;
  const downsideSigma = Math.sqrt(downsideVariance);
  if (downsideSigma === 0) return 0;
  return (mu / downsideSigma) * Math.sqrt(barsPerYear);
}

function computeMaxDrawdown(equityCurve: readonly number[]): number {
  let peak = -Infinity;
  let maxDD = 0;
  for (const e of equityCurve) {
    if (e > peak) peak = e;
    if (peak > 0) {
      const dd = (peak - e) / peak;
      if (dd > maxDD) maxDD = dd;
    }
  }
  return maxDD;
}
