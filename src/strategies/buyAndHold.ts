import type { OhlcvBar } from "../types/index.ts";
import type { Strategy, OrderIntent, EngineState } from "../backtest/types.ts";

/**
 * Trivial buy-and-hold reference strategy.
 *
 * Purpose: exercise the backtest engine end-to-end in tests and the CLI.
 * This is NOT a real trading strategy — do not use with live capital.
 *
 * Behaviour:
 *   Bar 0         → place a limit buy at bar.high × (1 + priceBuffer).
 *                   Using bar.high with a buffer makes a fill on bar 1 very
 *                   likely even if the market gaps up slightly.
 *   After filled  → hold until bar (totalBars − 2).
 *   Bar totalBars − 2 → place a limit sell at bar.low × (1 − priceBuffer)
 *                   to ensure a fill on the final bar.
 *
 * @param totalBars    Total number of bars the strategy will receive.
 * @param cashFraction Fraction of available cash to deploy (default 0.99 to
 *                     leave headroom for the maker fee).
 * @param priceBuffer  Buffer applied to the limit price (default 0.01 = 1 %).
 */
export function createBuyAndHoldStrategy(
  totalBars: number,
  cashFraction = 0.99,
  priceBuffer = 0.01,
): Strategy {
  let buyPlaced = false;
  let hasFilled = false;
  let sellPlaced = false;

  return {
    onBar(bar: OhlcvBar, state: Readonly<EngineState>): OrderIntent[] {
      // Detect position fill on any bar.
      if (!hasFilled && state.position > 0) hasFilled = true;

      // Bar 0: place the entry buy.
      if (!buyPlaced && state.barIndex === 0 && state.cash > 0) {
        buyPlaced = true;
        const limitPrice = bar.high * (1 + priceBuffer);
        // Allow for maker fee in the volume estimate so the order passes
        // the cash-check without going over the available balance.
        const maxVolume =
          (state.cash * cashFraction) / (limitPrice * 1.0016);
        if (maxVolume > 0) {
          return [
            { side: "buy", price: limitPrice, volume: maxVolume, tag: "bah-entry" },
          ];
        }
        return [];
      }

      // On bar totalBars − 2: queue the exit sell so it can fill on the last bar.
      if (
        hasFilled &&
        !sellPlaced &&
        state.barIndex === totalBars - 2 &&
        state.position > 0
      ) {
        sellPlaced = true;
        const limitPrice = bar.low * (1 - priceBuffer);
        return [
          {
            side: "sell",
            price: limitPrice,
            volume: state.position,
            tag: "bah-exit",
          },
        ];
      }

      return [];
    },
  };
}
