#!/usr/bin/env bun
/**
 * backtest — load OHLCV bars from the PR-1 SQLite store and run the reference
 * buy-and-hold strategy through the backtesting engine, printing summary stats.
 *
 * Usage:
 *   bun run backtest [--pair XBTUSD] [--interval 15] [--db data/ohlcv.sqlite]
 *
 * Data limit:
 *   Kraken's public OHLC endpoint returns at most 720 bars per run.  Without a
 *   history deeper than what `bun run fetch-ohlcv` has accumulated (≈ 7.5 days
 *   at 15 m bars) the backtest window may be short.  Run `fetch-ohlcv` on a
 *   schedule to grow the series before backtesting.  See README for details.
 *
 * Series gaps:
 *   The engine treats consecutive bars as consecutive time steps, so a hole
 *   left by a missed scheduled fetch would distort the annualised statistics.
 *   Loaded timestamps are scanned and every discontinuity is reported before
 *   the run — a warning only; nothing is segmented or backfilled.
 *
 * The reference strategy (buy-and-hold) is for engine validation only and is
 * not a real trading strategy.
 */

import { openDb, loadBars } from "../src/storage/db.ts";
import { runBacktest } from "../src/backtest/engine.ts";
import { tradesToCsv } from "../src/backtest/csv.ts";
import { createBuyAndHoldStrategy } from "../src/strategies/buyAndHold.ts";
import type { BacktestConfig } from "../src/backtest/types.ts";

// ── CLI argument parsing ──────────────────────────────────────────────────────

const VALID_INTERVALS: readonly number[] = [
  1, 5, 15, 30, 60, 240, 1440, 10080, 21600,
];

const USAGE =
  "Usage: bun run backtest [--pair XBTUSD] [--interval 15] [--db data/ohlcv.sqlite]";

function parseArgs(argv: string[]): {
  pair: string;
  interval: number;
  db: string;
} {
  const args = { pair: "XBTUSD", interval: 15, db: "data/ohlcv.sqlite" };

  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i]!;
    if (flag !== "--pair" && flag !== "--interval" && flag !== "--db") {
      throw new Error(`Unknown flag ${flag}. ${USAGE}`);
    }
    const val = argv[i + 1];
    if (val === undefined) {
      throw new Error(`Missing value for ${flag}. ${USAGE}`);
    }

    if (flag === "--pair") {
      if (val.length === 0) throw new Error(`--pair needs a Kraken pair name. ${USAGE}`);
      args.pair = val;
    } else if (flag === "--interval") {
      const n = Number(val);
      if (!VALID_INTERVALS.includes(n)) {
        throw new Error(`Invalid --interval ${val}. Valid: ${VALID_INTERVALS.join(", ")}`);
      }
      args.interval = n;
    } else {
      if (val.length === 0) throw new Error(`--db needs a file path. ${USAGE}`);
      args.db = val;
    }
  }
  return args;
}

// ── Series continuity ───────────────────────────────────────────────────────

/** One discontinuity inside a loaded bar series. */
export interface SeriesGap {
  /** Index (into the loaded array) of the bar immediately before the gap. */
  index: number;
  /** Timestamp of the bar before the gap, in seconds. */
  fromTs: number;
  /** Timestamp of the bar after the gap, in seconds. */
  toTs: number;
  /** Number of bars absent between them. */
  missingBars: number;
}

/**
 * Scan a ts-ascending bar series for discontinuities larger than one interval.
 *
 * The engine treats consecutive array entries as consecutive time steps, so a
 * hole left by a missed `fetch-ohlcv` run silently distorts annualised stats
 * and the walk-forward window layout.  Returns one entry per gap in
 * chronological order; an empty array when the series is contiguous.
 */
export function findSeriesGaps(
  bars: readonly { ts: number }[],
  intervalMinutes: number,
): SeriesGap[] {
  if (!(intervalMinutes > 0)) {
    throw new RangeError(`intervalMinutes must be > 0, got ${intervalMinutes}`);
  }
  const step = intervalMinutes * 60;
  const gaps: SeriesGap[] = [];

  for (let i = 1; i < bars.length; i++) {
    const fromTs = bars[i - 1]!.ts;
    const toTs = bars[i]!.ts;
    const missingBars = Math.floor((toTs - fromTs) / step) - 1;
    if (missingBars > 0) gaps.push({ index: i - 1, fromTs, toTs, missingBars });
  }

  return gaps;
}

/**
 * Human-readable warning naming every gap found by `findSeriesGaps`, or `null`
 * when the series is contiguous.  Warning only: the backtest still runs over
 * the discontinuous series, and nothing is segmented or backfilled.
 */
export function seriesGapWarning(
  gaps: readonly SeriesGap[],
  pair: string,
  intervalMinutes: number,
): string | null {
  if (gaps.length === 0) return null;

  const totalMissing = gaps.reduce((s, g) => s + g.missingBars, 0);
  const lines = gaps.map(
    (g) =>
      `  • ${g.missingBars} bar(s) missing between ` +
      `${new Date(g.fromTs * 1000).toISOString()} and ` +
      `${new Date(g.toTs * 1000).toISOString()}`,
  );

  return (
    `WARNING: the ${pair} ${intervalMinutes}m series is discontinuous — ` +
    `${gaps.length} gap(s), ${totalMissing} bar(s) missing in total.\n` +
    `${lines.join("\n")}\n` +
    `The engine treats consecutive bars as consecutive time steps, so the ` +
    `annualised Sharpe/Sortino and drawdown below are computed as if the ` +
    `missing bars did not exist.`
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────

function printStats(result: ReturnType<typeof runBacktest>, pair: string, interval: number): void {
  const { stats, trades, equityCurve, rejectedOrders } = result;
  const finalEquity = equityCurve[equityCurve.length - 1] ?? 0;

  console.log(`\n═══ Backtest: ${pair} ${interval}m (buy-and-hold reference) ═══`);
  console.log(`  Bars              : ${equityCurve.length}`);
  console.log(`  Fills             : ${trades.length}`);
  console.log(`  Total return      : ${(stats.totalReturn * 100).toFixed(3)} %`);
  console.log(`  Final equity      : $${finalEquity.toFixed(2)}`);
  console.log(`  Annualised Sharpe : ${stats.annualizedSharpe.toFixed(4)}`);
  console.log(`  Annualised Sortino: ${stats.annualizedSortino === Infinity ? "∞" : stats.annualizedSortino.toFixed(4)}`);
  console.log(`  Max drawdown      : ${(stats.maxDrawdown * 100).toFixed(3)} %`);
  console.log(`  Win rate          : ${stats.numTrades === 0 ? "N/A" : (stats.winRate * 100).toFixed(1) + " %"}`);
  console.log(`  Profit factor     : ${stats.numTrades === 0 ? "N/A" : stats.profitFactor === Infinity ? "∞" : stats.profitFactor.toFixed(4)}`);
  console.log(`  Round trips       : ${stats.numTrades}`);
  console.log(`  Total fees paid   : $${stats.totalFeesPaid.toFixed(4)}`);
  console.log(`  Rejected orders   : ${stats.numRejectedOrders}`);
  console.log(`  ${stats.annualizationNote}`);

  if (rejectedOrders.length > 0) {
    const byReason = new Map<string, number>();
    for (const r of rejectedOrders) {
      byReason.set(r.reason, (byReason.get(r.reason) ?? 0) + 1);
    }
    console.warn(
      `\nWARNING: ${rejectedOrders.length} order intent(s) were not placed, so the ` +
        `statistics above describe fewer orders than the strategy asked for:`,
    );
    for (const [reason, count] of byReason) {
      console.warn(`  • ${count} × ${reason}`);
    }
  }

  if (trades.length > 0) {
    console.log("\n─── Trade log ───");
    console.log(tradesToCsv(trades));
  }
}

async function main(): Promise<void> {
  let args: ReturnType<typeof parseArgs>;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(String(err));
    process.exitCode = 1;
    return;
  }

  const { pair, interval, db: dbPath } = args;
  const fetchHint =
    `Run: bun run fetch-ohlcv --pair ${pair} --interval ${interval} --db ${dbPath}`;

  let bars: ReturnType<typeof loadBars>;
  try {
    bars = loadBars(openDb(dbPath), pair, interval);
  } catch (err) {
    console.error(
      `Could not read ${pair} ${interval}m bars from ${dbPath}: ${String(err)}\n` +
        fetchHint,
    );
    process.exitCode = 1;
    return;
  }

  if (bars.length === 0) {
    console.error(`No ${pair} ${interval}m bars found in ${dbPath}.\n` + fetchHint);
    process.exitCode = 1;
    return;
  }

  console.log(
    `Loaded ${bars.length} ${pair} ${interval}m bars from ${dbPath}\n` +
      `(Kraken cap: ≤ 720 bars per fetch-ohlcv run, ` +
      `≈ ${((720 * interval) / (60 * 24)).toFixed(1)} days at ${interval}m)`,
  );

  const gapNote = seriesGapWarning(
    findSeriesGaps(bars, interval),
    pair,
    interval,
  );
  if (gapNote !== null) console.warn(gapNote);

  const config: BacktestConfig = {
    initialCash: 1_000,
    intervalMinutes: interval,
  };

  const strategy = createBuyAndHoldStrategy(bars.length);
  const result = runBacktest(bars, strategy, config);

  printStats(result, pair, interval);
}

if (import.meta.main) {
  await main();
}
