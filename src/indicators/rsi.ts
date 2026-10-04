/**
 * Relative Strength Index (RSI) — Wilder's smoothing, no lookahead.
 *
 * Requires `period + 1` closes to produce the first valid value at index
 * `period`. Returns NaN for all earlier indices.
 *
 * Seed: simple average of the first `period` up-moves / down-moves.
 * Subsequent values use Wilder's smoothing:
 *   avgGain_t = (avgGain_{t−1} × (period − 1) + gain_t) / period
 *
 * RSI = 100 − 100 / (1 + avgGain / avgLoss).
 * When avgLoss is zero the series is in a pure uptrend: RSI = 100.
 */
export function rsi(closes: readonly number[], period: number): number[] {
  if (!Number.isInteger(period) || period < 1) {
    throw new RangeError(`RSI period must be a positive integer, got ${period}`);
  }
  const n = closes.length;
  const out = new Array<number>(n).fill(NaN);
  if (n <= period) return out;

  // Build gain / loss series (length = n − 1).
  const gains = new Array<number>(n - 1);
  const losses = new Array<number>(n - 1);
  for (let i = 1; i < n; i++) {
    const d = closes[i]! - closes[i - 1]!;
    gains[i - 1] = d > 0 ? d : 0;
    losses[i - 1] = d < 0 ? -d : 0;
  }

  // Seed: simple average of the first `period` changes.
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 0; i < period; i++) {
    avgGain += gains[i]!;
    avgLoss += losses[i]!;
  }
  avgGain /= period;
  avgLoss /= period;

  out[period] =
    avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  // Wilder's smoothing for the remainder.
  for (let i = period + 1; i < n; i++) {
    avgGain = (avgGain * (period - 1) + gains[i - 1]!) / period;
    avgLoss = (avgLoss * (period - 1) + losses[i - 1]!) / period;
    out[i] =
      avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }

  return out;
}
