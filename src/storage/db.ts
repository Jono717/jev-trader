/**
 * SQLite storage for OHLCV bars using Bun's built-in bun:sqlite.
 *
 * Schema: one table with (pair, interval, ts) as primary key — upserts are
 * idempotent so re-running fetch-ohlcv never creates duplicate rows.
 */

import { Database } from "bun:sqlite";
import type { OhlcvBar } from "../types/index.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS ohlcv_bars (
  pair     TEXT    NOT NULL,
  interval INTEGER NOT NULL,
  ts       INTEGER NOT NULL,
  open     REAL    NOT NULL,
  high     REAL    NOT NULL,
  low      REAL    NOT NULL,
  close    REAL    NOT NULL,
  vwap     REAL    NOT NULL,
  volume   REAL    NOT NULL,
  count    INTEGER NOT NULL,
  PRIMARY KEY (pair, interval, ts)
);
`;

/** Open (or create) the SQLite database at `path` and ensure the schema exists. */
export function openDb(path: string): Database {
  const db = new Database(path, { create: true });
  db.run("PRAGMA journal_mode = WAL;");
  db.exec(SCHEMA);
  return db;
}

/** Upsert a batch of OHLCV bars in a single transaction. */
export function upsertBars(db: Database, bars: OhlcvBar[]): void {
  if (bars.length === 0) return;

  const stmt = db.prepare<void, {
    $pair: string;
    $interval: number;
    $ts: number;
    $open: number;
    $high: number;
    $low: number;
    $close: number;
    $vwap: number;
    $volume: number;
    $count: number;
  }>(`
    INSERT OR REPLACE INTO ohlcv_bars
      (pair, interval, ts, open, high, low, close, vwap, volume, count)
    VALUES
      ($pair, $interval, $ts, $open, $high, $low, $close, $vwap, $volume, $count)
  `);

  db.transaction(() => {
    for (const b of bars) {
      stmt.run({
        $pair: b.pair,
        $interval: b.interval,
        $ts: b.ts,
        $open: b.open,
        $high: b.high,
        $low: b.low,
        $close: b.close,
        $vwap: b.vwap,
        $volume: b.volume,
        $count: b.count,
      });
    }
  })();
}

/** Count stored bars for a given pair and interval. */
export function countBars(
  db: Database,
  pair: string,
  interval: number,
): number {
  const row = db
    .query<{ n: number }, [string, number]>(
      "SELECT COUNT(*) AS n FROM ohlcv_bars WHERE pair = ? AND interval = ?",
    )
    .get(pair, interval);
  return row?.n ?? 0;
}

/**
 * Return all stored OHLCV bars for a pair+interval, ordered by ts ASC.
 * Returns an empty array when no bars are stored yet.
 */
export function loadBars(
  db: Database,
  pair: string,
  interval: number,
): OhlcvBar[] {
  return db
    .query<OhlcvBar, [string, number]>(
      `SELECT pair, interval, ts, open, high, low, close, vwap, volume, count
       FROM ohlcv_bars
       WHERE pair = ? AND interval = ?
       ORDER BY ts ASC`,
    )
    .all(pair, interval);
}

/**
 * Return the timestamp of the most recently stored bar for a pair+interval,
 * or `null` if no bars are stored yet.
 */
export function getLatestTimestamp(
  db: Database,
  pair: string,
  interval: number,
): number | null {
  const row = db
    .query<{ ts: number | null }, [string, number]>(
      "SELECT MAX(ts) AS ts FROM ohlcv_bars WHERE pair = ? AND interval = ?",
    )
    .get(pair, interval);
  return row?.ts ?? null;
}
