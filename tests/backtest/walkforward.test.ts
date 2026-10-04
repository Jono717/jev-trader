/**
 * Unit tests for the walk-forward runner and Deflated Sharpe Ratio helper.
 *
 * Walk-forward window layout:
 *   bars = 10 bars (indices 0–9), trainSize=4, testSize=3, step=3
 *   Window 0: train=[0..3], test=[4..6]  (start=0, 0+4+3=7  ≤ 10 ✓)
 *   Window 1: train=[3..6], test=[7..9]  (start=3, 3+4+3=10 ≤ 10 ✓)
 *   Window 2: start=6, 6+4+3=13 > 10 → skipped
 *   → 2 windows, with non-overlapping test spans [4..6] and [7..9]
 *
 * `step` must be ≥ `testSize`: a smaller step overlaps the out-of-sample spans
 * and would count the same bar returns more than once in the aggregate.
 *
 * DSR reference case (hand-computed, per-observation Sharpe, V = 1):
 *   T=252, K=2, SR=0.6, V=1, skewness=0, excess_kurtosis=0
 *
 *   SR₀ = √V · [(1−γ)·Φ⁻¹(0.5) + γ·Φ⁻¹(1−1/(2·e))]
 *       = 1 · [(1−0.5772)·0 + 0.5772·Φ⁻¹(0.81606)]
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
  deannualizeSharpe,
  aggregateWindowStats,
} from "../../src/backtest/walkforward.ts";
import type { WalkForwardWindow } from "../../src/backtest/walkforward.ts";
import { computeStats } from "../../src/backtest/stats.ts";
import { normalCdf } from "../../src/math/normal.ts";
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

const LAYOUT = { trainSize: 4, testSize: 3, step: 3 };

/** A window carrying a given test-window equity curve. */
function makeWindow(
  windowIndex: number,
  testStart: number,
  equityCurve: number[],
): WalkForwardWindow {
  return {
    windowIndex,
    trainStart: testStart - LAYOUT.trainSize,
    trainEnd: testStart,
    testStart,
    testEnd: testStart + equityCurve.length,
    result: {
      trades: [],
      equityCurve,
      roundTripPnls: [],
      stats: computeStats(equityCurve, [], [], equityCurve[0]!, 15),
    },
  };
}

// ── Walk-forward window layout ────────────────────────────────────────────────

describe("runWalkForward — window layout", () => {
  const factory = (_trainBars: readonly OhlcvBar[]) => noOpStrategy;

  test("produces 2 windows for 10 bars, trainSize=4, testSize=3, step=3", () => {
    const result = runWalkForward(TEN_BARS, factory, LAYOUT, BASE_CONFIG);
    expect(result.windows.length).toBe(2);
  });

  test("window 0 slice indices are correct", () => {
    const result = runWalkForward(TEN_BARS, factory, LAYOUT, BASE_CONFIG);
    const w0 = result.windows[0]!;
    expect(w0.trainStart).toBe(0);
    expect(w0.trainEnd).toBe(4);
    expect(w0.testStart).toBe(4);
    expect(w0.testEnd).toBe(7);
  });

  test("window 1 slice indices are correct", () => {
    const result = runWalkForward(TEN_BARS, factory, LAYOUT, BASE_CONFIG);
    const w1 = result.windows[1]!;
    expect(w1.trainStart).toBe(3);
    expect(w1.trainEnd).toBe(7);
    expect(w1.testStart).toBe(7);
    expect(w1.testEnd).toBe(10);
  });

  test("consecutive out-of-sample test spans never overlap", () => {
    const result = runWalkForward(TEN_BARS, factory, LAYOUT, BASE_CONFIG);
    expect(result.windows.length).toBeGreaterThan(1);
    for (let i = 1; i < result.windows.length; i++) {
      expect(result.windows[i]!.testStart).toBeGreaterThanOrEqual(
        result.windows[i - 1]!.testEnd,
      );
    }
  });

  test("windowIndex is 0-based", () => {
    const result = runWalkForward(TEN_BARS, factory, LAYOUT, BASE_CONFIG);
    expect(result.windows[0]!.windowIndex).toBe(0);
    expect(result.windows[1]!.windowIndex).toBe(1);
  });

  test("each test window's equity curve length equals testSize", () => {
    const result = runWalkForward(TEN_BARS, factory, LAYOUT, BASE_CONFIG);
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
    runWalkForward(TEN_BARS, trackFactory, LAYOUT, BASE_CONFIG);
    expect(trainLengths).toEqual([4, 4]);
  });

  test("no windows when bars < trainSize + testSize", () => {
    const result = runWalkForward(
      TEN_BARS.slice(0, 5),
      factory,
      LAYOUT,
      BASE_CONFIG,
    );
    expect(result.windows.length).toBe(0);
  });

  test("step = testSize produces the maximum window count", () => {
    // 10 bars, train=4, test=3: starts must satisfy start+7 ≤ 10 → start ≤ 3.
    // The smallest legal step (3) reaches starts 0 and 3 → 2 windows.
    const result = runWalkForward(TEN_BARS, factory, LAYOUT, BASE_CONFIG);
    expect(result.windows.length).toBe(2);
  });

  test("rejects step < testSize instead of overlapping test spans", () => {
    expect(() =>
      runWalkForward(
        TEN_BARS,
        factory,
        { trainSize: 4, testSize: 3, step: 2 },
        BASE_CONFIG,
      ),
    ).toThrow(RangeError);
    expect(() =>
      runWalkForward(
        TEN_BARS,
        factory,
        { trainSize: 4, testSize: 3, step: 1 },
        BASE_CONFIG,
      ),
    ).toThrow(/step/);
  });

  test("throws on invalid config", () => {
    expect(() =>
      runWalkForward(
        TEN_BARS,
        factory,
        { trainSize: 0, testSize: 3, step: 3 },
        BASE_CONFIG,
      ),
    ).toThrow(RangeError);
  });
});

describe("runWalkForward — aggregate stats", () => {
  test("no-op strategy aggregates to a zero total return", () => {
    const result = runWalkForward(
      TEN_BARS,
      () => noOpStrategy,
      LAYOUT,
      BASE_CONFIG,
    );
    expect(result.aggregateStats.totalReturn).toBe(0);
  });

  test("aggregateWindowStats on empty windows returns zero stats", () => {
    const stats = aggregateWindowStats([], 1000, 15);
    expect(stats.totalReturn).toBe(0);
    expect(stats.numTrades).toBe(0);
  });

  test("compounds each window's return exactly once", () => {
    const windows = [
      makeWindow(0, 4, [1000, 1100]), // +10 %
      makeWindow(1, 7, [1000, 1200]), // +20 %
    ];
    const stats = aggregateWindowStats(windows, 1000, 15);
    expect(stats.totalReturn).toBeCloseTo(1.1 * 1.2 - 1, 10);
  });
});

// ── Annualised → per-observation conversion ───────────────────────────────────

describe("deannualizeSharpe", () => {
  test("divides by √(365-day bar count)", () => {
    const barsPerYear15m = (365 * 24 * 60) / 15;
    expect(deannualizeSharpe(15, 15)).toBeCloseTo(
      15 / Math.sqrt(barsPerYear15m),
      12,
    );
    expect(deannualizeSharpe(1.2, 60)).toBeCloseTo(1.2 / Math.sqrt(8760), 12);
    expect(deannualizeSharpe(1.2, 1440)).toBeCloseTo(1.2 / Math.sqrt(365), 12);
  });

  test("throws on a non-positive interval", () => {
    expect(() => deannualizeSharpe(1, 0)).toThrow(RangeError);
    expect(() => deannualizeSharpe(1, -15)).toThrow(RangeError);
  });
});

// ── Deflated Sharpe Ratio ─────────────────────────────────────────────────────

describe("deflatedSharpeRatio", () => {
  test("reference case: T=252, K=2, SR=0.6, V=1, Gaussian → DSR ≈ 0.881", () => {
    const result = deflatedSharpeRatio({
      observedSharpe: 0.6,
      numTrials: 2,
      numReturns: 252,
      trialSharpeVariance: 1,
      skewness: 0,
      excessKurtosis: 0,
    });
    // benchmarkSharpe = √1 × γ × Φ⁻¹(1−1/(2e)) ≈ 0.519
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
      trialSharpeVariance: 1,
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
      trialSharpeVariance: 1,
      skewness: 0,
      excessKurtosis: 0,
    });
    expect(result.dsr).toBeLessThan(0.01);
  });

  test("K=1 (no multiple-testing penalty): SR₀ = 0, DSR = the Probabilistic Sharpe Ratio", () => {
    const result = deflatedSharpeRatio({
      observedSharpe: 0.5,
      numTrials: 1,
      numReturns: 100,
      trialSharpeVariance: 1,
      skewness: 0,
      excessKurtosis: 0,
    });
    expect(result.benchmarkSharpe).toBe(0);
    expect(result.dsr).toBeCloseTo(
      normalCdf(0.5 / result.sharpeStdError),
      10,
    );
  });

  test("large K penalises more: DSR decreases as K increases (same SR)", () => {
    function dsr(k: number) {
      return deflatedSharpeRatio({
        observedSharpe: 1.0,
        numTrials: k,
        numReturns: 252,
        trialSharpeVariance: 1,
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
        trialSharpeVariance: 1,
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
        observedSharpe: 1, numTrials: 0, numReturns: 100,
        trialSharpeVariance: 1, skewness: 0, excessKurtosis: 0,
      }),
    ).toThrow(RangeError);
  });

  test("throws when numReturns < 2", () => {
    expect(() =>
      deflatedSharpeRatio({
        observedSharpe: 1, numTrials: 2, numReturns: 1,
        trialSharpeVariance: 1, skewness: 0, excessKurtosis: 0,
      }),
    ).toThrow(RangeError);
  });

  test("DSR is in [0, 1]", () => {
    for (const sr of [-2, -0.5, 0, 0.5, 2]) {
      const { dsr } = deflatedSharpeRatio({
        observedSharpe: sr, numTrials: 5, numReturns: 100,
        trialSharpeVariance: 1, skewness: 0, excessKurtosis: 0,
      });
      expect(dsr).toBeGreaterThanOrEqual(0);
      expect(dsr).toBeLessThanOrEqual(1);
    }
  });
});

describe("deflatedSharpeRatio — trial Sharpe dispersion (√V in SR₀)", () => {
  function run(trialSharpeVariance: number) {
    return deflatedSharpeRatio({
      observedSharpe: 0.6,
      numTrials: 2,
      numReturns: 252,
      trialSharpeVariance,
      skewness: 0,
      excessKurtosis: 0,
    });
  }

  test("benchmarkSharpe scales with √V", () => {
    expect(run(4).benchmarkSharpe).toBeCloseTo(
      2 * run(1).benchmarkSharpe,
      10,
    );
    expect(run(0.25).benchmarkSharpe).toBeCloseTo(
      0.5 * run(1).benchmarkSharpe,
      10,
    );
  });

  test("wider trial dispersion lowers the DSR at the same observed Sharpe", () => {
    expect(run(0.25).dsr).toBeGreaterThan(run(1).dsr);
    expect(run(1).dsr).toBeGreaterThan(run(4).dsr);
  });

  test("σ_SR is independent of V", () => {
    expect(run(4).sharpeStdError).toBe(run(1).sharpeStdError);
  });

  test("throws when trialSharpeVariance is not finite and positive", () => {
    expect(() => run(0)).toThrow(RangeError);
    expect(() => run(-1)).toThrow(RangeError);
    expect(() => run(Number.POSITIVE_INFINITY)).toThrow(RangeError);
    expect(() => run(Number.NaN)).toThrow(RangeError);
  });
});

describe("deflatedSharpeRatio — per-observation scale is not saturated", () => {
  // Regression for the annualised-input mismatch: an annualised Sharpe of 15
  // (ordinary for a 15 m intraday variant) used to clear SR₀ ≈ 1.9 by such a
  // margin that DSR returned 1 for every trial count.  On the per-observation
  // scale the trial count bites again.
  const ANNUALISED_SHARPE = 15;
  const INTERVAL_MINUTES = 15;
  const T = 720;
  const ZERO_EDGE_TRIAL_VARIANCE = 1 / (T - 1);

  function dsrForTrials(numTrials: number): number {
    return deflatedSharpeRatio({
      observedSharpe: deannualizeSharpe(ANNUALISED_SHARPE, INTERVAL_MINUTES),
      numTrials,
      numReturns: T,
      trialSharpeVariance: ZERO_EDGE_TRIAL_VARIANCE,
      skewness: 0,
      excessKurtosis: 0,
    }).dsr;
  }

  test("a few trials pass, a thousand trials do not", () => {
    expect(dsrForTrials(2)).toBeGreaterThan(0.9);
    expect(dsrForTrials(1000)).toBeLessThan(0.5);
  });

  test("DSR stays strictly inside (0, 1) across plausible trial counts", () => {
    for (const k of [2, 20, 100, 1000]) {
      const dsr = dsrForTrials(k);
      expect(dsr).toBeGreaterThan(0);
      expect(dsr).toBeLessThan(1);
    }
  });

  test("README example: 1.2 annualised over 720 bars with 20 trials", () => {
    const { dsr } = deflatedSharpeRatio({
      observedSharpe: deannualizeSharpe(1.2, 15),
      numTrials: 20,
      numReturns: 720,
      trialSharpeVariance: ZERO_EDGE_TRIAL_VARIANCE,
      skewness: 0,
      excessKurtosis: 0,
    });
    // A 1.2 annualised Sharpe measured over only 7.5 days of 15 m bars is a
    // weak edge once 20 variants were tried — well under the 0.95 threshold,
    // but not the hard 0 the annualised-input mismatch produced.
    expect(dsr).toBeGreaterThan(0);
    expect(dsr).toBeLessThan(0.95);
  });
});

describe("deflatedSharpeRatio — a single trial carries no penalty but still judges", () => {
  // Regression: the extreme-value expression for SR₀ diverges to −∞ at K = 1
  // (Φ⁻¹(1 − 1/1) = Φ⁻¹(0)), which reported dsr = 1 — maximum confidence — for
  // every observed Sharpe, including losing ones.  E[max of one standard
  // normal] is 0, so K = 1 reduces the DSR to Φ(SR / σ_SR).
  function singleTrial(observedSharpe: number) {
    return deflatedSharpeRatio({
      observedSharpe,
      numTrials: 1,
      numReturns: 252,
      trialSharpeVariance: 1,
      skewness: 0,
      excessKurtosis: 0,
    });
  }

  test("a losing Sharpe is rejected instead of green-lit", () => {
    const result = singleTrial(-2);
    expect(result.dsr).toBeLessThan(0.01);
  });

  test("a strong positive Sharpe is accepted", () => {
    expect(singleTrial(2).dsr).toBeGreaterThan(0.99);
  });

  test("SR₀ and the DSR are finite for every supported trial count", () => {
    for (const k of [1, 2, 3, 10, 1000]) {
      const result = deflatedSharpeRatio({
        observedSharpe: 0.6,
        numTrials: k,
        numReturns: 252,
        trialSharpeVariance: 1,
        skewness: 0,
        excessKurtosis: 0,
      });
      expect(Number.isFinite(result.benchmarkSharpe)).toBe(true);
      expect(Number.isFinite(result.dsr)).toBe(true);
    }
  });

  test("DSR rises monotonically with the observed Sharpe", () => {
    expect(singleTrial(-1).dsr).toBeLessThan(singleTrial(0).dsr);
    expect(singleTrial(0).dsr).toBeLessThan(singleTrial(1).dsr);
  });

  test("one trial is never stricter than two at the same Sharpe", () => {
    function dsrAt(numTrials: number) {
      return deflatedSharpeRatio({
        observedSharpe: 0.6,
        numTrials,
        numReturns: 252,
        trialSharpeVariance: 1,
        skewness: 0,
        excessKurtosis: 0,
      });
    }
    const one = dsrAt(1);
    const two = dsrAt(2);
    expect(one.benchmarkSharpe).toBe(0);
    expect(two.benchmarkSharpe).toBeGreaterThan(one.benchmarkSharpe);
    expect(one.dsr).toBeGreaterThan(two.dsr);
  });
});
