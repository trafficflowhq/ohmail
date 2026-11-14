import { accountOfMessage } from "@trafficflow/db";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { awayReplies, messageBodies, messages } from "@trafficflow/db";
import { eq, sql } from "drizzle-orm";
import { materializeMessage, materializeMessages, messageRowToDTO } from "../src/dto/materialize.js";
import { makeCtx, otherAccount, seedMessage } from "./helpers.js";

/**
 * ═══ `MessageDTO.awayRepliedAt` — THE TRUTH TABLE ═════════════════════════════════════════
 *
 * The stamp on the ORIGINAL: "the away responder answered this message, at this instant". It is
 * the other half of `autoReplyByUs`, which marks the REPLY, and the two are on DIFFERENT rows —
 * the last case in this file is the pair in one batch, because a projection that put both on one
 * row would read as a coherent answer and be wrong about which message a reader is looking at.
 *
 * The table's FALSE rows are the ones worth having. A stamp is a sentence on screen saying a
 * correspondent has been answered, so every decision NOT to answer must produce no stamp:
 *
 *   sent, with a send instant ................. the instant   (the responder answered)
 *   unverified, with a send instant ........... the instant   (SMTP threw, the claim is KEPT —
 *                                                              see the `unverified` case below)
 *   unverified, no send instant ............... null          (today's production shape)
 *   pending / throttled / suppressed .......... null          (decisions not to answer, or not yet)
 *   another account's ledger row .............. null          (the read is account-scoped)
 *   the responder's own SENT COPY ............. null          (the ledger keys on the ORIGINAL)
 */

const OWN = "mila@lichtgrat.example";
const READS = "ohmail/News";
const SENT_AT = new Date("2026-09-09T08:15:00.000Z");

type Ctx = Awaited<ReturnType<typeof makeCtx>>;

/** One ledger row against `messageId` — the ORIGINAL's id, which is what the ledger keys on. */
async function ledger(
  c: Ctx,
  messageId: string,
  outcome: "sent" | "unverified" | "pending" | "throttled" | "suppressed",
  sentAt: Date | null,
  over?: { accountId?: string; mailboxId?: string },
): Promise<void> {
  await c.db.insert(awayReplies).values({
    accountId: over?.accountId ?? c.accountId,
    mailboxId: over?.mailboxId ?? c.mailboxId,
    messageId,
    sender: "news@sender.test",
    outcome,
    sentAt,
  });
}

const stampOf = async (c: Ctx, id: string): Promise<string | null | undefined> =>
  (await materializeMessages(c.db, c.accountId, [id])).get(id)?.awayRepliedAt;

describe("MessageDTO.awayRepliedAt", () => {
  it("is the ledger's `sent_at` for a message the responder ANSWERED", async () => {
    const c = await makeCtx();
    const id = await seedMessage(c.db, c.accountId, c.mailboxId, { folder: READS, desired: READS });
    await ledger(c, id, "sent", SENT_AT);
    expect(await stampOf(c, id)).toBe(SENT_AT.toISOString());
  });

  /**
   * THE `unverified` ARM, AND WHY IT IS IN THE OUTCOME SET AT ALL.
   *
   * `away-responder-pass.ts#finalize` writes `sent_at` ONLY on `sent`, in as many words — *"an
   * `unverified` row has no send instant it can honestly claim"* — so the shape production writes
   * today for an SMTP throw is `unverified` with a NULL instant, and that yields no stamp. Both
   * halves are asserted, in that order, and the second is the reason the member is not decorative:
   * the responder KEEPS the claim on an `unverified` row and will never offer a second reply, so
   * the day that finalizer learns to record an ambiguous send this field must say so. Without this
   * pair the `unverified` term would be a condition nobody had watched matter.
   */
  it("is NULL for an `unverified` row with no send instant — production's SMTP-throw shape", async () => {
    const c = await makeCtx();
    const id = await seedMessage(c.db, c.accountId, c.mailboxId, { folder: READS, desired: READS });
    await ledger(c, id, "unverified", null);
    expect(await stampOf(c, id)).toBeNull();
  });

  it("is the instant for an `unverified` row that DOES carry one", async () => {
    const c = await makeCtx();
    const id = await seedMessage(c.db, c.accountId, c.mailboxId, { folder: READS, desired: READS });
    await ledger(c, id, "unverified", SENT_AT);
    expect(await stampOf(c, id)).toBe(SENT_AT.toISOString());
  });

  /**
   * THE THREE DECISIONS NOT TO ANSWER. Each is a real production row — the reservation before the
   * dial (`pending`), the per-sender refusal (`throttled`), an eligibility guard holding
   * (`suppressed`) — and every one of them is written with `sent_at: null`, which is why they are
   * asserted here as the rows they actually are rather than as a constructed outcome string.
   */
  for (const outcome of ["pending", "throttled", "suppressed"] as const) {
    it(`is NULL for a \`${outcome}\` row — the responder did not answer`, async () => {
      const c = await makeCtx();
      const id = await seedMessage(c.db, c.accountId, c.mailboxId, { folder: READS, desired: READS });
      await ledger(c, id, outcome, null);
      expect(await stampOf(c, id)).toBeNull();
    });
  }

  /**
   * THE ONE CASE THAT TELLS THE OUTCOME FILTER APART FROM EVERYTHING ELSE — and it is here
   * because the obvious mutation stayed GREEN.
   *
   * Deleting `inArray(outcome, ["sent","unverified"])` left all twelve of the other cases passing,
   * and the reason is not that the term is dead: every non-`sent` row production writes carries
   * `sent_at: null`, and a null instant produces a null stamp whether the database filtered the
   * row or the projection did. So the three decision rows above measure the PAIR, not the part.
   *
   * The discriminator has to vary ONE thing: an out-of-set outcome WITH an instant. The schema
   * permits it — `away_replies`'s CHECK constrains the outcome alone, nothing ties `sent_at` to it
   * — so this is a state a hand repair or a backfill can produce, not a fiction. It is the only
   * shape in which the outcome filter decides an answer, and with this case the mutation reds.
   */
  it("is NULL for a `throttled` row that DOES carry an instant — the filter, discriminated", async () => {
    const c = await makeCtx();
    const id = await seedMessage(c.db, c.accountId, c.mailboxId, { folder: READS, desired: READS });
    await ledger(c, id, "throttled", SENT_AT);
    expect(await stampOf(c, id)).toBeNull();
  });

  it("is NULL for a message with no ledger row at all — ordinary mail", async () => {
    const c = await makeCtx();
    const id = await seedMessage(c.db, c.accountId, c.mailboxId, { folder: READS, desired: READS });
    expect(await stampOf(c, id)).toBeNull();
  });

  /**
   * THE ACCOUNT SCOPING, AND THE ROW IS BUILT SO ONLY THE SCOPING CAN EXPLAIN THE ANSWER.
   *
   * `away_replies` carries no foreign key to `messages` (the header on the table says why: the
   * record has to outlive the message it answers), so a row naming ANOTHER account and OUR
   * message id is storable — and its `outcome`/`sent_at` are the true ones, so if the predicate
   * dropped `account_id` this case would report the stamp. Nothing else in the row could.
   */
  it("a ledger row for our message under another account is REFUSED, and unread if planted anyway", async () => {
    /* The read is account-scoped, and since mail 0118 keyed `away_replies` to
       `(message_id, account_id)` the disagreeing row cannot be written at all — the stronger
       guarantee, asserted first. The predicate is then still driven, against a row planted with
       that ONE key dropped, so dropping it from the read reddens here rather than passing. */
    const c = await makeCtx();
    const id = await seedMessage(c.db, c.accountId, c.mailboxId, { folder: READS, desired: READS });
    const other = await otherAccount(c.db);
    const row = {
      accountId: other.accountId, mailboxId: other.mailboxId, messageId: id,
      sender: "news@sender.test", outcome: "sent" as const, sentAt: SENT_AT,
    };
    const verdict = await c.db.insert(awayReplies).values(row).then(
      () => "admitted",
      (e: unknown) => (/away_replies_message_id_account_fk/.test(String(e))
        ? "refused-by-the-key" : `refused-otherwise:${String(e)}`),
    );
    expect(verdict, "the cross-account ledger row is representable again").toBe("refused-by-the-key");
    await c.db.execute(sql`alter table away_replies
      drop constraint away_replies_message_id_account_fk`);
    await c.db.insert(awayReplies).values(row);
    expect(await stampOf(c, id)).toBeNull();
  });

  /**
   * ═══ THE MARK IS ON THE ORIGINAL AND THE FLAG IS ON THE REPLY — one batch, both rows ═══
   *
   * The hard stop this file exists to keep: no mark on the Sent copy. The ledger keys on the
   * ORIGINAL's id, so the reply's own id has no row and its stamp is `null` by construction —
   * which is the point, and is why both rows are read from ONE `materializeMessages` call. Two
   * separate calls would let a projection that stamped whatever row it was handed pass.
   */
  it("stamps the ORIGINAL and never the responder's own Sent copy", async () => {
    const c = await makeCtx();
    const original = await seedMessage(c.db, c.accountId, c.mailboxId, {
      from: "news@sender.test", folder: READS, desired: READS,
    });
    const reply = await seedMessage(c.db, c.accountId, c.mailboxId, {
      from: OWN, folder: "Sent", desired: "Sent", subject: "Re: the roundup",
    });
    // The reply wears the header marker, so `autoReplyByUs` is true for it — the flag and the
    // stamp are then observably on different rows rather than merely absent from one.
    await c.db.insert(messageBodies).values({
      messageId: reply, accountId: accountOfMessage(reply), text: "", headers: { "auto-submitted": ["auto-replied"] },
    });
    await ledger(c, original, "sent", SENT_AT);

    const dtos = await materializeMessages(c.db, c.accountId, [original, reply]);
    expect(dtos.get(original)?.awayRepliedAt).toBe(SENT_AT.toISOString());
    expect(dtos.get(original)?.autoReplyByUs).toBe(false);
    expect(dtos.get(reply)?.awayRepliedAt).toBeNull();
    expect(dtos.get(reply)?.autoReplyByUs).toBe(true);
  });

  /**
   * THE RECEIPT PATH CARRIES IT TOO — `materializeMessage` passes `deleted: "include"`, and a
   * field that answered on the living view and not on the receipt would let `MessageService`'s
   * echo disagree with the row the client already holds about something the `update` before it
   * did not change.
   */
  it("is set on the `deleted: include` receipt path as well", async () => {
    const c = await makeCtx();
    const id = await seedMessage(c.db, c.accountId, c.mailboxId, { folder: READS, desired: READS });
    await ledger(c, id, "sent", SENT_AT);
    await c.db.update(messages).set({ deletedAt: new Date() }).where(eq(messages.id, id));
    expect((await materializeMessage(c.db, c.accountId, id))?.awayRepliedAt).toBe(SENT_AT.toISOString());
  });

  /**
   * ABSENT, not present-and-undefined, when nobody asked. Identical in TypeScript and different
   * over JSON: "this server does not know" has to serialize exactly like "this server predates
   * the field", which is what makes a client older than the field correct without a deploy order.
   */
  it("omits the key entirely from a direct projection that was not given the fact", async () => {
    const c = await makeCtx();
    const id = await seedMessage(c.db, c.accountId, c.mailboxId, { folder: READS, desired: READS });
    const [row] = await c.db.select().from(messages).where(eq(messages.id, id));
    const dto = messageRowToDTO(row!, undefined, undefined, undefined);
    expect("awayRepliedAt" in dto).toBe(false);
    expect(JSON.stringify(dto)).not.toContain("awayRepliedAt");
  });

  /**
   * ONE QUERY PER PAGE, NOT ONE PER ROW — the constancy property `materializeMessages` exists to
   * hold, asserted for this read's own query. A per-row `exists` against the ledger is the
   * tempting shape and it scales with the page, which is the outage that function was written to
   * end.
   */
  it("costs the same number of statements for one message and for six", async () => {
    const c = await makeCtx();
    const first = await seedMessage(c.db, c.accountId, c.mailboxId, { folder: READS, desired: READS });
    await ledger(c, first, "sent", SENT_AT);

    const count = async (ids: string[]): Promise<number> => {
      const spy = vi.spyOn(c.db, "select");
      try {
        await materializeMessages(c.db, c.accountId, ids);
        return spy.mock.calls.length;
      } finally { spy.mockRestore(); }
    };

    const one = await count([first]);
    const more: string[] = [first];
    for (let i = 0; i < 5; i++) {
      const id = await seedMessage(c.db, c.accountId, c.mailboxId, { folder: READS, desired: READS });
      await ledger(c, id, "sent", SENT_AT);
      more.push(id);
    }
    const six = await count(more);
    expect(six).toBe(one);
    // And the stamp is right for every one of them, so the constancy is not constancy over nothing.
    const dtos = await materializeMessages(c.db, c.accountId, more);
    expect(dtos.size).toBe(6);
    expect([...dtos.values()].every((d) => d.awayRepliedAt === SENT_AT.toISOString())).toBe(true);
  });
});
