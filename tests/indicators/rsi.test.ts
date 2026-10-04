/**
 * Unit tests for the RSI indicator.
 *
 * Hand-computed reference case:
 *   period = 2, closes = [10, 11, 10, 11, 12]
 *   differences: +1, −1, +1, +1
 *   gains:  1,  0,  1,  1
 *   losses: 0,  1,  0,  0
 *
 *   Seed (first `period` = 2 differences):
 *     avgGain = (1+0)/2 = 0.5,  avgLoss = (0+1)/2 = 0.5
 *   index 2: RS = 0.5/0.5 = 1 → RSI = 100 − 100/(1+1) = 50
 *
 *   Wilder smoothing, index 3 (gain[2]=1, loss[2]=0):
 *     avgGain = (0.5×1 + 1)/2 = 0.75,  avgLoss = (0.5×1 + 0)/2 = 0.25
 *     RS = 3 → RSI = 100 − 100/4 = 75
 *
 *   Wilder smoothing, index 4 (gain[3]=1, loss[3]=0):
 *     avgGain = (0.75×1 + 1)/2 = 0.875,  avgLoss = (0.25×1 + 0)/2 = 0.125
 *     RS = 7 → RSI = 100 − 100/8 = 87.5
 */

import { test, expect, describe } from "bun:test";
import { rsi } from "../../src/indicators/rsi.ts";

describe("rsi", () => {
  const CLOSES = [10, 11, 10, 11, 12];

  test("first valid value at index `period`", () => {
    const result = rsi(CLOSES, 2);
    expect(Number.isNaN(result[0]!)).toBe(true);
    expect(Number.isNaN(result[1]!)).toBe(true);
    expect(Number.isNaN(result[2]!)).toBe(false);
  });

  test("RSI at seed (index 2): 50", () => {
    expect(rsi(CLOSES, 2)[2]).toBeCloseTo(50, 10);
  });

  test("RSI after one Wilder step (index 3): 75", () => {
    expect(rsi(CLOSES, 2)[3]).toBeCloseTo(75, 10);
  });

  test("RSI after two Wilder steps (index 4): 87.5", () => {
    expect(rsi(CLOSES, 2)[4]).toBeCloseTo(87.5, 10);
  });

  test("pure uptrend returns RSI = 100 (no losses)", () => {
    const up = [1, 2, 3, 4, 5, 6];
    const result = rsi(up, 3);
    for (let i = 3; i < result.length; i++) {
      expect(result[i]).toBe(100);
    }
  });

  test("pure downtrend returns RSI = 0", () => {
    const down = [6, 5, 4, 3, 2, 1];
    const result = rsi(down, 3);
    for (let i = 3; i < result.length; i++) {
      expect(result[i]).toBe(0);
    }
  });

  test("a flat series is neutral (50), not maximally overbought", () => {
    // No up-moves and no down-moves: avgGain = avgLoss = 0 at the seed and at
    // every Wilder step, so there is no trend in either direction.
    const flat = [100, 100, 100, 100, 100];
    const result = rsi(flat, 2);
    expect(result[2]).toBe(50); // seed
    expect(result[3]).toBe(50); // first smoothing step
    expect(result[4]).toBe(50); // second smoothing step
  });

  test("a flat stretch following an uptrend keeps the pure-uptrend reading", () => {
    // Wilder's averages decay geometrically, so avgGain stays strictly above
    // zero after a real up-move while avgLoss remains zero: still 100, and
    // the degenerate 0/0 case is never entered.
    const upThenFlat = [1, 2, 3, 3, 3, 3, 3, 3, 3, 3];
    const result = rsi(upThenFlat, 2);
    for (let i = 2; i < result.length; i++) {
      expect(result[i]).toBe(100);
    }
  });

  test("a flat stretch following a downtrend keeps the pure-downtrend reading", () => {
    // Mirror of the case above on the loss axis: avgGain is zero while
    // avgLoss decays but stays positive, so the ratio is well defined at 0.
    const downThenFlat = [3, 2, 2, 2, 2, 2];
    const result = rsi(downThenFlat, 2);
    for (let i = 2; i < result.length; i++) {
      expect(result[i]).toBe(0);
    }
  });

  test("output length equals input length", () => {
    expect(rsi(CLOSES, 2).length).toBe(CLOSES.length);
  });

  test("returns all-NaN when closes length <= period", () => {
    expect(rsi([10, 11], 2).every((v) => Number.isNaN(v))).toBe(true);
  });

  test("RSI is bounded [0, 100]", () => {
    const mixed = [100, 105, 102, 108, 104, 110, 103, 107, 100, 112];
    const result = rsi(mixed, 4);
    for (const v of result) {
      if (!Number.isNaN(v)) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(100);
      }
    }
  });

  test("only a window with up-moves and no down-moves reads 100", () => {
    const series: Record<string, number[]> = {
      flat: [5, 5, 5, 5, 5],
      up: [1, 2, 3, 4, 5],
      down: [5, 4, 3, 2, 1],
    };
    expect(rsi(series.flat!, 2)[4]).toBe(50);
    expect(rsi(series.up!, 2)[4]).toBe(100);
    expect(rsi(series.down!, 2)[4]).toBe(0);
  });

  test("throws on non-positive period", () => {
    expect(() => rsi(CLOSES, 0)).toThrow(RangeError);
  });
});
