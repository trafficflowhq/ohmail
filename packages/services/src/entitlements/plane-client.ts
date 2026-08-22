import type { EntitlementEvent, ReconcilePageDTO } from "./entitlement-event.js";
import type { BillingPlanePort, PlaneCheckoutRequest, WebhookVerdict } from "./plane-port.js";

/**
 * The HTTP client of the PRIVATE billing plane, implementing {@link BillingPlanePort}
 * over the plane's documented API. It replaced the in-tree adapter when the plane became a
 * separate service. An open client of a documented API is also the self-host story: point
 * `BILLING_PLANE_URL` at your own plane and every route works unchanged.
 *
 * ── THE VERDICT MAPPING IS THE MONEY-CRITICAL LINE ─────────────────────────────────────────
 *
 * Stripe reads the open relay's status as an instruction: 400 = drop this delivery FOREVER,
 * 5xx = retry for ~3 days. The relay maps a REJECTED promise from this client to 503 and an
 * `{ok:false}` verdict to 400, so the mapping HERE decides which of those a plane failure
 * becomes:
 *
 *  · plane answers **200** ⇒ `{ok:true, event}` — the verified, translated delivery;
 *  · plane answers **400 whose JSON body IS the plane's refusal vocabulary** — exactly
 *    `{error:"bad_signature"}` or `{error:"event_rejected", reason:<string>}` — ⇒
 *    `{ok:false, body}`, the plane's OWN final verdict, forwarded VERBATIM;
 *  · **anything else** — network failure, timeout, 401/404/5xx, a "400" whose body is not
 *    JSON, or a "400" whose JSON is OUTSIDE the vocabulary (a proxy's `{error:"bad_request"}`
 *    was never the verify endpoint's voice) ⇒ REJECT. Turning any of those into `{ok:false}`
 *    converts an outage into permanent, silent money loss, one webhook at a time — the
 *    `! producer | grep -q .` shape.
 *
 * ── BYTES TRAVEL VERBATIM ──────────────────────────────────────────────────────────────────
 *
 * `verifyWebhook` sends `rawBody` as the request body UNTOUCHED — never decoded to a string,
 * never JSON round-tripped — because the plane HMACs exactly what it receives, and every
 * re-encoding failure is indistinguishable from an attack: a 400, and a delivery Stripe never
 * brings back. A `null` signature is forwarded as an ABSENT header; the plane answers its own
 * `400 {error:"bad_signature"}`, so there is exactly one authority for the verdict.
 *
 * ── BOUNDED IN TIME — THE WHOLE EXCHANGE, NOT JUST THE HEADERS ─────────────────────────────
 *
 * Every call aborts at {@link PLANE_CALL_TIMEOUT_MS}, and the bound covers the FULL exchange:
 * the response body is parsed inside the armed region, and the parse races the abort clock, so
 * a peer that answers headers promptly and then stalls the body still rejects at the ceiling —
 * even under a fetch implementation that ignores the abort signal mid-body. Checkout/portal
 * sit inside interactive requests; `cancelSubscription` sits inside the erasure path, whose
 * caller (`cancelForErasure`) additionally never lets a failure block Art. 17; verify sits
 * inside the webhook relay, where a hang would eat the serverless invocation. A timeout
 * REJECTS, which on the webhook path is a 503 — a retry, never a loss.
 *
 * The suite performs zero external requests: `fetchImpl` is injectable and every test injects
 * it. No test dials the plane.
 */

/** The ceiling on every plane call. The webhook relay's 503-on-rejection makes it safe. */
export const PLANE_CALL_TIMEOUT_MS = 10_000;

/** The slice of `fetch` this client needs — injectable so no test opens a socket. */
export type PlaneFetch = (url: string, init: {
  method: "POST";
  headers: Record<string, string>;
  body: string | Uint8Array;
  signal: AbortSignal;
}) => Promise<{
  status: number;
  /** Parse the response body as JSON. May reject (an intermediary's HTML page). */
  json(): Promise<unknown>;
}>;

export interface BillingPlaneClientConfig {
  /** The plane's origin — wherever your plane is deployed. A trailing slash is normalized. */
  baseUrl: string;
  /** `BILLING_PLANE_SECRET` — presented as `Authorization: Bearer …` on every call. */
  secret: string;
  /** Production leaves this absent (global `fetch`); every test injects one. */
  fetchImpl?: PlaneFetch;
  /** Test seam for the abort clock. Defaults to {@link PLANE_CALL_TIMEOUT_MS}. */
  timeoutMs?: number;
}

/**
 * THE PLANE'S REFUSAL VOCABULARY, exactly. The verify endpoint's only `400` payloads are
 * `{error:"bad_signature"}` and `{error:"event_rejected", reason:<string>}` — nothing else,
 * no extra keys. A 400 carrying any OTHER JSON (a proxy's `{error:"bad_request"}`, a WAF's
 * envelope, a future plane bug) was never a verdict on the delivery, and treating it as one
 * would relay Stripe a 400 = drop forever. Matched exactly so the vocabulary widening is a
 * deliberate two-sided change, never an accident an intermediary can perform.
 */
function isPlaneRefusal(body: unknown): boolean {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return false;
  const b = body as Record<string, unknown>;
  const keys = Object.keys(b);
  if (b.error === "bad_signature") return keys.length === 1;
  if (b.error === "event_rejected") return keys.length === 2 && typeof b.reason === "string";
  return false;
}

/** One completed exchange: status plus the parsed body (or the fact that it was not JSON). */
interface PlaneExchange {
  status: number;
  /** The JSON body, when `bodyIsJson`; `undefined` otherwise. */
  body: unknown;
  /** False when the body failed to parse as JSON — an intermediary's page, never the plane. */
  bodyIsJson: boolean;
}

/** Build the HTTP implementation of the port. Pure construction — nothing is dialled here. */
export function makeBillingPlaneClient(cfg: BillingPlaneClientConfig): BillingPlanePort {
  const base = cfg.baseUrl.replace(/\/+$/, "");
  const timeoutMs = cfg.timeoutMs ?? PLANE_CALL_TIMEOUT_MS;
  const fetchImpl: PlaneFetch = cfg.fetchImpl ?? (globalThis.fetch as unknown as PlaneFetch);

  const post = async (
    path: string,
    body: string | Uint8Array,
    extraHeaders: Record<string, string> = {},
    // Which statuses this call site actually READS the body of. Parsing is network I/O under
    // the abort clock, so parsing a body nobody consumes converts a stalling peer into a
    // needless timeout — and on the cancel path that would report a COMMITTED cancellation as
    // "cancel_failed". Where the body is not consumed, the exchange completes at the headers.
    consumesBody: (status: number) => boolean = () => true,
  ): Promise<PlaneExchange> => {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error(`billing plane call timed out after ${timeoutMs}ms: ${path}`)),
      timeoutMs,
    );
    // `unref` so a pending timer never holds a serverless invocation open past its response.
    (timer as unknown as { unref?: () => void }).unref?.();
    // The clock must bound the WHOLE exchange. `fetch` honours the signal for its own phases,
    // but a body stream is free to ignore it, so the abort competes at every await below as a
    // racing rejection — the bound is enforced HERE, not delegated to the fetch implementation.
    const aborted = new Promise<never>((_, reject) => {
      const fire = (): void => reject(controller.signal.reason ?? new Error("aborted"));
      if (controller.signal.aborted) fire();
      else controller.signal.addEventListener("abort", fire, { once: true });
    });
    // When the race is won elsewhere this promise still rejects later; mark it handled.
    aborted.catch(() => { /* raced away */ });
    try {
      const res = await Promise.race([
        fetchImpl(`${base}${path}`, {
          method: "POST",
          headers: { authorization: `Bearer ${cfg.secret}`, ...extraHeaders },
          body,
          signal: controller.signal,
        }),
        aborted,
      ]);
      // Parse INSIDE the bounded region: `res.json()` is network I/O — the body may still be
      // in flight — and disarming the timer before it completes would hand a stalling peer an
      // unbounded hold on the caller. A parse failure is recorded, not thrown:
      // which statuses tolerate a non-JSON body is the call site's decision. And parse ONLY
      // where the call site consumes the body — see `consumesBody` above.
      let parsed: unknown;
      let bodyIsJson = false;
      if (consumesBody(res.status)) {
        try {
          parsed = await Promise.race([res.json(), aborted]);
          bodyIsJson = true;
        } catch (err) {
          if (controller.signal.aborted) throw controller.signal.reason ?? err;
          parsed = undefined;
        }
      }
      return { status: res.status, body: parsed, bodyIsJson };
    } finally {
      clearTimeout(timer);
    }
  };

  /** A 200 whose body must carry `{url}`. Anything else is a thrown transport/protocol error. */
  const urlOf = (path: string, res: PlaneExchange): { url: string } => {
    if (res.status !== 200) {
      // Status only — never the body: a plane error body is fixed vocabulary today, but this
      // message reaches route error envelopes and logs, and the rule is structural.
      throw new Error(`billing plane answered ${res.status} for ${path}`);
    }
    const parsed = (res.bodyIsJson ? res.body : undefined) as { url?: unknown } | undefined;
    if (!parsed || typeof parsed.url !== "string" || parsed.url.length === 0) {
      throw new Error(`billing plane answered 200 without a url for ${path}`);
    }
    return { url: parsed.url };
  };

  return {
    async checkout(req: PlaneCheckoutRequest): Promise<{ url: string }> {
      // Body consumed only on 200 — `urlOf` reports every other status by number alone.
      const res = await post("/v1/checkout", JSON.stringify(req), {
        "content-type": "application/json",
      }, (status) => status === 200);
      return urlOf("/v1/checkout", res);
    },

    async portal(req: { stripeCustomerId: string }): Promise<{ url: string }> {
      const res = await post("/v1/portal", JSON.stringify(req), {
        "content-type": "application/json",
      }, (status) => status === 200);
      return urlOf("/v1/portal", res);
    },

    async cancelSubscription(req: { stripeSubscriptionId: string }): Promise<void> {
      // Status-only: nothing below reads the body, so the exchange completes at the headers —
      // a 200 whose body stalls is still a COMMITTED cancellation, never a timeout that the
      // erasure caller would misreport as "cancel_failed".
      const res = await post("/v1/subscription/cancel", JSON.stringify(req), {
        "content-type": "application/json",
      }, () => false);
      // Throws on refusal, per the port: the open caller (`cancelForErasure`) bounds it and
      // maps every failure to "cancel_failed" — erasure never depends on this succeeding.
      if (res.status !== 200) {
        throw new Error(`billing plane answered ${res.status} for /v1/subscription/cancel`);
      }
    },

    async setAddonQuantity(req: {
      stripeSubscriptionId: string; addon: "storage" | "mailbox"; quantity: number;
    }): Promise<void> {
      // Status-only, like the cancel beside it: nothing reads the body, so a 200 whose body
      // stalls is still a committed update.
      const res = await post("/v1/addons", JSON.stringify(req), {
        "content-type": "application/json",
      }, () => false);
      if (res.status !== 200) {
        throw new Error(`billing plane answered ${res.status} for /v1/addons`);
      }
    },

    async reconcileSubscriptions(req: { cursor: string | null; limit: number }): Promise<ReconcilePageDTO> {
      const res = await post("/v1/reconcile", JSON.stringify(req), {
        "content-type": "application/json",
      }, (status) => status === 200);
      if (res.status !== 200) {
        // Status only, per the client-wide rule — and EVERY non-200 is a throw: a refused or
        // failed list must surface as a failed pass, never as an empty page (an empty page
        // reads as "Stripe holds no subscriptions" and would flag every mirror row).
        throw new Error(`billing plane answered ${res.status} for /v1/reconcile`);
      }
      const parsed = (res.bodyIsJson ? res.body : undefined) as {
        observedAt?: unknown; events?: unknown; nextCursor?: unknown;
      } | undefined;
      if (
        !parsed || typeof parsed.observedAt !== "number" || !Array.isArray(parsed.events)
        || (parsed.nextCursor !== null && typeof parsed.nextCursor !== "string")
      ) {
        throw new Error("billing plane answered 200 without a reconcile page for /v1/reconcile");
      }
      return {
        observedAt: parsed.observedAt,
        events: parsed.events as EntitlementEvent[],
        nextCursor: parsed.nextCursor as string | null,
      };
    },

    async verifyWebhook(rawBody: Uint8Array, signature: string | null): Promise<WebhookVerdict> {
      // THE BYTES, VERBATIM. No decode, no re-encode, no content-type games — the plane HMACs
      // exactly these octets (mutation-checked: one flipped byte fails the verify). The
      // signature header passes through
      // untouched; `null` becomes an ABSENT header and the plane's own 400 answers it.
      // The body is a verdict's substance only on 200 (the event) and 400 (the refusal
      // vocabulary); every other status is transport reported by number, so a stalling body
      // there must not defer the rejection to the timeout.
      const res = await post(
        "/v1/stripe/verify",
        rawBody,
        signature === null ? {} : { "stripe-signature": signature },
        (status) => status === 200 || status === 400,
      );

      if (res.status === 200) {
        const parsed = (res.bodyIsJson ? res.body : undefined) as { event?: EntitlementEvent } | undefined;
        if (!parsed || !parsed.event || typeof parsed.event !== "object") {
          // A 200 without an event is not a verdict — it is a protocol breach, i.e. transport.
          throw new Error("billing plane answered 200 without an event for /v1/stripe/verify");
        }
        return { ok: true, event: parsed.event };
      }

      if (res.status === 400) {
        // The plane's OWN refusal, body VERBATIM — the relay forwards it to Stripe unchanged.
        // A "400" whose body is not JSON was never the plane's voice (the plane always answers
        // JSON): an intermediary's error page must REJECT so the relay answers 503 and Stripe
        // retries, instead of that page becoming a permanent drop instruction.
        if (!res.bodyIsJson) {
          throw new Error("billing plane answered 400 with a non-JSON body for /v1/stripe/verify");
        }
        // And a 400 whose JSON is OUTSIDE the refusal vocabulary is the same intermediary in a
        // different costume — see {@link isPlaneRefusal}. REJECT ⇒ relay 503 ⇒ Stripe retries.
        if (!isPlaneRefusal(res.body)) {
          throw new Error("billing plane answered 400 outside its refusal vocabulary for /v1/stripe/verify");
        }
        return { ok: false, body: res.body };
      }

      // EVERYTHING ELSE IS TRANSPORT — 401 (misdeployed secret), 404, 5xx, anything unexpected.
      // A rejection here is a 503 at the relay, so Stripe retries. Mapping ANY of these to
      // `{ok:false}` would turn a plane outage into "signature bad, drop it" (ruling risk #1).
      throw new Error(`billing plane answered ${res.status} for /v1/stripe/verify`);
    },
  };
}
