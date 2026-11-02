import { describe, it, expect } from "vitest";
import { like } from "drizzle-orm";
import { makeTestDb } from "@trafficflow/db/testing";
import { authThrottle } from "@trafficflow/db/cloud";
import {
  AuthService, MailService, SpyMailer, makeTestAuthDeps, THROTTLE_PREFIX, ServiceError, throttleKeysFor, type ServiceContext,
} from "../src/index.js";

/**
 * AN UNKNOWN CLIENT (`ctx.ip` empty: a trusted proxy that named nobody) is never a shared bucket.
 * It takes no per-client password lock, because five strangers would then lock the holder out on
 * every device; and it earns no known-client marker, because that marker would exempt EVERY
 * unknown client from the per-address ceiling for its whole retention. The ceiling is its bound:
 * it slows the address (429) and owes the holder a notice, and the holder's known devices are
 * exempt from it.
 */
const PASSWORD = "pw-correct-horse-password-password";
const START = new Date("2026-10-03T10:00:00.000Z");

async function harness() {
  const db = await makeTestDb();
  const svc = new AuthService(makeTestAuthDeps({ maxFailures: 5, maxAddressFailures: 20 }));
  const ctx = (ip: string): ServiceContext => ({
    db, accountId: "", userId: null, now: () => START, requestId: "r", ip,
  });
  const attempt = (ip: string, password = "WRONG") =>
    svc.login(ctx(ip), { email: "owner@x.example", password }).then(() => "ok", (e: unknown) => (e as ServiceError).code ?? "threw");
  const keys = async (prefix: string) =>
    (await db.select({ key: authThrottle.key }).from(authThrottle).where(like(authThrottle.key, `${prefix}%`))).map((r) => r.key);
  return { db, svc, ctx, attempt, keys };
}

describe("an unknown client", () => {
  it("takes no per-client lock — five failures, then the right password, signs in", async () => {
    const h = await harness();
    await h.svc.register(h.ctx("10.9.9.9"), { email: "owner@x.example", password: PASSWORD, displayName: "O", inviteCode: "INVITE-OK" });
    for (let i = 0; i < 5; i++) expect(await h.attempt("")).toBe("credential_refused");
    expect(await h.attempt("", PASSWORD)).toBe("ok");
    expect(await h.keys(THROTTLE_PREFIX.password)).toEqual([]);
  });

  it("earns no known-marker, so the ceiling still slows every unknown client and the known device signs in", async () => {
    const h = await harness();
    // The account holder's only completed sign-ins are from an unknown client, then from their own device.
    await h.svc.register(h.ctx(""), { email: "owner@x.example", password: PASSWORD, displayName: "O", inviteCode: "INVITE-OK" });
    expect(await h.attempt("", PASSWORD)).toBe("ok");
    expect(await h.keys(THROTTLE_PREFIX.knownClient)).toEqual([]);
    expect(await h.attempt("10.0.0.2", PASSWORD)).toBe("ok");
    expect(await h.keys(THROTTLE_PREFIX.knownClient)).toHaveLength(1);

    for (let i = 0; i < 20; i++) expect(await h.attempt("")).toBe("credential_refused");
    expect(await h.attempt("")).toBe("sign_in_slowed");
    expect(await h.attempt("", PASSWORD)).toBe("sign_in_slowed");
    expect(await h.attempt("10.0.0.2", PASSWORD)).toBe("ok");
  });

  it("verifying an address from an unknown client meets the ceiling instead of a shared lock", async () => {
    const db = await makeTestDb();
    const spy = new SpyMailer();
    const mail = new MailService({
      mailer: spy, config: { appUrl: "https://ohmail.app", siteUrl: "https://ohmail.app", supportEmail: "support@ohmail.app" },
      throttleKeys: throttleKeysFor(makeTestAuthDeps().keyProvider),
    });
    const svc = new AuthService(makeTestAuthDeps({ publicSignup: true, maxAddressFailures: 3 }, mail));
    const ctx = (ip: string): ServiceContext => ({ db, accountId: "", userId: null, now: () => START, requestId: "r", ip });
    await svc.register(ctx("1.2.3.4"), { email: "new@x.example", password: PASSWORD, displayName: "N" });
    const token = new URL(spy.only("email_verification").data.verifyUrl).searchParams.get("token")!;
    const verify = (password: string) =>
      svc.verifyEmail(ctx(""), { token, password }).then(() => "ok", (e: unknown) => (e as ServiceError).code ?? "threw");
    for (let i = 0; i < 3; i++) expect(await verify("WRONG")).toBe("credential_refused");
    expect(await verify(PASSWORD)).toBe("sign_in_slowed");
    const rows = await db.select({ key: authThrottle.key }).from(authThrottle).where(like(authThrottle.key, `${THROTTLE_PREFIX.password}%`));
    expect(rows).toEqual([]);
  });

  it("an identified client still locks only itself (the lock is unchanged for a known address)", async () => {
    const h = await harness();
    await h.svc.register(h.ctx("10.9.9.9"), { email: "owner@x.example", password: PASSWORD, displayName: "O", inviteCode: "INVITE-OK" });
    for (let i = 0; i < 5; i++) expect(await h.attempt("10.0.0.1")).toBe("credential_refused");
    expect(await h.attempt("10.0.0.1", PASSWORD)).toBe("account_locked");
    expect(await h.attempt("10.0.0.3", PASSWORD)).toBe("ok");
  });
});
