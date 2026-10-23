
/** The explicit empty trust set - an unlisted provider's mailbox; the auth demotion never fires. */
const NONE = async (): Promise<ReadonlySet<string>> => new Set<string>();
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { makeTestDb } from "@trafficflow/db/testing";
import {
  accounts, applyRuleRequest, approvals, applyScreenerDecision, auditLog, changeLog, contacts, drafts, folderState,
  mailboxes, messageStates, messages, reconcileRuleCreate, rules, threads, type Tx,
} from "@trafficflow/db";
import { carryDialect } from "@trafficflow/db/dialect";
import { ruleRetroPass } from "../src/rule-retro.js";
import { clearOrganizerStandDown, clearOwedRetroFences } from "../src/mailboxes.js";
import { makeDrizzleRepo } from "@trafficflow/core/adapters/drizzle-repo";
import {
  planChange, commitChange, UNMETERED_STORAGE_CAP, type Change,
} from "@trafficflow/core/mail";

/**
 * A NEW RULE REACHING MAIL THAT IS ALREADY FILED.
 *
 * The brief this slice was written to is explicit that a green test over an empty database is not
 * evidence about any of this, so every case below seeds real rows and asserts what MOVED. The
 * three claims it names are `moves the pre-existing messages`, `run twice does not double-move or
 * lose anything`, and `an interrupted run resumes`; they are the first three describes.
 *
 * ── THE ANTI-VACUITY CASE IS THE MOST IMPORTANT ONE IN THIS FILE ─────────────────────────────
 *
 * This pass's candidate query is a near-sibling of `sensitive-rescreen.ts#selectCandidates`, and
 * that one excludes any message whose sender already carries an enabled `rules` row. Copied here
 * — which is the obvious way to write this file — it excludes EVERYTHING, because the rule this
 * pass exists to apply is itself an enabled rules row for exactly that sender. The pass would
 * then examine nothing, move nothing, stamp itself complete and report success, and every
 * assertion of the shape "nothing was double-moved" would pass for the wrong reason.
 *
 * So `a freshly created rule has candidates at all` is asserted on its own, before anything else
 * is claimed about them. It was mutated and watched go red (re-adding the exclusion), which is
 * the only reason it counts as a guard.
 *
 * The transactional claims are NOT here. `FOR UPDATE`, two concurrent drivers and the gap-free
 * seq are green-by-construction under PGlite, which is single-connection; they live in
 * `rule-retro.pg.test.ts` against real Postgres on :5433, per CLAUDE.md.
 */

const OHBOX = "INBOX";
const READS = "ohmail/News";
const SCREENED = "ohmail/Screened";

interface World {
  db: Awaited<ReturnType<typeof makeTestDb>>;
  accountId: string;
  mailboxId: string;
}

async function newWorld(): Promise<World> {
  const db = await makeTestDb();
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: `retro-${accountId.slice(0, 8)}` });
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: `me-${accountId.slice(0, 8)}@ohmail.test`,
  }).returning();
  return { db, accountId, mailboxId: mb!.id };
}

/** One stored message, filed where `folder` says, with a `folder_state` row we authored. */
async function seedMessage(
  w: World,
  opts: {
    from: string; folder?: string; lastSetBy?: string; subject?: string; threadId?: string;
    /** Which of the account's mailboxes holds it. Default: the one `newWorld` connected. */
    mailboxId?: string;
    /**
     * A CHOSEN `messages.id`, for the cases that are about the CURSOR.
     *
     * `retro_cursor` is a `messages.id` and the walk orders by it, so "before the cursor" and
     * "after the cursor" are facts about a random uuid. A test that needs a row to sit BELOW a
     * page the pass has already walked has to name the id — with `defaultRandom()` the case would
     * pass or fail on the shape of a uuid, which is the definition of a flake.
     */
    id?: string;
  },
): Promise<string> {
  const dedup = `mid:${randomUUID()}`;
  const folder = opts.folder ?? OHBOX;
  const [m] = await w.db.insert(messages).values({
    ...(opts.id ? { id: opts.id } : {}),
    accountId: w.accountId, mailboxId: opts.mailboxId ?? w.mailboxId,
    messageIdHeader: dedup, bodyHash: randomUUID(), dedupKey: dedup,
    subject: opts.subject ?? "hello", fromAddress: opts.from,
    ...(opts.threadId ? { threadId: opts.threadId } : {}),
    nativeLocator: { folder, ref: "1:1" },
  }).returning();
  await w.db.insert(folderState).values({
    messageId: m!.id, desiredFolder: folder, observedFolder: folder,
    lastSetBy: opts.lastSetBy ?? "us", reconcileStatus: "reconciled", conflict: false,
  });
  return m!.id;
}

/** A rule the user just made, with the retroactive apply requested — the DEFAULT path. */
async function seedRule(
  w: World,
  opts: {
    kind?: string; match: string; destination: string; retro?: boolean; enabled?: boolean; subjectContains?: string;
  },
): Promise<string> {
  const [r] = await w.db.insert(rules).values({
    accountId: w.accountId,
    kind: opts.kind ?? "sender",
    match: opts.match,
    ...(opts.subjectContains ? { subjectContains: opts.subjectContains } : {}),
    destination: opts.destination,
    provenance: "manual",
    enabled: opts.enabled ?? true,
    retroRequestedAt: (opts.retro ?? true) ? new Date("2026-08-04T10:00:00Z") : null,
  }).returning();
  return r!.id;
}

const desiredOf = async (w: World, messageId: string): Promise<string> => {
  const [row] = await w.db.select({ d: folderState.desiredFolder }).from(folderState)
    .where(eq(folderState.messageId, messageId));
  return row!.d;
};

const movesFor = async (w: World, messageId: string) =>
  w.db.select({ meta: changeLog.meta }).from(changeLog)
    .where(and(
      eq(changeLog.accountId, w.accountId),
      eq(changeLog.entityType, "message"),
      eq(changeLog.entityId, messageId),
      eq(changeLog.op, "move"),
    ))
    .orderBy(asc(changeLog.seq));

/**
 * A SECOND MAILBOX on the same account — the shape the account-wide retro marker got wrong.
 *
 * `newWorld` connects one, which is the shape every case in this file was written against and the
 * reason a per-account "finished" marker read as correct for years.
 */
async function addMailbox(w: World, role: "organizer" | "reader", status = "connected"): Promise<string> {
  const [mb] = await w.db.insert(mailboxes).values({
    accountId: w.accountId, provider: "imap",
    address: `second-${randomUUID().slice(0, 8)}@ohmail.test`,
    organizerRole: role, status,
  }).returning();
  return mb!.id;
}

const ruleRow = async (w: World, ruleId: string) => {
  const [r] = await w.db.select().from(rules).where(eq(rules.id, ruleId));
  return r!;
};

const NOW = new Date("2026-08-04T12:00:00Z");
const run = (w: World, extra: Record<string, unknown> = {}) =>
  ruleRetroPass(w.db as unknown as Tx, { accountId: w.accountId, trustedAuthservIdsFor: NONE, ...extra }, NOW);

describe("a READER's mailbox is not a candidate (mail 0083)", () => {
  /**
   * THE HAZARD, and it is not the one it looks like.
   *
   * The candidate predicate excluded `mb.status = 'disabled'`, which WAS the whole of "a mailbox
   * this install no longer organizes". It stopped being that the moment the loser of an organizer
   * lease became a READER — connected, on the roster, syncing — instead of a disabled row.
   *
   * A reader's own ingest writes `last_set_by: 'external'`, so its NEW mail is out of reach by
   * data. What is reachable is everything the install filed while it WAS the organizer: those
   * rows are `'us'`, they sit in the destinations this pass scans, and a rule made afterwards
   * re-files them on a mailbox another install is now arranging.
   *
   * AND NOTHING EXECUTES IT TODAY, which is the trap rather than the mitigation. `reconcileFolders`
   * is skipped for a reader, so the move sits in `folder_state` as an intent — and fires in full
   * the instant the install is ever promoted. Mail moved by a decision taken when this install had
   * no right to take it, arriving one handover later.
   *
   * The same clause guards `ohbox-tidy.ts` and `screener-auto.ts`, which share this predicate's
   * shape and this argument exactly.
   */
  it("a rule made while this install READS the mailbox moves nothing", async () => {
    const w = await newWorld();
    await w.db.update(mailboxes).set({ organizerRole: "reader" })
      .where(eq(mailboxes.id, w.mailboxId));
    // `us` deliberately: this is a row from BEFORE the demotion, which is the only shape that can
    // reach the pass at all. Seeding `external` would prove nothing — the second, independent gate
    // already excludes those, so the test would pass on the unfixed code.
    const m = await seedMessage(w, { from: "news@x.test", folder: OHBOX, lastSetBy: "us" });
    await seedRule(w, { match: "news@x.test", destination: READS });

    const out = await run(w);
    expect(out.moved, "a reader re-filed mail on a mailbox another install organizes").toBe(0);
    expect(await desiredOf(w, m), "the intent was queued to fire on the next promotion").toBe(OHBOX);
    expect(await movesFor(w, m)).toHaveLength(0);
  });

  it("NEGATIVE CONTROL — the identical seed on an ORGANIZER mailbox moves", async () => {
    // Without this the case above is satisfied by a pass that moves nothing for any reason.
    const w = await newWorld();
    const m = await seedMessage(w, { from: "news@x.test", folder: OHBOX, lastSetBy: "us" });
    await seedRule(w, { match: "news@x.test", destination: READS });

    const out = await run(w);
    expect(out.moved, "the organizer arm moved nothing — the reader assertion is vacuous").toBe(1);
    expect(await desiredOf(w, m)).toBe(READS);
  });
});

describe("the candidate set is not empty", () => {
  /**
   * THE GUARD THAT MAKES EVERY OTHER TEST IN THIS FILE MEAN SOMETHING.
   *
   * `sensitive-rescreen`'s query excludes senders that already carry an enabled rule. The rule
   * this pass applies IS one. If that predicate is ever copied in, this is the assertion that
   * fails; without it the whole file goes vacuously green.
   */
  it("a rule the user JUST created still has candidates — its own row must not exclude them", async () => {
    const w = await newWorld();
    const id = await seedMessage(w, { from: "news@atelier.example" });
    await seedRule(w, { match: "news@atelier.example", destination: READS });

    const res = await run(w);

    expect(res.examined, "the pass examined nothing — its own rule excluded its own mail").toBe(1);
    expect(res.moved).toBe(1);
    expect(await desiredOf(w, id)).toBe(READS);
  });
});

describe("a rule created with retroactive apply moves the pre-existing mail", () => {
  it("moves every already-filed message from the sender, and records where each came from", async () => {
    const w = await newWorld();
    const a = await seedMessage(w, { from: "news@atelier.example", folder: OHBOX });
    const b = await seedMessage(w, { from: "news@atelier.example", folder: SCREENED });
    const other = await seedMessage(w, { from: "someone@else.example", folder: OHBOX });
    await seedRule(w, { match: "news@atelier.example", destination: READS });

    const res = await run(w);

    expect(res.moved).toBe(2);
    expect(await desiredOf(w, a)).toBe(READS);
    expect(await desiredOf(w, b)).toBe(READS);
    // Blast radius: a rule about one sender moves one sender's mail.
    expect(await desiredOf(w, other)).toBe(OHBOX);

    // `meta.from` is the TRUE previous desired folder, per message — the single field that makes
    // a later undo expressible without this pass writing an audit row per message.
    const [moveA] = await movesFor(w, a);
    const [moveB] = await movesFor(w, b);
    expect(moveA!.meta).toEqual({ from: OHBOX, to: READS });
    expect(moveB!.meta).toEqual({ from: SCREENED, to: READS });
    expect(await movesFor(w, other)).toHaveLength(0);
  });

  it("a DOMAIN rule moves everyone at the domain, by first-@ and not by suffix", async () => {
    const w = await newWorld();
    const one = await seedMessage(w, { from: "no-reply-kbdtwj@x.example" });
    const two = await seedMessage(w, { from: "billing@x.example" });
    // The `like '%@x.example'` trap: a DIFFERENT domain that ends in the same text.
    const evil = await seedMessage(w, { from: "hi@evil-x.example" });
    await seedRule(w, { kind: "domain", match: "x.example", destination: READS });

    const res = await run(w);

    expect(res.moved).toBe(2);
    expect(await desiredOf(w, one)).toBe(READS);
    expect(await desiredOf(w, two)).toBe(READS);
    expect(await desiredOf(w, evil), "`evil-x.example` is not `x.example`").toBe(OHBOX);
  });

  it("does nothing at all for a rule whose retroactive apply was DECLINED", async () => {
    const w = await newWorld();
    const id = await seedMessage(w, { from: "news@atelier.example" });
    const ruleId = await seedRule(w, { match: "news@atelier.example", destination: READS, retro: false });

    const res = await run(w);

    expect(res.rules).toBe(0);
    expect(res.moved).toBe(0);
    expect(await desiredOf(w, id)).toBe(OHBOX);
    expect((await ruleRow(w, ruleId)).retroDoneAt).toBeNull();
  });

  it("stamps `retro_done_at` only AFTER the work, and stops being owed", async () => {
    const w = await newWorld();
    await seedMessage(w, { from: "news@atelier.example" });
    const ruleId = await seedRule(w, { match: "news@atelier.example", destination: READS });

    expect((await ruleRow(w, ruleId)).retroDoneAt).toBeNull();
    const first = await run(w);
    expect(first.completed).toBe(1);

    const after = await ruleRow(w, ruleId);
    expect(after.retroDoneAt).not.toBeNull();
    expect(after.retroMoved).toBe(1);

    // No longer owed: a second cycle does not even pick it up.
    expect((await run(w)).rules).toBe(0);
  });

  it("the finished stamp is announced: one rule delta, and none from a run that stamps nothing", async () => {
    const w = await newWorld();
    await seedMessage(w, { from: "news@atelier.example" });
    const ruleId = await seedRule(w, { match: "news@atelier.example", destination: READS });
    const ruleDeltas = () => w.db.select({ op: changeLog.op }).from(changeLog)
      .where(and(eq(changeLog.accountId, w.accountId), eq(changeLog.entityType, "rule"), eq(changeLog.entityId, ruleId)));
    expect(await ruleDeltas()).toEqual([]);
    expect((await run(w)).completed).toBe(1);
    expect(await ruleDeltas(), "a client learns the pass finished only from a change row").toEqual([{ op: "update" }]);
    // Already stamped: a forced re-run finds the rule done and writes neither stamp nor delta.
    await run(w, { force: true });
    expect(await ruleDeltas()).toHaveLength(1);
  });
});

describe("running twice neither double-moves nor loses anything", () => {
  /**
   * ── THIS TEST WAS WRONG ONCE, AND THE MUTATION IS WHAT SAID SO ──────────────────────────
   *
   * Its first version ran the pass again with `force` and asserted zero writes. It passed — and
   * it went on passing with the candidate query's `desired_folder <> destination` predicate
   * DELETED, which is the entire idempotency of this pass. The reason is that `force` only
   * ignores the MARKER; `retro_cursor` still sat past every row, so the second run found nothing
   * to examine and proved only that a cursor skips rows it has already passed.
   *
   * So the claim is now made twice, and the second half is the one that bites. Resetting the
   * cursor is not a contrivance: it is exactly the state `RulesService.update` writes when a
   * rule is RETARGETED, which is the common path for a user changing their mind.
   */
  it("a re-run FROM THE START moves nothing again — the candidate query is the idempotency", async () => {
    const w = await newWorld();
    const a = await seedMessage(w, { from: "news@atelier.example" });
    const b = await seedMessage(w, { from: "news@atelier.example", folder: SCREENED });
    const ruleId = await seedRule(w, { match: "news@atelier.example", destination: READS });

    expect((await run(w)).moved).toBe(2);

    // (i) `force` alone: the marker is ignored, the cursor still skips. Cheap and true.
    const forced = await ruleRetroPass(
      w.db as unknown as Tx, { accountId: w.accountId, trustedAuthservIdsFor: NONE, force: true }, NOW,
    );
    expect(forced.moved).toBe(0);

    // (ii) The cursor reset too, so every message is offered to the query again. NOW the only
    // thing standing between this run and a second move of all of them is the predicate.
    await w.db.update(rules).set({ retroDoneAt: null, retroCursor: null })
      .where(eq(rules.id, ruleId));
    const again = await run(w);

    expect(again.examined, "an already-moved message must not even be a candidate").toBe(0);
    expect(again.moved, "the second run moved mail that was already there").toBe(0);
    expect(await movesFor(w, a), "one move, one `move` change — never two").toHaveLength(1);
    expect(await movesFor(w, b)).toHaveLength(1);
    expect(await desiredOf(w, a)).toBe(READS);
    expect(await desiredOf(w, b)).toBe(READS);
  });

  it("nothing is LOST: a message the first run could not take is still taken later", async () => {
    const w = await newWorld();
    const kept = await seedMessage(w, { from: "news@atelier.example" });
    // The user is mid-reply, so the first run must leave it alone.
    await w.db.insert(drafts).values({
      accountId: w.accountId, mailboxId: w.mailboxId, inReplyToMessageId: kept,
      subject: "re", body: "…", status: "draft",
    });
    await seedRule(w, { match: "news@atelier.example", destination: READS });

    expect((await run(w)).moved).toBe(0);
    expect(await desiredOf(w, kept)).toBe(OHBOX);

    // They abandon the draft. The rule is still on file, and a fresh request re-applies it —
    // the message was never dropped from the world, only from that run's candidate set.
    await w.db.delete(drafts).where(eq(drafts.inReplyToMessageId, kept));
    await w.db.update(rules).set({ retroDoneAt: null, retroCursor: null })
      .where(eq(rules.accountId, w.accountId));

    expect((await run(w)).moved).toBe(1);
    expect(await desiredOf(w, kept)).toBe(READS);
  });
});

describe("an interrupted run resumes", () => {
  /**
   * The interruption modelled here is the real one: the per-cycle WRITE BUDGET running out. The
   * pass stops mid-backlog, having committed everything it did, and the next cycle continues
   * from `retro_cursor`. A crash is the same shape with one page's work rolled back instead of
   * committed, which `rule-retro.pg.test.ts` covers where a real transaction can be aborted.
   */
  it("stops at the budget, leaves a cursor, and the next cycle finishes the rest", async () => {
    const w = await newWorld();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push(await seedMessage(w, { from: "news@atelier.example" }));
    const ruleId = await seedRule(w, { match: "news@atelier.example", destination: READS });

    const first = await run(w, { writesPerCycle: 2, batch: 2 });
    expect(first.moved).toBe(2);
    expect(first.capped).toBe(true);
    expect(first.completed, "a capped run must not claim it finished").toBe(0);

    const mid = await ruleRow(w, ruleId);
    expect(mid.retroDoneAt, "the marker is written LAST — a capped run has not earned it").toBeNull();
    expect(mid.retroCursor).not.toBeNull();
    expect(mid.retroMoved).toBe(2);

    // Exactly two are moved so far, and they are the two the cursor has passed.
    const movedSoFar = await Promise.all(ids.map((id) => desiredOf(w, id)));
    expect(movedSoFar.filter((f) => f === READS)).toHaveLength(2);

    const second = await run(w, { writesPerCycle: 2, batch: 2 });
    expect(second.moved).toBe(2);
    const third = await run(w, { writesPerCycle: 2, batch: 2 });
    expect(third.moved).toBe(1);
    expect(third.completed).toBe(1);

    for (const id of ids) expect(await desiredOf(w, id)).toBe(READS);
    // Five messages, five moves. Not six, and not four.
    const all = await Promise.all(ids.map((id) => movesFor(w, id)));
    expect(all.map((m) => m.length)).toEqual([1, 1, 1, 1, 1]);
    expect((await ruleRow(w, ruleId)).retroMoved).toBe(5);
  });

  /**
   * TERMINATION IS THE CURSOR, NOT AN EMPTY PAGE — and this is the test that says so.
   *
   * The idempotency predicate removes MOVED rows from the candidate set, so a pass that never
   * persisted a cursor would still finish a backlog it moves entirely. It would not finish one it
   * KEEPS: a message the router declines to move stays a candidate for ever, so page one returns
   * the same rows on every iteration and the pass spins until `maxPages` and reports truncation.
   *
   * A deny rule at a higher priority is the realistic way to have kept rows — the user has
   * already quarantined this sender, and the new allow rule does not outrank that.
   */
  it("makes progress over rows it KEEPS, instead of re-reading page one for ever", async () => {
    const w = await newWorld();
    for (let i = 0; i < 5; i++) {
      await seedMessage(w, { from: "news@atelier.example", folder: SCREENED });
    }
    await w.db.insert(rules).values({
      accountId: w.accountId, kind: "sender", match: "news@atelier.example",
      destination: SCREENED, priority: 10, provenance: "manual", enabled: true,
    });
    const ruleId = await seedRule(w, { match: "news@atelier.example", destination: READS });

    const res = await run(w, { batch: 2, maxPages: 10 });

    expect(res.kept, "five kept rows, each seen exactly once").toBe(5);
    expect(res.moved).toBe(0);
    expect(res.completed, "the backlog was walked to its end, so the rule is finished").toBe(1);
    expect((await ruleRow(w, ruleId)).retroDoneAt).not.toBeNull();
  });

  it("a rule REVOKED mid-run stops at the next page boundary and is not finished later", async () => {
    const w = await newWorld();
    for (let i = 0; i < 4; i++) await seedMessage(w, { from: "news@atelier.example" });
    const ruleId = await seedRule(w, { match: "news@atelier.example", destination: READS });

    expect((await run(w, { writesPerCycle: 2, batch: 2 })).moved).toBe(2);

    // The user revokes it in Settings → Rules between cycles.
    await w.db.update(rules).set({ enabled: false }).where(eq(rules.id, ruleId));

    const after = await run(w, { writesPerCycle: 2, batch: 2 });
    expect(after.rules, "a disabled rule is not owed work").toBe(0);
    expect(after.moved).toBe(0);
    // And the mail it already moved stays moved — revoking a rule has never un-filed mail
    // (`DELETE /rules/:id` touches only the rules row), and this pass does not change that.
    expect((await ruleRow(w, ruleId)).retroMoved).toBe(2);
  });
});

describe("a message the user has already acted on is not ours to move", () => {
  it("leaves a message the USER filed by hand (`last_set_by='external'`)", async () => {
    const w = await newWorld();
    const mine = await seedMessage(w, { from: "news@atelier.example", lastSetBy: "external" });
    await seedRule(w, { match: "news@atelier.example", destination: READS });

    expect((await run(w)).moved).toBe(0);
    // Not a preference: `reconcileFolders` SKIPS `lastSetBy !== 'us'`, so writing over this row
    // would be us reverting their own filing in their own mail client.
    expect(await desiredOf(w, mine)).toBe(OHBOX);
  });

  it("leaves a message the user TRIAGED", async () => {
    const w = await newWorld();
    const id = await seedMessage(w, { from: "news@atelier.example" });
    await w.db.insert(messageStates).values({
      accountId: w.accountId, messageId: id, state: "reply_later",
    });
    await seedRule(w, { match: "news@atelier.example", destination: READS });

    expect((await run(w)).moved).toBe(0);
    expect(await desiredOf(w, id)).toBe(OHBOX);
  });

  it("leaves a message with a DECIDED approval, but takes one with a merely PENDING one", async () => {
    const w = await newWorld();
    const decided = await seedMessage(w, { from: "news@atelier.example" });
    const pending = await seedMessage(w, { from: "news@atelier.example" });
    await w.db.insert(approvals).values({
      accountId: w.accountId, messageId: decided, kind: "routing", action: "file",
      status: "approved", payload: {},
    });
    await w.db.insert(approvals).values({
      accountId: w.accountId, messageId: pending, kind: "routing", action: "file",
      status: "pending", payload: {},
    });
    await seedRule(w, { match: "news@atelier.example", destination: READS });

    const res = await run(w);

    expect(res.moved).toBe(1);
    expect(await desiredOf(w, decided)).toBe(OHBOX);
    // A PENDING approval is something WE proposed and they have not answered. Counting it as
    // their intent would let the AI layer immunise mail from a rule they wrote by hand.
    expect(await desiredOf(w, pending)).toBe(READS);
  });

  it("leaves a message the user REPLIED to from their own mail client", async () => {
    const w = await newWorld();
    const [thread] = await w.db.insert(threads).values({
      accountId: w.accountId, subject: "a conversation",
    }).returning();
    const threadId = thread!.id;
    const inThread = await seedMessage(w, { from: "news@atelier.example", threadId });
    // Their own reply, sitting in the same thread, sent from the account's own address.
    const [mb] = await w.db.select({ address: mailboxes.address }).from(mailboxes)
      .where(eq(mailboxes.accountId, w.accountId));
    await seedMessage(w, { from: mb!.address, threadId, folder: "ohmail/Sent" });
    await seedRule(w, { match: "news@atelier.example", destination: READS });

    expect((await run(w)).moved).toBe(0);
    expect(await desiredOf(w, inThread)).toBe(OHBOX);
  });

  it("READ mail is NOT protected — reading is not consent", async () => {
    const w = await newWorld();
    const id = await seedMessage(w, { from: "news@atelier.example" });
    await w.db.update(messages).set({ unread: false }).where(eq(messages.id, id));
    await seedRule(w, { match: "news@atelier.example", destination: READS });

    // The report itself is an Ohbox full of READ mail that should have been filed.
    // Excluding it would leave behind precisely what this exists to move.
    expect((await run(w)).moved).toBe(1);
    expect(await desiredOf(w, id)).toBe(READS);
  });

  it("skips a DISABLED mailbox — nothing would ever reconcile a pending row written for it", async () => {
    const w = await newWorld();
    const id = await seedMessage(w, { from: "news@atelier.example" });
    await w.db.update(mailboxes).set({ status: "disabled" }).where(eq(mailboxes.id, w.mailboxId));
    await seedRule(w, { match: "news@atelier.example", destination: READS });

    expect((await run(w)).moved).toBe(0);
    expect(await desiredOf(w, id)).toBe(OHBOX);
  });
});

describe("it re-evaluates, it does not invert", () => {
  it("a higher-priority DENY rule still wins, and its mail is left where the deny put it", async () => {
    const w = await newWorld();
    const id = await seedMessage(w, { from: "news@atelier.example", folder: SCREENED });
    // The user has already quarantined this sender at a higher priority.
    await w.db.insert(rules).values({
      accountId: w.accountId, kind: "sender", match: "news@atelier.example",
      destination: SCREENED, priority: 10, provenance: "manual", enabled: true,
    });
    // …and now makes a lower-priority allow rule for the same sender.
    await seedRule(w, { match: "news@atelier.example", destination: READS });

    const res = await run(w);

    // The decision comes from `evaluateRules` over the whole rule set, not from the new rule.
    // A pass that applied its own understanding would be a second router.
    expect(res.moved).toBe(0);
    expect(res.kept).toBe(1);
    expect(await desiredOf(w, id)).toBe(SCREENED);
  });

  it("a `header` rule matches nothing rather than everything", async () => {
    const w = await newWorld();
    const id = await seedMessage(w, { from: "news@atelier.example" });
    await seedRule(w, { kind: "header", match: "List-Unsubscribe", destination: READS });

    // No surface can compose a header rule, and an omitted arm in `matchPredicate` would have
    // made this one match EVERY message in the account.
    const res = await run(w);
    expect(res.examined).toBe(0);
    expect(res.moved).toBe(0);
    expect(await desiredOf(w, id)).toBe(OHBOX);
  });
});

describe("a walk carries out only its own rule", () => {
  /* The reader's "→ News" press makes a sender rule with past mail OFF ("the rest of their mail here
     stays where it is"). A later rule on the same sender with a subject term and past mail ON walks
     the sender's letters; the untermed ones are decided by the first rule, whose backlog the person
     declined, and must stay where they are. */
  const PIET = "piet@x.invalid";
  const TERM = "refile check";

  it("a term rule's walk leaves the sender's other letters where they are", async () => {
    const w = await newWorld();
    const termed = await seedMessage(w, { from: PIET, subject: `News ${TERM}` });
    const other = await seedMessage(w, { from: PIET, subject: "Re: Draft agenda for Tuesday" });
    await seedRule(w, { match: PIET, destination: "ohmail/Receipts", retro: false });
    await seedRule(w, { match: PIET, subjectContains: TERM, destination: READS });

    const out = await run(w);

    expect(await desiredOf(w, termed), "the term rule's own letter was not filed").toBe(READS);
    expect(await desiredOf(w, other), "a declined backlog was filed by another rule's walk").toBe(OHBOX);
    expect(out.moved).toBe(1);
    expect(await movesFor(w, other)).toHaveLength(0);
  });

  it("with a mailbox this install only reads, later cycles still leave them", async () => {
    const w = await newWorld();
    await addMailbox(w, "reader");
    const termed = await seedMessage(w, { from: PIET, subject: `News ${TERM}` });
    const other = await seedMessage(w, { from: PIET, subject: "Re: Budget lines for Q4" });
    await seedRule(w, { match: PIET, destination: "ohmail/Receipts", retro: false });
    const termRule = await seedRule(w, { match: PIET, subjectContains: TERM, destination: READS });

    await run(w);
    // A letter arriving after the walk, and two more cycles with the rule still owed.
    const later = await seedMessage(w, { from: PIET, subject: "Notes from the call" });
    await run(w);
    const third = await run(w);

    expect(third.examined, "a finished walk re-walked the sender's mail every cycle").toBe(0);
    expect(await desiredOf(w, termed)).toBe(READS);
    expect(await desiredOf(w, other), "an owed walk filed a letter by another rule").toBe(OHBOX);
    expect(await desiredOf(w, later), "an owed walk filed a later letter by another rule").toBe(OHBOX);
    expect((await ruleRow(w, termRule)).retroDoneAt, "a reader is still outside the walk").toBeNull();
  });
});

describe("a press with past mail off ends an owed walk", () => {
  /* The rule's walk is parked behind a mailbox this install only reads. A later press on the sender
     says the rest of their mail stays where it is; a walk re-armed afterwards must not file it. */
  const PIET = "piet@x.invalid";
  const key = { kind: "sender", match: PIET, subjectContains: null, bodyContains: null };
  const inTx = <T>(w: World, f: (tx: Tx) => Promise<T>): Promise<T> =>
    w.db.transaction(async (tx) => f(carryDialect(w.db, tx as object) as unknown as Tx));
  const triggers: Record<string, (w: World, reader: string) => Promise<unknown>> = {
    promotion: (w, reader) => clearOrganizerStandDown(w.db as never, reader, { now: new Date(NOW.getTime() + 60_000) }),
    "reader disabled": (w, reader) => w.db.update(mailboxes).set({ status: "disabled" }).where(eq(mailboxes.id, reader)),
  };

  it.each(Object.keys(triggers))("a create over the rule leaves the rest in place after %s", async (trigger) => {
    const w = await newWorld();
    const reader = await addMailbox(w, "reader");
    const first = await seedMessage(w, { from: PIET, folder: "ohmail/Screener" });
    const ruleId = await seedRule(w, { match: PIET, destination: OHBOX });
    expect((await run(w)).moved).toBe(1);
    const rest = await seedMessage(w, { from: PIET, subject: "later" });

    await inTx(w, (tx) => reconcileRuleCreate(tx, {
      accountId: w.accountId, now: NOW,
      create: { op: "create", key, destination: READS, enabled: true, applyRetro: false },
    }));
    await triggers[trigger]!(w, reader);
    const out = await run(w);

    expect((await ruleRow(w, ruleId)).destination).toBe(READS);
    expect(out.moved, "a declined backlog was filed when the walk re-armed").toBe(0);
    expect(await desiredOf(w, rest)).toBe(OHBOX);
    expect(await desiredOf(w, first)).toBe(OHBOX);
  });

  it("a travelled re-point leaves what the walk filed after a promotion", async () => {
    const w = await newWorld();
    const reader = await addMailbox(w, "reader");
    const letter = await seedMessage(w, { from: PIET });
    await seedRule(w, { match: PIET, destination: READS });
    expect((await run(w)).moved).toBe(1);

    const res = await inTx(w, (tx) => applyRuleRequest(tx, {
      accountId: w.accountId, now: NOW,
      payload: { op: "update", key, set: { destination: "ohmail/Receipts" }, applyRetro: false, retroAsked: false },
    }));
    expect(res.applied).toBe(true);
    await triggers.promotion!(w, reader);

    expect((await run(w)).moved, "the re-pointed rule re-filed the walk's letters").toBe(0);
    expect(await desiredOf(w, letter)).toBe(READS);
  });
});

describe("the per-cycle write budget", () => {
  /**
   * THE CONSTANT IS ABOUT THE RECONCILER, NOT ABOUT THIS PASS, and this test says so where a
   * reader will find it. `reconcileFolders` walks an unbounded `listPendingFolderStates`
   * serially, one IMAP move per row, INSIDE the sync cycle; `beat()` is the last statement of
   * that cycle and `leaderStaleMs` is 120 000 ms. So a few hundred rows of pending desired state
   * make a healthy worker miss its heartbeat and page an operator — caused by a user clicking a
   * destination. The budget is what keeps a legitimate request from doing that.
   */
  it("writes no more than the budget in one cycle, however much mail matches", async () => {
    const w = await newWorld();
    for (let i = 0; i < 9; i++) await seedMessage(w, { from: "news@atelier.example" });
    await seedRule(w, { match: "news@atelier.example", destination: READS });

    const res = await run(w, { writesPerCycle: 3, batch: 100 });

    expect(res.moved).toBe(3);
    expect(res.capped).toBe(true);
    const moved = await w.db.select({ id: folderState.messageId }).from(folderState)
      .where(eq(folderState.desiredFolder, READS));
    expect(moved).toHaveLength(3);
  });

  it("spends one budget across SEVERAL owed rules rather than starving the later ones", async () => {
    const w = await newWorld();
    await seedMessage(w, { from: "a@one.example" });
    await seedMessage(w, { from: "b@two.example" });
    await seedRule(w, { match: "a@one.example", destination: READS });
    await seedRule(w, { match: "b@two.example", destination: READS });

    const res = await run(w, { writesPerCycle: 10, batch: 100 });
    expect(res.rules).toBe(2);
    expect(res.moved).toBe(2);
    expect(res.completed).toBe(2);
  });
});

describe("the pass is account-scoped", () => {
  it("never reaches another account's mail, even for an identical sender", async () => {
    const mine = await newWorld();
    // A second account inside the SAME database, with the same sender and the same rule.
    const otherAccountId = randomUUID();
    await mine.db.insert(accounts).values({ id: otherAccountId, name: "other" });
    const [otherMb] = await mine.db.insert(mailboxes).values({
      accountId: otherAccountId, provider: "imap", address: "them@ohmail.test",
    }).returning();
    const other: World = { db: mine.db, accountId: otherAccountId, mailboxId: otherMb!.id };
    const theirs = await seedMessage(other, { from: "news@atelier.example" });

    const ours = await seedMessage(mine, { from: "news@atelier.example" });
    await seedRule(mine, { match: "news@atelier.example", destination: READS });

    const res = await run(mine);

    expect(res.moved).toBe(1);
    expect(await desiredOf(mine, ours)).toBe(READS);
    // The "Account isolation is absolute, and it binds staff too" invariant is absolute and it binds a background pass exactly as it binds a route.
    expect(await desiredOf(other, theirs)).toBe(OHBOX);
  });
});

describe("a known sender is not re-screened by a rule that says Ohbox", () => {
  it("moves an allow-ruled sender's mail INTO the Ohbox", async () => {
    const w = await newWorld();
    await w.db.insert(contacts).values({ accountId: w.accountId, address: "lena@atelier.example" });
    const id = await seedMessage(w, { from: "lena@atelier.example", folder: SCREENED });
    await seedRule(w, { match: "lena@atelier.example", destination: OHBOX });

    expect((await run(w)).moved).toBe(1);
    expect(await desiredOf(w, id)).toBe(OHBOX);
  });
});

describe("`'peer'`: a READER's adoption is reachable, and only by a press", () => {
  /**
   * WHY THIS PASS ADMITS A VALUE THE OTHER THREE REFUSE.
   *
   * A message a READER adopted in a folder ohmail organizes is stamped `'peer'` — another install
   * of this account placed it (`pipeline.ts#readerAdoption`). It used to be stamped `'external'`,
   * which says the person filed it by hand and means "hands off, for ever" to every mover; mail
   * sitting at the gate behind a rule its owner had already written could therefore never be
   * reached by that rule.
   *
   * This is the ONLY pass that admits it, and the reason is the press: a rule is owed a retro only
   * because somebody asked for it to reach mail already on disk. `ohbox-tidy` and `screener-auto`
   * run unbidden — admitting `'peer'` there would make a promotion re-file the other install's
   * placements in bulk, which is the shape the import hold exists to refuse. Their halves of this
   * control, and the transactional half of this one, live in the `.pg.test.ts` files.
   *
   * `'external'` is asserted alongside in every case below. That is the whole reason a THIRD value
   * exists rather than a widened `!= 'external'`: a person dragging a message into a folder in
   * Apple Mail arrives at this table looking identical to a reader's adoption, and their hand
   * still wins.
   */

  it("a `peer` row is moved by a requested retro; an `external` row beside it is not", async () => {
    const w = await newWorld();
    const peer = await seedMessage(w, { from: "ruled@x.invalid", folder: SCREENED, lastSetBy: "peer" });
    const byHand = await seedMessage(w, { from: "ruled@x.invalid", folder: SCREENED, lastSetBy: "external" });
    const ours = await seedMessage(w, { from: "ruled@x.invalid", folder: SCREENED, lastSetBy: "us" });
    await seedRule(w, { match: "ruled@x.invalid", destination: READS, retro: true });

    const res = await run(w);

    expect(res.moved, "the pass moved neither the peer row nor our own").toBe(2);
    expect(await desiredOf(w, peer), "a reader's adoption is out of reach of the rule its owner wrote").toBe(READS);
    expect(await desiredOf(w, ours)).toBe(READS);
    expect(await desiredOf(w, byHand), "the user's own hand-filing was overwritten").toBe(SCREENED);
    expect((await movesFor(w, byHand)).length).toBe(0);
  });

  it("a moved `peer` row becomes OURS — it is this install's decision once the press lands", async () => {
    const w = await newWorld();
    const peer = await seedMessage(w, { from: "ruled@x.invalid", folder: SCREENED, lastSetBy: "peer" });
    await seedRule(w, { match: "ruled@x.invalid", destination: READS, retro: true });

    await run(w);

    const [row] = await w.db.select().from(folderState).where(eq(folderState.messageId, peer));
    expect(row!.lastSetBy, "a row this pass re-filed is ours to reconcile").toBe("us");
    expect(row!.desiredFolder).toBe(READS);
  });

  it("NO PRESS, NO MOVE: an enabled rule with no retro requested leaves a `peer` row alone", async () => {
    /* The promotion case. Every rule that already existed when an install is promoted is either
       done or never requested, so promotion itself moves nothing — which is what stops this from
       becoming a bulk re-filing of the other install's placements one handover later.

       Asserted with a POSITIVE control in the same world: the identical rule, once its retro IS
       requested, moves the identical row. Without that this passes on a pass that can do nothing. */
    const w = await newWorld();
    const peer = await seedMessage(w, { from: "ruled@x.invalid", folder: SCREENED, lastSetBy: "peer" });
    const ruleId = await seedRule(w, { match: "ruled@x.invalid", destination: READS, retro: false });

    const quiet = await run(w);
    expect(quiet.moved).toBe(0);
    expect(await desiredOf(w, peer)).toBe(SCREENED);
    expect((await movesFor(w, peer)).length).toBe(0);

    await w.db.update(rules).set({ retroRequestedAt: new Date("2026-08-04T10:00:00Z") })
      .where(eq(rules.id, ruleId));
    const pressed = await run(w);
    expect(pressed.moved, "the press is what moves it — otherwise the case above is vacuous").toBe(1);
    expect(await desiredOf(w, peer)).toBe(READS);
  });

  /**
   * ── THE ROW MAIL 0100 RE-STAMPED, AND WHOSE LICENCE IS THE RULE'S OWN ANSWER ──────────────
   *
   * `0100_reader_window_peer_restamp.sql` re-stamps settled `'external'` rows inside the ohmail
   * namespace to `'peer'`, because a reader's adoption had been recorded as if a person had filed
   * it by hand. Those rows then look exactly like any other `'peer'` row to the query above — which
   * is the gap row READER-WINDOW-BACKFILL-RESTAMP-MAKES-ROWS-RULE-RETRO-ELIGIBLE, filed because
   * that happened silently.
   *
   * The ruling, and what 0.19 makes true: a re-stamped row moves for a rule whose past-mail option
   * is ON — that is what the person asked for — and never for one whose option is OFF. The licence
   * is `retro_requested_at`, written by exactly four doors, each of them a press that carries the
   * option: `POST /rules`, a retarget PATCH, an explicit `applyRetro: true` on an unmoved rule, and
   * the Screener decide. A rule nobody asked is never even SELECTED (`owedFilters`), so the mail
   * stays where the other install put it.
   *
   * Both arms in one world, because either alone passes on a pass that can do nothing.
   */
  it("a row the 0100 backfill re-stamped moves only under a rule whose past-mail option was ON", async () => {
    const w = await newWorld();
    // As the migration leaves it: recorded `'external'`, settled inside the ohmail namespace, then
    // re-stamped. Seeded in two steps so the row's history is the migration's, not an assumption.
    const restamped = await seedMessage(w, { from: "ruled@x.invalid", folder: SCREENED, lastSetBy: "external" });
    await w.db.update(folderState).set({ lastSetBy: "peer" })
      .where(eq(folderState.messageId, restamped));

    // OFF: the person made a rule and declined the backlog, so nothing ever asked for this row.
    const ruleId = await seedRule(w, { match: "ruled@x.invalid", destination: READS, retro: false });
    const declined = await run(w);
    // BOTH gates, because the licence is enforced twice and either alone is a no-op mutation: the
    // owed probe never SELECTS the rule (`rules`), and the per-page re-read under the rule's own
    // lock would refuse it again (`moved`). Mutating one line leaves the other holding.
    expect(declined.rules, "an unasked rule is not even selected").toBe(0);
    expect(declined.moved, "…and no re-stamped row is reached").toBe(0);
    expect(await desiredOf(w, restamped)).toBe(SCREENED);
    expect((await movesFor(w, restamped)).length).toBe(0);

    // ON: the same rule, the same row, once the option is answered yes.
    await w.db.update(rules).set({ retroRequestedAt: new Date("2026-08-04T10:00:00Z") })
      .where(eq(rules.id, ruleId));
    const asked = await run(w);
    expect(asked.moved, "the option is what moves it — otherwise the arm above is vacuous").toBe(1);
    expect(await desiredOf(w, restamped)).toBe(READS);
  });

  it("A STRANGER'S `peer` IMBOX ROW IS NEVER SCREENED AFTERWARDS, and that is correct", async () => {
    /* The consent direction, and the sentence this lane originally got wrong. The gate is the
       ARRIVAL moment: either another organizer held the lease and its gate ran — the same human's
       consent — or nobody held it, which the dual-mode design names as the safe failure. A
       retroactive sweep of the Imbox into the Screener on promotion is exactly the re-screen the
       import hold refuses.

       No rule names this sender, so the pass has nothing owed about them; the assertion is that a
       requested retro for a DIFFERENT sender walks past them without touching them. */
    const w = await newWorld();
    const stranger = await seedMessage(w, { from: "stranger@y.invalid", folder: OHBOX, lastSetBy: "peer" });
    const ruled = await seedMessage(w, { from: "ruled@x.invalid", folder: SCREENED, lastSetBy: "peer" });
    await seedRule(w, { match: "ruled@x.invalid", destination: READS, retro: true });

    await run(w);

    expect(await desiredOf(w, ruled), "the ruled sender's row is the premise — it must have moved").toBe(READS);
    expect(await desiredOf(w, stranger)).toBe(OHBOX);
    expect((await movesFor(w, stranger)).length).toBe(0);
  });

  it("A PRESS THIS INSTALL CANNOT ACT ON STAYS OWED — it is not silently marked done", async () => {
    /* The owed probe is per ACCOUNT; the candidate query is per MAILBOX. Before the `exists` clause
       in `owedFilters`, an account whose mailbox this install does not organize selected the rule,
       walked zero candidates, read the short page as the end of the backlog and stamped
       `retro_done_at` — so promoting the install afterwards honoured nothing. What that cost is a
       PRESS: `retro_requested_at` is set only because somebody ticked "apply to existing mail", and
       they were told nothing.

       It also corrects a stated expectation: the rule was believed to stay owed because the
       `organizer_role` gate held it. That gate holds the CANDIDATES, never the rule.

       BOTH HALVES, because either alone is worthless: "nothing moved" is what a broken pass also
       looks like, and "the rule fires" says nothing about the window. */
    const w = await newWorld();
    const peer = await seedMessage(w, { from: "ruled@x.invalid", folder: SCREENED, lastSetBy: "peer" });
    const ours = await seedMessage(w, { from: "ruled@x.invalid", folder: OHBOX, lastSetBy: "us" });
    const ruleId = await seedRule(w, { match: "ruled@x.invalid", destination: READS, retro: true });
    await w.db.update(mailboxes).set({ organizerRole: "reader" }).where(eq(mailboxes.id, w.mailboxId));

    const whileReading = await run(w);

    expect(whileReading.moved).toBe(0);
    expect(whileReading.rules, "the rule must not even be selected — being unselected is the only "
      + "state a later promotion can still honour").toBe(0);
    expect((await ruleRow(w, ruleId)).retroDoneAt,
      "the press was consumed while this install could not look").toBeNull();
    expect(await desiredOf(w, peer)).toBe(SCREENED);
    expect((await movesFor(w, peer)).length).toBe(0);

    // …and the press is honoured the moment this install organizes again.
    await w.db.update(mailboxes).set({ organizerRole: "organizer" }).where(eq(mailboxes.id, w.mailboxId));
    const promoted = await run(w);

    expect(promoted.moved, "the same press, once this install organizes again").toBe(2);
    expect(await desiredOf(w, peer)).toBe(READS);
    expect(await desiredOf(w, ours)).toBe(READS);
    expect((await ruleRow(w, ruleId)).retroDoneAt,
      "and only NOW is the backlog genuinely finished").not.toBeNull();
  });
});

describe("a rule's backlog is finished PER MAILBOX, or it is not finished", () => {
  /**
   * THE SECOND HALF OF "A PRESS THIS INSTALL CANNOT ACT ON STAYS OWED", AND IT IS A DIFFERENT BUG.
   *
   * The `exists` clause in `owedFilters` holds a rule owed while this install organizes NONE of
   * the account's mailboxes. An account can hold several, and one organized mailbox is enough for
   * the rule to be selected — so on an account where we organize A and only READ B, the pass
   * walked A to its end and wrote ONE account-wide `retro_done_at`. B's mail was never a candidate
   * (the candidate query's `organizer_role` gate), and promoting B afterwards honoured nothing,
   * because nothing was owed any more. Same swallowed PRESS, one mailbox further in, and invisible
   * in every case above because `newWorld` connects a single mailbox.
   *
   * TWO assertions per case, because either alone is worthless:
   *
   *  · the STAMP is withheld — otherwise there is nothing to promote into;
   *  · the CURSOR is cleared — `retro_cursor` is a `messages.id`, `messages.id` is a random uuid,
   *    so the cursor is a fence across the id space and not a point in time. Holding the rule owed
   *    with A's cursor in place would honour the press for whichever of B's messages happen to sort
   *    ABOVE it. Both ids below are chosen for exactly that: B's row sits BELOW the fence A's walk
   *    leaves behind, so a fix that only withheld the stamp still loses B's mail.
   *
   * And a positive control on the other side: a DISABLED mailbox is not live, does not contribute
   * candidates, and must NOT hold the press open — otherwise this fix would leave every account
   * that ever disconnected a mailbox with a rule that can never finish. The single-mailbox account
   * is controlled by `stamps \`retro_done_at\` only AFTER the work` above.
   */

  /** Sorts LAST: the fence A's walk leaves in `retro_cursor`. */
  const HIGH_ID = "ffffffff-ffff-4fff-8fff-ffffffffffff";
  /** Sorts FIRST: B's mail, below the fence. */
  const LOW_ID = "00000000-0000-4000-8000-000000000001";

  it("does NOT stamp done while a live mailbox of the account is one we only READ", async () => {
    const w = await newWorld();
    const readerMb = await addMailbox(w, "reader");
    const ours = await seedMessage(w, {
      from: "ruled@x.invalid", folder: OHBOX, lastSetBy: "us", id: HIGH_ID,
    });
    // `peer` because that is what a reader records for the placement it adopts — the row shape
    // this pass exists to reach once a press lands.
    const theirs = await seedMessage(w, {
      from: "ruled@x.invalid", folder: OHBOX, lastSetBy: "peer", id: LOW_ID, mailboxId: readerMb,
    });
    const ruleId = await seedRule(w, { match: "ruled@x.invalid", destination: READS });

    const out = await run(w);

    expect(out.moved, "the organized mailbox's mail is the premise — it must have moved").toBe(1);
    expect(out.completed, "a backlog with a mailbox still outside the walk is not finished").toBe(0);
    expect(await desiredOf(w, ours)).toBe(READS);
    expect(await desiredOf(w, theirs), "a reader's mailbox is not a candidate").toBe(OHBOX);

    const after = await ruleRow(w, ruleId);
    expect(after.retroDoneAt,
      "the press was consumed for a mailbox this install cannot look at").toBeNull();
    expect(after.retroCursor,
      "the walk's own fence was left standing over the mail below it").not.toBe(HIGH_ID);

    // Still owed, and being owed is the only state a later promotion can honour; but the walk is
    // finished for the mailbox we organize, so the next cycle does not walk it again.
    const again = await run(w);
    expect(again.rules, "the rule stopped being owed").toBe(1);
    expect(again.examined, "a finished walk re-walked the organized mailbox's mail").toBe(0);
  });

  it("a parked walk re-armed by a promotion with nothing left to move is finished, not parked again", async () => {
    const w = await newWorld();
    const readerMb = await addMailbox(w, "reader");
    await seedMessage(w, { from: "ruled@x.invalid", folder: OHBOX, lastSetBy: "us" });
    const ruleId = await seedRule(w, { match: "ruled@x.invalid", destination: READS });
    expect((await run(w)).moved).toBe(1);

    await w.db.update(mailboxes).set({ organizerRole: "organizer" }).where(eq(mailboxes.id, readerMb));
    const after = await run(w);

    expect(after.completed, "the re-armed walk never finished").toBe(1);
    expect((await ruleRow(w, ruleId)).retroDoneAt).not.toBeNull();
    expect((await run(w)).rules, "a finished rule is still owed").toBe(0);
  });

  it("a PARTIAL promotion re-arms the finished walk while another mailbox is still a reader", async () => {
    // Two readers; one comes under this install by a flip that only stamps `organizer_event_at`.
    const w = await newWorld();
    const promotedMb = await addMailbox(w, "reader");
    await addMailbox(w, "reader");
    await seedMessage(w, { from: "ruled@x.invalid", subject: "zz term", lastSetBy: "us", id: HIGH_ID });
    const theirs = await seedMessage(w, {
      from: "ruled@x.invalid", subject: "zz term", lastSetBy: "peer", id: LOW_ID, mailboxId: promotedMb,
    });
    // A letter the walk examines and keeps, so a re-walk shows in `examined`.
    await seedMessage(w, { from: "ruled@x.invalid", subject: "other" });
    const ruleId = await seedRule(w, { match: "ruled@x.invalid", subjectContains: "zz term", destination: READS });

    expect((await run(w)).moved).toBe(1);
    expect((await run(w)).examined, "the finished walk ran again before anything changed").toBe(0);

    await w.db.update(mailboxes)
      .set({ organizerRole: "organizer", organizerEventAt: new Date(NOW.getTime() + 60_000) })
      .where(eq(mailboxes.id, promotedMb));
    const promoted = await ruleRetroPass(
      w.db as unknown as Tx, { accountId: w.accountId, trustedAuthservIdsFor: NONE },
      new Date(NOW.getTime() + 120_000),
    );

    expect(promoted.moved, "the promoted mailbox's mail was never reconsidered").toBe(1);
    expect(await desiredOf(w, theirs)).toBe(READS);
    expect((await ruleRow(w, ruleId)).retroDoneAt, "a reader is still outside the walk").toBeNull();
    const later = await ruleRetroPass(
      w.db as unknown as Tx, { accountId: w.accountId, trustedAuthservIdsFor: NONE },
      new Date(NOW.getTime() + 180_000),
    );
    expect(later.examined, "the same promotion re-armed the walk again").toBe(0);
  });

  it("PROMOTION honours the press for the mail BELOW the first walk's cursor", async () => {
    const w = await newWorld();
    const readerMb = await addMailbox(w, "reader");
    const ours = await seedMessage(w, {
      from: "ruled@x.invalid", folder: OHBOX, lastSetBy: "us", id: HIGH_ID,
    });
    const theirs = await seedMessage(w, {
      from: "ruled@x.invalid", folder: OHBOX, lastSetBy: "peer", id: LOW_ID, mailboxId: readerMb,
    });
    const ruleId = await seedRule(w, { match: "ruled@x.invalid", destination: READS });

    expect((await run(w)).moved).toBe(1);

    // The lease comes to us. Nothing else changes: the same rule, the same press, the same mail.
    await w.db.update(mailboxes).set({ organizerRole: "organizer" })
      .where(eq(mailboxes.id, readerMb));
    const promoted = await run(w);

    expect(promoted.moved, "the promoted mailbox's mail was never reconsidered").toBe(1);
    expect(await desiredOf(w, theirs)).toBe(READS);
    expect(await desiredOf(w, ours), "the first walk's work is not undone").toBe(READS);
    expect((await movesFor(w, theirs)), "one move, one `move` change").toHaveLength(1);
    expect((await movesFor(w, ours)), "the already-moved row must not move twice").toHaveLength(1);

    const after = await ruleRow(w, ruleId);
    expect(after.retroDoneAt, "and NOW every mailbox has been walked").not.toBeNull();
    expect(after.retroMoved, "both mailboxes' moves are counted").toBe(2);

    // And it is finished for good: the next cycle does not pick it up.
    expect((await run(w)).rules).toBe(0);
  });

  it("POSITIVE CONTROL — a DISABLED mailbox does not hold the press open", async () => {
    /* The other direction, and the one a fix like this breaks quietly. A disabled mailbox is one
       nothing will ever reconcile, so it contributes no candidates — and it must therefore not
       count as mail we still owe a look, or an account that ever disconnected a mailbox would
       carry a rule that can never finish and re-walks its kept rows every cycle for ever. */
    const w = await newWorld();
    const goneMb = await addMailbox(w, "organizer", "disabled");
    const ours = await seedMessage(w, { from: "ruled@x.invalid", folder: OHBOX, lastSetBy: "us" });
    const stranded = await seedMessage(w, {
      from: "ruled@x.invalid", folder: OHBOX, lastSetBy: "us", mailboxId: goneMb,
    });
    const ruleId = await seedRule(w, { match: "ruled@x.invalid", destination: READS });

    const out = await run(w);

    expect(out.completed, "a disabled mailbox held the backlog open").toBe(1);
    expect(await desiredOf(w, ours)).toBe(READS);
    expect(await desiredOf(w, stranded), "a disabled mailbox is not a candidate either").toBe(OHBOX);
    expect((await ruleRow(w, ruleId)).retroDoneAt).not.toBeNull();
  });

  it("a READER mailbox that is also DISABLED is not live — the two clauses are one question",
    async () => {
      /* The clause is `status <> 'disabled' AND organizer_role <> 'organizer'`, and a row that is
         both is the case where reading it as an OR would hold the press open for a mailbox nothing
         can ever reconcile. */
      const w = await newWorld();
      await addMailbox(w, "reader", "disabled");
      await seedMessage(w, { from: "ruled@x.invalid", folder: OHBOX, lastSetBy: "us" });
      const ruleId = await seedRule(w, { match: "ruled@x.invalid", destination: READS });

      expect((await run(w)).completed).toBe(1);
      expect((await ruleRow(w, ruleId)).retroDoneAt).not.toBeNull();
    });

  it("`force` on a FINISHED rule still resets nothing — the flag's promise about the cursor",
    async () => {
      /* `RuleRetroDeps.force` says in words that it is not a "re-apply everything" switch and that
         the cursor is unchanged by it. The withheld-stamp arm above writes `retro_cursor = null`,
         so the arm has to be unreachable for a rule that is already done — otherwise `force`
         became the re-apply switch its docblock refuses to be. */
      const w = await newWorld();
      await addMailbox(w, "reader");
      await seedMessage(w, { from: "ruled@x.invalid", folder: OHBOX, lastSetBy: "us" });
      const ruleId = await seedRule(w, { match: "ruled@x.invalid", destination: READS });

      await run(w);
      // Stand the rule down as finished, with a cursor, exactly as a single-mailbox account ends up.
      await w.db.update(rules).set({ retroDoneAt: NOW, retroCursor: HIGH_ID })
        .where(eq(rules.id, ruleId));

      const forced = await ruleRetroPass(
        w.db as unknown as Tx,
        { accountId: w.accountId, trustedAuthservIdsFor: NONE, force: true },
        NOW,
      );

      expect(forced.moved).toBe(0);
      const after = await ruleRow(w, ruleId);
      expect(after.retroCursor, "`force` moved the cursor of a finished rule").toBe(HIGH_ID);
      expect(after.retroDoneAt).not.toBeNull();
    });
});

describe("a person's own drag survives a rule pressed afterwards", () => {
  /**
   * THE TWO HALVES OF ONE SEQUENCE, DRIVEN THROUGH BOTH OF THEM.
   *
   * The pipeline decides WHAT to record for a placement a reader observes; this pass decides which
   * recorded values it may move. Each half is asserted in its own package
   * (`packages/core/test/pipeline.reader-organized-arrival.test.ts` for the write,
   * `a `peer` row is moved by a requested retro; an `external` row beside it is not` above for the
   * read) — and each half was green while the pair was broken, because they agreed about the WORD
   * and not about the case:
   *
   *   the person drags a message out of `ohmail/News` back into `INBOX` in Apple Mail while this
   *   install is a READER. `INBOX` is one of the six folders ohmail organizes, so the reader
   *   recorded another install's placement (`'peer'`) for the person's own hand — and `'peer'` is
   *   the one non-`us` value this pass admits, so the next rule they pressed moved it back out.
   *
   * So the case below runs the REAL ingest (`planChange` / `commitChange` over the drizzle repo)
   * for the arrival and for the drag, then this pass over the same database. Nothing is hand-seeded:
   * the value under test is the value the pipeline actually writes.
   */

  const eml = (messageId: string, from: string) => Buffer.from([
    `Message-ID: <${messageId}>`,
    `From: Anchor Digest <${from}>`,
    "To: me@ohmail.test",
    "Subject: field report",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "the winter build is out.",
  ].join("\r\n"));

  const create = (folder: string, raw: Buffer, ref: string): Change =>
    ({ type: "create", locator: { folder, ref }, raw, seen: false });
  /**
   * A CORRELATED MOVE, which is the only shape that adopts.
   *
   * An identical message merely APPEARING elsewhere is a second copy (`external_copy`) and
   * `permitsAdoption` refuses it on purpose — delivering a copy of a message we hold is something
   * a stranger can do. The adapter's `correlateMoves` produces this shape for a real drag.
   */
  const moved = (folder: string, raw: Buffer, ref: string): Change =>
    ({ type: "move", locator: { folder, ref }, raw, seen: false });

  /**
   * ONE REAL INGEST — plan and commit, inside a transaction, as a READER.
   *
   * The transaction is not decoration: `recordChange` allocates the account's `change_log` seq and
   * `commitChange` refuses a top-level handle by name, because an auto-committed allocation lets a
   * polling client advance past a seq whose row is not written yet. The worker's cycle opens the
   * same transaction around the same two calls.
   */
  const readerIngest = (w: World, change: Change) => w.db.transaction(async (tx) => {
    const repo = makeDrizzleRepo(tx as never);
    const deps = { repo, accountId: w.accountId, mailboxId: w.mailboxId, readerMode: true };
    const plan = await planChange(change, deps);
    return commitChange(plan, {
      storageCap: UNMETERED_STORAGE_CAP, repo, accountId: w.accountId, mailboxId: w.mailboxId,
    });
  });

  it("a drag from Reads to the IMBOX is `external`, and a later retro rule leaves it there",
    async () => {
      const w = await newWorld();
      const raw = eml("drag-1@x.invalid", "news@atelier.example");

      // 1. While this install READS the mailbox, the message is where the organizer filed it.
      const arrived = await readerIngest(w, create(READS, raw, "8:1"));
      const [afterArrival] = await w.db.select().from(folderState)
        .where(eq(folderState.messageId, arrived.messageId));
      expect(afterArrival!.lastSetBy,
        "the premise: a reader records the organizer's placement as a peer's").toBe("peer");

      // 2. The person drags it back into their inbox, in their own mail client.
      const dragged = await readerIngest(w, moved(OHBOX, raw, "1:1"));
      expect(dragged.messageId, "the drag was ingested as a second message instead of adopted")
        .toBe(arrived.messageId);
      const [afterDrag] = await w.db.select().from(folderState)
        .where(eq(folderState.messageId, arrived.messageId));
      expect(afterDrag!.lastSetBy, "the person's own hand was recorded as another install's")
        .toBe("external");
      expect(afterDrag!.desiredFolder).toBe(OHBOX);
      // The adoption's OWN delta, so the mirror follows the person's folders. It is the baseline
      // the assertion below compares against — this pass must add nothing to it.
      const adoptionMoves = await movesFor(w, arrived.messageId);
      expect(adoptionMoves.map((m) => m.meta)).toEqual([{ from: READS, to: OHBOX }]);

      // 3. The lease comes back to this install and they press "apply to existing mail" on a rule
      //    that files this sender into Reads — the same rule whose earlier press put it there.
      await seedRule(w, { match: "news@atelier.example", destination: READS, retro: true });
      const res = await run(w);

      expect(await desiredOf(w, arrived.messageId),
        "a rule pressed afterwards undid the person's own filing").toBe(OHBOX);
      expect(res.moved).toBe(0);
      expect(await movesFor(w, arrived.messageId),
        "the pass wrote a move of its own over the person's placement").toEqual(adoptionMoves);
    });

  it("POSITIVE CONTROL — the identical rule DOES move a message the reader adopted at the gate",
    async () => {
      /* Without this the case above is satisfied by a pass that cannot move anything through the
         real ingest path — a fixture failure wearing the fix's clothes. Same ingest, same rule; the
         only difference is that nobody dragged this one, so the row is still `'peer'`. */
      const w = await newWorld();
      const raw = eml("gate-1@x.invalid", "news@atelier.example");

      const arrived = await readerIngest(w, create(SCREENED, raw, "7:1"));
      const [state] = await w.db.select().from(folderState)
        .where(eq(folderState.messageId, arrived.messageId));
      expect(state!.lastSetBy).toBe("peer");

      await seedRule(w, { match: "news@atelier.example", destination: READS, retro: true });
      const res = await run(w);

      expect(res.moved, "the press moved nothing at all — the case above proves nothing").toBe(1);
      expect(await desiredOf(w, arrived.messageId)).toBe(READS);
    });
});

describe("the completion decision is ONE statement, so a promotion cannot split it", () => {
  /**
   * THE WINDOW BETWEEN TWO WRITES THAT EACH ASKED THE MAILBOXES SEPARATELY.
   *
   * Completion used to be two `UPDATE`s: one that stamps `retro_done_at` unless a live mailbox is
   * outside the walk, and one that clears `retro_cursor` when a live mailbox IS. Each is right on
   * its own and the pair is not, because the state they ask about can move between them:
   *
   *   1. the stamp is withheld — B is still a reader;
   *   2. B is PROMOTED (a lease claim, or somebody pressing "Organize here");
   *   3. the reset asks the same question, now gets `false`, and KEEPS the cursor.
   *
   * The rule is owed with the fence standing. `messages.id` is a random uuid, so the next pass
   * walks only the part of B's mail sorting ABOVE it, reads that as the end of the backlog — every
   * mailbox is organized now — and stamps. B's older mail is never filed and nothing says so.
   *
   * The seam is REAL and this drives it: the pass reaches `mailboxes` only through the handle it is
   * given, and the outer handle's `update` is used for exactly one thing — the completion decision
   * (every page write goes through the page's `tx`). So a handle that promotes B when the first
   * such `update` resolves lands the promotion precisely in the old window, and nowhere else.
   *
   * The assertion is the PRODUCT outcome, not the cursor: B's older matching mail is filed. A
   * cursor assertion would pass for a fix that cleared the fence and stopped honouring the press.
   */

  /** Sorts LAST — the fence A's walk leaves behind. */
  const HIGH_ID = "ffffffff-ffff-4fff-8fff-fffffffffffe";
  /** Sorts FIRST — B's mail, below the fence. */
  const LOW_ID = "00000000-0000-4000-8000-000000000002";

  /**
   * The pass's own db handle, with ONE side effect wired in after the completion decision.
   *
   * The decision is the one transaction whose FIRST statement is an `update` (every page opens
   * with its `select … for update`), and `after` runs when that transaction has COMMITTED — after
   * the whole one-statement decision and its rule delta, never inside the transaction, where an
   * outer write would wait on it. Everything else is forwarded untouched.
   */
  function handleThatPromotesAfterTheFirstUpdate(db: World["db"], after: () => Promise<void>) {
    let fired = false;
    return new Proxy(db as unknown as object, {
      get(t, prop, recv) {
        const v = Reflect.get(t, prop, recv);
        if (prop === "transaction") {
          return async (cb: (tx: unknown) => Promise<unknown>, ...rest: unknown[]) => {
            let first: string | symbol | null = null;
            const out = await (v as (...a: unknown[]) => Promise<unknown>).call(t, (tx: object) => cb(new Proxy(tx, {
              get(tt, p2, r2) {
                if (first === null && ["select", "update", "insert", "delete", "execute"].includes(String(p2))) first = p2;
                const f = Reflect.get(tt, p2, r2);
                return typeof f === "function" ? (f as (...a: unknown[]) => unknown).bind(tt) : f;
              },
            })), ...rest);
            if (first === "update" && !fired) { fired = true; await after(); }
            return out;
          };
        }
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
      },
    }) as World["db"];
  }

  it("B PROMOTED BETWEEN the two former writes — its older mail is still filed", async () => {
    const w = await newWorld();
    const readerMb = await addMailbox(w, "reader");
    const ours = await seedMessage(w, {
      from: "ruled@x.invalid", folder: OHBOX, lastSetBy: "us", id: HIGH_ID,
    });
    const theirs = await seedMessage(w, {
      from: "ruled@x.invalid", folder: OHBOX, lastSetBy: "peer", id: LOW_ID, mailboxId: readerMb,
    });
    const ruleId = await seedRule(w, { match: "ruled@x.invalid", destination: READS });

    let promotions = 0;
    const handle = handleThatPromotesAfterTheFirstUpdate(w.db, async () => {
      promotions++;
      await w.db.update(mailboxes).set({ organizerRole: "organizer" })
        .where(eq(mailboxes.id, readerMb));
    });

    const raced = await ruleRetroPass(
      handle as unknown as Tx,
      { accountId: w.accountId, trustedAuthservIdsFor: NONE }, NOW,
    );

    // THE PREMISE, asserted before anything else: the promotion really did land inside the pass.
    // Without it this case passes on a hook that never fired, which is the shape of a guard that
    // cannot fail.
    expect(promotions, "the completion decision never issued an update — nothing was raced").toBe(1);
    expect(raced.moved, "the organized mailbox's mail is the premise — it must have moved").toBe(1);
    expect(await desiredOf(w, ours)).toBe(READS);

    // The next cycle, with B organized: whatever the race did to the row, the press must still
    // reach the mail it was made for.
    const next = await run(w);

    expect(await desiredOf(w, theirs),
      "B's older mail was fenced off by a cursor the race preserved").toBe(READS);
    expect(next.moved).toBe(1);
    expect((await movesFor(w, theirs)), "one move, one `move` change").toHaveLength(1);
    expect((await ruleRow(w, ruleId)).retroDoneAt,
      "and only now, with every mailbox walked, is the backlog finished").not.toBeNull();
  });

  it("POSITIVE CONTROL — the same handle with NO promotion still completes normally", async () => {
    /* The hook itself must not be what makes the case above pass. Same proxy, same pass, a side
       effect that touches nothing: a single-mailbox account still stamps after its walk. */
    const w = await newWorld();
    const m = await seedMessage(w, { from: "ruled@x.invalid", folder: OHBOX, lastSetBy: "us" });
    const ruleId = await seedRule(w, { match: "ruled@x.invalid", destination: READS });

    let fired = 0;
    const handle = handleThatPromotesAfterTheFirstUpdate(w.db, async () => { fired++; });

    const res = await ruleRetroPass(
      handle as unknown as Tx,
      { accountId: w.accountId, trustedAuthservIdsFor: NONE }, NOW,
    );

    expect(fired, "the decision statement did not run at all").toBe(1);
    expect(res.moved).toBe(1);
    expect(res.completed, "the proxy swallowed the stamp").toBe(1);
    expect(await desiredOf(w, m)).toBe(READS);
    expect((await ruleRow(w, ruleId)).retroDoneAt).not.toBeNull();
  });
});

describe("THE PROMOTION EVENT takes the fence down, and the pass yields to it", () => {
  /**
   * THE DOOR THAT NEEDS NO RACE, AND WHY THE FIX IS AT THE EVENT.
   *
   * `retro_cursor` is a `messages.id` and that id is a random uuid, so the cursor is a fence across
   * the id space rather than a point in time — and it is only trustworthy for the mailboxes the
   * walk was allowed to look at when it was written. A budget-capped walk keeps its fence on
   * purpose (that is its progress), so this needs no concurrency at all:
   *
   *   cycle N spends `writesPerCycle` and stops, fence standing, rule still owed — correct;
   *   B is promoted between cycles;
   *   cycle N+1 resumes from the fence, walks only B's mail sorting ABOVE it, reads a short page
   *   as the end of the backlog, finds every live mailbox organized, and stamps.
   *
   * B's older matching mail is never filed. Withholding the stamp per mailbox cannot see this and
   * neither can any test of the pass alone, because by cycle N+1 the state is indistinguishable
   * from a legitimate resume.
   *
   * So the fence comes down where the CANDIDATE SET changes — in the same transaction as the role
   * flip (`mailboxes.ts#clearOwedRetroFences`) — and the pass yields to that reset from both of
   * its own writes: the page advance is a compare-and-set on the value it resumed from, and the
   * stamp refuses when the fence is no longer the one this pass left.
   *
   * The promotion below is performed by the REAL writer, not by an `update` in the test: the
   * atomicity is the property under test, and a hand-written role flip would prove nothing about
   * the function production calls.
   */

  /** Sorts LAST — the fence a capped walk leaves behind. */
  const HIGH_A = "ffffffff-ffff-4fff-8fff-fffffffffffd";
  const HIGH_B = "ffffffff-ffff-4fff-8fff-fffffffffffc";
  /** Sorts FIRST — the promoted mailbox's older mail, below the fence. */
  const LOW = "00000000-0000-4000-8000-000000000003";

  const promote = (w: World, mailboxId: string) =>
    clearOrganizerStandDown(w.db as never, mailboxId, { now: NOW });

  it("a CAPPED walk's fence is lifted by the promotion, so the older mail is still filed",
    async () => {
      const w = await newWorld();
      const readerMb = await addMailbox(w, "reader");
      const a1 = await seedMessage(w, { from: "ruled@x.invalid", lastSetBy: "us", id: HIGH_A });
      const a2 = await seedMessage(w, { from: "ruled@x.invalid", lastSetBy: "us", id: HIGH_B });
      const theirs = await seedMessage(w, {
        from: "ruled@x.invalid", lastSetBy: "peer", id: LOW, mailboxId: readerMb,
      });
      const ruleId = await seedRule(w, { match: "ruled@x.invalid", destination: READS });

      // Cycle N: one write of budget, so the walk stops mid-backlog with its fence standing. That
      // is progress and the fix must not throw it away.
      const capped = await run(w, { writesPerCycle: 1 });
      expect(capped.moved, "the budget did not bite — the fence was never laid down").toBe(1);
      expect(capped.capped).toBe(true);
      const fenced = await ruleRow(w, ruleId);
      expect(fenced.retroCursor, "no fence to lift — the rest of this case is vacuous").not.toBeNull();
      expect(fenced.retroDoneAt).toBeNull();

      // The lease comes to us, through the function the worker actually calls.
      await promote(w, readerMb);
      expect((await ruleRow(w, ruleId)).retroCursor,
        "the promotion left a fence written while that mailbox was a reader").toBeNull();

      // Cycle N+1: from the start, so the promoted mailbox's older mail is offered at last.
      const after = await run(w);

      expect(await desiredOf(w, theirs),
        "the promoted mailbox's older mail was fenced off and never filed").toBe(READS);
      expect(await desiredOf(w, a1)).toBe(READS);
      expect(await desiredOf(w, a2)).toBe(READS);
      expect((await ruleRow(w, ruleId)).retroDoneAt,
        "and only now, with every mailbox walked from the start, is it finished").not.toBeNull();
      expect(after.moved).toBe(2);
    });

  it("a reset landing between the last page and the stamp is NOT stamped over", async () => {
    /* The half the page's own compare-and-set cannot cover: the page write sits inside the
       transaction that holds the rule row `FOR UPDATE`, so a reset blocks and lands after it, but
       the completion decision runs after the loop with no lock at all. A promotion committing in
       that gap has discarded the very walk this statement is about to call finished.

       Driven at the seam rather than seeded: the handle's `transaction` is what the pass opens for
       each page, so promoting when the first page transaction resolves lands the reset exactly
       between the last page and the decision (the fixture is one page). */
    const w = await newWorld();
    const readerMb = await addMailbox(w, "reader");
    const ours = await seedMessage(w, { from: "ruled@x.invalid", lastSetBy: "us", id: HIGH_A });
    const theirs = await seedMessage(w, {
      from: "ruled@x.invalid", lastSetBy: "peer", id: LOW, mailboxId: readerMb,
    });
    const ruleId = await seedRule(w, { match: "ruled@x.invalid", destination: READS });

    let resets = 0;
    const handle = new Proxy(w.db as unknown as object, {
      get(t, prop, recv) {
        const v = Reflect.get(t, prop, recv);
        if (prop === "transaction") {
          return async (...args: unknown[]) => {
            const out = await (v as (...a: unknown[]) => Promise<unknown>).apply(t, args);
            if (resets === 0) {
              resets++;
              // The role flip AND its reset, exactly as production performs them together.
              await promote(w, readerMb);
            }
            return out;
          };
        }
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
      },
    }) as World["db"];

    const raced = await ruleRetroPass(
      handle as unknown as Tx, { accountId: w.accountId, trustedAuthservIdsFor: NONE }, NOW,
    );

    expect(resets, "no page transaction ran — nothing was raced").toBe(1);
    expect(raced.moved, "the organized mailbox's mail is the premise").toBe(1);
    expect(await desiredOf(w, ours)).toBe(READS);

    const row = await ruleRow(w, ruleId);
    expect(row.retroDoneAt,
      "a walk the reset had already discarded was stamped finished").toBeNull();
    expect(row.retroCursor, "the pass wrote its fence back over the reset").toBeNull();

    // …and the press is honoured in full on the next cycle.
    const next = await run(w);
    expect(await desiredOf(w, theirs)).toBe(READS);
    expect((await ruleRow(w, ruleId)).retroDoneAt).not.toBeNull();
    expect(next.moved).toBe(1);
  });

  it("the RESET is scoped: owed rules of THIS account only, and finished rules keep their cursor",
    async () => {
      /* The promotion's own statement, on its own. A reset that reached further than the account
         would silently re-walk somebody else's backlog; one that reached a FINISHED rule would
         re-open work whose press is spent, and `retro_done_at` plus a null cursor is the state a
         retarget writes, so the two must not be confused. */
      const w = await newWorld();
      const readerMb = await addMailbox(w, "reader");
      const owed = await seedRule(w, { match: "a@x.invalid", destination: READS, retro: true });
      const finished = await seedRule(w, { match: "b@x.invalid", destination: READS, retro: true });
      const unrequested = await seedRule(w, { match: "c@x.invalid", destination: READS, retro: false });
      await w.db.update(rules).set({ retroCursor: HIGH_A }).where(eq(rules.id, owed));
      await w.db.update(rules).set({ retroDoneAt: NOW, retroCursor: HIGH_B })
        .where(eq(rules.id, finished));
      await w.db.update(rules).set({ retroCursor: HIGH_B }).where(eq(rules.id, unrequested));

      // A SECOND ACCOUNT with an owed, fenced rule — the blast radius.
      const other = await newWorld();
      const otherRule = await seedRule(other, { match: "a@x.invalid", destination: READS, retro: true });
      await other.db.update(rules).set({ retroCursor: HIGH_A }).where(eq(rules.id, otherRule));

      await clearOwedRetroFences(w.db as never, readerMb);

      expect((await ruleRow(w, owed)).retroCursor, "the owed rule's fence still stands").toBeNull();
      expect((await ruleRow(w, finished)).retroCursor,
        "a finished rule's spent cursor was re-opened").toBe(HIGH_B);
      expect((await ruleRow(w, unrequested)).retroCursor,
        "a rule nobody asked to apply retroactively was touched").toBe(HIGH_B);
      expect((await ruleRow(other, otherRule)).retroCursor,
        "another account's backlog was re-opened").toBe(HIGH_A);
    });

  it("the flip and the reset are ONE transaction — a refused flip clears no fence", async () => {
    /* `clearOwedRetroFences` runs only if the role write landed, and in the same transaction, so a
       mailbox the lifecycle predicate refuses (a user disconnected it) leaves every owed walk
       exactly as it was. Without that, a disconnect would re-walk the account's backlog for
       nothing — and, worse, the pair could half-apply across a crash. */
    const w = await newWorld();
    const readerMb = await addMailbox(w, "reader", "disabled");
    const owed = await seedRule(w, { match: "a@x.invalid", destination: READS, retro: true });
    await w.db.update(rules).set({ retroCursor: HIGH_A }).where(eq(rules.id, owed));

    const landed = await promote(w, readerMb);

    expect(landed, "the lifecycle predicate admitted a disabled mailbox").toBe(false);
    expect((await ruleRow(w, owed)).retroCursor,
      "a refused promotion cleared a fence anyway").toBe(HIGH_A);
    const [mb] = await w.db.select().from(mailboxes).where(eq(mailboxes.id, readerMb));
    expect(mb!.organizerRole, "a disabled mailbox was promoted").toBe("reader");
  });
});

describe("the move leaves a trace a person can be shown", () => {
  /**
   * Every other machine mover writes an `audit_log` row with a cause and an inverse
   * (`screener-auto.ts`, `ohbox-tidy.ts`); this pass wrote only the cause-less `change_log` row,
   * so a rule's retroactive move and a hand move were byte-identical in the only record either
   * left, and "which mail did that press move?" had no answer.
   */
  const auditFor = async (w: World, messageId: string) => {
    const rows = await w.db.select().from(auditLog)
      .where(and(eq(auditLog.accountId, w.accountId), eq(auditLog.action, "rule_retro_move")));
    return rows.find((r) => (r.payload as { messageId: string }).messageId === messageId);
  };

  it("a moved message carries the rule that moved it and the way back", async () => {
    const w = await newWorld();
    const m = await seedMessage(w, { from: "news@x.test", folder: OHBOX, lastSetBy: "us" });
    const ruleId = await seedRule(w, { match: "news@x.test", destination: READS });

    expect((await run(w)).moved).toBe(1);
    const row = await auditFor(w, m);
    expect(row, "the pass moved mail and wrote no audit row").toBeDefined();
    expect(row!.payload).toMatchObject({
      mailboxId: w.mailboxId, messageId: m, from: OHBOX, to: READS, ruleId,
    });
    // The inverse is the way back, and it is the move read backwards — not a copy of the payload.
    expect(row!.inverse).toEqual({ messageId: m, from: READS, to: OHBOX });
  });

  it("a message the pass KEEPS gets no row — the trace follows the move", async () => {
    // Without this the case above is satisfied by a pass that writes a row per candidate.
    const w = await newWorld();
    const kept = await seedMessage(w, { from: "news@x.test", folder: OHBOX, lastSetBy: "us" });
    await w.db.insert(messageStates).values({
      accountId: w.accountId, messageId: kept, state: "set_aside",
    });
    await seedRule(w, { match: "news@x.test", destination: READS });

    expect((await run(w)).moved).toBe(0);
    expect(await auditFor(w, kept), "a row was written for mail that never moved").toBeUndefined();
  });
});

describe("SCREENER-020 — after an account-wide decide, the retro pass is a BACKSTOP with nothing to do", () => {
  /**
   * ITEM 3'S WORKER LEG. The decide itself now re-routes the sender's held bag in EVERY organized
   * mailbox, so the pass that used to paper over the one-mailbox gap ("clears in a minute or
   * two") finds no candidate: `desired_folder <> destination` is the candidate query's own
   * idempotency. The pass still RUNS — the promoted rule carries `retro_requested_at`, and mail
   * already PAST the gate stays its job. Mutation watched red: restore the mailbox filter on the
   * decide's held-bag read and the second mailbox's row is filed HERE instead — `moved` 1 and a
   * second `move` row on `b`, both asserted zero-and-one below.
   */
  it("an account-wide decide leaves the pass zero candidates at the gate — and exactly one move per row, ever", async () => {
    const w = await newWorld();
    const mb2 = await addMailbox(w, "organizer");
    const a = await seedMessage(w, { from: "post@twohomes.example", folder: "ohmail/Screener" });
    const b = await seedMessage(w, { from: "post@twohomes.example", folder: "ohmail/Screener", mailboxId: mb2 });

    await w.db.transaction((tx) => applyScreenerDecision(carryDialect(w.db, tx), {
      accountId: w.accountId, scope: "sender", address: "post@twohomes.example",
      appliedFolder: OHBOX, decision: "yes", triggeringActionId: "screener:backstop-020", now: NOW, decidedBy: "person", overExisting: "converge",
    }));
    expect(await desiredOf(w, a)).toBe(OHBOX);
    expect(await desiredOf(w, b)).toBe(OHBOX);

    const r = await run(w);
    expect(r.moved, "the pass filed gate mail the decide already re-routed").toBe(0);
    expect(await movesFor(w, a), "one move per row — the decide's, never a second").toHaveLength(1);
    expect(await movesFor(w, b)).toHaveLength(1);
  });
});
