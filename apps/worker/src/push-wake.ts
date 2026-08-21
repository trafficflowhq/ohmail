import { and, eq } from "drizzle-orm";
import { pushSubscriptions } from "@trafficflow/db/cloud";
import type { Tx } from "@trafficflow/db";
import {
  SsrfRefusal, pinnedHttpRequest, makePushEndpointGuard, nodeHostResolver,
  type PushEndpointGuard,
} from "@trafficflow/core/net";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  THE WAKE SENDER — a content-free "something changed", and NOTHING ELSE, ever
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * `push_subscriptions` has existed for months with no sender anywhere. This is the sender, for the
 * `unifiedpush` transport only: when an account's `change_log` advances, POST a CONSTANT to every
 * UnifiedPush endpoint that account registered. The device then does what it would have done on a
 * foreground open — pull from `/sync` — and gets its mail from us over its own authenticated
 * connection.
 *
 * ── THE PAYLOAD IS A CLOSED CONSTANT. THIS IS THE INVARIANT, NOT A PREFERENCE. ────────────────
 *
 * {@link WAKE_BODY} is a module-level `const` with no interpolation, no template hole, no
 * parameter and no caller-supplied part. A wake travels through a third party's servers — the
 * distributor the user chose, which is very often somebody else's ntfy — so anything in the body
 * is a fact about a person's mail handed to an operator they have no relationship with. Not the
 * subject, not the sender, not a count, not "you have new mail in Ohbox": a COUNT is a fact, and
 * a folder name is a fact.
 *
 * What that rules out is written down here because it is the shape of every plausible future
 * regression: no argument to the POST derived from a message, a thread, a mailbox or an account;
 * no query string appended to the endpoint; no header carrying a value from the database. The
 * ONLY thing this module learns from the change-wake hub is `(accountId, seq)`, and the only
 * thing it does with the account id is SELECT the rows to dial — the id never reaches the wire.
 * `seq` is read and dropped: a sequence number is a per-account activity counter, and putting it
 * in the body would let a distributor operator count somebody's mail.
 *
 * The content-free census beside this app's other tests is the evidence, and it is watched red by
 * threading a subject through — not by reading this comment.
 *
 * ── WHAT IS *NOT* HERE, SO NOBODY READS THIS AS DONE ─────────────────────────────────────────
 *
 * The wake goes out UNENCRYPTED. UnifiedPush 3.x endpoints are Web Push endpoints and the spec
 * expects an RFC 8291 `aes128gcm` body under an RFC 8292 VAPID `Authorization`; a distributor
 * (ntfy, NextPush) forwards whatever bytes arrive either way, so a plaintext constant does reach
 * the device — but a CONNECTOR that implements the encrypted profile will fail to decrypt it. The
 * registration path already stores `p256dh`/`auth` when a connector offers them, so the encrypting
 * arm needs no migration and no re-registration; it needs a VAPID keypair and its own slice. This
 * module reads neither column, and it says so here rather than leaving the absence to be read as
 * an oversight.
 *
 * Desktop-host wake is not here either and is not owed: `push_subscriptions` is a cloud-half
 * table, so a desktop-host profile has nothing to register against. Foreground sync plus
 * pull-to-refresh is that arm's story and the copy says so.
 */

/**
 * THE WAKE. Byte-identical, forever, on every deployment.
 *
 * A `const` and not a function, and not `JSON.stringify({ type: "wake" })`: a stringify call is a
 * place a second key can be added by editing an object literal that reads like configuration,
 * whereas this is fifteen bytes that a diff shows changing. The census asserts the literal AND
 * its byte length, so widening it is not something a reviewer has to notice.
 */
export const WAKE_BODY = '{"type":"wake"}';

/** {@link WAKE_BODY}'s length in bytes — pinned separately so a same-length swap is still caught. */
export const WAKE_BODY_BYTES = 15;

/**
 * How long to sit on a wake before sending it.
 *
 * A mailbox that receives ten messages in one sync cycle emits ten `change_log` advances, and ten
 * POSTs would tell the distributor operator the SHAPE of somebody's morning even with an empty
 * body — arrival timing is itself metadata, which is the second reason to coalesce and the one
 * that is easy to forget. The first is ordinary: the device is going to pull everything in one
 * `/sync` regardless, so the ninth wake buys nothing and costs a request.
 *
 * Two seconds: long enough to swallow a batch, short enough that "new mail wakes my phone" is
 * still true rather than technically true.
 */
export const WAKE_DEBOUNCE_MS = 2_000;

/**
 * The per-ENDPOINT floor between two POSTs to the same URL.
 *
 * The debounce above is keyed by ACCOUNT, and that is not the same thing. One endpoint can be
 * registered by more than one account — a phone with two server profiles on the same host, which
 * is exactly what the mobile server-profile list makes ordinary — and then two accounts' wakes
 * arrive at one device with no coalescing between them. This floor is the per-endpoint half, and
 * it is what makes "a rapid second wake coalesces" true of the endpoint rather than of a bucket
 * the endpoint happens to be in.
 */
export const WAKE_MIN_INTERVAL_MS = 2_000;

/** How long one POST may take before it is abandoned. A distributor that hangs must not hold a slot. */
export const WAKE_TIMEOUT_MS = 8_000;

/**
 * The statuses that mean THIS REGISTRATION IS DEAD and the row must go.
 *
 * 404 and 410 only, and the narrowness is the point. A UnifiedPush endpoint is deleted when the
 * user removes the distributor, uninstalls the app, or the distributor rotates its topic — and
 * those are the two codes an HTTP resource uses to say "gone". Everything else is a bad moment:
 * a 429 is a distributor throttling us, a 5xx is a distributor having an outage, a socket error is
 * a network. Pruning on any of those would delete a working registration during an incident and
 * the user would have to re-register from Settings to get wakes back — a self-inflicted outage
 * with no error anyone can act on. So the rule is: prune what is provably gone, retry everything
 * else on the next wake, and never count failures toward a deletion.
 */
const DEAD_ENDPOINT_STATUS = new Set([404, 410]);

/** The logger shape this module needs. Structural so the worker's real logger just fits. */
interface WakeLog {
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
}

/** The change-wake hub half this module uses — declared structurally so `ChangeWakeFanout` fits. */
export interface WakeSource {
  subscribeAll(onWake: (accountId: string, seq: bigint) => void): () => void;
}

export interface PushWakeDeps {
  /** The worker's own db handle. Reads `push_subscriptions`, deletes dead rows, nothing else. */
  db: Tx;
  /** The change-wake hub. Every account's advances, one subscription — see `ChangeWakeFanout`. */
  source: WakeSource;
  /**
   * The endpoint policy. REQUIRED and not defaulted, for `HostResolver`'s standing reason: a
   * default would make the permit branch unreachable in a DNS-blocked test sandbox, so the branch
   * that actually dials would ship having never executed.
   */
  guard: PushEndpointGuard;
  log?: WakeLog;
  /** The POST, injectable so the e2e can watch a real request without a real distributor. */
  post?: PushWakePost;
  debounceMs?: number;
  minIntervalMs?: number;
  now?: () => number;
}

/**
 * The one network operation, as a port.
 *
 * `url` and `pin` are the ONLY arguments, and the signature is the census's first line of
 * defence: there is no parameter here that a message could be threaded through. A body argument
 * would be exactly such a parameter, which is why the constant is read from module scope by the
 * implementation rather than passed in.
 */
export type PushWakePost = (url: string, pin: readonly string[]) => Promise<{ status: number }>;

export interface RunningPushWake {
  /** Unsubscribe from the hub and cancel every pending debounce. Idempotent. */
  stop(): void;
  /** Wakes POSTed with a 2xx, for `/health` and the tests. */
  sent(): number;
}

/**
 * The default POST: pinned to the addresses the guard cleared, redirects NOT followed, response
 * body drained and discarded.
 *
 * Redirects matter more here than in most places. A distributor that answers `302 Location:
 * http://169.254.169.254/` would, under a following client, turn a cleared endpoint into a dial
 * at cloud metadata — the gate can only ever speak about the URL it was given. `pinnedHttpRequest`
 * is built on `http(s).request`, which follows nothing, so this holds by construction rather than
 * by remembering to pass an option.
 *
 * The body is drained rather than read: we have no use for whatever a distributor says, and an
 * undrained response holds the socket. Nothing about the response is logged except its status.
 */
async function defaultPost(url: string, pin: readonly string[]): Promise<{ status: number }> {
  const ac = new AbortController();
  const timer = setTimeout(() => { ac.abort(); }, WAKE_TIMEOUT_MS);
  (timer as unknown as { unref?: () => void }).unref?.();
  try {
    const res = await pinnedHttpRequest(url, {
      method: "POST",
      pin,
      headers: {
        "content-type": "application/json",
        "content-length": String(WAKE_BODY_BYTES),
        // RFC 8030's TTL. Four minutes: a wake that could not be delivered while the phone was
        // offline is worth nothing once the phone comes back and syncs on its own. A constant,
        // like everything else on this request.
        "ttl": "240",
      },
      body: WAKE_BODY,
      signal: ac.signal,
    });
    res.stream.resume();          // drain and release the socket; the body is of no interest
    return { status: res.status };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Build the endpoint policy from the worker's environment.
 *
 * `TF_PUSH_ALLOW_PRIVATE=1` — the same variable `apps/server` reads, deliberately, so the process
 * that VALIDATES a registration and the process that DIALS it cannot disagree about whether a LAN
 * endpoint is permitted. A registration accepted by one and refused by the other is a phone that
 * shows a working switch and never rings.
 */
export function pushEndpointGuardFromEnv(env: NodeJS.ProcessEnv = process.env): PushEndpointGuard {
  return makePushEndpointGuard(nodeHostResolver, {
    allowPrivate: (env.TF_PUSH_ALLOW_PRIVATE ?? "").trim() === "1",
  });
}

/**
 * Start the sender. Returns immediately; everything after that is the hub's callback.
 *
 * ── FAILURE IS ALWAYS DEGRADATION, NEVER A CRASH ─────────────────────────────────────────────
 *
 * This runs inside the always-on worker beside the sync loop, so an unhandled rejection here is
 * an outage of the whole organizer for a feature whose entire job is a nice-to-have latency
 * improvement — the device polls on foreground regardless. So every path is wrapped: the hub
 * callback cannot throw (the hub swallows it anyway, and relying on that would be relying on
 * somebody else's catch), the debounce timer's body cannot throw, the query cannot throw out, and
 * one endpoint's failure cannot stop the endpoint beside it. A wake that does not go out is a
 * wake nobody notices; a worker that dies takes everybody's mail with it.
 */
export function startPushWake(deps: PushWakeDeps): RunningPushWake {
  const { db, source, guard, log } = deps;
  const post = deps.post ?? defaultPost;
  const debounceMs = deps.debounceMs ?? WAKE_DEBOUNCE_MS;
  const minIntervalMs = deps.minIntervalMs ?? WAKE_MIN_INTERVAL_MS;
  const now = deps.now ?? Date.now;

  /** One pending debounce per account. The VALUE is a timer and nothing else — no payload. */
  const pending = new Map<string, ReturnType<typeof setTimeout>>();
  /** Last successful POST per endpoint URL, for {@link WAKE_MIN_INTERVAL_MS}. */
  const lastSentAt = new Map<string, number>();
  let sentCount = 0;
  let stopped = false;

  /**
   * Dial one account's endpoints.
   *
   * The account id is used ONCE — as the SELECT predicate — and never leaves this function. The
   * rows it reads are `{ id, endpoint }`: the projection is narrow on purpose, so that a future
   * edit which wants a message-derived value has to widen the SELECT, which the census sees.
   */
  const fire = async (accountId: string): Promise<void> => {
    const rows = await db.select({
      id: pushSubscriptions.id,
      endpoint: pushSubscriptions.endpoint,
    }).from(pushSubscriptions).where(and(
      eq(pushSubscriptions.accountId, accountId),
      eq(pushSubscriptions.transport, "unifiedpush"),
    ));

    for (const row of rows) {
      const url = row.endpoint;
      if (!url) continue;                        // a unifiedpush row with no endpoint is unusable

      const last = lastSentAt.get(url);
      if (last !== undefined && now() - last < minIntervalMs) continue;   // per-endpoint floor

      /**
       * THE GATE, AT SEND TIME, ON EVERY SEND — not once at registration.
       *
       * `guard.check` resolves the name NOW and returns the addresses the socket may use. A
       * registration cleared in January is being dialled today, and the same hostname can answer
       * differently: re-pointing a name at `169.254.169.254` after registration is the whole
       * attack, and it is the reason the return value is a pin rather than a boolean. A refusal
       * is NOT a reason to delete the row — the endpoint may be fine again tomorrow, and a gate
       * that pruned would let a transient DNS answer erase a working registration.
       */
      let pin: string[];
      try {
        pin = await guard.check(url);
      } catch (err) {
        // Logged WITHOUT the endpoint: the URL is a per-device identifier and this line goes to
        // the drain. The reason is the gate's own short `why`, which names a class, not a target.
        log?.warn("push_wake_endpoint_refused", {
          reason: err instanceof SsrfRefusal ? err.why : "unavailable",
        });
        continue;
      }

      let status: number;
      try {
        ({ status } = await post(url, pin));
      } catch {
        // A socket error, a timeout, an abort. Not evidence about the registration — retried on
        // the next wake. Deliberately not logged per failure: a distributor outage would otherwise
        // write one line per account per wake for the length of the incident.
        continue;
      }

      if (status >= 200 && status < 300) {
        lastSentAt.set(url, now());
        sentCount += 1;
        continue;
      }

      if (DEAD_ENDPOINT_STATUS.has(status)) {
        /**
         * PROVABLY GONE → the row goes. Scoped to the account AND the row id, so a prune can
         * never reach another account's registration even if two accounts share an endpoint
         * string: the row this loop read is the only row it may delete.
         */
        try {
          await db.delete(pushSubscriptions).where(and(
            eq(pushSubscriptions.id, row.id),
            eq(pushSubscriptions.accountId, accountId),
          ));
          lastSentAt.delete(url);
          log?.info("push_wake_endpoint_pruned", { status });
        } catch {
          // The row stays and is retried; a failed delete is not worth an incident line.
        }
      }
      // Everything else (429, 5xx, an unexpected 4xx) is left alone — see DEAD_ENDPOINT_STATUS.
    }
  };

  const unsubscribe = source.subscribeAll((accountId) => {
    // `seq` IS DELIBERATELY NOT DESTRUCTURED. It is a per-account activity counter and this
    // function has no use for one; the parameter is dropped at the boundary so there is nothing
    // in scope for a later edit to reach for. The wake is "something changed", full stop.
    if (stopped) return;
    if (pending.has(accountId)) return;          // already coalescing this account's window

    const timer = setTimeout(() => {
      pending.delete(accountId);
      if (stopped) return;
      // `void` + a terminal catch: nothing awaits this, so an escaped rejection would be an
      // unhandled rejection inside the always-on worker. See the header — degradation, never a crash.
      void fire(accountId).catch((err: unknown) => {
        log?.warn("push_wake_pass_failed", { err: String(err) });
      });
    }, debounceMs);
    (timer as unknown as { unref?: () => void }).unref?.();
    pending.set(accountId, timer);
  });

  return {
    stop(): void {
      if (stopped) return;
      stopped = true;
      unsubscribe();
      for (const t of pending.values()) clearTimeout(t);
      pending.clear();
    },
    sent(): number {
      return sentCount;
    },
  };
}
