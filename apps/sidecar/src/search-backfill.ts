/**
 * THE SEARCH INDEX FILLS ITSELF IN WHILE NOBODY IS USING THE APP — the desktop's schedule for the
 * store-only `search_index_backfill` pass. One round per tick, and a tick runs a round only when no
 * person has asked for anything for {@link PERSON_QUIET_MS}, no drain is taking mail in, and the host
 * is on power. The account's marker ends the rounds; `maintain` (the planner statistics) runs after
 * each round and, once the marker is written, at most every {@link SEARCH_MAINTAIN_EVERY_MS} on an
 * idle tick. A failed round is logged and tried again; rows without a document are read the older way.
 */
import { PERSON_QUIET_MS } from "./attention.js";
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
  power: () => PowerVerdict;
  log: (event: string, fields: Record<string, unknown>) => void;
  /** The store's upkeep after the table grew — `OpenLocalDb.analyzeSearchIfStale`. Never throws. */
  maintain?: () => Promise<unknown>;
  maintainEveryMs?: number;
  now?: () => number;
  quietMs?: number;
  tickMs?: number;
  waitMs?: number;
}

export interface SearchBackfill {
  /** Look once and run a round if the gate admits one. The timer calls this; so may a test. */
  tick(): Promise<TickOutcome>;
  /** No further round; resolves once a round in flight has finished. */
  stop(): Promise<void>;
  done(): boolean;
}

export function startSearchIndexBackfill(deps: SearchBackfillDeps): SearchBackfill {
  const now = deps.now ?? Date.now;
  const quietMs = deps.quietMs ?? PERSON_QUIET_MS;
  let finished = false;
  let stopped = false;
  let inFlight: Promise<unknown> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let written = 0;
  let rounds = 0;
  let startedAt: number | null = null;
  let maintainedAt: number | null = null;
  const maintain = async (): Promise<void> => {
    if (!deps.maintain) return;
    maintainedAt = now();
    await deps.maintain().catch(() => undefined);
  };

  const tick = async (): Promise<TickOutcome> => {
    if (stopped) return "done";
    if (inFlight) return "busy";
    if (deps.quietForMs() < quietMs) return "person";
    if (deps.ingesting()) return "draining";
    if (!deps.power().onPower) return "battery";
    if (finished) {
      if (maintainedAt === null || now() - maintainedAt >= (deps.maintainEveryMs ?? SEARCH_MAINTAIN_EVERY_MS)) {
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
        deps.log("search_index_backfill_finished", {
          written, rounds, totalMs: now() - startedAt,
          reason: "every message on this install now has its search document; search reads the index alone",
        });
      }
      return "ran";
    } catch (err) {
      deps.log("search_index_backfill_failed", {
        err,
        reason: "one round of the search index backfill failed and wrote nothing; a later idle tick tries again",
      });
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
