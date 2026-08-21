import { and, eq } from "drizzle-orm";
import { pushSubscriptions } from "@trafficflow/db/cloud";
import type { Tx } from "@trafficflow/db";
import {
  SsrfRefusal, pinnedHttpRequest, makePushEndpointGuard, nodeHostResolver,
  encryptWebPushBody, vapidIdentityFromEnv,
  type PushEndpointGuard, type VapidIdentity, type VapidFromEnv, type WebPushKeys,
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
 * ── TWO WIRE FORMS FOR ONE PAYLOAD, CHOSEN BY WHAT THE DEVICE REGISTERED ─────────────────────
 *
 * UnifiedPush 3.x endpoints are Web Push endpoints, and a connector that implements the encrypted
 * profile renders ONLY an RFC 8291 `aes128gcm` body under an RFC 8292 VAPID `Authorization`. A
 * distributor forwards whatever bytes arrive either way, so a plaintext constant does reach the
 * device — and is then dropped by the connector, silently, with every status code on the path
 * saying 2xx. So this module sends whichever form the registration asked for:
 *
 *  · the row has `p256dh` AND `auth` → the constant is SEALED to that device's key and signed
 *    with this deployment's VAPID identity. Only the phone that registered can open it, and the
 *    signature is what tells the connector the wake came from the server it paired with rather
 *    than from anybody who learned the endpoint URL.
 *  · the row has neither → the constant goes as it always did, `application/json`, fifteen bytes.
 *    That arm is not legacy and is not deprecated: a raw consumer — an `ntfy` topic somebody
 *    watches directly, a script — is a supported way to use this, and it has no keys to seal to.
 *
 * **The PLAINTEXT is identical in both.** Encryption changes who can read the fifteen bytes, not
 * what they are, and the censuses are written to keep saying so: the ciphertext necessarily differs
 * per device and per message (a fresh salt and ephemeral key each time — reusing either would leak
 * the AES-GCM authentication key), so what they pin is the CONSTANT going in, the absence of any
 * message-derived input, and — since a signed token is the obvious place for one to hide — the
 * exact claim set of the VAPID JWT.
 *
 * ── WHAT IS *NOT* HERE, SO NOBODY READS THIS AS DONE ─────────────────────────────────────────
 *
 * A wake that arrives while the app's process is DEAD currently does nothing on the phone. The
 * connector's service starts, decrypts, finds no `id` field in the payload — because the payload is
 * `{"type":"wake"}` — and renders no notification, which is exactly what is wanted while the app is
 * alive (a wake is not a notification) and is a dead end when it is not. Closing that needs native
 * code on the device, not a change here. The app's copy says which of the two it does.
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
  /**
   * DOES THIS PROCESS OWN THIS ACCOUNT? REQUIRED, with no default.
   *
   * The hub's `subscribeAll` hears EVERY account, which is what the sender needs (it cannot
   * enumerate the accounts with a registered device up front — the set changes without it being
   * told). But a sharded deployment runs one leader PER SHARD, each under its own advisory lock,
   * and each of those leaders reaches this module. Without a filter every shard leader would POST
   * to every registration: N duplicate wakes per message, and a device with no way to tell which
   * instance is authoritative.
   *
   * `apps/worker/src/mailboxes.ts`'s `accountInShard` is the predicate, and it is the same one the
   * cron backstops already use to refuse work outside their own shard. It is INJECTED rather than
   * imported so this module keeps its narrow db surface, and it is REQUIRED rather than defaulted
   * because "own everything" is the wrong answer to get by forgetting: the shipped configuration
   * is one shard, so a default would be correct today and silently duplicating on the day sharding
   * is turned on.
   */
  ownsAccount: (accountId: string) => Promise<boolean>;
  /**
   * THIS DEPLOYMENT'S VAPID IDENTITY, OR THE REASON IT HAS NONE. REQUIRED, with no default.
   *
   * Required for `guard`'s and `ownsAccount`'s reason — a defaulted absence is the untested branch
   * shipping — and it is the discriminated `VapidFromEnv` rather than a nullable identity because
   * the three answers are three different behaviours and a nullable value cannot tell two of them
   * apart:
   *
   *  · `configured` — keyed registrations are sealed and signed; keyless ones still get the
   *    plaintext constant.
   *  · `absent` — the operator configured nothing. The keyless arm runs; keyed registrations are
   *    SKIPPED (counted, and warned about exactly once) because a plaintext body sent to a
   *    connector that expects the encrypted profile is dropped on the device with nothing on the
   *    wire to show it. Sending it anyway would look like a delivery and be a discard.
   *  · `invalid` — the operator configured SOMETHING and it is unusable: a truncated paste, a
   *    mismatched pair, one half of it. Then this sender does not start at all, and that is the
   *    point: if it fell back to the keyless arm, the wakes an operator could still see working
   *    would hide the fact that the thing they configured does nothing. A configuration error must
   *    not be masked by a partially working feature. The worker keeps running — mail syncing is
   *    never held hostage to this — and the refusal is logged with the reason.
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
 * The one network operation, as a port.
 *
 * `url`, `pin` and `keys` are the ONLY arguments, and the signature is the census's first line of
 * defence: there is no parameter here that a MESSAGE could be threaded through. A body argument
 * would be exactly such a parameter, which is why the constant is read from module scope by the
 * implementation rather than passed in — and why an "opaque already-framed request" seam was
 * rejected: that is a body parameter wearing a hat.
 *
 * `keys` is the third argument and it is not content. `p256dh` and `auth` are registration
 * provenance — the same class of value as the endpoint URL, which has always crossed this seam:
 * they came from the device at registration time, they say nothing about any message, and the
 * census pins their SHAPE to exactly those two fields so a threaded value fails it. `null` means
 * the registration offered no keys and the plaintext constant is what goes out.
 */
export type PushWakePost = (
  url: string, pin: readonly string[], keys: WebPushKeys | null,
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
 * The default POST: pinned to the addresses the guard cleared, redirects NOT followed, and the
 * response body DESTROYED rather than read.
 *
 * Redirects matter more here than in most places. A distributor that answers `302 Location:
 * http://169.254.169.254/` would, under a following client, turn a cleared endpoint into a dial
 * at cloud metadata — the gate can only ever speak about the URL it was given. `pinnedHttpRequest`
 * is built on `http(s).request`, which follows nothing, so this holds by construction rather than
 * by remembering to pass an option.
 *
 * ── THE RESPONSE IS A HOSTILE INPUT, AND THE FIRST VERSION OF THIS FUNCTION TREATED IT AS DATA ──
 *
 * The distributor at the other end of this socket was chosen by whoever registered the endpoint. On
 * a multi-account server that is any authenticated account, and "the endpoint I registered points
 * at a server I wrote" is the ordinary case rather than the exotic one. So the response is not a
 * message, it is an attack surface, and the first version of this function got two things wrong
 * about it — both found in review, both reachable from any account:
 *
 *  · **`clearTimeout` ran in a `finally` that fires when the HEADERS arrive.** `pinnedHttpRequest`
 *    resolves at the response head, not at its end, so the abort that was supposed to bound this
 *    request stopped covering it exactly when the body began. A server that answered `200` and then
 *    dripped one byte every few seconds held a socket open for ever, and every later wake added
 *    another. The timer now lives until the response is DONE — and since nothing here ever reads a
 *    body, "done" means destroyed immediately.
 *  · **`resume()` with no `'error'` listener.** The review that found the timer also called this a
 *    process death: a mid-body RST emits `'error'` on an `IncomingMessage` nobody is listening to,
 *    which in Node is an unhandled error, and it arrives after this function has resolved so the
 *    caller's `try/catch` cannot see it. **MEASURED, AND THAT SECOND HALF IS NOT REACHABLE HERE** —
 *    a standalone reproduction of exactly this shape (headers, one byte, `socket.destroy()`, an
 *    error listener on the REQUEST and none on the response, which is `pinnedHttpRequest`'s shape
 *    verbatim) reports `req 'error' fired` and NO uncaught exception. Node routes a mid-body socket
 *    fault to the `ClientRequest`, and `pinnedHttpRequest` has a listener there, so it is absorbed.
 *    The listener below stays anyway, and the reason is worth stating rather than leaving it as
 *    cargo: without it, this function's safety is a property of a DIFFERENT module's `reject`
 *    continuing to exist. That is a fine thing to rely on and a bad thing to depend on silently.
 *    It costs one no-op closure to make the property local.
 *
 * `destroy()` rather than `resume()` because we categorically do not want the bytes: it releases the
 * socket at once instead of waiting out however long the peer takes to finish talking. The cost is
 * that the connection is not reused, which for a per-account-debounced wake is not a cost worth
 * measuring. Nothing about the response is logged except its status.
 */
function makeDefaultPost(
  opts: { signal: AbortSignal; timeoutMs: number; vapid: VapidIdentity | null },
): PushWakePost {
  const vapid = opts.vapid;
  return async function post(
    url: string, pin: readonly string[], keys: WebPushKeys | null,
  ): Promise<{ status: number }> {
    /**
     * ── SEAL, OR DO NOT — and the headers follow from that one decision ──────────────────────
     *
     * `sealed === null` is the plaintext arm, byte-identical to what this sender has always put on
     * the wire. Otherwise the constant is encrypted to the device's own key and the request grows
     * exactly two headers: the content coding, and the signature that says which server sent it.
     *
     * The `throw` is unreachable by construction — `fire` skips a keyed row when there is no
     * identity, which is what `skipped()` counts — and it is here rather than a non-null assertion
     * because the alternative shape of this bug is silently sending a plaintext body to a device
     * that will discard it, i.e. a delivery that is not one. A throw is caught by the caller's
     * per-endpoint `catch` and retried on the next wake; a silent discard is forever.
     */
    let sealed: Buffer | null = null;
    let sealedHeaders: Record<string, string> = {};
    if (keys !== null) {
      if (vapid === null) throw new Error("cannot seal a wake without a VAPID identity");
      sealed = encryptWebPushBody(WAKE_BODY, keys);
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
  const { db, source, guard, ownsAccount, log } = deps;
  const debounceMs = deps.debounceMs ?? WAKE_DEBOUNCE_MS;
  const minIntervalMs = deps.minIntervalMs ?? WAKE_MIN_INTERVAL_MS;
  const timeoutMs = deps.timeoutMs ?? WAKE_TIMEOUT_MS;
  const now = deps.now ?? Date.now;

  /**
   * AN UNUSABLE VAPID CONFIGURATION STOPS THE SENDER HERE, BEFORE IT SUBSCRIBES TO ANYTHING.
   *
   * Not a degraded mode, and this is the one place in this module that deliberately does LESS on a
   * failure than it could. The keyless arm would still work — so an operator watching their own
   * `ntfy` topic would see wakes arriving and conclude the feature is fine, while every phone they
   * actually care about gets nothing. A half-working feature is worse than an off one when the
   * working half is the half nobody is testing with.
   *
   * The worker itself is untouched: this returns an inert handle, mail keeps syncing, and the
   * reason is in the log with no key material in it.
   */
  if (deps.vapid.kind === "invalid") {
    log?.warn("push_wake_vapid_invalid", {
      why: deps.vapid.why,
      reason: "this deployment configured a VAPID keypair that cannot be used, so NO wakes are "
        + "sent — including the unencrypted ones, deliberately, so a broken configuration is not "
        + "hidden by the arm that still works. Devices still sync on foreground and pull-to-refresh.",
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

  /** One pending debounce per account. The VALUE is a timer and nothing else — no payload. */
  const pending = new Map<string, ReturnType<typeof setTimeout>>();
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

  /**
   * Dial one account's endpoints.
   *
   * The account id is used ONCE — as the SELECT predicate — and never leaves this function. The
   * rows it reads are `{ id, endpoint, p256dh, auth }` and nothing else: the projection is narrow
   * on purpose, so that a future edit which wants a message-derived value has to widen the SELECT,
   * which the census sees. The two key columns are in it because sealing needs them and for no
   * other reason — they are the device's own material, they are never logged, and they never leave
   * this function except as the encryptor's input.
   */
  const fire = async (accountId: string): Promise<void> => {
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

    const rows = await db.select({
      id: pushSubscriptions.id,
      endpoint: pushSubscriptions.endpoint,
      p256dh: pushSubscriptions.p256dh,
      auth: pushSubscriptions.auth,
    }).from(pushSubscriptions).where(and(
      eq(pushSubscriptions.accountId, accountId),
      eq(pushSubscriptions.transport, "unifiedpush"),
    ));

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
        ({ status } = await post(url, pin, keys));
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
