import { describe, expect, it } from "vitest";
import { makeTestDb } from "@trafficflow/db/testing";
import type { Tx } from "@trafficflow/db";
import { authThrottle } from "@trafficflow/db/cloud";
import { like } from "drizzle-orm";
import {
  AuthService, makeTestAuthDeps, issueInvite, MailService, SpyMailer, hashToken, reserveIpSlot, throttleKeysFor,
  type Db, type ServiceContext, type ServiceError,
} from "@trafficflow/services";

/**
 * the two registration paths keep their own slots.
 *
 * With public signup on, one client address reaches `register` two ways: the OPEN path (no code)
 * and the INVITE path (a code offered). Each has its own ceiling, and each ceiling is spent only
 * by its own path's attempts; a refused attempt spends nothing. Red at the base, where both paths
 * counted into one `register:ip` row and every refused attempt still incremented it.
 */

const PW = "pw-correct-horse";
const NOW = new Date("2026-07-31T12:00:00.000Z");
const IP = "192.0.2.44";
const asTx = (db: Db): Tx => db as unknown as Tx;
const KEYS = throttleKeysFor(makeTestAuthDeps().keyProvider);

async function harness(cfg: { open: number; invite: number }) {
  const db = await makeTestDb();
  const mail = new MailService({
    mailer: new SpyMailer(),
    config: { appUrl: "https://ohmail.app", siteUrl: "https://ohmail.app", supportEmail: "support@ohmail.app" },
    throttleKeys: KEYS,
  });
  const deps = makeTestAuthDeps({
    publicSignup: true, inviteCodes: new Set<string>(),
    maxPublicRegistrationsPerWindow: cfg.open, maxRegistrationsPerWindow: cfg.invite,
  }, mail);
  const svc = new AuthService(deps);
  const ctx = (): ServiceContext => ({
    db, accountId: "", userId: null, now: () => NOW, requestId: "r", ip: IP,
  });
  const open = (email: string) => verdict(svc.register(ctx(), { email, password: PW, displayName: "S" }));
  const invite = async (email: string) => {
    const { code } = await issueInvite(asTx(db), {
      email, now: NOW, expiresAt: new Date(NOW.getTime() + 7 * 24 * 3_600_000),
    });
    return verdict(svc.register(ctx(), { email, password: PW, displayName: "S", inviteCode: code }));
  };
  const rows = () => db.select().from(authThrottle).where(like(authThrottle.key, "register:ip:%"));
  const counters = async () => (await rows()).map((r) => r.failures).sort((a, b) => a - b);
  const keys = async () => (await rows()).map((r) => r.key).sort();
  return { db, deps, open, invite, counters, keys };
}

/** One word per attempt: `ok`, or the refusal's code. */
const verdict = (p: Promise<unknown>): Promise<string> =>
  p.then(() => "ok", (e: ServiceError) => e.code);

describe("each registration path spends only its own ceiling", () => {
  it("public attempts up to and past the public ceiling leave the invite ceiling whole", async () => {
    const h = await harness({ open: 1, invite: 2 });
    const pub: string[] = [];
    for (let i = 0; i < 4; i++) pub.push(await h.open(`stranger${i}@example.com`));
    expect(pub).toEqual(["ok", "rate_limited", "rate_limited", "rate_limited"]);

    // The invited person, from the same address, gets both of the invite path's slots.
    expect([await h.invite("one@example.com"), await h.invite("two@example.com"),
      await h.invite("three@example.com")]).toEqual(["ok", "ok", "rate_limited"]);
    expect(await h.counters()).toEqual([1, 2]);
    // The client under the deployment's keyed hash: a plain digest of an address is reversed by a guess.
    const k = throttleKeysFor(h.deps.keyProvider).client(IP);
    expect(await h.keys()).toEqual([`register:ip:invite:${k}`, `register:ip:open:${k}`]);
    expect((await h.keys()).join(" ")).not.toContain(hashToken(IP));
  });

  it("invite attempts up to and past the invite ceiling leave the public ceiling whole", async () => {
    const h = await harness({ open: 2, invite: 1 });
    const inv: string[] = [];
    for (let i = 0; i < 4; i++) inv.push(await h.invite(`invited${i}@example.com`));
    expect(inv).toEqual(["ok", "rate_limited", "rate_limited", "rate_limited"]);

    expect([await h.open("a@example.com"), await h.open("b@example.com"),
      await h.open("c@example.com")]).toEqual(["ok", "ok", "rate_limited"]);
    expect(await h.counters()).toEqual([1, 2]);
  });

  it("a refused attempt is not counted: the counter reads the ceiling, never past it", async () => {
    const h = await harness({ open: 2, invite: 20 });
    const pub: string[] = [];
    for (let i = 0; i < 6; i++) pub.push(await h.open(`p${i}@example.com`));
    expect(pub).toEqual(["ok", "ok", "rate_limited", "rate_limited", "rate_limited", "rate_limited"]);
    expect(await h.counters(), "four refusals, and the one row still reads the ceiling").toEqual([2]);
  });
});

describe("reserveIpSlot — the one door compares before it counts", () => {
  const claim = (db: Db, now: Date, max = 3) => reserveIpSlot(asTx(db), KEYS, {
    namespace: "fr3-door", ip: IP, now, max, windowMs: 60_000,
  });
  const row = async (db: Db) => (await db.select().from(authThrottle)
    .where(like(authThrottle.key, "fr3-door:%")))[0]!;

  it("admits `max`, refuses the rest without counting them, and rolls with the window", async () => {
    const db = await makeTestDb();
    const out: boolean[] = [];
    for (let i = 0; i < 6; i++) out.push(await claim(db, NOW));
    expect(out).toEqual([true, true, true, false, false, false]);
    expect((await row(db)).failures).toBe(3);
    expect((await row(db)).key).toBe(`fr3-door:${KEYS.client(IP)}`);

    // The positive control: saturation is not a lock. The window rolls and the count restarts.
    expect(await claim(db, new Date(NOW.getTime() + 60_001))).toBe(true);
    expect((await row(db)).failures).toBe(1);
  });
});
