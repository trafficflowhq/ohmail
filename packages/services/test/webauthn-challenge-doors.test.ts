import { randomUUID } from "node:crypto";
import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import { makeTestDb } from "@trafficflow/db/testing";
import { bindDb, sessions } from "@trafficflow/db";
import { webauthnChallenges, WEBAUTHN_CHALLENGE_RETENTION_MS } from "@trafficflow/db/cloud";
import {
  AuthService, dbFor, makeTestAuthDeps,
  type ServiceContext, type SessionUser,
} from "../src/index.js";
import { SoftwareAuthenticator } from "./webauthn-authenticator.js";

/**
 * EVERY CEREMONY START PRUNES (cloud 0034).
 *
 * `webauthn_challenges` grows by exactly one row per ceremony opened and by nothing else, so the
 * prune belongs on the START door and nowhere else — there it removes at the rate the table
 * grows. Three doors open a ceremony; a fix applied to one of them is half applied, which is what
 * this file exists to refuse. The prune's own arithmetic is in
 * `packages/db/test/webauthn-challenge-prune.test.ts`; here the claim is only that each door is
 * wired to it.
 */
const RPID = "ohmail.app";
const APP = "https://ohmail.app";
const PW = "pw-correct-horse";
const START = new Date("2026-09-12T00:00:00.000Z");

interface Harness {
  db: Awaited<ReturnType<typeof makeTestDb>>;
  svc: AuthService;
  ctxFor(over?: Partial<ServiceContext>): ServiceContext;
}

async function harness(): Promise<Harness> {
  const db = await makeTestDb();
  const svc = new AuthService(makeTestAuthDeps({ rpID: RPID, origin: APP }));
  const now = (): Date => START;
  return {
    db, svc,
    // A door before sign-in holds a handle bound to nothing; a call that carries a session, its account's.
    ctxFor: (over = {}) => ({
      db: over.accountId === undefined ? bindDb(db, { account: null }) : dbFor(db, over.accountId),
      accountId: "", userId: null, now, requestId: "r", ip: "1.2.3.4", ...over,
    }),
  };
}

/** The invite path's enrollment session — narrowed once here rather than at four call sites. */
async function registerUser(h: Harness): Promise<SessionUser> {
  const res = await h.svc.register(h.ctxFor(), {
    email: "gil@x.example", password: PW, displayName: "Gil", inviteCode: "INVITE-OK",
  });
  expect(res.status).toBe("enrollment");
  if (res.status !== "enrollment") throw new Error("register did not open an enrollment session");
  return res.user;
}

async function stepUppedCtx(h: Harness, user: SessionUser): Promise<ServiceContext> {
  const [row] = await h.db.insert(sessions).values({
    accountId: user.accountId, userId: user.userId, familyId: randomUUID(), scope: "full",
    accessExpiresAt: new Date(START.getTime() + 3_600_000),
    refreshExpiresAt: new Date(START.getTime() + 7_200_000),
    lastTwofaAt: START, lastSeenAt: START,
  }).returning();
  return h.ctxFor({
    userId: user.userId, accountId: user.accountId, sessionId: row!.id, origin: APP,
  });
}

/** One row that is past retention and therefore owed to the prune, however it got there. */
async function seedStaleChallenge(h: Harness): Promise<string> {
  const [row] = await h.db.insert(webauthnChallenges).values({
    challenge: `stale-${randomUUID()}`,
    type: "authentication", rpId: RPID, origin: APP,
    expiresAt: new Date(START.getTime() - WEBAUTHN_CHALLENGE_RETENTION_MS - 60_000),
  }).returning();
  return row!.id;
}

const stillThere = async (h: Harness, id: string): Promise<boolean> => {
  const [row] = await h.db.select({ n: sql<number>`count(*)::int` })
    .from(webauthnChallenges)
    .where(sql`${webauthnChallenges.id} = ${id}::uuid`);
  return Number(row?.n ?? 0) > 0;
};

describe("the three ceremony START doors", () => {
  it("the passkey REGISTRATION door prunes what has expired past retention", async () => {
    const h = await harness();
    const user = await registerUser(h);
    const ctx = await stepUppedCtx(h, user);
    const stale = await seedStaleChallenge(h);
    expect(await stillThere(h, stale)).toBe(true);

    await h.svc.webauthnRegisterOptions(ctx);

    expect(await stillThere(h, stale)).toBe(false);
  });

  it("the SIGN-IN assertion door prunes", async () => {
    const h = await harness();
    const user = await registerUser(h);
    // A factor has to exist before `login` hands back a token to assert against.
    const ctx = await stepUppedCtx(h, user);
    const auth = new SoftwareAuthenticator();
    const { options } = await h.svc.webauthnRegisterOptions(ctx);
    const cred = auth.register({ rpID: RPID, challenge: (options as any).challenge, origin: APP });
    await h.svc.webauthnRegisterVerify(ctx, { credential: cred, label: "MacBook" });

    const ch = await h.svc.login(h.ctxFor({ origin: APP }), { email: "gil@x.example", password: PW });
    expect(ch.status).toBe("twofa_required");
    const stale = await seedStaleChallenge(h);

    await h.svc.webauthnAssertOptions(
      h.ctxFor({ origin: APP }), { loginToken: (ch as any).loginToken as string },
    );

    expect(await stillThere(h, stale)).toBe(false);
  });

  it("the STEP-UP door prunes", async () => {
    const h = await harness();
    const user = await registerUser(h);
    const ctx = await stepUppedCtx(h, user);
    const auth = new SoftwareAuthenticator();
    const { options } = await h.svc.webauthnRegisterOptions(ctx);
    const cred = auth.register({ rpID: RPID, challenge: (options as any).challenge, origin: APP });
    await h.svc.webauthnRegisterVerify(ctx, { credential: cred, label: "MacBook" });

    const stale = await seedStaleChallenge(h);

    await h.svc.stepUpWebauthnOptions(ctx);

    expect(await stillThere(h, stale)).toBe(false);
  });

  it("a FAILING prune costs the ceremony nothing — the row it just wrote survives", async () => {
    // The control for the swallow. These doors are autocommit, so the challenge is committed
    // before the prune runs; the risk the `catch` carries is that somebody later wraps a door in
    // a transaction, where a thrown DELETE aborts it and the ceremony row vanishes while the
    // caller is handed options for a challenge that cannot be verified.
    const h = await harness();
    const user = await registerUser(h);
    const ctx = await stepUppedCtx(h, user);
    // A row is DUE, or the prune returns before it ever reaches the delete and this arm measures
    // nothing — which is exactly how its first version passed its own mutant.
    const stale = await seedStaleChallenge(h);
    const broken = new Proxy(dbFor(h.db, ctx.accountId) as unknown as object, {
      get(t, k) {
        if (k === "delete") return () => { throw new Error("prune refused"); };
        const v = Reflect.get(t, k, t) as unknown;
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
      },
    });

    const { options } = await h.svc.webauthnRegisterOptions({ ...ctx, db: broken as never });

    expect((options as { challenge: string }).challenge).toBeTruthy();
    const rows = await h.db.select().from(webauthnChallenges);
    // The new ceremony AND the row the prune failed to remove — nothing was lost, nothing was
    // removed, and the door answered.
    expect(rows.map((r) => r.id), "the ceremony row was lost when the prune threw")
      .toContain(stale);
    expect(rows).toHaveLength(2);
  });

  it("a LIVE ceremony is never pruned by the door that opens the next one", async () => {
    // The positive control for the three refusals above: the prune is keyed on expiry, so an
    // overlapping ceremony — two tabs, the ordinary case — survives a start beside it.
    const h = await harness();
    const user = await registerUser(h);
    const ctx = await stepUppedCtx(h, user);

    await h.svc.webauthnRegisterOptions(ctx);
    const [first] = await h.db.select().from(webauthnChallenges);
    await h.svc.webauthnRegisterOptions(ctx);

    expect(await stillThere(h, first!.id)).toBe(true);
    const rows = await h.db.select().from(webauthnChallenges);
    expect(rows).toHaveLength(2);
  });
});
