import { describe, it, expect, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { accounts, refreshTokens, sessions, users } from "@trafficflow/db";
import { makeOwnedDb, type OwnedDb } from "@trafficflow/db/cloud";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { createApp, apiRoutes, type ApiDeps } from "@trafficflow/api";
import { generateToken, hashToken, makeAuthService, makeTestAuthDeps, type Db } from "@trafficflow/services";

/**
 * THE WEB'S SIGN-OUT, SENT WITHOUT THE REFRESH LOCK, AGAINST A RENEWAL OF THE SAME FAMILY. The
 * sign-out door no longer waits behind a renewal for ever: after a short wait it goes unlocked,
 * because the door ends the family in any state. That holds only while every writer of a family
 * takes the session row first: a revoke racing a rotation then waits on that row and revokes the
 * successor the rotation committed. Both orders at the session row are staged on real Postgres,
 * each read in both orders the browser can store the two answers. A sign-out that skips the
 * session-row wait leaves the successor live, and this file goes red.
 */

const PG_UP = await realPgAvailable();
const app = createApp(apiRoutes);
const owned: OwnedDb | null = PG_UP ? makeOwnedDb(PG_TEST_URL) : null;
const made: string[] = [];
const db = (): Db => owned!.db as unknown as Db;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
type Settled<T> = { ok: true; v: T } | { ok: false; e: unknown };
const settle = <T>(p: Promise<T>): Promise<Settled<T>> =>
  p.then((v) => ({ ok: true as const, v }), (e: unknown) => ({ ok: false as const, e }));

afterAll(async () => {
  if (!owned) return;
  for (const id of made) await owned.db.delete(accounts).where(eq(accounts.id, id)).catch(() => {});
  await owned.close();
});

/** A handle whose backends carry `name` as their application name, so each party can be watched. */
function named(name: string): OwnedDb {
  const u = new URL(PG_TEST_URL);
  u.searchParams.set("application_name", name);
  return makeOwnedDb(u.toString());
}

/** Is the backend named `waiter` blocked by the one named `holder`? Polled, never slept on. */
async function blockedBy(waiter: string, holder: string, ms = 10_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const rows = await db().execute(sql`select 1 as hit from pg_stat_activity w
      where w.datname = current_database() and w.application_name = ${waiter} and w.wait_event_type = 'Lock'
        and exists (select 1 from pg_stat_activity h
          where h.application_name = ${holder} and h.pid = any(pg_blocking_pids(w.pid)))`);
    if ((rows as unknown as unknown[]).length > 0) return true;
    await sleep(20);
  }
  return false;
}

function routeDeps(handle: unknown): ApiDeps {
  const authDeps = makeTestAuthDeps({});
  return {
    db: handle, now: () => new Date(), requestId: `race-${randomUUID()}`, session: null, idempotency: null,
    authConfig: authDeps.config, keyProvider: authDeps.keyProvider,
    services: { auth: makeAuthService(authDeps) },
  } as unknown as ApiDeps;
}

interface Family { accountId: string; sessionId: string; familyId: string; refresh: string }

/** A signed-in browser's family whose access cookie has lapsed: the jar carries `tf_refresh` alone. */
async function family(): Promise<Family> {
  const [a] = await db().insert(accounts).values({ name: "sign-out race" }).returning();
  made.push(a!.id);
  const [u] = await db().insert(users).values({
    accountId: a!.id, email: `race-${randomUUID().slice(0, 8)}@sign-out.test`, emailVerifiedAt: new Date(),
  }).returning();
  const now = Date.now();
  const familyId = randomUUID();
  const [s] = await db().insert(sessions).values({
    accountId: a!.id, userId: u!.id, familyId, accessTokenHash: hashToken(generateToken()),
    accessExpiresAt: new Date(now + 10 * 60_000), refreshExpiresAt: new Date(now + 30 * 86_400_000),
  }).returning();
  const refresh = generateToken();
  await db().insert(refreshTokens).values({
    accountId: a!.id, userId: u!.id, sessionId: s!.id, familyId, tokenHash: hashToken(refresh),
    expiresAt: new Date(now + 30 * 86_400_000), createdAt: new Date(now - 60 * 60_000),
  });
  return { accountId: a!.id, sessionId: s!.id, familyId, refresh };
}

const renewal = (refresh: string, deps: ApiDeps): Promise<Response> => app.handle(new Request("http://localhost/auth/refresh", {
  method: "POST", headers: { cookie: `tf_refresh=${refresh}`, "content-type": "application/json" },
  body: JSON.stringify({ attemptId: `race-${randomUUID()}` }),
}), deps);
const signOut = (refresh: string, deps: ApiDeps): Promise<Response> => app.handle(new Request("http://localhost/auth/refresh/logout", {
  method: "POST", headers: { cookie: `tf_refresh=${refresh}` },
}), deps);

/** A browser's jar after it stored `answers` in that order: name → value, cleared names gone. */
function jarAfter(answers: Response[]): Map<string, string> {
  const jar = new Map<string, string>();
  for (const res of answers) {
    for (const line of res.headers.getSetCookie()) {
      const first = line.split(";")[0]!;
      const at = first.indexOf("=");
      const name = first.slice(0, at).trim();
      const value = first.slice(at + 1).trim();
      if (value === "" || /Max-Age=0/i.test(line)) jar.delete(name);
      else jar.set(name, value);
    }
  }
  return jar;
}

/** Does anything in this jar still sign a browser in? The access token, then the refresh token. */
async function usable(jar: Map<string, string>): Promise<string[]> {
  const live: string[] = [];
  const access = jar.get("tf_session");
  if (access) {
    const res = await app.handle(new Request("http://localhost/auth/session", {
      headers: { authorization: `Bearer ${access}` },
    }), routeDeps(db()));
    if (res.status === 200) live.push("tf_session");
  }
  const refresh = jar.get("tf_refresh");
  if (refresh) {
    const res = await renewal(refresh, routeDeps(db()));
    if (res.status === 204) live.push("tf_refresh");
  }
  return live;
}

async function familyEnded(f: Family): Promise<{ liveTokens: number; liveSessions: number }> {
  const tokens = await db().select({ revokedAt: refreshTokens.revokedAt }).from(refreshTokens)
    .where(eq(refreshTokens.familyId, f.familyId));
  const sess = await db().select({ revokedAt: sessions.revokedAt }).from(sessions)
    .where(eq(sessions.familyId, f.familyId));
  return {
    liveTokens: tokens.filter((t) => t.revokedAt === null).length,
    liveSessions: sess.filter((s) => s.revokedAt === null).length,
  };
}

type Order = "the renewal reaches the session row first" | "the sign-out reaches the session row first";

/**
 * One race. A third backend holds the presented token's row, so the party that reaches the
 * session row first is held there while the other is seen waiting behind it; then it lets go.
 */
async function race(order: Order): Promise<{ renewal: Response; signOut: Response; f: Family }> {
  const f = await family();
  const tag = randomUUID().slice(0, 8);
  const [H, R, S] = [`race-hold-${tag}`, `race-renew-${tag}`, `race-signout-${tag}`];
  const hold = named(H); const ren = named(R); const out = named(S);
  try {
    let release!: () => void; let locked!: () => void;
    const released = new Promise<void>((r) => { release = r; });
    const isLocked = new Promise<void>((r) => { locked = r; });
    const holding = hold.db.transaction(async (tx) => {
      await tx.execute(sql`select 1 from refresh_tokens where token_hash = ${hashToken(f.refresh)} for update`);
      locked();
      await released;
    });
    await isLocked;
    let first: Promise<Settled<Response>>; let second: Promise<Settled<Response>>;
    if (order === "the renewal reaches the session row first") {
      first = settle(renewal(f.refresh, routeDeps(ren.db)));
      expect(await blockedBy(R, H), "the renewal never reached the held token row").toBe(true);
      second = settle(signOut(f.refresh, routeDeps(out.db)));
      expect(await blockedBy(S, R), "the sign-out never waited behind the renewal").toBe(true);
    } else {
      first = settle(signOut(f.refresh, routeDeps(out.db)));
      expect(await blockedBy(S, H), "the sign-out never reached the held token row").toBe(true);
      second = settle(renewal(f.refresh, routeDeps(ren.db)));
      expect(await blockedBy(R, S), "the renewal never waited behind the sign-out").toBe(true);
    }
    release();
    await holding;
    const [a, b] = await Promise.all([first, second]);
    if (!a.ok) throw a.e;
    if (!b.ok) throw b.e;
    const [renewalAnswer, signOutAnswer] = order === "the renewal reaches the session row first" ? [a.v, b.v] : [b.v, a.v];
    return { renewal: renewalAnswer, signOut: signOutAnswer, f };
  } finally {
    await Promise.all([hold.close(), ren.close(), out.close()]);
  }
}

describe.skipIf(!PG_UP)("an unlocked sign-out racing a renewal of the same family", () => {
  for (const order of ["the renewal reaches the session row first", "the sign-out reaches the session row first"] as const) {
    it(`${order}: the family ends, and no jar order keeps a usable session`, async () => {
      const { renewal: r, signOut: s, f } = await race(order);
      expect(s.status, "the sign-out door did not answer as a completed sign-out").toBe(204);
      expect(await familyEnded(f), "a token or the session of the family is still live").toEqual({ liveTokens: 0, liveSessions: 0 });
      // The browser stores the two answers in whichever order they arrive.
      expect(await usable(jarAfter([r, s])), "renewal answer first, then the sign-out's: a usable session survived").toEqual([]);
      expect(await usable(jarAfter([s, r])), "sign-out answer first, then the renewal's: a usable session survived").toEqual([]);
    }, 60_000);
  }
});
