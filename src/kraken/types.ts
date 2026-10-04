/**
 * Typed response shapes for Kraken's public REST API.
 * https://docs.kraken.com/api/docs/rest-api/
 */

/** Envelope returned by every Kraken REST endpoint. */
export interface KrakenEnvelope<T> {
  error: string[];
  result: T;
}

// ── GET /0/public/Time ────────────────────────────────────────────────────────

export interface KrakenServerTime {
  unixtime: number;
  rfc1123: string;
}

// ── GET /0/public/AssetPairs ──────────────────────────────────────────────────

export interface KrakenAssetPair {
  altname: string;
  wsname?: string;
  aclass_base: string;
  base: string;
  aclass_quote: string;
  quote: string;
  lot: string;
  pair_decimals: number;
  lot_decimals: number;
  lot_multiplier: number;
  fees: [number, number][];
  fees_maker?: [number, number][];
  fee_volume_currency: string;
  margin_call: number;
  margin_stop: number;
  ordermin: string;
}

export type KrakenAssetPairs = Record<string, KrakenAssetPair>;

// ── GET /0/public/OHLC ────────────────────────────────────────────────────────

/**
 * A single OHLC bar as returned by Kraken:
 * [time, open, high, low, close, vwap, volume, count]
 *
 * Price/volume fields are strings; time and count are numbers.
 */
export type KrakenOhlcBar = [
  number, // 0: bar open time (Unix seconds)
  string, // 1: open
  string, // 2: high
  string, // 3: low
  string, // 4: close
  string, // 5: vwap
  string, // 6: volume
  number, // 7: count
];

/**
 * Raw result object for the OHLC endpoint.
 * Kraken returns `{ [pair]: KrakenOhlcBar[], last: number }`.
 * The pair key may differ from what you requested (e.g. "XXBTZUSD" vs "XBTUSD").
 */
export interface KrakenOhlcResult {
  /** Cursor Kraken returns for polling newly committed bars. */
  last: number;
  /** Pair bars live under the pair's exchange key (not guaranteed to match request). */
  [pairKey: string]: KrakenOhlcBar[] | number;
}
