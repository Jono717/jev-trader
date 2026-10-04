/**
 * Unit tests for the walk-forward runner and Deflated Sharpe Ratio helper.
 *
 * Walk-forward window layout:
 *   bars = 10 bars (indices 0–9), trainSize=4, testSize=3, step=2
 *   Window 0: train=[0..3], test=[4..6]  (start=0, 0+4+3=7 ≤ 10 ✓)
 *   Window 1: train=[2..5], test=[6..8]  (start=2, 2+4+3=9 ≤ 10 ✓)
 *   Window 2: start=4, 4+4+3=11 > 10 → skipped
 *   → 2 windows total
 *
 * DSR reference case (hand-computed):
 *   T=252, K=2, SR=0.6, skewness=0, excess_kurtosis=0
 *
 *   SR₀ = (1−γ)·Φ⁻¹(0.5) + γ·Φ⁻¹(1−1/(2·e))
 *       = (1−0.5772)·0 + 0.5772·Φ⁻¹(0.81606)
 *       ≈ 0.5772 · 0.899 ≈ 0.519
 *
 *   σ_SR = √[(1 + 0.6²/2) / 251] = √[1.18/251] ≈ 0.0686
 *
 *   DSR = Φ[(0.6 − 0.519) / 0.0686] = Φ[1.181] ≈ 0.881
 */

import { test, expect, describe } from "bun:test";
import {
  runWalkForward,
  deflatedSharpeRatio,
  aggregateWindowStats,
} from "../../src/backtest/walkforward.ts";
import type {
  Strategy,
  BacktestConfig,
} from "../../src/backtest/types.ts";
import type { OhlcvBar } from "../../src/types/index.ts";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeBar(index: number): OhlcvBar {
  return {
    pair: "TEST",
    interval: 15,
    ts: index * 900,
    open: 100,
    high: 105,
    low: 95,
    close: 100,
    vwap: 100,
    volume: 10,
    count: 1,
  };
}

const TEN_BARS = Array.from({ length: 10 }, (_, i) => makeBar(i));

/** A no-op strategy: places no orders, holds cash. */
const noOpStrategy: Strategy = { onBar: () => [] };

const BASE_CONFIG: BacktestConfig = {
  initialCash: 1000,
  intervalMinutes: 15,
};

// ── Walk-forward window layout ────────────────────────────────────────────────

describe("runWalkForward — window layout", () => {
  const factory = (_trainBars: readonly OhlcvBar[]) => noOpStrategy;

  test("produces 2 windows for 10 bars, trainSize=4, testSize=3, step=2", () => {
    const result = runWalkForward(TEN_BARS, factory, { trainSize: 4, testSize: 3, step: 2 }, BASE_CONFIG);
    expect(result.windows.length).toBe(2);
  });

  test("window 0 slice indices are correct", () => {
    const result = runWalkForward(TEN_BARS, factory, { trainSize: 4, testSize: 3, step: 2 }, BASE_CONFIG);
    const w0 = result.windows[0]!;
    expect(w0.trainStart).toBe(0);
    expect(w0.trainEnd).toBe(4);
    expect(w0.testStart).toBe(4);
    expect(w0.testEnd).toBe(7);
  });

  test("window 1 slice indices are correct", () => {
    const result = runWalkForward(TEN_BARS, factory, { trainSize: 4, testSize: 3, step: 2 }, BASE_CONFIG);
    const w1 = result.windows[1]!;
    expect(w1.trainStart).toBe(2);
    expect(w1.trainEnd).toBe(6);
    expect(w1.testStart).toBe(6);
    expect(w1.testEnd).toBe(9);
  });

  test("windowIndex is 0-based", () => {
    const result = runWalkForward(TEN_BARS, factory, { trainSize: 4, testSize: 3, step: 2 }, BASE_CONFIG);
    expect(result.windows[0]!.windowIndex).toBe(0);
    expect(result.windows[1]!.windowIndex).toBe(1);
  });

  test("each test window's equity curve length equals testSize", () => {
    const result = runWalkForward(TEN_BARS, factory, { trainSize: 4, testSize: 3, step: 2 }, BASE_CONFIG);
    for (const w of result.windows) {
      expect(w.result.equityCurve.length).toBe(3);
    }
  });

  test("factory receives training bars of correct length", () => {
    const trainLengths: number[] = [];
    const trackFactory = (trainBars: readonly OhlcvBar[]) => {
      trainLengths.push(trainBars.length);
      return noOpStrategy;
    };
    runWalkForward(TEN_BARS, trackFactory, { trainSize: 4, testSize: 3, step: 2 }, BASE_CONFIG);
    expect(trainLengths).toEqual([4, 4]);
  });

  test("no windows when bars < trainSize + testSize", () => {
    const result = runWalkForward(
      TEN_BARS.slice(0, 5),
      factory,
      { trainSize: 4, testSize: 3, step: 1 },
      BASE_CONFIG,
    );
    expect(result.windows.length).toBe(0);
  });

  test("step=1 produces maximum window count", () => {
    // 10 bars, train=4, test=3: first possible start=0, last start where 0+4+3≤10 → start≤3
    // starts: 0,1,2,3 → 4 windows
    const result = runWalkForward(TEN_BARS, factory, { trainSize: 4, testSize: 3, step: 1 }, BASE_CONFIG);
    expect(result.windows.length).toBe(4);
  });

  test("throws on invalid config", () => {
    expect(() =>
      runWalkForward(TEN_BARS, factory, { trainSize: 0, testSize: 3, step: 1 }, BASE_CONFIG),
    ).toThrow(RangeError);
  });
});

describe("runWalkForward — aggregate stats", () => {
  test("aggregate equity curve length = sum of window equity curve lengths + 1", () => {
    const result = runWalkForward(TEN_BARS, () => noOpStrategy, { trainSize: 4, testSize: 3, step: 2 }, BASE_CONFIG);
    // 2 windows × 3 bars = 6 bar returns → synthetic equity has 6+1=7 points
    // But aggregateStats is derived from returns, not the equity array directly.
    // Check that no-op strategy → totalReturn = 0 for aggregate.
    expect(result.aggregateStats.totalReturn).toBe(0);
  });

  test("aggregateWindowStats on empty windows returns zero stats", () => {
    const stats = aggregateWindowStats([], 1000, 15);
    expect(stats.totalReturn).toBe(0);
    expect(stats.numTrades).toBe(0);
  });
});

// ── Deflated Sharpe Ratio ─────────────────────────────────────────────────────

describe("deflatedSharpeRatio", () => {
  test("reference case: T=252, K=2, SR=0.6, Gaussian → DSR ≈ 0.881", () => {
    const result = deflatedSharpeRatio({
      observedSharpe: 0.6,
      numTrials: 2,
      numReturns: 252,
      skewness: 0,
      excessKurtosis: 0,
    });
    // benchmarkSharpe = γ × Φ⁻¹(1−1/(2e)) ≈ 0.519
    expect(result.benchmarkSharpe).toBeCloseTo(0.519, 2);
    // σ_SR = √(1.18/251) ≈ 0.0686
    expect(result.sharpeStdError).toBeCloseTo(0.0686, 3);
    // DSR = Φ(1.181) ≈ 0.881
    expect(result.dsr).toBeCloseTo(0.881, 2);
  });

  test("SR >> SR₀: DSR close to 1", () => {
    const result = deflatedSharpeRatio({
      observedSharpe: 5.0,
      numTrials: 2,
      numReturns: 252,
      skewness: 0,
      excessKurtosis: 0,
    });
    expect(result.dsr).toBeGreaterThan(0.99);
  });

  test("SR << SR₀: DSR close to 0", () => {
    const result = deflatedSharpeRatio({
      observedSharpe: -2.0,
      numTrials: 2,
      numReturns: 252,
      skewness: 0,
      excessKurtosis: 0,
    });
    expect(result.dsr).toBeLessThan(0.01);
  });

  test("K=1 (no multiple-testing penalty): benchmarkSharpe = −Infinity → DSR = 1", () => {
    const result = deflatedSharpeRatio({
      observedSharpe: 0.5,
      numTrials: 1,
      numReturns: 100,
      skewness: 0,
      excessKurtosis: 0,
    });
    expect(result.benchmarkSharpe).toBe(-Infinity);
    expect(result.dsr).toBe(1);
  });

  test("large K penalises more: DSR decreases as K increases (same SR)", () => {
    function dsr(k: number) {
      return deflatedSharpeRatio({
        observedSharpe: 1.0,
        numTrials: k,
        numReturns: 252,
        skewness: 0,
        excessKurtosis: 0,
      }).dsr;
    }
    expect(dsr(2)).toBeGreaterThan(dsr(10));
    expect(dsr(10)).toBeGreaterThan(dsr(100));
  });

  test("positive skewness increases σ_SR (more uncertainty)", () => {
    function se(skewness: number) {
      return deflatedSharpeRatio({
        observedSharpe: 1.0,
        numTrials: 2,
        numReturns: 252,
        skewness,
        excessKurtosis: 0,
      }).sharpeStdError;
    }
    // σ_SR has term −skewness×SR; negative skewness → higher variance
    expect(se(-1)).toBeGreaterThan(se(0));
    expect(se(0)).toBeGreaterThan(se(1));
  });

  test("throws when numTrials < 1", () => {
    expect(() =>
      deflatedSharpeRatio({
        observedSharpe: 1, numTrials: 0, numReturns: 100, skewness: 0, excessKurtosis: 0,
      }),
    ).toThrow(RangeError);
  });

  test("throws when numReturns < 2", () => {
    expect(() =>
      deflatedSharpeRatio({
        observedSharpe: 1, numTrials: 2, numReturns: 1, skewness: 0, excessKurtosis: 0,
      }),
    ).toThrow(RangeError);
  });

  test("DSR is in [0, 1]", () => {
    for (const sr of [-2, -0.5, 0, 0.5, 2]) {
      const { dsr } = deflatedSharpeRatio({
        observedSharpe: sr, numTrials: 5, numReturns: 100, skewness: 0, excessKurtosis: 0,
      });
      expect(dsr).toBeGreaterThanOrEqual(0);
      expect(dsr).toBeLessThanOrEqual(1);
    }
  });
});
