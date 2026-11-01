import { describe, expect, it } from "vitest";
import { makeTestDb } from "@trafficflow/db/testing";
import { type Tx } from "@trafficflow/db";
import { authThrottle, invites, waitlist } from "@trafficflow/db/cloud";
import { eq } from "drizzle-orm";
import {
  consumeInvite, generateInviteCode, issueInvite, liveInvitesFor, normalizeInviteCode,
  pruneExpiredInvites, inviteError, hashToken, revokeInvitesFor,
  makeWaitlistService, SpyMailer, makeMailService, makeTestAuthDeps, throttleKeysFor,
  type Db,
} from "@trafficflow/services";

/**
 * Stage-2 the invite primitive, unit level.
 *
 * The HTTP walkthrough (`packages/api/test/onboarding-flow.test.ts`) proves the flow. This
 * file proves the properties the flow only samples: the hashing, the binding, the format
 * normalisation, and the refusal classification's disclosure rule.
 */

const NOW = new Date("2026-07-31T12:00:00.000Z");
const asTx = (db: Db): Tx => db as unknown as Tx;

async function fresh(): Promise<{ db: Db; tx: Tx }> {
  const db = await makeTestDb();
  return { db, tx: asTx(db) };
}

describe("the code format", () => {
  it("is 12 symbols from an unambiguous alphabet, grouped for a human to read out", () => {
    for (let i = 0; i < 50; i++) {
      const code = generateInviteCode();
      expect(code).toMatch(/^OHMAIL-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
      // I, L, O and U are excluded so 1/I and 0/O cannot be transcribed wrong.
      expect(code.slice(7)).not.toMatch(/[ILOU]/);
    }
  });

  it("does not repeat", () => {
    const seen = new Set(Array.from({ length: 500 }, () => generateInviteCode()));
    expect(seen.size).toBe(500);
  });

  it("normalises what a human actually pastes", () => {
    const code = "OHMAIL-A1B2-C3D4-E5F6";
    for (const variant of [
      code, code.toLowerCase(), `  ${code}  `, "ohmail a1b2 c3d4 e5f6",
      "OHMAILA1B2C3D4E5F6", "Ohmail-a1b2-c3d4-e5f6",
    ]) {
      expect(normalizeInviteCode(variant)).toBe(code);
    }
  });

  /**
   * THE REGRESSION THE MINT-BASED TESTS CANNOT SEE.
   *
   * Every other case in this file starts at `generateInviteCode()`, so it always exercises
   * whatever prefix is current — which is precisely why the `mailoh → ohmail` rename slipped
   * through green. `code_hash` is `sha256` of the canonical string, so the prefix is inside
   * the hash and a legacy code must canonicalise back to its OWN prefix, not the new one.
   * These literals are deliberately hard-coded: a future rename must break this test.
   */
  it("still canonicalises a pre-rebrand MAILOH- code, prefix intact", () => {
    const legacy = "MAILOH-A1B2-C3D4-E5F6";
    for (const variant of [
      legacy, legacy.toLowerCase(), `  ${legacy}  `, "mailoh a1b2 c3d4 e5f6",
      "MAILOHA1B2C3D4E5F6", "Mailoh-a1b2-c3d4-e5f6",
    ]) {
      expect(normalizeInviteCode(variant)).toBe(legacy);
    }
    // …and it is NOT rewritten to the current prefix, which would hash to a different value.
    expect(normalizeInviteCode(legacy)).not.toContain("OHMAIL");
  });

  it("a legacy MAILOH- invite row is still redeemable by a mangled paste", async () => {
    const { db, tx } = await fresh();
    // A row exactly as the pre-rebrand mint wrote it: the hash of a `MAILOH-` string.
    const legacy = "MAILOH-7Q2K-9XT4-M3PW";
    await db.insert(invites).values({
      codeHash: hashToken(legacy),
      email: "legacy@example.com",
      expiresAt: new Date(NOW.getTime() + 86_400_000),
    });
    const out = await consumeInvite(tx, {
      code: "  mailoh 7q2k 9xt4 m3pw ", email: "legacy@example.com", now: NOW,
    });
    expect(out.ok).toBe(true);
  });

  it("leaves a non-ohmail string alone, so the operator bootstrap set still works", () => {
    // `AuthConfig.inviteCodes` holds arbitrary operator strings (`INVITE-OK` in the test
    // harness). Normalising those would break the bootstrap path this slice keeps.
    expect(normalizeInviteCode("INVITE-OK")).toBe("INVITE-OK");
    expect(normalizeInviteCode(" beta-2026 ")).toBe("beta-2026");
    // A OHMAIL-prefixed string of the wrong length is not one of ours: untouched, and it
    // will simply not match any row.
    expect(normalizeInviteCode("OHMAIL-SHORT")).toBe("OHMAIL-SHORT");
  });
});

describe("issueInvite", () => {
  it("stores the code HASHED — a database dump is not a list of working invites", async () => {
    const { db, tx } = await fresh();
    const { code } = await issueInvite(tx, {
      email: "A@Example.com", expiresAt: new Date(NOW.getTime() + 86_400_000), now: NOW,
    });
    const [row] = await db.select().from(invites);
    expect(row!.codeHash).not.toBe(code);
    expect(row!.codeHash).not.toContain(code.slice(7));
    // `hashToken` is sha256 → base64url, the same at-rest shape as every other bearer
    // credential in this schema (`sessions`, `login_tokens`, `oauth_auth_codes`).
    expect(row!.codeHash).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // The binding is normalised, so it can match a normalised register email.
    expect(row!.email).toBe("a@example.com");
  });

  it("stamps `waitlist.invited_at` when the address is on the list", async () => {
    const { db, tx } = await fresh();
    const svc = makeWaitlistService({});
    await svc.join({ db, now: () => NOW }, { email: "w@example.com", tier: "solo" });
    await issueInvite(tx, {
      email: "w@example.com", expiresAt: new Date(NOW.getTime() + 86_400_000), now: NOW,
    });
    const [row] = await db.select().from(waitlist).where(eq(waitlist.email, "w@example.com"));
    expect(row!.invitedAt).not.toBeNull();
  });

  it("refuses an expiry in the past — an already-dead invite helps nobody", async () => {
    const { tx } = await fresh();
    await expect(issueInvite(tx, {
      email: "a@example.com", expiresAt: new Date(NOW.getTime() - 1), now: NOW,
    })).rejects.toMatchObject({ code: "validation_failed", httpStatus: 400 });
  });

  it("refuses an address that is not one", async () => {
    const { tx } = await fresh();
    await expect(issueInvite(tx, {
      email: "not an address", expiresAt: new Date(NOW.getTime() + 1000), now: NOW,
    })).rejects.toMatchObject({ code: "validation_failed" });
  });
});

describe("consumeInvite — single use, email-bound, and careful about what it discloses", () => {
  const later = new Date(NOW.getTime() + 3_600_000);

  async function seeded(email = "a@example.com"): Promise<{ db: Db; tx: Tx; code: string }> {
    const { db, tx } = await fresh();
    const { code } = await issueInvite(tx, {
      email, expiresAt: new Date(NOW.getTime() + 86_400_000), now: NOW,
    });
    return { db, tx, code };
  }

  it("consumes exactly once", async () => {
    const { tx, code } = await seeded();
    const first = await consumeInvite(tx, { code, email: "a@example.com", now: later });
    expect(first.ok).toBe(true);
    const second = await consumeInvite(tx, { code, email: "a@example.com", now: later });
    expect(second).toEqual({ ok: false, refusal: "used" });
  });

  it("REFUSES a different address, and calls it `unknown` — not `used`, not `mismatch`", async () => {
    // THE ORACLE RULE. `used` and `expired` are told only to a caller who already proved
    // they hold the bound address; anything else is byte-identical to a garbage code, so a
    // leaked invite cannot be walked across the user table.
    const { tx, code } = await seeded("owner@example.com");
    expect(await consumeInvite(tx, { code, email: "other@example.com", now: later }))
      .toEqual({ ok: false, refusal: "unknown" });
    expect(await consumeInvite(tx, { code: "OHMAIL-ZZZZ-ZZZZ-ZZZZ", email: "other@example.com", now: later }))
      .toEqual({ ok: false, refusal: "unknown" });

    // …and the probe did not consume it.
    expect(await consumeInvite(tx, { code, email: "owner@example.com", now: later })).toMatchObject({ ok: true });
  });

  it("a CONSUMED code still answers `unknown` to the wrong address", async () => {
    const { tx, code } = await seeded("owner@example.com");
    await consumeInvite(tx, { code, email: "owner@example.com", now: later });
    expect(await consumeInvite(tx, { code, email: "other@example.com", now: later }))
      .toEqual({ ok: false, refusal: "unknown" });
  });

  it("distinguishes expired from unknown, but only for the bound address", async () => {
    const { tx, code } = await seeded("owner@example.com");
    const wayLater = new Date(NOW.getTime() + 8 * 86_400_000);
    expect(await consumeInvite(tx, { code, email: "owner@example.com", now: wayLater }))
      .toEqual({ ok: false, refusal: "expired" });
    expect(await consumeInvite(tx, { code, email: "other@example.com", now: wayLater }))
      .toEqual({ ok: false, refusal: "unknown" });
  });

  it("empty and malformed inputs are `unknown`, never a throw", async () => {
    const { tx } = await fresh();
    for (const input of [
      { code: "", email: "a@example.com" },
      { code: "x", email: "" },
      { code: "x", email: "not an address" },
    ]) {
      expect(await consumeInvite(tx, { ...input, now: later })).toEqual({ ok: false, refusal: "unknown" });
    }
  });

  it("accepts a mangled paste of a real code", async () => {
    const { tx, code } = await seeded();
    const mangled = code.toLowerCase().replace(/-/g, " ");
    expect(await consumeInvite(tx, { code: mangled, email: "a@example.com", now: later }))
      .toMatchObject({ ok: true });
  });
});

describe("revocation — the remedy for a code that went to the wrong inbox", () => {
  it("a revoked invite stops opening an account, and says the same thing as an expired one", async () => {
    const { db, tx } = await fresh();
    const { code } = await issueInvite(tx, {
      email: "leak@example.com", expiresAt: new Date(NOW.getTime() + 86_400_000), now: NOW,
    });
    expect(await revokeInvitesFor(tx, { email: "leak@example.com", now: NOW, reason: "forwarded" })).toBe(1);

    const out = await consumeInvite(tx, { code, email: "leak@example.com", now: NOW });
    expect(out.ok).toBe(false);
    expect((out as { refusal: string }).refusal).toBe("revoked");

    // …and the WIRE answer is byte-identical to `expired`. Whoever is holding a revoked code
    // is, by hypothesis, not always the person it was meant for; "this was cancelled" tells
    // them somebody noticed, and buys nothing.
    const revoked = inviteError("revoked");
    const expired = inviteError("expired");
    expect(revoked.code).toBe(expired.code);
    expect(revoked.message).toBe(expired.message);
    expect(revoked.httpStatus).toBe(expired.httpStatus);

    const [row] = await db.select().from(invites);
    expect(row!.revokedAt).not.toBeNull();
    expect(row!.revokedBy).toBe("operator");
    expect(row!.revokedReason).toBe("forwarded");
    expect(row!.consumedAt).toBeNull();          // revoked ≠ used
  });

  it("is idempotent, and never rewrites a CONSUMED invite", async () => {
    const { db, tx } = await fresh();
    const { code } = await issueInvite(tx, {
      email: "spent@example.com", expiresAt: new Date(NOW.getTime() + 86_400_000), now: NOW,
    });
    expect((await consumeInvite(tx, { code, email: "spent@example.com", now: NOW })).ok).toBe(true);

    // Nothing live to take back — `consumed_by_user_id` is the record of which invite opened
    // which account, and revoking after the fact would rewrite it without closing anything.
    expect(await revokeInvitesFor(tx, { email: "spent@example.com", now: NOW })).toBe(0);
    expect((await db.select().from(invites))[0]!.revokedAt).toBeNull();
  });

  it("`liveInvitesFor` stops counting a revoked code, so --force is not blocked by it", async () => {
    const { tx } = await fresh();
    await issueInvite(tx, {
      email: "again@example.com", expiresAt: new Date(NOW.getTime() + 86_400_000), now: NOW,
    });
    expect(await liveInvitesFor(tx, "again@example.com", NOW)).toHaveLength(1);
    await revokeInvitesFor(tx, { email: "again@example.com", now: NOW });
    expect(await liveInvitesFor(tx, "again@example.com", NOW)).toHaveLength(0);
  });
});

describe("the refusal → HTTP mapping", () => {
  it("three refusals, three codes, three statuses, three remedies", () => {
    expect(inviteError("unknown")).toMatchObject({ code: "invite_invalid", httpStatus: 403 });
    expect(inviteError("used")).toMatchObject({ code: "invite_used", httpStatus: 409 });
    expect(inviteError("expired")).toMatchObject({ code: "invite_expired", httpStatus: 403 });
    // Each message must contain a next action, not merely a diagnosis.
    expect(inviteError("used").message).toMatch(/sign in/i);
    expect(inviteError("expired").message).toMatch(/fresh one/i);
    expect(inviteError("unknown").message).toMatch(/check the code/i);
  });
});

describe("liveInvitesFor / pruneExpiredInvites", () => {
  it("lists only unconsumed, unexpired invites for the address", async () => {
    const { tx } = await fresh();
    const live = await issueInvite(tx, {
      email: "x@example.com", expiresAt: new Date(NOW.getTime() + 86_400_000), now: NOW,
    });
    await issueInvite(tx, {
      email: "x@example.com", expiresAt: new Date(NOW.getTime() + 1000), now: NOW,
    });
    const spent = await issueInvite(tx, {
      email: "x@example.com", expiresAt: new Date(NOW.getTime() + 86_400_000), now: NOW,
    });
    await consumeInvite(tx, { code: spent.code, email: "x@example.com", now: NOW });

    // At `NOW + 1h` the short one has expired and the consumed one is gone.
    const rows = await liveInvitesFor(tx, "X@Example.com", new Date(NOW.getTime() + 3_600_000));
    expect(rows.map((r) => r.id)).toEqual([live.inviteId]);
  });

  it("prunes long-expired UNCONSUMED invites and keeps the consumed audit trail", async () => {
    const { db, tx } = await fresh();
    const old = await issueInvite(tx, {
      email: "old@example.com", expiresAt: new Date(NOW.getTime() + 1000), now: NOW,
    });
    const used = await issueInvite(tx, {
      email: "used@example.com", expiresAt: new Date(NOW.getTime() + 1000), now: NOW,
    });
    await consumeInvite(tx, { code: used.code, email: "used@example.com", now: NOW });

    const muchLater = new Date(NOW.getTime() + 200 * 86_400_000);
    expect(await pruneExpiredInvites(tx, muchLater)).toBe(1);
    const left = await db.select().from(invites);
    expect(left.map((r) => r.id)).toEqual([used.inviteId]);
    void old;
  });
});

describe("WaitlistService", () => {
  const ctxOf = (db: Db) => ({ db, now: () => NOW });
  const keys = throttleKeysFor(makeTestAuthDeps().keyProvider);

  function svcWithSpy(): { svc: ReturnType<typeof makeWaitlistService>; spy: SpyMailer } {
    const spy = new SpyMailer();
    const mail = makeMailService({
      mailer: spy,
      config: {
        appUrl: "http://localhost:3001", siteUrl: "http://localhost:3000",
        supportEmail: "support@ohmail.app",
      },
      throttleKeys: keys,
    });
    return { svc: makeWaitlistService({ mail, throttleKeys: keys }), spy };
  }

  it("records a signup and mails the confirmation with the chosen tier", async () => {
    const db = await makeTestDb();
    const { svc, spy } = svcWithSpy();
    expect(await svc.join(ctxOf(db), { email: " Gil@Example.com ", tier: "plus" }))
      .toEqual({ status: "ok", mailed: true });
    const send = spy.only("waitlist_confirmation");
    expect(send.to).toBe("gil@example.com");
    expect(send.data.tier).toBe("plus");
  });

  it("counts a connection under the deployment's keyed hash; with no keyer a join from one is refused and writes nothing", async () => {
    const db = await makeTestDb();
    const ip = "203.0.113.9";
    await makeWaitlistService({ throttleKeys: keys }).join({ ...ctxOf(db), ip }, { email: "keyed@example.com" });
    const rows = await db.select().from(authThrottle);
    expect(rows.map((r) => r.key)).toEqual([`waitlist:ip:${keys.client(ip)}`]);
    expect(rows[0]!.key, "a plain digest of an address is reversed by a guess").not.toContain(hashToken(ip));

    const bare = await makeTestDb();
    await expect(makeWaitlistService({}).join({ ...ctxOf(bare), ip }, { email: "unkeyed@example.com" })).rejects.toThrow();
    expect(await bare.select().from(waitlist), "a refused join wrote its row").toEqual([]);
    expect(await bare.select().from(authThrottle), "a refused join counted in the clear").toEqual([]);
  });

  it("records the signup even with NO mailer, and says so", async () => {
    const db = await makeTestDb();
    const svc = makeWaitlistService({});
    expect(await svc.join(ctxOf(db), { email: "nomail@example.com" }))
      .toEqual({ status: "ok", mailed: false });
    expect((await svc.stats(ctxOf(db))).total).toBe(1);
  });

  it("`--force` REVOKES the code it replaces — the leaked one must not stay live", async () => {
    // The documented remedy for a misdirected invite used to leave the compromised code
    // working for the rest of its fortnight NEXT TO its replacement: two live keys to one
    // account, from the command whose purpose was to take one away.
    const { db } = await fresh();
    const svc = makeWaitlistService({});
    const ctx = { db, now: () => NOW };
    const first = await svc.mintInvite(ctx, { email: "reissue@example.com", send: false });
    const second = await svc.mintInvite(ctx, {
      email: "reissue@example.com", send: false, requireNoLiveInvite: false,
    });
    expect(second.revoked).toBe(1);

    const tx = asTx(db);
    expect((await consumeInvite(tx, { code: first.code, email: "reissue@example.com", now: NOW })).ok)
      .toBe(false);
    expect((await consumeInvite(tx, { code: second.code, email: "reissue@example.com", now: NOW })).ok)
      .toBe(true);
  });

  it("mintInvite refuses a second live invite unless forced", async () => {
    const db = await makeTestDb();
    const { svc } = svcWithSpy();
    await svc.mintInvite(ctxOf(db), { email: "one@example.com" });
    await expect(svc.mintInvite(ctxOf(db), { email: "one@example.com" }))
      .rejects.toMatchObject({ code: "invite_exists", httpStatus: 409 });
    // …and forcing works, because a lost code has no other remedy (it is stored hashed).
    const forced = await svc.mintInvite(ctxOf(db), {
      email: "one@example.com", requireNoLiveInvite: false,
    });
    expect(forced.code).toMatch(/^OHMAIL-/);
  });

  it("mintInvite with `send: false` mints and mails NOTHING", async () => {
    const db = await makeTestDb();
    const { svc, spy } = svcWithSpy();
    const out = await svc.mintInvite(ctxOf(db), { email: "quiet@example.com", send: false });
    expect(out.mail).toBeNull();
    expect(spy.sent).toHaveLength(0);
  });

  it("DELIVERY decides whether the invite confers verification — mailed yes; hand-delivered, failed and skipped no", async () => {
    // The register path stamps `email_verified_at` only for a row whose consumption proves
    // address control, and for an operator invite that proof is RECEIPT — so the row must not
    // claim it until the mail actually went out. The mint issues non-conferring and upgrades
    // after a `sent` result; a hand-delivered code (`send: false`), a transport failure and a
    // skipped send all leave the row non-conferring, and that account verifies later through
    // the ordinary mailed flow. Anything else preserves the exact forgery the pairing-redeem
    // fix closed, one caller over: a code nobody's inbox ever received opening a verified
    // account.
    const db = await makeTestDb();
    const { svc, spy } = svcWithSpy();
    const rowFor = async (email: string) =>
      (await db.select().from(invites).where(eq(invites.email, email)))[0]!;

    // Mailed, and the transport says `sent` → the row confers.
    const mailed = await svc.mintInvite(ctxOf(db), { email: "mailed@example.com" });
    expect(mailed.mail?.status).toBe("sent");
    expect((await rowFor("mailed@example.com")).confersVerified).toBe(true);

    // Hand delivery: the operator reads the code off their terminal. Registration still works;
    // verification is not conferred, because nothing proved the recipient holds the address.
    await svc.mintInvite(ctxOf(db), { email: "hand@example.com", send: false });
    expect((await rowFor("hand@example.com")).confersVerified).toBe(false);

    // The transport FAILED: the documented remedy is hand delivery of the on-screen code, so
    // this is the previous case wearing an error — it must not confer either.
    spy.failNext();
    const failed = await svc.mintInvite(ctxOf(db), { email: "failed@example.com" });
    expect(failed.mail?.status).toBe("failed");
    expect((await rowFor("failed@example.com")).confersVerified).toBe(false);

    // Skipped (a mailer that refuses to send) — same reading.
    spy.skipNext();
    const skipped = await svc.mintInvite(ctxOf(db), { email: "skipped@example.com" });
    expect(skipped.mail?.status).toBe("skipped");
    expect((await rowFor("skipped@example.com")).confersVerified).toBe(false);

    // …and the end of the chain: consuming the hand-delivered code reports the truth to the
    // register path, which will therefore create the account UNVERIFIED.
    const hand = await svc.mintInvite(ctxOf(db), {
      email: "hand2@example.com", send: false,
    });
    const outcome = await consumeInvite(asTx(db), {
      code: hand.code, email: "hand2@example.com", now: NOW,
    });
    expect(outcome.ok && outcome.confersVerified,
      "an undelivered invite's consumption must not claim address control").toBe(false);
  });

  it("the invite mail carries the redeem URL the /join page reads", async () => {
    const db = await makeTestDb();
    const { svc, spy } = svcWithSpy();
    const out = await svc.mintInvite(ctxOf(db), { email: "link@example.com" });
    const send = spy.only("invite");
    expect(send.data.redeemUrl).toBe(
      `http://localhost:3001/join?code=${encodeURIComponent(out.code)}`,
    );
  });

  it("`list --pending` is who has not been invited yet, oldest first", async () => {
    const db = await makeTestDb();
    const { svc } = svcWithSpy();
    await svc.join(ctxOf(db), { email: "a@example.com" });
    await svc.join(ctxOf(db), { email: "b@example.com" });
    await svc.mintInvite(ctxOf(db), { email: "a@example.com" });

    const pending = await svc.list(ctxOf(db), { pending: true });
    expect(pending.map((r) => r.email)).toEqual(["b@example.com"]);
    expect(await svc.stats(ctxOf(db))).toEqual({ total: 2, invited: 1, registered: 0 });
  });
});
