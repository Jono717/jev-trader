/** Minimal bar shape required by the VWAP calculation. */
export interface VwapBar {
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** One rolling-VWAP result. */
export interface VwapResult {
  vwap: number;
  /** (close − vwap) / vwap */
  deviation: number;
}

/**
 * Rolling VWAP and VWAP deviation — no lookahead.
 *
 * Typical price = (high + low + close) / 3.
 * Rolling VWAP = Σ(typicalPrice × volume) / Σ(volume)  over the last `period` bars.
 * VWAP deviation = (close − vwap) / vwap.
 *
 * When the total volume in a window is zero there is no traded price to
 * average, so the result is `undefined` — absence of data, not "price exactly
 * at VWAP".
 *
 * Returns `undefined` for indices before the first full window (0 … period−2).
 */
export function rollingVwap(
  bars: readonly VwapBar[],
  period: number,
): (VwapResult | undefined)[] {
  if (!Number.isInteger(period) || period < 1) {
    throw new RangeError(
      `VWAP period must be a positive integer, got ${period}`,
    );
  }
  const n = bars.length;
  const out: (VwapResult | undefined)[] = new Array(n).fill(undefined);

  for (let i = period - 1; i < n; i++) {
    let sumTpV = 0;
    let sumV = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const b = bars[j]!;
      const tp = (b.high + b.low + b.close) / 3;
      sumTpV += tp * b.volume;
      sumV += b.volume;
    }
    if (sumV <= 0 || sumTpV <= 0) continue;
    const vwap = sumTpV / sumV;
    out[i] = { vwap, deviation: (bars[i]!.close - vwap) / vwap };
  }

  return out;
}
