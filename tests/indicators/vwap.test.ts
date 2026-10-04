/**
 * Unit tests for the rolling VWAP indicator.
 *
 * Hand-computed reference case:
 *   period = 2
 *   bars = [
 *     { H:12, L:10, C:11, V:100 },  tp = (12+10+11)/3 = 11,  tpV = 1100
 *     { H:14, L:12, C:13, V:200 },  tp = (14+12+13)/3 = 13,  tpV = 2600
 *     { H:13, L:11, C:12, V:150 },  tp = (13+11+12)/3 = 12,  tpV = 1800
 *   ]
 *
 *   index 1: sumTpV = 1100+2600 = 3700, sumV = 300 → vwap = 3700/300 = 12.3333…
 *            deviation = (13 − 12.3333) / 12.3333 ≈ 0.05405
 *
 *   index 2: sumTpV = 2600+1800 = 4400, sumV = 350 → vwap = 4400/350 ≈ 12.5714…
 *            deviation = (12 − 12.5714) / 12.5714 ≈ −0.04545
 */

import { test, expect, describe } from "bun:test";
import { rollingVwap } from "../../src/indicators/vwap.ts";

const BARS = [
  { high: 12, low: 10, close: 11, volume: 100 },
  { high: 14, low: 12, close: 13, volume: 200 },
  { high: 13, low: 11, close: 12, volume: 150 },
];

describe("rollingVwap", () => {
  test("index before first full window is undefined", () => {
    expect(rollingVwap(BARS, 2)[0]).toBeUndefined();
  });

  test("VWAP at index 1 (period=2)", () => {
    const result = rollingVwap(BARS, 2);
    expect(result[1]?.vwap).toBeCloseTo(3700 / 300, 8);
  });

  test("VWAP deviation at index 1", () => {
    const vwap1 = 3700 / 300;
    const expected = (13 - vwap1) / vwap1;
    const result = rollingVwap(BARS, 2);
    expect(result[1]?.deviation).toBeCloseTo(expected, 8);
  });

  test("VWAP at index 2 (period=2)", () => {
    const result = rollingVwap(BARS, 2);
    expect(result[2]?.vwap).toBeCloseTo(4400 / 350, 8);
  });

  test("VWAP deviation at index 2 is negative (close below VWAP)", () => {
    const result = rollingVwap(BARS, 2);
    expect(result[2]!.deviation).toBeLessThan(0);
    const vwap2 = 4400 / 350;
    expect(result[2]?.deviation).toBeCloseTo((12 - vwap2) / vwap2, 8);
  });

  test("period = full length: one VWAP value at last index", () => {
    const result = rollingVwap(BARS, 3);
    expect(result[0]).toBeUndefined();
    expect(result[1]).toBeUndefined();
    expect(result[2]).toBeDefined();
  });

  test("zero-volume window has no VWAP (undefined, not a 0 % deviation)", () => {
    const zeroBars = [
      { high: 10, low: 8, close: 9, volume: 0 },
      { high: 12, low: 10, close: 11, volume: 0 },
    ];
    expect(rollingVwap(zeroBars, 2)[1]).toBeUndefined();
  });

  test("a window regains a VWAP as soon as any volume trades", () => {
    const bars = [
      { high: 10, low: 8, close: 9, volume: 0 },
      { high: 12, low: 10, close: 11, volume: 5 },
    ];
    // Only bar 1 carries volume: vwap = tp(bar 1) = (12+10+11)/3 = 11.
    expect(rollingVwap(bars, 2)[1]?.vwap).toBeCloseTo(11, 8);
  });

  test("output length equals input length", () => {
    expect(rollingVwap(BARS, 2).length).toBe(3);
  });

  test("all-undefined when bars < period", () => {
    const result = rollingVwap([BARS[0]!], 2);
    expect(result.every((v) => v === undefined)).toBe(true);
  });

  test("throws on non-positive period", () => {
    expect(() => rollingVwap(BARS, 0)).toThrow(RangeError);
  });
});
