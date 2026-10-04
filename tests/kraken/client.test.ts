/**
 * Unit tests for KrakenPublicClient.
 *
 * All tests use pre-recorded (mocked) responses so they run entirely offline.
 * The live smoke test at the bottom is opt-in: set KRAKEN_LIVE=1 to enable it.
 *
 * Run: bun test
 */

import { test, expect, mock, describe, beforeEach, afterEach } from "bun:test";
import { KrakenPublicClient, KrakenError } from "../../src/kraken/client.ts";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const TIME_FIXTURE = {
  error: [],
  result: {
    unixtime: 1_700_000_000,
    rfc1123: "Thu, 14 Nov 2024 22:13:20 +0000",
  },
};

const ASSET_PAIRS_FIXTURE = {
  error: [],
  result: {
    XBTUSD: {
      altname: "XBTUSD",
      wsname: "XBT/USD",
      aclass_base: "currency",
      base: "XXBT",
      aclass_quote: "currency",
      quote: "ZUSD",
      lot: "unit",
      pair_decimals: 1,
      lot_decimals: 8,
      lot_multiplier: 1,
      fees: [[0, 0.26]],
      fees_maker: [[0, 0.16]],
      fee_volume_currency: "ZUSD",
      margin_call: 80,
      margin_stop: 40,
      ordermin: "0.0001",
    },
  },
};

/** Two OHLC bars under the standard "XBTUSD" key. */
const OHLC_FIXTURE = {
  error: [],
  result: {
    XBTUSD: [
      [1_699_999_200, "36500.0", "36700.0", "36400.0", "36600.0", "36550.0", "5.12300000", 87],
      [1_700_000_100, "36600.0", "36800.0", "36500.0", "36750.0", "36680.0", "4.56700000", 62],
    ],
    last: 1_700_000_100,
  },
};

/** Kraken sometimes returns bars under its internal pair name. */
const OHLC_INTERNAL_KEY_FIXTURE = {
  error: [],
  result: {
    XXBTZUSD: [
      [1_699_999_200, "36500.0", "36700.0", "36400.0", "36600.0", "36550.0", "5.12300000", 87],
    ],
    last: 1_699_999_200,
  },
};

const ERROR_FIXTURE = {
  error: ["EQuery:Unknown asset pair"],
  result: {},
};

// ── Helpers ───────────────────────────────────────────────────────────────────

/** The real fetch, captured before any test replaces it. */
const ORIGINAL_FETCH = globalThis.fetch;

/**
 * Single place that replaces global fetch, so the `afterEach` below is the only
 * restore path needed. Keeping the live smoke tests at the bottom working
 * depends on nothing leaking past a test.
 */
function installFetch(
  handler: (input: unknown, init?: RequestInit) => Promise<Response>,
): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).fetch = mock(handler);
}

/** Replace global fetch with a mock that returns the given body. */
function mockFetch(body: unknown, status = 200): void {
  installFetch(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
  );
}

afterEach(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).fetch = ORIGINAL_FETCH;
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("KrakenPublicClient", () => {
  // Use rate limit = 0 in all unit tests to skip artificial delays.
  let client: KrakenPublicClient;
  beforeEach(() => {
    client = new KrakenPublicClient(0);
  });

  // ── getServerTime ──

  test("getServerTime returns typed server time", async () => {
    mockFetch(TIME_FIXTURE);
    const time = await client.getServerTime();
    expect(time.unixtime).toBe(1_700_000_000);
    expect(time.rfc1123).toBe("Thu, 14 Nov 2024 22:13:20 +0000");
  });

  // ── getAssetPairs ──

  test("getAssetPairs returns pair metadata", async () => {
    mockFetch(ASSET_PAIRS_FIXTURE);
    const pairs = await client.getAssetPairs(["XBTUSD"]);
    const pair = pairs["XBTUSD"];
    expect(pair).toBeDefined();
    expect(pair?.wsname).toBe("XBT/USD");
    expect(pair?.pair_decimals).toBe(1);
    expect(pair?.ordermin).toBe("0.0001");
  });

  test("getAssetPairs passes no query param when called without args", async () => {
    let capturedUrl = "";
    installFetch(async (input) => {
      capturedUrl = String(input);
      return new Response(JSON.stringify(ASSET_PAIRS_FIXTURE), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    await client.getAssetPairs();
    expect(capturedUrl).not.toContain("pair=");
  });

  // ── getOhlc ──

  test("getOhlc parses bar array and last timestamp", async () => {
    mockFetch(OHLC_FIXTURE);
    const { bars, last } = await client.getOhlc("XBTUSD", 15);
    expect(bars.length).toBe(2);
    expect(bars[0]![0]).toBe(1_699_999_200); // ts
    expect(bars[0]![1]).toBe("36500.0"); // open (string as-is from Kraken)
    expect(bars[0]![7]).toBe(87); // count
    expect(last).toBe(1_700_000_100);
  });

  test("getOhlc handles internal pair key (XXBTZUSD) transparently", async () => {
    mockFetch(OHLC_INTERNAL_KEY_FIXTURE);
    const { bars, last } = await client.getOhlc("XBTUSD", 15);
    expect(bars.length).toBe(1);
    expect(last).toBe(1_699_999_200);
  });

  test("getOhlc prefers the requested pair key when Kraken returns both spellings", async () => {
    mockFetch({
      error: [],
      result: {
        XXBTZUSD: [
          [1_600_000_000, "1.0", "1.0", "1.0", "1.0", "1.0", "1.0", 1],
        ],
        XBTUSD: [
          [1_699_999_200, "36500.0", "36700.0", "36400.0", "36600.0", "36550.0", "5.123", 87],
        ],
        last: 1_699_999_200,
      },
    });
    const { bars } = await client.getOhlc("XBTUSD", 15);
    expect(bars.length).toBe(1);
    expect(bars[0]![0]).toBe(1_699_999_200);
  });

  test("getOhlc throws when two unrelated pair keys make the choice ambiguous", async () => {
    mockFetch({
      error: [],
      result: {
        ETHUSD: [[1_600_000_000, "1.0", "1.0", "1.0", "1.0", "1.0", "1.0", 1]],
        SOLUSD: [[1_600_000_900, "2.0", "2.0", "2.0", "2.0", "2.0", "2.0", 1]],
        last: 1_600_000_900,
      },
    });
    await expect(client.getOhlc("XBTUSD", 15)).rejects.toThrow(
      "No OHLC data returned for pair: XBTUSD",
    );
  });

  test("getOhlc passes since param when provided", async () => {
    let capturedUrl = "";
    installFetch(async (input) => {
      capturedUrl = String(input);
      return new Response(JSON.stringify(OHLC_FIXTURE), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    await client.getOhlc("XBTUSD", 15, 1_699_000_000);
    expect(capturedUrl).toContain("since=1699000000");
    expect(capturedUrl).toContain("interval=15");
    expect(capturedUrl).toContain("pair=XBTUSD");
  });

  // ── Error handling ──

  test("KrakenError is thrown when Kraken returns errors", async () => {
    mockFetch(ERROR_FIXTURE);
    await expect(client.getAssetPairs(["INVALID"])).rejects.toThrow(
      KrakenError,
    );
  });

  test("KrakenError carries the error strings from the response", async () => {
    mockFetch(ERROR_FIXTURE);
    try {
      await client.getAssetPairs(["INVALID"]);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(KrakenError);
      expect((err as KrakenError).krakenErrors).toEqual([
        "EQuery:Unknown asset pair",
      ]);
    }
  });

  test("HTTP error throws with status code in message", async () => {
    installFetch(
      async () =>
        new Response("", { status: 429, statusText: "Too Many Requests" }),
    );
    await expect(client.getServerTime()).rejects.toThrow("HTTP 429");
  });

  // ── Rate limiting ──

  test("rate limiter inserts delay between consecutive requests", async () => {
    const RATE = 50; // 50 ms for test speed
    const testClient = new KrakenPublicClient(RATE);
    let callCount = 0;
    installFetch(async () => {
      callCount++;
      return new Response(JSON.stringify(TIME_FIXTURE), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const start = Date.now();
    await testClient.getServerTime();
    await testClient.getServerTime();
    const elapsed = Date.now() - start;

    expect(callCount).toBe(2);
    // Two calls should take at least RATE ms (the delay before the second call).
    expect(elapsed).toBeGreaterThanOrEqual(RATE - 5); // small tolerance
  });

  // ── Request timeout ──

  test("a request that never responds is aborted by the timeout", async () => {
    installFetch(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new Error("aborted by signal")),
          );
        }),
    );
    const timingOut = new KrakenPublicClient(0, 20);
    await expect(timingOut.getServerTime()).rejects.toThrow(
      "aborted by signal",
    );
  });

  test("every endpoint passes an abort signal", async () => {
    const signals: unknown[] = [];
    installFetch(async (input, init) => {
      signals.push(init?.signal);
      const url = String(input);
      const body = url.includes("/OHLC")
        ? OHLC_FIXTURE
        : url.includes("/AssetPairs")
          ? ASSET_PAIRS_FIXTURE
          : TIME_FIXTURE;
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    await client.getServerTime();
    await client.getAssetPairs(["XBTUSD"]);
    await client.getOhlc("XBTUSD", 15);

    expect(signals.length).toBe(3);
    for (const signal of signals) {
      expect(signal).toBeInstanceOf(AbortSignal);
    }
  });
});

// ── Global state hygiene ──────────────────────────────────────────────────────

/**
 * Regression guard for the mocked fetch leaking out of the unit tests: the
 * opt-in live smoke tests below share this module's global scope, so a mock
 * left installed would answer them with a fixture instead of api.kraken.com.
 */
test("global fetch is restored after the mocked unit tests", () => {
  expect(globalThis.fetch).toBe(ORIGINAL_FETCH);
});

// ── Optional live smoke test ───────────────────────────────────────────────────

const RUN_LIVE = process.env["KRAKEN_LIVE"] === "1";

if (RUN_LIVE) {
  describe("Live smoke tests (KRAKEN_LIVE=1)", () => {
    const liveClient = new KrakenPublicClient();

    test(
      "live: getServerTime returns a recent timestamp",
      async () => {
        const time = await liveClient.getServerTime();
        const now = Math.floor(Date.now() / 1000);
        expect(time.unixtime).toBeGreaterThan(now - 60);
        expect(time.unixtime).toBeLessThan(now + 60);
      },
      15_000,
    );

    test(
      "live: getOhlc XBTUSD 15m returns bars",
      async () => {
        const { bars, last } = await liveClient.getOhlc("XBTUSD", 15);
        expect(bars.length).toBeGreaterThan(0);
        expect(last).toBeGreaterThan(0);
        const [ts, open] = bars[0]!;
        expect(typeof ts).toBe("number");
        expect(typeof open).toBe("string");
        expect(Number(open)).toBeGreaterThan(0);
      },
      15_000,
    );
  });
}
