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
  /** Number of bars to step forward between consecutive windows. */
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

/** Inputs to the Deflated Sharpe Ratio helper. */
export interface DsrInput {
  /** Observed (annualised) Sharpe ratio from the backtest. */
  observedSharpe: number;
  /**
   * Number of independent strategy variants tested (K).
   * Must be ≥ 1.  K = 1 means no multiple-testing penalty (DSR → 1).
   */
  numTrials: number;
  /**
   * Number of return observations T (bar count).
   * Must be ≥ 2.
   */
  numReturns: number;
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
  /** Expected maximum Sharpe ratio under the null (SR₀). */
  benchmarkSharpe: number;
  /** Estimated standard error of the observed Sharpe ratio (σ_SR). */
  sharpeStdError: number;
}

/**
 * Deflated Sharpe Ratio — Bailey, Borger & Lopez de Prado (2014).
 *
 * Corrects for selection bias when multiple strategy variants are tested by
 * comparing the observed Sharpe against an expected-maximum benchmark SR₀
 * derived from extreme-value theory.
 *
 * Formula:
 *   SR₀   = (1 − γ) · Φ⁻¹(1 − 1/K) + γ · Φ⁻¹(1 − 1/(K · e))
 *   σ_SR  = √[(1 + SR²/2 − skew · SR + excessKurt · SR²/4) / (T − 1)]
 *   DSR   = Φ[(SR_hat − SR₀) / σ_SR]
 *
 * where γ ≈ 0.5772 is the Euler–Mascheroni constant.
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
    skewness,
    excessKurtosis,
  } = input;

  if (K < 1 || !Number.isInteger(K)) {
    throw new RangeError(`numTrials must be a positive integer, got ${K}`);
  }
  if (T < 2) {
    throw new RangeError(`numReturns must be ≥ 2, got ${T}`);
  }

  const EULER_MASCHERONI = 0.5772156649015329;

  // ── Benchmark Sharpe SR₀ ─────────────────────────────────────────────
  const q1 = 1 - 1 / K;           // → 0 when K = 1, giving Φ⁻¹(0) = −∞
  const q2 = 1 - 1 / (K * Math.E);
  const benchmarkSharpe =
    (1 - EULER_MASCHERONI) * normalQuantile(q1) +
    EULER_MASCHERONI * normalQuantile(q2);

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
