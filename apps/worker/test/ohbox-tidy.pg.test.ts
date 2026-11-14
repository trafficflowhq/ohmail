
/** The explicit empty trust set - an unlisted provider's mailbox; the auth demotion never fires. */
const NONE = async (): Promise<ReadonlySet<string>> => new Set<string>();
import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { and, asc, eq, inArray } from "drizzle-orm";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import {
  accountSettings, accounts, approvals, auditLog, changeLog, contacts, drafts, folderState, mailboxes,
  messageBodies, messageStates, messages, rules, threads, accountPass, readPassProgress, requestPass,
  writePassProgress,
} from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import { ohboxTidyPass } from "../src/ohbox-tidy.js";
import type { Tx } from "@trafficflow/db";

/**
 * THE OHBOX BACKLOG RE-ROUTE PASS, AGAINST REAL POSTGRES.
 *
 * PGlite is single-connection, so `SELECT … FOR UPDATE OF folder_state` is a no-op there and every
 * "moved once, not twice" and every "user drag wins the race" claim would pass without being tested.
 * The behavioural matrix (which pile each shape lands in, which intents are excluded) is engine-level
 * and would pass on either, but it lives here too so the demonstration is one file.
 */

const AVAILABLE = await realPgAvailable();
const OHBOX = "INBOX";
const READS = "ohmail/News";
const RECEIPTS = "ohmail/Receipts";

type Provenance = "seeded-from-sent" | "promoted" | "manual" | "migrated";

interface World { accountId: string; mailboxId: string; address: string }

describe.skipIf(!AVAILABLE)("SCR-BACKLOG-REROUTE — the Ohbox tidy pass", () => {
  let db: Tx;
  let sql: ReturnType<typeof postgres>;

  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    // Four connections minimum, or the "concurrent" transactions queue in the POOL and the
    // concurrency cases prove nothing about the database.
    sql = postgres(PG_TEST_URL, { max: 6, onnotice: () => {} });
    db = brandDialect(drizzle(sql, { schema }), "pg") as unknown as Tx;
  }, 120_000);

  async function newWorld(): Promise<World> {
    const accountId = randomUUID();
    await db.insert(accounts).values({ id: accountId, name: `tidy-${accountId.slice(0, 8)}` });
    const [mb] = await db.insert(mailboxes).values({
      accountId, provider: "imap", address: `tidy-${accountId.slice(0, 8)}@example.test`,
    }).returning();
    return { accountId, mailboxId: mb!.id, address: mb!.address };
  }

  /** Turn `people_only` on and ARM the tidy, the way a policy flip does. */
  async function arm(w: World, o: { policy?: string; requested?: Date | null } = {}): Promise<void> {
    const requested = o.requested === undefined ? new Date() : o.requested;
    await db.insert(accountSettings).values({ accountId: w.accountId, ohboxPolicy: o.policy ?? "people_only" })
      .onConflictDoUpdate({ target: accountSettings.accountId, set: { ohboxPolicy: o.policy ?? "people_only" } });
    await writePassProgress(db as unknown as Tx, accountPass("ohbox_tidy", w.accountId), { requestedAt: requested, cursor: null });
  }

  /**
   * One message in the Ohbox, with the rule that admitted its sender. `provenance` defaults to the
   * inferred-admission seed (`seeded-from-sent`) because that IS the demotable shape. The three
   * populations the widened pass acts on:
   *  · default        → a seeded/promoted allow rule, NO contact — the `policy` class.
   *  · `noRule: true` → a bare CONTACT, no rule — the `header` class.
   *  · `stranger`     → NEITHER a rule NOR a contact (the legacy migration's blanket default admitted
   *                     it; `evaluateRules` answers `screener`) — kept: only a person lets a sender in.
   * `ruleDest` lets a `manual`/deny rule name a different destination; `sensitivityCategory`/`noAi`
   * flag the row so the sensitivity exclusion can be exercised.
   */
  async function seed(w: World, o: {
    from: string;
    subject?: string;
    headers?: Record<string, string[]>;
    provenance?: Provenance;
    ruleDest?: string;
    noRule?: boolean;
    stranger?: boolean;
    contact?: boolean;
    sensitivityCategory?: string;
    noAi?: boolean;
    lastSetBy?: "us" | "external" | "peer";
    threadId?: string | null;
    /** Who a message of ours was addressed to — what the ingest writes into `to_addresses`. */
    to?: string[];
    observed?: string;
    desired?: string;
  }): Promise<string> {
    const [m] = await db.insert(messages).values({
      accountId: w.accountId, mailboxId: w.mailboxId, bodyHash: "h", dedupKey: `tidy:${randomUUID()}`,
      subject: o.subject ?? "hello there",
      fromAddress: o.from,
      threadId: o.threadId ?? null,
      ...(o.to ? { toAddresses: o.to.map((address) => ({ address, name: "" })) } : {}),
      sensitivityCategory: o.sensitivityCategory ?? null,
      noAi: o.noAi ?? false,
      nativeLocator: { folder: o.observed ?? OHBOX, ref: `1:${Math.floor(Math.random() * 1e6)}` },
    }).returning();
    await db.insert(messageBodies).values({
      messageId: m!.id, accountId: m!.accountId, text: "", html: null, headers: o.headers ?? {},
    });
    await db.insert(folderState).values({
      messageId: m!.id, accountId: m!.accountId, desiredFolder: o.desired ?? OHBOX, observedFolder: o.observed ?? OHBOX,
      lastSetBy: o.lastSetBy ?? "us", reconcileStatus: "reconciled", conflict: false,
    });
    const wantRule = !o.noRule && !o.stranger;
    const wantContact = !o.stranger && (o.noRule === true || o.contact === true);
    if (wantContact) {
      await db.insert(contacts).values({ accountId: w.accountId, address: o.from }).onConflictDoNothing();
    }
    if (wantRule) {
      await db.insert(rules).values({
        accountId: w.accountId, kind: "sender", match: o.from,
        destination: o.ruleDest ?? OHBOX, priority: 0,
        provenance: o.provenance ?? "seeded-from-sent", enabled: true,
      });
    }
    return m!.id;
  }

  // A single List-Unsubscribe — passes the lenient `isBulkSend` (header class).
  const BULK = { "list-unsubscribe": ["<https://x.test/u>"] };
  // List-Unsubscribe AND a corroborating list/ESP marker: every bulk header a sender can write.
  const STRONG_BULK = { "list-unsubscribe": ["<https://x.test/u>"], "list-id": ["<news.shop.test>"] };
  // Feedback-ID with NO List-Unsubscribe — the Google-account/security-notice shape.
  const FEEDBACK_ONLY = { "feedback-id": ["1:2:3:campaign"] };

  const basisOf = async (accountId: string, messageId: string): Promise<string | undefined> => {
    const rows = await db.select().from(auditLog)
      .where(and(eq(auditLog.accountId, accountId), eq(auditLog.action, "ohbox_tidy_move")));
    const a = rows.find((r) => (r.payload as { messageId: string }).messageId === messageId);
    return a ? (a.payload as { basis?: string }).basis : undefined;
  };

  /**
   * Hold until the PASS is provably parked on a row lock, before the drag-back commits.
   *
   * Without this the two race cases below started the pass and committed immediately, so whichever
   * of the two orderings won the event loop decided the colour — and the ordering they exist to
   * measure (the pass waiting behind the USER) is the one that was usually NOT taken. Detection is
   * `wait_event_type = 'Lock'` and NOT the query text: `pg_stat_activity.query` is truncated at
   * `track_activity_query_size` (1 KB), and the candidate SELECT is longer than that, so its
   * trailing `for update of` never appears. The only other backend here is the reserved one, which
   * sits `idle in transaction`, so an active Lock wait is the pass.
   */
  const holdUntilPassIsParked = async (ms = 30_000): Promise<void> => {
    const deadline = Date.now() + ms;
    for (;;) {
      const [r] = await sql<{ n: number }[]>`
        select count(*)::int as n from pg_stat_activity
         where datname = current_database()
           and pid <> pg_backend_pid()
           and state = 'active'
           and wait_event_type = 'Lock'`;
      if ((r?.n ?? 0) > 0) return;
      if (Date.now() > deadline) throw new Error("the pass never parked on the folder_state row lock");
      await new Promise((res) => setTimeout(res, 25));
    }
  };

  const stateOf = async (id: string): Promise<{ desired: string; status: string; setBy: string }> => {
    const [r] = await db.select().from(folderState).where(eq(folderState.messageId, id)).limit(1);
    return { desired: r!.desiredFolder, status: r!.reconcileStatus, setBy: r!.lastSetBy };
  };
  const movesTo = async (accountId: string): Promise<Array<{ id: string; to: unknown }>> => {
    const rows = await db.select().from(changeLog)
      .where(and(eq(changeLog.accountId, accountId), eq(changeLog.op, "move")));
    return rows.map((r) => ({ id: r.entityId, to: (r.meta as { to?: unknown } | null)?.to }));
  };
  const tidyMarks = async (accountId: string) => {
    const r = await readPassProgress(db as unknown as Tx, accountPass("ohbox_tidy", accountId));
    return { done: r.doneAt, cursor: r.cursor };
  };

  // ══════════════════════════════════════════════════════════════════════════════════════════
  //  1. THE DEMONSTRATION — the Ohbox drops to the human + relevant residual, by relevance
  // ══════════════════════════════════════════════════════════════════════════════════════════

  it("demotes obvious bulk to the RIGHT pile and leaves people and relevant alerts in the Ohbox", async () => {
    const w = await newWorld();
    await arm(w);

    // MOVES — inferred-admission senders whose mail is obvious automated bulk.
    const newsletter = await seed(w, { from: "news@shop.test", headers: BULK });                    // → Reads
    const receipt = await seed(w, { from: "orders@shop.test", subject: "Your receipt", headers: BULK }); // → Receipts
    const promotedBulk = await seed(w, { from: "promo@brand.test", headers: BULK, provenance: "promoted" }); // → Reads

    // STAYS — a real person writing personally from a seeded sender.
    const human = await seed(w, { from: "anna@work.test", subject: "lunch friday?" });

    // STAYS — a relevant service alert: service-shaped sender, but NO bulk marker and NO money
    // subject, so the engine leaves it for the human and the bar to judge. This is the "buries mail I
    // need to see" failure the whole slice must avoid.
    const alert = await seed(w, { from: "noreply@bank.test", subject: "unusual sign-in to your account" });

    // STAYS — a rule the USER authored is exempt from the posture (both `manual` and `migrated`),
    // even when the mail is bulk. Writing one is how "keep in my Ohbox" ends the demotion for good.
    const manualKept = await seed(w, { from: "vip@brand.test", headers: BULK, provenance: "manual" });
    const migratedKept = await seed(w, { from: "imported@brand.test", headers: BULK, provenance: "migrated" });

    const r = await ohboxTidyPass(db, { trustedAuthservIdsFor: NONE, accountId: w.accountId });

    expect(r).toMatchObject({ ran: true, examined: 7, moved: 3, kept: 4, completed: true, capped: false });
    // NEVER anything but the two visible allow-side piles.
    expect(r.destinations).toEqual({ [READS]: 2, [RECEIPTS]: 1 });

    expect((await stateOf(newsletter)).desired).toBe(READS);
    expect((await stateOf(receipt)).desired).toBe(RECEIPTS);
    expect((await stateOf(promotedBulk)).desired).toBe(READS);
    // pending, not reconciled — this pass opened no IMAP; the reconciler owes the physical move.
    expect((await stateOf(newsletter)).status).toBe("pending");

    for (const id of [human, alert, manualKept, migratedKept]) {
      expect((await stateOf(id)).desired, `${id} was buried out of the Ohbox`).toBe(OHBOX);
    }

    // Every mover carries an undo naming the way back, and the overridden seeded rule.
    const audits = await db.select().from(auditLog)
      .where(and(eq(auditLog.accountId, w.accountId), eq(auditLog.action, "ohbox_tidy_move")));
    expect(audits).toHaveLength(3);
    const receiptAudit = audits.find((a) => (a.payload as { messageId: string }).messageId === receipt)!;
    expect(receiptAudit.inverse).toMatchObject({ messageId: receipt, from: RECEIPTS, to: OHBOX });
    expect((receiptAudit.payload as { overriddenRuleId: string | null }).overriddenRuleId).not.toBeNull();

    expect((await tidyMarks(w.accountId)).done).toBeInstanceOf(Date);
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════
  //  2. USER ALWAYS WINS — every intent that takes a message out of the candidate set
  // ══════════════════════════════════════════════════════════════════════════════════════════

  it("skips every message the user has placed, triaged, replied to, or ruled on", async () => {
    const w = await newWorld();
    await arm(w);

    // CONTROL — a demotable candidate with no intent, so a predicate that stopped working shows up
    // as this row staying while its neighbour also moves.
    const control = await seed(w, { from: "a@shop.test", headers: BULK });

    // 1 — filed in their OWN mail client (`last_set_by = 'external'`).
    const external = await seed(w, { from: "b@shop.test", headers: BULK, lastSetBy: "external" });

    // 1b — adopted by a READER: another install of this account placed it and this one watched
    // (`last_set_by = 'peer'`, `pipeline.ts#readerAdoption`). This pass runs UNBIDDEN, so admitting
    // `'peer'` would turn a promotion into a bulk re-filing of the other install's mail — the shape
    // the import hold refuses. `rule-retro` is the only pass that admits it, because a person has to
    // press for it. Otherwise identical to `control`, which is what makes this about the
    // attribution rather than about the fixture.
    const peer = await seed(w, { from: "b2@shop.test", headers: BULK, lastSetBy: "peer" });

    // 2 — dragged back INTO the Ohbox in-app. `folder_state` cannot express this (still 'us'); the
    // change-log move-to-INBOX row is the only record, and it is the guard.
    const draggedBack = await seed(w, { from: "c@shop.test", headers: BULK });
    await db.insert(changeLog).values({
      accountId: w.accountId, seq: 999_001n, entityType: "message", entityId: draggedBack,
      op: "move", meta: { from: READS, to: OHBOX },
    });

    // 3 — triaged onto a pile.
    const triaged = await seed(w, { from: "d@shop.test", headers: BULK });
    await db.insert(messageStates).values({ accountId: w.accountId, messageId: triaged, state: "reply_later" });

    // 4 — replying through ohmail.
    const replying = await seed(w, { from: "e@shop.test", headers: BULK });
    await db.insert(drafts).values({
      accountId: w.accountId, mailboxId: w.mailboxId, inReplyToMessageId: replying, subject: "Re:", body: "hi",
    });

    // 5 — decided on an AI proposal (`approved`, not a still-pending one WE proposed).
    const decided = await seed(w, { from: "f@shop.test", headers: BULK });
    await db.insert(approvals).values({
      accountId: w.accountId, kind: "routing", messageId: decided, action: "route", status: "approved",
    });

    // 6 — replied from their OWN client: a message in the same thread from the account's own
    // address, filed in Sent and addressed to the sender, as a reply is.
    const [th] = await db.insert(threads).values({ accountId: w.accountId, subject: "t" }).returning();
    const repliedExternally = await seed(w, { from: "g@shop.test", headers: BULK, threadId: th!.id });
    await seed(w, {
      from: w.address, threadId: th!.id, noRule: true, to: ["g@shop.test"], observed: "Sent", desired: "Sent",
    });

    const r = await ohboxTidyPass(db, { trustedAuthservIdsFor: NONE, accountId: w.accountId });

    // Only the control was EXAMINED — every intent is excluded in the SQL, so it never reaches the engine.
    expect(r).toMatchObject({ ran: true, examined: 1, moved: 1, kept: 0 });
    expect((await stateOf(control)).desired).toBe(READS);
    for (const id of [external, peer, draggedBack, triaged, replying, decided, repliedExternally]) {
      expect((await stateOf(id)).desired, `${id} was yanked out from under the user`).toBe(OHBOX);
    }
    // …and the attribution survives: nothing here may quietly promote a reader's row to ours.
    expect((await stateOf(peer)).setBy).toBe("peer");
    expect((await stateOf(external)).setBy).toBe("external");
  });

  it("a manual 'keep in my Ohbox' rule is exempt through the engine, not a candidate predicate", async () => {
    // The distinction matters: a manual rule is NOT excluded in SQL (the sender-rule predicate is
    // deliberately absent — it would exclude the seeded candidates this pass exists for), so the row
    // IS examined and `evaluateRules` is what keeps it, answering `source: "rule"`.
    const w = await newWorld();
    await arm(w);
    const kept = await seed(w, { from: "vip@brand.test", headers: BULK, provenance: "manual" });
    const r = await ohboxTidyPass(db, { trustedAuthservIdsFor: NONE, accountId: w.accountId });
    expect(r).toMatchObject({ examined: 1, moved: 0, kept: 1 });
    expect((await stateOf(kept)).desired).toBe(OHBOX);
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════
  //  2b. THE POPULATIONS — header (rule-less contact) moves; a stranger stays
  // ══════════════════════════════════════════════════════════════════════════════════════════

  it("header class: a rule-less CONTACT's bulk mail is filed to the engine's own pile (basis: header)", async () => {
    // A known contact with NO rule. The live router header-routes their bulk→Reads / money→Receipts
    // (`source: "header"`); the widened pass replays that placement over the backlog the legacy router
    // filed before that branch existed. Not a new consent judgment — the sender is already past the
    // gate. `basis: "header"`, `overriddenRuleId: null` (there is no rule to override).
    const w = await newWorld();
    await arm(w);
    const news = await seed(w, { from: "list@known.test", headers: BULK, noRule: true });
    const receipt = await seed(w, { from: "shop@known.test", subject: "Your receipt", headers: BULK, noRule: true });

    const r = await ohboxTidyPass(db, { trustedAuthservIdsFor: NONE, accountId: w.accountId });
    expect(r).toMatchObject({ examined: 2, moved: 2, kept: 0 });
    expect(r.destinations).toEqual({ [READS]: 1, [RECEIPTS]: 1 });
    expect(r.basis).toEqual({ header: 2 });

    expect((await stateOf(news)).desired).toBe(READS);
    expect((await stateOf(receipt)).desired).toBe(RECEIPTS);
    expect(await basisOf(w.accountId, news)).toBe("header");
    const audits = await db.select().from(auditLog)
      .where(and(eq(auditLog.accountId, w.accountId), eq(auditLog.action, "ohbox_tidy_move")));
    for (const a of audits) {
      expect((a.payload as { overriddenRuleId: string | null }).overriddenRuleId).toBeNull();
    }
  });

  it("header class STAYS: a real person, a noreply@ Feedback-ID alert, and manual/migrated rules", async () => {
    const w = await newWorld();
    await arm(w);
    // A real person: a contact, personal subject, no bulk markers ⇒ `source: "header"` returns null
    // (headerHeuristic finds nothing) → the engine answers `unclear`, and the pass keeps it.
    const person = await seed(w, { from: "anna@known.test", subject: "lunch?", noRule: true });
    // A noreply@ account/security notice: Feedback-ID but NO List-Unsubscribe. As a rule-less contact
    // it is `source: "header"`; headerHeuristic's isBulkSend does fire on Feedback-ID, BUT there is no
    // money subject and… see below — the safe way to keep this genuinely-relevant class is the strong
    // floor, which only governs the stranger population. Here, modelled as a contact, we assert the
    // real-person/manual/migrated STAYS; the Feedback-ID-only KEPT for a non-contact is the next test.
    const manual = await seed(w, { from: "vip@brand.test", headers: STRONG_BULK, provenance: "manual" });
    const migrated = await seed(w, { from: "imp@brand.test", headers: STRONG_BULK, provenance: "migrated" });

    const r = await ohboxTidyPass(db, { trustedAuthservIdsFor: NONE, accountId: w.accountId });
    expect(r).toMatchObject({ moved: 0, kept: 3 });
    for (const id of [person, manual, migrated]) {
      expect((await stateOf(id)).desired, `${id} was buried`).toBe(OHBOX);
    }
  });

  it("MUTATION-WATCH: a STRANGER (no rule, no contact) stays in the Ohbox whatever its headers; a contact's newsletter still moves", async () => {
    // Owner report 2026-11-02: every bulk header is the sender's to write, and cold outreach carries
    // them too, so no header lets a stranger into News or Receipts. Only a person lets a sender in.
    const w = await newWorld();
    await arm(w);
    const strong = await seed(w, { from: "news@nobody.test", headers: STRONG_BULK, stranger: true });
    const strongReceipt = await seed(w, {
      from: "billing@nobody.test", subject: "Your invoice", headers: STRONG_BULK, stranger: true,
    });
    const feedbackOnly = await seed(w, { from: "noreply@google.test", headers: FEEDBACK_ONLY, stranger: true });
    const unsubOnly = await seed(w, { from: "solo@nobody.test", headers: BULK, stranger: true });
    const bare = await seed(w, { from: "human@nobody.test", subject: "hi there", stranger: true });
    // CONTROL — the same headers from a person's contact: the router files it to News.
    const known = await seed(w, { from: "list@known.test", headers: STRONG_BULK, noRule: true });

    const r = await ohboxTidyPass(db, { trustedAuthservIdsFor: NONE, accountId: w.accountId });
    expect(r).toMatchObject({ examined: 6, moved: 1, kept: 5 });
    expect(r.basis).toEqual({ header: 1 });
    for (const id of [strong, strongReceipt, feedbackOnly, unsubOnly, bare]) {
      expect((await stateOf(id)).desired, `${id}: a stranger's letter left the Ohbox`).toBe(OHBOX);
    }
    expect((await stateOf(known)).desired).toBe(READS);
  });

  it("KEEPS a sensitivity-flagged POLICY and HEADER row — the live router's carve-out, every class", async () => {
    // THE REGRESSION. The sensitivity KEEP was bolted onto the `screener`/`migration_bulk` branch
    // only, so a flagged `policy` row (a seeded/promoted allow rule) or `header` row (a rule-less
    // contact) that ALSO carried a bulk header was demoted to Reads/Receipts — burying a verification
    // code / password reset / security alert the LIVE router (`pipeline.ts:563-567`) deliberately keeps
    // in the Ohbox. Both flagged rows must now STAY; the non-flagged controls of the SAME class must
    // still move, so a guard that stopped working shows as a control staying put beside its neighbour.
    //
    // MUTATION-WATCH: delete the `if (isSensitivityFlagged(c))` KEEP guard in `ohbox-tidy.ts` and both
    // `*Sensitive` rows demote to Reads — this goes red (`moved` becomes 4, the two rows leave OHBOX).
    const w = await newWorld();
    await arm(w);

    // POLICY class — a seeded-from-sent allow rule + strong bulk. Flagged (category) STAYS.
    const policySensitive = await seed(w, {
      from: "codes@brand.test", subject: "Your verification code",
      headers: STRONG_BULK, sensitivityCategory: "verification",
    });
    // POLICY control — same shape, NOT flagged → demotes to Reads (basis policy).
    const policyControl = await seed(w, { from: "news@brand.test", headers: STRONG_BULK });

    // HEADER class — a rule-less CONTACT + strong bulk, flagged by `no_ai` alone (category null). STAYS.
    const headerSensitive = await seed(w, {
      from: "security@known.test", subject: "unusual sign-in", headers: STRONG_BULK,
      noRule: true, noAi: true,
    });
    // HEADER control — same shape, NOT flagged → demotes to Reads (basis header).
    const headerControl = await seed(w, { from: "list@known.test", headers: STRONG_BULK, noRule: true });

    const r = await ohboxTidyPass(db, { trustedAuthservIdsFor: NONE, accountId: w.accountId });

    // Two flagged rows held back (one policy, one header), two controls moved to Reads.
    expect(r).toMatchObject({ examined: 4, moved: 2, kept: 2, sensitivityExcluded: 2 });
    expect(r.destinations).toEqual({ [READS]: 2 });
    expect(r.basis).toEqual({ policy: 1, header: 1 });

    expect((await stateOf(policySensitive)).desired, "a flagged policy row was buried").toBe(OHBOX);
    expect((await stateOf(headerSensitive)).desired, "a flagged header row was buried").toBe(OHBOX);
    // No over-correction: the non-sensitive movers of the same two classes still move.
    expect((await stateOf(policyControl)).desired).toBe(READS);
    expect((await stateOf(headerControl)).desired).toBe(READS);
  });

  it("skips a message in a DISABLED mailbox — a pending row there would never reconcile", async () => {
    const w = await newWorld();
    await arm(w);
    // A second mailbox Cloud no longer organizes (lease lost, or the user left). Nothing will ever
    // reconcile a `pending` folder_state written for it, so writing intent there is a permanent lie.
    const [dead] = await db.insert(mailboxes).values({
      accountId: w.accountId, provider: "imap",
      address: `dead-${randomUUID().slice(0, 8)}@example.test`, status: "disabled",
    }).returning();
    const [m] = await db.insert(messages).values({
      accountId: w.accountId, mailboxId: dead!.id, bodyHash: "h", dedupKey: `tidy:${randomUUID()}`,
      subject: "promo", fromAddress: "dead@shop.test", nativeLocator: { folder: OHBOX, ref: "1:1" },
    }).returning();
    await db.insert(messageBodies).values({ messageId: m!.id, accountId: m!.accountId, text: "", html: null, headers: BULK });
    await db.insert(folderState).values({
      messageId: m!.id, accountId: m!.accountId, desiredFolder: OHBOX, observedFolder: OHBOX,
      lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
    });
    await db.insert(rules).values({
      accountId: w.accountId, kind: "sender", match: "dead@shop.test",
      destination: OHBOX, priority: 0, provenance: "seeded-from-sent", enabled: true,
    });

    const r = await ohboxTidyPass(db, { trustedAuthservIdsFor: NONE, accountId: w.accountId });
    expect(r).toMatchObject({ examined: 0, moved: 0 });
    expect((await stateOf(m!.id)).desired).toBe(OHBOX);
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════
  //  3. RUN ONLY WHEN OWED — the opt-in, and lenient does nothing
  // ══════════════════════════════════════════════════════════════════════════════════════════

  it("does nothing for a lenient account, and nothing for a people_only account never armed", async () => {
    const lenient = await newWorld();
    await arm(lenient, { policy: "people_and_replied" });
    const m1 = await seed(lenient, { from: "n@shop.test", headers: BULK });
    expect(await ohboxTidyPass(db, { trustedAuthservIdsFor: NONE, accountId: lenient.accountId })).toMatchObject({ ran: false, moved: 0 });
    expect((await stateOf(m1)).desired).toBe(OHBOX);

    const unarmed = await newWorld();
    await arm(unarmed, { requested: null });   // people_only, but requested_at NULL ⇒ not owed
    const m2 = await seed(unarmed, { from: "n@shop.test", headers: BULK });
    expect(await ohboxTidyPass(db, { trustedAuthservIdsFor: NONE, accountId: unarmed.accountId })).toMatchObject({ ran: false, moved: 0 });
    expect((await stateOf(m2)).desired).toBe(OHBOX);

    // An account with NO settings row at all is also a no-op.
    const bare = await newWorld();
    await seed(bare, { from: "n@shop.test", headers: BULK });
    expect(await ohboxTidyPass(db, { trustedAuthservIdsFor: NONE, accountId: bare.accountId })).toMatchObject({ ran: false });
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════
  //  4. IDEMPOTENT, RESUMABLE, AND THE MARKER IS WRITTEN LAST
  // ══════════════════════════════════════════════════════════════════════════════════════════

  it("a second run moves nothing — with the marker, and again with it forced", async () => {
    const w = await newWorld();
    await arm(w);
    for (let i = 0; i < 5; i++) await seed(w, { from: `s${i}@shop.test`, headers: BULK });

    const first = await ohboxTidyPass(db, { trustedAuthservIdsFor: NONE, accountId: w.accountId });
    expect(first).toMatchObject({ ran: true, moved: 5, completed: true });
    expect(await movesTo(w.accountId)).toHaveLength(5);

    // The marker short-circuits: not owed any more.
    expect(await ohboxTidyPass(db, { trustedAuthservIdsFor: NONE, accountId: w.accountId })).toMatchObject({ ran: false, moved: 0 });

    // …and with the marker IGNORED, the pass STILL writes nothing — the idempotency is the candidate
    // query (a demoted row is desired into Reads and drops out), not the flag.
    const forced = await ohboxTidyPass(db, { trustedAuthservIdsFor: NONE, accountId: w.accountId, force: true });
    expect(forced).toMatchObject({ ran: true, examined: 0, moved: 0 });
    expect(await movesTo(w.accountId)).toHaveLength(5);
  });

  it("a capped run leaves the marker NULL, persists the cursor, and the next run resumes and stamps it", async () => {
    const w = await newWorld();
    await arm(w);
    for (let i = 0; i < 6; i++) await seed(w, { from: `t${i}@shop.test`, headers: BULK });

    // A tiny per-cycle budget is the crash/backpressure shape.
    const partial = await ohboxTidyPass(db, { trustedAuthservIdsFor: NONE, accountId: w.accountId, writesPerCycle: 2 });
    expect(partial).toMatchObject({ ran: true, moved: 2, capped: true, completed: false });
    const mid = await tidyMarks(w.accountId);
    expect(mid.done, "marked done with four still in the Ohbox").toBeNull();
    expect(mid.cursor, "no resume point persisted").not.toBeNull();

    const rest = await ohboxTidyPass(db, { trustedAuthservIdsFor: NONE, accountId: w.accountId, writesPerCycle: 100 });
    expect(rest).toMatchObject({ ran: true, moved: 4, completed: true });
    expect(await movesTo(w.accountId)).toHaveLength(6);
    expect((await tidyMarks(w.accountId)).done).toBeInstanceOf(Date);
  });

  it("re-arming a completed account (the 'tidy now' shape) re-owes and re-runs the backlog", async () => {
    const w = await newWorld();
    await arm(w);
    await seed(w, { from: "z@shop.test", headers: BULK });      // demotable → Reads on run 1
    await seed(w, { from: "h@work.test", subject: "hi" });      // a person, stays in the Ohbox
    expect(await ohboxTidyPass(db, { trustedAuthservIdsFor: NONE, accountId: w.accountId }))
      .toMatchObject({ examined: 2, moved: 1, kept: 1, completed: true });

    // With `done_at` stamped, the account is NOT owed…
    expect(await ohboxTidyPass(db, { trustedAuthservIdsFor: NONE, accountId: w.accountId })).toMatchObject({ ran: false });

    // …until a fresh request past `done_at` re-arms it (what requestOhboxTidy / a re-flip does).
    await requestPass(db as unknown as Tx, accountPass("ohbox_tidy", w.accountId), new Date(Date.now() + 1000));
    const again = await ohboxTidyPass(db, { trustedAuthservIdsFor: NONE, accountId: w.accountId });
    // Owed again and RE-EXAMINES: the demoted row is in Reads and drops out, the person is examined
    // and kept, and nothing moves twice.
    expect(again).toMatchObject({ ran: true, examined: 1, moved: 0, kept: 1, completed: true });
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════
  //  5. THE DRY-RUN PLAN — the counts the user authorizes, with ZERO writes and NO inflation
  // ══════════════════════════════════════════════════════════════════════════════════════════

  it("a dry run reports the counts, writes NOTHING, and never marks done", async () => {
    const w = await newWorld();
    // NOT armed and NOT people_only — a plan answers "what WOULD move" via assumePolicy, without any
    // opt-in and without flipping the posture that would start the live worker.
    const bulk = await seed(w, { from: "p@shop.test", headers: BULK });
    const human = await seed(w, { from: "person@work.test", subject: "hi" });

    const [{ max: before }] = await sql`select coalesce(max(seq),0)::text as max from change_log where account_id = ${w.accountId}`;

    const plan = await ohboxTidyPass(db, { trustedAuthservIdsFor: NONE, accountId: w.accountId, dryRun: true, assumePolicy: "people_only" });
    expect(plan).toMatchObject({ ran: true, examined: 2, moved: 1, kept: 1, completed: false });
    expect(plan.destinations).toEqual({ [READS]: 1 });

    // ZERO writes: folder state untouched, no move rows, no audit rows, no marker, seq unmoved.
    expect((await stateOf(bulk)).desired).toBe(OHBOX);
    expect((await stateOf(human)).desired).toBe(OHBOX);
    expect(await movesTo(w.accountId)).toHaveLength(0);
    const audits = await db.select().from(auditLog).where(eq(auditLog.accountId, w.accountId));
    expect(audits).toHaveLength(0);
    const [{ max: after }] = await sql`select coalesce(max(seq),0)::text as max from change_log where account_id = ${w.accountId}`;
    expect(after).toBe(before);
  });

  it("assumePolicy is refused without dryRun — the dangerous combination is unrepresentable", async () => {
    const w = await newWorld();
    await expect(ohboxTidyPass(db, { trustedAuthservIdsFor: NONE, accountId: w.accountId, assumePolicy: "people_only" }))
      .rejects.toThrow(/assumePolicy is only legal with dryRun/);
  });

  it("a dry run over several pages examines each id exactly once — no cursor-reread inflation", async () => {
    // The bug this pins: a pass that re-reads its cursor from the row each page re-reads page 1
    // forever under rollback, and hands the user a 500× count. `afterId` is JS state; the plan must
    // walk the backlog ONCE.
    const w = await newWorld();
    const n = 25;
    for (let i = 0; i < n; i++) await seed(w, { from: `d${i}@shop.test`, headers: BULK });
    const plan = await ohboxTidyPass(db, {
      accountId: w.accountId, trustedAuthservIdsFor: NONE, dryRun: true, assumePolicy: "people_only", batch: 10,
    });
    expect(plan).toMatchObject({ ran: true, examined: n, moved: n });
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════
  //  6. THE RACES PGLITE STRUCTURALLY CANNOT HOST
  // ══════════════════════════════════════════════════════════════════════════════════════════

  it("two concurrent passes produce ONE move per message and a gap-free seq", async () => {
    const w = await newWorld();
    await arm(w);
    const ids: string[] = [];
    for (let i = 0; i < 120; i++) ids.push(await seed(w, { from: `c${i}@shop.test`, headers: BULK }));

    const [a, b] = await Promise.all([
      ohboxTidyPass(db, { trustedAuthservIdsFor: NONE, accountId: w.accountId }),
      ohboxTidyPass(db, { trustedAuthservIdsFor: NONE, accountId: w.accountId }),
    ]);
    expect(a.moved + b.moved).toBe(120);

    const moves = await movesTo(w.accountId);
    expect(moves).toHaveLength(120);
    expect(new Set(moves.map((m) => m.id)).size).toBe(120);
    for (const m of moves) expect(m.to).toBe(READS);

    // Gap-free, strictly increasing per-account seq under two writers.
    const all = await db.select().from(changeLog)
      .where(eq(changeLog.accountId, w.accountId)).orderBy(asc(changeLog.seq));
    const seqs = all.map((r) => Number(r.seq));
    expect(new Set(seqs).size).toBe(seqs.length);
    for (let i = 1; i < seqs.length; i++) expect(seqs[i]! - seqs[i - 1]!).toBe(1);
  }, 60_000);

  it("a user drag back into the Ohbox that commits WHILE the pass pages leaves the message in the Ohbox", async () => {
    // The race the ruling names. A raw connection holds the message's `folder_state` lock (standing
    // in for the pass mid-page), commits an in-app drag-back — the desired='INBOX' write plus the
    // move-to-INBOX change row — and only then releases. The real pass, blocked on
    // `FOR UPDATE OF folder_state`, wakes against the committed row and must NOT demote it: the user's
    // placement is the last word, and the move-to-INBOX guard now excludes the row.
    const w = await newWorld();
    await arm(w);
    const m = await seed(w, { from: "race@shop.test", headers: BULK });

    const held = await sql.reserve();
    try {
      await held`begin`;
      await held`select 1 from folder_state where message_id = ${m}::uuid for update`;

      // The pass starts in parallel and blocks on the row lock the held connection owns.
      const passPromise = ohboxTidyPass(db, { trustedAuthservIdsFor: NONE, accountId: w.accountId });

      // The pass must be PARKED on the lock before the drag commits, or this measures the other
      // ordering (the drag visible to the SELECT), which the case above it already covers.
      await holdUntilPassIsParked();

      // The user's in-app drag back into the Ohbox, committed under the held lock.
      await held`update folder_state set desired_folder = 'INBOX', last_set_by = 'us' where message_id = ${m}::uuid`;
      await held`insert into change_log (account_id, seq, entity_type, entity_id, op, meta)
                 values (${w.accountId}::uuid, 990100, 'message', ${m}::uuid, 'move', ${JSON.stringify({ from: READS, to: OHBOX })}::jsonb)`;
      await held`commit`;

      const r = await passPromise;
      expect(r.moved, "the pass demoted a message the user had just moved back").toBe(0);
    } finally {
      await held.release();
    }

    expect((await stateOf(m)).desired).toBe(OHBOX);
  }, 60_000);

  // ══════════════════════════════════════════════════════════════════════════════════════════
  //  7. SCOPE
  // ══════════════════════════════════════════════════════════════════════════════════════════

  it("touches no other account", async () => {
    const mine = await newWorld();
    const theirs = await newWorld();
    await arm(mine);
    await arm(theirs);   // also owed, but this pass is scoped to `mine`
    const target = await seed(mine, { from: "x@shop.test", headers: BULK });
    const bystander = await seed(theirs, { from: "x@shop.test", headers: BULK });

    await ohboxTidyPass(db, { trustedAuthservIdsFor: NONE, accountId: mine.accountId });

    expect((await stateOf(target)).desired).toBe(READS);
    expect((await stateOf(bystander)).desired).toBe(OHBOX);
    expect(await movesTo(theirs.accountId)).toEqual([]);
    expect((await tidyMarks(theirs.accountId)).done).toBeNull();
  });
});
