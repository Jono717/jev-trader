/**
 * Unit tests for the backtest CLI's series-continuity scan.
 *
 * The engine treats consecutive array entries as consecutive time steps, and
 * `loadBars` happily returns a series with holes left by a missed scheduled
 * `fetch-ohlcv` run.  These tests pin that such a hole is reported before the
 * backtest runs rather than silently folded into the annualised statistics.
 *
 * Run: bun test
 */

import { test, expect, describe } from "bun:test";
import {
  findSeriesGaps,
  seriesGapWarning,
  parseArgs as backtestParseArgs,
} from "../scripts/backtest.ts";
import { parseArgs as fetchParseArgs } from "../scripts/fetch-ohlcv.ts";
import { countMissingBars } from "../src/storage/db.ts";
import { KRAKEN_OHLC_INTERVALS } from "../src/kraken/client.ts";

const INTERVAL = 15; // minutes
const STEP = INTERVAL * 60; // seconds
const START_TS = 1_700_000_000;

/** A contiguous series of `n` bars starting at `START_TS`. */
function contiguous(n: number): { ts: number }[] {
  return Array.from({ length: n }, (_, i) => ({ ts: START_TS + i * STEP }));
}

describe("findSeriesGaps", () => {
  test("empty and single-bar series have no gaps", () => {
    expect(findSeriesGaps([], INTERVAL)).toEqual([]);
    expect(findSeriesGaps(contiguous(1), INTERVAL)).toEqual([]);
  });

  test("a contiguous series has no gaps", () => {
    expect(findSeriesGaps(contiguous(50), INTERVAL)).toEqual([]);
  });

  test("one missing bar is reported with its position and size", () => {
    const bars = contiguous(4);
    bars.splice(2, 1); // drop the bar at START_TS + 2×STEP
    expect(findSeriesGaps(bars, INTERVAL)).toEqual([
      {
        index: 1,
        fromTs: START_TS + STEP,
        toTs: START_TS + 3 * STEP,
        missingBars: 1,
      },
    ]);
  });

  test("a multi-bar hole reports the exact number of absent bars", () => {
    const bars = [{ ts: START_TS }, { ts: START_TS + 100 * STEP }];
    const gaps = findSeriesGaps(bars, INTERVAL);
    expect(gaps.length).toBe(1);
    expect(gaps[0]!.missingBars).toBe(99);
  });

  test("every hole in a multi-gap series is reported, in order", () => {
    const bars = [
      { ts: START_TS },
      { ts: START_TS + STEP },
      { ts: START_TS + 4 * STEP }, // 2 missing
      { ts: START_TS + 5 * STEP },
      { ts: START_TS + 9 * STEP }, // 3 missing
    ];
    const gaps = findSeriesGaps(bars, INTERVAL);
    expect(gaps.map((g) => g.missingBars)).toEqual([2, 3]);
    expect(gaps.map((g) => g.index)).toEqual([1, 3]);
  });

  test("the interval argument sets what counts as contiguous", () => {
    // Hourly bars: contiguous at interval 60, a 3-bar hole at interval 15.
    const hourly = [{ ts: START_TS }, { ts: START_TS + 3600 }];
    expect(findSeriesGaps(hourly, 60)).toEqual([]);
    expect(findSeriesGaps(hourly, 15)[0]!.missingBars).toBe(3);
  });

  test("throws on a non-positive interval", () => {
    expect(() => findSeriesGaps(contiguous(2), 0)).toThrow(RangeError);
    expect(() => findSeriesGaps(contiguous(2), -15)).toThrow(RangeError);
  });
});

describe("seriesGapWarning", () => {
  test("returns null for a contiguous series", () => {
    expect(
      seriesGapWarning(findSeriesGaps(contiguous(10), INTERVAL), "XBTUSD", INTERVAL),
    ).toBeNull();
  });

  test("names the gap count, the total missing bars and both endpoints", () => {
    const bars = [
      { ts: START_TS },
      { ts: START_TS + 3 * STEP }, // 2 missing
      { ts: START_TS + 8 * STEP }, // 4 missing
    ];
    const warning = seriesGapWarning(
      findSeriesGaps(bars, INTERVAL),
      "XBTUSD",
      INTERVAL,
    );
    expect(warning).not.toBeNull();
    expect(warning!).toContain("2 gap(s)");
    expect(warning!).toContain("6 bar(s) missing in total");
    expect(warning!).toContain("XBTUSD");
    expect(warning!).toContain(new Date(START_TS * 1000).toISOString());
    expect(warning!).toContain(
      new Date((START_TS + 8 * STEP) * 1000).toISOString(),
    );
  });

  test("lists one line per gap", () => {
    const bars = [
      { ts: START_TS },
      { ts: START_TS + 3 * STEP },
      { ts: START_TS + 8 * STEP },
      { ts: START_TS + 20 * STEP },
    ];
    const warning = seriesGapWarning(
      findSeriesGaps(bars, INTERVAL),
      "XBTUSD",
      INTERVAL,
    )!;
    expect(warning.split("\n").filter((l) => l.startsWith("  •")).length).toBe(3);
  });
});

// ── CLI store-access failure ──────────────────────────────────────────────────

/**
 * `bun run backtest` is the first command the README documents, and on a fresh
 * clone the default `data/` directory does not exist (it is gitignored).
 * `openDb` cannot create a parent directory, so the first run must report the
 * actionable fetch-ohlcv hint and exit 1 — not raise an unhandled rejection.
 *
 * The contract under test is the CLI's own stderr/exit-code surface, driven
 * through a real subprocess.
 */
describe("backtest CLI — unreadable store", () => {
  const SCRIPT = new URL("../scripts/backtest.ts", import.meta.url).pathname;

  async function runCli(dbPath: string) {
    const proc = Bun.spawn(["bun", SCRIPT, "--db", dbPath], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr, exitCode };
  }

  test("exits 1 with the fetch-ohlcv hint when the parent directory is absent", async () => {
    const missing = `${import.meta.dir}/_no_such_dir_${Date.now()}/ohlcv.sqlite`;
    const { stderr, exitCode } = await runCli(missing);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Run: bun run fetch-ohlcv");
    expect(stderr).toContain(missing);
  });

  test("the failure is reported, not thrown as an unhandled rejection", async () => {
    const missing = `${import.meta.dir}/_no_such_dir_${Date.now()}/ohlcv.sqlite`;
    const { stderr } = await runCli(missing);
    expect(stderr).not.toContain("Unhandled");
    expect(stderr).toContain("Could not read");
  });
});

// ── One definition of the Kraken interval set ────────────────────────────────

/**
 * Both CLIs annualise and store against the same series, so an interval one
 * accepts and the other rejects would let `bun run backtest` annualise against
 * a bar width no stored series uses.  The expected set below is an independent
 * oracle for the documented Kraken OHLC parameter domain.
 */
describe("backtest and fetch-ohlcv agree on the accepted intervals", () => {
  const KRAKEN_INTERVALS = [1, 5, 15, 30, 60, 240, 1440, 10080, 21600];
  const NOT_SERVED = [2, 7, 45, 90, 120, 360, 720, 43200];

  test("the shared constant is exactly the documented Kraken set", () => {
    expect([...KRAKEN_OHLC_INTERVALS]).toEqual(KRAKEN_INTERVALS);
  });

  test("every served interval is accepted by both CLIs", () => {
    for (const minutes of KRAKEN_INTERVALS) {
      expect(
        backtestParseArgs(["--interval", String(minutes)]).interval,
      ).toBe(minutes);
      expect(
        fetchParseArgs(["--interval", String(minutes)]).interval,
      ).toBe(minutes);
    }
  });

  test("every unserved interval is rejected by both CLIs", () => {
    for (const minutes of NOT_SERVED) {
      expect(() =>
        backtestParseArgs(["--interval", String(minutes)]),
      ).toThrow(/Invalid --interval/);
      expect(() =>
        fetchParseArgs(["--interval", String(minutes)]),
      ).toThrow(/Invalid --interval/);
    }
  });
});

// ── One definition of the contiguity rule ────────────────────────────────────

/**
 * `findSeriesGaps` (backtest CLI, adjacent loaded bars) and `countMissingBars`
 * (fetch-ohlcv, the seam of a freshly fetched window) must report the same gap
 * size for the same discontinuity, or the two CLIs would disagree about the
 * same database.
 */
describe("findSeriesGaps and countMissingBars report the same gap size", () => {
  test("agree across a range of hole sizes and intervals", () => {
    for (const interval of [1, 15, 60, 1440]) {
      const step = interval * 60;
      for (const skipped of [0, 1, 2, 5, 99, 800]) {
        const fromTs = START_TS;
        const toTs = START_TS + (skipped + 1) * step;
        const viaScan = findSeriesGaps([{ ts: fromTs }, { ts: toTs }], interval);
        const viaSeam = countMissingBars(fromTs, toTs, interval);
        expect(viaSeam).toBe(skipped);
        if (skipped === 0) {
          expect(viaScan).toEqual([]);
        } else {
          expect(viaScan[0]!.missingBars).toBe(viaSeam);
        }
      }
    }
  });

  test("neither reports a gap for a non-advancing timestamp", () => {
    expect(countMissingBars(START_TS, START_TS, INTERVAL)).toBe(0);
    expect(findSeriesGaps([{ ts: START_TS }, { ts: START_TS }], INTERVAL)).toEqual(
      [],
    );
  });
});
