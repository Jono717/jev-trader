import type { TradeRecord } from "./types.ts";

/**
 * Serialise a trade log to CSV.
 *
 * Columns: barIndex, ts, side, price, volume, fee, tag
 *
 * The `tag` field is quoted if it contains a comma.
 * Returns an empty string when `trades` is empty (no header).
 */
export function tradesToCsv(trades: readonly TradeRecord[]): string {
  if (trades.length === 0) return "";

  const header = "barIndex,ts,side,price,volume,fee,tag";
  const rows = trades.map((t) => {
    const tag = t.tag.includes(",") ? `"${t.tag}"` : t.tag;
    return [
      t.barIndex,
      t.ts,
      t.side,
      t.price.toFixed(8),
      t.volume.toFixed(8),
      t.fee.toFixed(8),
      tag,
    ].join(",");
  });

  return [header, ...rows].join("\n");
}
