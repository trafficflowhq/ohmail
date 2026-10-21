import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { eq } from "drizzle-orm";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { accounts, folderState, mailboxes, messages, routingDecisions, rules } from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import type { Tx } from "@trafficflow/db";
import { gapCatchupPass } from "../src/gap-catchup.js";
import { clearOrganizerStandDown, markMailboxReleased, refreshOrganizerHolder } from "../src/mailboxes.js";

/**
 * A HAND-BACK OPENS THE GAP AT THE RELEASE, NOT ONE LOOK LATER. The letter is taken in
 * by the reader between `markMailboxReleased` and the reader's first look, which is the stretch the
 * window used to miss: the look opened it after the letter, both bounds refused it, and the offer
 * after "Organize here" counted 0. Real Postgres: the release is a fenced write and the bounds read
 * `timestamptz` columns against the store's own clock. Nothing moves until the press.
 */

const AVAILABLE = await realPgAvailable();
const NONE = async (): Promise<ReadonlySet<string>> => new Set<string>();
/** Settled rules: the settings folder read cleanly with no import question open. */
const CLEAR = () => ({ kind: "clear" }) as const;
const NEWS = "ohmail/News";
const RULE_MADE = new Date("2026-10-01T00:00:00Z");
const SENDER = "letters@news.test";
const NOBODY = { kind: null, installId: null, displayName: null, claimedAt: null, state: null, capabilities: null };
let uid = 0;

describe.skipIf(!AVAILABLE)("the gap window a hand-back opens", () => {
  let sql: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle<typeof schema>>;

  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    sql = postgres(PG_TEST_URL, { max: 2, onnotice: () => {} });
    db = brandDialect(drizzle(sql, { schema }), "pg");
  }, 120_000);

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
  });

  /** A mailbox this install organizes, a sender rule older than any letter, and the person's stop standing. */
  async function organizedWithAStop(): Promise<{ accountId: string; mailboxId: string }> {
    const accountId = randomUUID();
    await db.insert(accounts).values({ id: accountId, name: `handback-${accountId.slice(0, 8)}` });
    const [mb] = await db.insert(mailboxes).values({
      accountId, provider: "imap", address: `me-${accountId.slice(0, 8)}@ohmail.test`,
      organizerRole: "organizer", organizeConsentedAt: RULE_MADE, releaseRequestedAt: new Date(),
    }).returning();
    await db.insert(rules).values({
      accountId, kind: "sender", match: SENDER, destination: NEWS,
      provenance: "manual", enabled: true, createdAt: RULE_MADE, updatedAt: RULE_MADE,
    });
    return { accountId, mailboxId: mb!.id };
  }

  /** The reader takes in one INBOX arrival: `'peer'`, observed and desired INBOX, at the store's clock. */
  async function readerTakesIn(w: { accountId: string; mailboxId: string }, arrivedAt: Date): Promise<string> {
    const dedup = `mid:${randomUUID()}`;
    const [m] = await db.insert(messages).values({
      accountId: w.accountId, mailboxId: w.mailboxId, messageIdHeader: dedup, bodyHash: randomUUID(),
      dedupKey: dedup, subject: "a ruled letter", fromAddress: SENDER,
      nativeLocator: { folder: "INBOX", ref: `1:${++uid}` }, arrivedAt,
    }).returning();
    await db.insert(folderState).values({
      messageId: m!.id, desiredFolder: "INBOX", observedFolder: "INBOX",
      lastSetBy: "peer", reconcileStatus: "reconciled", conflict: false,
    });
    return m!.id;
  }

  /** The still-active organizer takes one in and decides it: `'us'`, filed or kept in the Ohbox. */
  async function organizerDecides(
    w: { accountId: string; mailboxId: string }, arrivedAt: Date, desired: string, observed: string,
  ): Promise<string> {
    const dedup = `mid:${randomUUID()}`;
    const [m] = await db.insert(messages).values({
      accountId: w.accountId, mailboxId: w.mailboxId, messageIdHeader: dedup, bodyHash: randomUUID(),
      dedupKey: dedup, subject: "a letter the organizer decided", fromAddress: SENDER,
      nativeLocator: { folder: observed, ref: `1:${++uid}` }, arrivedAt,
    }).returning();
    await db.insert(folderState).values({
      messageId: m!.id, desiredFolder: desired, observedFolder: observed,
      lastSetBy: "us", reconcileStatus: desired === observed ? "reconciled" : "pending", conflict: false,
    });
    return m!.id;
  }

  const storeNow = async (): Promise<Date> => {
    const [r] = await sql<{ at: Date }[]>`select clock_timestamp() as at`;
    return new Date(r!.at);
  };

  const rowOf = async (id: string) => {
    const [r] = await db.select({
      since: mailboxes.gapSince, letters: mailboxes.gapLetters, role: mailboxes.organizerRole,
      releaseRequestedAt: mailboxes.releaseRequestedAt, takeoverAuthorizedAt: mailboxes.takeoverAuthorizedAt,
    }).from(mailboxes).where(eq(mailboxes.id, id));
    return r!;
  };

  /** "Organize here", then the gate's promotion spending that press. */
  async function organizeHere(id: string): Promise<void> {
    await db.update(mailboxes).set({ takeoverAuthorizedAt: new Date() }).where(eq(mailboxes.id, id));
    const read = await rowOf(id);
    expect(await clearOrganizerStandDown(db as never, id, {
      asRead: { releaseRequestedAt: read.releaseRequestedAt, takeoverAuthorizedAt: read.takeoverAuthorizedAt },
    })).toBe(true);
  }

  it("a letter taken in before the reader's first look is offered after Organize here, and filed only on the press", async () => {
    const w = await organizedWithAStop();
    expect(await markMailboxReleased(db as never, w.mailboxId)).toBe(true);
    const released = await rowOf(w.mailboxId);
    expect(released.role).toBe("reader");

    const letter = await readerTakesIn(w, await storeNow());
    // The reader's first look after the release: nobody holds the mailbox.
    expect(await refreshOrganizerHolder(db as never, w.mailboxId, NOBODY, { gap: "open", stateChanged: false })).toBe(true);
    const looked = await rowOf(w.mailboxId);

    await organizeHere(w.mailboxId);
    const opts = { accountId: w.accountId, trustedAuthservIdsFor: NONE, clearanceFor: CLEAR };
    // At the base this read { offered: 0, moved: 0, completed: 1 }: a window that opened after the letter, closed empty.
    expect(await gapCatchupPass(db as unknown as Tx, opts)).toEqual({ offered: 1, moved: 0, completed: 0 });
    expect((await rowOf(w.mailboxId)).letters, "the offer missed the letter the hand-back let through").toBe(1);
    const [held] = await db.select().from(folderState).where(eq(folderState.messageId, letter));
    expect(held, "a count moved mail").toMatchObject({ desiredFolder: "INBOX", lastSetBy: "peer" });
    expect(await db.select().from(routingDecisions).where(eq(routingDecisions.accountId, w.accountId))).toHaveLength(0);

    await db.update(mailboxes).set({ gapPressedAt: new Date() }).where(eq(mailboxes.id, w.mailboxId));
    expect(await gapCatchupPass(db as unknown as Tx, opts)).toEqual({ offered: 0, moved: 1, completed: 1 });
    const [filed] = await db.select().from(folderState).where(eq(folderState.messageId, letter));
    expect(filed).toMatchObject({ desiredFolder: NEWS, lastSetBy: "us" });
    expect((await rowOf(w.mailboxId)).since).toBeNull();
    // The window began at the release, and the look kept that start.
    expect(released.since, "the release opened no gap window").not.toBeNull();
    expect(looked.since?.getTime()).toBe(released.since?.getTime());
  }, 60_000);

  it("in the worker's own order — the press, an arrival, then the visit that honours it, looks and takes in — the letter is offered", async () => {
    const w = await organizedWithAStop();
    const pressed = await storeNow();
    await db.update(mailboxes).set({ releaseRequestedAt: pressed }).where(eq(mailboxes.id, w.mailboxId));
    await new Promise((r) => setTimeout(r, 30));
    // The letter ARRIVES at the server before the visit that honours the stop (its arrival woke that visit).
    const arrived = await storeNow();
    await new Promise((r) => setTimeout(r, 30));
    expect(await markMailboxReleased(db as never, w.mailboxId)).toBe(true);
    expect(await refreshOrganizerHolder(db as never, w.mailboxId, NOBODY, { gap: "open", stateChanged: false })).toBe(true);
    const letter = await readerTakesIn(w, arrived);
    await organizeHere(w.mailboxId);
    const opts = { accountId: w.accountId, trustedAuthservIdsFor: NONE, clearanceFor: CLEAR };
    expect(await gapCatchupPass(db as unknown as Tx, opts), "a letter that arrived after the press was left out")
      .toEqual({ offered: 1, moved: 0, completed: 0 });
    const [held] = await db.select().from(folderState).where(eq(folderState.messageId, letter));
    expect(held).toMatchObject({ desiredFolder: "INBOX", lastSetBy: "peer" });
  }, 60_000);

  it("RULING Q1: what the still-active organizer decided between the press and the honouring is not offered", async () => {
    const w = await organizedWithAStop();
    await db.update(mailboxes).set({ releaseRequestedAt: await storeNow() }).where(eq(mailboxes.id, w.mailboxId));
    await new Promise((r) => setTimeout(r, 30));
    // Still organizing: one letter filed by the person's rule, one kept in the Ohbox.
    const filed = await organizerDecides(w, await storeNow(), NEWS, "INBOX");
    const kept = await organizerDecides(w, await storeNow(), "INBOX", "INBOX");
    expect(await markMailboxReleased(db as never, w.mailboxId)).toBe(true);
    expect(await refreshOrganizerHolder(db as never, w.mailboxId, NOBODY, { gap: "open", stateChanged: false })).toBe(true);
    const gap = await readerTakesIn(w, await storeNow());
    // Inside the window by both instants: only the organizer's decision keeps them out.
    const since = (await rowOf(w.mailboxId)).since!;
    for (const id of [filed, kept]) {
      const [m] = await db.select({ c: messages.createdAt, a: messages.arrivedAt }).from(messages).where(eq(messages.id, id));
      expect(m!.c.getTime()).toBeGreaterThanOrEqual(since.getTime());
      expect(m!.a!.getTime()).toBeGreaterThanOrEqual(since.getTime());
    }
    await organizeHere(w.mailboxId);
    const opts = { accountId: w.accountId, trustedAuthservIdsFor: NONE, clearanceFor: CLEAR };
    expect(await gapCatchupPass(db as unknown as Tx, opts)).toEqual({ offered: 1, moved: 0, completed: 0 });
    expect((await rowOf(w.mailboxId)).letters, "a letter the organizer decided was counted").toBe(1);
    await db.update(mailboxes).set({ gapPressedAt: new Date() }).where(eq(mailboxes.id, w.mailboxId));
    expect(await gapCatchupPass(db as unknown as Tx, opts)).toEqual({ offered: 0, moved: 1, completed: 1 });
    const decided = await db.select({ m: routingDecisions.messageId }).from(routingDecisions)
      .where(eq(routingDecisions.accountId, w.accountId));
    expect(decided.map((d) => d.m)).toEqual([gap]);
    const [f] = await db.select().from(folderState).where(eq(folderState.messageId, filed));
    expect(f).toMatchObject({ desiredFolder: NEWS, observedFolder: "INBOX", lastSetBy: "us" });
    const [k] = await db.select().from(folderState).where(eq(folderState.messageId, kept));
    expect(k).toMatchObject({ desiredFolder: "INBOX", observedFolder: "INBOX", lastSetBy: "us" });
  }, 60_000);

  it("CONTROL: a letter taken in before the person pressed is not in the window", async () => {
    const w = await organizedWithAStop();
    await db.update(mailboxes).set({ releaseRequestedAt: null }).where(eq(mailboxes.id, w.mailboxId));
    const before = await readerTakesIn(w, await storeNow());
    await new Promise((r) => setTimeout(r, 30));
    await db.update(mailboxes).set({ releaseRequestedAt: await storeNow() }).where(eq(mailboxes.id, w.mailboxId));
    expect(await markMailboxReleased(db as never, w.mailboxId)).toBe(true);
    await organizeHere(w.mailboxId);
    const ran = await gapCatchupPass(db as unknown as Tx, { accountId: w.accountId, trustedAuthservIdsFor: NONE, clearanceFor: CLEAR });
    expect({ offered: ran.offered, moved: ran.moved }).toEqual({ offered: 0, moved: 0 });
    expect((await rowOf(w.mailboxId)).letters).toBeNull();
    const [kept] = await db.select().from(folderState).where(eq(folderState.messageId, before));
    expect(kept).toMatchObject({ desiredFolder: "INBOX", lastSetBy: "peer" });
  }, 60_000);

  it("an earlier window keeps its start, and the wall's park opens none", async () => {
    const w = await organizedWithAStop();
    const earlier = new Date(Date.now() - 3_600_000);
    await db.update(mailboxes).set({ gapSince: earlier }).where(eq(mailboxes.id, w.mailboxId));
    expect(await markMailboxReleased(db as never, w.mailboxId)).toBe(true);
    expect((await rowOf(w.mailboxId)).since?.getTime()).toBe(earlier.getTime());

    // The park releases with no press, and organizing resumes by its join: no window to offer from.
    const parked = await organizedWithAStop();
    await db.update(mailboxes).set({ releaseRequestedAt: null }).where(eq(mailboxes.id, parked.mailboxId));
    expect(await markMailboxReleased(db as never, parked.mailboxId, { cause: "account_parked" })).toBe(true);
    expect((await rowOf(parked.mailboxId)).since, "the park opened a gap window").toBeNull();
  }, 60_000);

  /**
   * A HAND-BACK WITHHELD BEHIND ANOTHER INSTALL never reaches back over its tenure. The press, then
   * another install claims before this one honours it; each visit withholds and the look records the
   * live holder; the reader takes in a letter that install kept in INBOX. Once it lets go, the release
   * starts the window at the release itself: only the letter after it is offered and filed.
   */
  it("a hand-back withheld behind another install's live claim opens the window at the release, not the press", async () => {
    const w = await organizedWithAStop();
    const pressed = (await rowOf(w.mailboxId)).releaseRequestedAt!;
    const LAPTOP = { kind: "local", installId: "the-laptop", displayName: "Laptop", claimedAt: await storeNow(), state: "held" as const, capabilities: null };
    expect(await refreshOrganizerHolder(db as never, w.mailboxId, LAPTOP as never, { gap: "close", stateChanged: true })).toBe(true);
    const keptByTheLaptop = await readerTakesIn(w, await storeNow());
    await new Promise((r) => setTimeout(r, 30));
    expect(await markMailboxReleased(db as never, w.mailboxId)).toBe(true);
    const released = await rowOf(w.mailboxId);
    expect(released.since!.getTime(), "the window reached back to the press").toBeGreaterThan(pressed.getTime());
    expect(await refreshOrganizerHolder(db as never, w.mailboxId, NOBODY, { gap: "open", stateChanged: true })).toBe(true);
    const trueGap = await readerTakesIn(w, await storeNow());

    await organizeHere(w.mailboxId);
    const opts = { accountId: w.accountId, trustedAuthservIdsFor: NONE, clearanceFor: CLEAR };
    expect(await gapCatchupPass(db as unknown as Tx, opts), "a letter the laptop kept was counted")
      .toEqual({ offered: 1, moved: 0, completed: 0 });
    await db.update(mailboxes).set({ gapPressedAt: new Date() }).where(eq(mailboxes.id, w.mailboxId));
    expect(await gapCatchupPass(db as unknown as Tx, opts)).toEqual({ offered: 0, moved: 1, completed: 1 });
    const decided = await db.select({ m: routingDecisions.messageId }).from(routingDecisions)
      .where(eq(routingDecisions.accountId, w.accountId));
    expect(decided.map((d) => d.m)).toEqual([trueGap]);
    const [kept] = await db.select().from(folderState).where(eq(folderState.messageId, keptByTheLaptop));
    expect(kept).toMatchObject({ desiredFolder: "INBOX", lastSetBy: "peer" });
  }, 60_000);
});
