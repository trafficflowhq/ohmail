import { createHash } from "node:crypto";
import { and, eq, gte, inArray, lte, notInArray, sql } from "drizzle-orm";
import { pushSubscriptions } from "@trafficflow/db/cloud";
import { CALENDAR_RECORD_KINDS, changeLog, type Tx } from "@trafficflow/db";
import {
  SsrfRefusal, pinnedHttpRequest, makePushEndpointGuard, nodeHostResolver,
  encryptWebPushBody, vapidIdentityFromEnv,
  type PushEndpointGuard, type VapidIdentity, type VapidFromEnv, type WebPushKeys,
} from "@trafficflow/core/net";

/**
 * Wakes carry no mail content. UnifiedPush keeps its original constant. A browser wake
 * seals an opaque digest of the registration's account and session family alongside the type.
 */
export const WAKE_BODY = '{"type":"wake"}';

function browserWakeBinding(accountId: string, familyId: string): string {
  return createHash("sha256").update(JSON.stringify([accountId, familyId])).digest("hex");
}

/** {@link WAKE_BODY}'s length in bytes — pinned separately so a same-length swap is still caught. */
export const WAKE_BODY_BYTES = 15;

/**
 * How long to sit on a wake before sending it. A mailbox that receives ten messages in one sync cycle
 * emits ten `change_log` advances, and ten POSTs would tell the distributor operator the SHAPE of
 * somebody's morning even with an empty body — arrival timing is itself metadata. The device pulls
 * everything in one `/sync` regardless, so the ninth wake buys nothing. Two seconds: long enough to
 * swallow a batch, short enough that "new mail wakes my phone" stays true.
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
 * The statuses that mean THIS REGISTRATION IS DEAD and the row must go. 404 and 410 only, and the
 * narrowness is the point: a UnifiedPush endpoint is deleted when the user removes the distributor,
 * uninstalls, or the distributor rotates its topic, and those are the codes an HTTP resource uses for
 * "gone". Everything else is a bad moment — a 429 throttle, a 5xx outage, a socket error — and pruning
 * on those would delete a working registration during an incident. Prune what is provably gone, retry
 * everything else on the next wake, never count failures toward a deletion.
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
  /**
   * THE HANDLE OF THE ACCOUNT A WAKE IS FOR. Asked only after {@link ownsAccount} answered that the
   * account is this shard's (a wake's account is a hint until then), once per wake: the account's
   * registrations are read, a dead one deleted, and `change_log` asked one question per window ("is
   * there a record here that is not the calendar's") by the literal `1`, there and nowhere else.
   */
  dbOf: (accountId: string) => Tx;
  /** The change-wake hub. Every account's advances, one subscription — see `ChangeWakeFanout`. */
  source: WakeSource;
  /**
   * The endpoint policy. REQUIRED and not defaulted, for `HostResolver`'s standing reason: a
   * default would make the permit branch unreachable in a DNS-blocked test sandbox, so the branch
   * that actually dials would ship having never executed.
   */
  guard: PushEndpointGuard;
  /**
   * DOES THIS PROCESS OWN THIS ACCOUNT? REQUIRED, with no default. The hub's `subscribeAll` hears
   * EVERY account (it cannot enumerate accounts with a registered device up front), but a sharded
   * deployment runs one leader PER SHARD and each reaches this module — without a filter every shard
   * leader would POST to every registration (N duplicate wakes). `apps/worker/src/mailboxes.ts`'s
   * `accountInShard` is the predicate (the same one the cron backstops use), INJECTED to keep the db
   * surface narrow and REQUIRED because "own everything" is the wrong answer to get by forgetting: the
   * shipped config is one shard, so a default would be correct today and silently duplicating when
   * sharding turns on.
   */
  ownsAccount: (accountId: string) => Promise<boolean>;
  /**
   * THIS DEPLOYMENT'S VAPID IDENTITY, OR THE REASON IT HAS NONE. REQUIRED, no default — a defaulted
   * absence is the untested branch shipping. The discriminated `VapidFromEnv`, not a nullable identity,
   * because three answers are three behaviours: `configured` — keyed registrations sealed and signed,
   * keyless get the plaintext constant; `absent` — keyless runs, keyed SKIPPED (counted, warned once)
   * because a plaintext body to a connector expecting the encrypted profile is dropped on the device;
   * `invalid` — the operator configured something unusable, so this sender does not start at all
   * (falling back to keyless would hide that the configured thing does nothing). The worker keeps
   * running — mail sync is never held hostage — and the refusal is logged with the reason.
   */
  vapid: VapidFromEnv;
  log?: WakeLog;
  /** The POST, injectable so the e2e can watch a real request without a real distributor. */
  post?: PushWakePost;
  debounceMs?: number;
  minIntervalMs?: number;
  /** How long ONE POST may take, headers AND body. Injectable so a hostile-peer test is fast. */
  timeoutMs?: number;
  now?: () => number;
}

/**
 * The one network operation, as a port. `url`, `pin` and `keys` are the ONLY arguments, and the
 * signature is the census's first line of defence: no parameter here that a MESSAGE could be threaded
 * through. A body argument would be exactly that, which is why the constant is read from module scope
 * rather than passed in (and why an "opaque already-framed request" seam was rejected — a body
 * parameter in a hat). `keys` is not content: `p256dh` and `auth` are registration provenance, the same
 * class as the endpoint URL, and the census pins their SHAPE to those two fields; `null` means no keys
 * were offered and the plaintext constant goes out.
 */
export type PushWakePost = (
  url: string, pin: readonly string[], keys: WebPushKeys | null, binding?: string,
) => Promise<{ status: number }>;

export interface RunningPushWake {
  /** Unsubscribe from the hub and cancel every pending debounce. Idempotent. */
  stop(): void;
  /** Wakes POSTed with a 2xx, for `/health` and the tests. */
  sent(): number;
  /**
   * Wakes NOT sent because the registration offered keys and this deployment cannot seal to them.
   *
   * Separate from `sent()` because it is the ONLY signal that a VAPID misconfiguration exists. A
   * keyed registration on a deployment with no identity is not an error anywhere: the row is
   * valid, the endpoint is reachable, nothing is pruned, and the phone simply never rings. A
   * counter is what makes that visible from `/health` instead of from nowhere.
   */
  skipped(): number;
}

/**
 * The default POST: pinned to the addresses the guard cleared, redirects NOT followed, the response
 * body DESTROYED rather than read. A distributor answering `302 Location: http://169.254.169.254/`
 * would under a following client dial cloud metadata; `pinnedHttpRequest` is built on `http(s).request`
 * (follows nothing), so this holds by construction. The response is a HOSTILE input (the distributor
 * was chosen by whoever registered the endpoint): the first version ran `clearTimeout` in a `finally`
 * that fires at the HEADERS, so a slow-drip body held a socket open for ever — the timer now lives
 * until the response is DONE. It also lacked an `'error'` listener; a mid-body RST routes to the
 * `ClientRequest` (which has one) and is absorbed, but the local listener stays so the safety is local.
 * `destroy()`, not `resume()`: we want no bytes. */
function makeDefaultPost(
  opts: { signal: AbortSignal; timeoutMs: number; vapid: VapidIdentity | null },
): PushWakePost {
  const vapid = opts.vapid;
  return async function post(
    url: string, pin: readonly string[], keys: WebPushKeys | null, binding?: string,
  ): Promise<{ status: number }> {
    /**
     * SEAL, OR DO NOT — and the headers follow from that one decision. `sealed === null` is the
     * plaintext arm, byte-identical to what this sender has always put on the wire; otherwise the
     * constant is encrypted to the device's key and the request grows two headers (content coding and
     * the signature saying which server sent it). The `throw` is unreachable by construction — `fire`
     * skips a keyed row when there is no identity, which `skipped()` counts — and is here rather than a
     * non-null assertion because the alternative bug is silently sending plaintext to a device that
     * discards it (a delivery that is not one); a throw is caught and retried, a silent discard is forever.
     */
    let sealed: Buffer | null = null;
    let sealedHeaders: Record<string, string> = {};
    if (keys !== null) {
      if (vapid === null) throw new Error("cannot seal a wake without a VAPID identity");
      const payload = binding === undefined ? WAKE_BODY : `{"type":"wake","binding":"${binding}"}`;
      sealed = encryptWebPushBody(payload, keys);
      sealedHeaders = {
        "content-encoding": "aes128gcm",
        // RFC 8292. The audience is derived from THIS url's origin inside `authorizationFor`, so a
        // token is never replayable at a different distributor.
        "authorization": vapid.authorizationFor(url),
      };
    }

    // TWO reasons to abort, one signal: this request's own deadline, and the sender being stopped
    // (a lost leader lock must not leave a POST in flight that its successor is also making).
    const ac = new AbortController();
    const onStop = (): void => { ac.abort(); };
    if (opts.signal.aborted) ac.abort();
    else opts.signal.addEventListener("abort", onStop, { once: true });
    const timer = setTimeout(() => { ac.abort(); }, opts.timeoutMs);
    (timer as unknown as { unref?: () => void }).unref?.();
    try {
      const res = await pinnedHttpRequest(url, {
        method: "POST",
        pin,
        headers: {
          "content-type": sealed === null ? "application/json" : "application/octet-stream",
          "content-length": String(sealed === null ? WAKE_BODY_BYTES : sealed.length),
          // RFC 8030's TTL. Four minutes: a wake that could not be delivered while the phone was
          // offline is worth nothing once the phone comes back and syncs on its own. A constant,
          // like everything else on this request.
          "ttl": "240",
          ...sealedHeaders,
        },
        body: sealed ?? WAKE_BODY,
        signal: ac.signal,
      });
      // ORDER IS LOAD-BEARING. The listener goes on before the destroy, because `destroy()` can
      // itself surface a pending socket error, and an `IncomingMessage` that emits `'error'` with
      // no listener takes the process down.
      res.stream.on("error", () => {
        // A body we are not reading faulted. There is nothing to report and nothing to retry: the
        // status line was already the whole answer.
      });
      res.stream.destroy();
      return { status: res.status };
    } finally {
      clearTimeout(timer);
      opts.signal.removeEventListener("abort", onStop);
    }
  };
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
 * Read this deployment's VAPID identity from the worker's environment.
 *
 * Re-exported through this module rather than imported straight from core by the composition root,
 * for `pushEndpointGuardFromEnv`'s reason: the variables the wake sender reads are named in ONE
 * place, so "what does the organizer need in its environment for wakes to work" has one answer a
 * reader can find. `TF_VAPID_PRIVATE_KEY` is read HERE and nowhere else in the product — the API
 * holds only the public half, because nothing a request handler does needs the ability to sign.
 */
export function vapidFromEnv(env: NodeJS.ProcessEnv = process.env): VapidFromEnv {
  return vapidIdentityFromEnv(env);
}

/**
 * Start the sender. Returns immediately; everything after is the hub's callback. FAILURE IS ALWAYS
 * DEGRADATION, NEVER A CRASH: this runs inside the always-on worker beside the sync loop, so an
 * unhandled rejection is an outage of the whole organizer for a nice-to-have latency improvement (the
 * device polls on foreground regardless). Every path is wrapped — the hub callback cannot throw, the
 * debounce timer's body cannot throw, the query cannot throw out, and one endpoint's failure cannot
 * stop the one beside it. A wake that does not go out is unnoticed; a worker that dies takes
 * everybody's mail with it.
 */
export function startPushWake(deps: PushWakeDeps): RunningPushWake {
  const { dbOf, source, guard, ownsAccount, log } = deps;
  const debounceMs = deps.debounceMs ?? WAKE_DEBOUNCE_MS;
  const minIntervalMs = deps.minIntervalMs ?? WAKE_MIN_INTERVAL_MS;
  const timeoutMs = deps.timeoutMs ?? WAKE_TIMEOUT_MS;
  const now = deps.now ?? Date.now;

  /**
   * AN UNUSABLE VAPID CONFIGURATION STOPS THE SENDER HERE, BEFORE IT SUBSCRIBES TO ANYTHING. Not a
   * degraded mode, and the one place this module deliberately does LESS than it could on a failure:
   * the keyless arm would still work, so an operator watching their own `ntfy` topic would see wakes
   * and conclude the feature is fine while every phone they care about gets nothing. A half-working
   * feature is worse than an off one when the working half is the half nobody tests with. The worker
   * is untouched — this returns an inert handle, mail keeps syncing, and the reason is in the log with
   * no key material in it.
   */
  if (deps.vapid.kind === "invalid") {
    /**
     * ONE `reason` STRING, with the specific cause folded in — not a second `why` field. The logger
     * applies an allow-list to field NAMES and silently drops the rest as `droppedFields`; `why` is not
     * on the list, so a `{ why, reason }` pair loses the half that says WHICH misconfiguration this is.
     * Measured on the first managed deploy: `push_wake_started` shipped `vapid` and `encryptedWakes`
     * and logged `droppedFields=["vapid","encryptedWakes"]`. Folding rather than widening the list is
     * deliberate (`log.ts` argues a per-caller widening stops it being enumerable), and `reason` already
     * exists for a sentence an operator can act on.
     */
    log?.warn("push_wake_vapid_invalid", {
      state: deps.vapid.kind,
      reason: `${deps.vapid.why} — so NO wakes are sent, including the unencrypted ones. That is `
        + "deliberate: a broken configuration must not be hidden by the arm that still works. "
        + "Devices still sync on foreground and pull-to-refresh.",
    });
    return { stop(): void { /* nothing was ever started */ }, sent: () => 0, skipped: () => 0 };
  }
  const vapid = deps.vapid.kind === "configured" ? deps.vapid.identity : null;

  /**
   * ONE ABORT FOR THE WHOLE SENDER, aborted by {@link stop}.
   *
   * It exists so that losing the leader lock actually stops the traffic rather than only stopping
   * the scheduling of it. Without it, a `stop()` that arrived while a POST was on the wire left
   * that POST to finish beside the successor's own — and, worse, left the REST of that account's
   * rows to be dialled one by one by a worker that is no longer the leader.
   */
  const stopping = new AbortController();
  const post = deps.post ?? makeDefaultPost({ signal: stopping.signal, timeoutMs, vapid });

  /**
   * One pending window per account: its timer, and the lowest and the highest seq the hub named in
   * it. Two numbers, used once to bound the deciding read in {@link fire}, never sent and never logged.
   */
  const pending = new Map<string, { timer: ReturnType<typeof setTimeout>; lowest: bigint; highest: bigint }>();
  /** Last successful POST per endpoint URL, for {@link WAKE_MIN_INTERVAL_MS}. */
  const lastSentAt = new Map<string, number>();
  let sentCount = 0;
  let skippedCount = 0;
  let stopped = false;
  /**
   * The "we cannot seal for this device" warning is said ONCE per sender, not once per row.
   *
   * The same argument the per-failure logging refusal below makes: a deployment with no identity
   * and fifty keyed registrations would otherwise write fifty lines every time any of those
   * accounts received mail, which is an incident-shaped volume for a static configuration fact.
   * The COUNTER is the per-occurrence signal; the log line exists to say the reason once.
   */
  let warnedNoVapid = false;

  /** Dial only the wake's account, keeping the session family and endpoint from the same row snapshot. */
  const fire = async (accountId: string, lowest: bigint, highest: bigint): Promise<void> => {
    /**
     * IS THIS ACCOUNT OURS? Asked before the query, not after.
     *
     * `subscribeAll` is deliberately global — the sender cannot know in advance which accounts
     * have a device registered. A SHARDED deployment therefore has every shard leader hearing
     * every account, and without this check each of them would POST to the same registrations:
     * one duplicate wake per shard. On the shipped single-shard configuration this answers `true`
     * without touching the database, so it costs nothing today and is correct the day it matters.
     */
    if (!await ownsAccount(accountId)) return;
    if (stopped) return;
    // The wake's account is the shard's own now: its handle, for its read and its prune.
    const db = dbOf(accountId);

    const rows = await db.select({
      id: pushSubscriptions.id,
      endpoint: pushSubscriptions.endpoint,
      p256dh: pushSubscriptions.p256dh,
      auth: pushSubscriptions.auth,
      transport: pushSubscriptions.transport,
      familyId: pushSubscriptions.sessionFamilyId,
    }).from(pushSubscriptions).where(and(
      eq(pushSubscriptions.accountId, accountId),
      /**
       * BOTH WEB-PUSH-SHAPED TRANSPORTS, and `apns` deliberately absent. This read `unifiedpush` alone
       * while the phone was the only client that could receive a wake. A browser registration has
       * always been storable — `POST /push/subscriptions` validates and writes `webpush` rows with
       * `endpoint`, `p256dh`, `auth` — but nothing dialled them. Widening the predicate is the whole
       * fix; the sender needed no change because a `webpush` row carries both key columns and takes the
       * SEALED arm. `apns` stays out and its absence is load-bearing: an Apple device token is not an
       * endpoint URL, so it cannot be POSTed to, and it is refused by omission until that sender exists.
       */
      inArray(pushSubscriptions.transport, ["unifiedpush", "webpush"]),
    ));
    if (rows.length === 0) return;

    /**
     * DID THIS WINDOW HOLD ANYTHING BUT THE CALENDAR'S RECORDS? Asked once, after the registrations
     * are read and only when there are any. A closed app draws its one fixed notice for a wake, and
     * that notice says new mail: a calendar that moved must not ring it, so a window of calendar
     * records alone dials nothing, and the device finds the change when it next syncs. The answer is
     * the literal `1` or no row: no column of the log is read. The kinds are the calendar's own list,
     * which does not compile while a kind of the wire's union is missing from it. Bounded by the
     * window's two seqs: a batch names its highest, and the calendar's writers record their kinds in
     * batches of their own.
     */
    const held = await db.select({ one: sql<number>`1` }).from(changeLog).where(and(
      eq(changeLog.accountId, accountId),
      gte(changeLog.seq, lowest),
      lte(changeLog.seq, highest),
      notInArray(changeLog.entityType, [...CALENDAR_RECORD_KINDS]),
    )).limit(1);
    if (held.length === 0) return;

    for (const row of rows) {
      /**
       * RE-CHECKED EVERY ROW, and this is the half a `stop()` used to miss.
       *
       * Losing the leader lock mid-pass used to cancel only the pending timers. An account with
       * three registrations was then dialled row by row by a worker whose successor was doing the
       * same thing — the duplicate-wake shape, arrived at from the other direction. The loop asks
       * again before each dial, and the shared abort above cuts the one already on the wire.
       */
      if (stopped) return;

      const binding = row.transport === "webpush" && row.familyId
        ? browserWakeBinding(accountId, row.familyId)
        : undefined;
      const url = row.endpoint;
      if (!url) continue;                        // a unifiedpush row with no endpoint is unusable

      const last = lastSentAt.get(url);
      if (last !== undefined && now() - last < minIntervalMs) continue;   // per-endpoint floor

      /**
       * DID THIS DEVICE ASK TO BE SEALED TO? BOTH COLUMNS OR NEITHER.
       *
       * A UnifiedPush connector hands the app `{url, pubKey, auth}` together or not at all, so one
       * column without the other is not a half-capable device — it is a corrupt row, and treating
       * it as keyed would throw inside the encryptor on every wake for ever. Treating it as keyless
       * is the safe reading: a raw consumer gets the plaintext constant, which is exactly what a
       * row with no keys is.
       */
      const keys: WebPushKeys | null = row.p256dh !== null && row.auth !== null
        ? { p256dh: row.p256dh, auth: row.auth }
        : null;
      if (row.transport === "webpush" && (binding === undefined || keys === null)) continue;

      /**
       * A KEYED REGISTRATION ON A DEPLOYMENT THAT CANNOT SEAL IS SKIPPED, NOT DOWNGRADED.
       *
       * Sending the plaintext constant here would look like a delivery and be a discard: the
       * distributor answers 2xx, `sent()` goes up, and the connector on the phone drops the body it
       * cannot decrypt. Nothing on the wire would ever say so. So it is counted instead — the
       * counter is the only place a VAPID misconfiguration is visible — and the row is left alone,
       * because it becomes deliverable the moment an operator sets the keypair.
       */
      if (keys !== null && vapid === null) {
        skippedCount += 1;
        if (!warnedNoVapid) {
          warnedNoVapid = true;
          log?.warn("push_wake_vapid_unconfigured", {
            reason: "a device registered for encrypted wakes and this deployment has no VAPID "
              + "keypair, so those wakes are skipped rather than sent in a form the phone would "
              + "discard. Set TF_VAPID_PUBLIC_KEY and TF_VAPID_PRIVATE_KEY on the organizer, and "
              + "the public key on the api, to turn them on. Devices still sync on foreground.",
          });
        }
        continue;
      }

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
        ({ status } = await (binding === undefined ? post(url, pin, keys) : post(url, pin, keys, binding)));
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
            row.transport === "webpush" && row.familyId
              ? eq(pushSubscriptions.sessionFamilyId, row.familyId)
              : undefined,
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

  const unsubscribe = source.subscribeAll((accountId, seq) => {
    // `seq` is a per-account activity counter. It is kept as the window's two bounds and handed to
    // the deciding read alone: it reaches no request and no log line. The wake stays "something
    // changed", full stop.
    if (stopped) return;
    const open = pending.get(accountId);
    if (open !== undefined) {                     // already coalescing this account's window
      if (seq < open.lowest) open.lowest = seq;
      if (seq > open.highest) open.highest = seq;
      return;
    }

    const timer = setTimeout(() => {
      pending.delete(accountId);
      if (stopped) return;
      // `void` + a terminal catch: nothing awaits this, so an escaped rejection would be an
      // unhandled rejection inside the always-on worker. See the header — degradation, never a crash.
      void fire(accountId, window.lowest, window.highest).catch((err: unknown) => {
        log?.warn("push_wake_pass_failed", { err });
      });
    }, debounceMs);
    (timer as unknown as { unref?: () => void }).unref?.();
    const window = { timer, lowest: seq, highest: seq };
    pending.set(accountId, window);
  });

  return {
    stop(): void {
      if (stopped) return;
      stopped = true;
      unsubscribe();
      for (const open of pending.values()) clearTimeout(open.timer);
      pending.clear();
      // The socket, not just the schedule. A POST already on the wire is cut here; `fire`'s
      // per-row check stops the ones that had not started.
      stopping.abort();
    },
    sent(): number {
      return sentCount;
    },
    skipped(): number {
      return skippedCount;
    },
  };
}
