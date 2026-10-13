/**
 * Unit tests for the EMA indicator.
 *
 * All expected values are hand-computed:
 *   period = 3, α = 2/(3+1) = 0.5
 *   closes = [10, 11, 12, 13, 14]
 *   seed (index 2) = SMA([10,11,12]) = 33/3 = 11.0
 *   index 3 = 0.5 × 13 + 0.5 × 11 = 12.0
 *   index 4 = 0.5 × 14 + 0.5 × 12 = 13.0
 */

import { test, expect, describe } from "bun:test";
import { ema } from "../../src/indicators/ema.ts";

describe("ema", () => {
  const CLOSES = [10, 11, 12, 13, 14];

  test("returns NaN for indices before the seed window", () => {
    const result = ema(CLOSES, 3);
    expect(Number.isNaN(result[0]!)).toBe(true);
    expect(Number.isNaN(result[1]!)).toBe(true);
  });

  test("seed value equals SMA of first `period` bars", () => {
    const result = ema(CLOSES, 3);
    expect(result[2]).toBe(11.0); // (10+11+12)/3
  });

  test("subsequent values apply the exponential smoothing formula", () => {
    const result = ema(CLOSES, 3);
    expect(result[3]).toBe(12.0); // 0.5×13 + 0.5×11
    expect(result[4]).toBe(13.0); // 0.5×14 + 0.5×12
  });

  test("period 1 returns a copy of closes (alpha = 1)", () => {
    const result = ema(CLOSES, 1);
    expect(result).toEqual(CLOSES);
  });

  test("output length equals input length", () => {
    expect(ema(CLOSES, 3).length).toBe(CLOSES.length);
  });

  test("returns all-NaN array when bars are fewer than period", () => {
    const result = ema([10, 20], 5);
    expect(result.every((v) => Number.isNaN(v))).toBe(true);
  });

  test("throws on non-positive period", () => {
    expect(() => ema(CLOSES, 0)).toThrow(RangeError);
    expect(() => ema(CLOSES, -1)).toThrow(RangeError);
  });

  test("throws on non-integer period", () => {
    expect(() => ema(CLOSES, 1.5)).toThrow(RangeError);
  });

  test("period equals length: one valid value at last index", () => {
    const result = ema(CLOSES, 5);
    expect(Number.isNaN(result[4]!)).toBe(false);
    expect(result[4]).toBeCloseTo((10 + 11 + 12 + 13 + 14) / 5, 10);
  });

  test("longer ascending series is monotonically increasing", () => {
    const closes = Array.from({ length: 20 }, (_, i) => i + 1);
    const result = ema(closes, 5);
    for (let i = 5; i < result.length; i++) {
      expect(result[i]!).toBeGreaterThan(result[i - 1]!);
    }
  });
});
