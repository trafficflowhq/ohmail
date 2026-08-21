import postgres from "postgres";
import { CHANGE_LOG_CHANNEL, parseChangeWake } from "./change-log.js";
import { onNotice } from "./notices.js";

/**
 * ONE LISTEN CONNECTION PER PROCESS/INSTANCE, fanned out to that process's `/events` streams.
 *
 * Extracted verbatim from `apps/api-vercel/src/wake-hub.ts` (which now re-exports it), because a
 * second long-running host composes the same hub over its own connection string and the invariant
 * below must stay ONE implementation: two hand-kept copies of "streams : connections = N : 1"
 * is how one of them quietly becomes N : N. It lives on the CLOUD entry point — it dials a
 * `postgres://` URL, which no shipped local engine has.
 *
 * ── THE CONNECTION ECONOMICS, WHICH ARE THE WHOLE DESIGN ──────────────────────────────────
 *
 * A LISTEN must sit on a session-mode connection (on the managed host `DATABASE_URL_SESSION` —
 * the pooler pins one backend per client there; transaction mode multiplexes and the LISTEN
 * silently subscribes a backend the next statement has already left; a standalone server's plain
 * Postgres URL is session-mode by nature). Session-mode slots are the scarce resource: they are
 * real pinned backends, budgeted in the tens, not the hundreds. So the invariant this module
 * exists to hold is **streams : connections = N : 1 per instance** —
 *
 *  · never one LISTEN per stream (a hundred tabs would hold a hundred pinned backends, which
 *    is the pooler-exhaustion shape `events.ts` was written against);
 *  · lazily dialed — an instance that has served no `/events` stream holds nothing;
 *  · released when idle — {@link IDLE_CLOSE_MS} after the last unsubscribe, the connection is
 *    ended, so a fleet of warm-but-quiet instances converges back to zero held slots.
 *
 * ── FAILURE IS DEGRADATION, NEVER AN ERROR THE STREAM SEES ────────────────────────────────
 *
 * `subscribe` never throws and never blocks: a hub whose LISTEN cannot be established (bad
 * URL, exhausted pool, provider hiccup) registers the callback anyway and keeps trying to dial
 * on later subscribes, one attempt per {@link RETRY_AFTER_MS}. Streams notice nothing — their
 * own poll loop is the reliability floor, and a missed wake is indistinguishable from quiet.
 * postgres-js re-dials a dropped listen connection itself (and re-issues the LISTEN on
 * reconnect); the retry here covers the attempt that failed outright.
 *
 * The payload is parsed by `parseChangeWake` and anything malformed is dropped: this channel
 * is shared infrastructure, and a foreign writer on it must not become an exception inside a
 * notification callback.
 */
export const IDLE_CLOSE_MS = 60_000;
export const RETRY_AFTER_MS = 30_000;

interface HubLog {
  error(event: string, fields?: Record<string, unknown>): void;
}

/**
 * The hub's own interface, declared HERE structurally identical to `ChangeWakeHub` in
 * `@trafficflow/api` — this package sits BELOW the API package in the dependency order, so it
 * cannot import the type it satisfies. `deps-parity`: the API's `ChangeWakeHub` has exactly
 * `subscribe`, and structural typing is what lets every host assign this without a cast.
 *
 * `end()` is IN ADDITION to that contract and exists for the long-running host: a standalone
 * server's SIGTERM must be able to release the LISTEN connection NOW rather than waiting out
 * {@link IDLE_CLOSE_MS} with a socket holding the event loop open. The serverless host never
 * calls it (its instances are reaped by the platform), so its behavior is byte-identical to the
 * pre-extraction module. `end()` is idempotent; a subscribe arriving after it may re-dial, which
 * is harmless — shutdown closes the server before the hub, so nothing subscribes after.
 */
export interface ChangeWakeFanout {
  subscribe(accountId: string, onWake: (seq: bigint) => void): () => void;
  /**
   * EVERY account's wakes, one subscriber — the worker's push-wake sender, which cannot
   * enumerate accounts up front the way an `/events` stream names its own. Counted like any
   * other subscriber for the lazy dial and the idle close, so a process whose only consumer is
   * the sender still holds exactly one LISTEN and still releases it on `end()`. The callback
   * gets the account id AND the seq because that is the whole payload — nothing here widens
   * what rides the channel (see `CHANGE_LOG_CHANNEL`: id and seq, never content).
   */
  subscribeAll(onWake: (accountId: string, seq: bigint) => void): () => void;
  end(): Promise<void>;
}

/**
 * `retryAfterMs` overrides {@link RETRY_AFTER_MS} for ONE hub, and it exists for exactly one
 * reason: the all-accounts subscriber's retry (see `subscribeAll`) cannot be driven in a test at
 * the shipped thirty seconds, and fake timers cannot drive it either — the dial's failure is real
 * socket I/O, not a timer, so advancing fake time proves nothing. A guard nobody can watch fail is
 * not a guard, so the cadence is a parameter. Nothing in production passes it.
 */
export function makeChangeWakeHub(
  url: string, log?: HubLog, opts: { retryAfterMs?: number } = {},
): ChangeWakeFanout {
  const retryAfterMs = opts.retryAfterMs ?? RETRY_AFTER_MS;
  const subs = new Map<string, Set<(seq: bigint) => void>>();
  const allSubs = new Set<(accountId: string, seq: bigint) => void>();
  let total = 0;

  let sql: ReturnType<typeof postgres> | null = null;
  let listening: Promise<void> | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let retryAt = 0;

  const dispatch = (payload: string): void => {
    const wake = parseChangeWake(payload);
    if (!wake) return;
    const set = subs.get(wake.accountId);
    if (set) {
      for (const cb of [...set]) {
        try {
          cb(wake.seq);
        } catch {
          // One subscriber's throw must not stop the fan-out to its siblings. The stream's own
          // send() already swallows a dead controller; anything else is that stream's bug.
        }
      }
    }
    for (const cb of [...allSubs]) {
      try {
        cb(wake.accountId, wake.seq);
      } catch {
        // Same rule: the sender's bug must not silence the per-account streams beside it.
      }
    }
  };

  const teardown = async (): Promise<void> => {
    const s = sql;
    sql = null;
    listening = null;
    if (s) {
      try {
        await s.end({ timeout: 5 });
      } catch {
        /* a connection that will not close politely is closed by the socket */
      }
    }
  };

  const ensureListening = (): void => {
    if (listening || total === 0) return;
    if (Date.now() < retryAt) return;
    // max: 1 — this handle exists for the LISTEN and nothing else; a query pool here would be
    // session-mode slots spent on work the host's own runtime connection already does. `onnotice`
    // routes server notices through the hardened logger like every other production client;
    // without it postgres.js writes raw notice objects straight to the drain.
    sql ??= postgres(url, { max: 1, prepare: false, connect_timeout: 10, onnotice: onNotice });
    listening = sql
      .listen(CHANGE_LOG_CHANNEL, dispatch)
      .then(() => undefined)
      .catch(async (err: unknown) => {
        retryAt = Date.now() + retryAfterMs;
        await teardown();
        // Degradation, not an outage: every open stream still has its poll. Said once per
        // failed attempt so a permanently broken LISTEN is visible in the logs, not silent.
        log?.error("sse_listen_unavailable", {
          err,
          reason: "the change_log LISTEN could not be established; /events streams run on " +
            "their poll loop until it can — latency degrades to pollMs, nothing else changes",
        });
      });
  };

  const scheduleIdleClose = (): void => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (total === 0) void teardown();
    }, IDLE_CLOSE_MS);
    // A held timer must not keep a serverless process alive on its own.
    (idleTimer as { unref?: () => void }).unref?.();
  };

  return {
    subscribe(accountId, onWake) {
      let set = subs.get(accountId);
      if (!set) {
        set = new Set();
        subs.set(accountId, set);
      }
      set.add(onWake);
      total += 1;
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
      ensureListening();

      let gone = false;
      return () => {
        if (gone) return;                       // idempotent: stop() can run twice
        gone = true;
        set!.delete(onWake);
        if (set!.size === 0) subs.delete(accountId);
        total = Math.max(0, total - 1);
        if (total === 0) scheduleIdleClose();
      };
    },
    subscribeAll(onWake) {
      allSubs.add(onWake);
      total += 1;
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
      ensureListening();

      /**
       * ── THIS SUBSCRIBER NEEDS ITS OWN RETRY, AND THAT IS A REAL ASYMMETRY WITH `subscribe` ────
       *
       * The retry this module documents — "keeps trying to dial on later subscribes, one attempt
       * per RETRY_AFTER_MS" — is driven entirely by NEW SUBSCRIBERS calling `ensureListening`. For
       * `/events` that is self-driving: streams come and go constantly, and every reconnect is
       * another attempt. `subscribeAll` has exactly one consumer, which subscribes ONCE at process
       * start and never again. So a LISTEN that failed at boot — a pooler at its limit during a
       * rolling deploy is the ordinary way — stayed failed for the life of the process, and the
       * startup path's claim that it retries was false for precisely this subscriber.
       *
       * A timer rather than a hook on the failed dial, because `ensureListening` is already
       * idempotent and already respects `retryAt`: an attempt that is not due is free, and one that
       * is due is exactly the retry that was missing. Unref'd, so it never keeps a process alive,
       * and cleared on unsubscribe so a stopped sender leaves nothing behind.
       */
      const retry = setInterval(() => { ensureListening(); }, retryAfterMs);
      (retry as { unref?: () => void }).unref?.();

      let gone = false;
      return () => {
        if (gone) return;                       // idempotent, exactly as subscribe()'s
        gone = true;
        clearInterval(retry);
        allSubs.delete(onWake);
        total = Math.max(0, total - 1);
        if (total === 0) scheduleIdleClose();
      };
    },
    // The prompt release for a long-running host's shutdown. Idempotent: `teardown` nulls the
    // handle, so a second call awaits nothing.
    async end() {
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
      await teardown();
    },
  };
}
