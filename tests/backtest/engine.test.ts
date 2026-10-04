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
import { runBacktest, buyCost, fillEconomics } from "../../src/backtest/engine.ts";
import { createBuyAndHoldStrategy } from "../../src/strategies/buyAndHold.ts";
import { runWalkForward } from "../../src/backtest/walkforward.ts";
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
  test("order below minOrderCost is rejected and reported", () => {
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
    expect(result.rejectedOrders.map((r) => r.reason)).toEqual([
      "below-min-order-cost",
    ]);
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
    // A buy at 95 × 1 = $95 is reached by bar 1's low (85) so it really fills.
    const strategy: Strategy = {
      onBar(_bar, state) {
        if (state.barIndex === 0) return [{ side: "buy", price: 95, volume: 1 }];
        return [];
      },
    };
    const resultPass = runBacktest(BASE_BARS, strategy, {
      ...BASE_CONFIG,
      minOrderCost: 5,
    });
    expect(resultPass.trades.length).toBe(1);
    expect(resultPass.trades[0]!.barIndex).toBe(1);

    const resultFail = runBacktest(BASE_BARS, strategy, {
      ...BASE_CONFIG,
      minOrderCost: 100, // $95 order now below the floor
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

// ── Resting-order exposure reservation ───────────────────────────────────────

/**
 * The engine is spot-only long/flat: cash never goes negative and the position
 * is never short.  Validating an intent against the raw balance lets a ladder
 * of orders resting at the same time over-commit the account, so each intent
 * is validated against the balance not already committed to resting orders.
 */
describe("runBacktest — resting-order exposure is reserved", () => {
  /** Returns `count` identical buy intents on bar 0 only. */
  function laddersBuys(count: number, price: number, volume: number): Strategy {
    return {
      onBar(_bar, state) {
        if (state.barIndex !== 0) return [];
        return Array.from({ length: count }, (_, k) => ({
          side: "buy" as const,
          price,
          volume,
          tag: `rung-${k}`,
        }));
      },
    };
  }

  test("two same-bar buys that only fit one at a time: only one rests", () => {
    // Each buy costs 150 × 5 × 1.0016 = 751.2 ≤ 1000, but 1502.4 together.
    const result = runBacktest(BASE_BARS, laddersBuys(2, 150, 5), BASE_CONFIG);
    expect(result.trades.length).toBe(1);
    expect(result.trades[0]!.tag).toBe("rung-0");
  });

  test("cash never goes negative when a ladder over-commits", () => {
    const result = runBacktest(BASE_BARS, laddersBuys(2, 150, 5), BASE_CONFIG);
    const buy = result.trades[0]!;
    const cashAfterBuy =
      BASE_CONFIG.initialCash - buy.price * buy.volume - buy.fee;
    expect(cashAfterBuy).toBeGreaterThanOrEqual(0);
    // Equity at the fill bar = cash + position × close, both non-negative.
    expect(result.equityCurve[1]!).toBeCloseTo(cashAfterBuy + 5 * 105, 6);
  });

  test("a wide ladder rests only as many rungs as the cash covers", () => {
    // 1000 cash, each rung 90 × 2 × 1.0016 = 180.29 → 5 rungs fit (901.4).
    const result = runBacktest(BASE_BARS, laddersBuys(8, 90, 2), BASE_CONFIG);
    expect(result.trades.length).toBe(5);
    const spent = result.trades.reduce(
      (s, t) => s + t.price * t.volume + t.fee,
      0,
    );
    expect(spent).toBeLessThanOrEqual(BASE_CONFIG.initialCash);
  });

  test("the rungs that did not fit are reported, not dropped silently", () => {
    const result = runBacktest(BASE_BARS, laddersBuys(8, 90, 2), BASE_CONFIG);
    expect(result.rejectedOrders.length).toBe(3);
    expect(result.stats.numRejectedOrders).toBe(3);
    expect(result.rejectedOrders.map((r) => r.reason)).toEqual([
      "insufficient-available-cash",
      "insufficient-available-cash",
      "insufficient-available-cash",
    ]);
    // The rejected intents are the exact rungs the strategy asked for.
    expect(result.rejectedOrders.map((r) => r.intent.tag)).toEqual([
      "rung-5",
      "rung-6",
      "rung-7",
    ]);
    expect(result.rejectedOrders.every((r) => r.barIndex === 0)).toBe(true);
  });

  test("a ladder sized from availableCash places every rung", () => {
    const rungs = 8;
    const price = 90;
    const strategy: Strategy = {
      onBar(_bar, state) {
        if (state.barIndex !== 0) return [];
        // Each rung takes an equal slice of what is actually spendable.
        const budget = (state.availableCash * 0.99) / rungs;
        const perRung = budget / buyCost(price, 1, state.fee);
        return Array.from({ length: rungs }, (_, k) => ({
          side: "buy" as const,
          price,
          volume: perRung,
          tag: `rung-${k}`,
        }));
      },
    };
    const result = runBacktest(BASE_BARS, strategy, BASE_CONFIG);
    expect(result.rejectedOrders.length).toBe(0);
    expect(result.stats.numRejectedOrders).toBe(0);
    expect(result.trades.length).toBe(rungs);
    const spent = result.trades.reduce(
      (s, t) => s + t.price * t.volume + t.fee,
      0,
    );
    expect(spent).toBeLessThanOrEqual(BASE_CONFIG.initialCash);
    expect(spent).toBeCloseTo(BASE_CONFIG.initialCash * 0.99, 6);
  });

  test("availableCash shrinks as orders rest and recovers when they fill", () => {
    const seen: { bar: number; cash: number; available: number }[] = [];
    const strategy: Strategy = {
      onBar(_bar, state) {
        seen.push({
          bar: state.barIndex,
          cash: state.cash,
          available: state.availableCash,
        });
        if (state.barIndex === 0) {
          return [{ side: "buy", price: 90, volume: 5 }];
        }
        return [];
      },
    };
    runBacktest(BASE_BARS, strategy, BASE_CONFIG);
    // Bar 0: nothing resting yet, so the two agree.
    expect(seen[0]!.cash).toBe(1000);
    expect(seen[0]!.available).toBe(1000);
    // Bar 1: the buy has filled, so cash dropped and nothing is reserved.
    expect(seen[1]!.available).toBe(seen[1]!.cash);
    expect(seen[1]!.cash).toBeCloseTo(1000 - 450 - 0.72, 6);
  });

  test("availablePosition excludes volume reserved by a resting sell", () => {
    const seen: { bar: number; position: number; available: number }[] = [];
    const strategy: Strategy = {
      onBar(_bar, state) {
        seen.push({
          bar: state.barIndex,
          position: state.position,
          available: state.availablePosition,
        });
        if (state.barIndex === 0) {
          return [{ side: "buy", price: 90, volume: 5 }];
        }
        // Rest a sell at a price bar 2 cannot reach, so it stays resting.
        if (state.barIndex === 1 && state.availablePosition > 0) {
          return [{ side: "sell", price: 500, volume: state.availablePosition }];
        }
        return [];
      },
    };
    runBacktest(BASE_BARS, strategy, BASE_CONFIG);
    // Bar 1: position 5, nothing reserved yet.
    expect(seen[1]!.position).toBe(5);
    expect(seen[1]!.available).toBe(5);
    // Bar 2: the unfilled sell reserves the whole position.
    expect(seen[2]!.position).toBe(5);
    expect(seen[2]!.available).toBe(0);
  });

  test("each rejection reason is reported distinctly", () => {
    const strategy: Strategy = {
      onBar(_bar, state) {
        if (state.barIndex !== 0) return [];
        return [
          { side: "buy", price: -1, volume: 1, tag: "bad-price" },
          { side: "buy", price: 100, volume: 0.001, tag: "too-small" },
          { side: "buy", price: 100, volume: 100, tag: "too-rich" },
          { side: "sell", price: 100, volume: 1, tag: "unowned" },
        ];
      },
    };
    const result = runBacktest(BASE_BARS, strategy, BASE_CONFIG);
    expect(result.trades.length).toBe(0);
    expect(
      result.rejectedOrders.map((r) => [r.intent.tag, r.reason]),
    ).toEqual([
      ["bad-price", "invalid"],
      ["too-small", "below-min-order-cost"],
      ["too-rich", "insufficient-available-cash"],
      ["unowned", "insufficient-available-position"],
    ]);
    expect(result.stats.numRejectedOrders).toBe(4);
  });

  test("two resting sells of the whole position: only one rests", () => {
    const strategy: Strategy = {
      onBar(_bar, state) {
        if (state.barIndex === 0) {
          return [{ side: "buy", price: 90, volume: 5, tag: "entry" }];
        }
        if (state.barIndex === 1 && state.position > 0) {
          return [
            { side: "sell", price: 110, volume: state.position, tag: "exit-a" },
            { side: "sell", price: 110, volume: state.position, tag: "exit-b" },
          ];
        }
        return [];
      },
    };
    const result = runBacktest(BASE_BARS, strategy, BASE_CONFIG);
    const sells = result.trades.filter((t) => t.side === "sell");
    expect(sells.length).toBe(1);
    expect(sells[0]!.tag).toBe("exit-a");
    // The duplicate is reported rather than dropped silently.
    expect(result.rejectedOrders.map((r) => [r.intent.tag, r.reason])).toEqual([
      ["exit-b", "insufficient-available-position"],
    ]);
    expect(result.stats.numRejectedOrders).toBe(1);
  });

  test("the position is never sold short by duplicate resting sells", () => {
    const strategy: Strategy = {
      onBar(_bar, state) {
        if (state.barIndex === 0) {
          return [{ side: "buy", price: 90, volume: 5 }];
        }
        if (state.barIndex === 1 && state.position > 0) {
          return [
            { side: "sell", price: 110, volume: state.position },
            { side: "sell", price: 110, volume: state.position },
          ];
        }
        return [];
      },
    };
    const result = runBacktest(BASE_BARS, strategy, BASE_CONFIG);
    const bought = result.trades
      .filter((t) => t.side === "buy")
      .reduce((s, t) => s + t.volume, 0);
    const sold = result.trades
      .filter((t) => t.side === "sell")
      .reduce((s, t) => s + t.volume, 0);
    expect(sold).toBeLessThanOrEqual(bought);
    // One clean round trip, not a doubled credit.
    expect(result.roundTripPnls.length).toBe(1);
  });

  test("a resting buy from an earlier bar still reserves its cash", () => {
    // Bar 0 rests a buy at 1 (never fills). Bar 1 asks for a second buy whose
    // cost only fits if the first order's reservation is ignored.
    const strategy: Strategy = {
      onBar(_bar, state) {
        if (state.barIndex === 0) {
          return [{ side: "buy", price: 1, volume: 600, tag: "deep" }];
        }
        if (state.barIndex === 1) {
          return [{ side: "buy", price: 100, volume: 5, tag: "second" }];
        }
        return [];
      },
    };
    // deep reserves 600 × 1.0016 = 600.96; second needs 500 × 1.0016 = 500.8.
    // 600.96 + 500.8 = 1101.76 > 1000 → the second order must be rejected.
    const result = runBacktest(BASE_BARS, strategy, BASE_CONFIG);
    expect(result.trades.map((t) => t.tag)).not.toContain("second");
  });

  test("slippage is included in the reserved buy cost", () => {
    // Cash 100. Limit 99 × 1 slips to 99.99; with a 1 % fee the all-in cost is
    // 100.99 > 100, so the order must be rejected rather than overspend.
    const strategy: Strategy = {
      onBar(_bar, state) {
        if (state.barIndex === 0) return [{ side: "buy", price: 99, volume: 1 }];
        return [];
      },
    };
    const config: BacktestConfig = {
      initialCash: 100,
      intervalMinutes: 15,
      fee: { makerFee: 0.01, slippage: 0.01 },
    };
    const result = runBacktest(BASE_BARS, strategy, config);
    expect(result.trades.length).toBe(0);
    expect(result.equityCurve.every((e) => e >= 0)).toBe(true);
  });

  test("a buy that fits once slippage is counted still fills", () => {
    const strategy: Strategy = {
      onBar(_bar, state) {
        if (state.barIndex === 0) return [{ side: "buy", price: 90, volume: 1 }];
        return [];
      },
    };
    const config: BacktestConfig = {
      initialCash: 100,
      intervalMinutes: 15,
      fee: { makerFee: 0.01, slippage: 0.01 },
    };
    const result = runBacktest(BASE_BARS, strategy, config);
    expect(result.trades.length).toBe(1);
    const fill = result.trades[0]!;
    expect(fill.price).toBeCloseTo(90 * 1.01, 8);
    expect(fill.price * fill.volume + fill.fee).toBeLessThanOrEqual(100);
  });
});

// ── Reservation and fill share one cost rule ─────────────────────────────────

/**
 * `fillEconomics` is the single definition of how a limit order becomes cash
 * movement; `buyCost` is derived from it.  If the two ever diverge, the
 * reservation stops bounding the real outlay and the over-commitment the
 * reservation exists to prevent reopens.
 */
describe("fillEconomics / buyCost", () => {
  const FEE = { makerFee: 0.0016, takerFee: 0.0026, slippage: 0.02 };

  test("buyCost equals what the engine's buy fill actually spends", () => {
    const strategy: Strategy = {
      onBar(_bar, state) {
        if (state.barIndex === 0) return [{ side: "buy", price: 90, volume: 2 }];
        return [];
      },
    };
    const result = runBacktest(BASE_BARS, strategy, {
      initialCash: 1000,
      intervalMinutes: 15,
      fee: FEE,
    });
    const fill = result.trades[0]!;
    const spent = fill.price * fill.volume + fill.fee;
    expect(spent).toBeCloseTo(buyCost(90, 2, FEE), 10);
  });

  test("buyCost is linear in volume, so a unit cost sizes an order exactly", () => {
    expect(buyCost(90, 7, FEE)).toBeCloseTo(7 * buyCost(90, 1, FEE), 10);
  });

  test("slippage moves the fill price against each side", () => {
    expect(fillEconomics("buy", 100, 1, FEE).fillPrice).toBeCloseTo(102, 10);
    expect(fillEconomics("sell", 100, 1, FEE).fillPrice).toBeCloseTo(98, 10);
  });

  test("cashDelta is an outlay for a buy and proceeds for a sell", () => {
    const buy = fillEconomics("buy", 100, 1, FEE);
    expect(buy.cashDelta).toBeCloseTo(-(buy.fillValue + buy.fee), 10);
    const sell = fillEconomics("sell", 100, 1, FEE);
    expect(sell.cashDelta).toBeCloseTo(sell.fillValue - sell.fee, 10);
  });

  test("a sell fill credits exactly fillValue minus the fee", () => {
    const strategy: Strategy = {
      onBar(_bar, state) {
        if (state.barIndex === 0) return [{ side: "buy", price: 90, volume: 2 }];
        if (state.barIndex === 1 && state.availablePosition > 0) {
          return [{ side: "sell", price: 110, volume: state.availablePosition }];
        }
        return [];
      },
    };
    const result = runBacktest(BASE_BARS, strategy, {
      initialCash: 1000,
      intervalMinutes: 15,
      fee: FEE,
    });
    const sell = result.trades.find((t) => t.side === "sell")!;
    const econ = fillEconomics("sell", 110, 2, FEE);
    expect(sell.price).toBeCloseTo(econ.fillPrice, 10);
    expect(sell.fee).toBeCloseTo(econ.fee, 10);
  });
});

// ── Buy-and-hold sizing under configured slippage ────────────────────────────

/**
 * The reference strategy must size with the engine's own cost rule, so a
 * configured slippage cannot silently turn the run into a zero-activity report
 * (no trades, 0 % return, 0 Sharpe) that still looks like a backtest.
 */
describe("buy-and-hold reference strategy under slippage", () => {
  function runWithSlippage(slippage: number) {
    return runBacktest(BAH_BARS, createBuyAndHoldStrategy(BAH_BARS.length), {
      initialCash: 1000,
      intervalMinutes: 15,
      fee: { slippage },
    });
  }

  test("2 % slippage still produces a round trip, not an empty report", () => {
    const result = runWithSlippage(0.02);
    expect(result.trades.length).toBe(2);
    expect(result.rejectedOrders.length).toBe(0);
    expect(result.stats.numRejectedOrders).toBe(0);
    expect(result.roundTripPnls.length).toBe(1);
    expect(result.stats.totalReturn).not.toBe(0);
  });

  test("the entry never exceeds the cash available to spend", () => {
    for (const slippage of [0, 0.005, 0.01, 0.02, 0.05]) {
      const result = runWithSlippage(slippage);
      const buy = result.trades.find((t) => t.side === "buy");
      expect(buy).toBeDefined();
      expect(buy!.price * buy!.volume + buy!.fee).toBeLessThanOrEqual(1000);
      expect(result.rejectedOrders.length).toBe(0);
    }
  });

  test("heavier slippage deploys less base currency", () => {
    const light = runWithSlippage(0).trades[0]!.volume;
    const heavy = runWithSlippage(0.05).trades[0]!.volume;
    expect(heavy).toBeLessThan(light);
  });

  test("equity stays positive at every configured slippage", () => {
    for (const slippage of [0, 0.02, 0.05]) {
      const result = runWithSlippage(slippage);
      for (const e of result.equityCurve) expect(e).toBeGreaterThan(0);
    }
  });
});

// ── Resolved-config validation ───────────────────────────────────────────────

/**
 * Fees and slippage are fractions.  A percent/fraction mix-up used to invert
 * the sell side: `slippage: 2` gave `fillPrice = 99 × (1 − 2) = −99`, so the
 * exit *removed* cash and the run reported a negative equity curve and a
 * 129.7 % drawdown without erroring.  The engine now rejects a configuration
 * outside the domain its arithmetic can honour.
 */
describe("runBacktest — resolved config validation", () => {
  function run(config: Partial<BacktestConfig>) {
    return runBacktest(BAH_BARS, createBuyAndHoldStrategy(BAH_BARS.length), {
      initialCash: 1000,
      intervalMinutes: 15,
      ...config,
    });
  }

  test("a percent-for-fraction slippage is rejected, not silently inverted", () => {
    expect(() => run({ fee: { slippage: 2 } })).toThrow(RangeError);
    expect(() => run({ fee: { slippage: 2 } })).toThrow(/fee\.slippage/);
    expect(() => run({ fee: { slippage: 1 } })).toThrow(RangeError);
  });

  test("negative slippage is rejected (it would fill better than the limit)", () => {
    expect(() => run({ fee: { slippage: -0.5 } })).toThrow(RangeError);
  });

  test("a negative fee is rejected (it would rebate every fill)", () => {
    expect(() => run({ fee: { makerFee: -0.01 } })).toThrow(/fee\.makerFee/);
    expect(() => run({ fee: { takerFee: -0.01 } })).toThrow(/fee\.takerFee/);
  });

  test("a fee of 100 % or more is rejected (a sell would remove cash)", () => {
    expect(() => run({ fee: { makerFee: 1 } })).toThrow(RangeError);
    expect(() => run({ fee: { makerFee: 2 } })).toThrow(RangeError);
  });

  test("a non-finite fee field is rejected", () => {
    expect(() => run({ fee: { slippage: Number.NaN } })).toThrow(RangeError);
    expect(() => run({ fee: { makerFee: Number.POSITIVE_INFINITY } })).toThrow(
      RangeError,
    );
  });

  test("a negative or non-finite minOrderCost is rejected", () => {
    expect(() => run({ minOrderCost: -5 })).toThrow(/minOrderCost/);
    expect(() => run({ minOrderCost: Number.NaN })).toThrow(RangeError);
  });

  test("minOrderCost of exactly 0 is allowed (no floor)", () => {
    expect(() => run({ minOrderCost: 0 })).not.toThrow();
  });

  test("a non-positive or non-finite initialCash is rejected", () => {
    expect(() => run({ initialCash: 0 })).toThrow(/initialCash/);
    expect(() => run({ initialCash: -1000 })).toThrow(RangeError);
    expect(() => run({ initialCash: Number.NaN })).toThrow(RangeError);
  });

  test("the Kraken defaults and the documented knobs still run", () => {
    expect(() => run({})).not.toThrow();
    expect(() =>
      run({ fee: { makerFee: 0.0016, takerFee: 0.0026, slippage: 0 } }),
    ).not.toThrow();
    expect(() => run({ fee: { makerFee: 0, slippage: 0 } })).not.toThrow();
    expect(() => run({ fee: { slippage: 0.02 } })).not.toThrow();
  });

  test("across every accepted fee config, equity and drawdown stay in domain", () => {
    for (const makerFee of [0, 0.0016, 0.0026, 0.5, 0.999]) {
      for (const slippage of [0, 0.01, 0.02, 0.5, 0.999]) {
        const result = run({ fee: { makerFee, slippage } });
        for (const e of result.equityCurve) {
          expect(e).toBeGreaterThanOrEqual(0);
        }
        expect(result.stats.maxDrawdown).toBeGreaterThanOrEqual(0);
        expect(result.stats.maxDrawdown).toBeLessThanOrEqual(1);
        expect(Number.isFinite(result.stats.totalReturn)).toBe(true);
      }
    }
  });

  test("the walk-forward runner rejects the same config, per window", () => {
    expect(() =>
      runWalkForward(
        BAH_BARS,
        () => createBuyAndHoldStrategy(2),
        { trainSize: 1, testSize: 2, step: 2 },
        { initialCash: 1000, intervalMinutes: 15, fee: { slippage: 2 } },
      ),
    ).toThrow(RangeError);
  });
});
