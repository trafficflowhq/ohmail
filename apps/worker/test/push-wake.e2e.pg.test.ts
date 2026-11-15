import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { and, eq } from "drizzle-orm";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { accounts, recordChange, sessions, users } from "@trafficflow/db";
import { schema, pushSubscriptions, makeChangeWakeHub } from "@trafficflow/db/cloud";
import {
  makePushEndpointGuard, makeVapidIdentity,
  type HostResolver, type VapidFromEnv,
} from "@trafficflow/core/net";
import { makeAuthService, makePushService, makeTestAuthDeps } from "@trafficflow/services";
import { startPushWake, WAKE_BODY, type PushWakePost } from "../src/push-wake.js";
import type { Tx } from "@trafficflow/db";
import {
  makeSubscriber, openAes128Gcm, parseVapidAuthorization,
} from "../../../packages/core/test/webpush-subscriber.js";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 * ACCEPTANCE — new-mail wake, END TO END, BOTH ARMS, NO PHONE
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * The whole pipeline, with only the distributor replaced by a local listener:
 *
 *   `PushService.subscribe` (the real registration route's service, with the real endpoint gate)
 *      → `push_subscriptions` (real Postgres)
 *      → `recordChange` (the real change-log chokepoint, real `pg_notify` at commit)
 *      → `makeChangeWakeHub` (the real LISTEN, real fan-out, `subscribeAll`)
 *      → `startPushWake` (the real debounce, the real send-time gate)
 *      → a real HTTP server on loopback, which is standing in for `ntfy` and nothing else.
 *
 * ── WHY REAL POSTGRES AND NOT PGlite ─────────────────────────────────────────────────────────
 *
 * The wake path IS the NOTIFY path. PGlite has no second backend, so a NOTIFY is delivered
 * without ever crossing a wire and "queued at NOTIFY, delivered at COMMIT" cannot be observed
 * at all — a hub that subscribed the wrong backend would pass. The coalescing window, the LISTEN
 * fan-out and the prune are all only meaningful against a server two connections can share.
 *
 * ── THE TWO ARMS, AND WHAT EACH ONE CAN PROVE THAT THE OTHER CANNOT ──────────────────────────
 *
 * MANAGED: the STRICT gate — https only, public addresses only — with an injected resolver that
 * answers a public address for the test's hostname. This is the arm that proves the PERMIT branch
 * of the strict gate executes, that the pin is the address the gate cleared, and that the whole
 * debounce/coalesce/prune/revoke behaviour holds under it. It cannot dial the local listener,
 * because a listener on loopback is exactly what the strict gate exists to refuse — so its POST
 * port is injected and the assertion is about arguments.
 *
 * SELF-HOST: the RELAXED gate (`TF_PUSH_ALLOW_PRIVATE=1`'s policy), a REAL listener on loopback,
 * and the REAL `defaultPost`. This is the arm that proves the BYTES: the method, the path, the
 * headers and a body byte-identical to the constant. One arm proves the policy, the other proves
 * the wire; neither alone is the acceptance.
 *
 * ── WHAT IS STILL THE OWNER'S ────────────────────────────────────────────────────────────────
 *
 * A real UnifiedPush distributor delivering to a real phone. Nothing here can stand in for the
 * distributor's own forwarding or for what an Android connector does with the bytes once they
 * arrive; that is a phone test and it is named as such in the slice report.
 */

const AVAILABLE = await realPgAvailable();

/** A resolver that answers whatever the test says, so no case depends on DNS being reachable. */
function fixedResolver(map: Record<string, string[]>): HostResolver {
  return { async resolve(h) { return map[h] ?? []; } };
}

/**
 * The single-shard answer. The shipped configuration is one shard, where `accountInShard` returns
 * true without touching the database; the sharded case has its own test rather than being smuggled
 * in as a default here.
 */
const OWN_ALL = async (): Promise<boolean> => true;

/** A public, non-reserved address — not TEST-NET, which the gate blocks by design. */
const PUBLIC_IP = "93.184.216.34";

/**
 * A deployment with NO VAPID keypair — which is what every case below except the sealed one wants.
 *
 * Named rather than inlined because it says which ARM each test is exercising: with no keypair the
 * sender takes the plaintext path for keyless registrations, which is the behaviour every one of
 * these cases was written against and which must not change now that an encrypted path exists.
 */
const NO_VAPID: VapidFromEnv = { kind: "absent", why: "no VAPID keypair is configured" };

interface Captured {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  /** RAW BYTES. A sealed wake is not text, and `toString("utf8")` on it would corrupt the bytes. */
  raw: Buffer;
  body: string;
}

/** A local HTTP listener standing in for the distributor. `status` is what it answers next. */
async function listener(): Promise<{
  origin: string;
  captured: Captured[];
  setStatus: (s: number) => void;
  close: () => void;
}> {
  const captured: Captured[] = [];
  let status = 201;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks);
      captured.push({
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        raw,
        body: raw.toString("utf8"),
      });
      res.writeHead(status).end();
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  return {
    origin: `http://127.0.0.1:${port}`,
    captured,
    setStatus: (s) => { status = s; },
    close: () => { server.close(); },
  };
}

const waitFor = async (p: () => boolean, ms = 8_000): Promise<void> => {
  const end = Date.now() + ms;
  while (!p()) {
    if (Date.now() > end) return;               // the assertion after this reports what is missing
    await new Promise((r) => { setTimeout(r, 20); });
  }
};
const tick = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms); });

describe.skipIf(!AVAILABLE)("acceptance — the new-mail wake, both arms", () => {
  let sql: ReturnType<typeof postgres>;
  let dz: ReturnType<typeof drizzle>;
  let db: Tx;
  /** A wake registration names an account that exists (cloud 0103's key). */
  const anAccount = async (): Promise<string> =>
    (await db.insert(accounts).values({ name: `wake-${randomUUID()}` }).returning())[0]!.id;

  /**
   * WAIT FOR THE HUB'S LISTEN TO BE LIVE, by proving it delivers.
   *
   * `makeChangeWakeHub` dials LAZILY and asynchronously — `subscribe` registers the callback and
   * returns, and the LISTEN is established on a promise nobody exposes. That is correct for
   * production (a hub whose LISTEN is not up yet degrades to the client's own poll, which is the
   * documented reliability floor) and it is a race in a test: a `recordChange` that commits before
   * the LISTEN exists emits its NOTIFY to nobody, and Postgres does not replay it.
   *
   * Measured: the revoke case failed with `expected +0 to be 1` after waiting the full 8 s,
   * because its control append landed in exactly that window. So the control is RETRIED until it
   * is observed, and only then does the test assert anything. Everything after this point is
   * deterministic, which is what lets the later absences ("no wake after revoke") mean absence
   * rather than "the LISTEN was still coming up".
   */
  const settleHub = async (accountId: string, seen: () => number): Promise<void> => {
    const start = seen();
    const deadline = Date.now() + 15_000;
    while (seen() === start && Date.now() < deadline) {
      await mail(accountId);
      await waitFor(() => seen() > start, 400);
    }
  };

  /** One committed change-log append for `accountId` — the real chokepoint, the real NOTIFY. */
  const mail = (accountId: string): Promise<unknown> => dz.transaction((tx) =>
    recordChange(tx as unknown as Tx, {
      accountId, entityType: "message", entityId: randomUUID(), op: "create",
    }));

  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    sql = postgres(PG_TEST_URL, { max: 6, onnotice: () => { /* quiet */ } });
    dz = brandDialect(drizzle(sql, { schema }), "pg");
    db = dz as unknown as Tx;
  }, 120_000);

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
  });

  /** A service context shaped the way the routes build one. */
  const ctxFor = (accountId: string, sessionId?: string): Parameters<
    ReturnType<typeof makePushService>["subscribe"]
  >[0] => ({
    accountId,
    db,
    now: () => new Date(),
    ...(sessionId ? { sessionId } : {}),
  } as unknown as Parameters<ReturnType<typeof makePushService>["subscribe"]>[0]);

  it("MANAGED ARM — registers a public endpoint, wakes once per batch, coalesces, prunes, revokes", async () => {
    const accountId = await anAccount();
    const host = "push.managed-arm.example.com";
    const endpoint = `https://${host}/up/${randomUUID()}`;

    // The STRICT policy, exactly as `apps/api-vercel/src/deps.ts` builds it, with the DNS port
    // injected so this test never depends on the sandbox resolving anything.
    const guard = makePushEndpointGuard(
      fixedResolver({ [host]: [PUBLIC_IP] }), { allowPrivate: false },
    );
    const push = makePushService({ endpointGuard: guard });

    // ── REGISTRATION, through the real service. The gate runs here.
    const reg = await push.subscribe(ctxFor(accountId), { transport: "unifiedpush", endpoint });
    expect(reg.transport).toBe("unifiedpush");
    expect(reg.id).toMatch(/^[0-9a-f-]{36}$/);

    // Re-registering the SAME endpoint dedups to the same row (the coalesced UNIQUE), so a device
    // that calls register on every launch does not accumulate rows.
    const again = await push.subscribe(ctxFor(accountId), { transport: "unifiedpush", endpoint });
    expect(again.id).toBe(reg.id);

    const posts: { url: string; pin: readonly string[] }[] = [];
    let answer = 201;
    const post: PushWakePost = (url, pin) => {
      posts.push({ url, pin });
      return Promise.resolve({ status: answer });
    };

    const hub = makeChangeWakeHub(PG_TEST_URL);
    const wake = startPushWake({
      db, source: hub, guard, post, ownsAccount: OWN_ALL, vapid: NO_VAPID,
      debounceMs: 150,
      // ZERO on purpose: the per-endpoint floor is asserted in its own right elsewhere, and with a
      // floor in place this test cannot tell the ACCOUNT debounce from it. Measured — deleting the
      // account-level coalescing guard left the "two mails, one wake" assertion green because the
      // interval floor blocked the second POST for the wrong reason.
      minIntervalMs: 0,
    });

    try {
      // ── ONE PIECE OF MAIL → ONE WAKE. `settleHub` proves the LISTEN is live first, so the
      //    count below is about the sender and not about a connection that was still coming up.
      await settleHub(accountId, () => posts.length);
      expect(posts.length, "the committed change never produced a wake").toBeGreaterThanOrEqual(1);
      expect(posts[0]!.url).toBe(endpoint);
      // THE PIN IS THE ADDRESS THE GATE CLEARED — not the hostname, not a re-resolution.
      expect(posts[0]!.pin).toEqual([PUBLIC_IP]);

      // ── A RAPID SECOND MAIL COALESCES. Two commits inside one debounce window ⇒ one more POST,
      //    not two — and with `minIntervalMs: 0` the ACCOUNT window is the only thing that can
      //    produce that, which is what makes this assertion about the debounce rather than about
      //    the per-endpoint floor.
      const before = posts.length;
      await mail(accountId);
      await mail(accountId);
      await waitFor(() => posts.length > before);
      await tick(400);                                  // and give a second POST time to appear
      expect(posts.length - before, "two mails inside one window sent two wakes").toBe(1);

      // ── A DEAD ENDPOINT (410) IS PRUNED, and the row really goes.
      answer = 410;
      await tick(120);
      await mail(accountId);
      await tick(500);
      const left = await db.select({ id: pushSubscriptions.id }).from(pushSubscriptions)
        .where(and(
          eq(pushSubscriptions.accountId, accountId),
          eq(pushSubscriptions.transport, "unifiedpush"),
        ));
      expect(left, "a 410 did not prune the dead registration").toHaveLength(0);

      // ── AND WITH NO REGISTRATION THERE ARE NO WAKES. This is also the revoke assertion: the
      //    row is gone, so the next mail POSTs nothing.
      const afterPrune = posts.length;
      await tick(120);
      await mail(accountId);
      await tick(500);
      expect(posts.length, "a wake went out for a revoked registration").toBe(afterPrune);
    } finally {
      wake.stop();
      await hub.end();
    }
  }, 60_000);

  it("MANAGED ARM — an explicit unsubscribe stops wakes", async () => {
    const accountId = await anAccount();
    const host = "push.revoke-arm.example.com";
    const endpoint = `https://${host}/up/${randomUUID()}`;
    const guard = makePushEndpointGuard(
      fixedResolver({ [host]: [PUBLIC_IP] }), { allowPrivate: false },
    );
    const push = makePushService({ endpointGuard: guard });
    const reg = await push.subscribe(ctxFor(accountId), { transport: "unifiedpush", endpoint });

    const posts: string[] = [];
    const post: PushWakePost = (url) => { posts.push(url); return Promise.resolve({ status: 201 }); };
    const hub = makeChangeWakeHub(PG_TEST_URL);
    const wake = startPushWake({
      db, source: hub, guard, post, ownsAccount: OWN_ALL, vapid: NO_VAPID,
      debounceMs: 100, minIntervalMs: 0,
    });

    try {
      await settleHub(accountId, () => posts.length);
      const control = posts.length;
      expect(control, "the control wake never fired, so the absence below proves nothing")
        .toBeGreaterThanOrEqual(1);

      // FORGET — the same call `DELETE /push/subscriptions/:id` makes.
      await push.unsubscribe(ctxFor(accountId), reg.id);

      await mail(accountId);
      await tick(500);
      expect(posts.length, "a forgotten registration still received a wake").toBe(control);
    } finally {
      wake.stop();
      await hub.end();
    }
  }, 60_000);

  it("DEVICES REVOKE — a revoked browser's registration goes, and only the live browser is woken", async () => {
    // Two real live sessions of one person, each registering its own browser; the first presses
    // Devices revoke on the second. The control wake reaches both, the next one only the first.
    const [acct] = await db.insert(accounts).values({ name: "wake-revoke" }).returning();
    const accountId = acct!.id;
    const [user] = await db.insert(users).values({ accountId, email: `wake-${randomUUID()}@lichtgrat.example` }).returning();
    const session = async (twofaAt: Date | null): Promise<string> => (await db.insert(sessions).values({
      accountId, userId: user!.id, familyId: randomUUID(), lastTwofaAt: twofaAt,
      accessExpiresAt: new Date(Date.now() + 3_600_000), refreshExpiresAt: new Date(Date.now() + 3_600_000),
    }).returning({ id: sessions.id }))[0]!.id;
    const kept = await session(new Date());
    const revoked = await session(null);

    const host = "push.revoke-browser.example.com";
    const guard = makePushEndpointGuard(fixedResolver({ [host]: [PUBLIC_IP] }), { allowPrivate: false });
    const push = makePushService({ endpointGuard: guard });
    const sub = makeSubscriber();
    const liveEndpoint = `https://${host}/wp/${randomUUID()}`;
    const goneEndpoint = `https://${host}/wp/${randomUUID()}`;
    await push.subscribe(ctxFor(accountId, kept), { transport: "webpush", endpoint: liveEndpoint, p256dh: sub.p256dh, auth: sub.auth });
    const gone = await push.subscribe(ctxFor(accountId, revoked), { transport: "webpush", endpoint: goneEndpoint, p256dh: sub.p256dh, auth: sub.auth });

    const kp = makeSubscriber();
    const vapid: VapidFromEnv = {
      kind: "configured",
      identity: makeVapidIdentity({ publicKey: kp.p256dh, privateKey: kp.privateKey.toString("base64url") }),
    };
    const posts: string[] = [];
    const post: PushWakePost = (url) => { posts.push(url); return Promise.resolve({ status: 201 }); };
    const hub = makeChangeWakeHub(PG_TEST_URL);
    const wake = startPushWake({
      db, source: hub, guard, post, ownsAccount: OWN_ALL, vapid, debounceMs: 100, minIntervalMs: 0,
    });

    try {
      await settleHub(accountId, () => posts.length);
      await waitFor(() => posts.length >= 2);
      expect(new Set(posts), "the control wake did not reach both browsers").toEqual(new Set([liveEndpoint, goneEndpoint]));

      await makeAuthService(makeTestAuthDeps()).revokeDevice(
        { ...ctxFor(accountId, kept), userId: user!.id, requestId: "wake-revoke" } as Parameters<ReturnType<typeof makeAuthService>["revokeDevice"]>[0],
        revoked,
      );
      const rows = await db.select({ id: pushSubscriptions.id }).from(pushSubscriptions).where(eq(pushSubscriptions.id, gone.id));
      expect(rows, "the revoked browser's registration is still there").toEqual([]);

      await tick(400);                                  // a wake already in flight lands before the count
      const before = posts.length;
      await mail(accountId);
      await waitFor(() => posts.length > before);
      await tick(300);
      expect(posts.slice(before), "a wake went to the revoked browser, or none to the live one").toEqual([liveEndpoint]);
    } finally {
      wake.stop();
      await hub.end();
    }
  }, 60_000);

  it("SELF-HOST ARM — the real POST on a real socket carries the byte-identical constant", async () => {
    const l = await listener();
    const accountId = await anAccount();
    const endpoint = `${l.origin}/up/${randomUUID()}`;

    // The RELAXED policy — `TF_PUSH_ALLOW_PRIVATE=1`'s branch. Loopback is permitted, http is
    // permitted, and the pin is still computed (the literal is its own pin).
    const guard = makePushEndpointGuard(fixedResolver({}), { allowPrivate: true });
    const push = makePushService({ endpointGuard: guard });
    await push.subscribe(ctxFor(accountId), { transport: "unifiedpush", endpoint });

    const hub = makeChangeWakeHub(PG_TEST_URL);
    // NO injected post: the real `defaultPost`, on a real socket, pinned to 127.0.0.1.
    const wake = startPushWake({
      db, source: hub, guard, ownsAccount: OWN_ALL, vapid: NO_VAPID,
      debounceMs: 100, minIntervalMs: 0,
    });

    try {
      await settleHub(accountId, () => l.captured.length);
      expect(l.captured.length, "no request reached the listener").toBeGreaterThanOrEqual(1);

      const c = l.captured[0]!;
      expect(c.method).toBe("POST");
      expect(c.url).toBe(new URL(endpoint).pathname);
      expect(c.body).toBe(WAKE_BODY);
      expect(Buffer.byteLength(c.body, "utf8")).toBe(15);
      expect(c.headers["content-type"]).toBe("application/json");
      expect(c.headers["content-length"]).toBe("15");
      expect(c.headers.ttl).toBe("240");
      // No authorization, no cookie, no custom ohmail header: a wake identifies nothing.
      expect(c.headers.authorization).toBeUndefined();
      expect(c.headers.cookie).toBeUndefined();
      expect(Object.keys(c.headers).some((k) => k.toLowerCase().startsWith("x-ohmail"))).toBe(false);
      // And the account id is nowhere in the request.
      expect(`${c.url}\n${JSON.stringify(c.headers)}\n${c.body}`).not.toContain(accountId);

      await waitFor(() => wake.sent() >= 1);
      // The counter is incremented when the POST RESOLVES, which is strictly after the listener
      // saw the request — read through `waitFor`, never straight after. Measured as a latent flake
      // (`expected +0 to be 1`) before this wait existed.
      expect(wake.sent()).toBe(l.captured.length);
    } finally {
      wake.stop();
      await hub.end();
      l.close();
    }
  }, 60_000);

  it("SEALED ARM — a keyed registration receives an ENCRYPTED wake that decrypts to the constant", async () => {
    /**
     * ══════════════════════════════════════════════════════════════════════════════════════
     *  THE ACCEPTANCE, AND THE ONLY BRANCH NO PHONE-LESS TEST COULD REACH BEFORE
     * ══════════════════════════════════════════════════════════════════════════════════════
     *
     * Everything above proves the pipeline for a raw consumer. This proves it for a CONNECTOR: the
     * keys a UnifiedPush connector hands the app go in through the REAL `PushService.subscribe`
     * (not written to the table by hand — the service is what stores them, and a test that
     * inserted the row directly would prove nothing about whether registration keeps them), the
     * real change-log NOTIFY drives the real sender, and the body that lands on the socket is
     * opened with the subscriber's own private key.
     *
     * The keyed branch is otherwise unreachable without a real device, which is precisely the
     * "built, tested, unreachable" shape this repository has been bitten by: `push_subscriptions`
     * had no sender for months. So the branch that only a phone can exercise in production is
     * exercised here by a synthetic device that is real in every respect the code can observe.
     */
    const l = await listener();
    const accountId = await anAccount();
    const endpoint = `${l.origin}/up/${randomUUID()}`;
    const sub = makeSubscriber();

    const guard = makePushEndpointGuard(fixedResolver({}), { allowPrivate: true });
    const push = makePushService({ endpointGuard: guard });

    // ── REGISTRATION WITH KEYS, through the real service. This is the call `POST
    //    /push/subscriptions` makes when the connector reported `{url, pubKey, auth}`.
    const reg = await push.subscribe(ctxFor(accountId), {
      transport: "unifiedpush", endpoint, p256dh: sub.p256dh, auth: sub.auth,
    });
    expect(reg.transport).toBe("unifiedpush");

    // The keys really are in the table — the sender reads them from there, so a registration that
    // dropped them would make everything below pass through the plaintext arm instead.
    const stored = await db.select({
      p256dh: pushSubscriptions.p256dh, auth: pushSubscriptions.auth,
    }).from(pushSubscriptions).where(and(
      eq(pushSubscriptions.accountId, accountId),
      eq(pushSubscriptions.transport, "unifiedpush"),
    ));
    expect(stored).toHaveLength(1);
    expect(stored[0]!.p256dh).toBe(sub.p256dh);
    expect(stored[0]!.auth).toBe(sub.auth);

    // A deployment WITH a keypair. Generated here so the test owns both halves and can verify the
    // signature the way a push service would.
    const kp = makeSubscriber();          // reused only as a source of a P-256 keypair
    const vapidPublic = kp.p256dh;
    const vapid: VapidFromEnv = {
      kind: "configured",
      identity: makeVapidIdentity({
        publicKey: vapidPublic,
        privateKey: kp.privateKey.toString("base64url"),
        subject: "mailto:ops@selfhost.example",
      }),
    };

    const hub = makeChangeWakeHub(PG_TEST_URL);
    // NO injected post: the real `defaultPost`, on a real socket, doing the real encryption.
    const wake = startPushWake({
      db, source: hub, guard, ownsAccount: OWN_ALL, vapid,
      debounceMs: 100, minIntervalMs: 0,
    });

    try {
      await settleHub(accountId, () => l.captured.length);
      expect(l.captured.length, "no request reached the listener").toBeGreaterThanOrEqual(1);
      const c = l.captured[0]!;

      // ── THE BODY IS SEALED, AND IT OPENS TO THE CONSTANT.
      expect(c.headers["content-encoding"]).toBe("aes128gcm");
      expect(c.headers["content-type"]).toBe("application/octet-stream");
      expect(c.raw).toHaveLength(118);
      expect(c.headers["content-length"]).toBe("118");
      // Not the plaintext on the wire — otherwise the decryption below would be vacuous.
      expect(c.raw.toString("utf8")).not.toBe(WAKE_BODY);
      expect(openAes128Gcm(c.raw, sub).toString("utf8")).toBe(WAKE_BODY);
      // And no OTHER device can open it.
      expect(() => openAes128Gcm(c.raw, makeSubscriber())).toThrow();

      // ── THE VAPID HEADER IS REAL: it verifies against the key a phone would have registered
      //    with, which is the whole reason the connector will render this.
      const parsed = parseVapidAuthorization(String(c.headers.authorization));
      expect(parsed.verified, "the wake's signature does not verify").toBe(true);
      expect(parsed.k).toBe(vapidPublic);
      expect(Object.keys(parsed.claims).sort()).toEqual(["aud", "exp", "sub"]);
      expect(parsed.claims.aud).toBe(l.origin);

      // ── AND IT IS STILL CONTENT-FREE. The account id is in neither the ciphertext nor any
      //    header, and the request line is the registered path with nothing appended.
      expect(c.url).toBe(new URL(endpoint).pathname);
      const whole = `${c.url}\n${JSON.stringify(c.headers)}\n${c.raw.toString("binary")}`;
      expect(whole).not.toContain(accountId);
      expect(whole).not.toContain(sub.auth);

      await waitFor(() => wake.sent() >= 1);
      expect(wake.sent()).toBe(l.captured.length);
      // Nothing was skipped: this deployment CAN seal, so a keyed row is a delivery.
      expect(wake.skipped()).toBe(0);
    } finally {
      wake.stop();
      await hub.end();
      l.close();
    }
  }, 60_000);

  it("BROWSER ARM — a `webpush` registration is DIALLED, and its wake decrypts to the constant", async () => {
    /**
     * THE ROWS THAT WERE STORED AND NEVER DIALLED.
     *
     * `POST /push/subscriptions` has validated and written `webpush` rows since it existed — the
     * transport is one of the three it accepts, and it requires `endpoint`, `p256dh` and `auth`
     * before writing one. The SENDER did not read them: its predicate named `unifiedpush` alone,
     * so a browser could register successfully, see a row in the table, and never be woken. The
     * "built, tested, unreachable" shape this file's keyed test already warns about, one transport
     * over.
     *
     * This is the guard for the predicate. It is deliberately an END-TO-END assertion rather than
     * a unit test of the WHERE clause: what matters is not that the query mentions a string, but
     * that a real registration made the way a browser makes it results in a real POST carrying the
     * real constant. A test that asserted the predicate's text would pass on a sender that dialled
     * nothing.
     *
     * The keys are not optional here the way they are for a connector: a browser subscription
     * always has both, so this row necessarily takes the SEALED arm — which is why no separate
     * plaintext case exists for it.
     */
    const l = await listener();
    const accountId = await anAccount();
    const endpoint = `${l.origin}/wp/${randomUUID()}`;
    const sub = makeSubscriber();

    const guard = makePushEndpointGuard(fixedResolver({}), { allowPrivate: true });
    const push = makePushService({ endpointGuard: guard });

    // Registration exactly as a browser makes it: the three values `PushSubscription` yields.
    const reg = await push.subscribe(ctxFor(accountId), {
      transport: "webpush", endpoint, p256dh: sub.p256dh, auth: sub.auth,
    });
    expect(reg.transport).toBe("webpush");

    const stored = await db.select({ id: pushSubscriptions.id })
      .from(pushSubscriptions).where(and(
        eq(pushSubscriptions.accountId, accountId),
        eq(pushSubscriptions.transport, "webpush"),
      ));
    expect(stored, "the browser registration did not land as a webpush row").toHaveLength(1);

    const kp = makeSubscriber();
    const vapid: VapidFromEnv = {
      kind: "configured",
      identity: makeVapidIdentity({
        publicKey: kp.p256dh,
        privateKey: kp.privateKey.toString("base64url"),
        subject: "mailto:ops@selfhost.example",
      }),
    };

    const hub = makeChangeWakeHub(PG_TEST_URL);
    const wake = startPushWake({
      db, source: hub, guard, ownsAccount: OWN_ALL, vapid,
      debounceMs: 100, minIntervalMs: 0,
    });

    try {
      await settleHub(accountId, () => l.captured.length);
      expect(
        l.captured.length,
        "a webpush row was stored and never dialled — the predicate does not include it",
      ).toBeGreaterThanOrEqual(1);

      const c = l.captured[0]!;
      // Sealed to THIS browser, and it opens to the same fifteen bytes as every other arm.
      expect(c.headers["content-encoding"]).toBe("aes128gcm");
      expect(openAes128Gcm(c.raw, sub).toString("utf8")).toBe(WAKE_BODY);
      expect(() => openAes128Gcm(c.raw, makeSubscriber())).toThrow();

      // Still content-free: widening WHICH rows are dialled must not widen WHAT is sent.
      expect(c.url).toBe(new URL(endpoint).pathname);
      const whole = `${c.url}\n${JSON.stringify(c.headers)}\n${c.raw.toString("binary")}`;
      expect(whole).not.toContain(accountId);
      expect(whole).not.toContain(sub.auth);

      await waitFor(() => wake.sent() >= 1);
      expect(wake.skipped()).toBe(0);
    } finally {
      wake.stop();
      await hub.end();
      l.close();
    }
  }, 60_000);

  it("SEALED ARM — with NO keypair, a keyed registration is SKIPPED rather than sent in the clear", async () => {
    /**
     * The wrong-configuration drill, run deliberately. A deployment that stores keys and cannot
     * seal must not send the plaintext constant: the distributor would answer 2xx, the counter
     * would say "sent", and the connector on the phone would discard the body. That is a delivery
     * that is not one, and nothing on the wire would ever say so.
     */
    const l = await listener();
    const accountId = await anAccount();
    const endpoint = `${l.origin}/up/${randomUUID()}`;
    const sub = makeSubscriber();

    const guard = makePushEndpointGuard(fixedResolver({}), { allowPrivate: true });
    const push = makePushService({ endpointGuard: guard });
    await push.subscribe(ctxFor(accountId), {
      transport: "unifiedpush", endpoint, p256dh: sub.p256dh, auth: sub.auth,
    });

    const warnings: string[] = [];
    const hub = makeChangeWakeHub(PG_TEST_URL);
    const wake = startPushWake({
      db, source: hub, guard, ownsAccount: OWN_ALL, vapid: NO_VAPID,
      debounceMs: 100, minIntervalMs: 0,
      log: { info: () => { /* quiet */ }, warn: (e) => { warnings.push(e); } },
    });

    try {
      // The CONTROL is the skip counter rather than a delivery: there is nothing to deliver. The
      // hub still has to be live for the absence to mean anything, so this waits on the skip.
      const deadline = Date.now() + 15_000;
      while (wake.skipped() === 0 && Date.now() < deadline) {
        await mail(accountId);
        await waitFor(() => wake.skipped() > 0, 400);
      }
      expect(wake.skipped(), "the keyed row was never even considered").toBeGreaterThanOrEqual(1);

      // NOTHING went to the listener — not a plaintext body, not anything.
      expect(l.captured, "a plaintext wake was sent to a device that cannot read it").toEqual([]);
      expect(wake.sent()).toBe(0);
      // And the reason was said exactly once, however many wakes went by.
      expect(warnings.filter((w) => w === "push_wake_vapid_unconfigured")).toHaveLength(1);

      // The row SURVIVES: it becomes deliverable the moment an operator sets a keypair.
      const rows = await db.select({ id: pushSubscriptions.id }).from(pushSubscriptions)
        .where(and(
          eq(pushSubscriptions.accountId, accountId),
          eq(pushSubscriptions.transport, "unifiedpush"),
        ));
      expect(rows, "a skipped registration was pruned").toHaveLength(1);
    } finally {
      wake.stop();
      await hub.end();
      l.close();
    }
  }, 60_000);

  it("SEALED ARM — the SSRF gate still runs on the encrypted path", async () => {
    /**
     * Encryption is not an exemption. The gate's job is deciding which SOCKET may be opened, and a
     * sealed body says nothing about where it is going — a re-pointed endpoint on a keyed
     * registration is the same attack with a different payload, so it gets the same refusal.
     */
    const accountId = await anAccount();
    const host = "sealed-flips.example.com";
    const endpoint = `https://${host}/up/${randomUUID()}`;
    const sub = makeSubscriber();

    let answers = [PUBLIC_IP];
    const resolver: HostResolver = { async resolve(h) { return h === host ? answers : []; } };
    const guard = makePushEndpointGuard(resolver, { allowPrivate: false });
    const push = makePushService({ endpointGuard: guard });
    await push.subscribe(ctxFor(accountId), {
      transport: "unifiedpush", endpoint, p256dh: sub.p256dh, auth: sub.auth,
    });

    const kp = makeSubscriber();
    const vapid: VapidFromEnv = {
      kind: "configured",
      identity: makeVapidIdentity({
        publicKey: kp.p256dh, privateKey: kp.privateKey.toString("base64url"),
      }),
    };

    const posts: { url: string; keys: unknown }[] = [];
    const warnings: string[] = [];
    const post: PushWakePost = (url, _pin, keys) => {
      posts.push({ url, keys });
      return Promise.resolve({ status: 201 });
    };
    const hub = makeChangeWakeHub(PG_TEST_URL);
    const wake = startPushWake({
      db, source: hub, guard, post, ownsAccount: OWN_ALL, vapid,
      debounceMs: 100, minIntervalMs: 0,
      log: { info: () => { /* quiet */ }, warn: (e) => { warnings.push(e); } },
    });

    try {
      await settleHub(accountId, () => posts.length);
      const control = posts.length;
      expect(control, "the control wake never fired").toBeGreaterThanOrEqual(1);
      // The control also proves the KEYS reached the seam — otherwise the refusal below could be
      // about the plaintext arm.
      expect(posts[0]!.keys).toEqual({ p256dh: sub.p256dh, auth: sub.auth });

      answers = ["169.254.169.254"];
      await mail(accountId);
      await waitFor(() => warnings.includes("push_wake_endpoint_refused"));
      await tick(300);

      expect(posts.length, "the re-pointed endpoint WAS dialled on the encrypted path").toBe(control);
      expect(warnings).toContain("push_wake_endpoint_refused");
    } finally {
      wake.stop();
      await hub.end();
    }
  }, 60_000);

  it("SSRF at REGISTRATION — a private-range endpoint is refused before any row is written", async () => {
    const accountId = await anAccount();
    const guard = makePushEndpointGuard(
      fixedResolver({ "rebind.example.com": ["169.254.169.254"] }), { allowPrivate: false },
    );
    const push = makePushService({ endpointGuard: guard });

    const refusals: [string, string][] = [
      ["a loopback literal", "https://127.0.0.1/up/x"],
      ["a private literal", "https://10.1.2.3/up/x"],
      ["link-local, the metadata address", "https://169.254.169.254/up/x"],
      ["an IPv6 loopback literal", "https://[::1]/up/x"],
      ["a v4-mapped loopback", "https://[::ffff:127.0.0.1]/up/x"],
      ["an octal-looking bypass", "https://0177.0.0.1/up/x"],
      ["a decimal-integer bypass", "https://2130706433/up/x"],
      ["a NAME that resolves into link-local", "https://rebind.example.com/up/x"],
      ["userinfo hiding the real host", "https://evil@127.0.0.1/up/x"],
      ["plain http on the strict arm", "http://push.example.com/up/x"],
      ["a non-http scheme", "gopher://push.example.com/up/x"],
      [".internal, which no resolver should be asked about", "https://vault.internal/up/x"],
    ];

    for (const [what, endpoint] of refusals) {
      await expect(
        push.subscribe(ctxFor(accountId), { transport: "unifiedpush", endpoint }),
        `${what} was ACCEPTED at registration`,
      ).rejects.toThrow(/not a permitted url|scheme must be/);
    }

    // Nothing was written by any of them.
    const rows = await db.select({ id: pushSubscriptions.id }).from(pushSubscriptions)
      .where(eq(pushSubscriptions.accountId, accountId));
    expect(rows, "a refused registration still wrote a row").toHaveLength(0);
  }, 60_000);

  it("SSRF at SEND — an endpoint RE-POINTED after registration is refused, and never dialled", async () => {
    /**
     * THE CASE REGISTRATION-TIME VALIDATION CANNOT COVER, and the reason the gate runs twice.
     *
     * The name answers a public address while the registration is being made, and a private one
     * by the time the worker dials it. Nothing about the stored row changed; the world did. A
     * design that cleared once and trusted the row forever would POST to `169.254.169.254` here.
     */
    const accountId = await anAccount();
    const host = "flips.example.com";
    const endpoint = `https://${host}/up/${randomUUID()}`;

    let answers = [PUBLIC_IP];
    const resolver: HostResolver = { async resolve(h) { return h === host ? answers : []; } };
    const guard = makePushEndpointGuard(resolver, { allowPrivate: false });
    const push = makePushService({ endpointGuard: guard });

    // Registered while the name is public — accepted, as it should be.
    await push.subscribe(ctxFor(accountId), { transport: "unifiedpush", endpoint });

    const posts: string[] = [];
    const warnings: string[] = [];
    const post: PushWakePost = (url) => { posts.push(url); return Promise.resolve({ status: 201 }); };
    const hub = makeChangeWakeHub(PG_TEST_URL);
    const wake = startPushWake({
      db, source: hub, guard, post, ownsAccount: OWN_ALL, vapid: NO_VAPID,
      debounceMs: 100, minIntervalMs: 0,
      log: { info: () => { /* quiet */ }, warn: (e) => { warnings.push(e); } },
    });

    try {
      // CONTROL: while the name is still public, a wake DOES go out. Without this, the absence
      // below would be indistinguishable from a pipeline that never worked.
      await settleHub(accountId, () => posts.length);
      const control = posts.length;
      expect(control, "the control wake never fired").toBeGreaterThanOrEqual(1);

      // THE FLIP. Same row, same endpoint string, different DNS answer.
      answers = ["169.254.169.254"];

      await mail(accountId);
      await waitFor(() => warnings.includes("push_wake_endpoint_refused"));
      await tick(300);

      expect(posts.length, "the re-pointed endpoint WAS dialled").toBe(control);
      expect(warnings).toContain("push_wake_endpoint_refused");

      // AND THE ROW SURVIVES. A refusal is not evidence the registration is dead — the name may
      // be fine again tomorrow, and pruning here would let one bad DNS answer erase a device.
      const rows = await db.select({ id: pushSubscriptions.id }).from(pushSubscriptions)
        .where(and(
          eq(pushSubscriptions.accountId, accountId),
          eq(pushSubscriptions.transport, "unifiedpush"),
        ));
      expect(rows, "an SSRF refusal deleted a registration it should only have skipped").toHaveLength(1);
    } finally {
      wake.stop();
      await hub.end();
    }
  }, 60_000);

  it("a host that never wired the endpoint policy REFUSES unifiedpush, rather than storing it", async () => {
    // The absent-config-safe branch. `pushService` (the plain singleton) is what a composition
    // root gets by forgetting, and forgetting must not mean "accept an unvalidated endpoint".
    const { pushService } = await import("@trafficflow/services");
    const accountId = await anAccount();
    await expect(pushService.subscribe(
      ctxFor(accountId), { transport: "unifiedpush", endpoint: "https://push.example.com/up/x" },
    )).rejects.toThrow(/not enabled on this server/);

    const rows = await db.select({ id: pushSubscriptions.id }).from(pushSubscriptions)
      .where(eq(pushSubscriptions.accountId, accountId));
    expect(rows).toHaveLength(0);
  }, 60_000);
});
