/**
 * THE STORE-ONLY PASSES RUN WHILE NOBODY IS USING THE APP — the desktop's and the phone's schedule
 * for the store-only `search_index_backfill` and `html_words_backfill` passes. One round per tick,
 * and a tick runs a round only when no person has asked for anything for {@link PERSON_QUIET_MS},
 * no drain is taking mail in, and the host is on power. The account's marker ends the rounds;
 * `maintain` (the planner statistics) runs after each round and, once the marker is written, at
 * most every {@link SEARCH_MAINTAIN_EVERY_MS} on an idle tick. A failed round is logged and tried
 * again; rows without a document are read the older way.
 */
import { PERSON_QUIET_MS } from "./attention.js";
import { cadenceDue, stampNow, type CadenceClocks, type CadenceStamp } from "./pass-cadence.js";
import type { PowerVerdict } from "./host-power.js";

/** Between rounds while idle: a breather for the other lane, not a pacing of the work. */
const SEARCH_BACKFILL_TICK_MS = 2_000;
/** Between looks while somebody is busy, draining or on battery. */
const SEARCH_BACKFILL_WAIT_MS = 15_000;
/** How often the finished schedule still refreshes the search table's statistics, when idle. */
const SEARCH_MAINTAIN_EVERY_MS = 10 * 60_000;

export interface BackfillRound {
  /** False when the account's marker was already written — nothing was read. */
  readonly ran: boolean;
  readonly written: number;
  /** The completion marker was written by this round. */
  readonly marked: boolean;
}

type TickOutcome = "ran" | "person" | "draining" | "battery" | "busy" | "done" | "failed";

interface SearchBackfillDeps {
  /** ONE round of the pass over this install's account. */
  round: () => Promise<BackfillRound>;
  quietForMs: () => number;
  /** Is a drain taking mail in right now — `ingestIsRunning` in `store-lanes.ts`. */
  ingesting: () => boolean;
  /** Is the host on power — the desktop entry's `createHostPower`. Absent ⇒ {@link NO_POWER_READING}. */
  power?: () => PowerVerdict;
  log: (event: string, fields: Record<string, unknown>) => void;
  /** The store's upkeep after the table grew — `OpenLocalDb.analyzeSearchIfStale`. Never throws. */
  maintain?: () => Promise<unknown>;
  maintainEveryMs?: number;
  /** The monotonic clock; `wall` beside it, so the upkeep cadence survives a suspend (`pass-cadence.ts`). */
  now?: () => number;
  wall?: () => number;
  quietMs?: number;
  tickMs?: number;
  waitMs?: number;
}

/**
 * NO READER, NO INFORMATION — the verdict a host that cannot say gets from `host-power.ts`, and
 * the one a composition without a reader runs on: power never refuses a round. The reader is
 * injected rather than imported so the phone's engine carries no filesystem reader it never runs.
 */
const NO_POWER_READING: PowerVerdict = { onPower: true, state: "unknown" };

/** The pass's own two lines, written at each caller so every event name stays a literal. */
interface IdleStorePassLines {
  finished: (totals: { written: number; rounds: number; totalMs: number }) => void;
  failed: (err: unknown) => void;
}

export interface SearchBackfill {
  /** Look once and run a round if the gate admits one. The timer calls this; so may a test. */
  tick(): Promise<TickOutcome>;
  /** No further round; resolves once a round in flight has finished. */
  stop(): Promise<void>;
  done(): boolean;
}

export function startSearchIndexBackfill(deps: SearchBackfillDeps): SearchBackfill {
  return startIdleStorePass(deps, {
    finished: (t) => deps.log("search_index_backfill_finished", {
      written: t.written, rounds: t.rounds, totalMs: t.totalMs,
      reason: "every message on this install now has its search document; search reads the index alone",
    }),
    failed: (err) => deps.log("search_index_backfill_failed", {
      err,
      reason: "one round of the search index backfill failed and wrote nothing; a later idle tick tries again",
    }),
  });
}

/** Older html-only letters get their words (`html_words_backfill`), on the same idle gate. */
export function startHtmlWordsBackfill(deps: SearchBackfillDeps): SearchBackfill {
  return startIdleStorePass(deps, {
    finished: (t) => deps.log("html_words_backfill_finished", {
      written: t.written, rounds: t.rounds, totalMs: t.totalMs,
      reason: "every stored html-only letter on this install now has its words as its text",
    }),
    failed: (err) => deps.log("html_words_backfill_failed", {
      err,
      reason: "one round of the html-words backfill failed; its cursor holds, and a later idle tick resumes there",
    }),
  });
}

function startIdleStorePass(deps: SearchBackfillDeps, lines: IdleStorePassLines): SearchBackfill {
  // Monotonic: every reading below is a "how long since", which a wall clock stepped back stretches.
  const now = deps.now ?? ((): number => performance.now());
  const clocks: CadenceClocks = { wall: deps.wall ?? ((): number => Date.now()), mono: now };
  const quietMs = deps.quietMs ?? PERSON_QUIET_MS;
  const power = deps.power ?? (() => NO_POWER_READING);
  let finished = false;
  let stopped = false;
  let inFlight: Promise<unknown> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let written = 0;
  let rounds = 0;
  let startedAt: number | null = null;
  let maintainedAt: CadenceStamp | null = null;
  const maintain = async (): Promise<void> => {
    if (!deps.maintain) return;
    maintainedAt = stampNow(clocks);
    await deps.maintain().catch(() => undefined);
  };

  const tick = async (): Promise<TickOutcome> => {
    if (stopped) return "done";
    if (inFlight) return "busy";
    if (deps.quietForMs() < quietMs) return "person";
    if (deps.ingesting()) return "draining";
    if (!power().onPower) return "battery";
    if (finished) {
      if (cadenceDue(maintainedAt, deps.maintainEveryMs ?? SEARCH_MAINTAIN_EVERY_MS, clocks)) {
        const upkeep = maintain();
        inFlight = upkeep;
        try { await upkeep; } finally { inFlight = null; }
      }
      return "done";
    }
    const round = (async () => { const r = await deps.round(); await maintain(); return r; })();
    inFlight = round;
    try {
      const r = await round;
      if (!r.ran) { finished = true; return "done"; }
      startedAt ??= now();
      rounds += 1;
      written += r.written;
      if (r.marked) {
        finished = true;
        lines.finished({ written, rounds, totalMs: Math.round(now() - startedAt) });
      }
      return "ran";
    } catch (err) {
      lines.failed(err);
      return "failed";
    } finally {
      inFlight = null;
    }
  };

  const arm = (ms: number): void => {
    if (stopped || (finished && !deps.maintain)) return;
    timer = setTimeout(() => {
      timer = null;
      void tick().then((o) => arm(o === "ran" ? deps.tickMs ?? SEARCH_BACKFILL_TICK_MS : deps.waitMs ?? SEARCH_BACKFILL_WAIT_MS));
    }, ms);
    timer.unref?.();
  };
  arm(deps.waitMs ?? SEARCH_BACKFILL_WAIT_MS);

  return {
    tick,
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      await inFlight?.catch(() => undefined);
    },
    done: () => finished,
  };
}
