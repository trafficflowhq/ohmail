import { AsyncLocalStorage } from "node:async_hooks";

/**
 * FAIR SHARE OF THE ONE CONNECTION.
 *
 * PGlite is one connection served first-come-first-served, so a window polling in a loop always has
 * a statement ready and the cycle's queues behind the fleet of them. Two lanes instead — the mail
 * coming in, weighted, and everything else — so eight pollers share ONE turn. And every admission
 * crosses the loop's CHECK PHASE: PGlite answers from WASM in-process, so a poll loop is an
 * unbroken chain of microtasks and the cycle's stream-based MIME parse never ran. 0.0 % of quiet
 * throughput before; 55 % with the cycle's own gaps held for ({@link INGEST_GAP_TURNS}).
 *//** Which side of the connection a statement belongs to. */
export type StoreLane = "ingest" | "interactive";

/**
 * The ingest's share of the connection when BOTH lanes have work, as a weight against the
 * interactive lane's 1. Above 1 because the two lanes are not symmetric: a window that waits gets
 * a later answer, and mail that waits does not arrive. Two, measured by the liveness case under
 * eight pollers with the cycle's own gaps held for ({@link INGEST_GAP_TURNS}): 55 % of its quiet
 * throughput at about the unheld build's read latency, where three reads 66 % and costs a waiting
 * read 1.6x.
 */
export const INGEST_LANE_WEIGHT = 2;

/** Both lanes, in one place, so a third could not be added to half of them. */
const LANES = ["ingest", "interactive"] as const;

/**
 * THE LIVENESS BOUND: at most this many statements run without a turn of the event loop.
 *
 * The turn is what a starved stream or timer needs — the cycle's MIME parse waited 14.9 s for one.
 * Eight is a page read's worth of statements, so nothing waits longer than one read; taking it on
 * EVERY admission instead was measured changing what an idle store does (a churn loop's checkpoint
 * timer began keeping up, and two suites' five-second cases stopped fitting), which is a wide
 * change to buy a bound that eight already gives.
 */
export const TURN_EVERY = 8;

/**
 * …and while BOTH lanes are in use, every admission takes the turn instead.
 *
 * The lane is chosen after the microtasks drain or the weighting disappears — a lane never more
 * than one statement deep, which the cycle is, has an empty queue for the microtask between its own
 * statements. "In use" is the other lane having been served within this many admissions, and not
 * its queue being non-empty right now, which is that same blind spot asked as a question.
 */
export const SHARED_WINDOW = 32;

const lanes = new AsyncLocalStorage<StoreLane>();
/**
 * The admission a statement is running under, so a statement issued from INSIDE one never queues
 * behind itself.
 *
 * A token and not a boolean, and the difference is a hang: an async context outlives the work that
 * created it, so a timer armed inside an admission inherits the flag and every statement that
 * timer ever issues would bypass the scheduler for the life of the process. The token is compared
 * against the admission actually running, so the bypass ends exactly when the admission does.
 */
const holding = new AsyncLocalStorage<symbol>();

/**
 * Drains in flight. The scheduler ENGAGES only while this is above zero.
 *
 * With no mail coming in there are not two lanes to arbitrate between, and a queue in front of the
 * connection then buys nothing and costs something: measured, it put four cloud-mirror cases over
 * their five-second default while the same files passed at HEAD. So an idle install's statements
 * run exactly as they did before — no admission, no hop, no census entry — and everything this
 * file does begins with a drain and ends with it.
 */
let drainsRunning = 0;

/** Run `fn`, and every statement it issues, in `lane`. */
export function inStoreLane<T>(lane: StoreLane, fn: () => Promise<T>): Promise<T> {
  if (lane !== "ingest") return lanes.run(lane, fn);
  drainsRunning++;
  return lanes.run(lane, fn).finally(() => {
    drainsRunning--;
  });
}

/** Whether mail is being taken in right now — the condition the scheduler engages on. */
export function ingestIsRunning(): boolean {
  return drainsRunning > 0;
}

/** The lane a statement issued right now belongs to. Unnamed work is interactive. */
export function currentStoreLane(): StoreLane {
  return lanes.getStore() ?? "interactive";
}

/** What the scheduler did, for the vitals line and for a measurement that needs the shape. */
export interface StoreLaneCensus {
  /** Statements admitted, per lane. */
  admitted: Record<StoreLane, number>;
  /** Store time spent, per lane, in milliseconds. */
  storeMs: Record<StoreLane, number>;
  /** Time spent WAITING for the connection, per lane, in milliseconds. */
  waitedMs: Record<StoreLane, number>;
}

export interface StoreScheduler {
  /** Hold the connection for one statement in `lane`. */
  run<T>(lane: StoreLane, fn: () => Promise<T>): Promise<T>;
  census(): StoreLaneCensus;
}

interface Waiter {
  lane: StoreLane;
  admit: () => void;
  queuedAt: number;
}

/**
 * How far ahead of the other lane a lane returning from IDLE may be, in milliseconds of store time.
 *
 * A lane idle for a minute would otherwise hold a minute of credit and run unopposed for a whole
 * backlog — this file's defect pointed the other way. Capped, not reset: the cycle's queue is empty
 * between its OWN statements, so a rule written "reset on arrival" fires on every one of them and
 * the weighting disappears (measured 0.49 where 0.67 was intended). A hundred milliseconds is about
 * a dozen statements — one interaction answered at once — and far above the drift between two
 * working lanes, so it never touches the steady state it is not about.
 */
export const CREDIT_BURST_MS = 100;

/**
 * THE MAIL'S OWN GAP IS NOT THE WINDOWS' TURN, for up to this many turns of the loop.
 *
 * The cycle is one statement deep and its MIME parse settles on the check phase, so between two
 * of its statements it is not queued, and serving whoever is queued gave a poller one statement
 * per turn: the weight held only while both lanes happened to be, and the share read 47 %. While
 * the ingest is behind its weighted share the connection waits for it instead. In turns, so a
 * cycle gone to the network costs a window microseconds; 32 covers the parse's 11.4 turns a
 * message with the readers' own beside them (15.9 under eight pollers).
 */
export const INGEST_GAP_TURNS = 32;

/**
 * The scheduler: one admission at a time — the connection allows no more — given to whichever lane
 * has had the least of it.
 *
 * `owed[lane]` is that lane's consumed store time DIVIDED BY ITS WEIGHT, so the ingest at
 * {@link INGEST_LANE_WEIGHT} accumulates half as fast and is chosen twice as often while both lanes
 * have work. Weight decides who goes FIRST and nothing else: with equal finite work on both sides
 * every schedule ends 50/50 whatever the weights, so the property is only visible against demand
 * that never runs out — which is what a poll loop is, and what the guard uses.
 */
export function createStoreScheduler(
  weights: Record<StoreLane, number> = { ingest: INGEST_LANE_WEIGHT, interactive: 1 },
  clock: () => number = () => performance.now(),
  creditBurstMs: number = CREDIT_BURST_MS,
  ingestGapTurns: number = INGEST_GAP_TURNS,
): StoreScheduler {
  const queues: Record<StoreLane, Waiter[]> = { ingest: [], interactive: [] };
  let active: symbol | null = null;
  /** Weighted store time each lane has had. Smaller goes next. See the header. */
  const owed: Record<StoreLane, number> = { ingest: 0, interactive: 0 };
  const admitted: Record<StoreLane, number> = { ingest: 0, interactive: 0 };
  const storeMs: Record<StoreLane, number> = { ingest: 0, interactive: 0 };
  const waitedMs: Record<StoreLane, number> = { ingest: 0, interactive: 0 };
  let busy = false;
  /** A dispatch is already on the check phase; a second would double-admit. */
  let scheduled = false;
  /** Admissions so far, and the last one each lane got — see {@link SHARED_WINDOW}. */
  let admissions = 0;
  const lastServed: Record<StoreLane, number> = { ingest: -Infinity, interactive: -Infinity };
  /** Admissions since the last turn of the event loop — see {@link TURN_EVERY}. */
  let sinceTurn = 0;
  /** Turns since the ingest's last statement returned — see {@link INGEST_GAP_TURNS}. */
  let sinceIngest = Infinity;

  /**
   * ONE TURN OF THE EVENT LOOP BETWEEN STATEMENTS, AND THE CHOICE MADE INSIDE IT.
   *
   * The hop is unconditional: gated on "somebody else is queued" it did nothing for a SINGLE reader,
   * which starves the loop just as completely (17.7 s) on a three-quarters idle connection —
   * contention is not the condition, an unbroken chain is. And the lane is chosen HERE rather than
   * where the previous statement finished: a lane never more than one statement deep, which the
   * cycle is, has an empty queue for the microtask between its own statements, so a choice made at
   * completion time cannot see it and the weighting silently becomes strict alternation.
   */
  const dispatch = (): void => {
    scheduled = false;
    if (busy) return;
    const ready = LANES.filter((l) => queues[l].length > 0);
    if (ready.length === 0) return;
    if (holdForIngest(ready)) {
      scheduled = true;
      setImmediate(onTurn);
      return;
    }
    const next = ready.reduce((a, b) => (owed[a] <= owed[b] ? a : b));
    const w = queues[next].shift()!;
    busy = true;
    admissions++;
    lastServed[next] = admissions;
    admitted[next]++;
    waitedMs[next] += clock() - w.queuedAt;
    w.admit();
  };

  /* Only the interactive lane is queued, a drain is live, the ingest returned within the bound
     and it has had no more than its weighted share: wait a turn for it. */
  const holdForIngest = (ready: readonly StoreLane[]): boolean =>
    ready.length === 1 && ready[0] === "interactive" && ingestIsRunning()
    && sinceIngest < ingestGapTurns && owed.ingest <= owed.interactive;

  const onTurn = (): void => {
    sinceIngest++;
    dispatch();
  };

  const pump = (): void => {
    if (busy || scheduled) return;
    if (queues.ingest.length + queues.interactive.length === 0) return;
    const idle: StoreLane = lastServed.ingest >= lastServed.interactive ? "interactive" : "ingest";
    const shared = admissions - lastServed[idle] <= SHARED_WINDOW;
    if (shared || ++sinceTurn >= TURN_EVERY) {
      sinceTurn = 0;
      scheduled = true;
      setImmediate(onTurn);
      return;
    }
    dispatch();
  };

  const enqueue = (lane: StoreLane): Promise<void> =>
    new Promise<void>((resolve) => {
      /* CREDIT IS CAPPED, NEVER BANKED — see {@link CREDIT_BURST_MS}. */
      const floor = Math.max(owed.ingest, owed.interactive) - creditBurstMs;
      if (owed[lane] < floor) owed[lane] = floor;
      queues[lane].push({ lane, admit: resolve, queuedAt: clock() });
      pump();
    });

  return {
    async run<T>(lane: StoreLane, fn: () => Promise<T>): Promise<T> {
      // RE-ENTRANT: a statement issued from inside the admission that is RUNNING already holds the
      // connection, so queueing it would wait for itself.
      if (active !== null && holding.getStore() === active) return fn();
      // NOTHING TO ARBITRATE. See {@link ingestIsRunning}: with no drain in flight this is the
      // store the app has always had, and the scheduler is not in the path at all.
      if (!ingestIsRunning()) return fn();
      await enqueue(lane);
      const token = Symbol("admission");
      active = token;
      const started = clock();
      try {
        return await holding.run(token, fn);
      } finally {
        active = null;
        const spent = clock() - started;
        storeMs[lane] += spent;
        owed[lane] += spent / (weights[lane] || 1);
        if (lane === "ingest") sinceIngest = 0;
        busy = false;
        pump();
      }
    },
    census: () => ({
      admitted: { ...admitted },
      storeMs: { ...storeMs },
      waitedMs: { ...waitedMs },
    }),
  };
}

/**
 * The three methods of a store handle that reach the one connection. Named here rather than
 * derived from the client's type: the set is the CONTRACT — a method added to PGlite that runs a
 * statement and is not in this list would run outside the scheduler, so the list is asserted by a
 * test against the handle the product opens rather than inferred.
 */
export const SCHEDULED_STORE_METHODS = ["query", "exec", "transaction"] as const;

/**
 * Put `scheduler` in front of every statement `client` runs, in place.
 *
 * In place and not a proxy object: the handle is the process singleton and is passed to drizzle,
 * to the compaction pass and to the checkpointer, so a wrapper only some of them held would leave
 * the others outside the scheduler with no sign of it.
 */
export function scheduleStoreLanes<C extends object>(client: C, scheduler: StoreScheduler): C {
  for (const name of SCHEDULED_STORE_METHODS) {
    const original = (client as Record<string, unknown>)[name] as ((...args: unknown[]) => Promise<unknown>) | undefined;
    if (typeof original !== "function") continue;
    Object.defineProperty(client, name, {
      configurable: true,
      writable: true,
      value: function scheduled(this: C, ...args: unknown[]): Promise<unknown> {
        return scheduler.run(currentStoreLane(), () => original.apply(this, args));
      },
    });
  }
  return client;
}
