/**
 * Unit tests for the trade-log CSV exporter.
 *
 * The exported CSV is an owned text contract: `bun run backtest` prints it and
 * spreadsheets / pandas read it, so every field must follow RFC 4180 §2.6–2.7 —
 * a field containing a comma, a double quote, CR or LF is wrapped in double
 * quotes, and embedded double quotes are doubled.
 *
 * Each test parses the emitted text back with a minimal RFC 4180 reader and
 * asserts the round-tripped cell values, not the raw bytes.
 */

import { test, expect, describe } from "bun:test";
import { tradesToCsv } from "../../src/backtest/csv.ts";
import type { TradeRecord } from "../../src/backtest/types.ts";

// ── Minimal RFC 4180 reader (test-only oracle) ────────────────────────────────

/** Parse RFC 4180 text (LF or CRLF record separators) into rows of cells. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (ch === "\r") {
      // Swallow CR of a CRLF pair; a bare CR inside a field is quoted.
    } else {
      cell += ch;
    }
  }

  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeTrade(overrides: Partial<TradeRecord> = {}): TradeRecord {
  return {
    barIndex: 1,
    ts: 900,
    side: "buy",
    price: 90,
    volume: 5,
    fee: 0.72,
    tag: "entry",
    ...overrides,
  };
}

const HEADER = ["barIndex", "ts", "side", "price", "volume", "fee", "tag"];

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("tradesToCsv", () => {
  test("empty trade log emits nothing at all (not even a header)", () => {
    expect(tradesToCsv([])).toBe("");
  });

  test("header names the seven documented columns", () => {
    const rows = parseCsv(tradesToCsv([makeTrade()]));
    expect(rows[0]).toEqual(HEADER);
  });

  test("a plain trade round-trips to its field values", () => {
    const rows = parseCsv(tradesToCsv([makeTrade()]));
    expect(rows[1]).toEqual([
      "1",
      "900",
      "buy",
      "90.00000000",
      "5.00000000",
      "0.72000000",
      "entry",
    ]);
  });

  test("one row per trade, in order", () => {
    const csv = tradesToCsv([
      makeTrade({ barIndex: 1, tag: "a" }),
      makeTrade({ barIndex: 2, side: "sell", tag: "b" }),
    ]);
    const rows = parseCsv(csv);
    expect(rows.length).toBe(3);
    expect(rows[1]![0]).toBe("1");
    expect(rows[2]![0]).toBe("2");
    expect(rows[2]![2]).toBe("sell");
  });

  test("a comma in a tag does not split the row into extra cells", () => {
    const rows = parseCsv(tradesToCsv([makeTrade({ tag: "grid,level,3" })]));
    expect(rows[1]!.length).toBe(HEADER.length);
    expect(rows[1]![6]).toBe("grid,level,3");
  });

  test("a double quote in a tag is doubled and survives the round-trip", () => {
    const rows = parseCsv(tradesToCsv([makeTrade({ tag: 'rung "3"' })]));
    expect(rows[1]!.length).toBe(HEADER.length);
    expect(rows[1]![6]).toBe('rung "3"');
  });

  test("an LF in a tag stays inside one record", () => {
    const rows = parseCsv(tradesToCsv([makeTrade({ tag: "line1\nline2" })]));
    expect(rows.length).toBe(2);
    expect(rows[1]![6]).toBe("line1\nline2");
  });

  test("a CR in a tag stays inside one record", () => {
    const rows = parseCsv(tradesToCsv([makeTrade({ tag: "line1\rline2" })]));
    expect(rows.length).toBe(2);
    expect(rows[1]![6]).toBe("line1\rline2");
  });

  test("a tag mixing comma, quote and newline round-trips exactly", () => {
    const tag = 'grid,"rung"\n3';
    const rows = parseCsv(tradesToCsv([makeTrade({ tag })]));
    expect(rows.length).toBe(2);
    expect(rows[1]!.length).toBe(HEADER.length);
    expect(rows[1]![6]).toBe(tag);
  });

  test("a hostile tag cannot forge an extra column in a later row", () => {
    const csv = tradesToCsv([
      makeTrade({ barIndex: 1, tag: "x,y\n9,9,sell,1,1,1,injected" }),
      makeTrade({ barIndex: 2, tag: "clean" }),
    ]);
    const rows = parseCsv(csv);
    expect(rows.length).toBe(3);
    for (const row of rows) expect(row.length).toBe(HEADER.length);
    expect(rows[2]![0]).toBe("2");
  });

  test("an ordinary row is emitted verbatim, with no gratuitous quoting", () => {
    expect(tradesToCsv([makeTrade({ tag: "bah-entry" })])).toBe(
      "barIndex,ts,side,price,volume,fee,tag\n" +
        "1,900,buy,90.00000000,5.00000000,0.72000000,bah-entry",
    );
  });
});
