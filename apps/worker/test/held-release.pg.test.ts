import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { and, eq } from "drizzle-orm";
import { brandDialect } from "@trafficflow/db/dialect";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import {
  accounts, auditLog, folderState, mailboxes, messageBodies, messages, recordChange, rules, threads,
} from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import {
  dismissHeldRelease, heldReleaseFingerprint, heldReleaseGroups, heldReleaseSummary, releaseHeld,
  HELD_RELEASE_AUDIT_ACTION,
} from "@trafficflow/services/mail";
import type { Db, ServiceContext } from "@trafficflow/services";
import { ruleRetroPass } from "../src/rule-retro.js";

/**
 * "N HELD MESSAGES FROM SENDERS YOU ALREADY DECIDED" — THE COUNT, THE PRESS AND WHAT MOVES.
 *
 * Mail an install adopted at the screening gate is recorded as a hand file, so no pass revisits it
 * and it sits at the gate behind a rule its owner already wrote. The product answer is a press over
 * a named group. What that press must be worth is one sentence: THE NUMBER SHOWN IS THE NUMBER
 * RELEASED, and what the release does is ask the rule engine, not move mail to a folder named on a
 * rule row.
 *
 * `.pg.test.ts` and not PGlite, for `rule-retro.pg.test.ts`'s reasons: the pass selects its page
 * `FOR UPDATE OF folder_state` (a no-op that always succeeds under a single-connection engine) and
 * its candidate query is eight `NOT EXISTS`/`IN` arms whose counts are the only thing separating a
 * correct predicate from an accidentally always-true one. The counts here are asserted per arm.
 */

const AVAILABLE = await realPgAvailable();
const GATE = "ohmail/Screener";
const NONE = async (): Promise<ReadonlySet<string>> => new Set<string>();

interface World { accountId: string; mailboxId: string }

describe.skipIf(!AVAILABLE)("held mail released by a press", () => {
  let db: Db;
  let sql: ReturnType<typeof postgres>;

  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    sql = postgres(PG_TEST_URL, { max: 4, onnotice: () => {} });
    db = brandDialect(drizzle(sql, { schema }), "pg") as unknown as Db;
  }, 120_000);

  const ctxOf = (w: World): ServiceContext => ({
    db: db as never, accountId: w.accountId, userId: null,
    now: () => new Date("2026-09-12T12:00:00Z"), requestId: `hr-${randomUUID()}`,
  });

  async function newWorld(role = "organizer"): Promise<World> {
    const accountId = randomUUID();
    await db.insert(accounts).values({ id: accountId, name: `hr-${accountId.slice(0, 8)}` });
    const [mb] = await db.insert(mailboxes).values({
      accountId, provider: "imap", address: `hr-${accountId.slice(0, 8)}@example.test`,
      organizerRole: role,
    }).returning();
    return { accountId, mailboxId: mb!.id };
  }

  /** A rule the user already wrote. `retroDoneAt` set ⇒ its backlog is finished, which is the gap. */
  async function seedRule(w: World, o: {
    kind: "sender" | "domain"; match: string; destination: string;
    enabled?: boolean; priority?: number; owed?: boolean;
  }): Promise<string> {
    const [r] = await db.insert(rules).values({
      accountId: w.accountId, kind: o.kind, match: o.match, destination: o.destination,
      enabled: o.enabled ?? true, priority: o.priority ?? 0,
      retroRequestedAt: new Date("2026-01-01T00:00:00Z"),
      retroDoneAt: o.owed === true ? null : new Date("2026-01-01T00:01:00Z"),
    }).returning();
    return r!.id;
  }

  /** One message at the gate, stamped the way a pre-0.14.1 reader stamped it. */
  async function seedHeld(w: World, o: {
    from: string; lastSetBy?: string; desired?: string; observed?: string; threadId?: string;
  }): Promise<string> {
    const [m] = await db.insert(messages).values({
      accountId: w.accountId, mailboxId: w.mailboxId, bodyHash: "h",
      dedupKey: `hr:${randomUUID()}`, subject: "held", fromAddress: o.from,
      ...(o.threadId ? { threadId: o.threadId } : {}),
      nativeLocator: { folder: GATE, ref: `1:${Math.floor(Math.random() * 100000)}` },
    }).returning();
    await db.insert(messageBodies).values({ messageId: m!.id, accountId: m!.accountId, text: "", html: null, headers: {} });
    await db.insert(folderState).values({
      messageId: m!.id, accountId: m!.accountId, desiredFolder: o.desired ?? GATE, observedFolder: o.observed ?? GATE,
      lastSetBy: o.lastSetBy ?? "external", reconcileStatus: "reconciled", conflict: false,
    });
    // The change row every production placement writes: the offer's dismissal anchors on the log.
    await db.transaction(async (tx) => {
      await recordChange(tx as never, { accountId: w.accountId, entityType: "message", entityId: m!.id, op: "create", meta: null });
    });
    return m!.id;
  }

  /** A conversation, and the account's OWN reply in it to `to` — a person's, not the responder's. */
  async function seedRepliedThread(w: World, to: string): Promise<string> {
    const [t] = await db.insert(threads).values({ accountId: w.accountId, subject: "held" }).returning();
    const [mb] = await db.select().from(mailboxes).where(eq(mailboxes.id, w.mailboxId)).limit(1);
    const [reply] = await db.insert(messages).values({
      accountId: w.accountId, mailboxId: w.mailboxId, bodyHash: "h",
      dedupKey: `hr:${randomUUID()}`, subject: "Re: held", fromAddress: mb!.address,
      toAddresses: [{ address: to, name: "" }],
      threadId: t!.id, nativeLocator: { folder: "INBOX", ref: `1:${Math.floor(Math.random() * 100000)}` },
    }).returning();
    // Plain headers: a REAL reply, not the away responder's (`autoReplyByUsWhere` must not fire).
    await db.insert(messageBodies).values({ messageId: reply!.id, accountId: reply!.accountId, text: "", html: null, headers: {} });
    await db.insert(folderState).values({
      messageId: reply!.id, accountId: reply!.accountId, desiredFolder: "INBOX", observedFolder: "INBOX",
      lastSetBy: "external", reconcileStatus: "reconciled", conflict: false,
    });
    return t!.id;
  }

  const desiredOf = async (id: string): Promise<{ desired: string; setBy: string }> => {
    const [r] = await db.select().from(folderState).where(eq(folderState.messageId, id)).limit(1);
    return { desired: r!.desiredFolder, setBy: r!.lastSetBy };
  };

  const runPass = (w: World): Promise<{ moved: number; examined: number }> =>
    ruleRetroPass(db as never, { accountId: w.accountId, trustedAuthservIdsFor: NONE },
      new Date("2026-09-12T12:00:01Z"));

  const auditRows = async (w: World) =>
    db.select().from(auditLog)
      .where(and(eq(auditLog.accountId, w.accountId), eq(auditLog.action, HELD_RELEASE_AUDIT_ACTION)));

  /**
   * THE COUNT IS THE SEEDED SHAPE AND NOTHING ELSE.
   *
   * Six negative arms beside the four real groups, each the reason a row is NOT stuck: no rule at
   * all, a rule switched off, mail already filed where the rule sends it, a rule whose backlog is
   * open right now, a rule that sends mail TO the gate, and a placement written by a
   * `last_set_by` this product does not know. A predicate missing any one of them counts them all.
   *
   * `'us'` USED TO BE THE SIXTH NEGATIVE, on the argument that the ordinary retro reaches those.
   * Measured on a reported account, it does not: `confirmSeed` writes its rules with
   * `retro_requested_at` NULL, so their backlog is never owed, and five messages this product
   * itself put at the gate the day before the seed sat there for months while this screen offered
   * nothing. `hand@shape.test` is now a GROUP, and the allow-list keeps its teeth through
   * `strange@shape.test`, whose writer nobody has thought about.
   */
  it("counts the mail that is stuck, and only that", async () => {
    const w = await newWorld();
    await seedRule(w, { kind: "sender", match: "one@shape.test", destination: "INBOX" });
    await seedRule(w, { kind: "sender", match: "two@shape.test", destination: "ohmail/Receipts" });
    await seedRule(w, { kind: "domain", match: "reads.test", destination: "ohmail/News" });
    await seedRule(w, { kind: "sender", match: "off@shape.test", destination: "INBOX", enabled: false });
    await seedRule(w, { kind: "sender", match: "flight@shape.test", destination: "INBOX", owed: true });
    await seedRule(w, { kind: "sender", match: "gate@shape.test", destination: GATE });
    await seedRule(w, { kind: "sender", match: "filed@shape.test", destination: "INBOX" });
    // A rule DOES stand behind the `'us'` row below — the reported shape, which the press must
    // now offer. And one behind the unknown-writer row, so THAT arm measures the allow-list
    // rather than the absence of a rule.
    await seedRule(w, { kind: "sender", match: "hand@shape.test", destination: "INBOX" });
    await seedRule(w, { kind: "sender", match: "strange@shape.test", destination: "INBOX" });

    for (let i = 0; i < 5; i++) await seedHeld(w, { from: "one@shape.test" });
    for (let i = 0; i < 3; i++) await seedHeld(w, { from: "two@shape.test" });
    for (let i = 0; i < 2; i++) await seedHeld(w, { from: `n${i}@reads.test` });
    // Negatives.
    await seedHeld(w, { from: "norule@shape.test" });
    await seedHeld(w, { from: "off@shape.test" });
    await seedHeld(w, { from: "flight@shape.test" });
    await seedHeld(w, { from: "gate@shape.test" });
    await seedHeld(w, { from: "strange@shape.test", lastSetBy: "worker" });
    await seedHeld(w, { from: "filed@shape.test", desired: "INBOX", observed: "INBOX" });
    // THE REPORTED SHAPE: ohmail's own placement, settled at the gate, behind a rule its owner
    // already wrote. A group now, and the count below moves with it.
    await seedHeld(w, { from: "hand@shape.test", lastSetBy: "us" });

    const groups = await heldReleaseGroups(db as never, w.accountId);
    expect(groups.map((g) => [g.match, g.destination, g.count])).toEqual([
      ["one@shape.test", "INBOX", 5],
      ["two@shape.test", "ohmail/Receipts", 3],
      ["reads.test", "ohmail/News", 2],
      ["hand@shape.test", "INBOX", 1],
    ]);
    expect(groups.reduce((n, g) => n + g.count, 0)).toBe(11);
  });

  /**
   * THE PRESS RELEASES EXACTLY THE PREDICATE'S ROWS, AND THE RULE ENGINE FILES THEM.
   *
   * The engine's answer is made to DISAGREE with the pressed rule's own destination: the group is a
   * DOMAIN rule sending `paper.test` to Reads, and a sender rule for one address in that domain
   * sends it to Receipts. A sender rule outranks a domain rule, so the router's answer for that one
   * message is Receipts. Code that filed `rule.destination` would put it in Reads and pass every
   * other assertion here — which is the point of the arrangement.
   */
  it("files the released rows through the rule engine, not the rule's own destination", async () => {
    const w = await newWorld();
    const domainRule = await seedRule(w, { kind: "domain", match: "paper.test", destination: "ohmail/News" });
    await seedRule(w, { kind: "sender", match: "bills@paper.test", destination: "ohmail/Receipts" });

    const plain = await seedHeld(w, { from: "news@paper.test" });
    const outranked = await seedHeld(w, { from: "bills@paper.test" });
    // A hand file the press may NOT touch: same sender, but it is not at the gate.
    const elsewhere = await seedHeld(w, { from: "news@paper.test", desired: "INBOX", observed: "INBOX" });

    /* ONLY THE DOMAIN GROUP IS PRESSED, and that is what makes this case measure anything: press
       both and the sender rule's own walk files `bills@` into Receipts whatever the domain walk
       did, so filing `rule.destination` instead of the router's answer would still end correctly.
       With one group released, the domain walk is the ONLY thing that touches that row. */
    const result = await releaseHeld(ctxOf(w), { ruleIds: [domainRule] });
    expect(result.released.map((g) => g.ruleId)).toEqual([domainRule]);
    // Two held messages at the gate for this domain — the third is filed in the INBOX already.
    expect(result.total).toBe(2);

    const audits = await auditRows(w);
    expect(audits.length).toBe(1);
    expect((audits[0]!.payload as { count: number }).count).toBe(2);

    await runPass(w);

    expect((await desiredOf(plain)).desired).toBe("ohmail/News");
    expect((await desiredOf(plain)).setBy).toBe("us");
    // The router's answer, not the pressed rule's.
    expect((await desiredOf(outranked)).desired).toBe("ohmail/Receipts");
    // Untouched: a hand placement outside the gate is still theirs.
    expect(await desiredOf(elsewhere)).toEqual({ desired: "INBOX", setBy: "external" });
  });

  /**
   * THE HEADLINE NUMBER IS DISTINCT MESSAGES, NEVER THE SUM OF THE GROUPS. A domain rule and a
   * sender rule inside that domain both claim the same message, and both group counts say so
   * truthfully; a screen that added them up would tell a person they hold twice what they hold.
   */
  it("counts a message claimed by two rules once", async () => {
    const w = await newWorld();
    await seedRule(w, { kind: "domain", match: "twice.test", destination: "ohmail/News" });
    await seedRule(w, { kind: "sender", match: "both@twice.test", destination: "ohmail/Receipts" });
    await seedHeld(w, { from: "both@twice.test" });

    const summary = await heldReleaseSummary(db as never, w.accountId);
    expect(summary.groups.map((g) => g.count)).toEqual([1, 1]);
    expect(summary.groups.reduce((n, g) => n + g.count, 0)).toBe(2);
    expect(summary.total).toBe(1);
    expect((await releaseHeld(ctxOf(w))).total).toBe(1);
  });

  /**
   * THE PRESS MOVES WHAT IT COUNTED, AND NOTHING ELSE — the narrowing, measured rather than assumed.
   *
   * The press re-opens the rule's backlog, and a rule's backlog is bigger than the gate: measured
   * before this was narrowed, releasing ONE held message also re-filed a `'peer'` message sitting in
   * Reads that the screen had never counted. A person releasing held mail is not asking for a tidy-up
   * of everything else that rule claims. So a RELEASE run walks only mail still settled at the gate,
   * and an ordinary retro — a rule edited with "apply to existing mail" — is unaffected.
   */
  it("moves the mail it counted and leaves the rule's other mail alone", async () => {
    const w = await newWorld();
    await seedRule(w, { kind: "sender", match: "x@over.test", destination: "ohmail/Receipts" });
    const atGate = await seedHeld(w, { from: "x@over.test" });
    // Another install's placement, in an organized folder, that this rule would otherwise claim.
    const inReads = await seedHeld(w, {
      from: "x@over.test", lastSetBy: "peer", desired: "ohmail/News", observed: "ohmail/News",
    });
    // A hand file in the INBOX: excluded by the gate term, as it is for every rule.
    const inInbox = await seedHeld(w, { from: "x@over.test", desired: "INBOX", observed: "INBOX" });

    expect((await releaseHeld(ctxOf(w))).total).toBe(1);
    await runPass(w);

    expect((await desiredOf(atGate)).desired).toBe("ohmail/Receipts");
    expect(await desiredOf(inReads)).toEqual({ desired: "ohmail/News", setBy: "peer" });
    expect(await desiredOf(inInbox)).toEqual({ desired: "INBOX", setBy: "external" });
  });

  /**
   * AND AN ORDINARY RETRO IS NOT NARROWED BY A PRESS THAT HAPPENED ONCE. `release_held_at` is
   * sticky; what makes a walk a RELEASE walk is that it is the LAST thing asked of the rule. A rule
   * re-armed afterwards — the ordinary "apply to existing mail" — walks its whole backlog again.
   */
  it("leaves a later ordinary retro unnarrowed", async () => {
    const w = await newWorld();
    const rule = await seedRule(w, { kind: "sender", match: "y@over.test", destination: "ohmail/Receipts" });
    const inReads = await seedHeld(w, {
      from: "y@over.test", lastSetBy: "peer", desired: "ohmail/News", observed: "ohmail/News",
    });
    await seedHeld(w, { from: "y@over.test" });

    await releaseHeld(ctxOf(w));
    await runPass(w);
    expect((await desiredOf(inReads)).desired).toBe("ohmail/News");

    // The ordinary re-arm, as `RulesService` writes it: `retro_requested_at` moves, the licence stays.
    await db.update(rules)
      .set({ retroRequestedAt: new Date("2026-09-12T13:00:00Z"), retroDoneAt: null, retroCursor: null })
      .where(eq(rules.id, rule));
    await runPass(w);
    expect((await desiredOf(inReads)).desired).toBe("ohmail/Receipts");
  });

  /** A second press finds nothing: the released rule is in flight, so it is no longer a group. */
  it("is idempotent — a second press releases nothing", async () => {
    const w = await newWorld();
    await seedRule(w, { kind: "sender", match: "again@shape.test", destination: "INBOX" });
    for (let i = 0; i < 4; i++) await seedHeld(w, { from: "again@shape.test" });

    expect((await releaseHeld(ctxOf(w))).total).toBe(4);
    const second = await releaseHeld(ctxOf(w));
    expect(second.released).toEqual([]);
    expect(second.total).toBe(0);
    expect((await auditRows(w)).length).toBe(1);

    // And after the mail has actually moved, still nothing.
    await runPass(w);
    expect(await heldReleaseGroups(db as never, w.accountId)).toEqual([]);
  });

  /** Pressing one group leaves the others exactly where they were. */
  it("releases one group and leaves the rest held", async () => {
    const w = await newWorld();
    const wanted = await seedRule(w, { kind: "sender", match: "yes@shape.test", destination: "INBOX" });
    await seedRule(w, { kind: "sender", match: "no@shape.test", destination: "ohmail/News" });
    const released = await seedHeld(w, { from: "yes@shape.test" });
    const kept = await seedHeld(w, { from: "no@shape.test" });

    const out = await releaseHeld(ctxOf(w), { ruleIds: [wanted] });
    expect(out.released.map((g) => g.ruleId)).toEqual([wanted]);

    await runPass(w);
    expect((await desiredOf(released)).desired).toBe("INBOX");
    expect(await desiredOf(kept)).toEqual({ desired: GATE, setBy: "external" });
    // The other group is still offered.
    expect((await heldReleaseGroups(db as never, w.accountId)).map((g) => g.match))
      .toEqual(["no@shape.test"]);
  });

  /**
   * ANOTHER ACCOUNT'S RULE IS NOT A GROUP AND NOT A TARGET. The press is scoped by the caller's
   * account in both halves — what it can see and what it may update — so a foreign rule id names
   * nothing, and the foreign mail stays held.
   */
  it("refuses a rule the caller does not own", async () => {
    const mine = await newWorld();
    const theirs = await newWorld();
    const foreign = await seedRule(theirs, { kind: "sender", match: "x@other.test", destination: "INBOX" });
    const theirHeld = await seedHeld(theirs, { from: "x@other.test" });
    /* MY OWN HELD MAIL FROM THE SAME SENDER, so the refusal has something to refuse. Without this
       row the caller's query is empty for want of mail rather than for want of a rule, and the
       account scoping cannot be watched fail — every mutation of it reads green on an empty set. */
    const myHeld = await seedHeld(mine, { from: "x@other.test" });

    expect(await heldReleaseGroups(db as never, mine.accountId)).toEqual([]);
    const out = await releaseHeld(ctxOf(mine), { ruleIds: [foreign] });
    expect(out).toEqual({ released: [], releasedSenders: [], total: 0 });
    await runPass(mine);
    expect(await desiredOf(myHeld)).toEqual({ desired: GATE, setBy: "external" });

    await runPass(theirs);
    expect(await desiredOf(theirHeld)).toEqual({ desired: GATE, setBy: "external" });
    const [row] = await db.select().from(rules).where(eq(rules.id, foreign)).limit(1);
    expect(row!.releaseHeldAt).toBeNull();
  });

  /**
   * ═══ A REPLIED THREAD DOES NOT DEFEAT THE PRESS (FIX-021) ═══════════════════════════════
   *
   * MEASURED on a live account: every offered gate row sat in a thread that
   * account had replied in, so the walk's own-reply exclusion (arm 5) kept them all — every press
   * released its rules and moved ZERO messages, and the offer re-formed every session. The
   * press names this exact set and count, which outranks a reply somewhere in the thread; the
   * ordinary retro (no press) keeps the exclusion, because nobody named these rows to it.
   *
   * MUTATION WATCHED: restoring arm 5's unconditional form (`ownAddresses.length > 0` alone)
   * reddens the first case — the number shown stops being the number released.
   */
  it("moves gate mail the account replied to, once the press names it", async () => {
    const w = await newWorld();
    await seedRule(w, { kind: "sender", match: "replied@shape.test", destination: "INBOX" });
    const thread = await seedRepliedThread(w, "replied@shape.test");
    const held = await seedHeld(w, { from: "replied@shape.test", lastSetBy: "us", threadId: thread });

    // The offer counts it — and the press must therefore move it.
    expect((await heldReleaseSummary(db as never, w.accountId)).total).toBe(1);
    expect((await releaseHeld(ctxOf(w))).total).toBe(1);
    await runPass(w);
    expect((await desiredOf(held)).desired).toBe("INBOX");
    // Cleared for good: the set is gone, so the offer is too.
    expect(await heldReleaseGroups(db as never, w.accountId)).toEqual([]);
  });

  it("an ORDINARY retro still keeps a replied thread — the exclusion lost only to the press", async () => {
    const w = await newWorld();
    await seedRule(w, {
      kind: "sender", match: "replied2@shape.test", destination: "INBOX", owed: true,
    });
    const thread = await seedRepliedThread(w, "replied2@shape.test");
    const held = await seedHeld(w, { from: "replied2@shape.test", lastSetBy: "us", threadId: thread });

    await runPass(w);
    expect(await desiredOf(held)).toEqual({ desired: GATE, setBy: "us" });
  });

  /**
   * ═══ "NOT NOW" — THE DISMISSAL NAMES THE SET, AND ONLY THAT SET (FIX-021) ═══════════════
   *
   * The stored value is the fingerprint of the sorted (rule, destination, count) groups: the same
   * set reads `dismissed` on every device; ANY change — new held mail from a decided sender, a
   * group released — changes the fingerprint and the offer returns by construction.
   */
  it("a dismissed offer stays dismissed until the set changes", async () => {
    const w = await newWorld();
    await seedRule(w, { kind: "sender", match: "later@shape.test", destination: "INBOX" });
    await seedHeld(w, { from: "later@shape.test" });

    const before = await heldReleaseSummary(db as never, w.accountId);
    expect(before.dismissed).toBe(false);
    expect(before.fingerprint).not.toBe("");

    await dismissHeldRelease(ctxOf(w), { fingerprint: before.fingerprint });
    // The same set, read again — on this device or any other: dismissed.
    expect((await heldReleaseSummary(db as never, w.accountId)).dismissed).toBe(true);

    // New held mail from the decided sender: the count moves, the fingerprint moves, the offer returns.
    await seedHeld(w, { from: "later@shape.test" });
    const after = await heldReleaseSummary(db as never, w.accountId);
    expect(after.dismissed).toBe(false);
    expect(after.fingerprint).not.toBe(before.fingerprint);
  });

  it("refuses a dismissal that is not a short string", async () => {
    const w = await newWorld();
    await expect(dismissHeldRelease(ctxOf(w), { fingerprint: "" })).rejects.toThrow(/fingerprint/);
    await expect(dismissHeldRelease(ctxOf(w), { fingerprint: 42 })).rejects.toThrow(/fingerprint/);
    await expect(dismissHeldRelease(ctxOf(w), { fingerprint: "x".repeat(129) })).rejects.toThrow(/fingerprint/);
  });

  it("the fingerprint is a function of the set, not of when it was read", () => {
    const g = (ruleId: string, count: number) =>
      ({ ruleId, kind: "sender" as const, match: "a@b.test", destination: "INBOX", count });
    expect(heldReleaseFingerprint([g("r1", 2), g("r2", 1)]))
      .toBe(heldReleaseFingerprint([g("r2", 1), g("r1", 2)]));
    expect(heldReleaseFingerprint([g("r1", 2)])).not.toBe(heldReleaseFingerprint([g("r1", 3)]));
    expect(heldReleaseFingerprint([])).toBe("");
  });

  /** A mailbox this install only READS is not one it may file in — pressed or not. */
  it("counts nothing on a mailbox this install does not organize", async () => {
    const w = await newWorld("reader");
    await seedRule(w, { kind: "sender", match: "reader@shape.test", destination: "INBOX" });
    const held = await seedHeld(w, { from: "reader@shape.test" });

    expect(await heldReleaseGroups(db as never, w.accountId)).toEqual([]);
    expect((await releaseHeld(ctxOf(w))).total).toBe(0);
    await runPass(w);
    expect(await desiredOf(held)).toEqual({ desired: GATE, setBy: "external" });
  });
});
