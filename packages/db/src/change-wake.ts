import postgres from "postgres";
import { CHANGE_LOG_CHANNEL, parseChangeWake } from "./change-log.js";
import { onNotice } from "./notices.js";

/**
 * One LISTEN connection per process/instance, fanned out to that process's `/events` streams.
 * `apps/api-vercel/src/wake-hub.ts` re-exports this; a second long-running host composes the same
 * hub, and "streams : connections = N : 1" must stay ONE implementation. On the CLOUD entry point
 * — it dials a `postgres://` URL. A LISTEN needs a session-mode connection, and session slots are
 * scarce. So: never one LISTEN per stream, lazily dialed, released {@link IDLE_CLOSE_MS} after
 * the last unsubscribe. Failure is degradation: `subscribe` never throws — a failed LISTEN
 * registers the callback and retries on later subscribes, one attempt per {@link RETRY_AFTER_MS};
 * the stream's own poll loop is the reliability floor. Malformed payloads are dropped.
 */
export const IDLE_CLOSE_MS = 60_000;
export const RETRY_AFTER_MS = 30_000;

interface HubLog {
  error(event: string, fields?: Record<string, unknown>): void;
}

/**
 * The hub's own interface, structurally identical to `ChangeWakeHub` in `@trafficflow/api` — this
 * package sits BELOW the API in the dependency order, so it cannot import the type it satisfies;
 * structural typing lets every host assign it without a cast. `end()` is in ADDITION to that
 * contract, for the long-running host: a standalone server's SIGTERM must release the LISTEN
 * connection NOW rather than waiting out {@link IDLE_CLOSE_MS} with a socket holding the event
 * loop open. The serverless host never calls it. `end()` is idempotent; a subscribe arriving
 * after it may re-dial, which is harmless — shutdown closes the server before the hub.
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
  /**
   * The armed `subscribeAll` retry intervals, so {@link ChangeWakeFanout.end} can disarm them.
   * A Set rather than a single handle because nothing forbids two all-accounts subscribers on one
   * hub, and a shutdown has to silence all of them, not the most recent one.
   */
  const retryTimers = new Set<ReturnType<typeof setInterval>>();
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
       * This subscriber needs its own retry — a real asymmetry with `subscribe`. The module's
       * retry ("one attempt per RETRY_AFTER_MS") is driven by NEW subscribers calling
       * `ensureListening`; for `/events` that is self-driving, but `subscribeAll` has exactly one
       * consumer, which subscribes ONCE at process start. A LISTEN that failed at boot — a pooler
       * at its limit during a rolling deploy is the ordinary way — stayed failed for the life of
       * the process. A timer rather than a hook on the failed dial: `ensureListening` is
       * idempotent and respects `retryAt`, so an attempt not due is free. Unref'd so it never
       * keeps a process alive; cleared on unsubscribe.
       */
      const retry = setInterval(() => { ensureListening(); }, retryAfterMs);
      (retry as { unref?: () => void }).unref?.();
      // TRACKED, so `end()` can disarm it. See {@link ChangeWakeFanout.end}: a shutdown that
      // released the connection and then had a timer re-open it is not a release.
      retryTimers.add(retry);

      let gone = false;
      return () => {
        if (gone) return;                       // idempotent, exactly as subscribe()'s
        gone = true;
        clearInterval(retry);
        retryTimers.delete(retry);
        allSubs.delete(onWake);
        total = Math.max(0, total - 1);
        if (total === 0) scheduleIdleClose();
      };
    },
    /**
     * The prompt release for a long-running host's shutdown. Idempotent. Every automatic re-dial
     * is disarmed FIRST: `teardown` nulls `listening` and does not touch `total` (shutting the
     * socket unsubscribes nobody), and that combination is what `ensureListening` reads as "no
     * LISTEN and someone wants one" — the `subscribeAll` retry's next tick re-opened a fresh
     * connection moments after `end()` closed one, even on a healthy hub. A caller must not need
     * to know shutdown ordering to get a release that lasts. The hub is deliberately NOT
     * poisoned: a later subscribe may re-dial and re-arm — "a subscribe arriving after `end()` is
     * harmless" stays true. Only the AUTOMATIC paths are stopped.
     */
    async end() {
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
      for (const t of retryTimers) clearInterval(t);
      retryTimers.clear();
      await teardown();
    },
  };
}
