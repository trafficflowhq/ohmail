import { accountOfMessage } from "@trafficflow/db";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { makeTestDb } from "@trafficflow/db/testing";
import {
  mailboxes, messages, folderState, organizerRequests, rules,
  capabilitiesColumn, hasCapability, readRequestEligibility, CAPABILITY_REQUESTS,
  CAPABILITY_MOVES, CAPABILITY_RULES, CAPABILITY_PROFILE,
} from "@trafficflow/db";
import {
  formatClaim, parseClaim, isMalformed, deriveRequestKey,
  REQUEST_KINDS, capabilityForKind,
} from "@trafficflow/core/adapters/organizer-lease";
import { ScreenerService, type ServiceContext } from "@trafficflow/services";
import { ORGANIZER_CAPABILITIES, organizerCapabilitiesFor } from "../src/lease.js";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *  NO KEY ⇒ NO CAPABILITY — the honest degraded mode, walked end to end (mail 0090)
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * An organizer may only apply a decision record it can VERIFY, and verifying takes the account's
 * request key. An organizer holding no key therefore has no request channel — and the correct
 * behaviour is not to accept decisions it will refuse for ever, but to advertise nothing, so a
 * reader is refused at its own door with a sentence that is true.
 *
 * That is a chain of five links across three packages, and this file walks it end to end in BOTH
 * directions through the real functions rather than asserting at one link:
 *
 *   the key (or its absence)
 *     → `organizerCapabilitiesFor`  (worker)   — what this claim will advertise
 *     → `formatClaim` / `parseClaim` (core)    — what actually goes in the mailbox and comes back
 *     → `organized_by_capabilities`  (db)      — what a reader stores from its peek
 *     → `readRequestEligibility`     (db)      — whether a decision may become a request
 *     → `ScreenerService.decide`     (services)— 202 with a queued row, or 409 `organizer_outdated`
 *
 * ── THE HEADER IS ADVISORY AND IS NEVER THE GATE ────────────────────────────────────────────
 *
 * `organized_by_capabilities` is copied from a claim, and a claim is a message anyone with APPEND
 * rights on the mailbox can write — so an attacker CAN make a reader believe an organizer is
 * capable. What that buys them is nothing, and the last test here is the proof: the reader appends
 * a record signed with the key it holds, and an organizer either holds the same key or refuses it.
 * This chain speeds up the honest case; the SIGNATURE is what makes the dishonest one harmless.
 *
 * ── WHY THIS FILE LIVES IN `apps/worker/test` ───────────────────────────────────────────────
 *
 * The chain starts at a worker function and ends at a services door, and the worker half has to be
 * read from source rather than restated. `apps/worker/test/deps.test.ts` allows
 * `@trafficflow/services` in test files for exactly this (it is a `devDependency`; the runtime
 * boundary is what that census guards).
 */

const ACCT = "00000000-0000-0000-0000-0000000000c1";
const NOW = new Date("2026-09-03T12:00:00.000Z");

type TestDb = Awaited<ReturnType<typeof makeTestDb>>;

/** The claim an organizer of this build writes, for an account that does or does not hold a key. */
function claimAsThisBuildWritesIt(hasRequestKey: boolean): string {
  return formatClaim({
    installId: "organizer-install", kind: "cloud", displayName: "ohmail Cloud",
    heartbeat: NOW, claimedAt: NOW, nonce: randomUUID(), authorizedAt: null,
    capabilities: organizerCapabilitiesFor({ hasRequestKey }),
  });
}

/**
 * A READER mailbox whose holder columns were filled from a real claim written by this build — the
 * production path (`refreshReaderHolder`, `apps/worker/src/index.ts`) in miniature: peek the
 * claim, store what it advertised.
 */
async function seedReaderOfThisBuild(db: TestDb, hasRequestKey: boolean): Promise<string> {
  const parsed = parseClaim(claimAsThisBuildWritesIt(hasRequestKey), 1);
  if (parsed === null || isMalformed(parsed)) throw new Error("this build writes an unparseable claim");
  const [mb] = await db.insert(mailboxes).values({
    accountId: ACCT, provider: "imap", address: `${randomUUID()}@x.example`,
    organizerRole: "reader", organizerState: "held",
    organizedByKind: parsed.kind === "unknown" ? null : parsed.kind,
    organizedByName: parsed.displayName,
    organizedByCapabilities: capabilitiesColumn(parsed.capabilities),
  }).returning({ id: mailboxes.id });
  return mb!.id;
}

async function seedHeld(db: TestDb, mailboxId: string, from: string): Promise<string> {
  const [m] = await db.insert(messages).values({
    accountId: ACCT, mailboxId, bodyHash: randomUUID(), dedupKey: `mid:${randomUUID()}`,
    subject: "s", fromAddress: from, unread: true,
  }).returning({ id: messages.id });
  await db.insert(folderState).values({
    messageId: m!.id, accountId: accountOfMessage(m!.id), desiredFolder: "ohmail/Screener", observedFolder: "ohmail/Screener",
    lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
  });
  return m!.id;
}

const ctxFor = (db: TestDb): ServiceContext =>
  ({ db, accountId: ACCT, userId: null, now: () => NOW, requestId: "r" });

describe("an organizer with NO request key offers nothing, and says so honestly", () => {
  it("organizerCapabilitiesFor answers the empty set", () => {
    expect([...organizerCapabilitiesFor({ hasRequestKey: false })]).toEqual([]);
  });

  it("the CLAIM it writes carries no capability header a reader could read `requests` out of", () => {
    const raw = claimAsThisBuildWritesIt(false);
    expect(raw).not.toMatch(/requests/i);
    const parsed = parseClaim(raw, 1);
    expect(isMalformed(parsed!)).toBe(false);
    expect([...(parsed as { capabilities: readonly string[] }).capabilities]).toEqual([]);
  });

  it("a reader that peeked such a claim stores NULL, and `hasCapability` reads it as absent", async () => {
    const db = await makeTestDb();
    const mailboxId = await seedReaderOfThisBuild(db, false);
    const [row] = await db.select().from(mailboxes).where(eq(mailboxes.id, mailboxId));
    expect(row?.organizedByCapabilities).toBeNull();
    expect(hasCapability(row?.organizedByCapabilities, CAPABILITY_REQUESTS)).toBe(false);
  });

  it("`readRequestEligibility` answers capable:false — a held holder, and no capability", async () => {
    const db = await makeTestDb();
    const mailboxId = await seedReaderOfThisBuild(db, false);
    const eligibility = await db.transaction((tx) => readRequestEligibility(tx, ACCT, mailboxId, CAPABILITY_REQUESTS));
    expect(eligibility).toMatchObject({ role: "reader", state: "held", capable: false });
  });

  it("THE END OF THE CHAIN — decide() refuses 409 organizer_outdated and writes NOTHING", async () => {
    const db = await makeTestDb();
    const mailboxId = await seedReaderOfThisBuild(db, false);
    const messageId = await seedHeld(db, mailboxId, "person@example.com");

    await expect(new ScreenerService({}).decide(ctxFor(db), messageId, { decision: "yes" }))
      .rejects.toMatchObject({
        code: "organized_elsewhere", httpStatus: 409,
        details: { reason: "organizer_outdated", by: { kind: "cloud", name: "ohmail Cloud" } },
      });

    // Not a queued request, not a rule, and the mail is still at the gate.
    expect(await db.select().from(organizerRequests).where(eq(organizerRequests.accountId, ACCT))).toEqual([]);
    expect(await db.select().from(rules).where(eq(rules.accountId, ACCT))).toEqual([]);
    const [fs] = await db.select().from(folderState).where(eq(folderState.messageId, messageId));
    expect(fs?.desiredFolder).toBe("ohmail/Screener");
  });

  it("the refusal NAMES the holder — a reader is told who to press, not just told no", async () => {
    const db = await makeTestDb();
    const mailboxId = await seedReaderOfThisBuild(db, false);
    const messageId = await seedHeld(db, mailboxId, "person@example.com");
    await new ScreenerService({}).decide(ctxFor(db), messageId, { decision: "yes" }).then(
      () => { throw new Error("decide resolved — the gate is not holding"); },
      (err: { details?: { by?: { kind?: unknown; name?: unknown } } }) => {
        expect(err.details?.by).toMatchObject({ kind: "cloud", name: "ohmail Cloud" });
      },
    );
  });
});

/**
 * THE OTHER DIRECTION, and it is as load-bearing as the first: a gate that refuses EVERYTHING is
 * indistinguishable from a working one until somebody checks that the open case opens. Without
 * this, deleting `requests` from `ORGANIZER_CAPABILITIES` altogether would leave every test above
 * green.
 */
describe("an organizer that HOLDS a key offers the channel, and a decision queues", () => {
  it("ORGANIZER_CAPABILITIES names `requests`, `moves` and `profile` — the kinds this build can drain", () => {
    /* mail 0094. `moves` joined AFTER its applier and its dispatch-table entry, which is the whole
       content of the promise: advertised first, a reader would read `capable: true`, write a
       record this organizer has no code to drain, and the person would watch a message sit pending
       until it expired — nothing to report, because the claim was true about a build that did not
       exist yet. This literal is what makes the order reviewable. */
    expect([...ORGANIZER_CAPABILITIES]).toEqual([
      CAPABILITY_REQUESTS, CAPABILITY_MOVES, CAPABILITY_PROFILE, CAPABILITY_RULES,
    ]);
    expect([...organizerCapabilitiesFor({ hasRequestKey: true })]).toEqual([
      CAPABILITY_REQUESTS, CAPABILITY_MOVES, CAPABILITY_PROFILE, CAPABILITY_RULES,
    ]);
  });

  it("THE SET IS COMPLETE — every request kind this build admits has a capability", () => {
    /* The exclusion list is EMPTY now, and that is worth asserting rather than deleting: the
       property that guarded the staged rollout — no capability without its applier — has to keep
       holding in the other direction too, or a kind added later gets advertised by inheritance.
       So this compares the two sets rather than naming absences.

       `screener.decide` maps to `requests`, the three `rule.*` kinds share `rules` (one applier,
       one table), `message.move` to `moves`, `profile.update` to `profile`. Four capabilities for
       six kinds, and `capabilityForKind` is the map both sides read. */
    const needed = new Set(REQUEST_KINDS.map((k) => capabilityForKind(k)));
    expect([...needed].sort(), "a request kind needs a capability this organizer does not advertise")
      .toEqual([...ORGANIZER_CAPABILITIES].sort());
  });

  it("a mailbox with NO derived key advertises nothing at all — `moves` included", async () => {
    /* The degraded mode has to cover the new member too. A move request is signed with the same
       key, so an organizer that cannot verify one cannot apply one — advertising `moves` there
       would invite a request this build would refuse `unauthenticated` for ever. */
    expect([...organizerCapabilitiesFor({ hasRequestKey: false })]).toEqual([]);
  });

  it("the claim carries the token, and a reader stores it", async () => {
    const db = await makeTestDb();
    const mailboxId = await seedReaderOfThisBuild(db, true);
    const [row] = await db.select().from(mailboxes).where(eq(mailboxes.id, mailboxId));
    expect(hasCapability(row?.organizedByCapabilities, CAPABILITY_REQUESTS)).toBe(true);
  });

  it("eligibility says capable, and decide() answers 202 with a queued row", async () => {
    const db = await makeTestDb();
    const mailboxId = await seedReaderOfThisBuild(db, true);
    const messageId = await seedHeld(db, mailboxId, "person@example.com");

    const eligibility = await db.transaction((tx) => readRequestEligibility(tx, ACCT, mailboxId, CAPABILITY_REQUESTS));
    expect(eligibility).toMatchObject({ role: "reader", state: "held", capable: true });

    const out = await new ScreenerService({}).decide(ctxFor(db), messageId, { decision: "yes" });
    expect(out).toMatchObject({ pending: true });

    const queued = await db.select().from(organizerRequests).where(eq(organizerRequests.accountId, ACCT));
    expect(queued).toHaveLength(1);
    expect(queued[0]!.state).toBe("pending");
    expect(queued[0]!.mailboxId).toBe(mailboxId);
    // A REQUEST, not a write: the rule is the organizer's to make, and the mail has not moved.
    expect(await db.select().from(rules).where(eq(rules.accountId, ACCT))).toEqual([]);
    const [fs] = await db.select().from(folderState).where(eq(folderState.messageId, messageId));
    expect(fs?.desiredFolder).toBe("ohmail/Screener");
  });
});

/**
 * THE KEY ITSELF — derived, never stored, and the same on two installs that share the credential.
 *
 * This is the property the whole channel rests on: two processes that can open the same mailbox
 * arrive at the same secret WITHOUT talking to each other, which is what lets a local install —
 * which never contacts the hosted service — take part on equal terms.
 */
describe("deriveRequestKey", () => {
  const ADDR = "person@mailbox.example";

  it("two installs holding the same credential derive the SAME key", () => {
    const a = deriveRequestKey({ auth: { user: ADDR, pass: "request-key-password" }, address: ADDR });
    const b = deriveRequestKey({ auth: { user: "typed-by-someone-else", pass: "request-key-password" }, address: ADDR });
    expect(a).not.toBeNull();
    expect(b).toBe(a);
  });

  it("a DIFFERENT password derives a different key — which is what a password change is", () => {
    const before = deriveRequestKey({ auth: { user: ADDR, pass: "request-key-password" }, address: ADDR });
    const after = deriveRequestKey({ auth: { user: ADDR, pass: "request-key-changed-password" }, address: ADDR });
    expect(after).not.toBe(before);
  });

  /**
   * THE SALT'S JOB. Two mailboxes whose owner reused a password must not share a signing key, or a
   * record written for one would verify against the other.
   */
  it("the same password on two DIFFERENT mailboxes derives different keys", () => {
    const one = deriveRequestKey({ auth: { user: "u", pass: "same" }, address: "a@example.com" });
    const two = deriveRequestKey({ auth: { user: "u", pass: "same" }, address: "b@example.com" });
    expect(one).not.toBe(two);
  });

  it("is stable across calls, and the address is case- and space-insensitive", () => {
    const a = deriveRequestKey({ auth: { user: "u", pass: "p" }, address: "Person@Example.COM" });
    const b = deriveRequestKey({ auth: { user: "u", pass: "p" }, address: "  person@example.com  " });
    expect(a).toBe(b);
  });

  /** OAUTH HAS NO SHARED SECRET, so there is no key and the channel is honestly unavailable. */
  it("answers null for an OAuth mailbox, and for an empty password", () => {
    expect(deriveRequestKey({
      auth: { user: "u", fetchAccessToken: async () => "tok" } as never, address: ADDR,
    })).toBeNull();
    expect(deriveRequestKey({ auth: { user: "u", pass: "" }, address: ADDR })).toBeNull();
    expect(deriveRequestKey({ auth: { user: "u", pass: "p" }, address: "   " })).toBeNull();
  });
});
