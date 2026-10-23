
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
import { accounts, changeLog, folderState, mailboxes, messages, rules } from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import type { Tx } from "@trafficflow/db";
import { ruleRetroPass } from "../src/rule-retro.js";

/**
 * THE RETROACTIVE PASS OVER A SUBJECT RULE — mail 0050, against real Postgres.
 *
 * Writing a rule applies it to the mail already in the mailbox; that is the default and it is the
 * `retro_requested_at` machinery `ruleRetroPass` walks. A subject rule is meant to RIDE that
 * machinery unchanged, and "unchanged" is a claim that has to be measured rather than asserted,
 * because the pass has a SQL candidate query of its own (`selectCandidates`) and the subject term is
 * not in it.
 *
 * ── WHAT COULD HAVE GONE WRONG, AND WHY IT WOULD HAVE BEEN SILENT ──────────────────────────
 *
 * `selectCandidates` narrows by the rule's SENDER, so both kinds of mail from `info@` arrive as
 * candidates and the subject term is applied afterwards by `evaluateRules`. Two failures are
 * available and neither raises:
 *
 *  · the term is ignored on this path ⇒ the pass files the invoice into Reads along with the alerts,
 *    which is the exact damage the feature exists to prevent, done retroactively to the backlog;
 *  · the pass never completes ⇒ `retro_done_at` stays NULL and the rule is re-walked every cycle for
 *    ever, which costs a scan per cycle and shows up as nothing at all.
 *
 * So this asserts BOTH the mail that moved and the mail that did not, from one pass, plus the
 * completion marker and the counter.
 *
 * ── WHY REAL POSTGRES ──────────────────────────────────────────────────────────────────────
 *
 * The pass takes the rule row `FOR UPDATE` and commits its cursor and its `change_log` rows in the
 * same transaction; PGlite is single-connection and green by construction for all of that. More
 * specifically for this slice: the `rules` row the pass re-reads inside its page transaction is
 * built from a hand-listed column set, so a subject rule read through it is a real query against a
 * real catalog and not a fixture.
 */

const AVAILABLE = await realPgAvailable();

const OHBOX = "INBOX";
const READS = "ohmail/News";
const SENDER = "info@sichersatt.example";
const TOKEN = "[NinjaFirewall]";
const NOW = new Date("2026-08-10T12:00:00Z");

describe.skipIf(!AVAILABLE)("rule-retro over a subject rule", () => {
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
    await db.insert(accounts).values({ id: accountId, name: `s7r-${accountId.slice(0, 8)}` });
    const [mb] = await db.insert(mailboxes).values({
      accountId, provider: "imap", address: `me-${accountId.slice(0, 8)}@ohmail.test`,
    }).returning();
    return { accountId, mailboxId: mb!.id };
  }

  /** One stored message, filed where `folder` says, with a `folder_state` row WE authored. */
  async function seedMessage(w: World, subject: string, folder = OHBOX): Promise<string> {
    const dedup = `mid:${randomUUID()}`;
    const [m] = await db.insert(messages).values({
      accountId: w.accountId, mailboxId: w.mailboxId,
      messageIdHeader: dedup, bodyHash: randomUUID(), dedupKey: dedup,
      subject, fromAddress: SENDER, nativeLocator: { folder, ref: "1:1" },
    }).returning();
    await db.insert(folderState).values({
      messageId: m!.id, desiredFolder: folder, observedFolder: folder,
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

  it("moves the mail the term names and leaves the sender's other mail where it is", async () => {
    const w = await newWorld();
    const alertA = await seedMessage(w, `${TOKEN} Alert: brute-force attempt blocked`);
    const alertB = await seedMessage(w, `Re: ${TOKEN} nightly report`);
    const invoice = await seedMessage(w, "Rechnung 2026-08 / Invoice");

    // The pair a user ends up with: the narrow rule they just wrote (retro owed), and the broad rule
    // that was already there keeping everything else in the Ohbox. The broad rule is NOT owed — its
    // backlog was applied when it was written — so the pass has exactly one rule to walk.
    const [narrow] = await db.insert(rules).values({
      accountId: w.accountId, kind: "sender", match: SENDER, destination: READS,
      provenance: "manual", enabled: true, subjectContains: TOKEN,
      retroRequestedAt: new Date("2026-08-10T10:00:00Z"),
    }).returning();
    await db.insert(rules).values({
      accountId: w.accountId, kind: "sender", match: SENDER, destination: OHBOX,
      provenance: "manual", enabled: true,
    });

    const res = await run(w);

    // ANTI-VACUITY FIRST, on `rule-retro.test.ts`'s rule: a pass that examined nothing would satisfy
    // every "did not move" assertion below for the wrong reason.
    expect(res.rules, "the owed probe found no rule to walk").toBe(1);
    expect(res.examined, "the candidate query returned nothing — the sender narrowing is wrong")
      .toBe(3);

    expect(res.moved).toBe(2);
    expect(await desiredOf(alertA)).toBe(READS);
    expect(await desiredOf(alertB)).toBe(READS);
    // THE LOAD-BEARING NEGATIVE. Ignore the term on this path and the invoice lands in Reads too —
    // the feature's whole failure mode, applied retroactively to the backlog.
    expect(await desiredOf(invoice), "the invoice was re-filed by a rule that does not name it")
      .toBe(OHBOX);

    // …and no journal row claims to have moved it, so no client is told it moved either.
    expect(await movesFor(w.accountId, invoice)).toHaveLength(0);
    expect((await movesFor(w.accountId, alertA))[0]!.meta).toEqual({ from: OHBOX, to: READS });

    const [after] = await db.select().from(rules).where(eq(rules.id, narrow!.id));
    // The completion marker is written LAST and only once the backlog is exhausted. Without it the
    // rule is re-walked every cycle for ever, which is invisible except as load.
    expect(after!.retroDoneAt).not.toBeNull();
    expect(after!.retroMoved).toBe(2);
    expect(res.completed).toBe(1);
  }, 120_000);

  it("is idempotent — a second pass over the same rule writes nothing", async () => {
    // The pass's own idempotency is the candidate query (`desired_folder <> destination`), and a
    // subject rule must not break it: the two alerts are now desired into Reads and drop out, while
    // the invoice is still a candidate and must still be KEPT rather than moved. So the second run is
    // the strongest available statement that the term is consulted every time and not once.
    const w = await newWorld();
    const alert = await seedMessage(w, `${TOKEN} nightly report`);
    const invoice = await seedMessage(w, "Invoice 2026-08");
    await db.insert(rules).values({
      accountId: w.accountId, kind: "sender", match: SENDER, destination: READS,
      provenance: "manual", enabled: true, subjectContains: TOKEN,
      retroRequestedAt: new Date("2026-08-10T10:00:00Z"),
    });

    const first = await run(w);
    expect(first.moved).toBe(1);

    // `retro_done_at` is set, so the owed probe skips the rule entirely: nothing is examined and
    // nothing is written. That IS the second-run guarantee, and asserting the folder state after it
    // is what makes the claim about the mail rather than about the probe.
    const second = await run(w);
    expect(second.moved).toBe(0);
    expect(await desiredOf(alert)).toBe(READS);
    expect(await desiredOf(invoice)).toBe(OHBOX);
    expect(await movesFor(w.accountId, alert)).toHaveLength(1);
    expect(await movesFor(w.accountId, invoice)).toHaveLength(0);
  }, 120_000);

  it("a term whose token appears in NO stored subject moves nothing and still completes", async () => {
    // The honest negative case: a user mistypes the token, or the sender changes it. The rule must
    // not become a no-op that is re-walked for ever, and it must not fall back to matching the
    // sender's whole mail — which is the pre-column behaviour and would be a silent widening of a
    // rule the user deliberately narrowed.
    const w = await newWorld();
    const a = await seedMessage(w, "Rechnung 2026-08");
    const b = await seedMessage(w, "Terminbestätigung");
    const [rule] = await db.insert(rules).values({
      accountId: w.accountId, kind: "sender", match: SENDER, destination: READS,
      provenance: "manual", enabled: true, subjectContains: "[NinjaFirewal]",   // one letter short
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

  it("with a reader mailbox, the walk files only its term and is not re-walked each cycle", async () => {
    // The reader's press made a sender rule with past mail OFF; the term rule's walk must not file
    // the sender's other letters by it, on this cycle or any later one while the rule stays owed.
    const w = await newWorld();
    await db.insert(mailboxes).values({
      accountId: w.accountId, provider: "imap", address: `r-${w.accountId.slice(0, 8)}@ohmail.test`,
      organizerRole: "reader",
    });
    const alert = await seedMessage(w, `${TOKEN} nightly report`);
    const invoice = await seedMessage(w, "Invoice 2026-08");
    await db.insert(rules).values({
      accountId: w.accountId, kind: "sender", match: SENDER, destination: "ohmail/Receipts",
      provenance: "manual", enabled: true,
    });
    const [narrow] = await db.insert(rules).values({
      accountId: w.accountId, kind: "sender", match: SENDER, destination: READS,
      provenance: "manual", enabled: true, subjectContains: TOKEN,
      retroRequestedAt: new Date("2026-08-10T10:00:00Z"),
    }).returning();

    expect((await run(w)).moved).toBe(1);
    const second = await run(w);

    expect(second.examined, "the parked walk ran again").toBe(0);
    expect(await desiredOf(alert)).toBe(READS);
    expect(await desiredOf(invoice), "the declined sender rule's backlog was filed").toBe(OHBOX);
    expect(await movesFor(w.accountId, invoice)).toHaveLength(0);
    const [after] = await db.select().from(rules).where(eq(rules.id, narrow!.id));
    expect(after!.retroDoneAt, "a reader is still outside the walk").toBeNull();
  }, 120_000);
});
