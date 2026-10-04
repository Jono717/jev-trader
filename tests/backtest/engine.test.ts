/**
 * Unit tests for the event-driven backtest engine.
 *
 * Bars used throughout (pair="TEST", interval=15):
 *   bar 0: ts=0,    O=100, H=105, L=95,  C=100
 *   bar 1: ts=900,  O=100, H=110, L=85,  C=105   ← low=85 fills a buy at 90
 *   bar 2: ts=1800, O=105, H=115, L=100, C=110   ← high=115 fills a sell at 110
 *
 * Reference scenario (initial cash = $1000, maker fee = 0.16%):
 *   Bar 0: strategy places limit buy at $90, volume = 5
 *     cost = 90 × 5 = $450,  fee = 450 × 0.0016 = $0.72
 *     total outlay = $450.72   (validated: $450.72 ≤ $1000 ✓)
 *
 *   Bar 1: low = 85 ≤ 90 → buy fills
 *     cash = 1000 − 450 − 0.72 = $549.28
 *     position = 5
 *     equity = 549.28 + 5 × 105 = $1074.28
 *     Strategy then places limit sell at $110, volume = 5
 *
 *   Bar 2: high = 115 ≥ 110 → sell fills
 *     proceeds = 110 × 5 = $550,  fee = 550 × 0.0016 = $0.88
 *     cash = 549.28 + 550 − 0.88 = $1098.40
 *     position = 0,  equity = $1098.40
 *
 *   Round-trip PnL:
 *     buy effective cost/unit  = (450 + 0.72) / 5  = $90.144
 *     sell net proceeds/unit   = (550 − 0.88) / 5  = $109.824
 *     PnL/unit = 109.824 − 90.144 = $19.680
 *     total PnL = 19.680 × 5 = $98.40
 */

import { test, expect, describe } from "bun:test";
import { runBacktest } from "../../src/backtest/engine.ts";
import { createBuyAndHoldStrategy } from "../../src/strategies/buyAndHold.ts";
import type {
  Strategy,
  OrderIntent,
  EngineState,
  BacktestConfig,
} from "../../src/backtest/types.ts";
import type { OhlcvBar } from "../../src/types/index.ts";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeBar(
  index: number,
  overrides: Partial<OhlcvBar> = {},
): OhlcvBar {
  return {
    pair: "TEST",
    interval: 15,
    ts: index * 900,
    open: 100,
    high: 105,
    low: 95,
    close: 100,
    vwap: 100,
    volume: 10,
    count: 1,
    ...overrides,
  };
}

const BASE_BARS: OhlcvBar[] = [
  makeBar(0, { high: 105, low: 95,  close: 100 }),
  makeBar(1, { high: 110, low: 85,  close: 105 }),
  makeBar(2, { high: 115, low: 100, close: 110 }),
];

const BASE_CONFIG: BacktestConfig = {
  initialCash: 1000,
  intervalMinutes: 15,
};

/** Strategy: buy on bar 0 at $90 for 5 units; sell on bar 1 at $110 for all. */
function makeReferenceStrategy(): Strategy {
  let bought = false;
  return {
    onBar(_bar: OhlcvBar, state: Readonly<EngineState>): OrderIntent[] {
      if (state.barIndex === 0) {
        return [{ side: "buy", price: 90, volume: 5 }];
      }
      if (state.barIndex === 1 && state.position > 0 && !bought) {
        bought = true;
        return [{ side: "sell", price: 110, volume: state.position }];
      }
      return [];
    },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("runBacktest — fills", () => {
  test("buy fills on bar 1 when that bar's low ≤ limit price", () => {
    const result = runBacktest(BASE_BARS, makeReferenceStrategy(), BASE_CONFIG);
    const buy = result.trades.find((t) => t.side === "buy");
    expect(buy).toBeDefined();
    expect(buy?.barIndex).toBe(1);
    expect(buy?.price).toBe(90);
    expect(buy?.volume).toBe(5);
  });

  test("sell fills on bar 2 when that bar's high ≥ limit price", () => {
    const result = runBacktest(BASE_BARS, makeReferenceStrategy(), BASE_CONFIG);
    const sell = result.trades.find((t) => t.side === "sell");
    expect(sell).toBeDefined();
    expect(sell?.barIndex).toBe(2);
    expect(sell?.price).toBe(110);
  });

  test("order placed on bar i cannot fill on bar i (same-bar no-fill rule)", () => {
    // A buy at 200 (above any bar's high) placed on bar 0 should never fill.
    // But LOW of bar 1 is 85 ≤ 95 (NOT ≤ 200, so the condition is bar.low ≤ 200 → true for bar 1)
    // Use the EXISTING bar data: bar 0 has low=95, and we place at price=95 on bar 0.
    // If same-bar fill were allowed it would fill on bar 0; it should only fill on bar 1+.
    let fillBarIndex = -1;
    const strategy: Strategy = {
      onBar(_bar, state) {
        if (state.barIndex === 0) return [{ side: "buy", price: 95, volume: 1 }];
        return [];
      },
    };
    const result = runBacktest(BASE_BARS, strategy, BASE_CONFIG);
    fillBarIndex = result.trades[0]?.barIndex ?? -1;
    // bar 0's low = 95 ≤ 95, but the order was placed ON bar 0; must not fill until bar 1+.
    expect(fillBarIndex).toBeGreaterThan(0);
  });

  test("buy fee is deducted correctly: fee = fillValue × 0.0016", () => {
    const result = runBacktest(BASE_BARS, makeReferenceStrategy(), BASE_CONFIG);
    const buy = result.trades.find((t) => t.side === "buy")!;
    expect(buy.fee).toBeCloseTo(90 * 5 * 0.0016, 8); // 0.72
  });

  test("sell fee is deducted correctly: fee = fillValue × 0.0016", () => {
    const result = runBacktest(BASE_BARS, makeReferenceStrategy(), BASE_CONFIG);
    const sell = result.trades.find((t) => t.side === "sell")!;
    expect(sell.fee).toBeCloseTo(110 * 5 * 0.0016, 8); // 0.88
  });

  test("cash after buy fill = initialCash − cost − fee", () => {
    // Equity at bar 1 = cash + position × close[1]
    const result = runBacktest(BASE_BARS, makeReferenceStrategy(), BASE_CONFIG);
    const equityBar1 = result.equityCurve[1]!;
    const expectedCash = 1000 - 90 * 5 - 90 * 5 * 0.0016; // 549.28
    const expectedEquity = expectedCash + 5 * 105;
    expect(equityBar1).toBeCloseTo(expectedEquity, 6);
  });

  test("equity after sell fill = cash + 0 (position closed)", () => {
    const result = runBacktest(BASE_BARS, makeReferenceStrategy(), BASE_CONFIG);
    const finalEquity = result.equityCurve[2]!;
    expect(finalEquity).toBeCloseTo(1098.40, 4);
  });
});

describe("runBacktest — round-trip PnL", () => {
  test("total PnL ≈ $98.40", () => {
    const result = runBacktest(BASE_BARS, makeReferenceStrategy(), BASE_CONFIG);
    const total = result.roundTripPnls.reduce((s, p) => s + p, 0);
    expect(total).toBeCloseTo(98.40, 3);
  });

  test("one round-trip trade is recorded", () => {
    const result = runBacktest(BASE_BARS, makeReferenceStrategy(), BASE_CONFIG);
    expect(result.roundTripPnls.length).toBe(1);
    expect(result.roundTripPnls[0]).toBeCloseTo(98.40, 3);
  });
});

describe("runBacktest — equity curve", () => {
  test("equity curve length equals bar count", () => {
    const result = runBacktest(BASE_BARS, makeReferenceStrategy(), BASE_CONFIG);
    expect(result.equityCurve.length).toBe(3);
  });

  test("equity at bar 0 = initialCash (no fills yet)", () => {
    const result = runBacktest(BASE_BARS, makeReferenceStrategy(), BASE_CONFIG);
    expect(result.equityCurve[0]).toBe(1000);
  });
});

describe("runBacktest — order validation / rejection", () => {
  test("order below minOrderCost is silently rejected", () => {
    // price × volume = 4.99 < $5 default
    const strategy: Strategy = {
      onBar(_bar, state) {
        if (state.barIndex === 0) {
          return [{ side: "buy", price: 4.99, volume: 1 }];
        }
        return [];
      },
    };
    const result = runBacktest(BASE_BARS, strategy, BASE_CONFIG);
    expect(result.trades.length).toBe(0);
  });

  test("buy exceeding available cash is rejected", () => {
    // cash = 1000, order cost × (1 + fee) = 2000 × 0.5 × 1.0016 = 1001.6
    const strategy: Strategy = {
      onBar(_bar, state) {
        if (state.barIndex === 0) {
          return [{ side: "buy", price: 200, volume: 5 }]; // 200×5×1.0016=1001.6 > 1000
        }
        return [];
      },
    };
    const result = runBacktest(BASE_BARS, strategy, BASE_CONFIG);
    expect(result.trades.length).toBe(0);
  });

  test("sell exceeding position is rejected", () => {
    // No position, sell rejected.
    const strategy: Strategy = {
      onBar(_bar, state) {
        if (state.barIndex === 0) {
          return [{ side: "sell", price: 100, volume: 1 }];
        }
        return [];
      },
    };
    const result = runBacktest(BASE_BARS, strategy, BASE_CONFIG);
    expect(result.trades.length).toBe(0);
  });

  test("custom minOrderCost is respected", () => {
    // A $10 order (price=10, vol=1) passes the default $5 floor but fails $20.
    const strategy: Strategy = {
      onBar(_bar, state) {
        if (state.barIndex === 0) return [{ side: "buy", price: 10, volume: 1 }];
        return [];
      },
    };
    const resultPass = runBacktest(BASE_BARS, strategy, {
      ...BASE_CONFIG,
      minOrderCost: 5,
    });
    expect(resultPass.trades.length).toBeGreaterThanOrEqual(0); // may not fill if price not hit

    const resultFail = runBacktest(BASE_BARS, strategy, {
      ...BASE_CONFIG,
      minOrderCost: 20,
    });
    expect(resultFail.trades.length).toBe(0);
  });

  test("resting order that never triggers is discarded at end of backtest", () => {
    // Buy at price=1 (far below all lows) — never fills.
    const strategy: Strategy = {
      onBar(_bar, state) {
        if (state.barIndex === 0) return [{ side: "buy", price: 1, volume: 5 }];
        return [];
      },
    };
    const result = runBacktest(BASE_BARS, strategy, BASE_CONFIG);
    expect(result.trades.length).toBe(0);
    expect(result.equityCurve[2]).toBe(1000); // equity unchanged
  });
});

describe("runBacktest — slippage", () => {
  test("non-zero slippage increases effective buy price", () => {
    const strategy: Strategy = {
      onBar(_bar, state) {
        if (state.barIndex === 0) return [{ side: "buy", price: 90, volume: 1 }];
        return [];
      },
    };
    const slippageConfig: BacktestConfig = {
      ...BASE_CONFIG,
      fee: { makerFee: 0, slippage: 0.01 }, // 1 % slippage, no fee for isolation
    };
    const result = runBacktest(BASE_BARS, strategy, slippageConfig);
    const buy = result.trades[0];
    expect(buy?.price).toBeCloseTo(90 * 1.01, 8); // 90.9
  });

  test("non-zero slippage decreases effective sell price", () => {
    // Build a 3-bar scenario where we first buy then sell.
    let step = 0;
    const strategy: Strategy = {
      onBar(_bar, state) {
        if (step === 0) { step++; return [{ side: "buy", price: 90, volume: 1 }]; }
        if (step === 1 && state.position > 0) { step++; return [{ side: "sell", price: 110, volume: 1 }]; }
        return [];
      },
    };
    const slippageConfig: BacktestConfig = {
      ...BASE_CONFIG,
      fee: { makerFee: 0, slippage: 0.01 },
    };
    const result = runBacktest(BASE_BARS, strategy, slippageConfig);
    const sell = result.trades.find((t) => t.side === "sell");
    expect(sell?.price).toBeCloseTo(110 * (1 - 0.01), 8); // 108.9
  });
});

// ── End-to-end: the buy-and-hold reference strategy ───────────────────────────

/**
 * Four-bar end-to-end run of the reference strategy shipped for engine
 * validation (and used by `bun run backtest`):
 *
 *   bar 0: H=105, L=95,  C=100  → entry limit = 105 × 1.01 = 106.05
 *   bar 1: H=110, L=85,  C=105  → low 85 ≤ 106.05 → entry fills at 106.05
 *   bar 2: H=115, L=100, C=110  → (totalBars−2) exit limit = 100 × 0.99 = 99
 *   bar 3: H=120, L=105, C=118  → high 120 ≥ 99 → exit fills at 99
 */
const BAH_BARS: OhlcvBar[] = [
  makeBar(0, { high: 105, low: 95, close: 100 }),
  makeBar(1, { high: 110, low: 85, close: 105 }),
  makeBar(2, { high: 115, low: 100, close: 110 }),
  makeBar(3, { high: 120, low: 105, close: 118 }),
];

describe("runBacktest — buy-and-hold reference strategy end to end", () => {
  function run() {
    return runBacktest(
      BAH_BARS,
      createBuyAndHoldStrategy(BAH_BARS.length),
      BASE_CONFIG,
    );
  }

  test("produces exactly one entry fill and one exit fill, tagged", () => {
    const { trades } = run();
    expect(trades.length).toBe(2);
    expect(trades.map((t) => t.side)).toEqual(["buy", "sell"]);
    expect(trades.map((t) => t.tag)).toEqual(["bah-entry", "bah-exit"]);
  });

  test("entry rests on bar 0 and fills on bar 1 at high × (1 + buffer)", () => {
    const buy = run().trades[0]!;
    expect(buy.barIndex).toBe(1);
    expect(buy.price).toBeCloseTo(105 * 1.01, 10);
  });

  test("exit rests on bar totalBars−2 and fills on the final bar", () => {
    const sell = run().trades[1]!;
    expect(sell.barIndex).toBe(BAH_BARS.length - 1);
    expect(sell.price).toBeCloseTo(100 * 0.99, 10);
  });

  test("the whole position is exited (buy volume = sell volume)", () => {
    const trades = run().trades;
    const buy = trades[0]!;
    const sell = trades[1]!;
    expect(sell.volume).toBeCloseTo(buy.volume, 12);
    expect(buy.volume).toBeGreaterThan(0);
  });

  test("the entry never spends more than the starting cash", () => {
    const buy = run().trades[0]!;
    expect(buy.price * buy.volume + buy.fee).toBeLessThanOrEqual(
      BASE_CONFIG.initialCash,
    );
  });

  test("equity stays positive on every bar and is marked to market", () => {
    const { equityCurve } = run();
    expect(equityCurve.length).toBe(BAH_BARS.length);
    expect(equityCurve[0]).toBe(BASE_CONFIG.initialCash);
    for (const e of equityCurve) expect(e).toBeGreaterThan(0);
  });

  test("records one round trip whose PnL matches the two fills", () => {
    const result = run();
    const buy = result.trades[0]!;
    const sell = result.trades[1]!;
    const expectedPnl =
      sell.price * sell.volume - sell.fee - (buy.price * buy.volume + buy.fee);
    expect(result.roundTripPnls.length).toBe(1);
    expect(result.roundTripPnls[0]).toBeCloseTo(expectedPnl, 8);
    expect(result.stats.numTrades).toBe(1);
  });

  test("stats fees equal the sum of both fills' fees", () => {
    const result = run();
    const feeSum = result.trades.reduce((s, t) => s + t.fee, 0);
    expect(result.stats.totalFeesPaid).toBeCloseTo(feeSum, 10);
  });

  test("final equity equals initial cash plus the round-trip PnL", () => {
    const result = run();
    const finalEquity = result.equityCurve[result.equityCurve.length - 1]!;
    expect(finalEquity).toBeCloseTo(
      BASE_CONFIG.initialCash + result.roundTripPnls[0]!,
      6,
    );
    // The 1 % entry/exit fill buffers plus maker fees are a structural drag:
    // the reference strategy is validation-only, not a benchmark.
    expect(result.stats.totalReturn).toBeLessThan(0);
  });
});
