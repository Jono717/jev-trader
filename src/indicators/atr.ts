/** Minimal bar shape required by the ATR calculation. */
export interface OhlcBar {
  high: number;
  low: number;
  close: number;
}

/**
 * Average True Range (ATR) — Wilder's smoothing, no lookahead.
 *
 * True Range for bar i:
 *   max(high − low, |high − prevClose|, |low − prevClose|)
 * For bar 0 (no previous close): TR = high − low.
 *
 * Seed: simple average of the first `period` TR values, stored at index
 * `period − 1`. Subsequent values use Wilder's smoothing:
 *   ATR_t = (ATR_{t−1} × (period − 1) + TR_t) / period
 *
 * Returns NaN for indices before the seed window (0 … period − 2).
 */
export function atr(bars: readonly OhlcBar[], period: number): number[] {
  if (!Number.isInteger(period) || period < 1) {
    throw new RangeError(`ATR period must be a positive integer, got ${period}`);
  }
  const n = bars.length;
  const out = new Array<number>(n).fill(NaN);
  if (n < period) return out;

  // True Range for each bar.
  const tr = new Array<number>(n);
  tr[0] = bars[0]!.high - bars[0]!.low;
  for (let i = 1; i < n; i++) {
    const prev = bars[i - 1]!.close;
    tr[i] = Math.max(
      bars[i]!.high - bars[i]!.low,
      Math.abs(bars[i]!.high - prev),
      Math.abs(bars[i]!.low - prev),
    );
  }

  // Seed.
  let val = 0;
  for (let i = 0; i < period; i++) val += tr[i]!;
  val /= period;
  out[period - 1] = val;

  // Wilder's smoothing.
  for (let i = period; i < n; i++) {
    val = (val * (period - 1) + tr[i]!) / period;
    out[i] = val;
  }

  return out;
}
