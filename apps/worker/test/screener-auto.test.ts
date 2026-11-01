import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { makeTestDb } from "@trafficflow/db/testing";
import {
  accountSettings, accounts, auditLog, changeLog, folderState, mailboxes,
  messageBodies, messages, messageStates, rules, type Tx,
} from "@trafficflow/db";
import { screenerAutoApplyPass } from "../src/screener-auto.js";

/**
 * SCREENER AUTO-APPLY — the opt-in that files obvious strong-bulk out of the Screener.
 *
 * Runs on PGlite: the behavioural matrix (opt-in gating, the strong-bulk floor, the sensitivity KEEP
 * guard, the reversible move) is engine-level and does not need real Postgres — the `FOR UPDATE OF
 * folder_state` concurrency claim is the sibling passes' `*.pg.test.ts` territory and holds here for
 * the same reason it holds there.
 *
 * The three MUTATION-WATCHES this file exists to hold, each written so dropping the guard turns it red:
 *   (a) default OFF — a fresh account auto-applies nothing; the SAME message moves only once opted in.
 *   (b) sensitivity KEEP — a sensitivity-flagged strong-bulk message is NOT auto-moved.
 *   (c) reversibility — an auto-applied decision is a durable, undoable placement, never a delete and
 *       never a rule (it grants no admission).
 */

const SCREENER = "ohmail/Screener";
const READS = "ohmail/News";
const RECEIPTS = "ohmail/Receipts";

// The strong-bulk floor: List-Unsubscribe AND a corroborating list/ESP marker.
const STRONG_BULK = { "list-unsubscribe": ["<https://x.test/u>"], "list-id": ["<news.shop.test>"] };
// A single List-Unsubscribe — passes the lenient bulk check but NOT the strong floor.
const WEAK_BULK = { "list-unsubscribe": ["<https://x.test/u>"] };

interface World { accountId: string; mailboxId: string }

describe("SCR-AUTOMODE — the Screener auto-apply pass", () => {
  let db: Tx;

  beforeAll(async () => {
    db = (await makeTestDb()) as unknown as Tx;
  });

  async function newWorld(): Promise<World> {
    const accountId = randomUUID();
    await db.insert(accounts).values({ id: accountId, name: `auto-${accountId.slice(0, 8)}` });
    const [mb] = await db.insert(mailboxes).values({
      accountId, provider: "imap", address: `auto-${accountId.slice(0, 8)}@example.test`,
    }).returning();
    return { accountId, mailboxId: mb!.id };
  }

  /** Turn auto-apply ON (a stamped `screener_auto_apply_at`) or leave it OFF (null / no row). */
  async function optIn(w: World, on: boolean, hasRow = true): Promise<void> {
    if (!hasRow) return; // no account_settings row at all — the most common OFF shape
    await db.insert(accountSettings).values({
      accountId: w.accountId, screenerAutoApplyAt: on ? new Date() : null,
    }).onConflictDoUpdate({
      target: accountSettings.accountId,
      set: { screenerAutoApplyAt: on ? new Date() : null },
    });
  }

  /** One message HELD in the Screener, with headers and (optionally) a sensitivity flag. */
  async function held(w: World, o: {
    from: string;
    subject?: string;
    headers?: Record<string, string[]>;
    sensitivityCategory?: string;
    noAi?: boolean;
    lastSetBy?: "us" | "external";
  }): Promise<string> {
    const [m] = await db.insert(messages).values({
      accountId: w.accountId, mailboxId: w.mailboxId, bodyHash: "h", dedupKey: `auto:${randomUUID()}`,
      subject: o.subject ?? "hello there",
      fromAddress: o.from,
      sensitivityCategory: o.sensitivityCategory ?? null,
      noAi: o.noAi ?? false,
      nativeLocator: { folder: SCREENER, ref: `1:${Math.floor(Math.random() * 1e6)}` },
    }).returning();
    await db.insert(messageBodies).values({
      messageId: m!.id, text: "", html: null, headers: o.headers ?? {},
    });
    await db.insert(folderState).values({
      messageId: m!.id, desiredFolder: SCREENER, observedFolder: SCREENER,
      lastSetBy: o.lastSetBy ?? "us", reconcileStatus: "reconciled", conflict: false,
    });
    return m!.id;
  }

  const desiredOf = async (id: string): Promise<{ desired: string; status: string }> => {
    const [r] = await db.select().from(folderState).where(eq(folderState.messageId, id)).limit(1);
    return { desired: r!.desiredFolder, status: r!.reconcileStatus };
  };
  const auditFor = async (accountId: string, messageId: string) => {
    const rows = await db.select().from(auditLog)
      .where(and(eq(auditLog.accountId, accountId), eq(auditLog.action, "screener_auto_apply_move")));
    return rows.find((r) => (r.payload as { messageId: string }).messageId === messageId);
  };

  // ══════════════════════════════════════════════════════════════════════════════════════════
  //  (a) DEFAULT OFF — a fresh account auto-applies nothing
  // ══════════════════════════════════════════════════════════════════════════════════════════

  it("MUTATION-WATCH (a): a fresh account auto-applies NOTHING — the same message moves only once opted in", async () => {
    const w = await newWorld();
    const news = await held(w, { from: "news@shop.test", headers: STRONG_BULK });

    // No account_settings row at all — the default. If the default flips to ON, this goes red.
    const off = await screenerAutoApplyPass(db, { accountId: w.accountId });
    expect(off).toMatchObject({ ran: false, moved: 0 });
    expect((await desiredOf(news)).desired, "held mail moved with auto-apply OFF").toBe(SCREENER);

    // A row that exists but is NULL is ALSO off — the same safety as the absent row.
    await optIn(w, false);
    const stillOff = await screenerAutoApplyPass(db, { accountId: w.accountId });
    expect(stillOff).toMatchObject({ ran: false, moved: 0 });
    expect((await desiredOf(news)).desired).toBe(SCREENER);

    // Opting IN is the ONLY difference — now the very same message moves.
    await optIn(w, true);
    const on = await screenerAutoApplyPass(db, { accountId: w.accountId });
    expect(on).toMatchObject({ ran: true, moved: 1 });
    expect((await desiredOf(news)).desired).toBe(READS);
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════
  //  (b2) IDENTITY KEEP — a marked message is never auto-moved (mail 0148)
  // ══════════════════════════════════════════════════════════════════════════════════════════

  it("MUTATION-WATCH (b2): an identity-marked strong-bulk message is KEPT at the gate; a NULL row is computed", async () => {
    const w = await newWorld();
    await optIn(w, true);
    const plain = await held(w, { from: "news@shop.test", headers: STRONG_BULK });
    const markedRow = await held(w, { from: "x@gmail.test", headers: STRONG_BULK });
    await db.update(messages).set({ senderCheck: "impersonation", senderCheckBrand: "PostFinance" })
      .where(eq(messages.id, markedRow));
    // A row older than the column: the fact function speaks for it.
    const unchecked = await held(w, { from: "y@gmail.test", headers: STRONG_BULK });
    await db.update(messages).set({ fromName: "PostFinance" }).where(eq(messages.id, unchecked));

    const r = await screenerAutoApplyPass(db, { accountId: w.accountId });
    expect(r).toMatchObject({ ran: true, moved: 1, identityExcluded: 2 });
    expect((await desiredOf(plain)).desired).toBe(READS);
    expect((await desiredOf(markedRow)).desired, "a marked message was auto-moved").toBe(SCREENER);
    expect((await desiredOf(unchecked)).desired, "an unchecked brand claim was auto-moved").toBe(SCREENER);
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════
  //  (b) SENSITIVITY KEEP — a sensitive message is never auto-moved
  // ══════════════════════════════════════════════════════════════════════════════════════════

  it("MUTATION-WATCH (b): a sensitivity-flagged strong-bulk message is KEPT at the gate, not moved", async () => {
    const w = await newWorld();
    await optIn(w, true);

    // Both are strong-bulk and would otherwise file to Reads. Only the flagged one must stay.
    const plain = await held(w, { from: "news@shop.test", headers: STRONG_BULK });
    const byCategory = await held(w, { from: "codes@bank.test", headers: STRONG_BULK, sensitivityCategory: "otp" });
    const byNoAi = await held(w, { from: "alerts@bank.test", headers: STRONG_BULK, noAi: true });

    const r = await screenerAutoApplyPass(db, { accountId: w.accountId });

    // Drop the KEEP guard and this goes red three ways: moved 3, sensitivityExcluded 0, and the two
    // flagged rows land in Reads.
    expect(r).toMatchObject({ ran: true, moved: 1, sensitivityExcluded: 2 });
    expect((await desiredOf(plain)).desired).toBe(READS);
    expect((await desiredOf(byCategory)).desired, "a sensitive (otp) message was auto-moved").toBe(SCREENER);
    expect((await desiredOf(byNoAi)).desired, "a no_ai message was auto-moved").toBe(SCREENER);
  });

  it("a strong-bulk letter its provider failed is kept at the gate, for a person to decide", async () => {
    const w = await newWorld();
    await optIn(w, true);
    const plain = await held(w, { from: "news@shop.test", headers: STRONG_BULK });
    const forged = await held(w, { from: "news@bank.test", headers: STRONG_BULK });
    await db.update(messages).set({ authVerdict: "fail" }).where(eq(messages.id, forged));
    const r = await screenerAutoApplyPass(db, { accountId: w.accountId });
    expect(r).toMatchObject({ ran: true, moved: 1 });
    expect((await desiredOf(plain)).desired).toBe(READS);
    expect((await desiredOf(forged)).desired, "a letter its provider failed was filed automatically").toBe(SCREENER);
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════
  //  (c) REVERSIBLE — a durable, undoable placement, never a delete and never a rule
  // ══════════════════════════════════════════════════════════════════════════════════════════

  it("MUTATION-WATCH (c): a move is a durable reversible placement — message intact, undo recorded, NO rule, NO delete", async () => {
    const w = await newWorld();
    await optIn(w, true);
    const news = await held(w, { from: "news@shop.test", headers: STRONG_BULK });

    const r = await screenerAutoApplyPass(db, { accountId: w.accountId });
    expect(r).toMatchObject({ ran: true, moved: 1 });

    // NOT A DELETE — the message still exists.
    const [msg] = await db.select().from(messages).where(eq(messages.id, news)).limit(1);
    expect(msg, "the message was deleted rather than re-filed").toBeTruthy();

    // A DURABLE PLACEMENT — desired folder changed, reconcile pending (no IMAP opened here).
    expect(await desiredOf(news)).toEqual({ desired: READS, status: "pending" });

    // UNDOABLE — an audit row carrying the INVERSE, the way back to the Screener.
    const audit = await auditFor(w.accountId, news);
    expect(audit, "no audit row records the auto-apply move").toBeTruthy();
    expect(audit!.inverse).toMatchObject({ messageId: news, from: READS, to: SCREENER });
    expect(audit!.payload).toMatchObject({ from: SCREENER, to: READS });

    // VISIBLE — the client mirror sees the Screener→Reads transition.
    const moves = await db.select().from(changeLog)
      .where(and(eq(changeLog.accountId, w.accountId), eq(changeLog.op, "move")));
    expect(moves).toHaveLength(1);
    expect((moves[0]!.meta as { from: string; to: string })).toMatchObject({ from: SCREENER, to: READS });

    // GRANTS NO ADMISSION — no rule was written, so the sender still screens next time.
    const ruleRows = await db.select().from(rules).where(eq(rules.accountId, w.accountId));
    expect(ruleRows, "auto-apply wrote a rule — it must grant no admission").toHaveLength(0);
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════
  //  Supporting behaviour: the floor is deterministic and conservative
  // ══════════════════════════════════════════════════════════════════════════════════════════

  it("files a money-subject receipt to Receipts, and leaves plain strangers and weak-bulk at the gate", async () => {
    const w = await newWorld();
    await optIn(w, true);

    const receipt = await held(w, { from: "orders@shop.test", subject: "Your receipt", headers: STRONG_BULK });
    const person = await held(w, { from: "anna@work.test", subject: "lunch friday?" });          // no bulk headers
    const weak = await held(w, { from: "promo@brand.test", headers: WEAK_BULK });                 // one marker only

    const r = await screenerAutoApplyPass(db, { accountId: w.accountId });
    expect(r).toMatchObject({ ran: true, moved: 1, kept: 2 });
    expect(r.destinations).toEqual({ [RECEIPTS]: 1 });
    expect((await desiredOf(receipt)).desired).toBe(RECEIPTS);
    expect((await desiredOf(person)).desired, "a first-time person was auto-moved").toBe(SCREENER);
    expect((await desiredOf(weak)).desired, "weak bulk cleared the strong floor").toBe(SCREENER);
  });

  it("leaves a message the user has already ruled on or triaged where it is", async () => {
    const w = await newWorld();
    await optIn(w, true);

    // Ruled on: an enabled sender rule exists.
    const ruled = await held(w, { from: "news@ruled.test", headers: STRONG_BULK });
    await db.insert(rules).values({
      accountId: w.accountId, kind: "sender", match: "news@ruled.test",
      destination: READS, priority: 0, provenance: "promoted", enabled: true,
    });
    // Triaged: a non-`none` message state.
    const triaged = await held(w, { from: "news@triaged.test", headers: STRONG_BULK });
    await db.insert(messageStates).values({ accountId: w.accountId, messageId: triaged, state: "reply_later" });

    const r = await screenerAutoApplyPass(db, { accountId: w.accountId });
    expect(r).toMatchObject({ ran: true, moved: 0 });
    expect((await desiredOf(ruled)).desired).toBe(SCREENER);
    expect((await desiredOf(triaged)).desired).toBe(SCREENER);
  });

  it("a rule saved with spaces around the address holds the sender too", async () => {
    // The router names the sender by `ruleMatchKey`; RED at the base, the held bulk moved to News
    // over the destination the person wrote.
    const w = await newWorld();
    await optIn(w, true);
    const ruled = await held(w, { from: "news@padded.test", headers: STRONG_BULK });
    await db.insert(rules).values({
      accountId: w.accountId, kind: "sender", match: " news@padded.test ",
      destination: "INBOX", priority: 0, provenance: "manual", enabled: true,
    });
    const r = await screenerAutoApplyPass(db, { accountId: w.accountId });
    expect(r).toMatchObject({ ran: true, moved: 0 });
    expect((await desiredOf(ruled)).desired).toBe(SCREENER);
  });

  it("a NARROWED rule STILL holds the whole sender — this pass has no evaluator to ask", async () => {
    // The asymmetry that decides this, and it is the opposite of the sibling passes'.
    // `sensitive-rescreen` narrowed its copy of the sender-rule exclusion so a narrowed rule stops
    // speaking for mail it does not match, and hands those messages to `evaluateRules`. This pass
    // has no evaluator: it decides with `migrationBulkPlacement` and never asks the rules layer
    // anything. Narrowing here would not delegate the question, it would DISCARD it — and a held
    // message that genuinely matches the user's narrowed rule would be auto-moved to Reads over
    // the destination they wrote, silently.
    //
    // So this asserts the conservative behaviour deliberately, and the comment above the predicate
    // says why. Found by review, after the narrowing shipped here with a comment claiming these
    // messages "now reach `evaluateRules`" — which is false of this file.
    const w = await newWorld();
    await optIn(w, true);

    const narrowed = await held(w, { from: "news@narrow.test", headers: STRONG_BULK });
    await db.insert(rules).values({
      accountId: w.accountId, kind: "sender", match: "news@narrow.test",
      destination: READS, priority: 0, provenance: "manual", enabled: true,
      subjectContains: "invoice",
    });

    const r = await screenerAutoApplyPass(db, { accountId: w.accountId });

    expect(r).toMatchObject({ ran: true, moved: 0 });
    expect(
      (await desiredOf(narrowed)).desired,
      "auto-apply moved a message whose sender the user has written a rule about",
    ).toBe(SCREENER);
  });

  it("is idempotent — a second cycle moves nothing new", async () => {
    const w = await newWorld();
    await optIn(w, true);
    await held(w, { from: "news@shop.test", headers: STRONG_BULK });

    const first = await screenerAutoApplyPass(db, { accountId: w.accountId });
    expect(first.moved).toBe(1);
    const second = await screenerAutoApplyPass(db, { accountId: w.accountId });
    expect(second.moved).toBe(0);
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════
  //  (d) THE HEADER PROJECTION — the candidate query ships five keys, and all five still decide
  //
  //  `selectCandidates` no longer selects `message_bodies.headers` whole; it projects the five
  //  names `hasStrongBulkFloor` reads (~86 B against ~4 kB of real RFC-822 headers). That is only
  //  sound while those five are the ONLY names this pass's router reads, so each key below is
  //  asserted through the pass's OUTCOME rather than by inspecting the row.
  //
  //  MUTATION-WATCH: delete any one key from the `jsonb_build_object` in `screener-auto.ts` and
  //  exactly one of these goes red — the gate key fails the first case, each corroborator its own.
  //  Widening the projection back to the whole map keeps them green (they assert behaviour, not
  //  byte count), which is correct: this guards the CUT's safety, not its existence.
  // ══════════════════════════════════════════════════════════════════════════════════════════

  it("MUTATION-WATCH (d): the gate key — List-Unsubscribe absent ⇒ nothing moves, however bulky the rest", async () => {
    const w = await newWorld();
    await optIn(w, true);
    // Every corroborator present, but no `list-unsubscribe`: the floor's first line returns false.
    const noGate = await held(w, { from: "news@shop.test", headers: {
      "list-id": ["<news.shop.test>"],
      "feedback-id": ["1:2:3:esp"],
      "precedence": ["bulk"],
    } });

    const r = await screenerAutoApplyPass(db, { accountId: w.accountId });
    expect(r).toMatchObject({ ran: true, moved: 0 });
    expect((await desiredOf(noGate)).desired, "moved without a List-Unsubscribe").toBe(SCREENER);
  });

  it("MUTATION-WATCH (d): each corroborator alone still carries the floor through the projection", async () => {
    // One case per projected corroborator. `list-unsubscribe` gates all four; the fat headers a real
    // message carries ride along to prove the projection drops them without changing any verdict.
    const NOISE = {
      "received": ["from mx1.shop.test by mx2.example.test; Tue, 12 Aug 2026 10:00:00 +0000"],
      "authentication-results": ["mx.example.test; dkim=pass header.d=shop.test; spf=pass"],
      "dkim-signature": ["v=1; a=rsa-sha256; c=relaxed/relaxed; d=shop.test; s=s1; bh=abc; b=def"],
      "x-mailer": ["ESP 9.9"],
    };
    const corroborators: Array<[string, Record<string, string[]>]> = [
      ["list-id", { "list-id": ["<news.shop.test>"] }],
      ["list-unsubscribe-post", { "list-unsubscribe-post": ["List-Unsubscribe=One-Click"] }],
      ["feedback-id", { "feedback-id": ["1:2:3:esp"] }],
      ["precedence", { "precedence": ["bulk"] }],
    ];

    for (const [name, marker] of corroborators) {
      const w = await newWorld();
      await optIn(w, true);
      const id = await held(w, {
        from: `news@${name.replace(/[^a-z]/g, "")}.test`,
        headers: { ...NOISE, ...WEAK_BULK, ...marker },
      });

      const r = await screenerAutoApplyPass(db, { accountId: w.accountId });
      expect(r, `${name} did not carry the floor`).toMatchObject({ ran: true, moved: 1 });
      expect((await desiredOf(id)).desired, `${name} did not file to Reads`).toBe(READS);
    }
  });

  it("MUTATION-WATCH (d): the money split still reads the subject through the same page", async () => {
    // Receipts-vs-Reads is decided on the SUBJECT column, which the projection does not touch —
    // asserted here so a future trim of the column list cannot quietly collapse the two destinations.
    const w = await newWorld();
    await optIn(w, true);
    const receipt = await held(w, { from: "billing@shop.test", subject: "Your invoice #4021", headers: STRONG_BULK });
    const read = await held(w, { from: "news@shop.test", subject: "This week at the shop", headers: STRONG_BULK });

    const r = await screenerAutoApplyPass(db, { accountId: w.accountId });
    expect(r).toMatchObject({ ran: true, moved: 2 });
    expect((await desiredOf(receipt)).desired).toBe(RECEIPTS);
    expect((await desiredOf(read)).desired).toBe(READS);
  });
});
