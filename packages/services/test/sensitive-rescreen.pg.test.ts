
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
import { accounts, approvals, auditLog, changeLog, contacts, drafts, folderState, mailboxes, messageBodies, messageStates, messages, passProgress, rules, threads } from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import { runSensitiveRescreen } from "../src/sensitive-rescreen.js";
import type { Db } from "../src/context.js";

/**
 * THE RE-SCREEN PASS, AGAINST REAL POSTGRES.
 *
 * ── WHY THIS FILE IS `.pg.test.ts` AND PGLITE DOES NOT COUNT ───────────────────────────────
 *
 * This pass rewrites FOLDER MEMBERSHIP for many messages while the worker's reconciler is
 * reading and writing the same `folder_state` rows. Three properties depend on the real planner
 * and the real driver and are green-by-construction under PGlite, which is single-connection:
 *
 *  · `SELECT … FOR UPDATE OF folder_state` — a no-op that always succeeds under PGlite, so every
 *    "moved once, not twice" claim would pass without being tested. Three production bugs in this
 *    repository were invisible to PGlite and appeared only on :5433, all of this class.
 *  · `allocateSeq`'s gap-free per-account sequence under two writers. This pass is the second
 *    writer in the repo to hold a `folder_state` lock BEFORE taking the seq lock, which is exactly
 *    how a lock-order deadlock is introduced.
 *  · The candidate query's five `NOT EXISTS` arms against real statistics. A predicate that is
 *    accidentally always-true reads identically in either engine; only the counts distinguish it,
 *    and the counts here are asserted per predicate.
 */

const AVAILABLE = await realPgAvailable();
const OHBOX = "INBOX";
const SCREENER = "ohmail/Screener";

interface World { accountId: string; mailboxId: string; address: string }

describe.skipIf(!AVAILABLE)("the sensitive re-screen pass", () => {
  let db: Db;
  let sql: ReturnType<typeof postgres>;

  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    // Four connections minimum, or the "concurrent" transactions queue in the POOL and the
    // concurrency case proves nothing about the database.
    sql = postgres(PG_TEST_URL, { max: 4, onnotice: () => {} });
    db = brandDialect(drizzle(sql, { schema }), "pg") as unknown as Db;
  }, 120_000);

  async function newWorld(): Promise<World> {
    const accountId = randomUUID();
    await db.insert(accounts).values({ id: accountId, name: `w1-${accountId.slice(0, 8)}` });
    const [mb] = await db.insert(mailboxes).values({
      accountId, provider: "imap", address: `w1-${accountId.slice(0, 8)}@example.test`,
    }).returning();
    return { accountId, mailboxId: mb!.id, address: mb!.address };
  }

  /**
   * One message in the Ohbox. `sensitivity` defaults to `otp` because that is the shape of the
   * damage; `null` is how a row that reached the Ohbox on its own merits is expressed.
   */
  async function seedOhbox(w: World, o: {
    from: string;
    subject?: string;
    sensitivity?: string | null;
    headers?: Record<string, string[]>;
    lastSetBy?: "us" | "external";
    threadId?: string | null;
    /** Who a message of ours was addressed to — what the ingest writes into `to_addresses`. */
    to?: string[];
    observed?: string;
    /**
     * An EXPLICIT `messages.id`, so a test can choose the walk's order.
     *
     * The candidate walk is `order by messages.id asc` and the id is a random UUID, so the
     * default seeding produces an order no test can predict. Every cursor claim below is about
     * WHICH rows a page covered, which is unsayable without this — see {@link sortedIds}.
     */
    id?: string;
  }): Promise<string> {
    const [m] = await db.insert(messages).values({
      ...(o.id ? { id: o.id } : {}),
      accountId: w.accountId, mailboxId: w.mailboxId, bodyHash: "h", dedupKey: `w1:${randomUUID()}`,
      subject: o.subject ?? "Your verification code",
      fromAddress: o.from,
      sensitivityCategory: o.sensitivity === undefined ? "otp" : o.sensitivity,
      threadId: o.threadId ?? null,
      ...(o.to ? { toAddresses: o.to.map((address) => ({ address, name: "" })) } : {}),
      nativeLocator: { folder: OHBOX, ref: `1:${Math.floor(Math.random() * 100000)}` },
    }).returning();
    await db.insert(messageBodies).values({
      messageId: m!.id, accountId: m!.accountId, text: "", html: null, headers: o.headers ?? {},
    });
    // STAMPED A MINUTE BEFORE THE SEED, never the column's `now()`: a seed is mail that was in the
    // Ohbox BEFORE any walk began. Left to the default, a walk starting in the seed's own
    // millisecond reads the seed as written inside the walk and withholds its marker, which is the
    // product's right answer to a real write and was this file red one alone run in twelve.
    await db.insert(folderState).values({
      messageId: m!.id, accountId: m!.accountId, desiredFolder: OHBOX, observedFolder: o.observed ?? OHBOX,
      lastSetBy: o.lastSetBy ?? "us", reconcileStatus: "reconciled", conflict: false,
      updatedAt: new Date(Date.now() - 60_000),
    });
    return m!.id;
  }

  const desiredOf = async (id: string): Promise<{ desired: string; status: string; setBy: string }> => {
    const [r] = await db.select().from(folderState).where(eq(folderState.messageId, id)).limit(1);
    return { desired: r!.desiredFolder, status: r!.reconcileStatus, setBy: r!.lastSetBy };
  };
  /** `n` fresh uuids in the ASCENDING order Postgres compares them in — the walk's own order. */
  const sortedIds = (n: number): string[] =>
    Array.from({ length: n }, () => randomUUID()).sort();

  /** Where the pass stands for the mailbox, read as one; no row reads as every mark empty. */
  const marksOf = async (mailboxId: string): Promise<{ at: Date | null; cursor: string | null; started: Date | null }> => {
    const [r] = await db.select({ at: passProgress.doneAt, cursor: passProgress.cursor, started: passProgress.startedAt })
      .from(passProgress).where(and(eq(passProgress.job, "sensitive_rescreen"), eq(passProgress.subjectId, mailboxId))).limit(1);
    return r ?? { at: null, cursor: null, started: null };
  };
  const passStateOf = async (mailboxId: string): Promise<{ at: Date | null; cursor: string | null }> => {
    const { at, cursor } = await marksOf(mailboxId);
    return { at, cursor };
  };
  /** The walk epoch — NULL exactly when the cursor is. */
  const walkStartOf = async (mailboxId: string): Promise<Date | null> => (await marksOf(mailboxId)).started;

  const movesFor = async (accountId: string): Promise<string[]> => {
    const rows = await db.select().from(changeLog)
      .where(and(eq(changeLog.accountId, accountId), eq(changeLog.op, "move")));
    return rows.map((r) => r.entityId);
  };

  // ══════════════════════════════════════════════════════════════════════════════════════════
  //  1. IT RE-EVALUATES. IT DOES NOT INVERT.
  // ══════════════════════════════════════════════════════════════════════════════════════════

  it("moves the gate's own answer, and leaves every other answer exactly where it is", async () => {
    const w = await newWorld();

    // (a) the damage: sensitive, sender unknown ⇒ `evaluateRules` answers `screener`.
    const stranger = await seedOhbox(w, { from: "noreply@stranger.test" });

    // (b) A KNOWN SENDER'S CODE STAYS IN THE OHBOX. This is the case an "invert the sensitivity
    // rule" implementation gets wrong, and it is the behaviour an earlier change deliberately preserved.
    await db.insert(contacts).values({ accountId: w.accountId, address: "anna@work.example" });
    const knownCode = await seedOhbox(w, { from: "anna@work.example" });

    // (c) the user's own rule ⇒ source `rule`, not `screener`. Their decision outranks us.
    //
    // A HEADER rule, deliberately, and the first draft of this case used a sender rule and proved
    // less than it looked. The candidate query already excludes any sender or domain carrying an
    // enabled rule, so a sender rule never reaches `evaluateRules` at all — the row is filtered in
    // SQL (that path is `ruledOn` in the exclusions case below). `kind = 'header'` names no
    // principal, so it is NOT covered by that predicate: it is the one rule shape that travels all
    // the way into the evaluator, and it is therefore the only one that exercises the
    // `decision.source !== "screener"` arm for a rule.
    await db.insert(rules).values({
      accountId: w.accountId, kind: "header", match: "x-mailer-tag",
      destination: OHBOX, priority: 10, provenance: "manual", enabled: true,
    });
    const ruled = await seedOhbox(w, {
      from: "bank@allowed.test", headers: { "x-mailer-tag": ["keep"] },
    });

    // (d) a KNOWN sender whose mail trips the header heuristic ⇒ source `header`. A heuristic may
    // refine where NEW mail lands; it may not relocate mail that is already filed.
    await db.insert(contacts).values({ accountId: w.accountId, address: "news@known.test" });
    const headerAnswer = await seedOhbox(w, {
      from: "news@known.test", headers: { "list-unsubscribe": ["<mailto:u@known.test>"] },
    });

    // (e) NOT SENSITIVE. This row reached the Ohbox on its own merits and the bypass never
    // touched it, so it is not in the candidate set at all — the pass is bounded to the damage.
    const ordinary = await seedOhbox(w, { from: "someone@elsewhere.test", sensitivity: null });

    const r = await runSensitiveRescreen({ db, trustedAuthservIdsFor: NONE, mailboxId: w.mailboxId });

    expect(r).toMatchObject({ ran: true, examined: 4, rescreened: 1, kept: 3, truncated: false });
    expect((await desiredOf(stranger)).desired).toBe(SCREENER);
    // `pending`, not `reconciled` — this pass opened no IMAP, so the move is still owed and the
    // worker's reconciler is what picks it up. A `reconciled` row here would be a claim of
    // convergence that never happened.
    expect((await desiredOf(stranger)).status).toBe("pending");
    expect((await desiredOf(knownCode)).desired).toBe(OHBOX);
    expect((await desiredOf(ruled)).desired).toBe(OHBOX);
    expect((await desiredOf(headerAnswer)).desired).toBe(OHBOX);
    expect((await desiredOf(ordinary)).desired).toBe(OHBOX);

    // ONE `move` change, for the one message that moved.
    expect(await movesFor(w.accountId)).toEqual([stranger]);

    // …and the user's undo record names the way back.
    const audits = await db.select().from(auditLog)
      .where(and(eq(auditLog.accountId, w.accountId), eq(auditLog.action, "sensitive_rescreen_move")));
    expect(audits).toHaveLength(1);
    expect(audits[0]!.inverse).toMatchObject({ messageId: stranger, from: SCREENER, to: OHBOX });
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════
  //  2. MAIL THE USER HAS ACTED ON IS NOT OURS TO MOVE
  // ══════════════════════════════════════════════════════════════════════════════════════════

  it("excludes every message the user expressed an intent about — one predicate at a time", async () => {
    const w = await newWorld();

    // The CONTROL. Identical to every row below except for the intent, so a predicate that
    // stopped working is visible as this row still moving while its neighbour also moves.
    const control = await seedOhbox(w, { from: "a@stranger.test" });

    // 1 — they filed it themselves, in their own mail client.
    const movedByUser = await seedOhbox(w, { from: "b@stranger.test", lastSetBy: "external" });

    // 2 — they ruled on the sender (a Screener "no" writes exactly this row).
    await db.insert(rules).values({
      accountId: w.accountId, kind: "sender", match: "c@stranger.test",
      destination: "ohmail/Screened", priority: 0, provenance: "promoted", enabled: true,
    });
    const ruledOn = await seedOhbox(w, { from: "c@stranger.test" });

    // 3 — they triaged it onto a pile.
    const triaged = await seedOhbox(w, { from: "d@stranger.test" });
    await db.insert(messageStates).values({
      accountId: w.accountId, messageId: triaged, state: "reply_later",
    });

    // 4 — they are replying to it through ohmail.
    const replying = await seedOhbox(w, { from: "e@stranger.test" });
    await db.insert(drafts).values({
      accountId: w.accountId, mailboxId: w.mailboxId, inReplyToMessageId: replying,
      subject: "Re:", body: "on it",
    });

    // 5 — they decided on an AI proposal about it. `approved`, not `pending`: a pending approval
    // is something WE proposed and they have not answered.
    const decided = await seedOhbox(w, { from: "f@stranger.test" });
    await db.insert(approvals).values({
      accountId: w.accountId, kind: "routing", messageId: decided, action: "route",
      status: "approved",
    });

    // 6 — they replied from their OWN mail client. No draft of ours exists; the evidence is a
    // message in the same thread sent from one of the account's own addresses TO this sender —
    // the engagement question the re-screen asks now, which a reply naming nobody does not meet.
    const [th] = await db.insert(threads).values({ accountId: w.accountId, subject: "t" }).returning();
    const repliedExternally = await seedOhbox(w, { from: "g@stranger.test", threadId: th!.id });
    await seedOhbox(w, { from: w.address, threadId: th!.id, sensitivity: null, to: ["g@stranger.test"] });

    const r = await runSensitiveRescreen({ db, trustedAuthservIdsFor: NONE, mailboxId: w.mailboxId });

    // Only the control was examined at all — every other candidate is excluded IN THE SQL, so it
    // never reaches `evaluateRules` and never costs a page.
    expect(r).toMatchObject({ ran: true, examined: 1, rescreened: 1, kept: 0 });
    expect((await desiredOf(control)).desired).toBe(SCREENER);
    for (const id of [movedByUser, ruledOn, triaged, replying, decided, repliedExternally]) {
      expect((await desiredOf(id)).desired, `${id} was yanked out from under the user`).toBe(OHBOX);
    }
    expect(await movesFor(w.accountId)).toEqual([control]);
  });

  it("a NARROWED sender rule reaches the evaluator, which keeps the whole sender", async () => {
    // with its invariant RE-DERIVED after
    // `fix-018-ruled-senders-applied-after` (2026-09-12) and its watched mutation unchanged.
    //
    // THE INVARIANT THIS GUARD HOLDS, and the only one it ever held: **the SQL must not decide on
    // the user's behalf.** The exclusion above matched on `kind`/`match` alone, which was right
    // while a sender rule meant *all mail from this sender*; `subject_contains` / `body_contains`
    // (mail 0050, 0052) made a rule a CONJUNCTION, and the old predicate removed every OTHER
    // message from that sender from the candidate set in SQL, before `evaluateRules` could look
    // at it — the completion marker then certifying the mailbox as corrected over it, permanently.
    // `examined: 3` is that invariant, and the mutation named below is still what breaks it.
    //
    // WHAT MOVED IS THE EVALUATOR'S ANSWER, by a ruling this guard is not the place to relitigate.
    // A narrowed rule is a decision about the SENDER — the reading `consentIndex` and the consent
    // cutline's `decided` predicate have always taken ("terms narrow placement, never admission")
    // — so `rules.ts#standingRule` admits that sender at the gate and their other mail answers
    // `header`/`unclear`. This pass's own rule then keeps it, in its own words: those are "answers
    // about a sender already PAST the gate, and neither is evidence that this message was
    // misrouted — the defect being corrected is a stranger in the Ohbox". Somebody the account
    // wrote a rule about is not a stranger, and moving their mail to the Screener was itself the
    // double state that fix closed: decided on every consent surface, behind a waiting row here.
    const w = await newWorld();
    await db.insert(rules).values({
      accountId: w.accountId, kind: "sender", match: "billing@stranger.test",
      destination: "ohmail/News", priority: 0, provenance: "manual", enabled: true,
      subjectContains: "invoice",
    });

    // The message the rule IS about. Untouched, and by the evaluator rather than by the SQL: the
    // rule fires, `evaluateRules` answers `source: "rule"`, and this pass acts only on `screener`.
    const matchesTheTerm = await seedOhbox(w, {
      from: "billing@stranger.test", subject: "Your invoice for July",
    });
    // The message the rule's TERM is not about — a verification code from the same address. The
    // rule does not fire, so it reaches the evaluator on the standing-decision arm, and is kept.
    const missesTheTerm = await seedOhbox(w, {
      from: "billing@stranger.test", subject: "Your verification code",
    });
    // The domain form of the same defect, which the predicate's second arm carries.
    await db.insert(rules).values({
      accountId: w.accountId, kind: "domain", match: "narrow.test",
      destination: "ohmail/News", priority: 0, provenance: "manual", enabled: true,
      bodyContains: "receipt",
    });
    const domainMissesTheTerm = await seedOhbox(w, { from: "anyone@narrow.test" });
    // THE CONTROL THAT KEEPS THE COUNTS HONEST. With the three ruled rows now all kept, every
    // assertion below would also hold for a pass that had stopped working entirely. This stranger
    // carries no rule of any kind and must still be moved, in the same run, from the same fixture.
    const realStranger = await seedOhbox(w, { from: "nobody@elsewhere.test" });

    const r = await runSensitiveRescreen({ db, trustedAuthservIdsFor: NONE, mailboxId: w.mailboxId });

    // The three ruled rows are CANDIDATES — the SQL no longer decides on the user's behalf — and
    // the evaluator sorts them. MUTATION WATCHED 2026-09-01: revert the predicate to `kind`/`match`
    // alone and the ruled rows drop out of `examined` entirely — not "the wrong two moved", but
    // the pass never looking at them, which is what makes the defect invisible from every count it
    // reports. The stranger is the fourth candidate and the one that still moves.
    expect(r).toMatchObject({ ran: true, examined: 4, rescreened: 1, kept: 3 });
    expect(
      (await desiredOf(missesTheTerm)).desired,
      "the account has a rule about this sender, so this pass is not entitled to re-screen them",
    ).toBe(OHBOX);
    expect((await desiredOf(domainMissesTheTerm)).desired).toBe(OHBOX);
    expect(
      (await desiredOf(matchesTheTerm)).desired,
      "the rule fires for this one, so the evaluator keeps it — the SQL must not be what decided",
    ).toBe(OHBOX);
    // …and the pass is still doing its job for somebody nobody decided about.
    expect((await desiredOf(realStranger)).desired).toBe(SCREENER);
    expect(await movesFor(w.accountId)).toEqual([realStranger]);
  });

  it("a BARE sender rule still excludes the whole sender, in SQL, at no evaluation cost", async () => {
    // The other half, and it must stay green or the fix would have turned a cost saving into a
    // per-message evaluation for every ruled-on sender in the mailbox. `examined: 0` is the
    // assertion: the row never reached the evaluator at all.
    const w = await newWorld();
    await db.insert(rules).values({
      accountId: w.accountId, kind: "sender", match: "bare@stranger.test",
      destination: "ohmail/Screened", priority: 0, provenance: "promoted", enabled: true,
    });
    const ruledOn = await seedOhbox(w, { from: "bare@stranger.test" });

    const r = await runSensitiveRescreen({ db, trustedAuthservIdsFor: NONE, mailboxId: w.mailboxId });

    expect(r).toMatchObject({ ran: true, examined: 0, rescreened: 0 });
    expect((await desiredOf(ruledOn)).desired).toBe(OHBOX);
  });

  it("a message being READ is not an intent to keep it — an Ohbox can be full of read spam", async () => {
    // Stated as its own case because it is a DECISION, not an omission: some of the production
    // candidates are read, and the reported defect is precisely that the Ohbox holds read
    // spam. Excluding read mail would leave behind the mail this pass was commissioned to move.
    const w = await newWorld();
    const readSpam = await seedOhbox(w, { from: "h@stranger.test" });
    await db.update(messages).set({ unread: false }).where(eq(messages.id, readSpam));

    await runSensitiveRescreen({ db, trustedAuthservIdsFor: NONE, mailboxId: w.mailboxId });
    expect((await desiredOf(readSpam)).desired).toBe(SCREENER);
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════
  //  3. IDEMPOTENT, AND THE MARKER IS WRITTEN LAST
  // ══════════════════════════════════════════════════════════════════════════════════════════

  it("a second run applies zero — with the marker, and again with the marker ignored", async () => {
    const w = await newWorld();
    const ids = [];
    for (let i = 0; i < 5; i++) ids.push(await seedOhbox(w, { from: `s${i}@stranger.test` }));

    const first = await runSensitiveRescreen({ db, trustedAuthservIdsFor: NONE, mailboxId: w.mailboxId });
    expect(first).toMatchObject({ ran: true, examined: 5, rescreened: 5, truncated: false });
    const afterFirst = await movesFor(w.accountId);
    expect(afterFirst).toHaveLength(5);

    // (a) the marker short-circuits: nothing is read, examined or written.
    const second = await runSensitiveRescreen({ db, trustedAuthservIdsFor: NONE, mailboxId: w.mailboxId });
    expect(second).toEqual({
      ran: false, examined: 0, rescreened: 0, kept: 0, truncated: false, destinations: {},
      resumedFrom: null, stoppedBecause: null,
    });

    // (b) …and with the marker deliberately IGNORED, the pass STILL makes no MOVE — no folder
    // intent, no `move` change, no per-message audit row. Not "writes nothing": a completed run
    // records its own completion row like any other, and that is not what the claim is about. This is the
    // claim that matters, because the marker is stamped last and a crash re-runs the pass: the
    // idempotency has to come from the candidate query, not from the flag.
    const forced = await runSensitiveRescreen({ db, trustedAuthservIdsFor: NONE, mailboxId: w.mailboxId, force: true });
    expect(forced).toMatchObject({ ran: true, examined: 0, rescreened: 0 });
    expect(await movesFor(w.accountId)).toEqual(afterFirst);
  });

  it("a run that does not finish leaves the marker NULL — and finishing takes a second run", async () => {
    // NAMED FOR WHAT IT PROVES. It used to say "the next run resumes", and it does not test that:
    // every row here MOVES, so a moved row leaves the candidate query and a run restarting from
    // the top skips the finished work by accident. The durable resume point is what the stayer
    // cases below prove, because a stayer never leaves the candidate set. What this case does
    // prove — and it is the crash policy — is that a truncated run declines the marker.
    const w = await newWorld();
    for (let i = 0; i < 6; i++) await seedOhbox(w, { from: `t${i}@stranger.test` });

    // Two rows a page, one page — the crash-mid-pass shape, expressed as a budget.
    const partial = await runSensitiveRescreen({ db, trustedAuthservIdsFor: NONE, mailboxId: w.mailboxId, batch: 2, maxPages: 1 });
    expect(partial).toMatchObject({ ran: true, examined: 2, rescreened: 2, truncated: true });

    const mid = await passStateOf(w.mailboxId);
    // THE WHOLE OF THE CRASH POLICY. A marker written first would mark this mailbox corrected
    // with four misrouted messages still in the Ohbox and nothing that would ever look again.
    expect(mid!.at).toBeNull();

    const rest = await runSensitiveRescreen({ db, trustedAuthservIdsFor: NONE, mailboxId: w.mailboxId });
    expect(rest).toMatchObject({ ran: true, rescreened: 4, truncated: false });
    const done = await passStateOf(w.mailboxId);
    expect(done!.at).toBeInstanceOf(Date);
    expect(await movesFor(w.accountId)).toHaveLength(6);
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════
  //  3b. THE RESUME POINT IS ON DISK — and the STAYERS are what make that necessary
  //
  //  The test above resumes correctly with NO stored cursor, and it is worth saying why that
  //  proves less than it looks: every one of its six rows MOVES, and a moved row leaves the
  //  candidate query (it is desired into the Screener, not the Ohbox). Restarting from the top
  //  therefore skipped straight past the finished work by accident.
  //
  //  A STAYER never leaves the candidate set. It is a candidate the re-evaluation deliberately
  //  keeps in the Ohbox — a known sender's login code — so it satisfies every predicate for
  //  ever. A mailbox whose candidate prefix is stayers is the case where restarting from the top
  //  reads the same rows on every run and never reaches the misrouted mail behind them, while
  //  reporting progress-shaped counts. These cases are that mailbox.
  // ══════════════════════════════════════════════════════════════════════════════════════════

  it("a stayer prefix does not trap the pass — the next run starts BEHIND it and finishes", async () => {
    const w = await newWorld();
    // Ids chosen so the walk order is known: four stayers, then two strangers.
    const ids = sortedIds(6);
    await db.insert(contacts).values({ accountId: w.accountId, address: "known@friend.test" });
    for (let i = 0; i < 4; i++) {
      await seedOhbox(w, { id: ids[i], from: "known@friend.test" });
    }
    const movers = [ids[4]!, ids[5]!];
    for (const id of movers) await seedOhbox(w, { id, from: `s-${id.slice(0, 8)}@stranger.test` });

    // Run one is bounded to exactly the stayer prefix — the shape the row cap produces on a
    // real mailbox, expressed as a budget.
    const first = await runSensitiveRescreen({
      db, trustedAuthservIdsFor: NONE, mailboxId: w.mailboxId, batch: 2, maxPages: 2,
    });
    expect(first).toMatchObject({
      ran: true, examined: 4, rescreened: 0, kept: 4, truncated: true, resumedFrom: null,
      stoppedBecause: "page_cap",
    });
    // Nothing moved, so nothing left the candidate set. The ONLY record that this prefix was
    // examined is the cursor, and it is on disk.
    expect(await movesFor(w.accountId)).toEqual([]);
    expect(await passStateOf(w.mailboxId)).toEqual({ at: null, cursor: ids[3] });

    // Run two, same budget. WITHOUT the stored cursor this re-reads the same four stayers,
    // reports `examined: 4, rescreened: 0, truncated: true` — and does so on every subsequent
    // run, for ever.
    const second = await runSensitiveRescreen({
      db, trustedAuthservIdsFor: NONE, mailboxId: w.mailboxId, batch: 2, maxPages: 2,
    });
    expect(second).toMatchObject({
      ran: true, examined: 2, rescreened: 2, kept: 0, truncated: false, resumedFrom: ids[3],
    });
    expect((await movesFor(w.accountId)).sort()).toEqual([...movers].sort());

    // Finished ⇒ stamped, and the resume point is GONE. A completed mailbox holding a cursor at
    // its own end is what would make the `force` re-run above read nothing for the wrong reason.
    const done = await passStateOf(w.mailboxId);
    expect(done.at).toBeInstanceOf(Date);
    expect(done.cursor).toBeNull();
  });

  it("every row is examined EXACTLY once across four killed runs — not one twice, not one skipped", async () => {
    const w = await newWorld();
    const ids = sortedIds(6);
    const walkClock = new Date();   // the seeds' own millisecond — see the ALREADY-stamped case below
    await db.insert(contacts).values({ accountId: w.accountId, address: "known@friend.test" });
    // ALL stayers. Nothing ever leaves the candidate set, so the count is a pure statement about
    // where the walk is: a re-read shows up as an examined total above six, a skip as one below.
    for (const id of ids) await seedOhbox(w, { id, from: "known@friend.test" });

    let examined = 0;
    const seen: (string | null)[] = [];
    // One page per run, then the process is gone. Four runs: three pages of two, then the page
    // that comes back empty and stamps.
    for (let run = 0; run < 4; run++) {
      const r = await runSensitiveRescreen({
        db, trustedAuthservIdsFor: NONE, mailboxId: w.mailboxId, batch: 2, maxPages: 1,
        now: () => walkClock,
      });
      examined += r.examined;
      seen.push(r.resumedFrom);
      const state = await passStateOf(w.mailboxId);
      // The stored position after each run is the last row of the page that run committed.
      if (run < 3) expect(state.cursor).toBe(ids[run * 2 + 1]);
    }
    // Each run started exactly where the previous one stopped.
    expect(seen).toEqual([null, ids[1], ids[3], ids[5]]);
    expect(examined).toBe(6);
    expect(await movesFor(w.accountId)).toEqual([]);
    const done = await passStateOf(w.mailboxId);
    expect(done.at).toBeInstanceOf(Date);
    expect(done.cursor).toBeNull();
  });

  it("a page that dies before it commits advances NOTHING — not the moves, not the position", async () => {
    const w = await newWorld();
    const ids = sortedIds(4);
    for (const id of ids) await seedOhbox(w, { id, from: `s-${id.slice(0, 8)}@stranger.test` });

    // A database that dies at the exact instant the second page writes its resume point — after
    // that page has moved its rows and before it commits. This is the only window in which the
    // work and the position could ever disagree, and the claim is that the window does not
    // exist: the write is in the page's own transaction, so the abort takes both.
    let pages = 0;
    const dying = new Proxy(db as object, {
      get(target, prop, recv) {
        if (prop !== "transaction") return Reflect.get(target, prop, recv);
        return async (fn: (t: unknown) => unknown) => {
          pages += 1;
          const kill = pages === 2;
          return (db as unknown as { transaction: (f: (t: unknown) => unknown) => Promise<unknown> })
            .transaction((t: unknown) => fn(new Proxy(t as object, {
              get(tt, p) {
                // Methods are bound to the REAL transaction, never to the proxy: drizzle reads
                // `this.session` inside them, and a proxied `this` hands it undefined — which
                // fails the test with a TypeError that looks nothing like the fault under test.
                const bind = (): unknown => {
                  const v = Reflect.get(tt, p) as unknown;
                  return typeof v === "function" ? v.bind(tt) : v;
                };
                // `insert(passProgress)` inside a PAGE is the cursor write and nothing else: the
                // page stores its position through the one door, an upsert of the pass's row.
                // Dying on it is dying in the window.
                // THE DEATH IS AFTER THE WRITE, NOT INSTEAD OF IT — which is the whole point.
                // Throwing before the write would only prove that a page which never stored a
                // position stores no position. The window under test is the one where the page
                // HAS done its moves AND HAS written its resume point and the transaction has
                // not committed: the claim is that this state cannot reach disk.
                if (kill && p === "insert") {
                  return (table: unknown) => {
                    type Upsert = { select: (q: unknown) => { onConflictDoUpdate: (c: unknown) => { returning: (r: unknown) => PromiseLike<unknown> } } };
                    const built = (bind() as (x: unknown) => unknown)(table) as Upsert;
                    if (table !== passProgress) return built;
                    return {
                      select: (q: unknown) => ({
                        onConflictDoUpdate: (c: unknown) => ({
                          returning: async (r: unknown) => {
                            await built.select(q).onConflictDoUpdate(c).returning(r);   // the cursor IS written…
                            throw new Error("the process died mid-page");   // …and then we die
                          },
                        }),
                      }),
                    };
                  };
                }
                return bind();
              },
            })));
        };
      },
    }) as Db;

    await expect(runSensitiveRescreen({
      db: dying, trustedAuthservIdsFor: NONE, mailboxId: w.mailboxId, batch: 2, maxPages: 4,
    })).rejects.toThrow("the process died mid-page");

    // Page one committed: two moves, and the position that covers them.
    expect(await movesFor(w.accountId)).toHaveLength(2);
    expect(await passStateOf(w.mailboxId)).toEqual({ at: null, cursor: ids[1] });

    // …and the survivor picks up exactly the two rows page two never committed.
    const rest = await runSensitiveRescreen({ db, trustedAuthservIdsFor: NONE, mailboxId: w.mailboxId });
    expect(rest).toMatchObject({ ran: true, examined: 2, rescreened: 2, resumedFrom: ids[1] });
    expect(await movesFor(w.accountId)).toHaveLength(4);
  });

  it("refuses the marker when a row behind the walk became a candidate again, and re-walks", async () => {
    // THE WORKER'S COMPLETION, EXACTLY. `completeFiling` writes back the `desiredFolder` it read
    // BEFORE its IMAP move (`apps/worker/src/junk-filing.ts`), so a row this pass moved to the
    // Screener mid-move is restored to the Ohbox afterwards — a candidate again, and now behind
    // the cursor. Reaching an empty page after that is NOT "every candidate examined", and
    // stamping there would certify the mailbox as corrected over mail nothing looked at.
    const w = await newWorld();
    const ids = sortedIds(3);
    for (const id of ids) await seedOhbox(w, { id, from: `s-${id.slice(0, 8)}@stranger.test` });

    let restored = false;
    const clobbering = new Proxy(db as object, {
      get(target, prop, recv) {
        if (prop !== "transaction") return Reflect.get(target, prop, recv);
        return async (fn: (t: unknown) => unknown) => {
          const out = await (db as unknown as {
            transaction: (f: (t: unknown) => unknown) => Promise<unknown>;
          }).transaction(fn);
          // AFTER the page has COMMITTED — which is where the worker's completion lands, and it
          // has to be: the page holds `FOR UPDATE` on the rows it read until it commits, so a
          // write from another connection inside that window blocks rather than clobbers. The
          // real sequence is the worker reading the stale intent, moving on IMAP for as long as
          // that takes, and completing afterwards.
          if (!restored) {
            restored = true;
            await sql`update folder_state
                         set desired_folder = 'INBOX', last_set_by = 'us',
                             reconcile_status = 'reconciled', updated_at = now()
                       where message_id = ${ids[0]!}::uuid`;
          }
          return out;
        };
      },
    }) as Db;

    const r = await runSensitiveRescreen({
      db: clobbering, trustedAuthservIdsFor: NONE, mailboxId: w.mailboxId, batch: 3,
    });

    // The walk reached the end. The marker did NOT land, and the resume point was CLEARED —
    // keeping it would resume past the restored row for ever on the same evidence.
    // …and it says WHICH truncation this is. The operator acts on the difference: a page-cap
    // stop resumes, a disturbed one starts over.
    expect(r).toMatchObject({ ran: true, truncated: true, stoppedBecause: "disturbed" });
    expect(await passStateOf(w.mailboxId)).toEqual({ at: null, cursor: null });
    expect((await desiredOf(ids[0]!)).desired).toBe(OHBOX);

    // …and the next run re-walks the prefix, finds it, and finishes.
    const rest = await runSensitiveRescreen({ db, trustedAuthservIdsFor: NONE, mailboxId: w.mailboxId });
    expect(rest).toMatchObject({ ran: true, examined: 1, rescreened: 1, truncated: false, resumedFrom: null });
    const done = await passStateOf(w.mailboxId);
    expect(done.at).toBeInstanceOf(Date);
    expect(done.cursor).toBeNull();
  });

  it("catches a restoration that lands BETWEEN two runs, not only inside one", async () => {
    // THE WINDOW IS THE WALK'S, NOT THE RUN'S, and this is the case that separates them. The
    // cursor outlives an invocation: run one stores a prefix and exits, the worker's completion
    // restores one of its rows afterwards, and run two starts LATER STILL. Measured against run
    // two's own start instant that restoration is in the past and invisible, and run two stamps
    // the mailbox over a candidate nothing will look at again. Measured against the walk's start
    // (the pass's `started_at`) it is inside the window.
    const w = await newWorld();
    const ids = sortedIds(4);
    for (const id of ids) await seedOhbox(w, { id, from: `s-${id.slice(0, 8)}@stranger.test` });

    const first = await runSensitiveRescreen({
      db, trustedAuthservIdsFor: NONE, mailboxId: w.mailboxId, batch: 2, maxPages: 1,
    });
    expect(first).toMatchObject({ examined: 2, rescreened: 2, truncated: true });
    expect((await passStateOf(w.mailboxId)).cursor).toBe(ids[1]);
    const epoch = await walkStartOf(w.mailboxId);
    expect(epoch, "the walk stored no epoch with its resume point").toBeInstanceOf(Date);

    // BETWEEN the runs — the worker completing a move it began before run one touched the row.
    await sql`update folder_state
                 set desired_folder = 'INBOX', last_set_by = 'us',
                     reconcile_status = 'reconciled', updated_at = now()
               where message_id = ${ids[0]!}::uuid`;

    const second = await runSensitiveRescreen({ db, trustedAuthservIdsFor: NONE, mailboxId: w.mailboxId });
    expect(second).toMatchObject({
      ran: true, truncated: true, resumedFrom: ids[1], stoppedBecause: "disturbed",
    });
    // Refused, and BOTH columns cleared — the epoch may not outlive the cursor it dates.
    expect(await passStateOf(w.mailboxId)).toEqual({ at: null, cursor: null });
    expect(await walkStartOf(w.mailboxId)).toBeNull();

    // The next walk starts fresh, finds the restored row, and finishes.
    const third = await runSensitiveRescreen({ db, trustedAuthservIdsFor: NONE, mailboxId: w.mailboxId });
    expect(third).toMatchObject({ ran: true, examined: 1, rescreened: 1, truncated: false, resumedFrom: null });
    expect((await passStateOf(w.mailboxId)).at).toBeInstanceOf(Date);
    expect(await walkStartOf(w.mailboxId)).toBeNull();
  });

  it("a stamped mailbox stores no resume point, so `force` still measures the whole set", async () => {
    // A stale run outliving a faster one would otherwise write its own lower position onto a
    // mailbox the winner has already stamped and cleared. A completed mailbox holding a cursor
    // is the one state that makes `force` start at that cursor and read nothing — its "zero
    // writes" would then say where the cursor was, not that the candidate query is idempotent.
    const w = await newWorld();
    await db.insert(contacts).values({ accountId: w.accountId, address: "known@friend.test" });
    for (const id of sortedIds(4)) await seedOhbox(w, { id, from: "known@friend.test" });

    const first = await runSensitiveRescreen({ db, trustedAuthservIdsFor: NONE, mailboxId: w.mailboxId });
    expect(first).toMatchObject({ examined: 4, rescreened: 0, truncated: false });
    expect((await passStateOf(w.mailboxId)).cursor).toBeNull();

    // `force` over a stamped mailbox, TRUNCATED after one page. It must leave no position behind.
    const forced = await runSensitiveRescreen({
      db, trustedAuthservIdsFor: NONE, mailboxId: w.mailboxId, force: true, batch: 2, maxPages: 1,
    });
    expect(forced).toMatchObject({
      ran: true, examined: 2, truncated: true, stoppedBecause: "page_cap",
    });
    expect((await passStateOf(w.mailboxId)).cursor).toBeNull();

    // …so the NEXT force sees all four again — the measurement `force` exists to make.
    const xminOf = async (): Promise<string> => {
      const rows = await sql`select xmin::text as x from mailboxes where id = ${w.mailboxId}::uuid`;
      return (rows[0] as { x: string }).x;
    };
    const before = await xminOf();
    const again = await runSensitiveRescreen({
      db, trustedAuthservIdsFor: NONE, mailboxId: w.mailboxId, force: true,
    });
    expect(again).toMatchObject({ examined: 4, rescreened: 0, resumedFrom: null });
    // AND IT WROTE NOTHING. The marker statement is `coalesce(at, now), cursor = NULL`, which
    // without its predicate would take the row lock and emit a fresh tuple on every completed
    // `force` run and on every loser of a two-operator finish, for no change. `xmin` is the
    // transaction that last wrote this row: unchanged means no tuple was written.
    expect(await xminOf(), "the marker statement rewrote a row it had nothing to change").toBe(before);
  });

  it("clears a resume point left on an ALREADY stamped mailbox — the predicate's second job", async () => {
    // The marker statement has two jobs: stamp an unstamped mailbox, and clear a position left on
    // one that is already stamped. Its predicate has to admit BOTH, and only the first is
    // exercised by an ordinary run. This is the second: a stamped mailbox carrying a stale
    // position — the shape a database written by the pre-0081 code, or by a run interrupted
    // between the two, can hold — must come out of a `force` run with the position gone.
    const w = await newWorld();
    await db.insert(contacts).values({ accountId: w.accountId, address: "known@friend.test" });
    const ids = sortedIds(2);
    // THE WALK STARTS IN THE MILLISECOND THE FIXTURE SEEDS, pinned rather than raced: a run's start
    // is a whole-millisecond JS `Date` and a seed's `updated_at` is microseconds, so a walk starting
    // in the seed's own millisecond reads it as written inside the walk. That was this case and the
    // four-killed-runs case red about one alone run in twelve. A clock read BEFORE the seeds is that
    // instant made certain; `seedOhbox` stamps strictly before any walk, so the pass completes.
    const walkClock = new Date();
    for (const id of ids) await seedOhbox(w, { id, from: "known@friend.test" });

    const done = await runSensitiveRescreen({
      db, trustedAuthservIdsFor: NONE, mailboxId: w.mailboxId, now: () => walkClock,
    });
    expect(done).toMatchObject({ truncated: false });
    expect((await passStateOf(w.mailboxId)).at).toBeInstanceOf(Date);

    // Plant the state the predicate's second arm exists for.
    await sql`insert into pass_progress (account_id, job, subject_id, cursor, started_at)
               values (${w.accountId}::uuid, 'sensitive_rescreen', ${w.mailboxId}::uuid, ${ids[0]!}, now())
               on conflict (account_id, job, subject_id)
               do update set cursor = excluded.cursor, started_at = excluded.started_at`;

    const forced = await runSensitiveRescreen({
      db, trustedAuthservIdsFor: NONE, mailboxId: w.mailboxId, force: true,
    });
    expect(forced).toMatchObject({ ran: true, truncated: false, resumedFrom: ids[0] });
    expect((await passStateOf(w.mailboxId)).cursor, "the stale position survived a completion").toBeNull();
    expect(await walkStartOf(w.mailboxId)).toBeNull();
  });

  it("a write in the walk's OWN millisecond reads as disturbed — the boundary is inclusive", async () => {
    // The product's half of the case above. The completion check asks `updated_at >= walk start`,
    // the start whole milliseconds, the stamp microseconds: a write 500 µs into the walk's own
    // millisecond is inside the walk, and the pass withholds its marker (the conservative path —
    // no stamp, resume point cleared, the next run re-walks). The control: one microsecond BEFORE
    // that millisecond is outside, and the same walk stamps.
    const walkClock = new Date();
    for (const [offset, disturbed] of [["500 microseconds", true], ["-1 microseconds", false]] as const) {
      const w = await newWorld();
      await db.insert(contacts).values({ accountId: w.accountId, address: "known@friend.test" });
      const id = await seedOhbox(w, { from: "known@friend.test" });
      await sql`update folder_state
                   set updated_at = ${walkClock.toISOString()}::timestamptz + ${offset}::interval
                 where message_id = ${id}::uuid`;

      const r = await runSensitiveRescreen({
        db, trustedAuthservIdsFor: NONE, mailboxId: w.mailboxId, now: () => walkClock,
      });
      expect(r, offset).toMatchObject({
        ran: true, examined: 1, kept: 1, truncated: disturbed,
        stoppedBecause: disturbed ? "disturbed" : null,
      });
      expect((await passStateOf(w.mailboxId)).at === null, offset).toBe(disturbed);
    }
  });

  it("a mailbox that is not there is not a mailbox that is DONE", async () => {
    // `EMPTY` carries `ran: false, stoppedBecause: null`, which the operator command renders as
    // "SKIPPED — the marker is stamped". A mailbox deleted between the target selection and the
    // pass's own read would have reported itself as already corrected: the opposite fact, and the
    // one an operator would act on by moving to the next mailbox.
    const r = await runSensitiveRescreen({
      db, trustedAuthservIdsFor: NONE, mailboxId: randomUUID(),
    });
    expect(r).toMatchObject({ ran: true, truncated: true, stoppedBecause: "mailbox_gone" });
  });

  it("does not stamp a mailbox that was DELETED while the pass was walking it", async () => {
    // The completion transaction locks the mailbox row and then uses what it read. It has to:
    // account erasure deletes `folder_state` and then `mailboxes` in one transaction, so a pass
    // that started before it can arrive at the stamp with nothing to stamp. Writing the
    // completion audit row and the marker there would insert into tables the erasure has just
    // swept and report a mailbox corrected that no longer exists.
    const w = await newWorld();   // no messages: the walk's first page is its last

    let removed = false;
    const vanishing = new Proxy(db as object, {
      get(target, prop, recv) {
        if (prop !== "transaction") return Reflect.get(target, prop, recv);
        return async (fn: (t: unknown) => unknown) => {
          const out = await (db as unknown as {
            transaction: (f: (t: unknown) => unknown) => Promise<unknown>;
          }).transaction(fn);
          // Between the walk's last page and the completion — the window erasure lands in.
          if (!removed) {
            removed = true;
            await sql`delete from mailboxes where id = ${w.mailboxId}::uuid`;
          }
          return out;
        };
      },
    }) as Db;

    const r = await runSensitiveRescreen({
      db: vanishing, trustedAuthservIdsFor: NONE, mailboxId: w.mailboxId,
    });
    expect(r).toMatchObject({ ran: true, truncated: true, stoppedBecause: "mailbox_gone" });
    const rows = await db.select().from(auditLog)
      .where(and(eq(auditLog.accountId, w.accountId), eq(auditLog.action, "sensitive_rescreen")));
    expect(rows, "a completion row was written for a mailbox that no longer exists").toEqual([]);
  });

  it("takes the mailbox row BEFORE folder_state, so a fenced worker write cannot deadlock it", async () => {
    // THE CYCLE THIS ORDER EXISTS TO PREVENT. `makeSyncWriteFence` opens every worker write group
    // with `select mailboxes … for update` and only then writes `folder_state`. A page that took
    // `folder_state` first and reached for `mailboxes` last would close the cycle, and Postgres
    // would deadlock one side — repeatedly, on a live mailbox, with no error the operator could act
    // on beyond "it keeps dying".
    //
    // The worker's half is replayed literally, on its own connection: M, then F, then commit.
    // Held OPEN while the pass runs its page, which is the interleaving that deadlocks under the
    // wrong order and merely BLOCKS under the right one.
    const w = await newWorld();
    const ids = sortedIds(2);
    for (const id of ids) await seedOhbox(w, { id, from: `s-${id.slice(0, 8)}@stranger.test` });

    const worker = postgres(PG_TEST_URL, { max: 1, onnotice: () => {} });
    try {
      let release!: () => void;
      const held = new Promise<void>((res) => { release = res; });
      let workerPid = 0;
      const workerTx = worker.begin(async (t) => {
        const [me] = await t`select pg_backend_pid() as pid`;
        workerPid = (me as { pid: number }).pid;
        await t`select id from mailboxes where id = ${w.mailboxId}::uuid for update`;
        await held;                       // the pass runs its page against this
        await t`update folder_state set updated_at = now() where message_id = ${ids[1]!}::uuid`;
      });

      // The page now wants M (which the worker holds) and blocks. Releasing the worker lets it
      // take F and commit; the page then proceeds. Under the OLD order the page would already
      // hold F, the worker would block on it, and both would be stuck — Postgres kills one.
      const pass = runSensitiveRescreen({
        db, trustedAuthservIdsFor: NONE, mailboxId: w.mailboxId, batch: 2,
      });

      // SYNCHRONIZED ON THE DATABASE, NOT ON A TIMER. A fixed sleep makes this case pass on a
      // slow machine for the wrong reason: release the worker before the pass has reached ANY
      // conflicting lock and the two never contend, so a mutated (F-first) implementation would
      // go green. Waiting until Postgres reports somebody blocked on a lock is waiting for the
      // contention itself.
      const deadline = Date.now() + 15_000;
      while (workerPid === 0) {
        if (Date.now() > deadline) throw new Error("the worker never reported its backend pid");
        await new Promise((res) => setTimeout(res, 10));
      }
      for (;;) {
        // BLOCKED **BY THE WORKER**, not merely blocked. This database is shared with every
        // other pg suite, so "somebody is waiting on a lock" is satisfied by unrelated
        // contention — and an F-first mutant would then be released before it ever reached the
        // mailbox row and go green. `pg_blocking_pids` names who is holding the lock the waiter
        // wants, so the condition is the cycle's own first half and nothing else.
        const blocked = await sql`
          select 1 from pg_stat_activity a
           where a.datname = current_database()
             and a.wait_event_type = 'Lock'
             and ${workerPid}::int = any(pg_blocking_pids(a.pid))
           limit 1`;
        if (blocked.length > 0) break;
        if (Date.now() > deadline) throw new Error("nothing ever blocked — the case proved nothing");
        await new Promise((res) => setTimeout(res, 25));
      }
      release();

      const [r] = await Promise.all([pass, workerTx]);
      expect(r).toMatchObject({ ran: true, examined: 2, rescreened: 2, truncated: false });
    } finally {
      await worker.end({ timeout: 5 });
    }
  });

  it("a slower pass cannot drag the stored position backwards, and still stores when ahead", async () => {
    const w = await newWorld();
    const ids = sortedIds(6);
    await db.insert(contacts).values({ accountId: w.accountId, address: "known@friend.test" });
    for (const id of ids) await seedOhbox(w, { id, from: "known@friend.test" });

    // Pass A has read the cursor (NULL) and is inside its first page. Pass B — a second operator
    // on a second connection — finishes the whole mailbox and stores its end. A's page then
    // commits, and its position is BEHIND B's.
    //
    // A bare `SET cursor = <A's last row>` would rewind the mailbox to row two, and the two
    // operators would hand the walk back and forth over a prefix neither ever gets past — the
    // single-process defect this column closes, rebuilt out of two processes. The
    // `cursor IS NULL OR cursor < new` predicate is what refuses it.
    let raced = false;
    const racing = new Proxy(db as object, {
      get(target, prop, recv) {
        if (prop !== "transaction") return Reflect.get(target, prop, recv);
        return async (fn: (t: unknown) => unknown) =>
          (db as unknown as { transaction: (f: (t: unknown) => unknown) => Promise<unknown> })
            .transaction(async (t: unknown) => {
              if (!raced) {
                raced = true;
                // A SEPARATE connection, committed BEFORE this page opens its own transaction —
                // which is where it has to be now that every page takes the mailbox row FOR
                // UPDATE first. Inside the page it would block on that lock rather than race it,
                // and the case would prove a wait instead of a rewind.
                await sql`insert into pass_progress (account_id, job, subject_id, cursor)
                           values (${w.accountId}::uuid, 'sensitive_rescreen', ${w.mailboxId}::uuid, ${ids[3]!})
                           on conflict (account_id, job, subject_id) do update set cursor = excluded.cursor`;
              }
              return fn(t);
            });
      },
    }) as Db;

    await runSensitiveRescreen({
      db: racing, trustedAuthservIdsFor: NONE, mailboxId: w.mailboxId, batch: 2, maxPages: 1,
    });
    expect((await passStateOf(w.mailboxId)).cursor).toBe(ids[3]);

    // …AND THE PAGE STILL WRITES WHEN IT IS AHEAD. Without this half the case passes when the
    // page's cursor UPDATE is deleted outright — the value asserted above is the one the RACE
    // wrote, so "refused" and "never attempted" are indistinguishable. Resuming from `ids[3]`,
    // the next page ends at `ids[5]`, which is ahead of the stored value and must be stored.
    const rest = await runSensitiveRescreen({
      db, trustedAuthservIdsFor: NONE, mailboxId: w.mailboxId, batch: 2, maxPages: 1,
    });
    expect(rest).toMatchObject({ ran: true, resumedFrom: ids[3] });
    expect((await passStateOf(w.mailboxId)).cursor).toBe(ids[5]);
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════
  //  4. TWO PASSES AT ONCE — the case PGlite structurally cannot host
  // ══════════════════════════════════════════════════════════════════════════════════════════

  it("two concurrent passes produce ONE move per message and no hole in the account's seq", async () => {
    // WHAT THIS PROVES NOW, AND WHAT IT NO LONGER DOES. Since every page opens by taking the
    // mailbox row `FOR UPDATE`, two runs of THIS pass are serialized before they reach the
    // candidate query — so this case would still pass with `FOR UPDATE OF folder_state` removed,
    // and it is no longer evidence for that lock. It is still the seq claim's only test, and the
    // seq claim is the harder half: `allocateSeq` under two writers with no gap.
    //
    // No case in this file proves the `folder_state` lock, and saying so is better than pointing
    // at one that does not. The clobber test above races a writer on another connection, but it
    // writes AFTER the page has committed and released everything, so it exercises the completion
    // check rather than the lock. The writers the lock is for — the move route, the screener
    // apply, `rule-retro`, `ohbox-tidy`, `screener-auto` — would each need their own interleaved
    // case here. (The sync loop's reconciler is NOT one of them: its fenced write group takes the
    // mailbox row first, which is why the page order matches it.)
    const w = await newWorld();
    // Three pages of rows, so the two passes genuinely interleave across
    // transactions instead of racing once and finishing.
    const ids: string[] = [];
    for (let i = 0; i < 250; i++) ids.push(await seedOhbox(w, { from: `c${i}@stranger.test` }));

    const deps = { db, trustedAuthservIdsFor: NONE, mailboxId: w.mailboxId };
    const [a, b] = await Promise.all([
      runSensitiveRescreen(deps), runSensitiveRescreen(deps),
    ]);
    expect(a.rescreened + b.rescreened).toBe(250);

    // 1 — one `move` per message. What gives it HERE is the mailbox row lock every page opens
    // with: the two runs never hold pages at the same time, so the second one's candidate query
    // simply does not see rows the first has already moved. The `FOR UPDATE OF folder_state` this
    // comment used to credit would give the same result on its own — the loser blocking on the
    // locked row and re-reading a row no longer desired into the Ohbox — but that path is not the
    // one this case exercises any more, and crediting it here is how the file came to claim a
    // proof it does not have. See the lock's own docblock for the writers it is really for.
    const moves = await db.select().from(changeLog)
      .where(and(eq(changeLog.accountId, w.accountId), eq(changeLog.op, "move")));
    expect(moves).toHaveLength(250);
    expect(new Set(moves.map((m) => m.entityId)).size).toBe(250);
    for (const m of moves) expect(m.meta).toMatchObject({ from: OHBOX, to: SCREENER });

    // 2 — the per-account seq is unique, contiguous and strictly increasing under two writers.
    const all = await db.select().from(changeLog)
      .where(eq(changeLog.accountId, w.accountId)).orderBy(asc(changeLog.seq));
    const seqs = all.map((r) => Number(r.seq));
    expect(new Set(seqs).size).toBe(seqs.length);
    for (let i = 1; i < seqs.length; i++) expect(seqs[i]! - seqs[i - 1]!).toBe(1);

    // 3 — every message converged on ONE desired state, pending the physical move.
    const states = await db.select().from(folderState).where(inArray(folderState.messageId, ids));
    expect(states).toHaveLength(250);
    for (const s of states) {
      expect(s.desiredFolder).toBe(SCREENER);
      expect(s.reconcileStatus).toBe("pending");
      expect(s.lastSetBy).toBe("us");
    }

    // 4 — the mailbox ends STAMPED, and the instant is the first finisher's. Both processes may
    // reach the marker statement; `coalesce(done_at, <now>)` is what makes the
    // second one preserve the first one's timestamp rather than overwrite it, so the answer is
    // the DATABASE's and not a read-then-write either process performed. (The `WHERE … IS NULL`
    // this comment used to name was removed with the cursor: it made the whole statement a no-op
    // for the loser, which would have left a finished mailbox holding a stale resume point.)
    const audits = await db.select().from(auditLog)
      .where(and(eq(auditLog.accountId, w.accountId), eq(auditLog.action, "sensitive_rescreen")));
    expect(audits.length).toBeGreaterThanOrEqual(1);
    const mb = await passStateOf(w.mailboxId);
    expect(mb!.at).toBeInstanceOf(Date);
  }, 60_000);

  // ══════════════════════════════════════════════════════════════════════════════════════════
  //  5. SCOPE
  // ══════════════════════════════════════════════════════════════════════════════════════════

  it("touches no other mailbox and no other account", async () => {
    const mine = await newWorld();
    const theirs = await newWorld();
    const target = await seedOhbox(mine, { from: "x@stranger.test" });
    const bystander = await seedOhbox(theirs, { from: "x@stranger.test" });

    await runSensitiveRescreen({ db, trustedAuthservIdsFor: NONE, mailboxId: mine.mailboxId });

    expect((await desiredOf(target)).desired).toBe(SCREENER);
    expect((await desiredOf(bystander)).desired).toBe(OHBOX);
    expect(await movesFor(theirs.accountId)).toEqual([]);
    const other = await passStateOf(theirs.mailboxId);
    expect(other!.at).toBeNull();
  });
});
