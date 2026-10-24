import { ServiceError } from "@trafficflow/services/mail";
import { discoverDomain, discoverMailHosting } from "../mailbox-discovery.js";
import { jsonResponse } from "../responses.js";
import type { Route } from "../router.js";
import { readBody } from "./shared.js";

/** How long one lookup may take, every DNS question in it together. */
export const DISCOVER_BUDGET_MS = 2_000;

/**
 * Lookups per account per window, counted in this instance's memory and nowhere else: nothing about
 * a lookup is stored. The platform's per-IP limit at the edge is the other half.
 */
export const DISCOVER_PER_ACCOUNT = { max: 20, windowMs: 10 * 60_000 } as const;

/** Accounts this instance remembers; past it the longest-quiet one is forgotten. */
const ACCOUNTS_TRACKED_MAX = 10_000;

const recent = new Map<string, number[]>();

/** Count one lookup for the account, or refuse it with the seconds until the oldest one ages out. */
function takeLookup(accountId: string, nowMs: number): void {
  const kept = (recent.get(accountId) ?? []).filter((at) => at > nowMs - DISCOVER_PER_ACCOUNT.windowMs);
  if (kept.length >= DISCOVER_PER_ACCOUNT.max) {
    const retryAfter = Math.max(1, Math.ceil((kept[0]! + DISCOVER_PER_ACCOUNT.windowMs - nowMs) / 1000));
    throw new ServiceError("rate_limited", 429, "too many lookups; try again later", { retryAfter }, true);
  }
  recent.delete(accountId);
  recent.set(accountId, [...kept, nowMs]);
  while (recent.size > ACCOUNTS_TRACKED_MAX) recent.delete(recent.keys().next().value!);
}

/** The body is `{ domain }` and nothing more: a second field would be somewhere for the address to go. */
function domainOfBody(body: unknown): string {
  if (typeof body !== "object" || body === null || Array.isArray(body)
    || Object.keys(body).some((key) => key !== "domain")) {
    throw new ServiceError("validation_failed", 400, "the body is { domain } and nothing else");
  }
  const verdict = discoverDomain((body as { domain?: unknown }).domain);
  if (!verdict.ok) throw new ServiceError("validation_failed", 400, verdict.why);
  return verdict.domain;
}

/**
 * `POST /mailboxes/discover` — which provider hosts a domain's mail, for the connect forms to
 * pre-fill (`mailbox-discovery.ts` says what is asked and why nothing else is). `connection`: it
 * makes this process query DNS about a name the caller chose, so an unverified account may not.
 * Not relayed: only the hosted forms ask it. No step-up: the body carries no credential.
 */
export const mailboxDiscoverRoutes: Route[] = [
  {
    method: "POST",
    pattern: "/mailboxes/discover",
    relay: false,
    cost: "connection",
    handler: async (req, deps) => {
      const domain = domainOfBody(await readBody<unknown>(req));
      const dns = deps.mailDns;
      if (!dns) throw new ServiceError("discover_unconfigured", 503, "this server does not look up mail domains");
      takeLookup(deps.session!.accountId, deps.now().getTime());
      return jsonResponse(await discoverMailHosting(domain, dns, DISCOVER_BUDGET_MS));
    },
  },
];
