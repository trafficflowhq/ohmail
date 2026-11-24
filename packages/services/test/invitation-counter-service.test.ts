import { expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { accounts, calAttendees, calCalendars, calConnections, calEvents, calSettings, calWrites, drafts } from "@trafficflow/db";
import type { CalendarProposalAct, InvitationProposalTimes } from "@ohmail/wire";
import { sendInvitationProposal } from "../src/calendar/proposals.js";
import { readInvitation } from "../src/invitation-answer-service.js";
import { dbFor } from "../src/context.js";
import { makeCtx, otherAccount } from "./helpers.js";
import { invitationLetter, ME, ORGANIZER, outbox } from "./_invitation-answer.js";

const uid = "planning";
const startsAt = new Date("2026-11-24T10:00:00Z");
const endsAt = new Date("2026-11-24T11:00:00Z");
const times: InvitationProposalTimes = {
  start: { kind: "instant", value: "20261201T130000Z" },
  end: { kind: "instant", value: "20261201T140000Z" },
};

type Fixture = Awaited<ReturnType<typeof makeCtx>>;
async function world(options: { owned?: boolean; recurring?: boolean; shared?: Fixture } = {}) {
  const first = options.shared ?? await makeCtx(new Date("2026-11-22T12:00:00Z"));
  const { db } = first;
  const { accountId, mailboxId } = options.shared ? await otherAccount(db, ME) : first;
  const ctx = { ...first.ctx, accountId, db: dbFor(db, accountId) };
  const organizer = options.owned ? ME : ORGANIZER;
  await db.insert(accounts).values({ id: accountId });
  await db.insert(calSettings).values({ accountId, enabledAt: ctx.now() });
  const [connection] = await db.insert(calConnections).values({ accountId, provider: "google", label: "", mailboxId }).returning();
  const [calendar] = await db.insert(calCalendars).values({
    accountId, connectionId: connection!.id, providerId: "calendar", access: "owner",
  }).returning();
  const [event] = await db.insert(calEvents).values({
    accountId, calendarId: calendar!.id, providerId: "event", uid, sequence: 4, organizer,
    myAnswer: options.owned ? null : "tentative",
    startKind: "instant", startLocal: "20261124T100000Z", startsAt,
    endKind: "instant", endLocal: "20261124T110000Z", endsAt,
    repeatRule: options.recurring ? "FREQ=WEEKLY;COUNT=3" : null,
  }).returning();
  const attendee = options.owned ? ORGANIZER : ME;
  await db.insert(calAttendees).values([
    { accountId, eventId: event!.id, address: attendee, answer: "tentative" },
    { accountId, eventId: event!.id, address: "another-guest@calendar.example" },
  ]);
  const box = outbox();
  const openSendAdapter = vi.fn(box.factory);
  const send = (act: CalendarProposalAct, key: string) => sendInvitationProposal(ctx, act, key, { send: { openSendAdapter } });
  const base = { recordId: event!.id, base: event!.updatedAt.toISOString(), occurrence: "" };
  return { db, ctx, accountId, mailboxId, event, box, send, base, openSendAdapter };
}

it("sends only to the organizer and leaves the event, its queued writes and its invitation answer alone", async () => {
  const w = await world({ recurring: true });
  const messageId = await invitationLetter(w.db, w.accountId, w.mailboxId, { uid, attendees: [ME], sequence: 4 });
  const act = { ...w.base, kind: "calendar_event_propose", occurrence: String(Date.parse("2026-12-01T10:00:00Z")), ...times } as const;
  await expect(w.send(act, "proposal-key")).resolves.toMatchObject({ status: "sent" });
  await expect(w.send(act, "proposal-key")).resolves.toMatchObject({ status: "sent" });
  await expect(w.send({ ...act, end: { kind: "instant", value: "20261201T150000Z" } }, "proposal-key"))
    .rejects.toMatchObject({ code: "conflict" });
  expect(w.box.sent).toHaveLength(1);
  const sent = w.box.sent[0];
  expect(sent?.to).toEqual([ORGANIZER]);
  expect(sent?.cc).toBeUndefined();
  expect(sent?.bcc).toBeUndefined();
  expect(sent?.calendar?.method).toBe("COUNTER");
  expect(sent?.calendar?.text).toContain("RECURRENCE-ID:20261201T100000Z");
  expect(sent?.calendar?.text).toContain("ATTENDEE;PARTSTAT=TENTATIVE:");
  expect(await w.db.select().from(calEvents).where(eq(calEvents.accountId, w.accountId))).toEqual([w.event]);
  expect(await w.db.select().from(calWrites).where(eq(calWrites.accountId, w.accountId))).toEqual([]);
  expect((await readInvitation(w.ctx, messageId)).row.answer).toBeNull();
  await expect(w.send({ ...act, occurrence: "7" }, "invalid-day")).rejects.toMatchObject({ code: "conflict" });
  expect(w.box.sent).toHaveLength(1);
});

it("Keep sends a decline to the matching attendee alone and preserves the event", async () => {
  const w = await world({ owned: true });
  const letter = { method: "COUNTER", uid, organizer: ME, attendees: [ORGANIZER], sequence: 4, proposal: times } as const;
  const messageId = await invitationLetter(w.db, w.accountId, w.mailboxId, letter);
  const forged = await invitationLetter(w.db, w.accountId, w.mailboxId, { ...letter, from: "other@calendar.example" });
  const act = { ...w.base, kind: "calendar_proposal_keep", messageId } as const;
  await expect(w.send({ ...act, messageId: forged }, "invalid-proposer")).rejects.toMatchObject({ code: "invitation_not_answerable" });
  await expect(w.send(act, "keep-key")).resolves.toMatchObject({ status: "sent" });
  expect(w.box.sent.map((message) => message.to)).toEqual([[ORGANIZER]]);
  expect(w.box.sent[0]?.calendar?.method).toBe("DECLINECOUNTER");
  expect(await w.db.select().from(calEvents).where(eq(calEvents.accountId, w.accountId))).toEqual([w.event]);
  expect(await w.db.select().from(calWrites).where(eq(calWrites.accountId, w.accountId))).toEqual([]);
});


it.each(["event", "letter"] as const)("keeps another account's %s outside proposal sends", async (kind) => {
  const owner = await world({ owned: true });
  const other = await world({ shared: owner });
  const w = kind === "event" ? other : owner;
  const act = kind === "event" ?
    { ...owner.base, kind: "calendar_event_propose", ...times } as const :
    { ...owner.base, kind: "calendar_proposal_keep", messageId: await invitationLetter(other.db, other.accountId, other.mailboxId, {
      method: "COUNTER", uid, organizer: ME, attendees: [ORGANIZER], sequence: 4, proposal: times,
    }) } as const;
  await expect(w.send(act, "unrelated")).rejects.toMatchObject({ code: "not_found" });
  for (const account of [owner, other]) {
    expect(account.openSendAdapter).not.toHaveBeenCalled();
    expect(account.box.sent).toHaveLength(0);
    expect(await account.db.select().from(drafts).where(eq(drafts.accountId, account.accountId))).toEqual([]);
    expect(await account.db.select().from(calEvents).where(eq(calEvents.accountId, account.accountId))).toEqual([account.event]);
    expect(await account.db.select().from(calWrites).where(eq(calWrites.accountId, account.accountId))).toEqual([]);
  }
});
