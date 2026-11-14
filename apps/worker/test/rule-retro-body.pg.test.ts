
/** The explicit empty trust set - an unlisted provider's mailbox; the auth demotion never fires. */
const NONE = async (): Promise<ReadonlySet<string>> => new Set<string>();
import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { and, asc, eq } from "drizzle-orm";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import {
  accounts, changeLog, folderState, mailboxes, messageBodies, messages, rules,
} from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import type { Tx } from "@trafficflow/db";
import { ruleRetroPass } from "../src/rule-retro.js";

/**
 * THE RETROACTIVE PASS OVER A BODY RULE — mail 0052, against real Postgres.
 *
 * `rule-retro-subject.pg.test.ts` explains why "the term rides the machinery unchanged" is a
 * claim to measure: `selectCandidates` narrows by SENDER, so both kinds of mail arrive as
 * candidates and the term is applied afterwards by `evaluateRules`. For the body term one thing
 * is genuinely NEW at this seam, and it is the reason this file is not a copy of its sibling:
 *
 * THE HAYSTACK IS A JOINED COLUMN. The subject lives on `messages`; the body lives in
 * `message_bodies.text`, on the NULLABLE side of the pass's LEFT JOIN. So there are two ways for
 * this pass to silently diverge from ingest — read nothing (a body rule that never fires
 * retroactively, invisible except as a user's "the rule did nothing"), or invent something. The
 * fail-closed contract is: a message WITH a stored body is matched against exactly that text,
 * and a message WITHOUT one satisfies no term and STAYS PUT — asserted below with a body-less
 * message whose subject would happily have matched, so a fallback-to-subject bug goes red too.
 */

const AVAILABLE = await realPgAvailable();

const OHBOX = "INBOX";
const READS = "ohmail/News";
const SENDER = "info@sichersatt.example";
const TOKEN = "[NinjaFirewall]";
const NOW = new Date("2026-08-10T12:00:00Z");

describe.skipIf(!AVAILABLE)("rule-retro over a body rule", () => {
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let sql: ReturnType<typeof postgres>;

  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    sql = postgres(PG_TEST_URL, { max: 3, onnotice: () => {} });
    db = brandDialect(drizzle(sql, { schema }), "pg");
  }, 120_000);

  interface World { accountId: string; mailboxId: string }

  async function newWorld(): Promise<World> {
    const accountId = randomUUID();
    await db.insert(accounts).values({ id: accountId, name: `bR-${accountId.slice(0, 8)}` });
    const [mb] = await db.insert(mailboxes).values({
      accountId, provider: "imap", address: `me-${accountId.slice(0, 8)}@ohmail.test`,
    }).returning();
    return { accountId, mailboxId: mb!.id };
  }

  /**
   * One stored message. `text: null` seeds NO `message_bodies` row at all — the body-less shape
   * the LEFT JOIN answers NULL for, which is a real state (bodies arrive after headers on some
   * paths) and the one this file exists to pin fail-closed.
   */
  async function seedMessage(
    w: World, subject: string, text: string | null, folder = OHBOX,
  ): Promise<string> {
    const dedup = `mid:${randomUUID()}`;
    const [m] = await db.insert(messages).values({
      accountId: w.accountId, mailboxId: w.mailboxId,
      messageIdHeader: dedup, bodyHash: randomUUID(), dedupKey: dedup,
      subject, fromAddress: SENDER, nativeLocator: { folder, ref: "1:1" },
    }).returning();
    if (text !== null) {
      await db.insert(messageBodies).values({ messageId: m!.id, accountId: m!.accountId, text });
    }
    await db.insert(folderState).values({
      messageId: m!.id, accountId: m!.accountId, desiredFolder: folder, observedFolder: folder,
      lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
    });
    return m!.id;
  }

  const desiredOf = async (messageId: string): Promise<string> => {
    const [row] = await db.select({ d: folderState.desiredFolder }).from(folderState)
      .where(eq(folderState.messageId, messageId));
    return row!.d;
  };

  const movesFor = (accountId: string, messageId: string) =>
    db.select({ meta: changeLog.meta }).from(changeLog)
      .where(and(
        eq(changeLog.accountId, accountId),
        eq(changeLog.entityType, "message"),
        eq(changeLog.entityId, messageId),
        eq(changeLog.op, "move"),
      ))
      .orderBy(asc(changeLog.seq));

  const run = (w: World) =>
    ruleRetroPass(db as unknown as Tx, { accountId: w.accountId, trustedAuthservIdsFor: NONE }, NOW);

  it("moves the mail whose stored text carries the term and leaves the rest where it is", async () => {
    const w = await newWorld();
    // The sender writes the SAME subject on everything — the case a subject term cannot split.
    const alertA = await seedMessage(w, "Notification", `${TOKEN} brute-force attempt blocked`);
    const alertB = await seedMessage(w, "Notification", `Scan finished.\n${TOKEN}\nUnsubscribe.`);
    const invoice = await seedMessage(w, "Notification", "Rechnung 2026-08. Zahlbar in 30 Tagen.");

    const [narrow] = await db.insert(rules).values({
      accountId: w.accountId, kind: "sender", match: SENDER, destination: READS,
      provenance: "manual", enabled: true, bodyContains: TOKEN,
      retroRequestedAt: new Date("2026-08-10T10:00:00Z"),
    }).returning();
    await db.insert(rules).values({
      accountId: w.accountId, kind: "sender", match: SENDER, destination: OHBOX,
      provenance: "manual", enabled: true,
    });

    const res = await run(w);

    // Anti-vacuity first: a pass that examined nothing satisfies every negative below.
    expect(res.rules, "the owed probe found no rule to walk").toBe(1);
    expect(res.examined, "the candidate query returned nothing — the sender narrowing is wrong")
      .toBe(3);

    expect(res.moved).toBe(2);
    expect(await desiredOf(alertA)).toBe(READS);
    expect(await desiredOf(alertB)).toBe(READS);
    // THE LOAD-BEARING NEGATIVE: ignore the term on this path — or match against anything other
    // than the STORED text — and the invoice lands in Reads too.
    expect(await desiredOf(invoice), "the invoice was re-filed by a rule that does not name it")
      .toBe(OHBOX);

    expect(await movesFor(w.accountId, invoice)).toHaveLength(0);
    expect((await movesFor(w.accountId, alertA))[0]!.meta).toEqual({ from: OHBOX, to: READS });

    const [after] = await db.select().from(rules).where(eq(rules.id, narrow!.id));
    expect(after!.retroDoneAt).not.toBeNull();
    expect(after!.retroMoved).toBe(2);
    expect(res.completed).toBe(1);
  }, 120_000);

  it("a message with NO stored body is left alone — the term fails closed, never open", async () => {
    // THE SEAM THIS SLICE ADDS. The body-less message's SUBJECT carries the token, so three
    // distinct bugs go red here, not one: reading NULL as "" and matching (`"".includes` is false,
    // but a `?? subject` fallback would match), skipping the conjunct when the join is empty, and
    // matching the term against the subject instead of the body.
    const w = await newWorld();
    const bodiless = await seedMessage(w, `${TOKEN} Notification`, null);
    const bodied = await seedMessage(w, "Notification", `${TOKEN} details`);
    const [rule] = await db.insert(rules).values({
      accountId: w.accountId, kind: "sender", match: SENDER, destination: READS,
      provenance: "manual", enabled: true, bodyContains: TOKEN,
      retroRequestedAt: new Date("2026-08-10T10:00:00Z"),
    }).returning();

    const res = await run(w);

    expect(res.examined).toBe(2);
    expect(res.moved).toBe(1);
    expect(await desiredOf(bodied)).toBe(READS);
    expect(await desiredOf(bodiless), "a message whose body this pass cannot read was moved on it")
      .toBe(OHBOX);
    expect(await movesFor(w.accountId, bodiless)).toHaveLength(0);
    // …and the un-readable body did not wedge the rule open for ever.
    const [after] = await db.select().from(rules).where(eq(rules.id, rule!.id));
    expect(after!.retroDoneAt).not.toBeNull();
  }, 120_000);

  it("is idempotent — a second pass over the same rule writes nothing", async () => {
    const w = await newWorld();
    const alert = await seedMessage(w, "Notification", `${TOKEN} nightly`);
    const invoice = await seedMessage(w, "Notification", "Invoice 2026-08");
    await db.insert(rules).values({
      accountId: w.accountId, kind: "sender", match: SENDER, destination: READS,
      provenance: "manual", enabled: true, bodyContains: TOKEN,
      retroRequestedAt: new Date("2026-08-10T10:00:00Z"),
    });

    const first = await run(w);
    expect(first.moved).toBe(1);

    const second = await run(w);
    expect(second.moved).toBe(0);
    expect(await desiredOf(alert)).toBe(READS);
    expect(await desiredOf(invoice)).toBe(OHBOX);
    expect(await movesFor(w.accountId, alert)).toHaveLength(1);
    expect(await movesFor(w.accountId, invoice)).toHaveLength(0);
  }, 120_000);

  it("a term found in NO stored body moves nothing and still completes", async () => {
    const w = await newWorld();
    const a = await seedMessage(w, "Notification", "Rechnung 2026-08");
    const b = await seedMessage(w, "Notification", "Terminbestätigung");
    const [rule] = await db.insert(rules).values({
      accountId: w.accountId, kind: "sender", match: SENDER, destination: READS,
      provenance: "manual", enabled: true, bodyContains: "[NinjaFirewal]",   // one letter short
      retroRequestedAt: new Date("2026-08-10T10:00:00Z"),
    }).returning();

    const res = await run(w);

    expect(res.examined).toBe(2);
    expect(res.moved).toBe(0);
    expect(res.kept).toBe(2);
    expect(await desiredOf(a)).toBe(OHBOX);
    expect(await desiredOf(b)).toBe(OHBOX);
    const [after] = await db.select().from(rules).where(eq(rules.id, rule!.id));
    expect(after!.retroDoneAt, "a rule that matched nothing was left owed for ever").not.toBeNull();
  }, 120_000);
});
