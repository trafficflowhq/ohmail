import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { accounts, invitationCalendarId, mailboxes, messageInvitations, messages } from "@trafficflow/db";
import { materializeMessage, materializeMessages } from "../src/dto/materialize.js";
import { makeCtx, seedMessage } from "./helpers.js";

/**
 * `MessageDTO.invitation` — the invitation a letter carries (mail 0204), joined in the one statement
 * that materializes every message: present with exactly the row's values, ABSENT (not null) on a
 * letter without a row, and never another account's (the `sqlite` project runs this file too).
 */
describe("MessageDTO.invitation", () => {
  it("carries the row's identity, start, organizer, invitee and answer, the instants as ISO text", async () => {
    const { db, accountId, mailboxId } = await makeCtx();
    const id = await seedMessage(db, accountId, mailboxId, { from: "tobias@studio.example" });
    const [invitation] = await db.insert(messageInvitations).values({
      accountId, messageId: id, mailboxId, uid: "kickoff-17@studio.example", recurrenceId: "1796119200000", sequence: 2,
      method: "REQUEST", startRaw: "20261201T100000Z", startsAt: new Date("2026-12-01T10:00:00Z"),
      organizer: "tobias@studio.example", invitedAddress: "Mila@Lichtgrat.example",
      answer: "tentative", answeredAt: new Date("2026-11-11T09:00:00Z"),
    }).returning();
    const dto = (await materializeMessages(db, accountId, [id])).get(id);
    expect(dto?.invitation).toEqual({
      calendarEventId: invitationCalendarId(invitation!),
      method: "REQUEST", uid: "kickoff-17@studio.example", recurrenceId: "1796119200000", sequence: 2,
      start: "20261201T100000Z", startsAt: "2026-12-01T10:00:00.000Z", organizer: "tobias@studio.example",
      invitedAddress: "Mila@Lichtgrat.example", answer: "tentative", answeredAt: "2026-11-11T09:00:00.000Z",
    });
    // The receipt reader is the same statement.
    expect((await materializeMessage(db, accountId, id))?.invitation).toEqual(dto?.invitation);
  });

  it("is absent, not null, on a letter without a row; a row's empty values are nulls", async () => {
    const { db, accountId, mailboxId } = await makeCtx();
    const plain = await seedMessage(db, accountId, mailboxId, {});
    const bare = await seedMessage(db, accountId, mailboxId, {});
    const [cancellation] = await db.insert(messageInvitations).values({ accountId, messageId: bare, mailboxId, uid: "x@y.example", method: "CANCEL" }).returning();
    const dtos = await materializeMessages(db, accountId, [plain, bare]);
    expect("invitation" in dtos.get(plain)!).toBe(false);
    expect(dtos.get(bare)?.invitation).toEqual({
      calendarEventId: invitationCalendarId(cancellation!),
      method: "CANCEL", uid: "x@y.example", recurrenceId: "", sequence: 0, start: null, startsAt: null, organizer: null,
      invitedAddress: null, answer: null, answeredAt: null,
    });
  });

  it("finds the closest live revision when the preceding letter was deleted", async () => {
    const { db, accountId, mailboxId } = await makeCtx();
    const organizer = "organizer" + String.fromCharCode(64) + "fixture.invalid";
    const starts = [
      new Date("2026-12-01T10:00:00Z"),
      new Date("2026-12-01T11:00:00Z"),
      new Date("2026-12-01T12:00:00Z"),
    ];
    const ids: string[] = [];
    for (const [sequence, startsAt] of starts.entries()) {
      const messageId = await seedMessage(db, accountId, mailboxId, { from: organizer });
      ids.push(messageId);
      await db.insert(messageInvitations).values({
        accountId, mailboxId, messageId, organizer, uid: "weekly", method: "REQUEST", sequence, startsAt,
      });
    }
    await db.update(messages).set({ deletedAt: new Date() }).where(eq(messages.id, ids[1]!));

    const dto = await materializeMessage(db, accountId, ids[2]!);
    expect(dto?.invitation?.previous).toEqual({ start: null, startsAt: starts[0]!.toISOString() });
  });

  it("one row per letter: the join does not repeat a letter, with its tags beside it", async () => {
    const { db, accountId, mailboxId } = await makeCtx();
    const id = await seedMessage(db, accountId, mailboxId, {});
    await db.insert(messageInvitations).values({ accountId, messageId: id, mailboxId, uid: "x@y.example", method: "REQUEST" });
    const all = await materializeMessages(db, accountId, [id]);
    expect([...all.keys()]).toEqual([id]);
  });

  it("is never another account's row", async () => {
    const { db, accountId, mailboxId } = await makeCtx();
    const id = await seedMessage(db, accountId, mailboxId, {});
    const other = randomUUID();
    await db.insert(accounts).values({ id: other, name: "other" });
    const [mb] = await db.insert(mailboxes).values({ accountId: other, provider: "imap", address: "o@other.example" }).returning();
    // A row naming this letter under another account: the server's key refuses it (the letter's
    // account is in it), a device's single-account key does not; either way the join asks for this
    // account's row alone.
    await db.insert(messageInvitations).values({ accountId: other, messageId: id, mailboxId: mb!.id, uid: "x@y.example", method: "REQUEST" })
      .catch(() => undefined);
    expect("invitation" in (await materializeMessages(db, accountId, [id])).get(id)!).toBe(false);
  });
});
