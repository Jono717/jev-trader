/**
 * Indicator library — pure TypeScript, no external dependencies, no lookahead.
 *
 * Each function returns an array aligned to the input bar array.  Positions
 * where the indicator window is incomplete are filled with NaN (numeric
 * indicators) or undefined (object-valued indicators).
 */
export { ema } from "./ema.ts";
export { rsi } from "./rsi.ts";
export { atr } from "./atr.ts";
export { bollingerBands } from "./bollinger.ts";
export { rollingVwap } from "./vwap.ts";

export type { OhlcBar } from "./atr.ts";
export type { BollingerBand } from "./bollinger.ts";
export type { VwapBar, VwapResult } from "./vwap.ts";
