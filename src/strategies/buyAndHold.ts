import type { OhlcvBar } from "../types/index.ts";
import type { Strategy, OrderIntent, EngineState } from "../backtest/types.ts";
import { buyCost } from "../backtest/engine.ts";

/**
 * Fraction of `availableCash` the entry deploys.  Fees and slippage are priced
 * in exactly via `buyCost`, so this is pure headroom against floating-point
 * rounding, not a fee allowance.
 */
const CASH_FRACTION = 0.99;

/** Buffer applied to the limit price so the order fills on the next bar. */
const PRICE_BUFFER = 0.01;

/**
 * Trivial buy-and-hold reference strategy.
 *
 * Purpose: exercise the backtest engine end-to-end in tests and the CLI.
 * This is NOT a real trading strategy — do not use with live capital.
 *
 * Behaviour:
 *   Bar 0         → place a limit buy at bar.high × (1 + PRICE_BUFFER).
 *                   Using bar.high with a buffer makes a fill on bar 1 very
 *                   likely even if the market gaps up slightly.
 *   After filled  → hold until bar (totalBars − 2).
 *   Bar totalBars − 2 → place a limit sell at bar.low × (1 − PRICE_BUFFER)
 *                   to ensure a fill on the final bar.
 *
 * @param totalBars Total number of bars the strategy will receive.
 */
export function createBuyAndHoldStrategy(totalBars: number): Strategy {
  let buyPlaced = false;
  let hasFilled = false;
  let sellPlaced = false;

  return {
    onBar(bar: OhlcvBar, state: Readonly<EngineState>): OrderIntent[] {
      // Detect position fill on any bar.
      if (!hasFilled && state.position > 0) hasFilled = true;

      // Bar 0: place the entry buy.
      if (!buyPlaced && state.barIndex === 0 && state.availableCash > 0) {
        buyPlaced = true;
        const limitPrice = bar.high * (1 + PRICE_BUFFER);
        // Size against the engine's own all-in cost rule so the order's
        // reserved cost never exceeds the cash available to spend.
        const unitCost = buyCost(limitPrice, 1, state.fee);
        if (!(unitCost > 0)) return [];
        return [
          {
            side: "buy",
            price: limitPrice,
            volume: (state.availableCash * CASH_FRACTION) / unitCost,
            tag: "bah-entry",
          },
        ];
      }

      // On bar totalBars − 2: queue the exit sell so it can fill on the last bar.
      if (
        hasFilled &&
        !sellPlaced &&
        state.barIndex === totalBars - 2 &&
        state.availablePosition > 0
      ) {
        sellPlaced = true;
        const limitPrice = bar.low * (1 - PRICE_BUFFER);
        return [
          {
            side: "sell",
            price: limitPrice,
            volume: state.availablePosition,
            tag: "bah-exit",
          },
        ];
      }

      return [];
    },
  };
}
