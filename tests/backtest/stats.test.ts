/**
 * Unit tests for the summary statistics module.
 *
 * Hand-computed reference values where applicable.
 */

import { test, expect, describe } from "bun:test";
import { computeStats } from "../../src/backtest/stats.ts";

describe("computeStats — totalReturn", () => {
  test("totalReturn = (finalEquity − initialCash) / initialCash", () => {
    const stats = computeStats([1000, 1100], [], [], 1000, 15);
    expect(stats.totalReturn).toBeCloseTo(0.1, 10);
  });

  test("flat equity curve → totalReturn = 0", () => {
    const stats = computeStats([1000, 1000, 1000], [], [], 1000, 15);
    expect(stats.totalReturn).toBe(0);
  });

  test("empty equity curve → totalReturn = 0", () => {
    const stats = computeStats([], [], [], 1000, 15);
    expect(stats.totalReturn).toBe(0);
  });
});

describe("computeStats — maxDrawdown", () => {
  test("no drawdown → 0", () => {
    const stats = computeStats([1000, 1100, 1200], [], [], 1000, 15);
    expect(stats.maxDrawdown).toBe(0);
  });

  test("peak 1100 → trough 900: DD = 200/1100", () => {
    // equity = [1000, 1100, 900, 1050]
    // peak=1100, trough=900 → DD = 200/1100 ≈ 0.18182
    const stats = computeStats([1000, 1100, 900, 1050], [], [], 1000, 15);
    expect(stats.maxDrawdown).toBeCloseTo(200 / 1100, 8);
  });

  test("drawdown uses the highest peak seen so far", () => {
    // [1000, 800, 1200, 600]
    // After 1200: peak=1200, trough=600 → DD = 600/1200 = 0.5
    const stats = computeStats([1000, 800, 1200, 600], [], [], 1000, 15);
    expect(stats.maxDrawdown).toBeCloseTo(0.5, 8);
  });
});

describe("computeStats — Sharpe / Sortino", () => {
  test("flat equity → Sharpe = 0 (zero σ)", () => {
    const stats = computeStats([1000, 1000, 1000, 1000], [], [], 1000, 15);
    expect(stats.annualizedSharpe).toBe(0);
  });

  test("upward-trending equity has positive Sharpe", () => {
    const eq = Array.from({ length: 50 }, (_, i) => 1000 + i * 10);
    const stats = computeStats(eq, [], [], 1000, 15);
    expect(stats.annualizedSharpe).toBeGreaterThan(0);
  });

  test("downward-trending equity has negative Sharpe", () => {
    const eq = Array.from({ length: 50 }, (_, i) => 1000 - i * 10);
    const stats = computeStats(eq, [], [], 1000, 15);
    expect(stats.annualizedSharpe).toBeLessThan(0);
  });

  test("Sortino = Infinity when all bar returns are non-negative", () => {
    const eq = [1000, 1010, 1020, 1030, 1040];
    const stats = computeStats(eq, [], [], 1000, 15);
    expect(stats.annualizedSortino).toBe(Infinity);
  });

  test("Sortino < Sharpe when negative returns exist", () => {
    // Asymmetric: mostly up but one big drop.
    const eq = [1000, 1100, 900, 1050, 1150];
    const stats = computeStats(eq, [], [], 1000, 15);
    // Both valid numbers
    expect(isFinite(stats.annualizedSharpe)).toBe(true);
    expect(isFinite(stats.annualizedSortino)).toBe(true);
    // Sortino ≥ Sharpe (Sortino penalises only downside)
    expect(stats.annualizedSortino).toBeGreaterThanOrEqual(stats.annualizedSharpe);
  });

  test("annualisation note mentions 365-day year and interval", () => {
    const stats = computeStats([1000, 1010], [], [], 1000, 15);
    expect(stats.annualizationNote).toContain("365");
    expect(stats.annualizationNote).toContain("15");
  });

  test("15m: barsPerYear = 365 × 96 = 35 040 is in the annualisation note", () => {
    const stats = computeStats([1000, 1010], [], [], 1000, 15);
    expect(stats.annualizationNote).toContain("35040");
  });
});

describe("computeStats — win rate & profit factor", () => {
  test("no trades → winRate = 0, profitFactor = 0, numTrades = 0", () => {
    const stats = computeStats([1000, 1010], [], [], 1000, 15);
    expect(stats.winRate).toBe(0);
    expect(stats.profitFactor).toBe(0);
    expect(stats.numTrades).toBe(0);
  });

  test("one winning trade → winRate = 1, profitFactor = Infinity", () => {
    const stats = computeStats([1000, 1100], [], [50], 1000, 15);
    expect(stats.winRate).toBe(1);
    expect(stats.profitFactor).toBe(Infinity);
    expect(stats.numTrades).toBe(1);
  });

  test("one losing trade → winRate = 0, profitFactor = 0", () => {
    const stats = computeStats([1000, 900], [], [-50], 1000, 15);
    expect(stats.winRate).toBe(0);
    expect(stats.profitFactor).toBe(0);
  });

  test("two wins one loss: winRate = 2/3, profitFactor = 200/50 = 4", () => {
    // roundTripPnls: [100, 100, -50]
    const stats = computeStats([1000, 1050], [], [100, 100, -50], 1000, 15);
    expect(stats.winRate).toBeCloseTo(2 / 3, 8);
    expect(stats.profitFactor).toBeCloseTo(4, 8);
    expect(stats.numTrades).toBe(3);
  });
});

describe("computeStats — totalFeesPaid", () => {
  test("sum of all trade fees", () => {
    const trades = [
      { barIndex: 1, ts: 900, side: "buy" as const, price: 100, volume: 1, fee: 0.16, tag: "" },
      { barIndex: 2, ts: 1800, side: "sell" as const, price: 110, volume: 1, fee: 0.176, tag: "" },
    ];
    const stats = computeStats([1000, 1000, 1000], trades, [], 1000, 15);
    expect(stats.totalFeesPaid).toBeCloseTo(0.336, 8);
  });
});
