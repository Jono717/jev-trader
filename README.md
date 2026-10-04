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
| **1 — Foundation** (this PR) | Bun/TypeScript scaffold, Kraken public client, OHLCV fetch + SQLite storage, core types |
| **2 — Backtesting harness** | Vectorised engine, walk-forward splits, fee/slippage model, multiple-testing penalty |
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

**Re-runs are idempotent.** The script resumes from the most recently stored bar
timestamp; existing rows are updated in-place with `INSERT OR REPLACE`.

### Kraken OHLC 720-bar limit

Kraken's public `/0/public/OHLC` endpoint returns **at most 720 bars per
request**. At 15-minute bars that covers roughly **7.5 days** per page. The
fetch script pages forward (using the `last` cursor returned by each response)
to retrieve up to 180 days of history, but there is no way to reach data older
than that via this endpoint.

For deeper historical data, Kraken publishes downloadable OHLCVT CSV files at
<https://support.kraken.com/hc/en-us/articles/360047124832>. A CSV importer
(reading those files into the same `ohlcv_bars` table) is planned for a later
PR once it is confirmed whether the backtesting harness needs the extra depth.

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
  storage/db.ts           # bun:sqlite helpers (open, upsert, query)
scripts/
  fetch-ohlcv.ts          # CLI: page Kraken OHLC → SQLite
tests/
  kraken/client.test.ts   # Unit tests with mocked responses
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
- **Deeper history:** Evaluate whether the backtesting harness needs more than
  180 days; if so, build the Kraken CSV importer before parameter optimisation
  to avoid overfitting to a short window.
