/**
 * Unit tests for the ATR indicator.
 *
 * Hand-computed reference case:
 *   period = 2
 *   bars = [{H:12, L:10, C:11}, {H:14, L:12, C:13}, {H:13, L:11, C:12}]
 *
 *   TR[0] = 12 − 10 = 2  (no previous close)
 *   TR[1] = max(14−12, |14−11|, |12−11|) = max(2, 3, 1) = 3
 *   TR[2] = max(13−11, |13−13|, |11−13|) = max(2, 0, 2) = 2
 *
 *   Seed at index 1: (2 + 3) / 2 = 2.5
 *   ATR[2] = (2.5 × (2−1) + 2) / 2 = 4.5 / 2 = 2.25
 */

import { test, expect, describe } from "bun:test";
import { atr } from "../../src/indicators/atr.ts";

const BARS = [
  { high: 12, low: 10, close: 11 },
  { high: 14, low: 12, close: 13 },
  { high: 13, low: 11, close: 12 },
];

describe("atr", () => {
  test("indices before seed are NaN", () => {
    const result = atr(BARS, 2);
    expect(Number.isNaN(result[0]!)).toBe(true);
  });

  test("seed value = simple average of first `period` TRs", () => {
    const result = atr(BARS, 2);
    expect(result[1]).toBeCloseTo(2.5, 10);
  });

  test("subsequent values use Wilder's smoothing", () => {
    const result = atr(BARS, 2);
    expect(result[2]).toBeCloseTo(2.25, 10);
  });

  test("period 1: ATR equals True Range for each bar", () => {
    const result = atr(BARS, 1);
    expect(result[0]).toBeCloseTo(2, 10);  // TR[0] = H-L = 2
    expect(result[1]).toBeCloseTo(3, 10);  // TR[1] = 3
    expect(result[2]).toBeCloseTo(2, 10);  // TR[2] = 2
  });

  test("output length equals input length", () => {
    expect(atr(BARS, 2).length).toBe(3);
  });

  test("all-NaN when bars < period", () => {
    expect(atr([BARS[0]!], 2).every((v) => Number.isNaN(v))).toBe(true);
  });

  test("ATR is always non-negative", () => {
    const result = atr(BARS, 2);
    for (const v of result) {
      if (!Number.isNaN(v)) expect(v).toBeGreaterThanOrEqual(0);
    }
  });

  test("first bar TR uses only high − low (no prevClose)", () => {
    const onlyOne = [{ high: 20, low: 10, close: 15 }];
    const result = atr(onlyOne, 1);
    expect(result[0]).toBe(10);
  });

  test("throws on non-positive period", () => {
    expect(() => atr(BARS, 0)).toThrow(RangeError);
  });
});
