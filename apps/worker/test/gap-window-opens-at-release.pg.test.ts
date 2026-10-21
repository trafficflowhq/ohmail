import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect, dialect } from "@trafficflow/db/dialect";
import { eq } from "drizzle-orm";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { accounts, folderState, mailboxes, messages, routingDecisions, rules } from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import type { Tx } from "@trafficflow/db";
import { gapCatchupPass } from "../src/gap-catchup.js";
import { clearOrganizerStandDown, markMailboxReleased, readTravellingGapSince, refreshOrganizerHolder } from "../src/mailboxes.js";
import { gapOpenStart, type TravelledGap } from "../src/gap-window.js";

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
  /* ── THE GAP TRAVELS (RULING-026 lane A) ─────────────────────────────────────────────────────
     What a releasing organizer leaves (`readTravellingGapSince`, read before the release clears
     its row), and where the next install's look opens its own row's window from that key
     (`gapOpenStart`). Each arm then runs the pass with settled rules over one ruled letter planted
     between the key's `since` and the look, and counts it exactly. */

  const SELF = "this-cloud";
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const opts = (w: { accountId: string }) => ({ accountId: w.accountId, trustedAuthservIdsFor: NONE, clearanceFor: CLEAR });

  it("travelling since: a closed window leaves the press; an uncounted one its own start; a counted one the press", async () => {
    const closed = await organizedWithAStop();
    const pressed = (await rowOf(closed.mailboxId)).releaseRequestedAt!;
    const k1 = await readTravellingGapSince(db as never, closed.mailboxId, SELF);
    expect(k1).toMatchObject({ since: pressed.toISOString(), by: SELF });
    expect(Date.parse(k1!.at)).toBeGreaterThanOrEqual(Date.parse(k1!.since));

    const uncounted = await organizedWithAStop();
    const own = new Date(Date.now() - 3_600_000);
    await db.update(mailboxes).set({ gapSince: own }).where(eq(mailboxes.id, uncounted.mailboxId));
    expect((await readTravellingGapSince(db as never, uncounted.mailboxId, SELF))?.since).toBe(own.toISOString());

    const counted = await organizedWithAStop();
    const offered = new Date(Date.now() - 7_200_000);
    await db.update(mailboxes).set({ gapSince: offered, gapLetters: 3 }).where(eq(mailboxes.id, counted.mailboxId));
    const press = (await rowOf(counted.mailboxId)).releaseRequestedAt!;
    expect((await readTravellingGapSince(db as never, counted.mailboxId, SELF))?.since, "a counted window travelled")
      .toBe(press.toISOString());
    // …while the row keeps its own window and its offer.
    expect(await markMailboxReleased(db as never, counted.mailboxId)).toBe(true);
    expect(await rowOf(counted.mailboxId)).toMatchObject({ since: offered, letters: 3 });
  }, 60_000);

  it("travelling since: behind a recorded holder it is the release, not the press", async () => {
    const w = await organizedWithAStop();
    await db.update(mailboxes).set({ organizedByInstallId: "the-laptop", organizedByKind: "local" }).where(eq(mailboxes.id, w.mailboxId));
    const before = await storeNow();
    const k = await readTravellingGapSince(db as never, w.mailboxId, SELF);
    expect(Date.parse(k!.since)).toBeGreaterThanOrEqual(before.getTime() - 5);
    expect(k!.since).toBe(k!.at);
  }, 60_000);

  /** A reader row of this install; `row` sets its pre-look columns. */
  async function readerRow(row: Partial<typeof mailboxes.$inferInsert> = {}): Promise<{ accountId: string; mailboxId: string }> {
    const accountId = randomUUID();
    await db.insert(accounts).values({ id: accountId, name: `travels-${accountId.slice(0, 8)}` });
    const [mb] = await db.insert(mailboxes).values({
      accountId, provider: "imap", address: `me-${accountId.slice(0, 8)}@ohmail.test`,
      organizerRole: "reader", organizeConsentedAt: RULE_MADE, ...row,
    }).returning();
    await db.insert(rules).values({
      accountId, kind: "sender", match: SENDER, destination: NEWS,
      provenance: "manual", enabled: true, createdAt: RULE_MADE, updatedAt: RULE_MADE,
    });
    return { accountId, mailboxId: mb!.id };
  }

  /** The look that found nobody, opening the window from `travelled`. */
  const look = (id: string, travelled: TravelledGap | null, o: { written?: { by: string | null; at: Date } } = {}) =>
    refreshOrganizerHolder(db as never, id, NOBODY, {
      gap: "open", stateChanged: false,
      opensAt: gapOpenStart(dialect(db as never), {
        occupancy: "none", stoppedAt: null, travelled, written: o.written ?? null, self: SELF,
      }),
    });

  /** The look that found only a stopped claim, renewed last at `heartbeat`. */
  const lookStopped = (id: string, heartbeat: Date) =>
    refreshOrganizerHolder(db as never, id, { ...NOBODY, state: "stopped" } as never, {
      gap: "open", stateChanged: true,
      opensAt: gapOpenStart(dialect(db as never), {
        occupancy: "stopped", stoppedAt: heartbeat, travelled: null, written: null, self: SELF,
      }),
    });

  /** Organize here, then the pass with settled rules: the count it offered. */
  async function offered(w: { accountId: string; mailboxId: string }): Promise<number | null> {
    await organizeHere(w.mailboxId);
    await gapCatchupPass(db as unknown as Tx, opts(w));
    return (await rowOf(w.mailboxId)).letters;
  }

  /** A hand-back elsewhere at `since`, released `at`, by `by`; a letter planted after `since`. */
  async function handedBackElsewhere(by: string, row: Partial<typeof mailboxes.$inferInsert> = {}) {
    const w = await readerRow(row);
    const since = await storeNow();
    await wait(20);
    const letter = await readerTakesIn(w, await storeNow());
    await wait(20);
    const at = await storeNow();
    await wait(20);
    return { w, letter, key: { since, by, at } satisfies TravelledGap };
  }

  it("no key: today's rule, the window opens at the look and the letter before it is not offered", async () => {
    const { w } = await handedBackElsewhere("the-laptop");
    const lookedAt = await storeNow();
    expect(await look(w.mailboxId, null)).toBe(true);
    expect((await rowOf(w.mailboxId)).since!.getTime()).toBeGreaterThanOrEqual(lookedAt.getTime() - 5);
    expect(await offered(w), "a letter before the look was counted").toBeNull();
  }, 60_000);

  it("a release newer than the row's last change, by the holder it recorded: the window opens at the key", async () => {
    const seenHeld = new Date(Date.now() - 600_000);
    const { w, key } = await handedBackElsewhere("the-laptop", {
      organizedByInstallId: "the-laptop", organizedByKind: "local", organizerState: "held", organizerEventAt: seenHeld,
    });
    expect(await look(w.mailboxId, key)).toBe(true);
    expect((await rowOf(w.mailboxId)).since!.getTime()).toBe(key.since.getTime());
    expect(await offered(w)).toBe(1);
  }, 60_000);

  it("a release newer than the row's last change, by an install it never saw: the key replaces an older window", async () => {
    const accountStart = new Date(Date.now() - 3_600_000);
    const ownRelease = new Date(Date.now() - 3_000_000);
    const w = await readerRow({ gapSince: accountStart, organizerEventAt: ownRelease });
    // A letter of the tenure this row never saw, before the other install's press…
    await readerTakesIn(w, new Date(Date.now() - 1_000_000));
    const since = await storeNow();
    await wait(20);
    await readerTakesIn(w, await storeNow());
    const key = { since, by: "the-laptop", at: await storeNow() };
    expect(await look(w.mailboxId, key)).toBe(true);
    expect((await rowOf(w.mailboxId)).since!.getTime(), "the window reached over a tenure").toBe(since.getTime());
    expect(await offered(w), "only the letter after the press is offered").toBe(1);
  }, 60_000);

  it("a release older than a holder the row recorded since: today's rule", async () => {
    const { w, key } = await handedBackElsewhere("the-laptop");
    await db.update(mailboxes).set({
      organizedByInstallId: "a-phone", organizedByKind: "mobile", organizerState: "held", organizerEventAt: new Date(key.at.getTime() + 10),
    }).where(eq(mailboxes.id, w.mailboxId));
    expect(await look(w.mailboxId, key)).toBe(true);
    expect(await offered(w), "a key reached back over a tenure the row saw").toBeNull();
  }, 60_000);

  it("the same install held again after its key: today's rule", async () => {
    const { w, key } = await handedBackElsewhere("the-laptop");
    await db.update(mailboxes).set({
      organizedByInstallId: "the-laptop", organizedByKind: "local", organizerState: "held", organizerEventAt: new Date(key.at.getTime() + 10),
    }).where(eq(mailboxes.id, w.mailboxId));
    const lookedAt = await storeNow();
    expect(await look(w.mailboxId, key)).toBe(true);
    expect((await rowOf(w.mailboxId)).since!.getTime()).toBeGreaterThanOrEqual(lookedAt.getTime() - 5);
    expect(await offered(w)).toBeNull();
  }, 60_000);

  it("a release older than the row's last change with no holder remembered: an open window stays, a closed one opens at the key", async () => {
    const { w, key } = await handedBackElsewhere("the-laptop", { organizerEventAt: new Date(Date.now() + 60_000) });
    expect(await look(w.mailboxId, key)).toBe(true);
    expect(await offered(w)).toBe(1);

    const later = await handedBackElsewhere("the-laptop", { organizerEventAt: new Date(Date.now() + 60_000) });
    const open = new Date(Date.now() + 1_000);
    await db.update(mailboxes).set({ gapSince: open }).where(eq(mailboxes.id, later.w.mailboxId));
    expect(await look(later.w.mailboxId, later.key)).toBe(true);
    expect((await rowOf(later.w.mailboxId)).since!.getTime()).toBe(open.getTime());
  }, 60_000);

  it("this install's own key never moves an open window, and opens a closed one at its start", async () => {
    const { w, key } = await handedBackElsewhere(SELF);
    const open = await storeNow();
    await db.update(mailboxes).set({ gapSince: open }).where(eq(mailboxes.id, w.mailboxId));
    expect(await look(w.mailboxId, key)).toBe(true);
    expect((await rowOf(w.mailboxId)).since!.getTime(), "our own key moved the window").toBe(open.getTime());
    expect(await offered(w)).toBeNull();

    const closed = await handedBackElsewhere(SELF);
    expect(await look(closed.w.mailboxId, closed.key)).toBe(true);
    expect(await offered(closed.w)).toBe(1);
  }, 60_000);

  it("a stopped claim: the window opens at its last stamp, whatever a key says", async () => {
    const w = await readerRow();
    const early = await readerTakesIn(w, await storeNow());
    await wait(20);
    const heartbeat = await storeNow();
    await wait(20);
    const late = await readerTakesIn(w, await storeNow());
    const key = { since: new Date(Date.now() - 3_600_000), by: "the-laptop", at: new Date(Date.now() - 3_000_000) };
    expect(await refreshOrganizerHolder(db as never, w.mailboxId, { ...NOBODY, state: "stopped" } as never, {
      gap: "open", stateChanged: true,
      opensAt: gapOpenStart(dialect(db as never), {
        occupancy: "stopped", stoppedAt: heartbeat, travelled: key, written: null, self: SELF,
      }),
    })).toBe(true);
    expect((await rowOf(w.mailboxId)).since!.getTime()).toBe(heartbeat.getTime());
    expect(await offered(w)).toBe(1);
    await db.update(mailboxes).set({ gapPressedAt: new Date() }).where(eq(mailboxes.id, w.mailboxId));
    await gapCatchupPass(db as unknown as Tx, opts(w));
    const decided = await db.select({ m: routingDecisions.messageId }).from(routingDecisions)
      .where(eq(routingDecisions.accountId, w.accountId));
    expect(decided.map((d) => d.m)).toEqual([late]);
    expect(decided.map((d) => d.m)).not.toContain(early);
  }, 60_000);

  it("a stopped claim last renewed after the open window began: the window moves to its last stamp", async () => {
    const w = await readerRow();
    await db.update(mailboxes).set({ gapSince: await storeNow() }).where(eq(mailboxes.id, w.mailboxId));
    await wait(20);
    const kept = await readerTakesIn(w, await storeNow());
    await wait(20);
    const heartbeat = await storeNow();
    await wait(20);
    const late = await readerTakesIn(w, await storeNow());
    expect(await lookStopped(w.mailboxId, heartbeat)).toBe(true);
    expect((await rowOf(w.mailboxId)).since!.getTime(), "the window reached over the stopped tenure").toBe(heartbeat.getTime());
    expect(await offered(w), "a letter of the stopped tenure was counted").toBe(1);
    await db.update(mailboxes).set({ gapPressedAt: new Date() }).where(eq(mailboxes.id, w.mailboxId));
    await gapCatchupPass(db as unknown as Tx, opts(w));
    const decided = await db.select({ m: routingDecisions.messageId }).from(routingDecisions)
      .where(eq(routingDecisions.accountId, w.accountId));
    expect(decided.map((d) => d.m)).toEqual([late]);
    expect(decided.map((d) => d.m)).not.toContain(kept);
  }, 60_000);

  it("a stale claim last renewed before the open window began: the window stays, never moved back", async () => {
    const w = await readerRow();
    const open = new Date(Date.now() - 600_000);
    // Not even when the row never recorded that claim: an earlier tenure's residue says nothing of this window.
    await db.update(mailboxes).set({ gapSince: open, organizerEventAt: new Date(Date.now() - 300_000) }).where(eq(mailboxes.id, w.mailboxId));
    expect(await lookStopped(w.mailboxId, new Date(Date.now() - 1_800_000))).toBe(true);
    expect((await rowOf(w.mailboxId)).since!.getTime()).toBe(open.getTime());
  }, 60_000);

  it("a holder the row saw stop, renewed unseen and stopped again: the window moves to its newest stamp", async () => {
    // The row recorded the-laptop stopped (its window opened at that stamp), then the laptop came back unseen.
    const firstStop = await storeNow();
    const w = await readerRow({
      gapSince: firstStop, organizedByInstallId: "the-laptop", organizedByKind: "local", organizerState: "stopped",
      organizedSince: new Date(firstStop.getTime() - 600_000), organizerEventAt: new Date(firstStop.getTime() + 5),
    });
    await wait(20);
    const kept = await readerTakesIn(w, await storeNow());
    await wait(20);
    const again = await storeNow();
    await wait(20);
    const late = await readerTakesIn(w, await storeNow());
    expect(await refreshOrganizerHolder(db as never, w.mailboxId, { ...NOBODY, state: "stopped" } as never, {
      gap: "open", stateChanged: false,
      opensAt: gapOpenStart(dialect(db as never), { occupancy: "stopped", stoppedAt: again, travelled: null, written: null, self: SELF }),
    })).toBe(true);
    expect((await rowOf(w.mailboxId)).since!.getTime(), "the window reached over the laptop's second turn").toBe(again.getTime());
    expect(await offered(w), "a letter of the second turn was counted").toBe(1);
    await db.update(mailboxes).set({ gapPressedAt: new Date() }).where(eq(mailboxes.id, w.mailboxId));
    await gapCatchupPass(db as unknown as Tx, opts(w));
    const decided = await db.select({ m: routingDecisions.messageId }).from(routingDecisions)
      .where(eq(routingDecisions.accountId, w.accountId));
    expect(decided.map((d) => d.m)).toEqual([late]);
    expect(decided.map((d) => d.m)).not.toContain(kept);
  }, 60_000);

  it("no key, and another install wrote the settings after the window opened: the window opens at the look", async () => {
    const w = await readerRow();
    await db.update(mailboxes).set({ gapSince: await storeNow() }).where(eq(mailboxes.id, w.mailboxId));
    await wait(20);
    const written = { by: "the-laptop", at: await storeNow() };
    await wait(20);
    await readerTakesIn(w, await storeNow());
    await wait(20);
    const lookedAt = await storeNow();
    expect(await look(w.mailboxId, null, { written })).toBe(true);
    expect((await rowOf(w.mailboxId)).since!.getTime(), "the window reached over the other install's turn")
      .toBeGreaterThanOrEqual(lookedAt.getTime() - 5);
    await wait(20);
    await readerTakesIn(w, await storeNow());
    expect(await offered(w), "a letter of the other install's turn was counted").toBe(1);
  }, 60_000);

  it("no key: this install's own document, or one written before the window opened, keeps the window", async () => {
    for (const by of [SELF, "the-laptop"]) {
      const w = await readerRow();
      const before = new Date(Date.now() - 1_200_000);
      const open = new Date(Date.now() - 600_000);
      await db.update(mailboxes).set({ gapSince: open }).where(eq(mailboxes.id, w.mailboxId));
      const at = by === SELF ? await storeNow() : before;
      expect(await look(w.mailboxId, null, { written: { by, at } })).toBe(true);
      expect((await rowOf(w.mailboxId)).since!.getTime(), by).toBe(open.getTime());
    }
  }, 60_000);

  it("held: the travelled window waits by name, uncounted and kept", async () => {
    const { w, key } = await handedBackElsewhere("the-laptop");
    expect(await look(w.mailboxId, key)).toBe(true);
    await organizeHere(w.mailboxId);
    const said: Array<{ event: string; fields: Record<string, unknown> | undefined }> = [];
    const log = {
      level: "info", child: () => log,
      debug: () => {}, warn: () => {}, error: () => {},
      info: (event: string, fields?: Record<string, unknown>) => { said.push({ event, fields }); },
    };
    const ran = await gapCatchupPass(db as unknown as Tx, {
      accountId: w.accountId, trustedAuthservIdsFor: NONE, clearanceFor: () => ({ kind: "held" }) as never, log: log as never,
    });
    expect(ran).toEqual({ offered: 0, moved: 0, completed: 0 });
    expect(said.find((l) => l.event === "gap_catchup_withheld")?.fields).toMatchObject({ mailboxId: w.mailboxId, outcome: "held" });
    expect(await rowOf(w.mailboxId)).toMatchObject({ since: key.since, letters: null });
    expect(await offered(w), "the window kept under the hold was not the key's").toBe(1);
  }, 60_000);
});
