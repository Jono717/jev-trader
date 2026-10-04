# jev-trader

A low-frequency crypto trading system for Kraken Pro. **No real money goes in
until a strategy has passed out-of-sample backtesting (with fees and slippage),
a multiple-testing adjustment, and paper trading.**

---

## Design philosophy

- **Low-frequency, limit-order only.** All entries and exits use resting limit
  orders to capture the maker rebate on Kraken Pro and avoid slippage. No
  market orders, no high-frequency logic.
- **Test before you trade.** Every strategy must pass a multi-phase validation
  pipeline before live capital is touched: in-sample optimisation → out-of-sample
  backtest → multiple-testing penalty → paper trading with real latency → small
  live deployment.
- **Minimal dependencies.** The project uses Bun built-ins (`fetch`,
  `bun:sqlite`, `bun test`) wherever possible and keeps the dependency tree
  thin.
- **Phased delivery.** This repository is built in small, reviewable PRs. Grid
  trading logic does not land until the backtesting harness (PR 2) proves the
  strategy works on unseen data.

---

## Roadmap

| PR | Scope |
|----|-------|
| **1 — Foundation** (merged) | Bun/TypeScript scaffold, Kraken public client, OHLCV fetch + SQLite storage, core types |
| **2 — Backtesting harness** (this PR) | Indicator library, event-driven engine, walk-forward runner, Deflated Sharpe Ratio, fee model |
| **3 — Grid strategy** | Grid-trading logic, parameter search over BTC/USD 15 m bars |
| **4 — Paper trading** | Websocket feed, simulated order book, P&L tracker |
| **5 — Authenticated client & risk manager** | Private Kraken endpoints, position limits, drawdown guard |
| **6 — Live deployment** | Mac mini launchd service, alerting webhook, monitoring |

---

## Prerequisites

- [Bun](https://bun.sh) ≥ 1.1 (`curl -fsSL https://bun.sh/install | bash`)
- Git

---

## Setup

```bash
git clone https://github.com/Jono717/jev-trader.git
cd jev-trader
bun install

# Copy the example env file and fill in credentials when you reach PR 5+
cp .env.example .env   # keep .env out of git — it's in .gitignore
```

---

## Run a backtest

```bash
bun run backtest
```

Loads bars from the SQLite store (default `data/ohlcv.sqlite`) and runs the
buy-and-hold reference strategy through the backtesting engine, printing
summary statistics.

**Options:**

| Flag | Default | Description |
|------|---------|-------------|
| `--pair` | `XBTUSD` | Kraken pair name |
| `--interval` | `15` | Bar width in minutes |
| `--db` | `data/ohlcv.sqlite` | SQLite file path |

```bash
# Examples
bun run backtest --pair ETHUSD --interval 60
bun run backtest --db data/eth_1h.sqlite --pair ETHUSD --interval 60
```

**720-bar data limit:** The backtest window is limited to the history that
`bun run fetch-ohlcv` has accumulated (at most 720 bars per run, ≈ 7.5 days
at 15 m). Run `fetch-ohlcv` on a schedule to grow the series before
backtesting. See [Notes for later PRs](#notes-for-later-prs).

**Series gaps are reported before the run.** The engine treats consecutive
bars as consecutive time steps, so a hole left by a missed scheduled fetch
would silently distort annualised Sharpe/Sortino, drawdown and the
walk-forward window layout. After loading, the CLI scans the stored timestamps
and prints a warning naming each gap's position and size. It is a warning
only — the backtest still runs over the series as stored, and nothing is
segmented or backfilled.

### Buy-and-hold reference strategy

The `bun run backtest` CLI runs a trivial buy-and-hold strategy: enter on bar 0
and exit on bar N−1. This strategy is for engine validation only — it is **not**
a real trading strategy and must not be used with live capital.

---

## Backtesting harness (PR 2)

The backtesting harness lives in `src/backtest/` and `src/indicators/`.

### Indicator library

Pure TypeScript, no lookahead, no external dependencies:

```typescript
import { ema, rsi, atr, bollingerBands, rollingVwap } from "./src/indicators/index.ts";

// Each function returns an array aligned to the input bars.
// Indices before the warmup window are filled with NaN / undefined.
const emaValues = ema(closes, 20);        // EMA-20
const rsiValues = rsi(closes, 14);        // RSI-14 (Wilder's smoothing)
const atrValues = atr(bars, 14);          // ATR-14 (Wilder's smoothing)
const bb = bollingerBands(closes, 20, 2); // BB(20, 2σ)
const vwap = rollingVwap(bars, 20);       // rolling VWAP + deviation, 20 bars
```

`ema`, `rsi` and `atr` return `NaN` across their warmup region; the
object-valued `bollingerBands` and `rollingVwap` return `undefined` instead of
a stand-in value — including a VWAP window in which no volume traded, which
has no VWAP at all (as opposed to a 0 % deviation).

### Backtest engine

```typescript
import { runBacktest } from "./src/backtest/engine.ts";

const result = runBacktest(bars, myStrategy, {
  initialCash: 1_000,
  intervalMinutes: 15,
  fee: { makerFee: 0.0016, takerFee: 0.0026, slippage: 0 },
  minOrderCost: 5, // Kraken $5 minimum
});

console.log(result.stats);
// result.equityCurve — mark-to-market equity per bar
// result.trades      — all fills (CSV via tradesToCsv, RFC 4180 quoting)
```

Fill rule (conservative, no lookahead):
- A resting limit buy at price P fills only when a **later** bar's low ≤ P.
- A resting limit sell at price P fills only when a **later** bar's high ≥ P.
- Orders placed on bar i cannot fill on bar i.

Fee model: Kraken maker 0.16 % / taker 0.26 % (all limit orders use maker).
Slippage: configurable, default 0 for limit orders.

### Summary statistics

Annualisation uses a **365-day year** (crypto trades 24/7 continuously):

```
barsPerYear = 365 × 24 × 60 / intervalMinutes
```

Examples: 15 m → 35 040 bars/year; 1 h → 8 760; 1 d → 365.

Metrics reported:
- Total return, annualised Sharpe, annualised Sortino (risk-free rate = 0)
- Max drawdown (peak-to-trough equity fraction)
- Win rate, profit factor, number of trades, total fees paid

### Walk-forward runner

```typescript
import { runWalkForward } from "./src/backtest/walkforward.ts";

const result = runWalkForward(
  bars,
  (trainBars) => myStrategyFactory(trainBars), // called per window
  { trainSize: 480, testSize: 240, step: 240 },
  { initialCash: 1_000, intervalMinutes: 15 },
);

// result.windows[i].result  — per-window backtest result
// result.aggregateStats     — combined out-of-sample stats
```

`step` must be **≥ `testSize`**. A smaller step would overlap consecutive
out-of-sample spans, counting the same bar returns more than once in
`aggregateStats` and inflating the observation count T that feeds the Deflated
Sharpe Ratio; such a configuration is rejected with a `RangeError`.

### Deflated Sharpe Ratio

Corrects for selection bias when testing multiple strategy variants
(Bailey, Borger & Lopez de Prado 2014):

```typescript
import { deflatedSharpeRatio, deannualizeSharpe } from "./src/backtest/walkforward.ts";

const { dsr, benchmarkSharpe, sharpeStdError } = deflatedSharpeRatio({
  // Per-observation (per-bar) Sharpe — NOT annualised.  `SummaryStats`
  // reports an annualised figure, so convert it first.
  observedSharpe: deannualizeSharpe(1.2, 15), // 1.2 annualised on 15 m bars
  numTrials: 20,               // number of strategy variants tested (K)
  numReturns: 720,             // number of bar returns (T)
  trialSharpeVariance: 1 / 719, // variance V of the 20 variants' per-bar SRs
  skewness: 0,                 // bar-return skewness
  excessKurtosis: 0,           // bar-return excess kurtosis
});
// dsr > 0.95 ⟹ the Sharpe is unlikely to be pure luck
```

Every Sharpe quantity here is **per-observation**: the benchmark SR₀ and the
standard error σ_SR are both computed over `numReturns` bar returns, so feeding
an annualised Sharpe straight in would mix scales and saturate the test at 0
or 1. `deannualizeSharpe(sr, intervalMinutes)` divides by `√barsPerYear` using
the same 365-day crypto year as the summary statistics.

`trialSharpeVariance` is the variance V of the tested variants' per-bar Sharpe
estimates; `√V` scales SR₀, so it sets how much edge the best variant must
show before it beats chance. For a family of variants with no real edge,
V ≈ 1/(T − 1).

---

## Fetch OHLCV history

```bash
bun run fetch-ohlcv
```

Downloads BTC/USD 15-minute bars from Kraken's public OHLC endpoint and stores
them in `data/ohlcv.sqlite` (gitignored).

**Options:**

| Flag | Default | Description |
|------|---------|-------------|
| `--pair` | `XBTUSD` | Kraken pair name |
| `--interval` | `15` | Bar width in minutes (1, 5, 15, 30, 60, 240, 1440, 10080, 21600) |
| `--db` | `data/ohlcv.sqlite` | SQLite file path |

```bash
# Examples
bun run fetch-ohlcv --pair ETHUSD --interval 60
bun run fetch-ohlcv --db data/eth_1h.sqlite --pair ETHUSD --interval 60
```

Unknown flags, flags given without a value, and intervals Kraken does not
serve are rejected with a usage error — a typo never falls back to the
defaults and fetches the wrong series.

**Re-runs are idempotent.** Each run stores the most recent window Kraken will
serve; existing rows are updated in-place with `INSERT OR REPLACE`, and the
latest stored bar is re-fetched so a bar that was still forming gets its final
values.

### Kraken OHLC 720-bar limit

Kraken's public `/0/public/OHLC` endpoint returns **at most 720 of the most
recent bars**, and older data cannot be retrieved regardless of the `since`
parameter. That fixes the reachable history at 720 x interval:

| Interval | History reachable in one run |
|----------|------------------------------|
| 15 m | ~7.5 days |
| 1 h | ~30 days |
| 4 h | ~120 days |
| 1 d | ~720 days |

So at the default 15-minute bars this repository can only accumulate about
**7.5 days** of history per run — and if `fetch-ohlcv` is not run for longer
than that window, the intervening bars are gone for good. When that happens the
script prints a warning naming how many bars are missing instead of silently
storing a discontinuous series; it does not attempt a backfill.

Running the fetch on a schedule (PR 6) is what grows the series beyond one
window. For history deeper than the scheduler has been running, Kraken
publishes downloadable OHLCVT CSV files at
<https://support.kraken.com/hc/en-us/articles/360047124832>. A CSV importer and
gap backfill are later work, not part of PR 1.

---

## Run tests

```bash
bun test                  # offline unit tests (mocked Kraken responses)
KRAKEN_LIVE=1 bun test    # also runs live smoke tests against api.kraken.com
```

---

## Type-check

```bash
bun run type-check        # tsc --noEmit
```

---

## Project layout

```
src/
  types/index.ts          # Domain types: OhlcvBar, Order, Fill, Position
  kraken/
    types.ts              # Typed Kraken API response shapes
    client.ts             # Public REST client (Time, AssetPairs, OHLC)
  storage/db.ts           # bun:sqlite helpers (open, upsert, query, load)
  indicators/
    ema.ts                # Exponential Moving Average
    rsi.ts                # Relative Strength Index (Wilder's smoothing)
    atr.ts                # Average True Range (Wilder's smoothing)
    bollinger.ts          # Bollinger Bands
    vwap.ts               # Rolling VWAP + VWAP deviation
    index.ts              # Re-exports all indicators
  backtest/
    types.ts              # Strategy, OrderIntent, BacktestConfig, SummaryStats, etc.
    engine.ts             # Event-driven backtest engine
    stats.ts              # Summary statistics computation
    walkforward.ts        # Walk-forward runner + Deflated Sharpe Ratio
    csv.ts                # Trade log CSV export
  strategies/
    buyAndHold.ts         # Reference buy-and-hold strategy (tests / CLI only)
  math/
    normal.ts             # Standard normal CDF + quantile (used by DSR)
scripts/
  fetch-ohlcv.ts          # CLI: most recent Kraken OHLC window → SQLite
  backtest.ts             # CLI: load bars, warn on series gaps, run reference strategy, print stats
tests/
  kraken/client.test.ts   # Unit tests with mocked responses
  fetch-ohlcv.test.ts     # Unit tests for CLI flag validation + series gap detection
  backtest.test.ts        # Unit tests for the backtest CLI's series-continuity scan
  indicators/
    ema.test.ts           # EMA: hand-computed seed + smoothing
    rsi.test.ts           # RSI: hand-computed Wilder smoothing steps
    atr.test.ts           # ATR: hand-computed TR + Wilder smoothing
    bollinger.test.ts     # Bollinger: hand-computed mean + population σ
    vwap.test.ts          # VWAP: hand-computed typical price weighting
  backtest/
    engine.test.ts        # Fill rules, fees, slippage, order rejection, buy-and-hold end to end
    stats.test.ts         # totalReturn, maxDD, Sharpe, Sortino, win rate
    walkforward.test.ts   # Window slicing, aggregate stats, DSR reference case
    csv.test.ts           # RFC 4180 quoting of the trade log
data/                     # gitignored — SQLite files land here
```

---

## Notes for later PRs

Items observed during PR 1 that belong in future work:

- **PR 2 / backtesting:** The `KrakenOhlcBar` tuple keeps prices as strings
  (Kraken sends them that way); the backtesting engine should own the
  `Number()` conversion and precision handling.
- **PR 4+ / websocket:** Kraken's authenticated WebSocket v2 feeds real-time
  order book and own-trade events. The public client here is REST-only.
- **PR 5 / authenticated client:** `KRAKEN_API_KEY` and `KRAKEN_API_SECRET`
  in `.env` are not read yet. Private endpoints (order placement, balance
  queries) live entirely in PR 5+.
- **PR 6 / Mac mini service:** A `launchd` plist for `bun run fetch-ohlcv`
  on a schedule, log rotation, and the alerting webhook are deployment
  concerns for the final PR.
- **Deeper history:** A single `fetch-ohlcv` run can only reach the most recent
  720 bars (~7.5 days at 15 m). Before parameter optimisation, decide whether
  the backtesting harness needs more depth than a scheduled fetch has
  accumulated; if it does, build the Kraken OHLCVT CSV importer (and a backfill
  for the gaps `fetch-ohlcv` reports) to avoid overfitting to a short window.
