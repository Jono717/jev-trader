/**
 * Standard normal distribution utilities used by the Deflated Sharpe Ratio.
 *
 * normalCdf(x)      — Φ(x):   CDF of the standard normal distribution.
 * normalQuantile(p) — Φ⁻¹(p): inverse CDF (quantile function).
 *
 * Accuracy:
 *   normalCdf:      max |error| < 1.5 × 10⁻⁷  (Abramowitz & Stegun 7.1.26)
 *   normalQuantile: max |error| < 1.15 × 10⁻⁹ (Peter Acklam's rational approximation)
 */

// ── Error function ────────────────────────────────────────────────────────────

/**
 * erf(x) — Abramowitz & Stegun polynomial approximation 7.1.26.
 * max |error| < 1.5 × 10⁻⁷.
 */
function erf(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const poly =
    t *
    (0.254829592 +
      t *
        (-0.284496736 +
          t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  const result = 1 - poly * Math.exp(-x * x);
  return x >= 0 ? result : -result;
}

/** Φ(x) — standard normal CDF. */
export function normalCdf(x: number): number {
  return (1 + erf(x / Math.SQRT2)) / 2;
}

// ── Inverse CDF ───────────────────────────────────────────────────────────────

// Acklam rational-approximation coefficients (max |error| < 1.15 × 10⁻⁹).
const A = [
  -3.969683028665376e1,
  2.209460984245205e2,
  -2.759285104469687e2,
  1.38357751867269e2,
  -3.066479806614716e1,
  2.506628277459239,
] as const;

const B = [
  -5.447609879822406e1,
  1.615858368580409e2,
  -1.556989798598866e2,
  6.680131188771972e1,
  -1.328068155288572e1,
] as const;

const C = [
  -7.784894002430293e-3,
  -3.223964580411365e-1,
  -2.400758277161838,
  -2.549732539343734,
  4.374664141464968,
  2.938163982698783,
] as const;

const D = [
  7.784695709041462e-3,
  3.223907451340021e-1,
  2.445134137142996,
  3.754408661907416,
] as const;

const P_LOW = 0.02425;
const P_HIGH = 1 - P_LOW;

/** Φ⁻¹(p) — inverse standard normal CDF (quantile function). */
export function normalQuantile(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;

  if (p < P_LOW) {
    // Lower tail
    const q = Math.sqrt(-2 * Math.log(p));
    return (
      (((((C[0] * q + C[1]) * q + C[2]) * q + C[3]) * q + C[4]) * q + C[5]) /
      ((((D[0] * q + D[1]) * q + D[2]) * q + D[3]) * q + 1)
    );
  }

  if (p <= P_HIGH) {
    // Central region
    const q = p - 0.5;
    const r = q * q;
    return (
      ((((((A[0] * r + A[1]) * r + A[2]) * r + A[3]) * r + A[4]) * r +
        A[5]) *
        q) /
      (((((B[0] * r + B[1]) * r + B[2]) * r + B[3]) * r + B[4]) * r + 1)
    );
  }

  // Upper tail (reflect)
  const q = Math.sqrt(-2 * Math.log(1 - p));
  return (
    -(((((C[0] * q + C[1]) * q + C[2]) * q + C[3]) * q + C[4]) * q + C[5]) /
    ((((D[0] * q + D[1]) * q + D[2]) * q + D[3]) * q + 1)
  );
}
