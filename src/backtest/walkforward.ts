import type { OhlcvBar } from "../types/index.ts";
import type {
  Strategy,
  BacktestConfig,
  SummaryStats,
  BacktestResult,
} from "./types.ts";
import { runBacktest } from "./engine.ts";
import { computeStats } from "./stats.ts";
import { normalCdf, normalQuantile } from "../math/normal.ts";

// ── Walk-forward runner ───────────────────────────────────────────────────────

/** Configuration for the walk-forward evaluation. */
export interface WalkForwardConfig {
  /** Number of bars in each training window (used by the strategy factory). */
  trainSize: number;
  /** Number of bars in each out-of-sample test window. */
  testSize: number;
  /**
   * Number of bars to step forward between consecutive windows.
   * Must be ≥ `testSize` so consecutive out-of-sample spans never overlap.
   */
  step: number;
}

/** Result for one walk-forward window. */
export interface WalkForwardWindow {
  windowIndex: number;
  /** Inclusive start index of the training slice into the original bars array. */
  trainStart: number;
  /** Exclusive end of the training slice (= testStart). */
  trainEnd: number;
  /** Inclusive start of the test slice. */
  testStart: number;
  /** Exclusive end of the test slice. */
  testEnd: number;
  result: BacktestResult;
}

/** Complete walk-forward output. */
export interface WalkForwardResult {
  windows: WalkForwardWindow[];
  /**
   * Aggregate out-of-sample stats: computed from a synthetic equity curve
   * constructed by compounding each window's bar returns in sequence, starting
   * from `initialCash`.  Round-trip PnLs are concatenated across windows.
   *
   * `step ≥ testSize` is enforced by `runWalkForward`, so every bar return
   * enters the aggregate at most once.
   */
  aggregateStats: SummaryStats;
}

/**
 * A strategy factory receives the training bars and returns a strategy
 * configured for the test window.  It may freely inspect training bars for
 * in-sample parameter selection.
 */
export type StrategyFactory = (trainBars: readonly OhlcvBar[]) => Strategy;

/**
 * Run a walk-forward evaluation over `bars`.
 *
 * Window layout:
 *   train = bars[start .. start + trainSize)
 *   test  = bars[start + trainSize .. start + trainSize + testSize)
 *   start += step  (repeat while the next window fits within `bars`)
 *
 * Windows that would extend past the end of `bars` are skipped.
 * The factory is called fresh for each window to simulate true live deployment.
 *
 * `step` must be ≥ `testSize`: a smaller step makes consecutive out-of-sample
 * spans overlap, which would count the same bar returns more than once in
 * `aggregateStats` and inflate the observation count T that feeds the DSR.
 */
export function runWalkForward(
  bars: readonly OhlcvBar[],
  factory: StrategyFactory,
  wfConfig: WalkForwardConfig,
  backtestConfig: BacktestConfig,
): WalkForwardResult {
  const { trainSize, testSize, step } = wfConfig;
  if (trainSize < 1 || testSize < 1 || step < 1) {
    throw new RangeError("trainSize, testSize, and step must all be ≥ 1");
  }
  if (step < testSize) {
    throw new RangeError(
      `step (${step}) must be ≥ testSize (${testSize}): a smaller step makes ` +
        `out-of-sample test spans overlap, so the same bar returns would be ` +
        `counted more than once in the aggregate out-of-sample stats`,
    );
  }

  const windows: WalkForwardWindow[] = [];

  for (
    let start = 0;
    start + trainSize + testSize <= bars.length;
    start += step
  ) {
    const trainStart = start;
    const trainEnd = start + trainSize;
    const testStart = trainEnd;
    const testEnd = trainEnd + testSize;

    const trainBars = bars.slice(trainStart, trainEnd);
    const testBars = bars.slice(testStart, testEnd);

    const strategy = factory(trainBars);
    const result = runBacktest(testBars, strategy, backtestConfig);

    windows.push({
      windowIndex: windows.length,
      trainStart,
      trainEnd,
      testStart,
      testEnd,
      result,
    });
  }

  const aggregateStats = aggregateWindowStats(
    windows,
    backtestConfig.initialCash,
    backtestConfig.intervalMinutes,
  );

  return { windows, aggregateStats };
}

/**
 * Aggregate out-of-sample stats across all walk-forward windows.
 *
 * Bar returns from each window's test equity curve are concatenated in order.
 * A synthetic equity curve is then reconstructed by compounding those returns
 * starting from `initialCash`.  Round-trip PnLs and fees are pooled directly.
 *
 * Assumes non-overlapping test spans (guaranteed by `runWalkForward`'s
 * `step ≥ testSize` rule) so no bar return is counted twice.
 */
export function aggregateWindowStats(
  windows: WalkForwardWindow[],
  initialCash: number,
  intervalMinutes: number,
): SummaryStats {
  if (windows.length === 0) {
    return computeStats([], [], [], initialCash, intervalMinutes);
  }

  // Concatenated out-of-sample bar returns (in chronological order).
  const allReturns: number[] = [];
  for (const w of windows) {
    const eq = w.result.equityCurve;
    for (let i = 1; i < eq.length; i++) {
      const prev = eq[i - 1]!;
      if (prev !== 0) allReturns.push(eq[i]! / prev - 1);
    }
  }

  // Reconstruct a synthetic equity curve by compounding returns.
  const syntheticEquity: number[] = [initialCash];
  for (const r of allReturns) {
    syntheticEquity.push(syntheticEquity[syntheticEquity.length - 1]! * (1 + r));
  }

  // Pool trades and round-trip PnLs.
  const allTrades = windows.flatMap((w) => w.result.trades);
  const allPnls = windows.flatMap((w) => w.result.roundTripPnls);

  return computeStats(
    syntheticEquity,
    allTrades,
    allPnls,
    initialCash,
    intervalMinutes,
  );
}

// ── Deflated Sharpe Ratio ─────────────────────────────────────────────────────

/**
 * Convert an annualised Sharpe ratio into the per-observation (per-bar) Sharpe
 * that `deflatedSharpeRatio` expects.
 *
 * `computeStats` annualises with the same 365-day crypto year:
 *   barsPerYear = 365 × 24 × 60 / intervalMinutes
 * so the per-bar Sharpe is the annualised value divided by √barsPerYear
 * (15 m → ÷ √35 040 ≈ ÷ 187.2; 1 h → ÷ √8 760 ≈ ÷ 93.6).
 */
export function deannualizeSharpe(
  annualizedSharpe: number,
  intervalMinutes: number,
): number {
  if (!(intervalMinutes > 0)) {
    throw new RangeError(
      `intervalMinutes must be > 0, got ${intervalMinutes}`,
    );
  }
  const barsPerYear = (365 * 24 * 60) / intervalMinutes;
  return annualizedSharpe / Math.sqrt(barsPerYear);
}

/** Inputs to the Deflated Sharpe Ratio helper. */
export interface DsrInput {
  /**
   * Observed **per-observation** (per-bar, non-annualised) Sharpe ratio over
   * the T returns counted by `numReturns`.
   *
   * `SummaryStats.annualizedSharpe` is annualised — pass it through
   * `deannualizeSharpe` first.  Feeding an annualised value here mixes scales
   * with `numReturns`, `trialSharpeVariance` and σ_SR, which are all
   * per-observation quantities.
   */
  observedSharpe: number;
  /**
   * Number of independent strategy variants tested (K).
   * Must be ≥ 1.  K = 1 carries no multiple-testing penalty: SR₀ = 0 and the
   * DSR reduces to the Probabilistic Sharpe Ratio Φ(SR / σ_SR).
   */
  numTrials: number;
  /**
   * Number of return observations T (bar count).
   * Must be ≥ 2.
   */
  numReturns: number;
  /**
   * Variance V of the K trials' **per-observation** Sharpe estimates — the
   * dispersion of the variants that were tried.  √V scales the
   * expected-maximum benchmark SR₀, so it sets how much of an edge the best
   * variant has to show before it beats chance.  Must be finite and > 0.
   *
   * For a family of variants whose true edge is zero, V ≈ 1/(T − 1).
   */
  trialSharpeVariance: number;
  /** Sample skewness of bar returns. */
  skewness: number;
  /**
   * Sample excess kurtosis of bar returns (kurtosis − 3).
   * Zero for a Gaussian return distribution.
   */
  excessKurtosis: number;
}

/** Outputs from the Deflated Sharpe Ratio helper. */
export interface DsrResult {
  /**
   * DSR probability in [0, 1].
   * High values (e.g. > 0.95) suggest the observed Sharpe is unlikely to be
   * the result of chance across the tested variants.
   */
  dsr: number;
  /** Expected maximum per-observation Sharpe ratio under the null (SR₀). */
  benchmarkSharpe: number;
  /**
   * Estimated standard error of the observed per-observation Sharpe (σ_SR).
   */
  sharpeStdError: number;
}

/**
 * Deflated Sharpe Ratio — Bailey, Borger & Lopez de Prado (2014).
 *
 * Corrects for selection bias when multiple strategy variants are tested by
 * comparing the observed Sharpe against an expected-maximum benchmark SR₀
 * derived from extreme-value theory.
 *
 * All Sharpe quantities are **per-observation** (per bar), never annualised.
 *
 * Formula:
 *   SR₀   = √V · [(1 − γ) · Φ⁻¹(1 − 1/K) + γ · Φ⁻¹(1 − 1/(K · e))]   (K ≥ 2)
 *   SR₀   = 0                                                     (K = 1)
 *   σ_SR  = √[(1 + SR²/2 − skew · SR + excessKurt · SR²/4) / (T − 1)]
 *   DSR   = Φ[(SR_hat − SR₀) / σ_SR]
 *
 * where γ ≈ 0.5772 is the Euler–Mascheroni constant and V is the variance of
 * the K trials' per-observation Sharpe estimates.
 *
 * The extreme-value expression for SR₀ is only valid for K ≥ 2 — at K = 1 it
 * diverges to −∞, which would report DSR = 1 for any observed Sharpe.  The
 * expected maximum of a single standard normal is 0, so K = 1 uses SR₀ = 0 and
 * the result is the Probabilistic Sharpe Ratio.
 *
 * Note on σ_SR: uses the asymptotic variance formula from Mertens (2002) /
 * Lo (2002), which approximates kurtosis as (excessKurtosis + 3) but only
 * the excess-kurtosis term survives after the Gaussian baseline cancels out.
 * The simplified form shown above (with excessKurtosis directly) follows the
 * Bailey & Lopez de Prado (2014) notation.
 *
 * References:
 *   Bailey, D.H. & Lopez de Prado, M. (2014) "The Deflated Sharpe Ratio:
 *     Correcting for Selection Bias, Backtest Overfitting and Non-Normality"
 *   Mertens, E. (2002) "Variance of the IID Estimator in Lo (2002)"
 */
export function deflatedSharpeRatio(input: DsrInput): DsrResult {
  const {
    observedSharpe: SR,
    numTrials: K,
    numReturns: T,
    trialSharpeVariance: V,
    skewness,
    excessKurtosis,
  } = input;

  if (K < 1 || !Number.isInteger(K)) {
    throw new RangeError(`numTrials must be a positive integer, got ${K}`);
  }
  if (T < 2) {
    throw new RangeError(`numReturns must be ≥ 2, got ${T}`);
  }
  if (!Number.isFinite(V) || V <= 0) {
    throw new RangeError(
      `trialSharpeVariance must be a finite positive number, got ${V}`,
    );
  }

  const EULER_MASCHERONI = 0.5772156649015329;

  // ── Benchmark Sharpe SR₀ ─────────────────────────────────────────────
  const q1 = 1 - 1 / K;
  const q2 = 1 - 1 / (K * Math.E);
  const expectedMaxZ =
    K === 1
      ? 0
      : (1 - EULER_MASCHERONI) * normalQuantile(q1) +
        EULER_MASCHERONI * normalQuantile(q2);
  const benchmarkSharpe = Math.sqrt(V) * expectedMaxZ;

  // ── Standard error of the observed SR ───────────────────────────────
  const innerVariance =
    1 + (SR * SR) / 2 - skewness * SR + (excessKurtosis * SR * SR) / 4;
  const sharpeStdError = Math.sqrt(Math.max(0, innerVariance) / (T - 1));

  // ── DSR ──────────────────────────────────────────────────────────────
  const dsr =
    sharpeStdError === 0
      ? SR > benchmarkSharpe
        ? 1
        : 0
      : normalCdf((SR - benchmarkSharpe) / sharpeStdError);

  return { dsr, benchmarkSharpe, sharpeStdError };
}
