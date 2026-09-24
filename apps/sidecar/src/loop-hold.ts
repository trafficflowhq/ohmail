/**
 * A LONG TRANSACTION HANDS THE EVENT LOOP BACK EVERY {@link LOOP_HOLD_MS}.
 *
 * PGlite answers from WASM in-process, so a mirror page applied statement after statement is one
 * unbroken chain of microtasks: 1.9 s in which no timer, socket or request of this process ran.
 * The yield sits INSIDE the transaction callback, so the page stays one transaction: the store's
 * own mutex is held across the turn, and every other statement waits for the commit as before.
 */
export const LOOP_HOLD_MS = 20;

/** One turn of the event loop. */
export function loopTurn(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

/**
 * A checkpoint to await before each unit of work: yields once `budgetMs` is spent. The FIRST call
 * always yields, so the work that ran before the transaction (the page's parse) is its own stretch;
 * a caller ends with {@link loopTurn} so the commit is its own stretch too.
 */
export function loopHold(budgetMs: number = LOOP_HOLD_MS, clock: () => number = () => performance.now()): () => Promise<void> {
  let since = -Infinity;
  return async (): Promise<void> => {
    if (clock() - since < budgetMs) return;
    await loopTurn();
    since = clock();
  };
}
