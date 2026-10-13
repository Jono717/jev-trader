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
 * With down-moves absent but up-moves present (avgLoss = 0, avgGain > 0) the
 * series is in a pure uptrend: RSI = 100.  With no moves at all in the window
 * (avgGain = avgLoss = 0) there is no trend in either direction, so RSI is
 * neutral: 50.
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

  out[period] = wilderRsi(avgGain, avgLoss);

  // Wilder's smoothing for the remainder.
  for (let i = period + 1; i < n; i++) {
    avgGain = (avgGain * (period - 1) + gains[i - 1]!) / period;
    avgLoss = (avgLoss * (period - 1) + losses[i - 1]!) / period;
    out[i] = wilderRsi(avgGain, avgLoss);
  }

  return out;
}

/**
 * Sole definition of the RSI reading for a pair of Wilder averages, shared by
 * the seed and every smoothing step so the two can never disagree.
 */
function wilderRsi(avgGain: number, avgLoss: number): number {
  if (avgGain === 0 && avgLoss === 0) return 50;
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}
