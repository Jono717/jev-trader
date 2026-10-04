/**
 * Kraken public REST client.
 *
 * Covers unauthenticated endpoints only (Time, AssetPairs, OHLC).
 * No API keys are read or required — all data is publicly accessible.
 *
 * Rate limiting: Kraken's public tier allows ~1 req/s. The client
 * enforces a configurable minimum interval between requests (default 1 s) and
 * aborts any request that has not responded within a configurable timeout, so
 * an unattended scheduled run cannot wedge forever on a stalled connection.
 */

import type {
  KrakenEnvelope,
  KrakenServerTime,
  KrakenAssetPairs,
  KrakenOhlcBar,
  KrakenOhlcResult,
} from "./types.ts";

const BASE_URL = "https://api.kraken.com";
const DEFAULT_RATE_LIMIT_MS = 1_000;
const DEFAULT_TIMEOUT_MS = 15_000;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Bar widths, in minutes, that Kraken's OHLC endpoint accepts. */
export const KRAKEN_OHLC_INTERVALS: readonly number[] = [
  1, 5, 15, 30, 60, 240, 1440, 10080, 21600,
];

/** Thrown when Kraken returns a non-empty `error` array. */
export class KrakenError extends Error {
  public readonly krakenErrors: string[];

  constructor(errors: string[]) {
    super(`Kraken API error: ${errors.join(", ")}`);
    this.name = "KrakenError";
    this.krakenErrors = errors;
  }
}

export class KrakenPublicClient {
  private lastRequestAt = 0;
  private readonly rateLimitMs: number;
  private readonly timeoutMs: number;

  /**
   * @param rateLimitMs Minimum ms between requests (default 1000).
   *                    Pass 0 in tests to skip the delay.
   * @param timeoutMs   Ms to wait for a response before aborting (default 15000).
   */
  constructor(
    rateLimitMs = DEFAULT_RATE_LIMIT_MS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ) {
    this.rateLimitMs = rateLimitMs;
    this.timeoutMs = timeoutMs;
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  private async throttledFetch(url: string): Promise<Response> {
    const elapsed = Date.now() - this.lastRequestAt;
    if (elapsed < this.rateLimitMs) {
      await sleep(this.rateLimitMs - elapsed);
    }
    this.lastRequestAt = Date.now();

    const res = await fetch(url, {
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${res.statusText} — ${url}`);
    }
    return res;
  }

  private async get<T>(
    path: string,
    params?: Record<string, string>,
  ): Promise<T> {
    const url = new URL(BASE_URL + path);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        url.searchParams.set(k, v);
      }
    }

    const res = await this.throttledFetch(url.toString());
    const data = (await res.json()) as KrakenEnvelope<T>;

    if (data.error.length > 0) {
      throw new KrakenError(data.error);
    }
    return data.result;
  }

  // ── Public endpoints ─────────────────────────────────────────────────────

  /** GET /0/public/Time — returns current Kraken server time. */
  async getServerTime(): Promise<KrakenServerTime> {
    return this.get<KrakenServerTime>("/0/public/Time");
  }

  /**
   * GET /0/public/AssetPairs — returns tradable asset pair info.
   * Omit `pairs` to fetch all pairs.
   */
  async getAssetPairs(pairs?: string[]): Promise<KrakenAssetPairs> {
    const params: Record<string, string> = {};
    if (pairs && pairs.length > 0) {
      params["pair"] = pairs.join(",");
    }
    return this.get<KrakenAssetPairs>("/0/public/AssetPairs", params);
  }

  /**
   * GET /0/public/OHLC — returns up to 720 of the most recent OHLC bars.
   * Older data cannot be retrieved through this endpoint, whatever `since` is.
   *
   * @param pair     Kraken pair name, e.g. "XBTUSD"
   * @param interval Bar width in minutes (1|5|15|30|60|240|1440|10080|21600)
   * @param since    Return bars at or after this Unix timestamp (optional)
   *
   * @returns `bars` — the bar array (raw Kraken strings for prices);
   *          `last` — Kraken's cursor for polling newly committed bars
   */
  async getOhlc(
    pair: string,
    interval: number,
    since?: number,
  ): Promise<{ bars: KrakenOhlcBar[]; last: number }> {
    const params: Record<string, string> = {
      pair,
      interval: String(interval),
    };
    if (since !== undefined) {
      params["since"] = String(since);
    }

    const raw = await this.get<KrakenOhlcResult>("/0/public/OHLC", params);
    const last = raw.last;

    // Kraken may return the bars under its internal pair key instead of the
    // requested one (e.g. request "XBTUSD", receive "XXBTZUSD").
    const direct = raw[pair];
    let bars: KrakenOhlcBar[] | undefined = Array.isArray(direct)
      ? direct
      : undefined;

    if (bars === undefined) {
      const barKeys = Object.keys(raw).filter(
        (key) => key !== "last" && Array.isArray(raw[key]),
      );
      if (barKeys.length === 1) {
        bars = raw[barKeys[0]!] as KrakenOhlcBar[];
      }
    }

    if (bars === undefined) {
      throw new Error(`No OHLC data returned for pair: ${pair}`);
    }

    return { bars, last };
  }
}
