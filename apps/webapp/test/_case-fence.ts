/**
 * ONE CASE'S REACT WORK ENDS WITH ITS CASE.
 *
 * vitest 2 races a case against its budget and moves on when the budget wins; the body keeps
 * running beside the next case. Its next act() then overlaps that case's, and React 19's act
 * restores its scope depth from each scope's saved value, so interleaved exits leave the depth
 * above zero: from then on no act() in the file flushes anything and every later render is empty.
 *
 * So `act` here refuses while a case is being ended, `endCase()` (first in afterEach) waits for
 * the scopes still open, and a body that meets the closed door ends with CaseEnded. A case body
 * awaits nothing but these doors (act, and mounts wrapped in `tracked`).
 */
import * as React from "react";
import { setImmediate as realSetImmediate } from "node:timers";

type Act = (cb: () => Promise<void> | void) => Promise<void>;
const reactAct = (React as unknown as { act: Act }).act;

export class CaseEnded extends Error {
  constructor() {
    super("this case already ended (its budget ran out); its body may not open another act() scope");
    this.name = "CaseEnded";
  }
}

let closed = false;
const inFlight = new Set<Promise<unknown>>();

/** Throws CaseEnded while the case that ran is being ended. */
export function caseLive(): void {
  if (closed) throw new CaseEnded();
}

/** Counted until it settles, so `endCase` waits for it. */
export function tracked<T>(p: Promise<T>): Promise<T> {
  inFlight.add(p);
  const off = (): void => { inFlight.delete(p); };
  p.then(off, off);
  return p;
}

/** React's act behind the door. */
export const act: Act = (cb) => {
  caseLive();
  return tracked(new Promise<void>((resolve, reject) => { reactAct(cb).then(resolve, reject); }));
};

/** First in afterEach: refuse the ended body, wait for its open scopes, then admit the teardown. */
export async function endCase(): Promise<void> {
  closed = true;
  try {
    while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
    // A real macrotask (fake timers may be installed): an await that settles in microtasks resumes
    // here, meets the closed door, and ends.
    await new Promise<void>((r) => { realSetImmediate(r); });
  } finally {
    closed = false;
  }
}
