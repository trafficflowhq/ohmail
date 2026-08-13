import { eq, sql } from "drizzle-orm";
import { changeLog } from "@trafficflow/db";
import type { Db } from "@trafficflow/services/mail";
import { DEFAULT_SSE } from "../deps.js";
import { errorResponse } from "../responses.js";
import type { Route } from "../router.js";

/**
 * The account's highest `change_log` seq via a DISCRETE query (borrow-and-release,
 * no open transaction, no LISTEN). That is the whole primitive: the poll holds NO DB
 * connection between iterations, so an open `/events` tab never pins a pooled conn.
 */
async function maxSeq(db: Db, accountId: string): Promise<bigint> {
  const rows = await db.select({ max: sql<string | null>`max(${changeLog.seq})` })
    .from(changeLog).where(eq(changeLog.accountId, accountId));
  const m = rows[0]?.max;
  return m == null ? 0n : BigInt(m);
}

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
 * §4.1 / §5 — bounded SSE (RAW route). Emits a `: ping` heartbeat, and a
 * content-free `event: sync` wake whenever this account's change_log max seq advances (the
 * client then pulls `GET /sync?since=cursor` — SSE is lossy by design, so a frame need not
 * carry entities). Server-closes after a bounded lifetime; `EventSource` reconnects on the
 * `retry:` hint. All durations are injectable via `deps.sse` (DEFAULT_SSE in prod; tiny
 * values in tests).
 *
 * ## Two wake sources, one stream
 *
 * **PUSH — `deps.changeWake`, when the host has one.** `recordChanges` NOTIFYs
 * `ohmail_change_log` at commit from every writer (worker ingest, record-at-send, screener,
 * triage), the host's per-instance LISTEN connection receives it, and the hub fans it out to
 * this instance's streams by account. A wake whose seq is ahead of `lastSeq` emits the same
 * `event: sync` frame the poll would — within milliseconds of the commit instead of within
 * `pollMs`. The hub cannot exist on the request connection: a hosted deployment reaches its
 * database through a TRANSACTION-mode pooler, which multiplexes statements across backends, so
 * a LISTEN there lands on a backend the next statement has already left. The host holds ONE
 * session-mode connection per instance for it, fanned out in process to that instance's streams.
 *
 * **POLL — always.** The serialized loop below is the reliability floor, not a fallback mode:
 * it runs with and without the hub, so a dead LISTEN degrades latency to `pollMs` and changes
 * nothing else. Push is a hint; it is never load-bearing.
 *
 * ## Three cost/robustness properties
 *
 * **1. It is OFF unless the SERVER says otherwise.** `sse.enabled === false` ⇒ 503
 * `sse_disabled`. SSE is behind a flag, but a flag in the CLIENT bundle is not a
 * control: anyone can open `/events` directly, and every open stream is a function running
 * for its whole lifetime and reconnecting forever. The switch has to be server-side to mean
 * anything. 503 rather than 404 because `EventSource` treats a non-200 as terminal and stops
 * reconnecting, so a client built with the flag on backs off instead of hammering.
 *
 * **2. Bounded concurrency.** `maxPerAccount` (429) and `maxPerInstance` (503) refuse to open
 * stream N+1. Without them one authenticated account could hold an unbounded number of
 * 30-second invocations — denial of WALLET, which no auth check catches because every request
 * is perfectly legitimate.
 *
 * **3. ONE serialized, caught poll loop — not `setInterval`.** `setInterval` fires on a
 * schedule regardless of whether the previous poll finished: when DB latency exceeds `pollMs`
 * (a pooler under load — exactly when this matters) the polls OVERLAP and one slow account
 * multiplies its own query rate. And the interval callback's promise carried no `catch`, so a
 * rejected poll became an unhandled rejection. The loop below awaits its own query, THEN waits
 * `pollMs`, so there is never more than one poll in flight; a failed poll emits `sync_failed`
 * and closes, and the client reconnects — a closed stream that reconnects is honest, a
 * silently dead stream is not.
 *
 * **And a fourth, for the push path: a slow client is DROPPED, never waited on.** `enqueue`
 * on a Web stream never blocks — it buffers — so a client that stops reading turns a pushed
 * stream into unbounded server-side memory. When the buffer is {@link SSE_MAX_BUFFERED_FRAMES}
 * frames behind, the stream closes; `EventSource` reconnects and starts clean. The lifetime
 * already bounded the poll-only worst case; wakes can burst, so the bound is explicit now.
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
    // `connection`: on a per-invocation-second platform an open stream is a LIVE FUNCTION
    // for its whole lifetime, with a poll loop querying `change_log` behind it, and the client
    // reconnects forever. The `enabled`/`maxPerAccount`/`maxPerInstance` controls below are
    // per-instance blast-radius limits; the class is what keeps an unproven account off it.
    // Being `raw` used to mean this route could not be gated AT ALL — see RAW_PIPELINE.
    cost: "connection",
    options: { raw: true },   // reduced pipeline: no JSON envelope / CSRF / idempotency
    handler: async (_req, deps) => {
      const accountId = deps.session!.accountId;   // raw pipeline still runs withSession (401 if none)
      const cfg = { ...DEFAULT_SSE, ...(deps.sse ?? {}) };
      const enc = new TextEncoder();

      if (cfg.enabled === false) {
        return errorResponse("sse_disabled", 503, "server-sent events are disabled on this deployment; poll GET /sync");
      }
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
            try { controller.enqueue(enc.encode(s)); } catch { closed = true; }
          };
          const finish = (): void => {
            closed = true;
            stop();
            try { controller.close(); } catch { /* already closed */ }
          };

          send("retry: 3000\n\n");                       // EventSource reconnect hint
          let lastSeq: bigint;
          try {
            lastSeq = await maxSeq(deps.db, accountId);   // don't replay backlog: start at current max
          } catch {
            send("event: sync_failed\ndata: {}\n\n");
            finish();
            return;
          }

          /**
           * THE PUSHED WAKE. Subscribed AFTER the `maxSeq` read on purpose: a commit landing in
           * the gap between the read and the subscription is missed here and caught by the poll
           * — the benign direction. The other order would deliver a wake into an uninitialized
           * `lastSeq`. Wrapped in a catch even though the hub's contract says it never throws,
           * because the hub is a HINT and a hint must not be able to kill the stream it hints at.
           * The seq comes from the NOTIFY payload, so a pushed frame costs zero DB reads.
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
                const m = await maxSeq(deps.db, accountId);
                if (m > lastSeq) { lastSeq = m; send(`event: sync\ndata: {"seq":${m}}\n\n`); }
              } catch {
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
