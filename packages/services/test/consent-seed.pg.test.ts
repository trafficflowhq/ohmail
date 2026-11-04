import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { and, eq, inArray } from "drizzle-orm";
import { accounts, accountSettings, changeLog, contacts, folderState, mailboxes, messageBodies, messages, ruleRemovals, rules } from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { buildSeedReview, confirmSeed, type SeedConfirmResult } from "../src/consent-seed.js";
import type { ServiceContext } from "../src/context.js";

/**
 * THE SENT-MAIL SEED, AGAINST REAL POSTGRES.
 *
 * Two of the claims here are transactional and one is an ABSENCE, which is the hardest kind to
 * test and the most important one in this slice:
 *
 *   · every accepted candidate becomes exactly one rule and exactly one change-log row;
 *   · the rules carry the RELEASE shape — `release_held_at` equal to `retro_requested_at` — so
 *     `rule-retro.ts`' release arm walks only rows settled at the screening gate. It used to be
 *     NULL on both, and that was measured costing mail: a reported account's five held messages,
 *     imported the day before the confirmation, were still at the gate months later because a
 *     NULL `retro_requested_at` is not owed work. `apps/worker/test/seed-release.test.ts` drives
 *     the pass over four rows from one sender and pins which of them moves;
 *   · `folder_state` is byte-identical before and after THIS CALL. A seed that routed itself
 *     through the Screener's own decide path would look correct in every other assertion and
 *     would also have queued thousands of IMAP moves; the release is the worker's, bounded,
 *     resumable and desired-state only.
 *
 * The recipients are read out of stored HEADERS rather than `messages.to_addresses`, because
 * those two columns are never written on ingest — measured on the hosted service, where every row
 * carries the empty-array default while the headers hold the real `To:` and `Cc:` lines.
 */

const AVAILABLE = await realPgAvailable();
const client = postgres(PG_TEST_URL, { max: 4, onnotice: () => {} });
const db = brandDialect(drizzle(client, { schema }), "pg");

const NOW = new Date("2026-08-04T12:00:00.000Z");
const ACCOUNT = randomUUID();
const OWN = `seed-own-${ACCOUNT.slice(0, 8)}@example.com`;
let mailboxId = "";

const ctx: ServiceContext = {
  db, accountId: ACCOUNT, userId: null, now: () => NOW, requestId: "consent-seed",
};

/** One of the user's own messages, with the headers the seed actually reads. */
async function sent(o: {
  to?: string; cc?: string; subject?: string; extraHeaders?: Record<string, string[]>; from?: string;
  date?: Date;
}): Promise<string> {
  const [m] = await db.insert(messages).values({
    accountId: ACCOUNT, mailboxId,
    bodyHash: randomUUID(), dedupKey: randomUUID(),
    fromAddress: o.from ?? OWN,
    subject: o.subject ?? "a note",
    date: o.date ?? NOW,
    nativeLocator: { folder: "Sent Messages", uid: 1 },
    snippet: "",
  }).returning({ id: messages.id });
  await db.insert(messageBodies).values({
    messageId: m!.id,
    headers: {
      ...(o.to ? { to: [o.to] } : {}),
      ...(o.cc ? { cc: [o.cc] } : {}),
      ...(o.extraHeaders ?? {}),
    },
  });
  // Sent mail is organised in place — it keeps the folder it arrived in.
  await db.insert(folderState).values({
    messageId: m!.id, desiredFolder: "Sent Messages", observedFolder: "Sent Messages",
    lastSetBy: "external", reconcileStatus: "reconciled",
  });
  return m!.id;
}

/** A snapshot of every folder_state row for the account — the "nothing moved" oracle. */
async function folderSnapshot(): Promise<string[]> {
  const rows = await db.select({
    id: folderState.messageId, desired: folderState.desiredFolder,
    observed: folderState.observedFolder, status: folderState.reconcileStatus,
  }).from(folderState).innerJoin(messages, eq(messages.id, folderState.messageId))
    .where(eq(messages.accountId, ACCOUNT));
  return rows.map((r) => `${r.id}|${r.desired}|${r.observed}|${r.status}`).sort();
}

describe.skipIf(!AVAILABLE)("the sent-mail seed writes consent and moves nothing", () => {
  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    await db.insert(accounts).values({ id: ACCOUNT, name: `seed-${ACCOUNT.slice(0, 8)}` });
    const [mb] = await db.insert(mailboxes).values({
      accountId: ACCOUNT, provider: "imap", address: OWN,
    }).returning({ id: mailboxes.id });
    mailboxId = mb!.id;

    // Distinct timestamps, because "which display name wins" is a real rule — the most recent
    // spelling — and equal dates would leave the scan order, and therefore the answer, arbitrary.
    await sent({ to: '"Roth, Lena" <lena@atelier.example>', cc: "ben@studio.example", date: new Date("2026-07-01T09:00:00.000Z") });
    await sent({ to: "Lena Roth <lena@atelier.example>", date: new Date("2026-08-01T09:00:00.000Z") });
    // A display name containing an at-sign, which a naive address regex reads as a recipient.
    await sent({ to: '"admin@old.example" <real@studio.example>' });
    // Robots, both shapes named in the spec.
    await sent({ to: "no-reply@bank.example, bounces+u=x.example@mail.example" });
    await sent({ to: "calendar-server@apple.example" });
    // The user's own address is never a candidate.
    await sent({ to: OWN });
    // An out-of-office WE sent: its recipients are the machine's, not the user's.
    await sent({ to: "stranger@conference.example", subject: "Automatic reply: away until Monday" });
    // RFC 3834, the same idea stated in a header.
    await sent({ to: "robot@list.example", extraHeaders: { "auto-submitted": ["auto-replied"] } });
    // …and `Auto-Submitted: no` means a human wrote it, so this one COUNTS.
    await sent({ to: "human@replied.example", extraHeaders: { "auto-submitted": ["no"] } });
    // A name transmitted as an RFC 2047 encoded-word — the COMMON case for an accented name,
    // and exactly the shape dozens of a live mailbox's correspondents are stored in. The old code
    // dropped these to a bare address; the review must now carry the person's name.
    await sent({ to: "=?utf-8?Q?jonas_m\x3dC3\x3dB6ller?= <jonas@gmx.example>", date: new Date("2026-07-15T09:00:00.000Z") });
    // …and a name that reached storage as Latin-1-folded UTF-8 (the live mojibake), repaired.
    await sent({ to: "Anna SÃ¸rensen <anna@fjordline.example>", date: new Date("2026-07-16T09:00:00.000Z") });
  }, 120_000);

  afterAll(async () => { await client.end({ timeout: 5 }); });

  it("offers the people written to, and discloses every robot it removed", async () => {
    const review = await buildSeedReview(ctx);
    const addrs = review.candidates.map((c) => c.address);

    expect(addrs).toContain("lena@atelier.example");
    expect(addrs).toContain("ben@studio.example");
    expect(addrs).toContain("real@studio.example");
    expect(addrs).toContain("human@replied.example");
    // The quoted display name is not a person.
    expect(addrs).not.toContain("admin@old.example");
    // Robots, own address, and the recipients of our own auto-reply.
    for (const gone of ["no-reply@bank.example", "calendar-server@apple.example", OWN,
      "stranger@conference.example", "robot@list.example"]) {
      expect(addrs).not.toContain(gone);
    }
    // Removed, not hidden — the review list can show its own exclusions.
    const excluded = new Map(review.excluded.map((e) => [e.address, e.reason]));
    expect(excluded.get("no-reply@bank.example")).toBe("robot-recipient");
    expect(excluded.get("calendar-server@apple.example")).toBe("robot-recipient");
    expect(excluded.get(OWN)).toBe("own-address");
    expect(excluded.get("stranger@conference.example")).toBe("machine-sent");
    expect(excluded.get("robot@list.example")).toBe("machine-sent");

    // Counted across messages, most-written-to first.
    expect(review.candidates[0]!.address).toBe("lena@atelier.example");
    expect(review.candidates[0]!.messages).toBe(2);
    // The MOST RECENT spelling, not the first one stored.
    expect(review.candidates[0]!.name).toBe("Lena Roth");
    expect(review.candidates[0]!.lastWrittenAt).toBe("2026-08-01T09:00:00.000Z");

    // The accented names arrive as NAMES, not bare addresses — decoded end to end, through the
    // stored header, `parseAddressList` and the review's own name-precedence rule.
    const byAddr = new Map(review.candidates.map((c) => [c.address, c]));
    expect(byAddr.get("jonas@gmx.example")?.name).toBe("jonas möller");
    expect(byAddr.get("anna@fjordline.example")?.name).toBe("Anna Sørensen");
  });

  it("CONFIRMING WRITES RULES AND MOVES NOTHING", async () => {
    const before = await folderSnapshot();
    const seqBefore = await db.select({ seq: changeLog.seq }).from(changeLog)
      .where(eq(changeLog.accountId, ACCOUNT));

    const review = await buildSeedReview(ctx);
    // Uncheck one — the user's own edit of the list.
    const keep = review.candidates.map((c) => c.address).filter((a) => a !== "ben@studio.example");
    const result = await confirmSeed(ctx, keep);

    expect(result.rulesCreated).toBe(keep.length);
    expect(result.declined).toBe(1);

    const written = await db.select().from(rules).where(eq(rules.accountId, ACCOUNT));
    expect(written).toHaveLength(keep.length);
    for (const r of written) {
      expect(r.provenance).toBe("seeded-from-sent");
      expect(r.destination).toBe("INBOX");
      expect(r.kind).toBe("sender");
      expect(r.enabled).toBe(true);
      // THE ONE THAT MATTERS, and it is the PAIR rather than either value. Equal stamps are the
      // release shape: the pass walks only rows settled at the gate for these senders. A
      // `retro_requested_at` stamped WITHOUT `release_held_at` is the dangerous one — an ordinary
      // retro re-opening the whole backlog, which is thousands of IMAP moves out of one confirm.
      expect(r.releaseHeldAt).not.toBeNull();
      expect(r.releaseHeldAt!.getTime()).toBe(r.retroRequestedAt!.getTime());
      expect(r.retroDoneAt).toBeNull();
    }

    // Consent is also a known sender, so future mail routes without asking again — plus the
    // account's OWN address, which is not consent for anybody but is what stops somebody's own
    // mail to themselves being screened as a first contact. The connect-time pass that used to
    // write that row is retired and this is its only remaining writer.
    const known = await db.select().from(contacts).where(eq(contacts.accountId, ACCOUNT));
    expect(known.map((c) => c.address).sort()).toEqual([...keep, OWN].sort());

    // One change-log row per rule, so every mirror learns about them.
    const seqAfter = await db.select({ seq: changeLog.seq }).from(changeLog)
      .where(and(eq(changeLog.accountId, ACCOUNT), eq(changeLog.entityType, "rule")));
    expect(seqAfter.length - seqBefore.length).toBe(keep.length);

    // …AND THE MAILBOX IS EXACTLY AS IT WAS.
    expect(await folderSnapshot()).toEqual(before);

    const [settings] = await db.select().from(accountSettings)
      .where(eq(accountSettings.accountId, ACCOUNT));
    expect(settings!.seedConfirmedAt).not.toBeNull();
    expect(settings!.seedConfirmedCount).toBe(keep.length);
    expect(settings!.seedDeclinedCount).toBe(1);
    expect(settings!.dormancyDays).toBeNull();   // untouched dial stays at the product default
  });

  it("A SECOND CONFIRM WRITES ONLY WHO IS NEW — the review may be answered again", async () => {
    // The account confirmed in the previous test, leaving Ben unticked. Answering the review a
    // second time is a real thing a person does — they change their mind, or they connect
    // another mailbox and a second address book of correspondents appears — so it is allowed,
    // and the guarantee is not "refused" but "one rule per person, however often you press it".
    const before = await db.select({ id: rules.id }).from(rules).where(eq(rules.accountId, ACCOUNT));
    const review = await buildSeedReview(ctx);
    // Everybody already consented to comes back marked, and comes back UNWRITTEN.
    expect(review.candidates.filter((c) => c.alreadyDecided).length).toBe(before.length);
    // Ben's rule was removed once; the rule written for him now ends that removal, and nobody else's.
    for (const match of ["ben@studio.example", "gone@elsewhere.example"]) {
      await db.insert(ruleRemovals).values({ accountId: ACCOUNT, ruleKey: `["sender","${match}","",""]`, kind: "sender", match, removedAt: NOW });
    }

    const result = await confirmSeed(ctx, review.candidates.map((c) => c.address));
    expect((await db.select().from(ruleRemovals).where(eq(ruleRemovals.accountId, ACCOUNT))).map((r) => r.match))
      .toEqual(["gone@elsewhere.example"]);

    expect(result.rulesCreated).toBe(1);            // Ben, and nobody else
    expect(result.skipped).toBe(before.length);
    const ben = await db.select().from(rules)
      .where(and(eq(rules.accountId, ACCOUNT), inArray(rules.match, ["ben@studio.example"])));
    expect(ben).toHaveLength(1);
    const after = await db.select({ id: rules.id }).from(rules).where(eq(rules.accountId, ACCOUNT));
    expect(after).toHaveLength(before.length + 1);  // no second copy of anybody
  });

  /**
   * TWO CONFIRMS AT ONCE, ON REAL POSTGRES — and this is the reason the transaction opens by
   * locking the account's settings row and then asks, from inside that lock, who already has a
   * rule.
   *
   * The pre-check version was correct sequentially and wrong concurrently: both requests built
   * their review before either committed, so both saw every candidate undecided and both
   * inserted a rule apiece. `rules` carries no unique constraint on `(account_id, kind, match)`,
   * so nothing downstream rejected the second copy either.
   *
   * BOTH REQUESTS NOW SUCCEED, and that is the change: the loser is not an error, it is a
   * confirmation that found its work already done and says so as `skipped`. Refusing it with a
   * 409 was the same mechanism that made the review a once-in-an-account's-life offer, and that
   * was the wrong price for double-click safety.
   *
   * PGlite cannot show this — one connection, no concurrency — which is exactly why it lives
   * here. `max: 4` on the pool above is what lets the two transactions genuinely overlap.
   */
  it("TWO SIMULTANEOUS CONFIRMS: both answer, and nobody gets two rules", async () => {
    // A fresh account, because the one above has already confirmed.
    const raceAccount = randomUUID();
    await db.insert(accounts).values({ id: raceAccount, name: "race" });
    const [mb] = await db.insert(mailboxes).values({
      accountId: raceAccount, provider: "imap", address: `race-${raceAccount.slice(0, 8)}@example.com`,
    }).returning({ id: mailboxes.id, address: mailboxes.address });
    const [m] = await db.insert(messages).values({
      accountId: raceAccount, mailboxId: mb!.id,
      bodyHash: randomUUID(), dedupKey: randomUUID(),
      fromAddress: mb!.address, subject: "hello", date: NOW,
      nativeLocator: { folder: "Sent Messages", uid: 1 }, snippet: "",
    }).returning({ id: messages.id });
    await db.insert(messageBodies).values({
      messageId: m!.id, text: "", html: null, headers: { to: ["pia@atelier.example"] },
    });

    const raceCtx: ServiceContext = { ...ctx, accountId: raceAccount };
    const both = await Promise.allSettled([
      confirmSeed(raceCtx, ["pia@atelier.example"]),
      confirmSeed(raceCtx, ["pia@atelier.example"]),
    ]);

    const won = both.filter((r) => r.status === "fulfilled");
    expect(won, "neither confirm may fail").toHaveLength(2);
    // Exactly one of them did the writing; the other found the rule already there.
    const created = won.map((r) => (r as PromiseFulfilledResult<SeedConfirmResult>).value);
    expect(created.map((c) => c.rulesCreated).sort()).toEqual([0, 1]);
    expect(created.map((c) => c.skipped).sort()).toEqual([0, 1]);

    const written = await db.select().from(rules).where(eq(rules.accountId, raceAccount));
    expect(written.map((r) => r.match)).toEqual(["pia@atelier.example"]);
  });

  it("a confirmation can only ever be a subset of what was offered", async () => {
    // Without the intersection, this endpoint would write a rule for any address a caller names.
    // The stamp is cleared first — that is what `resetScreeningState` does, and the only way
    // back to a confirmable account.
    await db.update(accountSettings).set({ seedConfirmedAt: null })
      .where(eq(accountSettings.accountId, ACCOUNT));
    const before = await db.select({ id: rules.id }).from(rules).where(eq(rules.accountId, ACCOUNT));
    const result = await confirmSeed(ctx, ["attacker@evil.example", "lena@atelier.example"]);

    expect(result.rulesCreated).toBe(0);   // lena already has one; the other was never offered
    const after = await db.select({ id: rules.id }).from(rules).where(eq(rules.accountId, ACCOUNT));
    expect(after).toHaveLength(before.length);
    const evil = await db.select().from(rules)
      .where(and(eq(rules.accountId, ACCOUNT), inArray(rules.match, ["attacker@evil.example"])));
    expect(evil).toHaveLength(0);
  });
});
