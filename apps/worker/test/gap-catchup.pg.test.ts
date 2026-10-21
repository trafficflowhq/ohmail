/** The explicit empty trust set - an unlisted provider's mailbox; the auth demotion never fires. */
const NONE = async (): Promise<ReadonlySet<string>> => new Set<string>();
/** Settled rules: the settings folder read cleanly with no import question open. */
const CLEAR = () => ({ kind: "clear" }) as const;
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect, carryDialect } from "@trafficflow/db/dialect";
import { and, eq } from "drizzle-orm";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { accounts, changeLog, folderState, mailboxes, messages, routingDecisions, rules } from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import type { Tx } from "@trafficflow/db";
import {
  formatProfileMessage, isMalformedProfile, makeProfileDoc, parseProfileMessage, profileFingerprint,
} from "@trafficflow/core/adapters/organizer-profile";
import { applyOrganizerProfile } from "@trafficflow/core/adapters/organizer-profile-store";
import { gapCatchupPass } from "../src/gap-catchup.js";

/**
 * THE GAP OFFER'S ONCE-ONLY, ON REAL POSTGRES. PGlite is one connection, so the
 * mailbox row's lock and two drivers meeting on one window are green there by construction. Here
 * two passes race on two connections: they write ONE offer, and after the press every counted
 * letter gets exactly one decision row and one change row, and the window closes once.
 */

const AVAILABLE = await realPgAvailable();
const NEWS = "ohmail/News";
const GAP = new Date("2026-10-09T10:00:00Z");
const IN_GAP = new Date("2026-10-09T10:30:00Z");
const RULE_MADE = new Date("2026-10-01T00:00:00Z");

describe.skipIf(!AVAILABLE)("the gap catch-up on real Postgres", () => {
  let sql: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let other: ReturnType<typeof postgres>;
  let db2: ReturnType<typeof drizzle<typeof schema>>;

  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    sql = postgres(PG_TEST_URL, { max: 3, onnotice: () => {} });
    db = brandDialect(drizzle(sql, { schema }), "pg");
    other = postgres(PG_TEST_URL, { max: 3, onnotice: () => {} });
    db2 = brandDialect(drizzle(other, { schema }), "pg");
  }, 120_000);

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
    await other?.end({ timeout: 5 });
  });

  async function world(letters: number): Promise<{ accountId: string; mailboxId: string; ids: string[] }> {
    const accountId = randomUUID();
    await db.insert(accounts).values({ id: accountId, name: `gap-${accountId.slice(0, 8)}` });
    const [mb] = await db.insert(mailboxes).values({
      accountId, provider: "imap", address: `me-${accountId.slice(0, 8)}@ohmail.test`,
      organizerRole: "organizer", gapSince: GAP,
    }).returning();
    await db.insert(rules).values({
      accountId, kind: "sender", match: "letters@news.test", destination: NEWS,
      provenance: "manual", enabled: true, createdAt: RULE_MADE, updatedAt: RULE_MADE,
    });
    const ids: string[] = [];
    for (let i = 0; i < letters; i++) {
      const dedup = `mid:${randomUUID()}`;
      const [m] = await db.insert(messages).values({
        accountId, mailboxId: mb!.id, messageIdHeader: dedup, bodyHash: randomUUID(), dedupKey: dedup,
        subject: `letter ${i}`, fromAddress: "letters@news.test", nativeLocator: { folder: "INBOX", ref: `1:${i + 1}` },
        arrivedAt: IN_GAP,
      }).returning();
      await db.insert(folderState).values({
        messageId: m!.id, desiredFolder: "INBOX", observedFolder: "INBOX",
        lastSetBy: "peer", reconcileStatus: "reconciled", conflict: false,
      });
      ids.push(m!.id);
    }
    return { accountId, mailboxId: mb!.id, ids };
  }

  const press = (mailboxId: string) => db.update(mailboxes).set({ gapPressedAt: new Date() }).where(eq(mailboxes.id, mailboxId));

  it("counts the gap, files it only on the press and closes the window, on Postgres's own parameters", async () => {
    const w = await world(3);
    const opts = { accountId: w.accountId, trustedAuthservIdsFor: NONE, clearanceFor: CLEAR };
    expect(await gapCatchupPass(db as unknown as Tx, opts)).toEqual({ offered: 1, moved: 0, completed: 0 });
    const [offer] = await db.select({ n: mailboxes.gapLetters }).from(mailboxes).where(eq(mailboxes.id, w.mailboxId));
    expect(offer!.n, "intake and arrival bounds read the timestamptz columns wrong").toBe(3);
    await press(w.mailboxId);
    const done = await gapCatchupPass(db as unknown as Tx, opts);
    expect(done).toMatchObject({ moved: 3, completed: 1 });
    const [mb] = await db.select({ g: mailboxes.gapSince }).from(mailboxes).where(eq(mailboxes.id, w.mailboxId));
    expect(mb!.g).toBeNull();
    for (const id of w.ids) {
      const [fs] = await db.select().from(folderState).where(eq(folderState.messageId, id));
      expect(fs).toMatchObject({ desiredFolder: NEWS, lastSetBy: "us" });
    }
  }, 60_000);

  it("two drivers racing on one window write ONE offer, then ONE decision and ONE change row per letter", async () => {
    const w = await world(24);
    const opts = { accountId: w.accountId, trustedAuthservIdsFor: NONE, clearanceFor: CLEAR, batch: 4 };
    const [c1, c2] = await Promise.all([
      gapCatchupPass(db as unknown as Tx, opts),
      gapCatchupPass(db2 as unknown as Tx, opts),
    ]);
    expect(c1.offered + c2.offered, "two offers were written").toBe(1);
    expect(c1.moved + c2.moved, "a count moved mail").toBe(0);
    await press(w.mailboxId);
    const [a, b] = await Promise.all([
      gapCatchupPass(db as unknown as Tx, opts),
      gapCatchupPass(db2 as unknown as Tx, opts),
    ]);

    expect(a.moved + b.moved, "a letter was decided twice, or not at all").toBe(24);
    expect(a.completed + b.completed, "the window closed twice").toBe(1);
    const decisions = await db.select({ m: routingDecisions.messageId }).from(routingDecisions)
      .where(eq(routingDecisions.accountId, w.accountId));
    expect(decisions).toHaveLength(24);
    expect(new Set(decisions.map((d) => d.m)).size).toBe(24);
    const moves = await db.select({ e: changeLog.entityId }).from(changeLog)
      .where(and(eq(changeLog.accountId, w.accountId), eq(changeLog.op, "move")));
    expect(moves).toHaveLength(24);
    const [mb] = await db.select({ g: mailboxes.gapSince }).from(mailboxes).where(eq(mailboxes.id, w.mailboxId));
    expect(mb!.g).toBeNull();
  }, 60_000);

  const HELD = () => ({ kind: "held" }) as const;

  /** A fresh install's window with one letter in it and no rules of its own. */
  async function freshWorld(): Promise<{ accountId: string; mailboxId: string; letter: string }> {
    const w = await world(1);
    await db.delete(rules).where(eq(rules.accountId, w.accountId));
    return { accountId: w.accountId, mailboxId: w.mailboxId, letter: w.ids[0]! };
  }

  it("the cross-install case on Postgres: held withholds, then the imported rule's age offers the letter and File files it", async () => {
    const w = await freshWorld();
    const opts = { accountId: w.accountId, trustedAuthservIdsFor: NONE };
    expect(await gapCatchupPass(db as unknown as Tx, { ...opts, clearanceFor: HELD })).toEqual({ offered: 0, moved: 0, completed: 0 });
    const [open] = await db.select({ g: mailboxes.gapSince }).from(mailboxes).where(eq(mailboxes.id, w.mailboxId));
    expect(open!.g, "the open import question closed the window").not.toBeNull();

    const written = makeProfileDoc({
      screener: [], notifyRules: [], awayResponder: null, tagNames: [], signature: null,
      rules: [{
        kind: "sender", match: "letters@news.test", destination: NEWS, priority: 0, enabled: true,
        provenance: "manual", updatedAt: RULE_MADE.toISOString(),
      }],
    }, { updatedAt: GAP, producer: { kind: "local", version: "dev" } });
    const parsed = parseProfileMessage(formatProfileMessage(written, { installId: "the-desktop" }));
    if (parsed === null || isMalformedProfile(parsed) || !parsed.doc) throw new Error("expected a readable copy");
    const doc = parsed.doc;
    await db.transaction((tx) => applyOrganizerProfile(carryDialect(db, tx) as never, {
      accountId: w.accountId, mailboxId: w.mailboxId, doc, fingerprint: profileFingerprint(doc), now: new Date(),
    }));
    expect(await gapCatchupPass(db as unknown as Tx, { ...opts, clearanceFor: CLEAR })).toEqual({ offered: 1, moved: 0, completed: 0 });
    await press(w.mailboxId);
    expect(await gapCatchupPass(db as unknown as Tx, { ...opts, clearanceFor: CLEAR })).toEqual({ offered: 0, moved: 1, completed: 1 });
    const [fs] = await db.select().from(folderState).where(eq(folderState.messageId, w.letter));
    expect(fs).toMatchObject({ desiredFolder: NEWS, lastSetBy: "us" });
  }, 60_000);

  it("a withheld window takes no lock: it returns while another connection holds the mailbox row", async () => {
    const w = await world(1);
    const opts = { accountId: w.accountId, trustedAuthservIdsFor: NONE };
    const within = <T>(p: Promise<T>, ms: number): Promise<T | "blocked"> =>
      Promise.race([p, new Promise<"blocked">((r) => setTimeout(() => r("blocked"), ms))]);
    let release!: () => void;
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => { locked = r; });
    const holder = other.begin(async (t) => {
      await t`select id from mailboxes where id = ${w.mailboxId} for update`;
      locked();
      await new Promise<void>((r) => { release = r; });
    });
    await isLocked;
    try {
      expect(await within(gapCatchupPass(db as unknown as Tx, { ...opts, clearanceFor: HELD }), 5_000),
        "a withheld window waited on the mailbox row").toEqual({ offered: 0, moved: 0, completed: 0 });
      /* CONTROL: cleared, the same pass waits on that row — the lock this test says is not taken. */
      const cleared = gapCatchupPass(db as unknown as Tx, { ...opts, clearanceFor: CLEAR });
      expect(await within(cleared, 1_000), "premise: a cleared pass locks the mailbox row").toBe("blocked");
      release();
      await holder;
      expect(await cleared).toEqual({ offered: 1, moved: 0, completed: 0 });
    } finally {
      release?.();
      await holder.catch(() => undefined);
    }
  }, 60_000);
});
