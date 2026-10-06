import { eq, sql } from "drizzle-orm";
import { changeLog, sessions } from "@trafficflow/db";
import type { Db } from "@trafficflow/services/mail";
import { DEFAULT_SSE } from "../deps.js";
import { errorResponse } from "../responses.js";
import { sseDisabledResponse } from "./sse-disabled.js";
import type { Route } from "../router.js";

/**
 * ONE discrete statement per read (no transaction, no LISTEN, no connection held between reads):
 * the account's highest `change_log` seq, and whether the session the stream was admitted on is
 * still live. Live is the row being present, this account's, with `revoked_at` null — never
 * `access_expires_at`: a refresh rotation updates this same row, and an expiry check would cut
 * every stream at the access TTL. Anything but a boolean `true` reads as not live.
 */
async function readSeqAndSession(
  db: Db, accountId: string, sessionId: string,
): Promise<{ seq: bigint; live: boolean }> {
  const rows = await db.select({
    max: sql<string | null>`max(${changeLog.seq})`,
    live: sql<boolean>`exists (select 1 from ${sessions} where ${sessions.id} = ${sessionId} and ${sessions.accountId} = ${accountId} and ${sessions.revokedAt} is null)`,
  }).from(changeLog).where(eq(changeLog.accountId, accountId));
  const m = rows[0]?.max;
  return { seq: m == null ? 0n : BigInt(m), live: rows[0]?.live === true };
}

/**
 * The reconnect hint after a FAILED read. A clean close makes the browser re-dial on the last
 * `retry:` it was given, and the opening 3 s hint turned a database episode into a new invocation
 * and a baseline read every 3 s per stream; the `/sync` poll the stream replaces backs off to 60 s.
 */
const RETRY_AFTER_FAILURE = "retry: 30000\n\n";

/**
 * LIVE STREAM COUNTERS, per warm instance.
 *
 * Module scope on purpose: this is the only cheap place a serverless host can count its own
 * concurrent streams. It is honestly a PER-INSTANCE bound, not a global one — N warm
 * instances admit N × the cap — so it is a blast-radius limiter, not a quota. The real cost
 * control is `sse.enabled === false` (the beta default); these caps exist so that turning SSE
 * on cannot be turned into an unbounded invocation bill by a single looping client.
 */
const liveByAccount = new Map<string, number>();
let liveTotal = 0;

const openStream = (accountId: string): void => {
  liveByAccount.set(accountId, (liveByAccount.get(accountId) ?? 0) + 1);
  liveTotal += 1;
};
const closeStream = (accountId: string): void => {
  const n = (liveByAccount.get(accountId) ?? 1) - 1;
  if (n <= 0) liveByAccount.delete(accountId);
  else liveByAccount.set(accountId, n);
  liveTotal = Math.max(0, liveTotal - 1);
};

/** Test seam: forget the counters (a leaked count would poison later assertions). */
export function resetSseCounters(): void {
  liveByAccount.clear();
  liveTotal = 0;
}

/** Observability seam for tests and the cap assertions. */
export function sseLiveCounts(): { total: number; byAccount: Record<string, number> } {
  return { total: liveTotal, byAccount: Object.fromEntries(liveByAccount) };
}

/**
 * Bounded SSE (raw): a `: ping` heartbeat and a content-free `event: sync` wake when the account's
 * max seq advances — the client pulls `GET /sync?since=cursor`; SSE is lossy by design. It ends at
 * a bounded lifetime, or at the first read that finds its session revoked or deleted. Push —
 * `deps.changeWake`, one session-mode LISTEN per instance (a transaction-mode pooler lands a LISTEN
 * on a backend the next statement has left); poll — always, the floor: a dead LISTEN degrades
 * latency to `pollMs`, nothing else. `sse.enabled === false` ⇒ 503 `sse_disabled` (a client-bundle
 * flag is not a control). `maxPerAccount` 429, `maxPerInstance` 503. One serialized, caught poll
 * loop (`setInterval` overlaps under load); a slow client is dropped at SSE_MAX_BUFFERED_FRAMES.
 */

/**
 * How many enqueued-but-unread frames a stream may hold before it is closed as unread. Frames
 * here are tiny (a ping, a `{"seq":n}`), so this is about a CONSUMER that has stopped reading,
 * not about volume: 32 frames is minutes of heartbeats or a burst of wakes nobody is draining.
 */
export const SSE_MAX_BUFFERED_FRAMES = 32;
export const eventsRoutes: Route[] = [
  {
    method: "GET",
    pattern: "/events",
    relay: true,
    // `connection`: on a per-invocation-second platform an open stream is a LIVE FUNCTION
    // for its whole lifetime, with a poll loop querying `change_log` behind it, and the client
    // reconnects forever. The `enabled`/`maxPerAccount`/`maxPerInstance` controls below are
    // per-instance blast-radius limits; the class is what keeps an unproven account off it.
    // Being `raw` used to mean this route could not be gated AT ALL — see RAW_PIPELINE.
    cost: "connection",
    options: { raw: true },   // reduced pipeline: no JSON envelope / CSRF / idempotency
    handler: async (_req, deps) => {
      const { accountId, sessionId } = deps.session!;   // raw pipeline still runs withSession (401 if none)
      const cfg = { ...DEFAULT_SSE, ...(deps.sse ?? {}) };
      const enc = new TextEncoder();

      if (cfg.enabled === false) return sseDisabledResponse();
      if (cfg.maxPerInstance != null && liveTotal >= cfg.maxPerInstance) {
        return errorResponse("sse_capacity", 503, "too many open event streams on this instance; poll GET /sync");
      }
      if (cfg.maxPerAccount != null && (liveByAccount.get(accountId) ?? 0) >= cfg.maxPerAccount) {
        return errorResponse("sse_too_many_streams", 429, "too many open event streams for this account");
      }

      let closed = false;
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      let lifetime: ReturnType<typeof setTimeout> | undefined;
      let wake: (() => void) | undefined;          // resolves the poll loop's sleep early
      let counted = false;
      /** The hub unsubscribe, once subscribed. Idempotent by the hub's contract. */
      let unhook: (() => void) | null = null;

      const stop = (): void => {
        if (heartbeat) clearInterval(heartbeat);
        if (lifetime) clearTimeout(lifetime);
        heartbeat = undefined;
        lifetime = undefined;
        unhook?.();                                 // stop receiving pushed wakes at once
        unhook = null;
        wake?.();                                   // let the loop observe `closed` at once
        if (counted) { closeStream(accountId); counted = false; }
      };

      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          openStream(accountId);
          counted = true;

          const send = (s: string): void => {
            if (closed) return;
            // A consumer that has stopped reading must be DROPPED, not buffered for: `enqueue`
            // never blocks, so without this bound a pushed stream to a stalled client is
            // unbounded memory held by this instance. `desiredSize` goes negative by exactly
            // the number of unread frames past the high-water mark.
            if (controller.desiredSize !== null && controller.desiredSize <= -SSE_MAX_BUFFERED_FRAMES) {
              finish();
              return;
            }
            try { controller.enqueue(enc.encode(s)); } catch { closed = true; /* a gone subscriber; the flag ends the loop */ }
          };
          const finish = (): void => {
            closed = true;
            stop();
            try { controller.close(); } catch { /* already closed */ }
          };

          send("retry: 3000\n\n");                       // EventSource reconnect hint
          let lastSeq: bigint;
          try {
            const first = await readSeqAndSession(deps.db, accountId, sessionId);
            if (!first.live) { finish(); return; }
            lastSeq = first.seq;                          // don't replay backlog: start at current max
          } catch {
            send(RETRY_AFTER_FAILURE);
            send("event: sync_failed\ndata: {}\n\n");
            finish();
            return;
          }

          /**
           * THE PUSHED WAKE. Subscribed AFTER the first read on purpose: a commit landing in
           * the gap between the read and the subscription is missed here and caught by the poll
           * — the benign direction. The other order would deliver a wake into an uninitialized
           * `lastSeq`. Wrapped in a catch even though the hub's contract says it never throws,
           * because the hub is a HINT and a hint must not be able to kill the stream it hints at.
           * The seq comes from the NOTIFY payload, so a pushed frame costs zero DB reads; its
           * session is the poll's to recheck, which is the floor: within `pollMs` either way.
           */
          try {
            unhook = deps.changeWake?.subscribe(accountId, (seq) => {
              if (closed) return;
              if (seq > lastSeq) {
                lastSeq = seq;
                send(`event: sync\ndata: {"seq":${seq}}\n\n`);
              }
            }) ?? null;
          } catch {
            unhook = null;                       // push is unavailable; the poll carries the stream
          }

          heartbeat = setInterval(() => send(": ping\n\n"), cfg.heartbeatMs);
          lifetime = setTimeout(finish, cfg.lifetimeMs);

          // The serialized poll loop. Deliberately not awaited by `start` (the Response has to
          // be returned immediately), but each iteration awaits the previous one, so at most
          // one query per stream is ever in flight.
          void (async () => {
            while (!closed) {
              await new Promise<void>((resolve) => {
                const timer = setTimeout(resolve, cfg.pollMs);
                // Early wake clears the timer, so a closed stream does not hold the event loop
                // open for a whole poll interval.
                wake = () => { clearTimeout(timer); resolve(); };
              });
              if (closed) return;
              try {
                const t = await readSeqAndSession(deps.db, accountId, sessionId);
                if (!t.live) { finish(); return; }        // the session ended: so does its stream
                if (t.seq > lastSeq) { lastSeq = t.seq; send(`event: sync\ndata: {"seq":${t.seq}}\n\n`); }
              } catch {
                send(RETRY_AFTER_FAILURE);
                send("event: sync_failed\ndata: {}\n\n");
                finish();
                return;
              }
            }
          })();
        },
        cancel() { closed = true; stop(); },
      });

      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
        },
      });
    },
  },
];
