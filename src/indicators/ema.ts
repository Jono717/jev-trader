/**
 * Exponential Moving Average (EMA) — no lookahead.
 *
 * Seed: the first `period` closes are averaged (SMA) to produce the first
 * EMA value at index `period − 1`. Subsequent values use:
 *   EMA_t = α × close_t + (1 − α) × EMA_{t−1}   where α = 2 / (period + 1).
 *
 * Returns NaN for indices where the seed window is incomplete (0 … period−2).
 */
export function ema(closes: readonly number[], period: number): number[] {
  if (!Number.isInteger(period) || period < 1) {
    throw new RangeError(`EMA period must be a positive integer, got ${period}`);
  }
  const n = closes.length;
  const out = new Array<number>(n).fill(NaN);
  if (n < period) return out;

  const alpha = 2 / (period + 1);

  // Seed with SMA of the first `period` bars.
  let acc = 0;
  for (let i = 0; i < period; i++) acc += closes[i]!;
  out[period - 1] = acc / period;

  for (let i = period; i < n; i++) {
    out[i] = alpha * closes[i]! + (1 - alpha) * out[i - 1]!;
  }

  return out;
}
