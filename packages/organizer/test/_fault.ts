/*
 * THE WORKER TESTS' FAULT INJECTOR, WITH NO DATABASE IN ITS IMPORTS. `scripts/box-files.mjs`
 * follows imports and `_workerdb.ts` reaches the shared Postgres, so a PGlite or in-memory file
 * that took the injector from there was put on the box it never used.
 */

/**
 * ONE REPO METHOD MADE TO FAIL, WHEREVER THE CYCLE CALLS IT — including inside a transaction.
 * Every writer goes through `fencedLiveGroup`, so the write lands on the repo `transaction` hands
 * its callback; an outer-only proxy never saw it and three fault cases passed for the wrong
 * reason. This proxies the callback repo too, so the write fails where production makes it.
 */
export function repoWithFailingMethod<R extends object>(
  repo: R, method: string, fail: () => never | Promise<never>,
  /**
   * `times`: fail only that many calls, then call through. `sync`: throw at the call rather than
   * reject — a drizzle builder (`tx.insert(…)`) is chained before it is awaited, so a rejected
   * promise there becomes an unrelated TypeError and an unhandled rejection.
   */
  opts: { times?: number; sync?: boolean } = {},
): R {
  let left = opts.times ?? Infinity;
  const wrap = (target: R): R => new Proxy(target, {
    get(t, prop, recv) {
      if (prop === method && left > 0) {
        return opts.sync
          ? (): never => { left--; return fail() as never; }
          : async (): Promise<never> => { left--; return fail(); };
      }
      const v = Reflect.get(t, prop, recv) as unknown;
      if (typeof v !== "function") return v;
      if (prop === "transaction") {
        return (fn: (r: R) => Promise<unknown>): unknown =>
          (v as (f: (r: R) => Promise<unknown>) => unknown).call(t, (inner) => fn(wrap(inner)));
      }
      return (v as (...a: unknown[]) => unknown).bind(t);
    },
  }) as R;
  return wrap(repo);
}
