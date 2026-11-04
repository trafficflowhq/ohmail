import { createHmac, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { desc, eq } from "drizzle-orm";
import { StaticKeyProvider } from "@trafficflow/core";
import { refreshTokens, sessions } from "@trafficflow/db";
import { makeOwnedDb, type OwnedDb } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { AuthService, ServiceError, makeTestAuthDeps, type ServiceContext } from "@trafficflow/services";
import { createCloudAuth, loadSealedTokens, sealTokens, type CloudAuth } from "../src/cloud-auth.js";

/**
 * A SEAL THAT FAILED AFTER THE SERVER ANSWERED COSTS NOTHING — against the real rotation.
 *
 * The desktop's client and the hosted refresh door, joined on real Postgres (the replay takes the
 * session lock; PGlite proves nothing here). The disk refuses the renewed pair, the app quits, and
 * the next launch presents the saved token under the name that spent it: the server replays it
 * and the family lives. The second case is the order that made it a revocation — a renewal sent
 * under a name the disk never held moves the chain on, and the same relaunch is then theft.
 */
const PG_UP = await realPgAvailable();

let owned: OwnedDb;
const dirs: string[] = [];
const auths: CloudAuth[] = [];
let ipCell = 0;

/** RFC 6238 over the enrolment's base32 secret — the sidecar carries no TOTP library. */
function totp(secret: string, atMs: number): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const bits = [...secret.replace(/=+$/, "").toUpperCase()]
    .map((c) => alphabet.indexOf(c).toString(2).padStart(5, "0")).join("");
  const key = Buffer.from(Array.from({ length: Math.floor(bits.length / 8) }, (_, i) => parseInt(bits.slice(i * 8, i * 8 + 8), 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(atMs / 30_000)));
  const mac = createHmac("sha1", key).update(counter).digest();
  const at = mac[mac.length - 1]! & 0x0f;
  return String((mac.readUInt32BE(at) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

const ctx = (ip: string, over: Partial<ServiceContext> = {}): ServiceContext => ({
  db: owned.db as unknown as ServiceContext["db"], accountId: "", userId: null,
  now: () => new Date(), requestId: "cloud-seal-replay", ip, ...over,
});

/** Register, enrol TOTP, sign in with the factor: the user and the first native pair. */
async function establish(svc: AuthService): Promise<{ userId: string; access: string; refresh: string }> {
  const ip = `10.23.${(ipCell += 1)}.7`;
  let t = Date.now();
  const at = (over: Partial<ServiceContext> = {}): ServiceContext => ctx(ip, { now: () => new Date(t), ...over });
  const email = `seal-replay-${randomUUID()}@lichtgrat.example`;
  const registered = await svc.register(at(), { email, password: "account-signin-password", displayName: "S", inviteCode: "INVITE-OK" });
  if (registered.status !== "enrollment") throw new Error(`expected enrolment, got ${registered.status}`);
  const user = registered.user;
  const [row] = await owned.db.select({ id: sessions.id }).from(sessions)
    .where(eq(sessions.userId, user.userId)).orderBy(desc(sessions.createdAt)).limit(1);
  const enrol = at({ userId: user.userId, accountId: user.accountId, sessionId: row!.id });
  const { secret } = await svc.totpEnroll(enrol);
  await svc.totpActivate(enrol, { code: totp(secret, t) });
  t += 30_000;
  const ch = await svc.login(at(), { email, password: "account-signin-password" });
  if (ch.status !== "twofa_required") throw new Error(`expected a 2FA challenge, got ${ch.status}`);
  const est = await svc.totpVerify(at(), { loginToken: ch.loginToken, code: totp(secret, t) });
  return { userId: user.userId, access: est.tokens!.accessToken, refresh: est.tokens!.refreshToken };
}

/** The hosted refresh door over the real service, native surface; every other path 401s. */
function realDoor(svc: AuthService, afterMint: () => void = () => undefined): { fetchImpl: typeof fetch; presented: number } {
  const d = { presented: 0, fetchImpl: undefined as unknown as typeof fetch };
  d.fetchImpl = (async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    if (!String(url).endsWith("/auth/refresh")) return new Response("{}", { status: 401 });
    d.presented += 1;
    const body = JSON.parse(String(init!.body)) as { refreshToken: string; attemptId: string };
    try {
      const out = await svc.refresh(ctx("10.23.0.1"), body, { surface: "native" });
      afterMint();
      return new Response(JSON.stringify({ tokens: out.tokens }), { status: 200 });
    } catch (err) {
      if (!(err instanceof ServiceError)) throw err;
      return new Response(JSON.stringify({ error: { code: err.code, message: err.message } }), { status: err.httpStatus });
    }
  }) as typeof fetch;
  return d;
}

async function familyRevoked(userId: string): Promise<boolean> {
  const rows = await owned.db.select().from(refreshTokens).where(eq(refreshTokens.userId, userId));
  return rows.some((r) => r.revokedAt !== null);
}

describe.skipIf(!PG_UP)("a post-answer seal failure, against the real refresh door", () => {
  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    owned = makeOwnedDb(PG_TEST_URL);
  }, 60_000);
  afterAll(async () => {
    for (const a of auths.splice(0)) a.stop();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    await owned?.close();
  });

  async function scene(svc: AuthService): Promise<{ userId: string; sealPath: string; keyProvider: StaticKeyProvider; staging: string; first: CloudAuth; door: ReturnType<typeof realDoor> }> {
    const { userId, access, refresh } = await establish(svc);
    const dir = mkdtempSync(join(realpathSync(tmpdir()), "ohmail-seal-replay-"));
    dirs.push(dir);
    const sealPath = join(dir, "cloud-tokens.seal");
    const keyProvider = new StaticKeyProvider({ 1: Buffer.from(crypto.getRandomValues(new Uint8Array(32))) });
    await sealTokens(sealPath, keyProvider, { accessToken: access, refreshToken: refresh });
    const staging = `${sealPath}.${process.pid}.tmp`;
    // The disk fails between the server's mint and this client's write of what it minted.
    const door = realDoor(svc, () => mkdirSync(staging, { recursive: true }));
    const first = createCloudAuth({ baseUrl: "https://cloud.test", tokens: { accessToken: access, refreshToken: refresh }, fetchImpl: door.fetchImpl, keyProvider, sealPath });
    auths.push(first);
    expect((await first.renewNow()).state, "the server rotated and this launch goes on").toBe("live");
    expect(first.sealState().sealed).toBe(false);
    return { userId, sealPath, keyProvider, staging, first, door };
  }

  it("the next launch resumes from the seal: replayed, live, and nothing in the family revoked", { timeout: 60_000 }, async () => {
    const svc = new AuthService(makeTestAuthDeps());
    const { userId, sealPath, keyProvider, staging, first, door } = await scene(svc);
    // A later renewal in the same launch would move the chain on: the disk still refuses, so none goes out.
    expect((await first.renewNow()).state).toBe("seal_failed");
    expect(door.presented, "one rotation reached the server, not two").toBe(1);
    first.stop();

    rmSync(staging, { recursive: true });
    const saved = await loadSealedTokens(sealPath, keyProvider);
    const next = createCloudAuth({ baseUrl: "https://cloud.test", tokens: saved!, fetchImpl: realDoor(svc).fetchImpl, keyProvider, sealPath });
    auths.push(next);
    expect((await next.renewNow()).state, "the saved token under its own name is a replay").toBe("live");
    expect(await familyRevoked(userId), "no device of this account was signed out").toBe(false);
    expect((await next.renewNow()).state, "and the replayed pair is the family's live line").toBe("live");
  });

  it("the order it replaces: a renewal sent under a name the disk never held makes the same relaunch a theft", { timeout: 60_000 }, async () => {
    const svc = new AuthService(makeTestAuthDeps());
    const { userId, sealPath, keyProvider, staging, first } = await scene(svc);
    // What the client used to do when its write failed: rotate on regardless. Reproduced by
    // presenting the in-memory pair under a fresh name straight to the server.
    await svc.refresh(ctx("10.23.0.2"), { refreshToken: first.currentTokens().refreshToken, attemptId: `r${randomUUID()}` }, { surface: "native" });
    first.stop();

    rmSync(staging, { recursive: true });
    const saved = await loadSealedTokens(sealPath, keyProvider);
    const next = createCloudAuth({ baseUrl: "https://cloud.test", tokens: saved!, fetchImpl: realDoor(svc).fetchImpl, keyProvider, sealPath });
    auths.push(next);
    expect((await next.renewNow()).state, "use beats the name: the chain moved on").toBe("refused");
    expect(await familyRevoked(userId), "the whole family is revoked — the defect this lane closes").toBe(true);
  });
});
