import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { createApp, apiRoutes, type ApiDeps } from "@trafficflow/api";
import { localRoutes } from "@trafficflow/api/local";
import { accountSettings, contacts, rules, tags, mailboxes, awayResponders } from "@trafficflow/db";
import type { AccessVerdict, EntitlementsPort } from "@trafficflow/db";
import { serializeOrganizerProfile } from "@trafficflow/core/adapters/organizer-profile-store";
import { makeDeps, seedSession, req, FIXED_NOW } from "./helpers.js";

/**
 * `GET /account/export` — the way out with your configuration (the wall).
 *
 * Three properties, each its own failure class: the document is EXACTLY what the worker
 * publishes into `ohmail/_meta` for the same mailbox (one serializer, so a self-hosted install
 * joining the mailbox reads the identical configuration); NO key of the document matches a
 * credential shape (an export that leaked a password would follow the person out the door);
 * and the door is OPEN UNDER THE WALL (leave-anytime is not suspended by a lapsed subscription).
 */

const app = createApp(apiRoutes);
const H = (r: Request, d: ApiDeps): Promise<Response> => app.handle(r, { ...d, session: null, idempotency: null });

const refusing: EntitlementsPort = {
  access: async (): Promise<AccessVerdict> => ({ ok: false, reason: "payment_required" }),
  accessOrFault: async (): Promise<AccessVerdict> => ({ ok: false, reason: "payment_required" }),
  spend: async (_a, _b, key) => ({ verdict: "ok", charged: true, attempt: key }),
  release: async () => "settled",
  manageLink: async () => null,
  releaseAccount: async () => "none",
};

async function seeded() {
  const { db, deps } = await makeDeps();
  const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
  const [mb] = await db.insert(mailboxes).values({
    accountId: s.accountId, provider: "imap", address: "export@wall.test",
    signature: "— me", status: "connected",
  }).returning();
  await db.insert(contacts).values({ accountId: s.accountId, address: "friend@example.com" });
  await db.insert(rules).values({
    accountId: s.accountId, kind: "domain", match: "feed.example", destination: "ohmail/Reads", priority: 3,
  });
  await db.insert(tags).values({ accountId: s.accountId, name: "travel" });
  await db.insert(awayResponders).values({
    accountId: s.accountId, enabled: true, body: "Back soon.", audience: "screened_in",
    throttle: "per_day", piles: ["INBOX"], enabledAt: FIXED_NOW,
  });
  return { db, deps, s, mailboxId: mb!.id };
}

/** Every key of a JSON document, dotted, so the refusal names the exact path. */
function keysOf(value: unknown, path = ""): string[] {
  if (Array.isArray(value)) return value.flatMap((v, i) => keysOf(v, `${path}[${i}]`));
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).flatMap(([k, v]) => [`${path}.${k}`, ...keysOf(v, `${path}.${k}`)]);
  }
  return [];
}

describe("GET /account/export", () => {
  it("is on apiRoutes and NOT on the local door — a local install's data is already local", () => {
    const key = (r: { method: string; pattern: string }): string => `${r.method} ${r.pattern}`;
    expect(apiRoutes.map(key)).toContain("GET /account/export");
    expect(localRoutes.map(key)).not.toContain("GET /account/export");
  });

  it("the per-mailbox document IS the worker's own — one serializer, byte for byte", async () => {
    const { db, deps, s, mailboxId } = await seeded();
    const res = await H(req("GET", "/account/export", { bearer: s.token }), deps);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.v).toBe(1);
    expect(body.mailboxes).toHaveLength(1);
    const published = await serializeOrganizerProfile(db, s.accountId, mailboxId);
    expect(JSON.stringify(body.mailboxes[0].profile)).toBe(JSON.stringify(published));
    // The seeds are IN it — an equality against an accidentally-empty document proves nothing.
    expect(JSON.stringify(published)).toContain("friend@example.com");
    expect(JSON.stringify(published)).toContain("feed.example");
    expect(body.settings.screeningScope).toBeDefined();
    // Under every bound nothing is left out, and the export says so beside the document.
    expect(body.mailboxes[0].leftOut).toEqual({ screener: 0, rules: 0, notifyRules: 0, tagNames: 0 });
  });

  it("carries the impersonation filing as a choice: on by default, off once turned off", async () => {
    const { db, deps, s } = await seeded();
    const read = async () => (await (await H(req("GET", "/account/export", { bearer: s.token }), deps)).json()).settings;
    expect((await read()).impersonationFiling).toBe(true);
    await db.insert(accountSettings).values({ accountId: s.accountId, impersonationFilingOffAt: FIXED_NOW })
      .onConflictDoUpdate({ target: accountSettings.accountId, set: { impersonationFilingOffAt: FIXED_NOW } });
    expect((await read()).impersonationFiling).toBe(false);
  });

  it("NO key of the document matches a credential shape", async () => {
    const { deps, s } = await seeded();
    const body = await (await H(req("GET", "/account/export", { bearer: s.token }), deps)).json();
    const credentialShaped = keysOf(body).filter((k) => /password|token|secret|refresh|oauth/i.test(k));
    expect(credentialShaped, "an export must not carry a credential-shaped field").toEqual([]);
    // The positive control on the scanner itself: a planted key IS found.
    expect(keysOf({ a: [{ imapPassword: "x" }] }).some((k) => /password/i.test(k))).toBe(true);
  });

  it("is OPEN UNDER THE WALL — a refused account exports, and its product doors still 402", async () => {
    const { db, deps: base } = await makeDeps();
    const deps = {
      ...base,
      services: { ...base.services, entitlementsPort: refusing },
    } as ApiDeps;
    const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
    const res = await H(req("GET", "/account/export", { bearer: s.token }), deps);
    expect(res.status).toBe(200);
    expect((await res.json()).v).toBe(1);
    // The control that keeps this from passing for a gate that opened everything.
    expect((await H(req("GET", "/mailboxes", { bearer: s.token }), deps)).status).toBe(402);
  });
});
