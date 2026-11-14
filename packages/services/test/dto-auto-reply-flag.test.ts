import { accountOfMessage } from "@trafficflow/db";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { awayReplies, messageBodies, messages } from "@trafficflow/db";
import { eq } from "drizzle-orm";
import { materializeMessage, materializeMessages, messageRowToDTO } from "../src/dto/materialize.js";
import { makeCtx, seedMessage } from "./helpers.js";

/**
 * ═══ `MessageDTO.autoReplyByUs` — THE TRUTH TABLE ════════════════════════════════════════
 *
 * The client cannot compute this: raw headers cross the wire in neither body mode, and the
 * `away_replies` ledger is not mirrored at all. So the server decides, once per page, and this
 * file is what pins WHICH rows it decides for.
 *
 * The table has four rows and the three FALSE ones are the ones worth having. A flag that is
 * true for the right rows and also for a few wrong ones takes the person's own mail out of their
 * Ohbox, which is a bigger fault than the one being fixed.
 *
 *   ledger-correlated own-sent reply .............. TRUE   (the responder sent it)
 *   own-sent reply with the header marker only .... TRUE   (the belt: sent before the ledger
 *                                                           existed, or by another client)
 *   own-sent reply the PERSON wrote ............... FALSE  (no ledger row, no marker)
 *   INBOUND auto-reply from a stranger ............ FALSE  ("by us" is half the claim)
 */

const OWN = "mila@lichtgrat.example";

async function withHeaders(
  db: Awaited<ReturnType<typeof makeCtx>>["db"], id: string, headers: Record<string, unknown>,
) {
  await db.insert(messageBodies).values({ messageId: id, accountId: accountOfMessage(id), text: "", headers });
}

/** Give a seeded row a bare (bracket-free) Message-ID, as ingest writes it. */
async function withBareMessageId(
  db: Awaited<ReturnType<typeof makeCtx>>["db"], id: string, bare: string,
) {
  await db.update(messages).set({ messageIdHeader: bare }).where(eq(messages.id, id));
}

describe("MessageDTO.autoReplyByUs", () => {
  it("is TRUE for a Sent copy correlated to an away_replies ledger row", async () => {
    const { db, accountId, mailboxId } = await makeCtx();
    const id = await seedMessage(db, accountId, mailboxId, { from: OWN, folder: "Sent", desired: "Sent" });
    const bare = `${randomUUID()}@lichtgrat.example`;
    await withBareMessageId(db, id, bare);
    // The ledger stores the id WITH the angle brackets the responder minted; ingest stored it
    // without. That mismatch is why the correlation is a trim and not an `=`.
    /* The ledger names the message it ANSWERED — a real incoming row, not a minted uuid: mail
       0118 keys `away_replies` to `(message_id, account_id)`, and the Sent copy above is a
       different message, which is the whole shape this correlation exists for. */
    const answered = await seedMessage(db, accountId, mailboxId, { from: "them@elsewhere.test" });
    await db.insert(awayReplies).values({
      accountId, mailboxId, messageId: answered, sender: "them@elsewhere.test",
      outcome: "sent", mintedMessageId: `<${bare}>`,
    });
    const dto = (await materializeMessages(db, accountId, [id])).get(id);
    expect(dto?.autoReplyByUs).toBe(true);
  });

  it("is TRUE for an own-sent reply carrying only the header marker — the belt", async () => {
    const { db, accountId, mailboxId } = await makeCtx();
    const id = await seedMessage(db, accountId, mailboxId, { from: OWN, folder: "Sent", desired: "Sent" });
    await withHeaders(db, id, { "auto-submitted": ["auto-replied"] });
    const dto = (await materializeMessages(db, accountId, [id])).get(id);
    expect(dto?.autoReplyByUs).toBe(true);
  });

  it("is FALSE for a reply the PERSON wrote — no ledger row, no marker", async () => {
    const { db, accountId, mailboxId } = await makeCtx();
    const id = await seedMessage(db, accountId, mailboxId, { from: OWN, folder: "Sent", desired: "Sent" });
    await withHeaders(db, id, { "auto-submitted": ["no"], subject: ["Re: the roof"] });
    const dto = (await materializeMessages(db, accountId, [id])).get(id);
    expect(dto?.autoReplyByUs).toBe(false);
  });

  /**
   * THE ARM THE SUBJECT HEURISTIC WOULD HAVE BROKEN.
   *
   * `isMachineSent` also matches an out-of-office SUBJECT, and reusing the whole of it here would
   * make this row true. On the account that reported the bug there were TWO such messages — mail
   * the person wrote, which would have vanished from their Ohbox. `hasMachineSentHeaders` is the
   * headers alone for exactly this reason.
   */
  it("is FALSE for the person's own message whose SUBJECT looks like an out-of-office", async () => {
    const { db, accountId, mailboxId } = await makeCtx();
    const id = await seedMessage(db, accountId, mailboxId, {
      from: OWN, folder: "Sent", desired: "Sent", subject: "Re: Out of office",
    });
    await withHeaders(db, id, {});
    const dto = (await materializeMessages(db, accountId, [id])).get(id);
    expect(dto?.autoReplyByUs).toBe(false);
  });

  it("is FALSE for an INBOUND auto-reply from a stranger", async () => {
    const { db, accountId, mailboxId } = await makeCtx();
    const id = await seedMessage(db, accountId, mailboxId, {
      from: "stranger@elsewhere.test", folder: "INBOX", desired: "INBOX",
    });
    await withHeaders(db, id, { "auto-submitted": ["auto-replied"] });
    const dto = (await materializeMessages(db, accountId, [id])).get(id);
    expect(dto?.autoReplyByUs).toBe(false);
  });

  /**
   * THE RECEIPT PATH CARRIES IT TOO. `materializeMessage` passes `deleted: "include"`, and a DTO
   * that answered on the living view but not on the receipt would let `MessageService.delete`'s
   * echo disagree with the row the client already holds.
   */
  it("is set on the `deleted: include` receipt path as well", async () => {
    const { db, accountId, mailboxId } = await makeCtx();
    const id = await seedMessage(db, accountId, mailboxId, { from: OWN, folder: "Sent", desired: "Sent" });
    await withHeaders(db, id, { "auto-submitted": ["auto-replied"] });
    await db.update(messages).set({ deletedAt: new Date() }).where(eq(messages.id, id));
    const dto = await materializeMessage(db, accountId, id);
    expect(dto?.autoReplyByUs).toBe(true);
  });

  /**
   * THE KEY IS ABSENT, not present-and-undefined, when nobody asked. The two are identical in
   * TypeScript and different over JSON, and "this server does not know" has to serialize exactly
   * like "this server predates the field" — which is what makes the client's `!== true` correct.
   */
  it("omits the key entirely from a direct projection that was not given the fact", async () => {
    const { db, accountId, mailboxId } = await makeCtx();
    const id = await seedMessage(db, accountId, mailboxId, { from: OWN, folder: "Sent", desired: "Sent" });
    const [row] = await db.select().from(messages).where(eq(messages.id, id));
    const dto = messageRowToDTO(row!, undefined, undefined, undefined);
    expect("autoReplyByUs" in dto).toBe(false);
    expect(JSON.stringify(dto)).not.toContain("autoReplyByUs");
  });

  /**
   * ONE QUERY PER PAGE, NOT ONE PER ROW. The flag is a set membership computed once over the
   * surviving ids; the constancy property `search-materialize.test.ts` guards for the whole batch
   * is asserted here for the flag's own query, because a per-row `exists` is the tempting shape
   * and it scales with the page.
   */
  it("costs the same number of statements for one message and for six", async () => {
    const { db, accountId, mailboxId } = await makeCtx();
    const first = await seedMessage(db, accountId, mailboxId, { from: OWN, folder: "Sent", desired: "Sent" });
    await withHeaders(db, first, { "auto-submitted": ["auto-replied"] });

    const count = async (ids: string[]): Promise<number> => {
      const spy = vi.spyOn(db, "select");
      try {
        await materializeMessages(db, accountId, ids);
        return spy.mock.calls.length;
      } finally { spy.mockRestore(); }
    };

    const one = await count([first]);
    const more: string[] = [first];
    for (let i = 0; i < 5; i++) {
      const id = await seedMessage(db, accountId, mailboxId, { from: OWN, folder: "Sent", desired: "Sent" });
      await withHeaders(db, id, { "auto-submitted": ["auto-replied"] });
      more.push(id);
    }
    const six = await count(more);
    expect(six).toBe(one);
    // And the flag is right for every one of them, so the constancy is not constancy over nothing.
    const dtos = await materializeMessages(db, accountId, more);
    expect([...dtos.values()].every((d) => d.autoReplyByUs === true)).toBe(true);
    expect(dtos.size).toBe(6);
  });
});
