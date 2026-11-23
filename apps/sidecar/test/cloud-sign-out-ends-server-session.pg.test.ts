import { createHash, randomBytes, randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { accounts, bindDb, devices, refreshTokens, sessions, users } from "@trafficflow/db";
import { authEvents, loginTokens, makeOwnedDb, type OwnedDb } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { apiRoutes, createApp, type ApiDeps } from "@trafficflow/api";
import { generateToken, hashToken, makeAuthService, makeTestAuthDeps, type Db } from "@trafficflow/services";

import { createCloudSidecar, type CloudSidecar } from "../src/cloud-engine.js";
import { mailboxList } from "./fixtures/hosted-mailbox.js";
import { freshDataDir } from "./_datadir.js";

/**
 * SIGN OUT ON A CLOUD DESKTOP ENDS ITS SESSION AT THE SERVER. The desktop's session is minted by
 * the real approval flow on this checkout's own database; the engine is handed that pair as a
 * sign-in hands it; the press is the request the shell sends (`DELETE /cloud/session`). The row,
 * not the engine's answer, is the verdict. The mirror's reads are canned: they are not the subject.
 */
const PG_UP = await realPgAvailable();
const START = new Date("2026-08-11T09:00:00.000Z");
const ACCESS_TTL_MS = 15 * 60_000;
const app = createApp(apiRoutes);

describe.skipIf(!PG_UP)("a Cloud desktop's sign-out at the server", () => {
  let owned: OwnedDb;
  let db: Db;
  let apiNow = START;
  const made: { userIds: string[]; accountIds: string[]; approvalIds: string[] } = {
    userIds: [], accountIds: [], approvalIds: [],
  };
  const dirs: string[] = [];
  const sidecars: CloudSidecar[] = [];

  const depsOn = (): ApiDeps => {
    const authDeps = makeTestAuthDeps({});
    // One container a request, its handle minted as the host mints a request's: bound to nothing.
    return {
      db: bindDb(db, { account: null }), now: () => apiNow, requestId: `pg-${randomUUID()}`, session: null,
      authConfig: authDeps.config, keyProvider: authDeps.keyProvider,
      services: { auth: makeAuthService(authDeps) },
    } as unknown as ApiDeps;
  };
  const freshIp = (): string => `198.18.${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 256)}`;
  const call = (method: string, path: string, body?: unknown, bearer?: string): Promise<Response> =>
    app.handle(new Request(`http://localhost${path}`, {
      method,
      headers: {
        "content-type": "application/json", "x-forwarded-for": freshIp(),
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }), depsOn());

  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    owned = makeOwnedDb(PG_TEST_URL);
    db = owned.db as unknown as Db;
  }, 60_000);

  afterEach(async () => {
    for (const s of sidecars.splice(0)) await s.stop().catch(() => undefined);
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    const { userIds, accountIds, approvalIds } = made;
    if (approvalIds.length) await db.delete(loginTokens).where(inArray(loginTokens.id, approvalIds));
    if (userIds.length) {
      await db.delete(authEvents).where(inArray(authEvents.userId, userIds));
      await db.delete(refreshTokens).where(inArray(refreshTokens.userId, userIds));
      await db.delete(sessions).where(inArray(sessions.userId, userIds));
      await db.delete(devices).where(inArray(devices.userId, userIds));
      await db.delete(users).where(inArray(users.id, userIds));
    }
    if (accountIds.length) await db.delete(accounts).where(inArray(accounts.id, accountIds));
    made.userIds = []; made.accountIds = []; made.approvalIds = [];
    apiNow = START;
  });

  afterAll(async () => {
    await owned?.close();
  });

  /** An account with a signed-in, stepped-up browser — the session that reads Settings → Devices. */
  async function account(): Promise<{ userId: string; browser: string }> {
    const browser = generateToken();
    const [acct] = await db.insert(accounts).values({ name: `signout-${randomUUID()}` }).returning();
    const [user] = await db.insert(users).values({
      accountId: acct!.id, email: `so-${randomUUID()}@example.com`, displayName: "S", emailVerifiedAt: START,
    }).returning();
    made.accountIds.push(acct!.id); made.userIds.push(user!.id);
    await db.insert(sessions).values({
      accountId: acct!.id, userId: user!.id, familyId: randomUUID(), accessTokenHash: hashToken(browser),
      accessExpiresAt: new Date(START.getTime() + 24 * 3_600_000),
      refreshExpiresAt: new Date(START.getTime() + 48 * 3_600_000), lastTwofaAt: START,
    });
    return { userId: user!.id, browser };
  }

  /** A desktop signed in by the browser approval, as a Cloud door's sign-in mints it. */
  async function desktop(browser: string, label: string): Promise<{ accessToken: string; refreshToken: string; expiresIn?: number }> {
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier, "utf8").digest("base64url");
    const asked = await call("POST", "/auth/desktop-approval", { challenge, kind: "desktop-linux", label });
    expect(asked.status, await asked.clone().text()).toBe(200);
    const { approvalId } = (await asked.json()) as { approvalId: string };
    made.approvalIds.push(approvalId);
    const ok = await call("POST", `/auth/desktop-approval/${approvalId}/confirm`, {}, browser);
    expect(ok.status, await ok.clone().text()).toBe(200);
    const claimed = await call("POST", "/auth/desktop-approval/claim", { approvalId, verifier, kind: "desktop-linux" });
    expect(claimed.status, await claimed.clone().text()).toBe(200);
    return ((await claimed.json()) as { tokens: { accessToken: string; refreshToken: string; expiresIn?: number } }).tokens;
  }

  /** The server's own answer about a token: its session row, by the hash the server stores. */
  const sessionOf = async (accessToken: string) =>
    (await db.select().from(sessions).where(eq(sessions.accessTokenHash, hashToken(accessToken))))[0];
  /** Settings → Devices on the web, as the browser session reads it. */
  const listed = async (browser: string): Promise<string[]> => {
    const res = await call("GET", "/devices", undefined, browser);
    expect(res.status, await res.clone().text()).toBe(200);
    return ((await res.json()) as { items: { label: string }[] }).items.map((d) => d.label);
  };

  /** The cloud engine, holding the desktop's pair; `/auth/*` reaches the real API, the rest is canned. */
  async function engineHolding(tokens: { accessToken: string; refreshToken: string; expiresIn?: number }) {
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (url.pathname.startsWith("/auth/")) {
        const headers = new Headers(init?.headers);
        headers.set("x-forwarded-for", freshIp());
        return app.handle(new Request(`http://localhost${url.pathname}${url.search}`, {
          method: init?.method ?? "GET", headers, ...(init?.body === undefined ? {} : { body: init.body as string }),
        }), depsOn());
      }
      const json = (v: unknown): Response =>
        new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });
      if (url.pathname === "/mailboxes") return json(mailboxList([]));
      if (url.pathname === "/sync") {
        return json({ changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: "c", hasMore: false, serverTime: apiNow.toISOString() });
      }
      if (url.pathname === "/messages/bodies") return json({ items: [], nextCursor: null });
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;
    const dataDir = await freshDataDir("ohmail-signout-at-server-");
    dirs.push(dataDir);
    const sidecar = await createCloudSidecar({
      dataDir, cloudUrl: "https://api.test", address: "me@ohmail.test", fetchImpl, pollIntervalMs: 3_600_000, tokens,
    });
    sidecars.push(sidecar);
    /** THE PRESS: what `Shell::logout_of` sends the engine on Settings → Desktop → Sign out. */
    const signOut = async (): Promise<{ status: number; body: unknown }> => {
      const res = await sidecar.handle(new Request("http://sidecar/cloud/session", {
        method: "DELETE", headers: { authorization: `Bearer ${sidecar.sessionToken}` },
      }));
      return { status: res.status, body: await res.json() };
    };
    return { sidecar, signOut };
  }

  it("the shell's sign-out revokes this desktop's session row and takes it off Devices", { timeout: 60_000 }, async () => {
    const { browser } = await account();
    const pair = await desktop(browser, "Studio desktop");
    expect(await listed(browser)).toContain("Studio desktop");
    const { signOut } = await engineHolding(pair);

    const out = await signOut();
    expect(out.status).toBe(200);
    const row = await sessionOf(pair.accessToken);
    expect(row, "the desktop's session row").toBeDefined();
    expect(row!.revokedAt, "revoked_at after the press").not.toBeNull();
    expect(await listed(browser), "Settings → Devices on the web").not.toContain("Studio desktop");
  });

  /** Two desktops and the browser on one account; one desktop signs out, then the other. */
  async function twoDesktops(first: "A" | "B") {
    const { browser } = await account();
    const pairs = { A: await desktop(browser, "Desktop A"), B: await desktop(browser, "Desktop B") };
    const engines = { A: await engineHolding(pairs.A), B: await engineHolding(pairs.B) };
    const second = first === "A" ? "B" : "A";
    const live = async (token: string): Promise<boolean> => (await sessionOf(token))!.revokedAt === null;

    expect((await engines[first].signOut()).body).toEqual({ status: "signed_out", revokedAtHost: true, queued: 0 });
    expect(await live(pairs[first].accessToken), `Desktop ${first} after its own sign-out`).toBe(false);
    expect(await live(pairs[second].accessToken), `Desktop ${second} was ended by the other's sign-out`).toBe(true);
    expect(await live(browser), "the browser was ended by a desktop's sign-out").toBe(true);
    expect((await listed(browser)).filter((l) => l !== ""), "the named devices on the web").toEqual([`Desktop ${second}`]);

    expect((await engines[second].signOut()).body).toEqual({ status: "signed_out", revokedAtHost: true, queued: 0 });
    expect(await live(pairs[second].accessToken)).toBe(false);
    expect(await live(browser), "the browser outlived both desktops").toBe(true);
    expect((await listed(browser)).filter((l) => l !== "")).toEqual([]);
  }

  it("B then A: each desktop's sign-out ends its own session and nobody else's", { timeout: 60_000 }, async () => {
    await twoDesktops("B");
  });

  it("A then B: the same, in the other order", { timeout: 60_000 }, async () => {
    await twoDesktops("A");
  });

  it("an access token that lapsed is ended through its refresh token", { timeout: 60_000 }, async () => {
    const { browser } = await account();
    const pair = await desktop(browser, "Studio desktop");
    const { signOut } = await engineHolding(pair);
    apiNow = new Date(START.getTime() + ACCESS_TTL_MS + 60_000);
    expect((await signOut()).body).toEqual({ status: "signed_out", revokedAtHost: true, queued: 0 });
    expect((await sessionOf(pair.accessToken))!.revokedAt, "revoked_at after the press").not.toBeNull();
  });

  // ── THE SERVER HALF, MEASURED: the answers the desktop's credential gets at each door ──────────
  it("POST /auth/logout with the desktop's bearer: 204, its own family only", { timeout: 60_000 }, async () => {
    const { browser } = await account();
    const a = await desktop(browser, "Desktop A");
    const b = await desktop(browser, "Desktop B");
    const out = await call("POST", "/auth/logout", {}, a.accessToken);
    expect(out.status, await out.clone().text()).toBe(204);
    expect((await sessionOf(a.accessToken))!.revokedAt).not.toBeNull();
    expect((await sessionOf(b.accessToken))!.revokedAt, "the other desktop").toBeNull();
    const after = await listed(browser);
    expect(after).not.toContain("Desktop A");
    expect(after).toContain("Desktop B");
  });

  it("an expired access token with a good refresh: /auth/logout 401s, /auth/refresh/logout ends it", { timeout: 60_000 }, async () => {
    const { browser } = await account();
    const a = await desktop(browser, "Desktop A");
    apiNow = new Date(START.getTime() + ACCESS_TTL_MS + 60_000);
    const bearer = await call("POST", "/auth/logout", {}, a.accessToken);
    expect(bearer.status, await bearer.clone().text()).toBe(401);
    expect((await sessionOf(a.accessToken))!.revokedAt, "untouched by the refused bearer").toBeNull();
    const byRefresh = await call("POST", "/auth/refresh/logout", { refreshToken: a.refreshToken });
    expect(byRefresh.status, await byRefresh.clone().text()).toBe(204);
    expect((await sessionOf(a.accessToken))!.revokedAt).not.toBeNull();
  });
});
