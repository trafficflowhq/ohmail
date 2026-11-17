// The desktop's engine: the passes' constants, the drain's summary and the four route wrappers.

import { errorResponse, type Route } from "@trafficflow/api/local";

/**
 * The budget for the historical-name repair, per drain — see `backfillStoredNames`. Two numbers because they
 * bound different things: the batch is how many rows one transaction writes; the pages are how many of those
 * a drain may run before yielding. Their product — 200 rows — is one visit's whole work, a deliberately small
 * fraction of a store that may hold tens of thousands: the repair is cosmetic and the sync it rides is not.
 * The batch is half the shared default — that default is sized for a server with the table to itself; here
 * the parse, the write and the request handler are one process, and what matters is the longest stretch in
 * which the window gets no answer. Fifty thousand messages take a few hundred drains, hours of the app being
 * open — the intended shape, not a limitation: rows read as they always have until their turn comes.
 */
export const LOCAL_NAME_BACKFILL_BATCH = 100;
export const LOCAL_NAME_BACKFILL_PAGES = 2;

/** Pages of senders the launch's act-admission retirement may walk: a bound, never reached in practice. */
export const LOCAL_ACT_RETIRE_PAGES = 1000;

/**
 * How often a launch runs the THREAD-JOIN HEAL (`@ohmail/organizer/thread-join-heal`) at the
 * tail of a drain. Six hours — the hosted worker's own gate — because it repairs presentation
 * (a conversation a forward split into two threads), nothing user-promised rides on a run, and
 * its candidate pre-filter is a GROUP BY over the store's threads that per-drain polling would
 * pay for nothing. A `const`, not an env var, for the reason every gate here is.
 */
export const LOCAL_JOIN_HEAL_EVERY_MS = 6 * 60 * 60 * 1000;

/**
 * How often a launch runs the INBOUND-QUIET pass (`@ohmail/organizer/inbound-quiet` — the
 * forwarding-detection heuristic, mail 0078) at the tail of a drain. Six hours, the hosted
 * worker's own gate, for its reason: the pass judges fortnight-wide windows, so nothing a user
 * can perceive changes between two drains, and its grouped aggregate is not worth paying
 * per poll. A standalone install has the same blind spot the incident was found in — a
 * provider-level forward diverts mail before IMAP storage while every cycle here reports
 * healthy — and no worker anywhere else will ever judge this store. A `const`, not an env
 * var, for the reason every gate here is.
 */
export const LOCAL_INBOUND_QUIET_EVERY_MS = 6 * 60 * 60 * 1000;

/**
 * A drain's wall-clock shape, from the per-cycle durations it measured — the number that
 * attributes desktop CPU and quit lag. A drain runs its inner cycles back-to-back (only a
 * `setTimeout(0)` yield between), so a drain taking longer than the poll interval is a high-duty
 * loop; and quit waits for the in-flight cycle, so `slowestMs` is the floor on how long an
 * ordinary quit blocks. `slowestMs` is the max, not the sum — the single cycle a quit waits on,
 * and the sharpest read on the account-wide-modseq folder-diff (an iCloud mailbox re-scans every
 * watched folder whenever any changed). Pure, testable without IMAP.
 */
export function summarizeDrain(cycleMs: readonly number[]): { cycles: number; totalMs: number; slowestMs: number } {
  let totalMs = 0;
  let slowestMs = 0;
  for (const ms of cycleMs) {
    totalMs += ms;
    if (ms > slowestMs) slowestMs = ms;
  }
  return { cycles: cycleMs.length, totalMs, slowestMs };
}

/**
 * "Sync now" forces a re-dial — the local door's one addition to the shared resync route. The shared handler
 * nulls every folder's cursor and answers 202; on this door the engine is in this process and holds a backoff
 * ladder, so the press was answered 202 and nothing happened until the ladder ran down. Wrapped rather than
 * replaced: the shared handler stays the authority for what a resync IS. On a 202 only — and 202 is the only
 * answer this check ever sees: every refusal the shared handler makes is thrown and enveloped above this
 * wrapper, so the status test is a contract on this wrapper (the suite reaches the other arm with a stub
 * route). Fire-and-forget so the answer stays immediate; the catch prevents a process-level crash on a
 * mailbox that is simply still unreachable — the ordinary case this exists for.
 */
export function withForcedRedial(
  routes: readonly Route[],
  runtimeFor: (mailboxId: string) => { syncUntilQuiet(maxCycles?: number, opts?: { force?: boolean }): Promise<number> } | undefined,
  /**
   * The engine's diagnostic seam, for the ONE line this wrapper writes: a press it refused
   * because there is no runtime to hand it to. Optional so the wrapper stays drivable from a
   * test with a stub route and nothing else — see the control that reaches its refusal arm.
   */
  log: (event: string, detail: Record<string, unknown>) => void = () => undefined,
): Route[] {
  return routes.map((r) => {
    if (r.method !== "POST" || r.pattern !== "/mailboxes/:id/resync") return r;
    return {
      ...r,
      handler: async (req, deps, params) => {
        const res = await r.handler(req, deps, params);
        if (res.status !== 202) return res;
        const id = params.id;
        if (id === undefined) return res;
        const runtime = runtimeFor(id);
        /* No runtime means the press reaches nothing, so it is refused rather than queued.
         * This was `runtimeFor(id)?.syncUntilQuiet(...)`, and the optional chain is the whole
         * defect: for a mailbox with no runtime nothing was dialled and the shared handler's
         * 202 was returned anyway — the pane says "Sync queued" while the engine never hears
         * of the mailbox, the failure-looks-like-healthy shape on the one control that exists
         * to make a stuck mailbox move. Reaching here with no runtime is not a race with a
         * removal: the 202 means `ownedRow` found the row and `assertOrganizerRole` read
         * `organizer` — the state this refusal makes unrepresentable. `DesktopMailboxes`
         * renders the sentence.
         */
        if (runtime === undefined) {
          log("local_mailbox_resync_unserved", {
            mailboxId: id,
            reason: "a resync was asked for a mailbox this install holds no runtime for; nothing "
              + "was dialled and the press is refused rather than reported as queued",
          });
          return errorResponse(
            "sync_engine_absent", 503,
            "This install is not running this mailbox, so there is nothing to sync here.",
          );
        }
        void runtime.syncUntilQuiet(undefined, { force: true })
          .catch(() => { /* the drain reports its own failures; a press must not crash the host */ });
        return res;
      },
    };
  });
}

/**
 * A PRESS OF IMPORT SETTINGS HANDED TO THE ORGANIZER reaches it now. The shared handler records
 * the ask and rings `sync_requested_at`, which only the hosted worker reads; here the organizer
 * is this process, idling up to its poll ceiling, so a 202 starts one drain whose tail runs the
 * ask. Fire-and-forget, as {@link withForcedRedial}: the answer stays immediate.
 */
export function withImportHandover(
  routes: readonly Route[],
  runtimeFor: (mailboxId: string) => { syncUntilQuiet(maxCycles?: number): Promise<number> } | undefined,
): Route[] {
  return routes.map((r) => {
    if (r.method !== "POST" || r.pattern !== "/mailboxes/:id/profile-import") return r;
    return {
      ...r,
      handler: async (req, deps, params) => {
        const res = await r.handler(req, deps, params);
        if (res.status !== 202 || params.id === undefined) return res;
        void runtimeFor(params.id)?.syncUntilQuiet(1)
          .catch(() => { /* the drain reports its own failures; a press must not crash the host */ });
        return res;
      },
    };
  });
}

/**
 * A PRESS THAT ASKS FOR THE WIRE RINGS THE ORGANIZER HERE. `POST /sync/pull` stamps
 * `sync_requested_at`, which only the hosted worker reads; on this composition the organizer is
 * this process, so a 202 rings every runtime's doorbell (`ring`, the INBOX `exists` path: the
 * ladder to base and one coalesced drain under `serialize`). Unconditional on the 202 — the
 * stamp's own gap would make a second press wait for the poll. No runtime rings nothing.
 */
export function withPullKick(
  routes: readonly Route[],
  runtimesFor: () => Iterable<{ ring(): void }>,
  runtimeFor: (mailboxId: string) => { ring(): void } | undefined = () => undefined,
  onGapPress: (mailboxId: string) => void = () => undefined,
): Route[] {
  return routes.map((r) => {
    /* "ORGANIZE HERE" AND "HAND THE MAILBOX BACK" RING THEIR OWN MAILBOX: the next gated pass
       re-reads the stamp (a release is its first arm) and the lease decides, so neither press is
       left to the next poll. "Try again now" on the waiting filings likewise: it re-arms the rows,
       and only the hosted worker reads the stamp it leaves. */
    if (r.method === "POST" && (r.pattern === "/mailboxes/:id/organize" || r.pattern === "/mailboxes/:id/release"
      || r.pattern === "/mailboxes/:id/filings/retry")) {
      return { ...r, handler: async (req, deps, params) => {
        const res = await r.handler(req, deps, params);
        if (res.status === 202) runtimeFor(params.id ?? "")?.ring();
        return res;
      } } as Route;
    }
    /* A RULE WRITTEN HERE RINGS EVERY RUNTIME: the retro walk runs at the start of each drain, so
       the mail a sheet press asked to file is not left to the idle poll. A 202 (another install
       organizes) or a refusal rings nothing. */
    if ((r.method === "POST" && r.pattern === "/rules") || (r.method === "PATCH" && r.pattern === "/rules/:id")) {
      return { ...r, handler: async (req, deps, params) => {
        const res = await r.handler(req, deps, params);
        if (res.status === 200 || res.status === 201) for (const rt of runtimesFor()) rt.ring();
        return res;
      } } as Route;
    }
    /* THE GAP PRESS (mail 0151) RINGS ITS OWN MAILBOX: the organizer's next drain files the set. */
    if (r.method === "POST" && r.pattern === "/mailboxes/:id/gap-letters") {
      return { ...r, handler: async (req, deps, params) => {
        const res = await r.handler(req, deps, params);
        if (res.status === 202) { onGapPress(params.id ?? ""); runtimeFor(params.id ?? "")?.ring(); }
        return res;
      } } as Route;
    }
    if (r.method !== "POST" || r.pattern !== "/sync/pull") return r;
    return {
      ...r,
      handler: async (req, deps, params) => {
        /* A PRESS NAMES ITS MAILBOX (`mailboxIds`), and only that runtime rings; a pull that names
           none (pull-to-refresh) rings them all. Read off a clone, before the shared handler. */
        const named = await pullMailboxIds(req);
        const res = await r.handler(req, deps, params);
        if (res.status !== 202) return res;
        if (named === null) for (const rt of runtimesFor()) rt.ring();
        else for (const id of named) runtimeFor(id)?.ring();
        return res;
      },
    } as Route;
  });
}

/**
 * A READ OR UNREAD PRESS IS SENT AT ONCE. The routes write `desired_seen` and answer; on this door
 * the engine is in-process, so the press asks every runtime for one `\Seen`-only push behind its
 * drains instead of waiting for the next poll. Fire-and-forget: the answer never waits on IMAP.
 * A 202 on `/messages/:id` still landed its `unread` half locally.
 */
export function withSeenPush(
  routes: readonly Route[],
  runtimesFor: () => Iterable<{ pushSeen(): void }>,
): Route[] {
  return routes.map((r) => {
    const batch = r.method === "PATCH" && r.pattern === "/messages";
    if (!batch && !(r.method === "PATCH" && r.pattern === "/messages/:id")) return r;
    return { ...r, handler: async (req, deps, params) => {
      const res = await r.handler(req, deps, params);
      if (res.status === 200 || (!batch && res.status === 202)) for (const rt of runtimesFor()) rt.pushSeen();
      return res;
    } } as Route;
  });
}

/** The mailboxes a pull names, or `null` when it names none. Bounded; anything else is none. */
async function pullMailboxIds(req: Request): Promise<string[] | null> {
  try {
    const b = (await req.clone().json()) as { mailboxIds?: unknown };
    const ids = Array.isArray(b?.mailboxIds) ? b.mailboxIds.filter((x): x is string => typeof x === "string") : [];
    return ids.length > 0 ? [...new Set(ids)].slice(0, 64) : null;
  } catch {
    return null;
  }
}
