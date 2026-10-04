#!/usr/bin/env bun
/**
 * fetch-ohlcv — download the most recent OHLCV window from Kraken and persist
 * it to SQLite.
 *
 * Usage:
 *   bun run fetch-ohlcv [--pair XBTUSD] [--interval 15] [--db data/ohlcv.sqlite]
 *
 * Kraken's public OHLC endpoint returns at most 720 of the most recent bars and
 * cannot reach older data regardless of `since`. One run therefore captures
 * 720 x interval minutes of history — about 7.5 days at 15 m bars. Deeper
 * history requires Kraken's downloadable OHLCVT CSV dumps, which are later work
 * (see README, "Notes for later PRs").
 *
 * Re-runs are idempotent: bars are written with INSERT OR REPLACE, and the
 * latest stored bar is re-fetched so a bar that was still forming gets its
 * final values. If a re-run happens after more than 720 bars of downtime the
 * intervening bars are unreachable from this endpoint; the script warns and
 * reports how many bars are missing rather than hiding the hole.
 */

import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import { KrakenPublicClient } from "../src/kraken/client.ts";
import { openDb, upsertBars, countBars, getLatestTimestamp } from "../src/storage/db.ts";
import type { OhlcvBar } from "../src/types/index.ts";

/** Hard ceiling Kraken's public OHLC endpoint applies to every response. */
export const MAX_BARS_PER_REQUEST = 720;

// ── CLI argument parsing ──────────────────────────────────────────────────────

/** Bar widths, in minutes, that Kraken's OHLC endpoint accepts. */
const VALID_INTERVALS: readonly number[] = [
  1, 5, 15, 30, 60, 240, 1440, 10080, 21600,
];

const USAGE =
  "Usage: bun run fetch-ohlcv [--pair XBTUSD] [--interval 15] [--db data/ohlcv.sqlite]";

/**
 * Parse the documented flags. Throws on an unrecognised flag, a flag without a
 * value, or an interval Kraken does not serve, so a typo can never be mistaken
 * for a default.
 */
export function parseArgs(argv: string[]): {
  pair: string;
  interval: number;
  db: string;
} {
  const args = { pair: "XBTUSD", interval: 15, db: "data/ohlcv.sqlite" };

  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i]!;
    const val = argv[i + 1];
    if (val === undefined) {
      throw new Error(`Missing value for ${flag}. ${USAGE}`);
    }

    if (flag === "--pair") {
      if (val.length === 0) {
        throw new Error(`--pair needs a Kraken pair name. ${USAGE}`);
      }
      args.pair = val;
    } else if (flag === "--interval") {
      const interval = Number(val);
      if (!VALID_INTERVALS.includes(interval)) {
        throw new Error(
          `Invalid --interval ${val}. Kraken serves only: ${VALID_INTERVALS.join(", ")}.`,
        );
      }
      args.interval = interval;
    } else if (flag === "--db") {
      if (val.length === 0) {
        throw new Error(`--db needs a file path. ${USAGE}`);
      }
      args.db = val;
    } else {
      throw new Error(`Unknown flag ${flag}. ${USAGE}`);
    }
  }

  return args;
}

// ── Series continuity ─────────────────────────────────────────────────────────

/**
 * Number of bars absent between the latest stored bar and the earliest bar this
 * fetch returned. Zero when the series stays contiguous.
 */
export function countMissingBars(
  latestStoredTs: number,
  earliestReturnedTs: number,
  intervalMinutes: number,
): number {
  const step = intervalMinutes * 60;
  return Math.max(0, Math.floor((earliestReturnedTs - latestStoredTs) / step) - 1);
}

/**
 * Human-readable warning for a discontinuity in the stored series, or `null`
 * when the series is contiguous.
 */
export function gapWarning(
  pair: string,
  intervalMinutes: number,
  latestStoredTs: number,
  earliestReturnedTs: number,
): string | null {
  const missing = countMissingBars(
    latestStoredTs,
    earliestReturnedTs,
    intervalMinutes,
  );
  if (missing === 0) return null;

  const from = new Date(latestStoredTs * 1000).toISOString();
  const to = new Date(earliestReturnedTs * 1000).toISOString();
  return (
    `WARNING: gap in the ${pair} ${intervalMinutes}m series — ${missing} bar(s) ` +
    `missing between ${from} and ${to}. Kraken's public OHLC endpoint only ` +
    `serves the most recent ${MAX_BARS_PER_REQUEST} bars, so these bars cannot ` +
    `be backfilled from it (see README, "Notes for later PRs").`
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { pair, interval, db: dbPath } = parseArgs(process.argv.slice(2));

  mkdirSync(dirname(dbPath), { recursive: true });
  const db = openDb(dbPath);
  const client = new KrakenPublicClient();

  const windowDays = (MAX_BARS_PER_REQUEST * interval) / (60 * 24);
  const latestStored = getLatestTimestamp(db, pair, interval);
  const since =
    latestStored === null ? undefined : latestStored - interval * 60;

  console.log(
    `fetch-ohlcv: ${pair} ${interval}m → ${dbPath}\n` +
      `  Kraken returns at most ${MAX_BARS_PER_REQUEST} of the most recent bars ` +
      `(~${windowDays.toFixed(1)} days at ${interval}m); older history is not ` +
      `reachable through this endpoint.\n` +
      (latestStored === null
        ? "  first run — storing the most recent window"
        : `  resuming from ${new Date(latestStored * 1000).toISOString()} ` +
          "(latest stored bar is re-fetched in case it was still forming)"),
  );

  const { bars: rawBars } = await client.getOhlc(pair, interval, since);

  if (rawBars.length === 0) {
    if (latestStored === null) {
      console.error(
        `Kraken returned no OHLC bars for ${pair} ${interval}m — nothing was ` +
          "stored. Check that the pair name and interval are ones Kraken lists.",
      );
      process.exitCode = 1;
      return;
    }
    console.log("No new bars returned — already up to date.");
    return;
  }

  const ohlcv: OhlcvBar[] = rawBars.map(
    ([ts, open, high, low, close, vwap, volume, count]) => ({
      pair,
      interval,
      ts,
      open: Number(open),
      high: Number(high),
      low: Number(low),
      close: Number(close),
      vwap: Number(vwap),
      volume: Number(volume),
      count,
    }),
  );

  const earliest = ohlcv[0]!.ts;
  const newest = ohlcv[ohlcv.length - 1]!.ts;

  if (latestStored !== null) {
    const warning = gapWarning(pair, interval, latestStored, earliest);
    if (warning !== null) console.warn(warning);
  }

  upsertBars(db, ohlcv);

  const total = countBars(db, pair, interval);
  console.log(
    `\nDone. Upserted ${ohlcv.length} bars ` +
      `(${new Date(earliest * 1000).toISOString()} → ` +
      `${new Date(newest * 1000).toISOString()}). ` +
      `Total ${pair} ${interval}m bars stored: ${total}`,
  );
}

if (import.meta.main) {
  await main();
}
