import { describe, it, expect } from "vitest";
import { createApp, apiRoutes, type ApiDeps } from "@trafficflow/api";
import { sessions } from "@trafficflow/db";
import { pushSubscriptions } from "@trafficflow/db/cloud";
import { eq } from "drizzle-orm";
import { makeDeps, seedSession, seedSessionFor, req, FIXED_NOW } from "./helpers.js";

const app = createApp(apiRoutes);
const H = (r: Request, d: ApiDeps): Promise<Response> => app.handle(r, { ...d, session: null, idempotency: null });

const WEBPUSH = { transport: "webpush", endpoint: "https://push.example/abc", p256dh: "key-p256", auth: "key-auth" };

describe("push subscriptions", () => {
  it("webpush subscribe with Idempotency-Key → 201; replay same key+body is verbatim (no dup row); different body same key → 409", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const body = JSON.stringify(WEBPUSH);

    const first = await H(req("POST", "/push/subscriptions", { bearer: s.token, headers: { "idempotency-key": "pk1" }, body }), deps);
    expect(first.status).toBe(201);
    const firstJson = await first.json();
    expect(firstJson.id).toBeTruthy();

    // Replay: verbatim, same id, no duplicate row.
    const replay = await H(req("POST", "/push/subscriptions", { bearer: s.token, headers: { "idempotency-key": "pk1" }, body }), deps);
    expect(replay.status).toBe(201);
    expect(await replay.json()).toEqual(firstJson);

    const rows = await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.accountId, s.accountId));
    expect(rows).toHaveLength(1);

    // Same key, different body → 409.
    const conflict = await H(req("POST", "/push/subscriptions", {
      bearer: s.token, headers: { "idempotency-key": "pk1" },
      body: JSON.stringify({ ...WEBPUSH, endpoint: "https://push.example/different" }),
    }), deps);
    expect(conflict.status).toBe(409);
  });

  it("apns subscribe with deviceToken → 201; an identical apns sub is deduped by the unique index", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const apns = JSON.stringify({ transport: "apns", deviceToken: "dtok-123", bundleId: "ch.trafficflow", environment: "sandbox" });

    const first = await H(req("POST", "/push/subscriptions", { bearer: s.token, body: apns }), deps);
    expect(first.status).toBe(201);
    const id1 = (await first.json()).id;

    // Second identical (same account+transport+deviceToken), no idempotency key → deduped by index, same id.
    const second = await H(req("POST", "/push/subscriptions", { bearer: s.token, body: apns }), deps);
    expect(second.status).toBe(201);
    expect((await second.json()).id).toBe(id1);

    const rows = await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.accountId, s.accountId));
    expect(rows).toHaveLength(1);
  });

  it("a registration names its session's family; the same endpoint from a second session moves to it, and Devices revokes follow", async () => {
    const { db, deps } = await makeDeps();
    const s1 = await seedSession(db, { now: FIXED_NOW });
    const s2 = await seedSessionFor(db, { accountId: s1.accountId, userId: s1.userId, now: FIXED_NOW });
    const admin = await seedSessionFor(db, { accountId: s1.accountId, userId: s1.userId, now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
    const familyOf = async (id: string) => (await db.select({ f: sessions.familyId }).from(sessions).where(eq(sessions.id, id)))[0]!.f;
    const post = (bearer: string) => H(req("POST", "/push/subscriptions", { bearer, body: JSON.stringify(WEBPUSH) }), deps);

    const first = await post(s1.token);
    expect(first.status).toBe(201);
    const { id } = await first.json() as { id: string };
    const stamp = async () => {
      const [row] = await db.select({ f: pushSubscriptions.sessionFamilyId }).from(pushSubscriptions).where(eq(pushSubscriptions.id, id));
      return row ? row.f : "gone";
    };
    expect(await stamp()).toBe(await familyOf(s1.sessionId));

    const second = await post(s2.token);
    expect((await second.json() as { id: string }).id).toBe(id);
    expect(await stamp()).toBe(await familyOf(s2.sessionId));

    // The first session's take-back no longer reaches the row; the second's does.
    expect((await H(req("DELETE", `/devices/${s1.sessionId}`, { bearer: admin.token }), deps)).status).toBe(204);
    expect(await stamp()).toBe(await familyOf(s2.sessionId));
    expect((await H(req("DELETE", `/devices/${s2.sessionId}`, { bearer: admin.token }), deps)).status).toBe(204);
    expect(await stamp()).toBe("gone");
  });

  it("missing transport identity → 400", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const res = await H(req("POST", "/push/subscriptions", { bearer: s.token, body: JSON.stringify({ transport: "webpush", endpoint: "https://x" }) }), deps);
    expect(res.status).toBe(400);
  });

  it("DELETE own subscription → 204; deleting another account's subscription → 404", async () => {
    const { db, deps } = await makeDeps();
    const owner = await seedSession(db, { now: FIXED_NOW, token: "owner-tok" });
    const other = await seedSession(db, { now: FIXED_NOW, token: "other-tok" });

    const created = await H(req("POST", "/push/subscriptions", { bearer: owner.token, body: JSON.stringify(WEBPUSH) }), deps);
    const id = (await created.json()).id;

    // Cross-account delete → 404.
    expect((await H(req("DELETE", `/push/subscriptions/${id}`, { bearer: other.token }), deps)).status).toBe(404);
    // Owner delete → 204.
    expect((await H(req("DELETE", `/push/subscriptions/${id}`, { bearer: owner.token }), deps)).status).toBe(204);
    // Idempotent-ish: already gone → 404.
    expect((await H(req("DELETE", `/push/subscriptions/${id}`, { bearer: owner.token }), deps)).status).toBe(404);
  });
});

describe("GET /push/vapid-key — the key a connector needs before it can register", () => {
  /**
   * A UnifiedPush connector hands a VAPID public key to the device's distributor and thereafter
   * renders only wakes signed by the matching private half. The key is per-DEPLOYMENT, so the phone
   * has to ask; this is what it asks.
   *
   * The route lives beside the registration it feeds rather than on `GET /hello`, whose wire shape
   * is frozen and whose contents are grouped booleans. A `features.wake` flag there as well would
   * be a second source of truth that can disagree with this one — announced by the flag, refused by
   * the key — so there is deliberately only this.
   */
  const KEY = "B".repeat(87);

  it("serves the configured key to an authenticated caller", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const res = await H(req("GET", "/push/vapid-key", { bearer: s.token }), { ...deps, vapidPublicKey: KEY });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ publicKey: KEY });
  });

  it("answers `null` — NOT an error — when this deployment has no keypair", async () => {
    /**
     * The load-bearing case. A self-host whose operator has not generated a keypair is correctly
     * configured, just without encrypted wakes: mail still arrives, the app still syncs on
     * foreground, and a raw consumer still gets the plaintext wake. A 404 or 503 here would make the
     * app show an error for a server that is working as configured, so the answer is an honest null
     * that the app turns into one sentence.
     */
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    for (const configured of [undefined, null, "", "   "]) {
      const res = await H(
        req("GET", "/push/vapid-key", { bearer: s.token }),
        { ...deps, vapidPublicKey: configured as string | null | undefined },
      );
      expect(res.status, `vapidPublicKey=${JSON.stringify(configured)}`).toBe(200);
      expect(await res.json()).toEqual({ publicKey: null });
    }
  });

  it("answers EXACTLY one key and nothing else — no secret rides along", async () => {
    // The response shape is closed. This route is reachable by any authenticated account, so a
    // field added here would be disclosed to all of them; the body is one key by contract.
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const res = await H(req("GET", "/push/vapid-key", { bearer: s.token }), { ...deps, vapidPublicKey: KEY });
    expect(Object.keys(await res.json())).toEqual(["publicKey"]);
  });

  it("requires a credential — an unauthenticated read is refused", async () => {
    // Not because the key is secret (it goes to every device that registers, and travels in the
    // clear on every wake), but because there is no caller that needs it before pairing: the app
    // asks from an authenticated Settings pane, right before registering.
    const { deps } = await makeDeps();
    const res = await H(req("GET", "/push/vapid-key"), { ...deps, vapidPublicKey: KEY });
    expect(res.status).toBe(401);
  });
});
