/**
 * Unit tests for the fetch-ohlcv series-continuity helpers.
 *
 * Kraken's public OHLC endpoint only serves the most recent 720 bars, so a run
 * that happens after a longer outage cannot reach the intervening bars. These
 * tests pin the behaviour that such a hole is reported rather than hidden.
 *
 * Run: bun test
 */

import { test, expect, describe } from "bun:test";
import {
  countMissingBars,
  gapWarning,
  MAX_BARS_PER_REQUEST,
} from "../scripts/fetch-ohlcv.ts";

const INTERVAL = 15; // minutes
const STEP = INTERVAL * 60; // seconds
const STORED_TS = 1_700_000_000;

describe("countMissingBars", () => {
  test("reports no gap when the next bar follows immediately", () => {
    expect(countMissingBars(STORED_TS, STORED_TS + STEP, INTERVAL)).toBe(0);
  });

  test("reports no gap when the stored bar itself is re-fetched", () => {
    expect(countMissingBars(STORED_TS, STORED_TS, INTERVAL)).toBe(0);
  });

  test("counts the bars skipped over a discontinuity", () => {
    expect(countMissingBars(STORED_TS, STORED_TS + STEP * 5, INTERVAL)).toBe(4);
  });

  test("counts a full outage longer than Kraken's window", () => {
    // Two weeks idle at 15 m = 1344 bars; only the most recent 720 are reachable.
    const idleBars = 1_344;
    const earliest = STORED_TS + STEP * (idleBars - MAX_BARS_PER_REQUEST + 1);
    expect(countMissingBars(STORED_TS, earliest, INTERVAL)).toBe(
      idleBars - MAX_BARS_PER_REQUEST,
    );
  });

  test("scales with the bar interval", () => {
    const hourly = 60;
    expect(countMissingBars(STORED_TS, STORED_TS + 3_600 * 3, hourly)).toBe(2);
  });
});

describe("gapWarning", () => {
  test("returns null for a contiguous series", () => {
    expect(gapWarning("XBTUSD", INTERVAL, STORED_TS, STORED_TS + STEP)).toBeNull();
  });

  test("names the pair, interval and missing bar count on a gap", () => {
    const warning = gapWarning("XBTUSD", INTERVAL, STORED_TS, STORED_TS + STEP * 5);
    expect(warning).not.toBeNull();
    expect(warning).toContain("XBTUSD 15m");
    expect(warning).toContain("4 bar(s) missing");
  });

  test("reports the boundaries of the hole in ISO time", () => {
    const earliest = STORED_TS + STEP * 3;
    const warning = gapWarning("ETHUSD", INTERVAL, STORED_TS, earliest);
    expect(warning).toContain(new Date(STORED_TS * 1000).toISOString());
    expect(warning).toContain(new Date(earliest * 1000).toISOString());
  });
});
