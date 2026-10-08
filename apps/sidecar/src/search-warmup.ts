/**
 * THE LAUNCH PAYS FOR THE FIRST SEARCH'S COLD START, NOT THE PERSON. A search plans against dozens
 * of relation files, and the first one after a launch opens and reads them cold. Once a drain has
 * come back settled, ONE search for a word nothing matches runs and its answer is dropped: never
 * while a drain takes mail in (it waits and looks again), never twice in one launch, a failure
 * logged and not retried. It holds the store's one connection, so a person who searched, read or
 * opened anything in the last {@link SEARCH_WARMUP_QUIET_MS} comes first: the launch skips it.
 */

/** A word no mailbox holds; its page and typo tier read the same indexes a real word does. */
export const SEARCH_WARMUP_WORD = "zqxjkvwpfh";
/** Between looks while a drain is taking mail in. */
const SEARCH_WARMUP_WAIT_MS = 2_000;
/** How long nobody may have asked the window for anything before the warm-up takes the store. */
export const SEARCH_WARMUP_QUIET_MS = 3_000;

export type SearchWarmupState = "waiting" | "armed" | "ran" | "failed" | "skipped" | "stopped";

export interface SearchWarmup {
  /** A drain came back with nothing left to take: the first call arms the one warm-up. */
  settled(): void;
  /** No warm-up after this; one in flight finishes and is not reported. */
  stop(): void;
  state(): SearchWarmupState;
}

export function createSearchWarmup(deps: {
  /** One page search for {@link SEARCH_WARMUP_WORD} on this install's own store. */
  search: () => Promise<unknown>;
  /** Is a drain taking mail in right now — `ingestIsRunning` in `store-lanes.ts`. */
  ingesting: () => boolean;
  /** Milliseconds since a person's last request — `attention.ts`'s clock. */
  quietForMs: () => number;
  log: (event: string, fields: Record<string, unknown>) => void;
  waitMs?: number;
}): SearchWarmup {
  let state: SearchWarmupState = "waiting";
  let timer: ReturnType<typeof setTimeout> | null = null;
  const look = (): void => {
    timer = null;
    if (state !== "armed") return;
    if (deps.quietForMs() < SEARCH_WARMUP_QUIET_MS) {
      state = "skipped";
      deps.log("search_warm_skipped", { reason: "somebody used the window first; the launch's warm-up search does not run" });
      return;
    }
    if (deps.ingesting()) {
      timer = setTimeout(look, deps.waitMs ?? SEARCH_WARMUP_WAIT_MS);
      timer.unref?.();
      return;
    }
    state = "ran";
    const t0 = performance.now();
    void deps.search().then(
      () => { if (state === "ran") deps.log("search_warmed", { totalMs: Math.round(performance.now() - t0) }); },
      (err: unknown) => {
        if (state !== "ran") return;
        state = "failed";
        deps.log("search_warm_failed", { err, reason: "the launch's one warm-up search failed; the first search pays its own cold start" });
      },
    );
  };
  return {
    settled() {
      if (state !== "waiting") return;
      state = "armed";
      look();
    },
    stop() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      state = "stopped";
    },
    state: () => state,
  };
}
