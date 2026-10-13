import type { TradeRecord } from "./types.ts";

/**
 * Escape one CSV field per RFC 4180 §2.6/2.7.
 *
 * A field is wrapped in double quotes when it contains a comma, a double
 * quote, CR or LF; embedded double quotes are doubled.
 */
function csvField(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/**
 * Serialise a trade log to CSV (RFC 4180 quoting, LF record separator).
 *
 * Columns: barIndex, ts, side, price, volume, fee, tag
 *
 * Returns an empty string when `trades` is empty (no header).
 */
export function tradesToCsv(trades: readonly TradeRecord[]): string {
  if (trades.length === 0) return "";

  const header = "barIndex,ts,side,price,volume,fee,tag";
  const rows = trades.map((t) =>
    [
      String(t.barIndex),
      String(t.ts),
      t.side,
      t.price.toFixed(8),
      t.volume.toFixed(8),
      t.fee.toFixed(8),
      t.tag,
    ]
      .map(csvField)
      .join(","),
  );

  return [header, ...rows].join("\n");
}
