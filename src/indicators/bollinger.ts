/** One Bollinger Band value. */
export interface BollingerBand {
  upper: number;
  middle: number;
  lower: number;
}

/**
 * Bollinger Bands — no lookahead.
 *
 * Middle = SMA of the last `period` closes.
 * Upper  = Middle + k × population σ (denominator N, not N−1).
 * Lower  = Middle − k × population σ.
 *
 * Returns `undefined` for indices before the first full window (0 … period−2).
 */
export function bollingerBands(
  closes: readonly number[],
  period: number,
  k = 2,
): (BollingerBand | undefined)[] {
  if (!Number.isInteger(period) || period < 1) {
    throw new RangeError(
      `Bollinger period must be a positive integer, got ${period}`,
    );
  }
  const n = closes.length;
  const out: (BollingerBand | undefined)[] = new Array(n).fill(undefined);

  for (let i = period - 1; i < n; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += closes[j]!;
    const mean = sum / period;

    let variance = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const d = closes[j]! - mean;
      variance += d * d;
    }
    const std = Math.sqrt(variance / period);

    out[i] = {
      upper: mean + k * std,
      middle: mean,
      lower: mean - k * std,
    };
  }

  return out;
}
