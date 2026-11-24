import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import {
  attachments, changeLog, mailboxes, messageBodies, messageFailures, messageInvitations, messageSearch, messages, type Tx,
} from "@trafficflow/db";
import { makeTestDb } from "@trafficflow/db/testing";
import { readLetterInvitation, UNMETERED_STORAGE_CAP } from "@trafficflow/core/mail";
import { makeDrizzleRepo } from "@trafficflow/core/adapters/drizzle-repo";
import { runSyncCycle } from "../src/sync.js";
import { FakeAdapterFleet } from "./_fakeadapter.js";
import { FIXTURE_LEASE } from "./_door.js";
import {
  calendarText, recorder, refuseInvitationRows, shapeLetters, invitationLetter, ME, reply, request, SQLITE_STORE, type InvitationLetter,
} from "./_invitations.js";

/**
 * AN INVITATION'S IDENTITY IS KEPT AT INGEST, one letter at a time, on the store a server holds and
 * on the one a phone holds (the `sqlite` project runs this file too): the row its calendar part
 * says, in the letter's own transaction; the person's own reply recorded on the invitation it
 * answers, with a change; and a part that defeats the reader costs the letter nothing.
 */
const ACCOUNT = "00000000-0000-4000-8000-00000000c41e";

async function world() {
  const db = (await makeTestDb()) as unknown as Tx;
  const [mb] = await db.insert(mailboxes).values({ accountId: ACCOUNT, provider: "imap", address: ME }).returning();
  const fleet = new FakeAdapterFleet();
  const adapter = fleet.factory(
    { host: "h", port: 143, secure: false, auth: { user: "u", pass: "p" } },
    { accountId: ACCOUNT, mailboxId: mb!.id, onConnectionError: () => { /* nothing dials here */ } },
  );
  const delivered: InvitationLetter[] = [];
  const log = recorder();
  return {
    db, mailboxId: mb!.id, log,
    async cycle(letters: InvitationLetter[]): Promise<void> {
      delivered.push(...letters);
      fleet.behave(mb!.id, { deliver: [...delivered] });
      await runSyncCycle({
        writeAuthority: FIXTURE_LEASE, repo: makeDrizzleRepo(db as never), adapter, accountId: ACCOUNT, mailboxId: mb!.id,
        storageCap: UNMETERED_STORAGE_CAP, role: "organizer", trustedAuthservIds: new Set<string>(), signatures: null, log,
      });
    },
    fleet,
  };
}

/** The rows, by the letter's Message-ID. */
async function invitations(db: Tx): Promise<Map<string, typeof messageInvitations.$inferSelect>> {
  const rows = await db.select({ mid: messages.messageIdHeader, row: messageInvitations }).from(messageInvitations)
    .innerJoin(messages, eq(messages.id, messageInvitations.messageId));
  return new Map(rows.map((r) => [r.mid ?? "", r.row]));
}

describe("the ingest keeps each letter's invitation, one letter at a time", () => {
  it("every provider's letter gets the row its calendar part says, and no other", async () => {
    const w = await world();
    const corpus = shapeLetters();
    await w.cycle(corpus.map((c) => c.letter));
    const rows = await invitations(w.db);
    let kept = 0;
    for (const c of corpus) {
      const read = readLetterInvitation([{ id: "1", contentType: "text/calendar", text: c.text }]);
      const row = rows.get(c.letter.messageId);
      if (read === undefined) {
        expect(row, c.name).toBeUndefined();
        continue;
      }
      kept++;
      expect(row, c.name).toMatchObject({
        uid: read.uid, recurrenceId: read.recurrenceId, sequence: read.sequence, method: read.method,
        startRaw: read.startRaw, startsAt: read.startsAt, organizer: read.organizer, mailboxId: w.mailboxId,
      });
    }
    // The positive control: the shapes hold invitations of every method that keeps a row.
    expect(kept).toBeGreaterThanOrEqual(7);
    expect(new Set([...rows.values()].map((r) => r.method))).toEqual(new Set(["REQUEST", "REPLY", "CANCEL", "COUNTER"]));
  });

  it("the person's own answer in Sent is recorded on the invitation, by a change at a later position", async () => {
    const w = await world();
    await w.cycle([invitationLetter("ask-1@studio.example", request("kickoff-1@studio.example", 2))]);
    const asked = (await invitations(w.db)).get("ask-1@studio.example")!;
    expect(asked).toMatchObject({ method: "REQUEST", invitedAddress: ME, answer: null, answeredAt: null });
    const seqs = async (): Promise<Array<{ seq: bigint; entityId: string; op: string }>> =>
      (await w.db.select({ seq: changeLog.seq, entityId: changeLog.entityId, op: changeLog.op }).from(changeLog).orderBy(asc(changeLog.seq)))
        .map((c) => ({ seq: BigInt(String(c.seq)), entityId: String(c.entityId), op: String(c.op) }));
    const before = (await seqs()).at(-1)!.seq;
    await w.cycle([invitationLetter("answer-1@lichtgrat.example", reply("kickoff-1@studio.example", "DECLINED", "20261111T090000Z", 2), {
      from: ME, folder: "Sent", ownAuthored: true,
    })]);
    const rows = await invitations(w.db);
    expect(rows.get("ask-1@studio.example")).toMatchObject({ answer: "declined", answeredAt: new Date("2026-11-11T09:00:00Z") });
    expect(rows.get("answer-1@lichtgrat.example")).toMatchObject({ method: "REPLY", invitedAddress: ME, answer: "declined" });
    const later = (await seqs()).filter((c) => c.seq > before && c.entityId === asked.messageId);
    expect(later.map((c) => c.op)).toEqual(["update"]);
  });

  it("a part the reader refuses costs the letter nothing: stored, no row, no failure, never fetched again", async () => {
    const w = await world();
    const hostile = [
      invitationLetter("nul@x.example", request("a\u0000b@x.example")),
      invitationLetter("long@x.example", request(`${"u".repeat(1100)}@x.example`)),
      invitationLetter("big@x.example", request("big@x.example", 0, [`X-PAD:${"x".repeat(600 * 1024)}`])),
      invitationLetter("junk@x.example", "BEGIN:VCALENDAR\r\nMETHOD:REQUEST\r\nBEGIN:VEVENT\r\n\u0000\u0001\u0002;;;:::\r\n"),
    ];
    await w.cycle(hostile);
    const stored = await w.db.select({ mid: messages.messageIdHeader, id: messages.id }).from(messages).where(eq(messages.accountId, ACCOUNT));
    expect(stored.map((m) => m.mid).sort()).toEqual(hostile.map((h) => h.messageId).sort());
    for (const m of stored) {
      expect(await w.db.select({ id: messageBodies.messageId }).from(messageBodies).where(eq(messageBodies.messageId, m.id))).toHaveLength(1);
    }
    expect(await invitations(w.db)).toEqual(new Map());
    expect(await w.db.select().from(messageFailures)).toEqual([]);
    const served = w.fleet.served.get(w.mailboxId)?.length ?? 0;
    await w.cycle([]);
    expect(w.fleet.served.get(w.mailboxId)?.length ?? 0).toBe(served);
  });

  it("nothing of the calendar part is stored beyond the row's columns", async () => {
    const w = await world();
    const marker = "Zq7Marker";
    const ics = calendarText("REQUEST", [
      "UID:quiet-1@studio.example", "DTSTART:20261201T100000Z", `SUMMARY:${marker} title`, `LOCATION:${marker} room`,
      `DESCRIPTION:${marker} words`, `ORGANIZER;CN=${marker} name:mailto:tobias@studio.example`,
      `ATTENDEE;CN=${marker} guest:mailto:guest-${marker}@studio.example`, `ATTENDEE:mailto:${ME}`,
      `ATTACH:https://studio.example/${marker}.pdf`, `X-ALT-DESC:${marker}`,
    ]);
    await w.cycle([invitationLetter("quiet-1@studio.example", ics)]);
    expect((await invitations(w.db)).get("quiet-1@studio.example")).toMatchObject({ uid: "quiet-1@studio.example", invitedAddress: ME });
    const everything = JSON.stringify([
      await w.db.select().from(messageInvitations), await w.db.select().from(messages), await w.db.select().from(messageBodies),
      await w.db.select().from(messageSearch), await w.db.select().from(attachments),
    ], (_k, v: unknown) => (typeof v === "bigint" ? String(v) : v));
    expect(everything).not.toContain(marker);
    expect(everything.toLowerCase()).not.toContain(marker.toLowerCase());
  });
});

describe("a fault inside the invitation's statements", () => {
  it("a refusal of the row's own value keeps the letter without its row, and says so in one line", async () => {
    const w = await world();
    const lift = await refuseInvitationRows(w.db, "refused-1@studio.example", "22023");
    try {
      await w.cycle([invitationLetter("refused-1@studio.example", request("refused-1@studio.example"))]);
    } finally {
      await lift();
    }
    const [stored] = await w.db.select({ id: messages.id }).from(messages).where(eq(messages.messageIdHeader, "refused-1@studio.example"));
    expect(stored, "the letter was lost with its row").toBeDefined();
    expect(await invitations(w.db)).toEqual(new Map());
    expect(await w.db.select().from(messageFailures)).toEqual([]);
    expect(w.log.lines.filter((l) => l.event === "invitation_row_refused")).toEqual([{
      event: "invitation_row_refused",
      fields: { accountId: ACCOUNT, mailboxId: w.mailboxId, messageId: stored!.id, reason: SQLITE_STORE ? "constraint_violation" : "data_exception" },
    }]);
  });

  // A store's own fault is planted on the server's store; a device store's classes are the classifier's own cases.
  it.skipIf(SQLITE_STORE)("any other fault fails the letter's transaction, and the next cycle stores the letter with its row", async () => {
    const w = await world();
    const lift = await refuseInvitationRows(w.db, "held-1@studio.example", "40P01");
    let cycled: unknown = null;
    try {
      cycled = await w.cycle([invitationLetter("held-1@studio.example", request("held-1@studio.example"))]).then(() => null, (e: unknown) => e);
    } finally {
      await lift();
    }
    expect(cycled, "the cycle went on past a fault of the store").toMatchObject({ code: "40P01" });
    expect(await w.db.select().from(messages).where(eq(messages.messageIdHeader, "held-1@studio.example"))).toEqual([]);
    expect(await w.db.select().from(messageFailures)).toEqual([]);
    expect(w.log.lines.filter((l) => l.event === "invitation_row_refused")).toEqual([]);
    await w.cycle([]);
    expect((await invitations(w.db)).get("held-1@studio.example")).toMatchObject({ method: "REQUEST", uid: "held-1@studio.example" });
  });
});

describe("a store that holds several mailboxes", () => {
  it("names only the mailbox the letter is in as invited", async () => {
    const w = await world();
    const other = randomUUID();
    await w.db.insert(mailboxes).values({ id: other, accountId: ACCOUNT, provider: "imap", address: "second@lichtgrat.example" });
    const ics = calendarText("REQUEST", ["UID:two-1@studio.example", "ORGANIZER:mailto:tobias@studio.example", "ATTENDEE:mailto:second@lichtgrat.example"]);
    await w.cycle([invitationLetter("two-1@studio.example", ics)]);
    expect((await invitations(w.db)).get("two-1@studio.example")).toMatchObject({ invitedAddress: null });
  });
});
