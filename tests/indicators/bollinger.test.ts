/**
 * Unit tests for the Bollinger Bands indicator.
 *
 * Hand-computed reference case:
 *   period = 3, k = 2, closes = [10, 11, 12, 13, 14]
 *
 *   index 2: window = [10,11,12], mean = 11
 *     variance = ((10−11)² + (11−11)² + (12−11)²) / 3 = 2/3
 *     std = √(2/3) ≈ 0.816497
 *     upper = 11 + 2 × 0.816497 ≈ 12.632993
 *     lower = 11 − 2 × 0.816497 ≈  9.367007
 *
 *   index 3: window = [11,12,13], mean = 12  →  same std  → upper ≈ 13.633, lower ≈ 10.367
 *   index 4: window = [12,13,14], mean = 13  →  same std  → upper ≈ 14.633, lower ≈ 11.367
 */

import { test, expect, describe } from "bun:test";
import { bollingerBands } from "../../src/indicators/bollinger.ts";

const CLOSES = [10, 11, 12, 13, 14];
const SQRT_2_3 = Math.sqrt(2 / 3); // ≈ 0.816497

describe("bollingerBands", () => {
  test("indices before first window are undefined", () => {
    const result = bollingerBands(CLOSES, 3);
    expect(result[0]).toBeUndefined();
    expect(result[1]).toBeUndefined();
  });

  test("middle band equals SMA", () => {
    const result = bollingerBands(CLOSES, 3);
    expect(result[2]?.middle).toBeCloseTo(11, 10);
    expect(result[3]?.middle).toBeCloseTo(12, 10);
    expect(result[4]?.middle).toBeCloseTo(13, 10);
  });

  test("upper = middle + k × population σ", () => {
    const result = bollingerBands(CLOSES, 3);
    expect(result[2]?.upper).toBeCloseTo(11 + 2 * SQRT_2_3, 8);
    expect(result[3]?.upper).toBeCloseTo(12 + 2 * SQRT_2_3, 8);
    expect(result[4]?.upper).toBeCloseTo(13 + 2 * SQRT_2_3, 8);
  });

  test("lower = middle − k × population σ", () => {
    const result = bollingerBands(CLOSES, 3);
    expect(result[2]?.lower).toBeCloseTo(11 - 2 * SQRT_2_3, 8);
    expect(result[3]?.lower).toBeCloseTo(12 - 2 * SQRT_2_3, 8);
    expect(result[4]?.lower).toBeCloseTo(13 - 2 * SQRT_2_3, 8);
  });

  test("upper > middle > lower for all valid bands", () => {
    const result = bollingerBands(CLOSES, 3);
    for (const band of result) {
      if (band) {
        expect(band.upper).toBeGreaterThan(band.middle);
        expect(band.middle).toBeGreaterThan(band.lower);
      }
    }
  });

  test("k = 0 → upper = middle = lower", () => {
    const result = bollingerBands(CLOSES, 3, 0);
    for (const band of result) {
      if (band) {
        expect(band.upper).toBe(band.middle);
        expect(band.lower).toBe(band.middle);
      }
    }
  });

  test("output length equals input length", () => {
    expect(bollingerBands(CLOSES, 3).length).toBe(5);
  });

  test("period 1: std = 0, so upper = lower = middle = close", () => {
    const result = bollingerBands(CLOSES, 1);
    for (let i = 0; i < CLOSES.length; i++) {
      expect(result[i]?.upper).toBe(CLOSES[i]);
      expect(result[i]?.middle).toBe(CLOSES[i]);
      expect(result[i]?.lower).toBe(CLOSES[i]);
    }
  });

  test("all-undefined when bars < period", () => {
    const result = bollingerBands([10, 20], 5);
    expect(result.every((v) => v === undefined)).toBe(true);
  });

  test("throws on non-positive period", () => {
    expect(() => bollingerBands(CLOSES, 0)).toThrow(RangeError);
  });
});
