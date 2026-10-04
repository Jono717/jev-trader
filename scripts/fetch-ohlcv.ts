#!/usr/bin/env bun
/**
 * fetch-ohlcv — download OHLCV history from Kraken and persist to SQLite.
 *
 * Usage:
 *   bun run fetch-ohlcv [--pair XBTUSD] [--interval 15] [--db data/ohlcv.sqlite]
 *
 * On first run the script fetches up to 180 days of history by paging forward
 * from a `since` timestamp. Each Kraken OHLC response delivers at most 720 bars
 * (see README for the 720-bar limit and deeper-history alternatives).
 *
 * On subsequent runs it resumes from the last stored bar timestamp, making
 * re-runs idempotent: existing bars are updated in-place via INSERT OR REPLACE.
 */

import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import { KrakenPublicClient } from "../src/kraken/client.ts";
import { openDb, upsertBars, countBars, getLatestTimestamp } from "../src/storage/db.ts";
import type { OhlcvBar } from "../src/types/index.ts";

// ── CLI argument parsing ──────────────────────────────────────────────────────

function parseArgs(argv: string[]): {
  pair: string;
  interval: number;
  db: string;
} {
  const args = { pair: "XBTUSD", interval: 15, db: "data/ohlcv.sqlite" };
  for (let i = 0; i < argv.length - 1; i++) {
    const flag = argv[i];
    const val = argv[i + 1];
    if (val === undefined) break;
    if (flag === "--pair") {
      args.pair = val;
      i++;
    } else if (flag === "--interval") {
      args.interval = Number(val);
      i++;
    } else if (flag === "--db") {
      args.db = val;
      i++;
    }
  }
  return args;
}

const { pair, interval, db: dbPath } = parseArgs(process.argv.slice(2));

// ── Setup ─────────────────────────────────────────────────────────────────────

mkdirSync(dirname(dbPath), { recursive: true });
const db = openDb(dbPath);
const client = new KrakenPublicClient();

// Default lookback: 180 days from now (Kraken only delivers ~7.5 days per page
// at 15 min; we page forward until we reach the present).
const LOOKBACK_SECONDS = 180 * 24 * 60 * 60;
const defaultSince = Math.floor(Date.now() / 1000) - LOOKBACK_SECONDS;

// Resume from the last stored bar on re-runs.
const latestStored = getLatestTimestamp(db, pair, interval);
let since: number = latestStored ?? defaultSince;

console.log(
  `fetch-ohlcv: ${pair} ${interval}m → ${dbPath}` +
    (latestStored
      ? ` (resuming from ${new Date(latestStored * 1000).toISOString()})`
      : ` (first run, looking back ${LOOKBACK_SECONDS / 86400} days)`),
);

// ── Fetch loop ────────────────────────────────────────────────────────────────

let totalUpserted = 0;
let page = 0;
const MAX_BARS_PER_PAGE = 720;

while (true) {
  page++;
  process.stdout.write(
    `  page ${page}: since=${new Date(since * 1000).toISOString()} … `,
  );

  const { bars: rawBars, last } = await client.getOhlc(pair, interval, since);

  if (rawBars.length === 0) {
    console.log("no bars returned — up to date.");
    break;
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

  upsertBars(db, ohlcv);
  totalUpserted += ohlcv.length;
  console.log(`${ohlcv.length} bars (last: ${new Date(last * 1000).toISOString()})`);

  // Stop paging if Kraken returned a full page and there may be more.
  // `last` is the cut-off timestamp; use it as `since` for the next page.
  if (rawBars.length < MAX_BARS_PER_PAGE) {
    // Fewer than a full page means we've caught up to the present.
    break;
  }
  if (last <= since) {
    // No forward progress — already at the head.
    break;
  }
  since = last;
}

const total = countBars(db, pair, interval);
console.log(
  `\nDone. Upserted ${totalUpserted} bars this run. ` +
    `Total ${pair} ${interval}m bars stored: ${total}`,
);
