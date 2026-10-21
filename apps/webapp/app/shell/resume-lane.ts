/**
 * THE RESUME LANE: after a pause, one read warms the API and the rest follow a few at a time.
 *
 * Measured on Cloud (perf-026, "search after a pause"): a tab that came back fired its reads at
 * once, the platform started a fresh instance for most of them, and each paid a cold start. Here
 * every GET the web client's two API doors send (`api()` and the engine's transport) passes one
 * admission point:
 *
 * - COLD (no API answer for {@link LANE_COLD_AFTER_MS}, or the clock stepped back): the first read
 *   leads, the others wait for it. Never the access read: `GET /account/access` asks the
 *   entitlements program, the slowest read there is (perf-026: p50 283 ms against 51-67 ms for its
 *   siblings), so it goes at once, counted, and the next read leads.
 * - A PAGE LOAD (`confirming()`, the first-paint gate): a cold lane's lead is kept for the session
 *   confirm, which gates the delta, so nothing else goes before it. The access read is the one read
 *   it does not hold: the gate may ask it before the shell can confirm at all.
 * - A RETURN (`resume()`): the lead is reserved for the sync delta, cold or warm, so `/sync` goes
 *   first and the surfaces it names follow.
 * - The lead ends on its first answer, on any API answer (a kept lead: only its own read's), on its
 *   failure, or after {@link LANE_BOUND_MS}. A window of {@link LANE_WINDOW_MS} then admits at most
 *   {@link LANE_SLOTS} reads in flight; the delta first, then ceremony reads and the access read,
 *   then the rest, first come first served within each rank. Background reads take at most
 *   `LANE_SLOTS - 1`: the last slot is kept for the delta and the ceremony reads, so the session
 *   confirm that gates the delta never waits behind them.
 * - A read the person asked for (`asked`: an open, an attachment, a search) passes the cap. It is
 *   counted, and still waits for a lead's one answer.
 * - FREE requests never wait and are not counted: writes, the cookie-writing paths, the sign-out
 *   door. Their answers warm the lane like any other.
 * - No read waits longer than {@link LANE_BOUND_MS} from entry, whatever holds it: the lane's own
 *   timer releases it. A waiter whose signal aborts leaves and fails as its fetch would.
 *
 * Order and concurrency only: nothing is dropped, added or re-read here.
 */

/** Census (perf-026): a search within 30 s of the last one on an instance was warm. */
export const LANE_COLD_AFTER_MS = 30_000;
/** The longest a lead holds the lane, and the longest any read waits in it. */
export const LANE_BOUND_MS = 3_000;
/** The engine's body fetches already run in four slots; the mount's reads clear in three waves. */
export const LANE_SLOTS = 4;
/** How long the cap holds after a lead ends. */
export const LANE_WINDOW_MS = 10_000;

const DELTA_PATHS: ReadonlySet<string> = new Set(["/sync", "/sync/snapshot"]);
const CONFIRM_PATHS: ReadonlySet<string> = new Set(["/auth/session"]);
const ACCESS_PATH = "/account/access";

export interface LaneRequest {
  /** The API path, without the base or the query. */
  path: string;
  /** Never waits and is not counted (writes, cookie writers, the sign-out door). */
  free: boolean;
  /** A ceremony read: ranks with the access read, after the delta. */
  urgent?: boolean;
  /** The person is waiting for it (an open, an attachment, a search): passes the cap, not a lead. */
  asked?: boolean;
  signal?: AbortSignal | null;
}

export interface LaneTicket {
  /** The request waited: its door asks its identity questions again. */
  readonly waited: boolean;
  /** The request settled; `answered` when a response arrived. Idempotent. */
  done(answered: boolean): void;
}

export interface ResumeLane {
  /** A ticket at once when nothing holds the request, else a promise of one. */
  enter(req: LaneRequest): LaneTicket | Promise<LaneTicket>;
  /** A return is about to drain: reserve the lead for the delta. Returns the release. */
  resume(): () => void;
  /** A page load is about to confirm its session: keep a cold lane's lead for that confirm. Returns the release. */
  confirming(): () => void;
  /** Run `cb` once no lead is in the air (at once when none is). */
  afterLead(cb: () => void): void;
  /** An API answer that came through neither door (the session renewal). */
  noteAnswer(): void;
}

/** `reserved`: kept for a read not sent yet, the one `for` names (the delta on a return, the confirm on a page load). */
interface Lead { reserved: boolean; since: number; for: ReadonlySet<string> | null }

interface Waiter {
  path: string;
  rank: number;
  asked: boolean;
  at: number;
  go: (lead: Lead | null) => void;
  off: () => void;
}

export interface ResumeLaneOptions {
  now?: () => number;
  slots?: number;
}

export function createResumeLane(opts: ResumeLaneOptions = {}): ResumeLane & { dispose(): void } {
  const now = opts.now ?? (() => Date.now());
  const slots = opts.slots ?? LANE_SLOTS;
  let lastAnswerAt = Number.NEGATIVE_INFINITY;
  let lead: Lead | null = null;
  let windowUntil = Number.NEGATIVE_INFINITY;
  let inFlight = 0;
  const queue: Waiter[] = [];
  let afterLeadCbs: Array<() => void> = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  /** Past `since + LANE_BOUND_MS`, or the clock went back past `since`. */
  const overdue = (since: number, n: number): boolean => n < since || n - since >= LANE_BOUND_MS;
  const cold = (): boolean => {
    const n = now();
    return !(n >= lastAnswerAt && n - lastAnswerAt < LANE_COLD_AFTER_MS);
  };
  /** Rank 2 (background) leaves the last slot to the delta and the ceremony reads. */
  const capped = (rank: number, asked: boolean): boolean => {
    if (asked) return false;
    const n = now();
    const inWindow = n < windowUntil && windowUntil - n <= LANE_WINDOW_MS;
    return inWindow && inFlight >= (rank < 2 ? slots : Math.max(1, slots - 1));
  };
  const rankOf = (req: LaneRequest): number =>
    DELTA_PATHS.has(req.path) ? 0 : req.urgent === true || req.asked === true || req.path === ACCESS_PATH ? 1 : 2;

  function arm(): void {
    if (timer !== null) { clearTimeout(timer); timer = null; }
    if (disposed) return;
    let next = Number.POSITIVE_INFINITY;
    if (lead !== null) next = lead.since + LANE_BOUND_MS;
    for (const w of queue) next = Math.min(next, w.at + LANE_BOUND_MS);
    // The window's end lifts the cap for whoever still waits.
    if (queue.length > 0 && windowUntil > now()) next = Math.min(next, windowUntil);
    if (next === Number.POSITIVE_INFINITY) return;
    const delay = Math.min(Math.max(0, next - now()), LANE_BOUND_MS);
    timer = setTimeout(sweep, delay);
  }

  function sweep(): void {
    timer = null;
    const n = now();
    if (lead !== null && overdue(lead.since, n)) { leadOver(); return; }
    // Overdue waiters go whatever holds them: the bound is the lane's promise.
    for (let i = 0; i < queue.length;) {
      const w = queue[i]!;
      if (overdue(w.at, n)) { queue.splice(i, 1); release(w, null); } else i += 1;
    }
    pump();
  }

  function release(w: Waiter, asLead: Lead | null): void {
    w.off();
    inFlight += 1;
    w.go(asLead);
  }

  function leadOver(): void {
    lead = null;
    windowUntil = now() + LANE_WINDOW_MS;
    pump();
    const cbs = afterLeadCbs;
    afterLeadCbs = [];
    for (const cb of cbs) {
      try { cb(); } catch { /* the caller's own */ }
    }
  }

  function pump(): void {
    // A reserved lead goes to the read it is kept for, if that one is already waiting.
    const kept = lead?.reserved === true ? lead.for : null;
    const at = kept === null ? -1 : queue.findIndex((w) => kept.has(w.path));
    if (at >= 0) {
      const [w] = queue.splice(at, 1);
      lead = { reserved: false, since: now(), for: null };
      release(w!, lead);
    }
    // In rank order; a capped waiter stays, one its cap still admits goes past it.
    for (let i = 0; i < queue.length && lead === null;) {
      const w = queue[i]!;
      if (capped(w.rank, w.asked)) { i += 1; continue; }
      queue.splice(i, 1);
      release(w, null);
    }
    arm();
  }

  function ticket(waited: boolean, counted: boolean, mine: Lead | null): LaneTicket {
    let open = true;
    return {
      waited,
      done(answered: boolean): void {
        if (!open) return;
        open = false;
        if (counted) inFlight -= 1;
        if (answered) lastAnswerAt = now();
        if (lead !== null && ((mine !== null && lead === mine) || (answered && !lead.reserved))) {
          leadOver();
          return;
        }
        pump();
      },
    };
  }

  const startLead = (): Lead => {
    lead = { reserved: false, since: now(), for: null };
    inFlight += 1;
    arm();
    return lead;
  };

  /** Keep the lead for `paths` (none in the air): the reads that come first wait for them. */
  const reserve = (paths: ReadonlySet<string>): (() => void) => {
    const mine: Lead = { reserved: true, since: now(), for: paths };
    lead = mine;
    pump();
    return () => { if (lead === mine) leadOver(); };
  };

  return {
    enter(req) {
      if (req.free) return ticket(false, false, null);
      if (lead?.reserved === true && lead.for?.has(req.path) === true) return ticket(false, true, startLead());
      const rank = rankOf(req);
      const asked = req.asked === true;
      const access = req.path === ACCESS_PATH;
      // The first-paint gate asks the access read before the shell can confirm at all: a lead kept
      // for the confirm never holds it.
      const passes = access && lead?.reserved === true && lead.for === CONFIRM_PATHS;
      // A queued read of this rank or better goes first; the person's own goes past them.
      const ahead = !asked && queue.some((w) => w.rank <= rank);
      if ((lead === null || passes) && !ahead && !capped(rank, asked)) {
        // The access read never leads: the next read does.
        if (lead === null && !access && queue.length === 0 && cold()) return ticket(false, true, startLead());
        inFlight += 1;
        return ticket(false, true, null);
      }
      const signal = req.signal ?? null;
      if (signal?.aborted) return Promise.reject(abortReason(signal));
      return new Promise<LaneTicket>((resolve, reject) => {
        const onAbort = (): void => {
          const at = queue.indexOf(w);
          if (at >= 0) queue.splice(at, 1);
          arm();
          reject(abortReason(signal!));
        };
        const w: Waiter = {
          path: req.path,
          rank,
          asked,
          at: now(),
          go: (asLead) => resolve(ticket(true, true, asLead)),
          off: () => signal?.removeEventListener("abort", onAbort),
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        const after = queue.findIndex((x) => x.rank > w.rank);
        queue.splice(after < 0 ? queue.length : after, 0, w);
        pump();
      });
    },
    resume() {
      if (lead !== null) return () => {};
      return reserve(DELTA_PATHS);
    },
    confirming() {
      // Only a cold lane: a warm one (a navigation inside the tab) has nothing to warm.
      if (lead !== null || !cold()) return () => {};
      return reserve(CONFIRM_PATHS);
    },
    afterLead(cb) {
      if (lead === null) cb();
      else afterLeadCbs.push(cb);
    },
    noteAnswer() {
      lastAnswerAt = now();
      if (lead !== null && !lead.reserved) leadOver();
    },
    dispose() {
      disposed = true;
      if (timer !== null) { clearTimeout(timer); timer = null; }
      for (const w of queue.splice(0)) w.off();
      afterLeadCbs = [];
      lead = null;
    },
  };
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
}

let current = createResumeLane();

/** The tab's lane, shared by both API doors and the sync scheduler on the live web build. */
export const webLane: ResumeLane = {
  enter: (req) => current.enter(req),
  resume: () => current.resume(),
  confirming: () => current.confirming(),
  afterLead: (cb) => current.afterLead(cb),
  noteAnswer: () => current.noteAnswer(),
};

/** A fresh lane for the next test; waiters of the old one are dropped unsettled. */
export function resetResumeLaneForTests(): void {
  current.dispose();
  current = createResumeLane();
}
