import { and, desc, eq, inArray, isNotNull, notInArray, sql } from "drizzle-orm";
import { mailboxes, type Tx } from "@trafficflow/db";
import { silentLogger, type Logger } from "@trafficflow/core";

/**
 * ENFORCED SYNC — the worker half of `mailboxes.sync_requested_at` (mail 0049). The API stamps it the
 * instant it finalizes a write the user is watching; this pass is the doorbell's other end — a short scan,
 * far more often than the 60 s poll, that kicks an out-of-band cycle for any stamped mailbox this process
 * serves and clears the stamp. Its writers each finalize a write somebody is watching:
 * the send's finalize, the junk rescue, the junk sweep press, the folder-op service, the mailbox
 * service's resync, its pull and its create (the unserved arm asks for a roster), the two lease presses, "Organize here" and "Hand the mailbox back" (a served row with either pending asks a roster first), the account's reopening, and a FILING decision, which rings after its own commit (`packages/db/src/filing-doorbell.ts`). NOT a leader-locked backstop — it runs
 * only inside a live worker, and writes only its own attached mailboxes (producer: {@link startSyncKickBell} below, on the change log's signal and on a floor timer). The
 * clear is COMPARE-AND-CLEAR (`WHERE sync_requested_at = <observed>`) so a second stamp mid-flight is
 * preserved; and compared as TEXT (`::text` / `= <that>::timestamptz`) because `timestamptz` microseconds never survive a JS millisecond `Date` — measured 2026-08-26, an SQL `now()` stamp kicked every 3 s for 10+ min. Pure/hermetic, proven on real Postgres. */
export interface SyncKickDeps {
  /** The db/tx handle. */
  db: Tx;
  /** The mailbox ids this process currently serves (the worker's live runtime keys). */
  served: () => Iterable<string>;
  /**
   * Trigger an out-of-band ingest/reconcile for one served mailbox. The worker wires this to an
   * immediate cycle request (which returns void); it is AWAITED so the compare-and-clear below can
   * only run once the kick has been issued, which is what makes a stamp that changes mid-kick
   * observable — and testable — rather than a race. Called at most once per stamped mailbox per pass.
   */
  kick: (mailboxId: string) => void | Promise<void>;
  /**
   * Ask for a roster pass, for a stamped mailbox this process does not serve — a mailbox created a
   * moment ago waits for the roster otherwise. Called once per OBSERVED stamp value per mailbox
   * (`askedFor` remembers them), and such a stamp is never cleared here: only the process that
   * serves the mailbox clears it. Both omitted is the served arm alone.
   */
  requestRoster?: () => void;
  askedFor?: Map<string, string>;
  /**
   * A served mailbox whose row carries an unspent lease press: "Organize here"
   * (`takeover_authorized_at`) or "Hand the mailbox back" (`release_requested_at`). The runtime's
   * lease columns are refreshed only by a roster pass, so the kick alone would run the gate on the
   * value read before the press; the worker wires this to `requestRoster`, called BEFORE `kick`
   * so the pass is queued ahead of the cycle. It only asks: the fenced gate still decides.
   */
  leasePressed?: (mailboxId: string) => void;
  now?: () => Date;
  log?: Logger;
}

/** Unserved stamps read per scan, newest first; a new mailbox's stamp is always among them. */
const SYNC_KICK_UNSERVED_MAX = 64;

export interface SyncKickResult {
  /** Mailboxes that were stamped and served, and for which `kick` was called this pass. */
  kicked: string[];
  /** How many of those had their stamp cleared (compare-and-clear landed; a newer stamp did not). */
  cleared: number;
  /** Unserved mailboxes whose stamp was new to this process, so a roster pass was requested. */
  rosterFor: string[];
}

/**
 * One kick scan. Returns which served mailboxes owed a reconcile and were kicked, and how many
 * stamps were cleared — the two numbers the pg test and the worker's log line read.
 */
export async function syncKickPass(deps: SyncKickDeps): Promise<SyncKickResult> {
  const log = deps.log ?? silentLogger;
  const served = [...new Set(deps.served())];
  const rosterFor = deps.requestRoster && deps.askedFor
    ? await askRosterForUnserved(deps.db, served, deps.askedFor, deps.requestRoster)
    : [];
  if (served.length === 0) return { kicked: [], cleared: 0, rosterFor };

  // Only mailboxes THIS process serves AND that are stamped. Scoping to the served set is what
  // keeps the pass from reaching into a mailbox another worker (or a desktop install) organizes —
  // the same principle the roster pass follows. The stamp is read AS TEXT — see the header: a
  // `Date` truncates the server's microseconds and the compare-and-clear below must name the
  // stored value exactly.
  const rows = await deps.db
    .select({
      id: mailboxes.id,
      requestedAtText: sql<string | null>`${mailboxes.syncRequestedAt}::text`,
      pressed: mailboxes.takeoverAuthorizedAt,
      released: mailboxes.releaseRequestedAt,
    })
    .from(mailboxes)
    .where(and(inArray(mailboxes.id, served), isNotNull(mailboxes.syncRequestedAt)));

  const kicked: string[] = [];
  let cleared = 0;
  for (const row of rows) {
    if (!row.requestedAtText) continue; // isNotNull already guarantees this; narrows the type.
    // Kick first: the mailbox owed a reconcile the moment we read the stamp, and a kick is only a
    // request for a cycle, so it is safe to issue before the clear even if the clear then misses.
    try {
      if (row.pressed !== null || row.released !== null) deps.leasePressed?.(row.id);
      await deps.kick(row.id);
      kicked.push(row.id);
    } catch (err) {
      log.warn("sync_kick_trigger_failed", { mailboxId: row.id, err });
      continue; // do NOT clear a stamp we failed to act on.
    }
    // Compare-and-clear on the observed instant, at the SERVER's precision. A stamp that changed
    // since the read (a second send) does not match and is preserved for the next pass.
    const done = await deps.db
      .update(mailboxes)
      .set({ syncRequestedAt: null })
      .where(and(
        eq(mailboxes.id, row.id),
        sql`${mailboxes.syncRequestedAt} = ${row.requestedAtText}::timestamptz`,
      ))
      .returning({ id: mailboxes.id });
    if (done.length > 0) cleared += 1;
  }
  return { kicked, cleared, rosterFor };
}

/**
 * The unserved arm: a roster request per stamp value this process has not seen for that mailbox.
 * Nothing is written. The memory keeps only mailboxes still stamped and unserved, so it is bounded
 * by the scan, and a mailbox served by another shard costs one request per stamp, not one a tick.
 */
async function askRosterForUnserved(
  db: Tx, served: readonly string[], askedFor: Map<string, string>, requestRoster: () => void,
): Promise<string[]> {
  const rows = await db
    .select({ id: mailboxes.id, requestedAtText: sql<string | null>`${mailboxes.syncRequestedAt}::text` })
    .from(mailboxes)
    .where(and(
      isNotNull(mailboxes.syncRequestedAt),
      ...(served.length > 0 ? [notInArray(mailboxes.id, [...served])] : []),
    ))
    .orderBy(desc(mailboxes.syncRequestedAt))
    .limit(SYNC_KICK_UNSERVED_MAX);
  const seen = new Set<string>();
  const asked: string[] = [];
  for (const row of rows) {
    if (!row.requestedAtText) continue;
    seen.add(row.id);
    if (askedFor.get(row.id) === row.requestedAtText) continue;
    askedFor.set(row.id, row.requestedAtText);
    requestRoster();
    asked.push(row.id);
  }
  for (const id of [...askedFor.keys()]) if (!seen.has(id)) askedFor.delete(id);
  return asked;
}

/**
 * The least time between two scans a SIGNAL starts. The worker's own ingest signals on every chunk it
 * records, so a long import rings without pause; with this gap that costs one scan a second while it
 * lasts (two statements each, the scan the floor already runs every {@link SyncKickBellDeps.floorMs}).
 */
export const SYNC_KICK_SIGNAL_GAP_MS = 1_000;

export interface SyncKickBellDeps {
  /** One scan ({@link syncKickPass}); `by` is what started it. */
  pass: (by: "signal" | "floor") => Promise<unknown>;
  /** The floor: a scan this often whatever was heard, so a lost signal costs at most this wait. */
  floorMs: number;
  /** See {@link SYNC_KICK_SIGNAL_GAP_MS}. */
  gapMs: number;
  /** The change log's signal for every account. Absent: the floor alone. */
  source?: { subscribeAll(onWake: (accountId: string, seq: bigint) => void): () => void };
  /**
   * Whether this process serves a mailbox of the account. A signal for any other account is dropped
   * here, in memory: it starts no scan, so nothing an account writes costs a worker that does not
   * serve it. Absent: every signal rings.
   */
  owns?: (accountId: string) => boolean;
  isStopped: () => boolean;
  log?: Logger;
  /** The word the bell's own two log lines begin with; another pass's bell names itself. Absent: `sync_kick`. */
  label?: string;
}

export interface SyncKickBell {
  /** A signal for this account: a scan now, or one owed scan once the gap or the running scan allows. */
  ring(accountId: string): void;
  stop(): void;
}

/**
 * THE DOORBELL. The scan of {@link syncKickPass} on two triggers: the change log's signal, and a
 * floor timer. One scan at a time, whoever starts it: a floor tick that finds one running is skipped
 * (the stamp is there at the next), and signals heard meanwhile, however many, owe ONE more scan. A
 * scan that starts after a signal has read what the signal announced, so it pays that debt. A signal
 * only starts the scan: which mailboxes are kicked and which stamps are cleared is the scan's own
 * read of the mailboxes this process serves, and never the signal's account.
 */
export function startSyncKickBell(deps: SyncKickBellDeps): SyncKickBell {
  const log = deps.log ?? silentLogger;
  const label = deps.label ?? "sync_kick";
  let ended = false;
  let inFlight = false;
  /** A signal was heard that no scan started since has answered. */
  let owed = false;
  let owedTimer: ReturnType<typeof setTimeout> | null = null;
  /** When the last scan a signal started began; the gap is counted from it. */
  let lastSignalScanAt = Number.NEGATIVE_INFINITY;
  const off = (): boolean => ended || deps.isStopped();

  const scan = (by: "signal" | "floor"): void => {
    if (off() || inFlight) return;
    inFlight = true;
    owed = false;
    if (owedTimer !== null) { clearTimeout(owedTimer); owedTimer = null; }
    if (by === "signal") lastSignalScanAt = Date.now();
    void (async () => {
      try {
        await deps.pass(by);
      } catch (err) {
        log.warn(`${label}_failed`, { err });
      } finally {
        inFlight = false;
        if (owed) serveOwed();
      }
    })();
  };

  /** The owed scan: now when the gap has passed, else once it has. */
  const serveOwed = (): void => {
    if (off() || inFlight || owedTimer !== null) return;
    const wait = lastSignalScanAt + deps.gapMs - Date.now();
    if (wait <= 0) { scan("signal"); return; }
    owedTimer = setTimeout(() => { owedTimer = null; if (owed) scan("signal"); }, wait);
  };

  const ring = (accountId: string): void => {
    if (off()) return;
    if (deps.owns !== undefined && !deps.owns(accountId)) return;
    owed = true;
    serveOwed();
  };

  const floor = setInterval(() => { scan("floor"); }, deps.floorMs);
  let unsubscribe: (() => void) | null = null;
  try {
    // The payload's sequence number is dropped here: the bell needs to know that something changed, not what.
    unsubscribe = deps.source?.subscribeAll((accountId) => { ring(accountId); }) ?? null;
  } catch (err) {
    log.warn(`${label}_signal_unavailable`, { err, reason: "the change log's signal could not be subscribed; the floor scan serves alone" });
  }

  return {
    ring,
    stop(): void {
      ended = true;
      clearInterval(floor);
      if (owedTimer !== null) { clearTimeout(owedTimer); owedTimer = null; }
      unsubscribe?.();
      unsubscribe = null;
    },
  };
}
