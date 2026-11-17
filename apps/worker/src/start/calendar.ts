/**
 * THE CALENDAR'S PASSES ON THE WORKER'S OWN CLOCK. A bell of their own (the doorbell's shape: the
 * change log's ring and a floor timer), off the serialized queue that carries the mail's cycle, so
 * that no woken mailbox waits on a calendar call and no calendar call waits on a mailbox. A ring
 * only reads the roster and queues what is due; one lane runs the turns, each of which holds a
 * database connection for one short store transaction at a time and never across a provider's call.
 *
 * Composed here and nowhere else: the providers (with the deployment's address policy, the lookup
 * of names and the one zone source), the registrations, and the notices. With the calendar off
 * (`config.calendar` null) nothing is made and no timer runs.
 */
import { randomInt } from "node:crypto";
import { intlZones } from "@ohmail/cal-core";
import { MS_GRAPH_BASE, makeCalendarProviders, type ProviderWord } from "@ohmail/cal-providers";
import type { Logger } from "@trafficflow/core";
import { nodeHostResolver } from "@trafficflow/core/net";
import type { Tx } from "@trafficflow/db";
import { calendarSyncPass, calendarTurnFailed } from "@ohmail/organizer/calendar-sync-pass";
import {
  calendarPool, loadDueConnections, newCalendarSyncMemory, parkConnection, CALENDAR_LANES, CALENDAR_RING_GAP_MS,
  CALENDAR_RING_SETTLE_MS, CALENDAR_TICK_MS, CalendarTurnOverdue, OFF_RECHECK_MS, RETRY_CEILING_MS, ROSTER_EXCEPT_MAX, ROSTER_LIMIT,
  TURN_HARD_MS, TURN_MS, doublingWait,
  type CalendarSyncDeps, type CalendarSyncOutcome, type DueConnection,
} from "@ohmail/organizer/calendar-sync";
import { calendarNoticesPass } from "../calendar-notices.js";
import { calendarWriteDrain } from "@ohmail/organizer/calendar/write-drain";
import type { WorkerCalendarConfig } from "../config.js";
import { accountShardFilter } from "../mailboxes.js";
import { startSyncKickBell, type SyncKickBell } from "../sync-kick.js";
import type { WorkerScope } from "./scope.js";

/** What the runner is handed: everything it does to the world goes through these. */
export interface CalendarRunnerDeps {
  /** The connections due now, in the roster's order, without those named in `except`. */
  readonly roster: (now: Date, except: readonly string[]) => Promise<DueConnection[]>;
  /** One connection's turn. Its signal ends with the worker's stop, or with `CalendarTurnOverdue` at the turn's bound. */
  readonly turn: (c: DueConnection, signal: AbortSignal) => Promise<CalendarSyncOutcome>;
  /** A turn threw: its word and its wait said on the row. Answers when the row is asked again, `null` where nothing was written. */
  readonly failed?: (c: DueConnection, err: unknown) => Promise<number | null>;
  /** The accounts among these that are parked, where a reader is composed. */
  readonly parked?: (accountIds: readonly string[], now: Date) => Promise<ReadonlySet<string>>;
  /** A parked account's connection: looked at again later, never dialled now. */
  readonly park?: (c: DueConnection, until: Date) => Promise<void>;
  readonly lanes: number;
  readonly floorMs: number;
  readonly gapMs: number;
  /**
   * A read a ring starts waits this long before it reads the roster (`CALENDAR_RING_SETTLE_MS` as the
   * worker composes it): a press rings at its act's commit, and its wake commits just after. Not said: at once.
   */
  readonly settleMs?: number;
  /** No turn outlasts this (`TURN_HARD_MS` where it is not said). */
  readonly turnHardMs?: number;
  /** A turn with more to read that took longer than this waits as long before it queues again (`TURN_MS`). */
  readonly turnMs?: number;
  readonly source?: { subscribeAll(onWake: (accountId: string, seq: bigint) => void): () => void };
  readonly isStopped: () => boolean;
  readonly now: () => number;
  readonly log: Logger;
}

export interface CalendarRunner {
  /** Read the roster soon: the floor's tick, or a ring. */
  ring(): void;
  /** Stop ringing and end every turn at its next step; nothing new starts. */
  stop(): void;
  /** Resolves once no turn is in flight. */
  settled(): Promise<void>;
  /** Turns running and connections waiting, from memory. */
  load(): { readonly running: number; readonly queued: number };
}

/**
 * The bell, the queue and the lanes. A connection is in the queue once at most; a turn that ended
 * with more to read joins the back of it at once, behind the others, and every other turn leaves
 * it to the row's `next_poll_at`.
 *
 * No turn holds a lane for ever: each has a bound of its own, at which its signal ends and the
 * next connection is read. A turn with more to read that ran long waits as long before it queues
 * again, so one slow host takes the lane at most every other time.
 *
 * A turn that threw, or found its connection gone, waits in memory, doubling; a thrown one is also
 * said on its row where the store takes it. The roster is told which connections wait here, so
 * rows that cannot run never fill its cut and hide the ones that can.
 */
export function startCalendarRunner(deps: CalendarRunnerDeps): CalendarRunner {
  const queue: DueConnection[] = [];
  const held = new Set<string>();
  const cooling = new Map<string, { until: number; failures: number }>();
  const inflight = new Set<Promise<void>>();
  const ended = new AbortController();
  const hardMs = deps.turnHardMs ?? TURN_HARD_MS;
  const turnMs = deps.turnMs ?? TURN_MS;
  let running = 0;
  let stopped = false;
  const off = (): boolean => stopped || deps.isStopped();

  const pump = (): void => {
    while (!off() && running < deps.lanes && queue.length > 0) {
      const c = queue.shift()!;
      running += 1;
      const p: Promise<void> = turnOf(c).finally(() => {
        running -= 1;
        inflight.delete(p);
        pump();
      });
      inflight.add(p);
    }
  };

  const turnOf = async (c: DueConnection): Promise<void> => {
    let again = false;
    const began = deps.now();
    // The turn's own bound: its signal ends with the worker's stop, or when its time has run out.
    const overdue = new AbortController();
    const timer = setTimeout(() => overdue.abort(new CalendarTurnOverdue()), hardMs);
    try {
      const outcome = await deps.turn(c, AbortSignal.any([ended.signal, overdue.signal]));
      // A connection the roster listed and its own binding did not find writes nothing; it is not asked every tick.
      if (outcome.kind === "gone") {
        const failures = (cooling.get(c.id)?.failures ?? 0) + 1;
        cooling.set(c.id, { until: deps.now() + doublingWait(failures), failures });
      } else {
        cooling.delete(c.id);
      }
      again = outcome.kind === "synced" && outcome.more && !off();
      const used = deps.now() - began;
      if (again && used > turnMs) {
        cooling.set(c.id, { until: deps.now() + used, failures: 0 });
        again = false;
      }
      if (outcome.kind !== "synced" || outcome.changed > 0 || outcome.dropped > 0) {
        deps.log.info("calendar_turn", { accountId: c.accountId, kind: c.provider, ...outcomeFields(outcome) });
      }
    } catch (err) {
      const failures = (cooling.get(c.id)?.failures ?? 0) + 1;
      let until = deps.now() + doublingWait(failures);
      deps.log.warn("calendar_turn_failed", { accountId: c.accountId, kind: c.provider, err });
      try {
        until = Math.max(until, await deps.failed?.(c, err) ?? 0);
      } catch (unsaid) {
        // The store would not take the word either: the wait stays here, and the roster is told to pass the row over.
        deps.log.warn("calendar_turn_unsaid", { accountId: c.accountId, kind: c.provider, err: unsaid });
      }
      cooling.set(c.id, { until, failures });
    } finally {
      clearTimeout(timer);
    }
    if (again) queue.push(c);
    else held.delete(c.id);
  };

  /**
   * The connections that will not run now whatever their rows say: those waiting here first (they
   * are the ones that would hide others), then those queued or running.
   */
  const notNow = (at: number): string[] => {
    const ids = new Set<string>();
    for (const [id, c] of cooling) {
      // A wait long over is forgotten, so this memory holds only connections that failed lately.
      if (c.until + RETRY_CEILING_MS < at) cooling.delete(id);
      else if (c.until > at) ids.add(id);
    }
    for (const id of held) ids.add(id);
    return [...ids].slice(0, ROSTER_EXCEPT_MAX);
  };

  const scan = async (by: "signal" | "floor"): Promise<void> => {
    if (off()) return;
    if (by === "signal" && (deps.settleMs ?? 0) > 0) {
      await new Promise((r) => setTimeout(r, deps.settleMs));
      if (off()) return;
    }
    const at = deps.now();
    const due = (await deps.roster(new Date(at), notNow(at)))
      .filter((c) => !held.has(c.id) && (cooling.get(c.id)?.until ?? 0) <= at);
    if (due.length === 0) return;
    const parked = deps.parked === undefined ? new Set<string>()
      : await deps.parked([...new Set(due.map((c) => c.accountId))], new Date(at));
    for (const c of due) {
      if (off()) return;
      if (held.has(c.id)) continue;
      if (parked.has(c.accountId)) {
        await deps.park?.(c, new Date(at + OFF_RECHECK_MS));
        continue;
      }
      held.add(c.id);
      queue.push(c);
    }
    pump();
  };

  const bell: SyncKickBell = startSyncKickBell({
    pass: scan, floorMs: deps.floorMs, gapMs: deps.gapMs, ...(deps.source ? { source: deps.source } : {}),
    isStopped: off, log: deps.log, label: "calendar_scan",
  });

  return {
    ring: () => bell.ring(""),
    stop(): void {
      if (stopped) return;
      stopped = true;
      bell.stop();
      queue.length = 0;
      ended.abort();
    },
    async settled(): Promise<void> {
      while (inflight.size > 0) await Promise.allSettled([...inflight]);
    },
    load: () => ({ running, queued: queue.length }),
  };
}

/** An outcome as log fields: closed words and counts, nothing a provider wrote. */
function outcomeFields(o: CalendarSyncOutcome): Record<string, string | number | boolean> {
  switch (o.kind) {
    case "synced": return { outcome: o.kind, count: o.calendars, pages: o.pages, changed: o.changed, dropped: o.dropped, more: o.more };
    case "stopped": return { outcome: o.kind, reason: o.word };
    case "backed_off": return { outcome: o.kind, reason: o.word, retryAt: new Date(o.untilMs).toISOString() };
    case "off": return { outcome: o.kind, reason: o.why };
    default: return { outcome: o.kind };
  }
}

/** The providers this deployment serves: a subscription and CalDAV whenever the calendar is on. */
export function servedProviders(cfg: WorkerCalendarConfig): ReadonlySet<ProviderWord> {
  const words = new Set<ProviderWord>(["ics", "caldav"]);
  if (cfg.google !== null) words.add("google");
  if (cfg.microsoft !== null) words.add("microsoft");
  return words;
}

/**
 * The calendar's section of the worker. Called once the change log's ring exists; sets
 * `scope.calendar`, which `clearTimers` stops and the worker's stop awaits.
 */
export function calendarSection(scope: WorkerScope): void {
  scope.calendar = null;
  const cfg = scope.config.calendar ?? null;
  if (cfg === null) return;
  const clock = { now: () => Date.now() };
  const zones = intlZones();
  const enabled = servedProviders(cfg);
  // Made once, and a fault of the composition refuses the start here rather than at the first turn.
  const providers = makeCalendarProviders({
    clock, zones, resolver: nodeHostResolver, policy: { kind: cfg.policy }, enabled,
    microsoft: cfg.microsoft === null ? null : { graphBase: cfg.microsoft.graphBase ?? MS_GRAPH_BASE },
    // The worker is where a person's writes reach their provider; nothing else composes a writer.
    writes: true,
  });
  const pool = calendarPool(scope.db as unknown as Tx);
  const noticeDeps = { origin: cfg.noticeOrigin, log: scope.log, clock, refused: new Map<string, number>() };
  const syncDeps: CalendarSyncDeps = {
    db: pool,
    providers,
    keys: scope.keyProvider,
    clock,
    zones,
    random: () => randomInt(0, 1_000_000) / 1_000_000,
    oauth: { google: cfg.google, microsoft: cfg.microsoft === null ? null : scope.msRegistration },
    memory: newCalendarSyncMemory(),
    halted: () => scope.stopped,
    log: scope.log,
    // A person's writes reach their provider in the turn that reads it, before the reading.
    drainWrites: calendarWriteDrain({ clock, zones, log: scope.log }),
    ...(cfg.noticeOrigin === null ? {} : { notices: (input) => calendarNoticesPass(noticeDeps, input) }),
  };
  scope.calendar = startCalendarRunner({
    roster: (now, except) => loadDueConnections(pool, now, ROSTER_LIMIT, (column) => accountShardFilter(scope.selection, column), except),
    turn: (c, signal) => calendarSyncPass(syncDeps, c, signal),
    failed: (c, err) => calendarTurnFailed(syncDeps, c, err),
    ...(scope.parkedAccountsReader === null ? {} : {
      parked: (ids: readonly string[], now: Date) => scope.parkedAccountsReader!(ids, now),
      park: (c: DueConnection, until: Date) => parkConnection(pool, c, until),
    }),
    lanes: CALENDAR_LANES,
    floorMs: CALENDAR_TICK_MS,
    gapMs: CALENDAR_RING_GAP_MS,
    settleMs: CALENDAR_RING_SETTLE_MS,
    ...(scope.wakeHub ? { source: scope.wakeHub } : {}),
    isStopped: () => scope.stopped,
    now: () => Date.now(),
    log: scope.log,
  });
  scope.log.info("calendar_started", {
    mode: cfg.policy, kind: [...enabled].sort().join(","), state: cfg.noticeOrigin === null ? "polling" : "notices",
    phase: syncDeps.drainWrites === undefined ? "reads" : "writes",
  });
}
