import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { eq, sql } from "drizzle-orm";
import { accounts, users, sessions, devices, pairingTokens } from "@trafficflow/db";
import { invites, schema } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import {
  mintPairingToken, consumePairingToken, redeemInviteGrant, redeemDevicePair,
  revokePairingToken, listPairingTokens,
  PAIRING_LIVE_TOKENS_MAX, PAIRING_TTL_BOUNDS,
  makeAuthService, makeTestAuthDeps, hashToken, MailService, SpyMailer, throttleKeysFor,
  type ServiceContext, type PairedDeviceSessionMinter,
} from "@trafficflow/services";

/**
 * THE PAIRING TOKEN AGAINST REAL POSTGRES: the claims PGlite structurally cannot judge,
 * plus the whole mint/redeem/revoke bound census in one place.
 *
 *  1. **SINGLE-USE UNDER CONCURRENCY.** Redemption is ONE
 *     `UPDATE … SET consumed_at = now() WHERE token_hash = $1 AND "grant" = $2 AND consumed_at
 *     IS NULL AND revoked_at IS NULL AND expires_at > now() RETURNING`, so the row lock decides
 *     the race and exactly one presenter wins. The defect this shape forbids —
 *     SELECT-check-UPDATE — passes every sequential test ever written and hands N simultaneous
 *     presentations N sessions (or N invites). PGlite is one connection and can never
 *     interleave two redeems; `desktop-link.pg.test.ts` and
 *     `invite-consumption.concurrency.pg.test.ts` are the same guard over the two ancestors
 *     this module borrows its statement from. A start BARRIER releases every presenter in the
 *     same tick, and each runs its transaction on its own pool connection.
 *
 *  2. **HASH AT REST.** The whole ROW cast to text and searched by Postgres for the raw token —
 *     never a field-by-field check, because the risk is a column somebody adds later.
 *
 *  3. **THE INVITE-GRANT BRIDGE BUYS REGISTRATION WITHOUT A MAILER — NOT VERIFICATION.**
 *     redeem → `POST /auth/register`-equivalent → an account exists. Whether it starts VERIFIED
 *     is decided by the consumed TOKEN's own record: the first-boot OWNERLESS token confers it
 *     (whoever redeems the token printed to the server's stdout is the operator — box control is
 *     the proof), a user-minted token does NOT (its holder typed an address nothing was ever
 *     mailed to, so receipt proves nothing and the account verifies later through the ordinary
 *     mailed flow). The earlier revision of this file demonstrated the opposite — every
 *     invite-grant registration arrived verified — which was a verification forgery reachable by
 *     anyone handed a pairing token; the cases below assert the forgery is dead and that no
 *     caller-supplied input can resurrect it.
 *
 * `describe.skipIf` on a missing Postgres; `TF_REQUIRE_PG=1` (`pnpm test:pg`) makes
 * `realPgAvailable()` throw instead, so CI cannot silently skip this file.
 */
const PG_UP = await realPgAvailable();

const FIXED_NOW = new Date("2026-08-17T12:00:00.000Z");

let client: ReturnType<typeof postgres>;
let db: ReturnType<typeof drizzle<typeof schema>>;

/** A ServiceContext over the shared pool — each `.transaction()` call checks out its OWN
 *  connection, which is what makes `Promise.all` here a real race rather than a queue. */
const ctxFor = (userId: string | null, now: Date = FIXED_NOW): ServiceContext => ({
  db: db as unknown as ServiceContext["db"],
  accountId: "",
  userId,
  sessionId: null,
  now: () => now,
  requestId: `s2-${randomUUID()}`,
  ip: `10.1.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250) + 1}`,
});

async function seedUser(): Promise<{ userId: string; accountId: string }> {
  const [acct] = await db.insert(accounts).values({ name: `pair-${randomUUID()}` }).returning();
  const [user] = await db.insert(users).values({
    accountId: acct!.id, email: `p-${randomUUID()}@example.com`, displayName: "P",
    emailVerifiedAt: FIXED_NOW,
  }).returning();
  return { userId: user!.id, accountId: acct!.id };
}

/** Release N waiting presenters in one tick — the barrier that makes "simultaneous" a fact
 *  of the dispatch rather than a hope about the scheduler. */
function volley<T>(n: number, shot: (i: number) => Promise<T>): { fire: () => void; results: Promise<PromiseSettledResult<T>[]> } {
  let open!: () => void;
  const gun = new Promise<void>((resolve) => { open = resolve; });
  const shots = Array.from({ length: n }, (_, i) => (async () => { await gun; return shot(i); })());
  return { fire: open, results: Promise.allSettled(shots) };
}

const errCode = (r: PromiseSettledResult<unknown>): string =>
  ((r as PromiseRejectedResult).reason as { code?: string }).code ?? "(none)";

describe.skipIf(!PG_UP)("on real Postgres — a pairing token is spent exactly once", () => {
  const FANOUT = 12;
  let auth: ReturnType<typeof makeAuthService>;

  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    // A POOL with headroom over the fan-out, deliberately: `max: 1` would serialise the
    // transactions and reintroduce the exact blind spot this file exists to remove.
    client = postgres(PG_TEST_URL, { max: FANOUT + 4 });
    db = brandDialect(drizzle(client, { schema }), "pg");
    auth = makeAuthService(makeTestAuthDeps());
  }, 60_000);
  afterAll(async () => { await client?.end({ timeout: 5 }); });

  it("TWELVE simultaneous device-pair redeems of one token: ONE session, ONE device, eleven refusals", async () => {
    const { userId } = await seedUser();
    const minted = await mintPairingToken(ctxFor(userId), {
      grant: "device-pair", label: "Kitchen iPad",
    });

    const { fire, results } = volley(FANOUT, () =>
      redeemDevicePair(ctxFor(null), auth, { token: minted.token }));
    fire();
    const settled = await results;

    const won = settled.filter((r) => r.status === "fulfilled");
    expect(won, `outcomes: ${settled.map((r) => r.status === "fulfilled" ? "ok" : errCode(r)).join(",")}`)
      .toHaveLength(1);
    // Every loser got the ONE refusal — never a driver error, never a second success.
    for (const r of settled.filter((x) => x.status === "rejected")) {
      expect(errCode(r)).toBe("pairing_invalid");
      expect(((r as PromiseRejectedResult).reason as { httpStatus?: number }).httpStatus).toBe(400);
    }

    // The database's own count — the fact the settled statuses are only evidence for. A flow
    // that answered one success and eleven refusals while establishing twelve sessions would
    // pass the assertions above and be the exact defect.
    expect(await db.select().from(sessions).where(eq(sessions.userId, userId))).toHaveLength(1);
    const devs = await db.select().from(devices).where(eq(devices.userId, userId));
    expect(devs).toHaveLength(1);
    expect(devs[0]!.label).toBe("Kitchen iPad");

    const [row] = await db.select().from(pairingTokens).where(eq(pairingTokens.id, minted.id));
    expect(row!.consumedAt).not.toBeNull();

    // …and the bearer pair the winner holds resolves to a session with NO step-up standing:
    // `lastTwofaAt` NULL, by `establishPairedDevice`'s design, so a freshly paired device fails
    // step-up closed until its holder asserts a factor of their own.
    expect((await db.select().from(sessions).where(eq(sessions.userId, userId)))[0]!.lastTwofaAt)
      .toBeNull();
  }, 60_000);

  it("TEN simultaneous invite-grant redeems of one token mint exactly ONE invite", async () => {
    const { userId } = await seedUser();
    const minted = await mintPairingToken(ctxFor(userId), { grant: "invite", label: "family" });

    const { fire, results } = volley(10, (i) =>
      redeemInviteGrant(ctxFor(null), { token: minted.token, email: `race-${i}-${randomUUID()}@example.com` }));
    fire();
    const settled = await results;

    expect(settled.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of settled.filter((x) => x.status === "rejected")) {
      expect(errCode(r)).toBe("pairing_invalid");
    }
    // One invite row, attributed to this token — the transaction kept burn and mint atomic
    // in BOTH directions under the race.
    const issued = await db.select().from(invites)
      .where(eq(invites.issuedBy, `pairing:${minted.id}`));
    expect(issued).toHaveLength(1);
    // The creator's own words ("family") must NOT be copied into the derived invite's `note`
    // (a review finding): that row is keyed by the REDEEMER's email and outlives the creator's account,
    // so a personal label there is a fragment of the creator's authored text that erasure — which
    // cleans pairing_tokens but not this invite — would leave behind. `issued_by` already carries
    // the traceability, so the label has no second home to be in.
    expect(issued[0]!.note).toBeNull();
  }, 60_000);

  it("the raw token's plaintext appears in NO column of pairing_tokens; the digest does", async () => {
    const { userId } = await seedUser();
    const minted = await mintPairingToken(ctxFor(userId), { grant: "invite" });

    // Every column, cast to text and searched by Postgres — not a named-field check, because
    // the risk this guards is a column somebody adds LATER that starts carrying the raw value.
    const [hit] = await db.execute(sql`
      select count(*)::int as n from pairing_tokens
      where pairing_tokens::text like ${`%${minted.token}%`}
    `) as unknown as Array<{ n: number }>;
    expect(hit!.n, "the raw pairing token is stored somewhere in pairing_tokens").toBe(0);

    const [row] = await db.select().from(pairingTokens).where(eq(pairingTokens.id, minted.id));
    expect(row!.tokenHash).toBe(hashToken(minted.token));
  }, 30_000);

  it("expired refused; revoked refused; consumed refused twice — and NONE of the refusals burns", async () => {
    const { userId } = await seedUser();

    // EXPIRED: minted at FIXED_NOW with the 5-minute default, presented one second past it.
    const expired = await mintPairingToken(ctxFor(userId), { grant: "device-pair", label: "late" });
    const late = new Date(FIXED_NOW.getTime() + 5 * 60_000 + 1000);
    await expect(redeemDevicePair(ctxFor(null, late), auth, { token: expired.token }))
      .rejects.toMatchObject({ code: "pairing_invalid" });
    expect((await db.select().from(pairingTokens).where(eq(pairingTokens.id, expired.id)))[0]!.consumedAt)
      .toBeNull();

    // REVOKED: taken back by its creator, then presented.
    const revoked = await mintPairingToken(ctxFor(userId), { grant: "invite" });
    expect(await revokePairingToken(ctxFor(userId), revoked.id)).toBe(true);
    await expect(redeemInviteGrant(ctxFor(null), { token: revoked.token, email: "a@example.com" }))
      .rejects.toMatchObject({ code: "pairing_invalid" });

    // CONSUMED, twice: the first spend wins, the second is indistinguishable from unknown.
    const once = await mintPairingToken(ctxFor(userId), { grant: "device-pair", label: "once" });
    await redeemDevicePair(ctxFor(null), auth, { token: once.token });
    await expect(redeemDevicePair(ctxFor(null), auth, { token: once.token }))
      .rejects.toMatchObject({ code: "pairing_invalid", httpStatus: 400 });
  }, 30_000);

  it("the WRONG grant matches no row and burns nothing — the grant is a conjunct of the burn statement", async () => {
    const { userId } = await seedUser();
    const minted = await mintPairingToken(ctxFor(userId), { grant: "device-pair", label: "desk" });

    expect(await consumePairingToken(ctxFor(null), { token: minted.token, grant: "invite" })).toBeNull();
    expect((await db.select().from(pairingTokens).where(eq(pairingTokens.id, minted.id)))[0]!.consumedAt)
      .toBeNull();
    // The rightful arm still spends it.
    const spent = await consumePairingToken(ctxFor(null), { token: minted.token, grant: "device-pair" });
    expect(spent?.id).toBe(minted.id);
  }, 30_000);

  it("a USER-minted token's redeem + register: the account EXISTS and is NOT verified — the forgery is dead", async () => {
    // The reversal of what this very test used to demonstrate. A user-minted pairing token is
    // not email-bound: its holder types any address they like into the redeem, nothing was ever
    // mailed, so receipt proves nothing — and an account that arrived verified here was a
    // verification forgery (a mark of address control nobody established). The bridge still
    // buys what it exists for: registration with no mailer in the picture.
    const { userId } = await seedUser();
    const minted = await mintPairingToken(ctxFor(userId), { grant: "invite", label: "family" });
    const email = `fam-${randomUUID()}@example.com`;

    const redeemed = await redeemInviteGrant(ctxFor(null), { token: minted.token, email });
    expect(redeemed.email).toBe(email);

    // The invite row the redeem minted says so itself: it does not confer verification.
    const [derived] = await db.select().from(invites)
      .where(eq(invites.issuedBy, `pairing:${minted.id}`));
    expect(derived!.confersVerified, "a user-minted token's derived invite must not confer").toBe(false);

    // The client's next call, verbatim: the EXISTING register, invite path — same 201 shape,
    // same enrollment session. Only the verification mark is withheld.
    const svc = makeAuthService(makeTestAuthDeps());
    const reg = await svc.register(ctxFor(null), {
      email, password: "a-long-enough-password", displayName: "Fam", inviteCode: redeemed.code,
    });
    expect(reg.status).toBe("enrollment");

    const [created] = await db.select().from(users).where(eq(users.email, email));
    expect(created, "the account itself must exist — only the mark is withheld").toBeDefined();
    expect(created!.emailVerifiedAt,
      "a user-minted pairing token must NOT produce a verified account").toBeNull();
  }, 30_000);

  it("the OWNERLESS first-boot token's redeem + register: the account is created VERIFIED", async () => {
    // The one invite-grant path that DOES confer: `created_by_user_id IS NULL` is only mintable
    // by the composition root at boot (the API mint always has a session user), so whoever
    // presents this token read it off the server's own stdout — box control is address control
    // for the operator's login identifier on their own box.
    const boot = await mintPairingToken(ctxFor(null), { grant: "invite", label: "first-run setup" });
    const email = `boot-${randomUUID()}@example.com`;

    const redeemed = await redeemInviteGrant(ctxFor(null), { token: boot.token, email });
    const [derived] = await db.select().from(invites)
      .where(eq(invites.issuedBy, `pairing:${boot.id}`));
    expect(derived!.confersVerified, "the first-boot token's derived invite confers").toBe(true);

    const svc = makeAuthService(makeTestAuthDeps());
    const reg = await svc.register(ctxFor(null), {
      email, password: "a-long-enough-password", displayName: "Op", inviteCode: redeemed.code,
    });
    expect(reg.status).toBe("enrollment");

    const [created] = await db.select().from(users).where(eq(users.email, email));
    expect(created!.emailVerifiedAt, "the first-boot registration was NOT stamped verified")
      .not.toBeNull();
  }, 30_000);

  it("a FORGED confersVerified in the redeem input is ignored — the consumed row decides, not the caller", async () => {
    // The redeem is anonymous and public. If the flag were readable from input, any holder of a
    // user-minted token could upgrade their registration to verified by adding one JSON field —
    // the exact forgery the column closes, reintroduced through the wire. The service reads the
    // discriminator from the token row it consumed inside its own transaction and from nowhere
    // else; this presents the forged field and asserts it changed nothing.
    const { userId } = await seedUser();
    const minted = await mintPairingToken(ctxFor(userId), { grant: "invite" });
    const email = `forge-${randomUUID()}@example.com`;

    const redeemed = await redeemInviteGrant(ctxFor(null), {
      token: minted.token, email, confersVerified: true,
    } as never as { token: string; email: string });

    const [derived] = await db.select().from(invites)
      .where(eq(invites.issuedBy, `pairing:${minted.id}`));
    expect(derived!.confersVerified, "a caller-supplied flag must never upgrade the invite")
      .toBe(false);

    // …and the end-to-end fact the forger was after: the registration is still unverified.
    const svc = makeAuthService(makeTestAuthDeps());
    const reg = await svc.register(ctxFor(null), {
      email, password: "a-long-enough-password", displayName: "F", inviteCode: redeemed.code,
    });
    expect(reg.status).toBe("enrollment");
    const [created] = await db.select().from(users).where(eq(users.email, email));
    expect(created!.emailVerifiedAt, "the forged flag reached register anyway").toBeNull();
  }, 30_000);

  it("an account created UNVERIFIED through a pairing invite verifies later via the ordinary mailed flow", async () => {
    // The path out of the unverified state must actually work for these accounts: nothing about
    // arriving through a pairing invite may strand them. Register unverified, then run the same
    // resend + link + password ceremony every open-path signup uses, and watch the stamp land.
    const { userId } = await seedUser();
    const minted = await mintPairingToken(ctxFor(userId), { grant: "invite" });
    const email = `later-${randomUUID()}@example.com`;
    const password = "a-long-enough-password";

    const redeemed = await redeemInviteGrant(ctxFor(null), { token: minted.token, email });

    const spy = new SpyMailer();
    const mail = new MailService({
      mailer: spy,
      config: { appUrl: "https://ohmail.app", siteUrl: "https://ohmail.app", supportEmail: "support@ohmail.app" },
      throttleKeys: throttleKeysFor(makeTestAuthDeps().keyProvider),
    });
    const svc = makeAuthService(makeTestAuthDeps({}, mail));

    await svc.register(ctxFor(null), {
      email, password, displayName: "Later", inviteCode: redeemed.code,
    });
    const [before] = await db.select().from(users).where(eq(users.email, email));
    expect(before!.emailVerifiedAt).toBeNull();

    // The wizard's resend, as the signed-in user — the same endpoint every unverified account
    // reaches — then the mailed link plus the password, verbatim.
    await svc.resendVerification(ctxFor(before!.id));
    const token = new URL(spy.only("email_verification").data.verifyUrl).searchParams.get("token")!;
    expect(token.length).toBeGreaterThan(0);
    await svc.verifyEmail(ctxFor(null), { token, password });

    const [after] = await db.select().from(users).where(eq(users.email, email));
    expect(after!.emailVerifiedAt, "the mailed flow must verify a pairing-invited account")
      .not.toBeNull();
  }, 30_000);

  it("a device-pair redeem whose session mint FAILS un-burns the token — burn and mint share one transaction", async () => {
    const { userId } = await seedUser();
    const minted = await mintPairingToken(ctxFor(userId), { grant: "device-pair", label: "flaky" });

    const failing: PairedDeviceSessionMinter = {
      async establishPairedDevice() { throw new Error("session mint failed mid-ceremony"); },
    };
    await expect(redeemDevicePair(ctxFor(null), failing, { token: minted.token }))
      .rejects.toThrow("session mint failed mid-ceremony");

    // The rollback un-burned it: the person whose QR flow hiccuped can present the SAME token
    // again rather than re-running the step-up mint. (Stricter than the desktop claim, which
    // tolerates a burned code because a fresh one is one click away.)
    expect((await db.select().from(pairingTokens).where(eq(pairingTokens.id, minted.id)))[0]!.consumedAt)
      .toBeNull();
    expect((await redeemDevicePair(ctxFor(null), auth, { token: minted.token })).tokens.accessToken)
      .toBeTruthy();
  }, 30_000);

  it("an invalid email refuses BEFORE anything is consumed", async () => {
    const { userId } = await seedUser();
    const minted = await mintPairingToken(ctxFor(userId), { grant: "invite" });
    await expect(redeemInviteGrant(ctxFor(null), { token: minted.token, email: "not-an-address" }))
      .rejects.toMatchObject({ code: "validation_failed" });
    expect((await db.select().from(pairingTokens).where(eq(pairingTokens.id, minted.id)))[0]!.consumedAt)
      .toBeNull();
  }, 30_000);

  it("mint bounds: the grant whitelist, per-grant ttl caps, the label cap, and who may mint what", async () => {
    const { userId } = await seedUser();

    // The whitelist, at runtime — the TS union does not bind a JavaScript caller or wire input.
    await expect(mintPairingToken(ctxFor(userId), { grant: "backdoor" as never }))
      .rejects.toMatchObject({ code: "validation_failed" });

    // TTL: refused one second past the cap and under the floor, per grant — never clamped.
    await expect(mintPairingToken(ctxFor(userId), {
      grant: "device-pair", ttlSeconds: PAIRING_TTL_BOUNDS["device-pair"].maxMs / 1000 + 1,
    }))
      .rejects.toMatchObject({ code: "validation_failed" });
    await expect(mintPairingToken(ctxFor(userId), { grant: "device-pair", ttlSeconds: 30 }))
      .rejects.toMatchObject({ code: "validation_failed" });
    await expect(mintPairingToken(ctxFor(userId), { grant: "invite", ttlSeconds: 31 * 24 * 3600 }))
      .rejects.toMatchObject({ code: "validation_failed" });
    await expect(mintPairingToken(ctxFor(userId), { grant: "invite", ttlSeconds: 3.5 as never }))
      .rejects.toMatchObject({ code: "validation_failed" });

    await expect(mintPairingToken(ctxFor(userId), { grant: "invite", label: "x".repeat(101) }))
      .rejects.toMatchObject({ code: "validation_failed" });

    // A device-pair token with no creator would mint a session for nobody: refused at mint.
    // The ownerless mint is legal for the INVITE grant only — the first-boot setup token.
    await expect(mintPairingToken(ctxFor(null), { grant: "device-pair" }))
      .rejects.toMatchObject({ code: "validation_failed" });
    const boot = await mintPairingToken(ctxFor(null), { grant: "invite", label: "first-run setup" });
    expect(boot.token).toBeTruthy();
    const [bootRow] = await db.select().from(pairingTokens).where(eq(pairingTokens.id, boot.id));
    expect(bootRow!.createdByUserId).toBeNull();
  }, 30_000);

  it(`the live-token cap: mint ${PAIRING_LIVE_TOKENS_MAX}, and the next one refuses with its own code`, async () => {
    const { userId } = await seedUser();
    for (let i = 0; i < PAIRING_LIVE_TOKENS_MAX; i++) {
      await mintPairingToken(ctxFor(userId), { grant: "invite", label: `t${i}` });
    }
    await expect(mintPairingToken(ctxFor(userId), { grant: "invite" }))
      .rejects.toMatchObject({ code: "pairing_mint_limit", httpStatus: 409 });

    // Revoking one frees the slot — the remedy the refusal names.
    const mine = await listPairingTokens(ctxFor(userId));
    expect(await revokePairingToken(ctxFor(userId), mine[0]!.id)).toBe(true);
    await expect(mintPairingToken(ctxFor(userId), { grant: "invite" })).resolves.toBeTruthy();
  }, 60_000);

  it("list and revoke are creator-scoped: a sibling sees nothing and revokes nothing", async () => {
    const alice = await seedUser();
    const carol = await seedUser();
    const minted = await mintPairingToken(ctxFor(alice.userId), { grant: "invite", label: "mine" });

    const carols = await listPairingTokens(ctxFor(carol.userId));
    expect(carols.find((t) => t.id === minted.id)).toBeUndefined();
    expect(await revokePairingToken(ctxFor(carol.userId), minted.id)).toBe(false);

    const mine = await listPairingTokens(ctxFor(alice.userId));
    const listed = mine.find((t) => t.id === minted.id)!;
    expect(listed.status).toBe("live");
    // The projection never carries the hash — a key census over what the service returns.
    expect(Object.keys(listed).sort()).toEqual(
      ["consumedAt", "createdAt", "expiresAt", "grant", "id", "label", "revokedAt", "status"],
    );
  }, 30_000);
});
