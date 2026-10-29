import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { desc, eq } from "drizzle-orm";
import { generateSync } from "otplib";
import { refreshTokens, sessions } from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { pgTestUrl, realPgAvailable } from "@trafficflow/db/testing";
import { AuthService, hashToken, makeTestAuthDeps, type ServiceContext } from "@trafficflow/services";
import { resolveSession } from "@trafficflow/services/auth";

/**
 * A SIGN-IN SUPERSEDES THE JAR'S PREVIOUS SESSION, on real Postgres. Account A's session sits in a
 * browser jar; B signs in carrying A's access cookie, and a rotation of A's family races that mint.
 * Whichever order the two commit in, no token of A's session authenticates after the mint and A's
 * family keeps no spendable refresh token. Each case builds its own accounts and reads only them.
 * The one order the server cannot see (the rotation fully committed while the jar still presents
 * the pre-rotation cookie) is pinned apart, as the open residual it is; for the same person the
 * jar's resume marker closes it.
 */
const URL = pgTestUrl(import.meta.url);
const PG_UP = await realPgAvailable(URL);

let client: ReturnType<typeof postgres>;
let db: ReturnType<typeof drizzle<typeof schema>>;

let ipCell = 0;
const ctx = (over: Partial<ServiceContext> = {}): ServiceContext => ({
  db, accountId: "", userId: null, now: () => new Date(),
  requestId: "supersede-race-pg", ip: `10.8.${(ipCell += 1) % 250}.${Math.floor(ipCell / 250) + 1}`, ...over,
});
const totp = (secret: string): string => generateSync({ secret, epoch: Math.floor(Date.now() / 1000) });
const PW = "pw-correct-horse";
const COOKIE = { concurrentGrace: true, surface: "cookie" } as const;

/** Register and enrol TOTP; the answer signs in a fresh browser session on demand. */
async function person(svc: AuthService, label: string): Promise<{
  userId: string; first: { access: string; refresh: string };
  signIn: (over?: Partial<ServiceContext>) => Promise<{ access: string; refresh: string }>;
}> {
  const email = `${label}-${randomUUID()}@lichtgrat.example`;
  const reg = await svc.register(ctx(), { email, password: PW, displayName: "S", inviteCode: "INVITE-OK" });
  if (reg.status !== "enrollment") throw new Error(`expected an enrolment session, got ${reg.status}`);
  const [enrol] = await db.select({ id: sessions.id }).from(sessions)
    .where(eq(sessions.userId, reg.user.userId)).orderBy(desc(sessions.createdAt)).limit(1);
  const enrolCtx = ctx({ userId: reg.user.userId, accountId: reg.user.accountId, sessionId: enrol!.id });
  const { secret } = await svc.totpEnroll(enrolCtx);
  const { session } = await svc.totpActivate(enrolCtx, { code: totp(secret) });
  return {
    userId: reg.user.userId,
    // The full session activation exchanged the enrolment for: this browser's first family.
    first: { access: session!.tokens!.accessToken, refresh: session!.tokens!.refreshToken },
    // ONE sign-in per person: activation spent this step, and the window admits the next one at
    // the real clock, so nothing is stamped ahead of it.
    signIn: async (over = {}) => {
      const ch = await svc.login(ctx(), { email, password: PW });
      if (ch.status !== "twofa_required") throw new Error(`expected a challenge, got ${ch.status}`);
      const code = generateSync({ secret, epoch: Math.floor(Date.now() / 1000) + 30 });
      const est = await svc.totpVerify(ctx(over), { loginToken: ch.loginToken, code });
      return { access: est.tokens!.accessToken, refresh: est.tokens!.refreshToken };
    },
  };
}

const authenticates = async (token: string): Promise<boolean> =>
  (await resolveSession(db as never, token, new Date())) !== null;

/** Spendable refresh tokens in the FAMILY the jar's first refresh token opened (activation mints another). */
async function spendableRefresh(jarRefresh: string): Promise<number> {
  const [first] = await db.select({ familyId: refreshTokens.familyId }).from(refreshTokens)
    .where(eq(refreshTokens.tokenHash, hashToken(jarRefresh))).limit(1);
  const rows = await db.select().from(refreshTokens).where(eq(refreshTokens.familyId, first!.familyId));
  return rows.filter((r) => r.revokedAt === null && r.consumedAt === null && r.expiresAt > new Date()).length;
}

async function refused(p: Promise<unknown>): Promise<string> {
  try { await p; return "rotated"; } catch (err) { return (err as { code?: string }).code ?? "threw"; }
}

const opened: ReturnType<typeof postgres>[] = [];
/** A handle of its own, named in pg_stat_activity, so a wait of its backend can be READ. */
function named(app: string): typeof db {
  const base = postgres(URL, { max: 2, onnotice: () => {}, connection: { application_name: app } });
  opened.push(base);
  return brandDialect(drizzle(base, { schema }), "pg");
}

/** Poll, bounded, until a backend named `app` in this database waits on a lock: a reading, not a sleep. */
async function blockedOnALock(app: string, ms = 10_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const [row] = await client`select count(*)::int as n from pg_stat_activity
      where datname = current_database() and application_name = ${app} and wait_event_type = 'Lock'`;
    if ((row as { n: number }).n > 0) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return false;
}

/**
 * A handle whose `update(<table>)` statements wait for `gate` once they are awaited, inside its
 * transactions too. The rotation is one transaction that locks its session row before its claim,
 * so pausing its session update holds that row with the claim and the new refresh row written and
 * not committed: a mint that arrives then waits for the rotation.
 */
function pausingUpdatesOf(target: object, table: object, gate: Promise<void>, reached: () => void): typeof db {
  const gated = (b: object): object => new Proxy(b, {
    get(t, p) {
      const v = Reflect.get(t, p) as unknown;
      if (p === "then") {
        return (ok: (v: unknown) => unknown, ko: (e: unknown) => unknown) => {
          reached();
          return gate.then(() => (v as (a: unknown, b: unknown) => unknown).call(t, ok, ko));
        };
      }
      return typeof v === "function" ? (...a: unknown[]) => gated((v as (...x: unknown[]) => object).apply(t, a)) : v;
    },
  });
  const wrap = (h: object): object => new Proxy(h, {
    get(t, p) {
      const v = Reflect.get(t, p) as unknown;
      if (p === "update") return (tbl: object) => { const b = (v as (x: object) => object).call(t, tbl); return tbl === table ? gated(b) : b; };
      if (p === "transaction") {
        return (fn: (tx: object) => Promise<unknown>, ...rest: unknown[]) =>
          (v as (...x: unknown[]) => Promise<unknown>).call(t, (tx: object) => fn(wrap(tx)), ...rest);
      }
      return typeof v === "function" ? (v as (...x: unknown[]) => unknown).bind(t) : v;
    },
  });
  return wrap(target) as typeof db;
}

/**
 * A handle whose TRANSACTIONS stop at their `sessions` insert until `gate` settles (after the supersede).
 * A transaction opened inside one stops the same way: the sign-in burns its first step and writes its
 * session in one transaction, and the supersede and the mint open theirs inside it.
 */
function mintPausedAtSessionInsert(target: typeof db, gate: Promise<void>, reached: () => void): typeof db {
  const bind = (o: object, p: string | symbol): unknown => {
    const v = Reflect.get(o, p) as unknown;
    return typeof v === "function" ? (v as (...x: unknown[]) => unknown).bind(o) : v;
  };
  const txProxy = (tx: object): object => new Proxy(tx, {
    get(t, p) {
      if (p === "transaction") {
        const transaction = Reflect.get(t, p) as (f: (inner: object) => Promise<unknown>) => Promise<unknown>;
        return (fn: (inner: object) => Promise<unknown>) => transaction.call(t, (inner) => fn(txProxy(inner)));
      }
      if (p !== "insert") return bind(t, p);
      const insert = Reflect.get(t, p) as (tbl: object) => { values: (r: unknown) => { returning: () => Promise<unknown> } };
      return (tbl: object) => (tbl !== sessions ? insert.call(t, tbl) : {
        values: (row: unknown) => ({
          returning: async () => { reached(); await gate; return insert.call(t, tbl).values(row).returning(); },
        }),
      });
    },
  });
  return new Proxy(target, {
    get(t, p) {
      if (p !== "transaction") return bind(t, p);
      const transaction = Reflect.get(t, p) as (f: (tx: object) => Promise<unknown>) => Promise<unknown>;
      return (fn: (tx: object) => Promise<unknown>) => transaction.call(t, (tx) => fn(txProxy(tx)));
    },
  }) as typeof db;
}

describe.skipIf(!PG_UP)("a sign-in supersedes the jar's previous session, on real Postgres", () => {
  beforeAll(async () => {
    await runMigrations(URL);
    client = postgres(URL, { max: 6 });
    db = brandDialect(drizzle(client, { schema }), "pg");
  }, 60_000);
  afterAll(async () => {
    for (const c of opened) await c.end({ timeout: 5 }).catch(() => {});
    await client?.end({ timeout: 5 });
  });

  it("control: a sign-in that presents no jar cookie leaves the other account's session alone", async () => {
    const svc = new AuthService(makeTestAuthDeps());
    const a = await person(svc, "sup-ctl-a");
    const b = await person(svc, "sup-ctl-b");
    const jar = await a.signIn();
    await b.signIn();
    expect(await authenticates(jar.access), "A's session did not survive a sign-in that named no jar").toBe(true);
    expect(await refused(svc.refresh(ctx(), { refreshToken: jar.refresh }, COOKIE))).toBe("rotated");
  });

  it("mint first, then the late rotation: the rotation is refused and nothing of A authenticates", async () => {
    const svc = new AuthService(makeTestAuthDeps());
    const a = await person(svc, "sup-mf-a");
    const b = await person(svc, "sup-mf-b");
    const jar = await a.signIn();
    expect(await authenticates(jar.access), "positive control: A's jar authenticated before").toBe(true);
    await b.signIn({ supersedes: jar.access });
    expect(await refused(svc.refresh(ctx(), { refreshToken: jar.refresh }, COOKIE))).toBe("refresh_revoked");
    expect(await authenticates(jar.access)).toBe(false);
    expect(await spendableRefresh(jar.refresh)).toBe(0);
  });

  it("rotation first, then the mint presenting the rotated cookie: A's rotated family is revoked", async () => {
    const svc = new AuthService(makeTestAuthDeps());
    const a = await person(svc, "sup-rf-a");
    const b = await person(svc, "sup-rf-b");
    const jar = await a.signIn();
    const rotated = (await svc.refresh(ctx(), { refreshToken: jar.refresh }, COOKIE)).tokens!;
    await b.signIn({ supersedes: rotated.accessToken });
    expect(await authenticates(rotated.accessToken)).toBe(false);
    expect(await refused(svc.refresh(ctx(), { refreshToken: rotated.refreshToken }, COOKIE))).toBe("refresh_revoked");
    expect(await spendableRefresh(jar.refresh)).toBe(0);
  });

  it("a mint arriving in the MIDDLE of a rotation waits for it, and the successor is dead on arrival", async () => {
    const svc = new AuthService(makeTestAuthDeps());
    const a = await person(svc, "sup-mid-a");
    const b = await person(svc, "sup-mid-b");
    const jar = await a.signIn();
    let release!: () => void;
    let arrived!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const atSessionWrite = new Promise<void>((r) => { arrived = r; });
    const rotation = svc.refresh(
      ctx({ db: pausingUpdatesOf(db, sessions, gate, arrived) as never }), { refreshToken: jar.refresh }, COOKIE,
    );
    await atSessionWrite;
    let minted = false;
    const minter = `sup-mid-${randomUUID().slice(0, 8)}`;
    const mint = b.signIn({ supersedes: jar.access, db: named(minter) }).finally(() => { minted = true; });
    expect(await blockedOnALock(minter), "the supersede is blocked on a lock").toBe(true);
    expect(minted, "the supersede waits for the rotation that holds A's session row").toBe(false);
    release();
    const late = (await rotation).tokens!;
    await mint;
    expect(await spendableRefresh(jar.refresh), "the supersede revoked the successor the rotation committed").toBe(0);
    expect(await authenticates(late.accessToken), "the late rotation's access token authenticates").toBe(false);
    expect(await refused(svc.refresh(ctx(), { refreshToken: late.refreshToken }, COOKIE))).toBe("refresh_revoked");
    expect(await spendableRefresh(jar.refresh)).toBe(0);
  });

  it("the rotation runs while the mint's transaction is open: it waits, then is refused", async () => {
    const svc = new AuthService(makeTestAuthDeps());
    const a = await person(svc, "sup-open-a");
    const b = await person(svc, "sup-open-b");
    const jar = await a.signIn();
    let release!: () => void;
    let arrived!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const atMint = new Promise<void>((r) => { arrived = r; });
    const mint = b.signIn({ supersedes: jar.access, db: mintPausedAtSessionInsert(db, gate, arrived) as never });
    await atMint;
    let settled = false;
    const rotator = `sup-open-${randomUUID().slice(0, 8)}`;
    const rotation = refused(svc.refresh(ctx({ db: named(rotator) }), { refreshToken: jar.refresh }, COOKIE))
      .finally(() => { settled = true; });
    expect(await blockedOnALock(rotator), "the rotation is blocked on a lock").toBe(true);
    expect(settled, "the rotation did not wait for the mint's transaction").toBe(false);
    release();
    await mint;
    expect(await rotation).toBe("refresh_revoked");
    expect(await authenticates(jar.access)).toBe(false);
    expect(await spendableRefresh(jar.refresh)).toBe(0);
  });

  it("a mint that fails after the supersede leaves the jar's previous session as it was", async () => {
    const svc = new AuthService(makeTestAuthDeps());
    const a = await person(svc, "sup-fail-a");
    const b = await person(svc, "sup-fail-b");
    const jar = await a.signIn();
    const broken = Promise.reject(new Error("the mint's insert failed"));
    broken.catch(() => {});   // handled here; the mint's own await still rejects
    const failing = mintPausedAtSessionInsert(db, broken, () => {});
    await expect(b.signIn({ supersedes: jar.access, db: failing as never })).rejects.toThrow("the mint's insert failed");
    expect(await authenticates(jar.access), "the supersede committed without its mint").toBe(true);
    expect(await refused(svc.refresh(ctx(), { refreshToken: jar.refresh }, COOKIE))).toBe("rotated");
  });

  it("an enrollment token or an unknown token in the jar revokes nothing", async () => {
    const svc = new AuthService(makeTestAuthDeps());
    const a = await person(svc, "sup-noop-a");
    const b = await person(svc, "sup-noop-b");
    const c = await person(svc, "sup-noop-c");
    const jar = await a.signIn();
    await b.signIn({ supersedes: "not-a-token-this-server-minted" });
    expect(await authenticates(jar.access)).toBe(true);
    expect(await spendableRefresh(jar.refresh)).toBe(1);
    const pending = await svc.register(ctx(), {
      email: `sup-noop-d-${randomUUID()}@lichtgrat.example`, password: PW, displayName: "D", inviteCode: "INVITE-OK",
    });
    if (pending.status !== "enrollment") throw new Error(`expected an enrolment session, got ${pending.status}`);
    await c.signIn({ supersedes: pending.enrollmentToken });
    expect(await authenticates(pending.enrollmentToken), "an enrollment session was superseded").toBe(true);
  });

  // THE OPEN RESIDUAL: the rotation committed whole and its answer is still on the wire, so the jar
  // presents the PRE-rotation cookie; `sessions` keeps only the current access hash and the mint
  // cannot find the session. The web client aborts that answer at the mint. Flips when closed.
  it.fails("a rotation committed whole before the mint, jar still on the old cookie: A is revoked", async () => {
    const svc = new AuthService(makeTestAuthDeps());
    const a = await person(svc, "sup-res-a");
    const b = await person(svc, "sup-res-b");
    const jar = await a.signIn();
    const rotated = (await svc.refresh(ctx(), { refreshToken: jar.refresh }, COOKIE)).tokens!;
    await b.signIn({ supersedes: jar.access });
    expect(await authenticates(rotated.accessToken)).toBe(false);
  });

  // ITS SAME-PERSON SIBLING, closed: the jar's resume marker is the digest of the pre-rotation
  // refresh token, which still names the family the rotation moved on.
  it("the same person signs in again after a whole rotation, carrying the pre-rotation marker: the family is revoked", async () => {
    const svc = new AuthService(makeTestAuthDeps());
    const a = await person(svc, "sup-own-a");
    const rotated = (await svc.refresh(ctx(), { refreshToken: a.first.refresh }, COOKIE)).tokens!;
    await a.signIn({ supersedesMarker: hashToken(a.first.refresh) });
    expect(await authenticates(rotated.accessToken)).toBe(false);
    expect(await refused(svc.refresh(ctx(), { refreshToken: rotated.refreshToken }, COOKIE))).toBe("refresh_revoked");
    expect(await spendableRefresh(a.first.refresh)).toBe(0);
  });

  it("a sign-in carrying only the marker, in the MIDDLE of a rotation, waits for it: the successor is dead on arrival", async () => {
    const svc = new AuthService(makeTestAuthDeps());
    const a = await person(svc, "sup-mark-mid");
    let release!: () => void;
    let arrived!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const atSessionWrite = new Promise<void>((r) => { arrived = r; });
    const rotation = svc.refresh(
      ctx({ db: pausingUpdatesOf(db, sessions, gate, arrived) as never }), { refreshToken: a.first.refresh }, COOKIE,
    );
    await atSessionWrite;
    const minter = `sup-mark-${randomUUID().slice(0, 8)}`;
    const mint = a.signIn({ supersedesMarker: hashToken(a.first.refresh), db: named(minter) });
    const blocked = await blockedOnALock(minter);
    release();
    expect(blocked, "the supersede waits for the rotation that holds the session row").toBe(true);
    const late = (await rotation).tokens!;
    await mint;
    expect(await authenticates(late.accessToken), "the late rotation's access token authenticates").toBe(false);
    expect(await refused(svc.refresh(ctx(), { refreshToken: late.refreshToken }, COOKIE))).toBe("refresh_revoked");
    expect(await spendableRefresh(a.first.refresh)).toBe(0);
  });

  it("control: a marker naming the person's paired device revokes nothing", async () => {
    const svc = new AuthService(makeTestAuthDeps());
    const a = await person(svc, "sup-mark-pair");
    const phone = (await svc.establishPairedDevice(ctx(), { userId: a.userId, label: "Phone", kind: "mobile-android" })).tokens;
    await a.signIn({ supersedesMarker: hashToken(phone.refreshToken) });
    expect(await authenticates(phone.accessToken), "a browser's marker revoked a paired device").toBe(true);
    expect(await refused(svc.refresh(ctx(), { refreshToken: phone.refreshToken }, { surface: "native" }))).toBe("rotated");
  });
});
