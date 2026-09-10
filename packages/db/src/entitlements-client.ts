import {
  UNMETERED_ACCESS,
  type AccessRefusal, type AccessVerdict, type EntitlementsPort,
  type ReleaseOutcome, type SpendAction, type SpendOutcome, type SpendRelease,
} from "./entitlements-port.js";

/**
 * THE HTTP CLIENT of an entitlements program, implementing {@link EntitlementsPort} over that
 * program's wire contract v1. An operator who runs their own points `ENTITLEMENTS_URL` at it and
 * every route works unchanged; a host that sets nothing constructs none and is unmetered.
 *
 * ── THE FAULT ARM IS THE LOAD-BEARING LINE ────────────────────────────────────────────────
 *
 * `access` is consulted on the mail path, so an unreachable program must not lock a paying
 * customer out of their own mail. A fault answers with the last verdict this process saw for the
 * account, and with none, allow. The opposite direction — refuse when unsure — turns one outage
 * into every customer's inbox going dark, and no test of a healthy program would ever show it.
 *
 * ── AND A 200 NOBODY CAN PARSE IS A FAULT, NOT AN ALLOW ───────────────────────────────────
 *
 * The two sides can drift: a field renamed, a verdict added, a proxy rewriting a body. Reading
 * such an answer as "no verdict, therefore fine" is a silent allow — metering that has stopped
 * applying, with nothing in any log. So an unrecognised 200 is reported by name with the offending
 * field and THEN takes the fault path. The customer is still never locked out; the operator is
 * told.
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

/** A drift between the two sides, named. `field` is what could not be read, never a value. */
export interface ContractFault {
  path: string;
  status: number;
  /** The field that failed to parse, or `"body"` when the whole shape was wrong. */
  field: string;
}

export interface EntitlementsClientConfig {
  /** `ENTITLEMENTS_URL` — the program's origin. A trailing slash is normalized. */
  baseUrl: string;
  /** `BILLING_PLANE_SECRET` — the program's own bearer, presented on every call. */
  secret: string;
  /** Production leaves this absent (global `fetch`); every test injects one. */
  fetchImpl?: EntitlementsFetch;
  timeoutMs?: number;
  ttlMs?: number;
  now?: () => number;
  /**
   * Where a contract drift goes. Absent ⇒ `console.warn`. A client that degraded silently is one
   * nobody can debug when "metering stopped applying" arrives as a finance question.
   */
  onContractFault?: (f: ContractFault) => void;
}

/** One completed exchange, or the fact that there was not one. */
interface Exchange {
  status: number;
  body: unknown;
  bodyIsJson: boolean;
}

const obj = (v: unknown): Record<string, unknown> | null =>
  (typeof v === "object" && v !== null && !Array.isArray(v)) ? v as Record<string, unknown> : null;

/** The program's ten reasons, reduced to the two sentences the open app has. */
function refusalOf(reason: unknown): AccessRefusal {
  return reason === "suspended" ? "suspended" : "payment_required";
}

/**
 * THE `access` ANSWER — the full entitlement, from which the open side derives what it needs.
 * The refusal is `syncEnabled === false`: the program deliberately does not send an ok/refused
 * pair, because `reason`, `syncEnabled` and `canAddMailbox` are three different questions.
 *
 * Returns the field that failed when it cannot read one, so the drift is nameable.
 */
function verdictOf(body: unknown): AccessVerdict | { bad: string } {
  const b = obj(body);
  if (!b) return { bad: "body" };
  const e = obj(b.entitlements);
  if (!e) return { bad: "entitlements" };
  if (typeof e.syncEnabled !== "boolean") return { bad: "entitlements.syncEnabled" };
  if (typeof e.canAddMailbox !== "boolean") return { bad: "entitlements.canAddMailbox" };
  if (typeof e.aiEnabled !== "boolean") return { bad: "entitlements.aiEnabled" };

  const url = typeof b.manageUrl === "string" && b.manageUrl.length > 0 ? b.manageUrl : undefined;
  if (!e.syncEnabled) {
    return { ok: false, reason: refusalOf(e.reason), ...(url ? { manageUrl: url } : {}) };
  }
  const num = (v: unknown, field: string): number | null | { bad: string } =>
    v === null ? null : typeof v === "number" ? v : { bad: field };
  const mailboxes = num(e.mailboxLimit, "entitlements.mailboxLimit");
  if (typeof mailboxes === "object" && mailboxes !== null) return mailboxes;
  const storageBytes = num(e.storageBytesLimit, "entitlements.storageBytesLimit");
  if (typeof storageBytes === "object" && storageBytes !== null) return storageBytes;
  return {
    ok: true,
    limits: {
      mailboxes, storageBytes, canAddMailbox: e.canAddMailbox, aiEnabled: e.aiEnabled,
    },
  };
}

/** The program's five spend verdicts. `fault` is never one of them — see {@link SpendOutcome}. */
function spendOf(body: unknown): SpendOutcome | { bad: string } {
  const b = obj(body);
  if (!b) return { bad: "body" };
  switch (b.verdict) {
    case "ok":
    case "duplicate": {
      if (typeof b.attempt !== "string" || b.attempt.length === 0) return { bad: "attempt" };
      return b.verdict === "ok"
        ? { verdict: "ok", charged: true, attempt: b.attempt }
        : { verdict: "duplicate", charged: false, attempt: b.attempt };
    }
    case "insufficient":
    case "refused": {
      const reason = typeof b.reason === "string" ? b.reason : "";
      if (reason === "") return { bad: "reason" };
      return { verdict: b.verdict, reason };
    }
    case "inflight": {
      if (typeof b.source !== "string" || b.source.length === 0) return { bad: "source" };
      return { verdict: "inflight", source: b.source };
    }
    default:
      return { bad: "verdict" };
  }
}

const OUTCOMES: ReadonlySet<string> = new Set<ReleaseOutcome>(["none", "cancelled", "cancel_failed"]);

/**
 * Build the client. **Refuses to be constructed without both halves of its configuration**, and
 * that is the fail-closed direction that matters here: a client with an empty base URL would
 * dial a relative path, fault on every call, and then fail OPEN by design — an unmetered
 * deployment wearing a metered one's clothes. A host that means unmetered declares `UNMETERED`.
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
    throw new Error(
      "entitlements client: BILLING_PLANE_SECRET is required — the bearer rides every request");
  }

  const base = raw.replace(/\/+$/, "");
  const timeoutMs = cfg.timeoutMs ?? ENTITLEMENTS_CALL_TIMEOUT_MS;
  const ttlMs = cfg.ttlMs ?? ACCESS_TTL_MS;
  const clock = cfg.now ?? (() => Date.now());
  const fetchImpl: EntitlementsFetch =
    cfg.fetchImpl ?? (globalThis.fetch as unknown as EntitlementsFetch);
  const report = cfg.onContractFault ?? ((f: ContractFault) => {
    console.warn(
      `[entitlements] the program answered ${f.status} on ${f.path} with an unreadable `
      + `\`${f.field}\`. This is a CONTRACT DRIFT between the two sides, not a verdict: the call `
      + "took the fault path (last known verdict, else allow), so nothing is locked out and "
      + "nothing is metered on it.");
  });
  /** A reporter that throws must not replace the answer with its own failure. */
  const named = (path: string, status: number, field: string): void => {
    try { report({ path, status, field }); } catch { /* observability is never load-bearing */ }
  };

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
      // A 200 is the only answer. 400/401/503 are not verdicts about this account (the contract's
      // own status table), so they take the fault path without being reported as drift.
      if (res && res.status === 200) {
        const read = res.bodyIsJson ? verdictOf(res.body) : { bad: "body" };
        if ("bad" in read) named("/v1/access", res.status, read.bad);
        else {
          cache.set(accountId, { verdict: read, freshUntil: at + ttlMs });
          return read;
        }
      }
      // The fault arm: the last thing we knew, however stale, and otherwise allow.
      return held?.verdict ?? UNMETERED_ACCESS;
    },

    async spend(accountId: string, action: SpendAction, attemptKey: string): Promise<SpendOutcome> {
      const res = await post("/v1/spend", { accountId, action, attemptKey });
      if (!res || res.status !== 200) return { verdict: "fault" };
      const read = res.bodyIsJson ? spendOf(res.body) : { bad: "body" };
      if ("bad" in read) {
        named("/v1/spend", res.status, read.bad);
        return { verdict: "fault" };
      }
      return read;
    },

    async release(accountId: string, r: SpendRelease): Promise<void> {
      // A lost release leaves the attempt OPEN, so its retry is free — losing one costs the
      // customer nothing, which is why this swallows rather than retries. A lost REFUND is the
      // dearer half and the ledger is what makes reissuing it safe, so the caller may repeat it.
      await post("/v1/spend/release", {
        accountId, action: r.action, attemptKey: r.attemptKey, attempt: r.attempt, refund: r.refund,
      });
    },

    async manageLink(accountId: string): Promise<{ url: string } | null> {
      const res = await post("/v1/manage-link", { accountId });
      if (!res || res.status !== 200 || !res.bodyIsJson) return null;
      const b = obj(res.body);
      // `{url: null}` is an ANSWER — the program does not know this account. Only a body that
      // is neither a string nor null is drift. (It used to mean "nothing to manage"; a known
      // account now always gets a URL, because this page is the only door to a first plan.)
      if (b && b.url === null) return null;
      const url = b?.url;
      if (typeof url === "string" && url.length > 0) return { url };
      named("/v1/manage-link", res.status, "url");
      return null;
    },

    async releaseAccount(accountId: string): Promise<ReleaseOutcome> {
      const res = await post("/v1/account/release", { accountId });
      // No answer means nothing was reversed, and saying "nothing to cancel" for that is the
      // sentence that leaves a deleted customer being charged.
      if (!res || res.status !== 200 || !res.bodyIsJson) return "cancel_failed";
      const outcome = obj(res.body)?.outcome;
      if (typeof outcome === "string" && OUTCOMES.has(outcome)) return outcome as ReleaseOutcome;
      named("/v1/account/release", res.status, "outcome");
      return "cancel_failed";
    },
  };
}
