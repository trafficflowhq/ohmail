import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { mailboxes, drafts, outboundSends, changeLog } from "@trafficflow/db";
import { materializeDraft } from "../src/dto/materialize.js";
import { makeOwnedDb } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { DraftsService, dbFor } from "../src/index.js";
import type { ServiceContext } from "../src/index.js";

/**
 * A HELD SEND HAS A WAY OUT, AND A FINISHED ONE STOPS HOLDING THE DRAFT.
 *
 * ## What was wrong, in the order a person met it
 *
 * A send whose outcome could not be confirmed leaves `outbound_sends.status = 'unverified'` and
 * `drafts.status = 'unverified'` (`SendService.finalizeUnverified`). The Drafts row then says
 * *"Not confirmed — it may not have been delivered. It's held here; check your Sent folder."* and
 * there was no verb anywhere in the product for answering that sentence. Discard did not work
 * either: `remove` refused for ANY `outbound_sends` row, so the row could not leave by the front
 * door or the back one. Pressed five times on a live account, it stayed five times.
 *
 * The same refusal caught a case that is not ambiguous at all. `finalizeFailed` records a
 * definitively-undelivered attempt and puts the draft back to `draft` with a sentence — nothing is
 * in flight and nothing is unknown — and the delete was refused anyway, because the predicate
 * asked whether a ROW EXISTED rather than whether a send was still on record.
 *
 * ## The predicate, and the constraint underneath it
 *
 * `sendOnRecord` is now `status IN ('pending','unverified')`: an attempt whose outcome is still
 * open. A `sent` or `failed` row is a LEDGER ENTRY about the past and holds nothing.
 *
 * Narrowing the predicate alone could not admit the delete, and this file is where that was
 * measured. `outbound_sends.draft_id` was `NOT NULL … ON DELETE NO ACTION`, so the DELETE reached
 * the constraint and raised `23503` for a `failed`, `sent` and `unverified` row alike — which
 * reaches a caller as an unhandled `internal` 500. That is why the 409 existed in the first place,
 * and why the fix had to be in the schema as well as in the service: `draft_id` is nullable with
 * `ON DELETE SET NULL` (mail 0095). The reservation's identity is `(account_id,
 * idempotency_key)` — the replay gate — not the draft it was once about, so the record of the
 * attempt survives the discard of the text. That is the stated intent: the words go, the fact
 * that something was attempted does not.
 *
 * ## Why these cases and not fewer
 *
 * {@link resolve} is asserted by its EFFECT on both tables rather than by its return, because the
 * two outcomes differ in what they leave behind and a DTO-shaped assertion would pass for either.
 * `arrived` is a terminal confirmation: the ledger row becomes `sent` and the draft becomes `sent`,
 * which takes it out of the Drafts list while leaving the account's record of the send alone.
 * `not_arrived` is the opposite claim and has to leave an ORDINARY DRAFT behind — editable and
 * discardable — or the verb has not actually resolved anything.
 *
 * The ordinary delete is asserted in the same file as a POSITIVE CONTROL. Every other case here is
 * a refusal or the lifting of one, and a suite made only of refusals has no evidence it still
 * admits the thing it is supposed to admit: `sendOnRecord` returning `true` unconditionally would
 * satisfy all of them and make Drafts a one-way door.
 */
const PG_UP = await realPgAvailable();

// The factory's handle: the binder takes a server handle only from the factory that registered its door.
const owned = makeOwnedDb(PG_TEST_URL);
const dbA = owned.db;

const NOW = new Date("2026-09-08T12:00:00.000Z");
const draftsSvc = new DraftsService();

interface World {
  ctx: ServiceContext;
  draftId: string;
  accountId: string;
  sendId: string | null;
}

/**
 * One account, one mailbox, one draft — and at most one `outbound_sends` row, in the status the
 * case is about.
 *
 * A fresh account per case, because this database is shared with every other pg file in the repo:
 * a fixture that reads or writes deployment-globally is how two suites that each pass alone poison
 * each other. Every read below is scoped to this account's own ids.
 */
/**
 * `at` places the attempt's `created_at`, which is the clock `resolve` reads to decide whether a
 * `pending` send may still be running. Absent ⇒ the column's own default, which no case that
 * resolves a `pending` row may rely on.
 */
async function seeded(
  sendStatus: string | null,
  over: { draftStatus?: string; at?: Date } = {},
): Promise<World> {
  const accountId = randomUUID();
  const tag = randomUUID().slice(0, 8);
  const [mb] = await dbA.insert(mailboxes).values({
    accountId, provider: "imap", address: `resolution-${tag}@old.test`,
  }).returning();
  const [d] = await dbA.insert(drafts).values({
    accountId,
    mailboxId: mb!.id,
    subject: "did this go out?",
    body: "text",
    to: [{ name: null, address: "you@example.com" }],
    // The draft status the server itself would be holding for that ledger state:
    // `finalizeUnverified` leaves `unverified`, `finalizeFailed` returns the row to `draft`.
    status: over.draftStatus
      ?? (sendStatus === "unverified" ? "unverified" : sendStatus === "pending" ? "sending" : "draft"),
    createdAt: NOW,
    updatedAt: NOW,
  }).returning();

  let sendId: string | null = null;
  if (sendStatus !== null) {
    const [s] = await dbA.insert(outboundSends).values({
      accountId,
      idempotencyKey: randomUUID(),
      draftId: d!.id,
      mintedMessageId: `<${randomUUID()}@old.test>`,
      status: sendStatus,
      ...(over.at ? { createdAt: over.at } : {}),
    }).returning();
    sendId = s!.id;
  }

  const ctx: ServiceContext = { db: dbFor(dbA, accountId), accountId, userId: null, now: () => NOW, requestId: "r" };
  return { ctx, draftId: d!.id, accountId, sendId };
}

const draftRow = async (w: World) =>
  (await dbA.select().from(drafts)
    .where(and(eq(drafts.id, w.draftId), eq(drafts.accountId, w.accountId))))[0];

const sendRow = async (w: World) =>
  (await dbA.select().from(outboundSends)
    .where(and(eq(outboundSends.id, w.sendId!), eq(outboundSends.accountId, w.accountId))))[0];

/** The thrown refusal, or `null` when the call succeeded. */
async function refusalOf(p: Promise<unknown>): Promise<{ httpStatus?: number; code?: string } | null> {
  try {
    await p;
    return null;
  } catch (e) {
    return e as { httpStatus?: number; code?: string };
  }
}

beforeAll(async () => { if (PG_UP) await runMigrations(PG_TEST_URL); }, 120_000);
afterAll(async () => { await owned.close(); });

describe.skipIf(!PG_UP)("a held send can be resolved, and a finished one stops holding the draft", () => {
  it("THE POSITIVE CONTROL — an ordinary draft with nothing on record is discarded", async () => {
    const w = await seeded(null);

    const err = await refusalOf(draftsSvc.remove(w.ctx, w.draftId));

    expect(err, "an ordinary draft with no send on record was refused the delete").toBeNull();
    expect(
      await draftRow(w),
      "the ordinary delete stopped working — every other case in this file is a refusal, so this "
      + "is the one that fails if the predicate is widened until Drafts is a one-way door",
    ).toBeUndefined();
  });

  it("a send STILL RUNNING holds the draft — 409 by name, never the foreign key", async () => {
    const w = await seeded("pending", { at: NOW });

    const err = await refusalOf(draftsSvc.remove(w.ctx, w.draftId));

    expect(err, "a draft whose send may be on the wire was deleted").not.toBeNull();
    expect(err!.httpStatus).toBe(409);
    expect(err!.code, "the refusal does not name the reason a person can act on").toBe("send_recorded");
    expect(await draftRow(w), "the account's only copy of a message being sent was removed").toBeDefined();
  });

  /**
   * THE DISCARD THE OWNER PRESSED FOR WEEKS. An `unverified` row used to be refused here ("resolve
   * it first"), and a person who did not understand the question never could. The words are theirs:
   * the row goes; the ledger keeps the attempt, stamped `resolved_by = 'discard'`, `draft_id` NULL by
   * the FK, status untouched — a discard is not evidence about delivery.
   *
   * Mutation: put `unverified` back into the refusal (`open.some(a => a.status !== "sent")`) → the
   * first assertion reads a 409 and the round trip below never starts.
   */
  it("a send we could not confirm no longer holds the draft — discarded, ledger stamped by the discard", async () => {
    const w = await seeded("unverified");

    const err = await refusalOf(draftsSvc.remove(w.ctx, w.draftId));

    expect(err, "the held row was refused its discard — the question with no exit, again").toBeNull();
    expect(await draftRow(w), "the row survived a discard that reported success").toBeUndefined();
    const ledger = await sendRow(w);
    expect(ledger, "the record of the attempt was deleted with the draft").toBeDefined();
    expect(ledger!.status, "a discard rewrote the attempt's recorded outcome").toBe("unverified");
    expect(ledger!.resolvedBy, "the ledger does not say the question was closed by a discard").toBe("discard");
    expect(ledger!.resolvedAt?.toISOString()).toBe(NOW.toISOString());
    expect(ledger!.draftId).toBeNull();
  });

  /**
   * DISCARD, DRAIN, LIST — the row cannot come back. The three readers a client has for a draft
   * after a delete: the DTO (`materializeDraft`, what `/sync` re-materializes a change into), the
   * change log (the tombstone the drain carries), and a second delete (404, the convergent answer).
   * With the record left behind unstamped nothing re-hydrates the row either — the row is gone from
   * `drafts` and every reader keys on that table. The mutation that RE-HYDRATES: leave the draft
   * row in place (refuse the delete) — the DTO reads it back and the list shows it again.
   */
  it("discard, drain, list: the DTO is gone, the drain carries a delete, a second discard is 404", async () => {
    const w = await seeded("unverified");
    const before = await w.ctx.db.select({ seq: changeLog.seq }).from(changeLog)
      .where(and(eq(changeLog.accountId, w.accountId), eq(changeLog.entityId, w.draftId)));

    const { seq } = await draftsSvc.remove(w.ctx, w.draftId);

    expect(await materializeDraft(w.ctx.db, w.accountId, w.draftId), "the DTO re-hydrates a discarded draft").toBeNull();
    const after = await w.ctx.db.select({ seq: changeLog.seq, op: changeLog.op, entityType: changeLog.entityType })
      .from(changeLog)
      .where(and(eq(changeLog.accountId, w.accountId), eq(changeLog.entityId, w.draftId)));
    expect(after.length).toBe(before.length + 1);
    const tombstone = after.find((c) => Number(c.seq) === seq);
    expect(tombstone, "the seq the door answered with is not in the account's change log").toBeDefined();
    expect(tombstone!.op, "the drain carries something other than a delete for the discarded row").toBe("delete");
    expect(tombstone!.entityType).toBe("draft");
    const again = await refusalOf(draftsSvc.remove(w.ctx, w.draftId));
    expect(again?.httpStatus, "a second discard of the discarded did not converge on 404").toBe(404);
    expect(
      (await dbA.select({ id: drafts.id }).from(drafts).where(eq(drafts.accountId, w.accountId))).length,
      "the account still lists a draft after the discard",
    ).toBe(0);
  });

  it("a send that definitively FAILED holds nothing — the draft is discarded and the ledger keeps the attempt", async () => {
    const w = await seeded("failed");

    const err = await refusalOf(draftsSvc.remove(w.ctx, w.draftId));

    expect(
      err,
      "a draft whose send definitively failed was refused the delete. Nothing is in flight and "
      + "nothing is unknown: this is a ledger entry about the past, and it was holding the text "
      + "hostage for ever",
    ).toBeNull();
    expect(await draftRow(w), "the draft survived a delete that reported success").toBeUndefined();

    const ledger = await sendRow(w);
    expect(ledger, "the record of the attempt was deleted with the draft — nothing cascades here").toBeDefined();
    expect(
      ledger!.draftId,
      "the ledger row still points at a draft that is gone, which is the foreign key this delete "
      + "used to reach as a 500",
    ).toBeNull();
    expect(ledger!.status, "the attempt's recorded outcome was rewritten by a discard").toBe("failed");
  });

  it("`not_arrived` puts the row back to an ordinary draft, and THEN it discards", async () => {
    const w = await seeded("unverified");

    const { draft } = await draftsSvc.resolve(w.ctx, w.draftId, "not_arrived");

    expect(draft.status, "the resolved row is not an ordinary draft, so nothing was resolved").toBe("draft");
    const send = await sendRow(w);
    expect(send!.status, "the attempt is still open after the person said it never arrived").toBe("failed");
    expect(send!.resolvedBy, "nothing records WHO decided this").toBe("person");
    expect(send!.resolvedAt, "nothing records WHEN it was decided").not.toBeNull();

    // The whole point of the verb: the row a person could not get rid of is now ordinary.
    const err = await refusalOf(draftsSvc.remove(w.ctx, w.draftId));
    expect(err, "a resolved draft is still undeletable — the hold outlived its own resolution").toBeNull();
    expect(await draftRow(w), "the resolved draft survived its discard").toBeUndefined();
  });

  it("`arrived` marks the send delivered and takes the row out of Drafts, keeping the ledger", async () => {
    const w = await seeded("unverified");

    const { draft } = await draftsSvc.resolve(w.ctx, w.draftId, "arrived");

    expect(draft.status, "a message the person confirmed arrived is not recorded as sent").toBe("sent");
    const send = await sendRow(w);
    expect(send!.status, "the ledger still calls a confirmed delivery unverified").toBe("sent");
    expect(send!.resolvedBy).toBe("person");
    expect(send!.resolvedAt).not.toBeNull();
    expect(
      await draftRow(w),
      "the draft row was deleted rather than marked sent — the Sent copy is the mail, but this row "
      + "is the account's record of it and `arrived` is not a discard",
    ).toBeDefined();
  });

  it("resolving twice is the asked-for state, not an error and not a second write", async () => {
    const w = await seeded("unverified");

    await draftsSvc.resolve(w.ctx, w.draftId, "arrived");
    const first = await sendRow(w);

    const err = await refusalOf(draftsSvc.resolve(w.ctx, w.draftId, "arrived"));

    expect(err, "a repeated resolve is an error, so a retry after a blip reports a failure").toBeNull();
    const second = await sendRow(w);
    expect(second!.status, "the second resolve rewrote a terminal outcome").toBe("sent");
    expect(
      second!.resolvedAt?.getTime(),
      "the second resolve re-stamped the resolution, so a retry moves the record of when a person "
      + "decided",
    ).toBe(first!.resolvedAt?.getTime());
  });

  it("the OTHER outcome does not reopen a resolution somebody already made", async () => {
    const w = await seeded("unverified");

    await draftsSvc.resolve(w.ctx, w.draftId, "arrived");
    await draftsSvc.resolve(w.ctx, w.draftId, "not_arrived");

    const send = await sendRow(w);
    expect(
      send!.status,
      "`not_arrived` overwrote a delivery the person had already confirmed — the one direction "
      + "that turns a sent message back into an unsent one",
    ).toBe("sent");
  });
});

/** An attempt older than every invocation's lifetime — nothing is going to settle it but a person. */
const STOPPED = new Date(NOW.getTime() - 60 * 60 * 1000);
/** An attempt half a minute old — it may be mid-SMTP this second. */
const RUNNING = new Date(NOW.getTime() - 30 * 1000);

/**
 * ═══ AND THE TWO ROWS THE VERB DID NOT REACH ══════════════════════════════════════════════
 *
 * Measured at that change over every (draft status × ledger status) pair: `resolve` moved exactly
 * one of them. Its compare-and-swap was `outbound_sends.status = 'unverified'`, so for a row stuck
 * at `sending` — an attempt that died mid-flight and never came back to say anything — both verbs
 * answered **200 with nothing written**, and `remove` answered 409 `send_recorded` because the
 * reservation was still `pending`. Neither door opened, and the 200 made the surface report a
 * success for a press that did nothing. A held draft whose attempt never settled (`unverified`
 * draft, `pending` ledger) read the same way.
 *
 * The one thing a person may NOT answer for is a send that could still be running: marking a live
 * attempt `failed` frees the row, and the next press delivers a second copy of mail already on the
 * wire. So a `pending` attempt younger than `SEND_STALE_AFTER_MS` is refused by name.
 *
 * And with nothing open left, the LEDGER names the state rather than the person — a recorded
 * delivery is a fact, and neither verb may overwrite one in either direction.
 */
describe.skipIf(!PG_UP)("a send that never answered at all resolves too", () => {
  it("`not_arrived` frees a stranded `sending` row, and THEN it discards", async () => {
    const w = await seeded("pending", { at: STOPPED });

    const { draft } = await draftsSvc.resolve(w.ctx, w.draftId, "not_arrived");

    expect(
      draft.status,
      "the row is still `sending` — the verb answered 200 and moved nothing, which is the state "
      + "with no exit this closes",
    ).toBe("draft");
    const send = await sendRow(w);
    expect(send!.status, "the attempt nobody settled is still open").toBe("failed");
    expect(send!.resolvedBy, "nothing records WHO decided this").toBe("person");

    const err = await refusalOf(draftsSvc.remove(w.ctx, w.draftId));
    expect(err, "the freed row is still undeletable — nothing was actually resolved").toBeNull();
    expect(await draftRow(w), "the resolved draft survived its discard").toBeUndefined();
  });

  it("`arrived` records the stranded send as delivered and takes the row out of Drafts", async () => {
    const w = await seeded("pending", { at: STOPPED });

    const { draft } = await draftsSvc.resolve(w.ctx, w.draftId, "arrived");

    expect(draft.status, "a message the person found in Sent is not recorded as sent").toBe("sent");
    expect((await sendRow(w))!.status, "the ledger still calls a confirmed delivery pending").toBe("sent");
    expect(await draftRow(w), "`arrived` deleted the account's record of the message").toBeDefined();
  });

  it("a HELD draft whose attempt never settled resolves by the same door", async () => {
    const w = await seeded("pending", { draftStatus: "unverified", at: STOPPED });

    const { draft } = await draftsSvc.resolve(w.ctx, w.draftId, "not_arrived");

    expect(
      draft.status,
      "the surface offers both verbs for this row and the server moved neither — the person "
      + "presses an answer and the row does not move",
    ).toBe("draft");
    expect((await sendRow(w))!.status).toBe("failed");
  });

  it("THE REFUSAL — a send that may still be running is not a person's to answer", async () => {
    for (const outcome of ["not_arrived", "arrived"] as const) {
      const w = await seeded("pending", { at: RUNNING });

      const err = await refusalOf(draftsSvc.resolve(w.ctx, w.draftId, outcome));

      expect(
        err,
        `\`${outcome}\` settled an attempt that may be mid-SMTP this second. Marking a live send `
        + "failed frees the row, and the next press delivers a second copy of mail already on the "
        + "wire — the one ending the whole reservation design exists to make impossible",
      ).not.toBeNull();
      expect(err!.httpStatus).toBe(409);
      expect(err!.code, "the refusal does not name a state a person can wait out").toBe("send_still_running");
      expect((await draftRow(w))!.status, "a refused resolve moved the draft anyway").toBe("sending");
      expect((await sendRow(w))!.status, "a refused resolve settled the attempt anyway").toBe("pending");
    }
  });

  it("with nothing open, the LEDGER names the state — `not_arrived` cannot unsend a delivery", async () => {
    const w = await seeded("sent", { draftStatus: "sending", at: STOPPED });

    const { draft } = await draftsSvc.resolve(w.ctx, w.draftId, "not_arrived");

    expect(
      draft.status,
      "the person's answer overwrote a recorded delivery, so a message that went out is offered "
      + "back as an unsent draft to send again",
    ).toBe("sent");
    expect((await sendRow(w))!.status, "the ledger was rewritten by a verb").toBe("sent");
    expect((await sendRow(w))!.resolvedBy, "a settled attempt was re-stamped with a person").toBeNull();
  });

  /**
   * THE ENDING IS RECORDED WHERE THE MACHINE'S ENDINGS ARE, and the REAL logger is driven: the
   * field census is the half a fake sink cannot see, and it has swallowed instrumentation twice
   * before. A dropped name would leave the one line that says how a stuck send finished carrying
   * neither the outcome nor the row.
   *
   * Mutation: rename any field in `resolveLog.info`. Real failure text:
   *   AssertionError: the resolution's log line lost a field to the census …
   */
  it("the resolution is logged, with every field the census lets through", async () => {
    const w = await seeded("pending", { at: STOPPED });
    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((l: unknown) => { lines.push(String(l)); });
    try {
      await draftsSvc.resolve(w.ctx, w.draftId, "not_arrived");
    } finally {
      spy.mockRestore();
    }

    const line = lines.map((l) => { try { return JSON.parse(l) as Record<string, unknown>; } catch { return null; } })
      .find((o) => o !== null && o.event === "send_resolved");
    expect(
      line,
      "a send settled by a person leaves no line at all — the only endings in the log are the "
      + "machine's, so a stuck row that a person freed is invisible beside `send_phases`",
    ).toBeDefined();
    expect(line!.service).toBe("send");
    expect(
      line!.droppedFields,
      "the resolution's log line lost a field to the census in `packages/core/src/log.ts` — the "
      + "half a fake sink cannot see",
    ).toBeUndefined();
    expect(line!.draftId).toBe(w.draftId);
    expect(line!.outcome).toBe("not_arrived");
    expect(line!.status, "the line does not say which state the row was resolved TO").toBe("draft");
    expect(line!.state, "the line cannot tell a freed row from an already-answered one").toBe("moved");
  });

  it("with nothing open, `arrived` cannot promote a recorded failure to a delivery", async () => {
    const w = await seeded("failed", { draftStatus: "sending", at: STOPPED });

    const { draft } = await draftsSvc.resolve(w.ctx, w.draftId, "arrived");

    expect(
      draft.status,
      "the row was filed as sent on a person's guess against a recorded failure — and then it is "
      + "out of Drafts, so the text nobody delivered is gone from the one list that holds it",
    ).toBe("draft");
    expect((await sendRow(w))!.status, "the ledger's recorded failure was rewritten").toBe("failed");
  });
});
