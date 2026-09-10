import {
  UNMETERED_ACCESS,
  type AccessRefusal, type AccessVerdict, type EntitlementsPort,
  type ReleaseOutcome, type SpendVerdict,
} from "./entitlements-port.js";

/**
 * THE HTTP CLIENT of an entitlements program, implementing {@link EntitlementsPort} over its
 * documented API. An operator who runs their own program points `ENTITLEMENTS_URL` at it and
 * every route works unchanged; a host that sets nothing constructs none and is unmetered.
 *
 * ── THE FAULT ARM IS THE LOAD-BEARING LINE ────────────────────────────────────────────────
 *
 * `access` is consulted on the mail path, so an unreachable program must not lock a paying
 * customer out of their own mail. A fault therefore answers with the last verdict this process
 * saw for the account, and with none, allow. The opposite direction — refuse when unsure — turns
 * one outage into every customer's inbox going dark, and no test of a healthy program would
 * ever show it.
 *
 * Only an ANSWER changes what the customer sees: a refusal has to come from the program's own
 * verdict, never from a proxy's error page or an expired secret.
 */

/** The ceiling on every call. Short, because `access` sits in front of mail reads. */
export const ENTITLEMENTS_CALL_TIMEOUT_MS = 3_000;

/** How long an `access` verdict is reused before it is re-read. */
export const ACCESS_TTL_MS = 60_000;

/** The slice of `fetch` this client needs — injectable so no test opens a socket. */
export type EntitlementsFetch = (url: string, init: {
  method: "POST";
  headers: Record<string, string>;
  body: string;
  signal: AbortSignal;
}) => Promise<{ status: number; json(): Promise<unknown> }>;

export interface EntitlementsClientConfig {
  /** `ENTITLEMENTS_URL` — the program's origin. A trailing slash is normalized. */
  baseUrl: string;
  /** `ENTITLEMENTS_SECRET` — presented as `Authorization: Bearer …` on every call. */
  secret: string;
  /** Production leaves this absent (global `fetch`); every test injects one. */
  fetchImpl?: EntitlementsFetch;
  timeoutMs?: number;
  ttlMs?: number;
  now?: () => number;
}

/** One completed exchange, or the fact that there was not one. */
interface Exchange {
  status: number;
  body: unknown;
  bodyIsJson: boolean;
}

const REFUSALS: ReadonlySet<string> = new Set<AccessRefusal>(["payment_required", "suspended"]);

/** The program's `access` answer, matched exactly — a shape outside it was never a verdict. */
function verdictOf(body: unknown): AccessVerdict | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  if (b.ok === true) {
    const l = b.limits as Record<string, unknown> | undefined;
    if (!l || typeof l.aiEnabled !== "boolean") return null;
    const num = (v: unknown): number | null => (v === null ? null : typeof v === "number" ? v : NaN);
    const mailboxes = num(l.mailboxes);
    const storageBytes = num(l.storageBytes);
    if (Number.isNaN(mailboxes) || Number.isNaN(storageBytes)) return null;
    return { ok: true, limits: { mailboxes, storageBytes, aiEnabled: l.aiEnabled } };
  }
  if (b.ok === false && typeof b.reason === "string" && REFUSALS.has(b.reason)) {
    const url = typeof b.manageUrl === "string" && b.manageUrl.length > 0 ? b.manageUrl : undefined;
    return { ok: false, reason: b.reason as AccessRefusal, ...(url ? { manageUrl: url } : {}) };
  }
  return null;
}

const SPEND_VERDICTS: ReadonlySet<string> =
  new Set<SpendVerdict>(["ok", "duplicate", "insufficient", "fault"]);

/**
 * Build the client. **Refuses to be constructed without both halves of its configuration**, and
 * that is the fail-closed direction that matters here: a client with an empty base URL would
 * dial a relative path, fault on every call, and then fail OPEN by design — an unmetered
 * deployment wearing a metered one's clothes, with nothing in any log to say so. A host that
 * means to be unmetered declares `UNMETERED` instead.
 */
export function makeEntitlementsClient(cfg: EntitlementsClientConfig): EntitlementsPort {
  const raw = (cfg.baseUrl ?? "").trim();
  if (raw === "") {
    throw new Error(
      "entitlements client: ENTITLEMENTS_URL is required to construct one. A host with no " +
      "entitlements program declares UNMETERED; it does not build a client that cannot dial.");
  }
  if (!/^https?:\/\//.test(raw)) {
    throw new Error("entitlements client: ENTITLEMENTS_URL must be an absolute http(s) URL");
  }
  if ((cfg.secret ?? "").trim() === "") {
    throw new Error("entitlements client: ENTITLEMENTS_SECRET is required — the bearer rides every request");
  }

  const base = raw.replace(/\/+$/, "");
  const timeoutMs = cfg.timeoutMs ?? ENTITLEMENTS_CALL_TIMEOUT_MS;
  const ttlMs = cfg.ttlMs ?? ACCESS_TTL_MS;
  const clock = cfg.now ?? (() => Date.now());
  const fetchImpl: EntitlementsFetch =
    cfg.fetchImpl ?? (globalThis.fetch as unknown as EntitlementsFetch);

  /** Per-account verdicts. `freshUntil` bounds REUSE; the value itself is kept for the fault arm. */
  const cache = new Map<string, { verdict: AccessVerdict; freshUntil: number }>();

  /**
   * One bounded exchange. The clock covers the WHOLE call including the body parse, so a peer
   * that answers headers and then stalls still returns at the ceiling. Never throws: every
   * caller here has a degrade arm and a rejection would only move the mapping outwards.
   */
  const post = async (path: string, payload: unknown): Promise<Exchange | null> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`entitlements call timed out: ${path}`)), timeoutMs);
    (timer as unknown as { unref?: () => void }).unref?.();
    const aborted = new Promise<never>((_, reject) => {
      const fire = (): void => reject(controller.signal.reason ?? new Error("aborted"));
      if (controller.signal.aborted) fire();
      else controller.signal.addEventListener("abort", fire, { once: true });
    });
    aborted.catch(() => { /* raced away */ });
    try {
      const res = await Promise.race([
        fetchImpl(`${base}${path}`, {
          method: "POST",
          headers: { authorization: `Bearer ${cfg.secret}`, "content-type": "application/json" },
          body: JSON.stringify(payload),
          signal: controller.signal,
        }),
        aborted,
      ]);
      let body: unknown;
      let bodyIsJson = false;
      try {
        body = await Promise.race([res.json(), aborted]);
        bodyIsJson = true;
      } catch {
        body = undefined;
      }
      return { status: res.status, body, bodyIsJson };
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    async access(accountId: string): Promise<AccessVerdict> {
      const at = clock();
      const held = cache.get(accountId);
      if (held && held.freshUntil > at) return held.verdict;

      const res = await post("/v1/access", { accountId });
      const verdict = res && res.bodyIsJson ? verdictOf(res.body) : null;
      // A verdict is a verdict at any status the program states it with — 200 for a permitted
      // account, 402/403 for a refused one. What is NOT a verdict is everything else: a
      // timeout, a 5xx, a 401 from a rotated secret, an intermediary's HTML page.
      if (res && verdict && res.status < 500) {
        cache.set(accountId, { verdict, freshUntil: at + ttlMs });
        return verdict;
      }
      // The fault arm: the last thing we knew, however stale, and otherwise allow.
      return held?.verdict ?? UNMETERED_ACCESS;
    },

    async spend(accountId: string, action: string, attemptKey: string): Promise<SpendVerdict> {
      const res = await post("/v1/spend", { accountId, action, attemptKey });
      if (!res || res.status !== 200 || !res.bodyIsJson) return "fault";
      const v = (res.body as { verdict?: unknown } | undefined)?.verdict;
      return typeof v === "string" && SPEND_VERDICTS.has(v) ? (v as SpendVerdict) : "fault";
    },

    async release(accountId: string, attemptKey: string): Promise<void> {
      // A lost release leaves the attempt OPEN, so its retry is free — losing one costs the
      // customer nothing, which is why this swallows rather than retries.
      await post("/v1/spend/release", { accountId, attemptKey });
    },

    async manageLink(accountId: string): Promise<{ url: string } | null> {
      const res = await post("/v1/manage-link", { accountId });
      if (!res || res.status !== 200 || !res.bodyIsJson) return null;
      const url = (res.body as { url?: unknown } | undefined)?.url;
      return typeof url === "string" && url.length > 0 ? { url } : null;
    },

    async releaseAccount(accountId: string): Promise<ReleaseOutcome> {
      const res = await post("/v1/account/release", { accountId });
      if (!res) return "failed";
      if (res.status === 404) return "none";
      if (res.status !== 200) return "failed";
      const released = (res.body as { released?: unknown } | undefined)?.released;
      // An explicit `released: false` is "there was nothing to stop"; a bare 200 is "stopped".
      return released === false ? "none" : "released";
    },
  };
}
