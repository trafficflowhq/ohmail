/**
 * AN INVITATION THAT CAME AS AN OUTLOOK WEB APP LINK GETS ITS CARD from the account's own Microsoft
 * calendar connection: the letter's item id is looked up there, and the letter's invitation row is
 * written through the table's one door with the answer on record and a message change. Only the
 * turn's own account is read, a letter is looked up once, a turn looks up few, and an id that is no
 * id is never handed on. The lookup is a stand-in that records what it was asked; every value is invented.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CalEvent } from "@ohmail/cal-core";
import type { Answer, CalendarProvider, Connection } from "@ohmail/cal-providers";
import type { ExchangeInvitationEvent } from "@ohmail/cal-providers/microsoft";
import { mailboxes, messageBodies, messageInvitations, messages } from "@trafficflow/db";
import {
  EXCHANGE_LOOKUPS_PER_TURN,
  EXCHANGE_SCAN_EVERY_MS,
  exchangeInvitationPass,
  invitationOf,
} from "../src/calendar/exchange-invitations.js";
import { newCalendarSyncMemory, passDb, calendarPool } from "../src/calendar/index.js";
import {
  AVAILABLE,
  ZONES,
  and,
  capturedLog,
  changesOf,
  eq,
  eventOf,
  openWorld,
  seedConnection,
  silentHttp,
  type World,
} from "./_calendar-world.js";

const ME = "mila@org.example";
const ORGANIZER = "lena@org.example";
const ITEM = "AAMkADJh/TaHJ8AAV95f1jAAA=";
const stub = (item: string) =>
  [
    "Microsoft Outlook Web Access:",
    `https://outlook.office365.com/owa/org.example/?itemid=${encodeURIComponent(item)}&exvsurl=1&path=/calendar/item`,
    "",
    "To receive meeting invitations as .iCalendar attachments instead of Outlook Web App links, go to",
    "https://outlook.office365.com/owa/org.example/?path=/options/popandimap and select Send meeting invitations in iCalendar format.",
    "",
  ].join("\n");

const invited = (uid: string): CalEvent =>
  eventOf([
    `UID:${uid}`,
    "DTSTAMP:20261124T080000Z",
    "DTSTART;TZID=Europe/Berlin:20261203T100000",
    "DTEND;TZID=Europe/Berlin:20261203T110000",
    "SUMMARY:Review planning",
    "LOCATION:Room 4",
    `ORGANIZER;CN=Lena:mailto:${ORGANIZER}`,
    `ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:${ME}`,
    "ATTENDEE;PARTSTAT=ACCEPTED:mailto:tom@org.example",
  ]);

type Lookup = (itemId: string) => Answer<ExchangeInvitationEvent | null>;

function standIn(answer: Lookup) {
  const asked: string[] = [];
  const provider: CalendarProvider = {
    reader: { provider: "microsoft" } as CalendarProvider["reader"],
    writer: null,
    notices: null,
    http: silentHttp(),
    invitations: {
      async eventOfItem(_c, itemId) {
        asked.push(itemId);
        return answer(itemId);
      },
    },
  };
  return { provider, asked };
}

const connection: Connection = {
  provider: "microsoft",
  credential: { kind: "bearer", accessToken: async () => ({ ok: true, token: "t" }) },
  start: null,
};
const found =
  (uid: string, answer: ExchangeInvitationEvent["answer"] = "tentative"): Lookup =>
  () => ({ ok: true, value: { event: invited(uid), id: "rest-1", answer } });

describe.skipIf(!AVAILABLE)(
  "an Outlook Web App invitation, looked up in the account's own Microsoft calendar",
  () => {
    let w: World;
    beforeAll(async () => {
      w = await openWorld();
    });
    afterAll(async () => {
      await w?.close();
    });

    async function account() {
      const seeded = await seedConnection(w, { provider: "microsoft", credential: null, mailboxAddress: ME });
      const [mb] = await w.db
        .select({ id: mailboxes.id })
        .from(mailboxes)
        .where(eq(mailboxes.accountId, seeded.accountId));
      return { ...seeded, mailboxId: mb!.id };
    }

    async function letter(
      a: { accountId: string; mailboxId: string },
      text: string,
      daysAgo = 1,
    ): Promise<string> {
      const [m] = await w.db
        .insert(messages)
        .values({
          accountId: a.accountId,
          mailboxId: a.mailboxId,
          dedupKey: `mid:<${randomUUID()}@org.example>`,
          bodyHash: "b",
          subject: "Review planning",
          date: new Date(Date.now() - daysAgo * 86_400_000),
        })
        .returning({ id: messages.id });
      await w.db.insert(messageBodies).values({ accountId: a.accountId, messageId: m!.id, text });
      return m!.id;
    }

    /** One look; `turn` moves the clock on by a look's least gap for each turn. */
    const pass = (
      a: { accountId: string; connectionId: string },
      provider: CalendarProvider,
      memory = newCalendarSyncMemory(),
      turn = 0,
      at = Date.now(),
    ) =>
      exchangeInvitationPass({
        db: passDb(calendarPool(w.db), a.accountId),
        key: { accountId: a.accountId, id: a.connectionId },
        provider,
        connection,
        memory,
        zones: ZONES,
        now: () => at + turn * (EXCHANGE_SCAN_EVERY_MS + 1),
        signal: new AbortController().signal,
        log: capturedLog().log,
      });

    const rowOf = async (accountId: string, messageId: string) =>
      (
        await w.db
          .select()
          .from(messageInvitations)
          .where(
            and(eq(messageInvitations.accountId, accountId), eq(messageInvitations.messageId, messageId)),
          )
      )[0];

    it("writes the letter's invitation from the event, with my answer, and tells every device", async () => {
      const a = await account();
      const id = await letter(a, stub(ITEM));
      const { provider, asked } = standIn(found(`uid-${id}@org.example`));
      expect(await pass(a, provider)).toBe(1);
      expect(asked).toEqual([ITEM]);
      expect(await rowOf(a.accountId, id)).toMatchObject({
        method: "REQUEST",
        uid: `uid-${id}@org.example`,
        recurrenceId: "",
        sequence: 0,
        startRaw: "20261203T100000",
        startsAt: new Date("2026-12-03T09:00:00.000Z"),
        organizer: ORGANIZER,
        invitedAddress: ME,
        answer: "tentative",
      });
      expect((await changesOf(w, a.accountId))["message:update"]).toBe(1);
    });

    it("asks about a letter once: its row is the cache", async () => {
      const a = await account();
      const id = await letter(a, stub(ITEM));
      const { provider, asked } = standIn(found(`uid-${id}@org.example`, null));
      const memory = newCalendarSyncMemory();
      await pass(a, provider, memory);
      await pass(a, provider, newCalendarSyncMemory());
      expect(asked).toEqual([ITEM]);
      expect((await rowOf(a.accountId, id))?.answer).toBeNull();
    });

    it("a cancelled event writes a cancellation", async () => {
      const a = await account();
      const id = await letter(a, stub(ITEM));
      const cancelled: Lookup = () => ({
        ok: true,
        value: {
          event: eventOf([
            `UID:uid-${id}@org.example`,
            "DTSTAMP:20261124T080000Z",
            "DTSTART:20261203T090000Z",
            "DTEND:20261203T100000Z",
            "STATUS:CANCELLED",
            `ORGANIZER:mailto:${ORGANIZER}`,
            `ATTENDEE:mailto:${ME}`,
          ]),
          id: "rest-1",
          answer: null,
        },
      });
      await pass(a, standIn(cancelled).provider);
      expect(await rowOf(a.accountId, id)).toMatchObject({ method: "CANCEL", startRaw: "20261203T090000Z" });
    });

    it("an id Graph says names nothing writes nothing, and is not asked about again", async () => {
      const a = await account();
      const id = await letter(a, stub(ITEM));
      const { provider, asked } = standIn(() => ({ ok: false, reason: "not_found", retryAfterMs: null }));
      const memory = newCalendarSyncMemory();
      expect(await pass(a, provider, memory)).toBe(0);
      await pass(a, provider, memory, 1);
      expect(asked).toEqual([ITEM]);
      expect(await rowOf(a.accountId, id)).toBeUndefined();
    });

    it("a failed lookup is asked again in a later turn, a few times at most", async () => {
      const a = await account();
      await letter(a, stub(ITEM));
      const { provider, asked } = standIn(() => ({ ok: false, reason: "unavailable", retryAfterMs: null }));
      const memory = newCalendarSyncMemory();
      const at = Date.now();
      for (let turn = 0; turn < 5; turn++) await pass(a, provider, memory, turn, at);
      expect(asked).toHaveLength(3);
    });

    it("looks at a connection's letters at most once in a while", async () => {
      const a = await account();
      await letter(a, stub(ITEM));
      const { provider, asked } = standIn(() => ({ ok: false, reason: "unavailable", retryAfterMs: null }));
      const memory = newCalendarSyncMemory();
      const at = Date.now();
      await pass(a, provider, memory, 0, at);
      await pass(a, provider, memory, 0, at + EXCHANGE_SCAN_EVERY_MS - 1);
      expect(asked).toHaveLength(1);
      await pass(a, provider, memory, 1, at);
      expect(asked).toHaveLength(2);
    });

    it("a letter dated ahead holds no place, and one another connection settled is still asked here", async () => {
      const a = await account();
      for (let i = 0; i < 25; i++)
        await letter(a, stub(`AAMkADahead${String(i).padStart(2, "0")}00000000=`), -30);
      const real = await letter(a, stub(ITEM));
      const { provider, asked } = standIn(found(`uid-${real}@org.example`));
      const memory = newCalendarSyncMemory();
      memory.exchangeLookups.set(`another-connection:${real}`, 99);
      await pass(a, provider, memory);
      expect(asked).toEqual([ITEM]);
    });

    it("letters settled before leave their places to older ones", async () => {
      const a = await account();
      const real = await letter(a, stub(ITEM), 10);
      for (let i = 0; i < 25; i++) await letter(a, `Notes on calendar/item ${i}\n`, 1);
      const { provider, asked } = standIn(found(`uid-${real}@org.example`));
      const memory = newCalendarSyncMemory();
      await pass(a, provider, memory, 0);
      expect(asked).toEqual([]);
      await pass(a, provider, memory, 1);
      expect(asked).toEqual([ITEM]);
    });

    it("a malformed id is never handed to the lookup", async () => {
      const a = await account();
      const id = await letter(a, stub("../../me/messages?$select=body"));
      const { provider, asked } = standIn(found("never"));
      expect(await pass(a, provider)).toBe(0);
      expect(asked).toEqual([]);
      expect(await rowOf(a.accountId, id)).toBeUndefined();
    });

    it("ordinary mail and old letters are not looked up", async () => {
      const a = await account();
      await letter(a, "See the calendar item list at https://example.test/calendar/item-list\n");
      await letter(a, stub(ITEM), 90);
      const { provider, asked } = standIn(found("never"));
      await pass(a, provider);
      expect(asked).toEqual([]);
    });

    it("reads only the turn's own account", async () => {
      const mine = await account();
      const theirs = await account();
      const own = await letter(mine, stub("AAMkADmineMineMine0000="));
      const other = await letter(theirs, stub("AAMkADtheirsTheirs0000="));
      const { provider, asked } = standIn(found(`uid-${own}@org.example`));
      await pass(mine, provider);
      expect(asked).toEqual(["AAMkADmineMineMine0000="]);
      expect(await rowOf(theirs.accountId, other)).toBeUndefined();
    });

    it(`looks up at most ${EXCHANGE_LOOKUPS_PER_TURN} letters a turn`, async () => {
      const a = await account();
      for (let i = 0; i < EXCHANGE_LOOKUPS_PER_TURN + 2; i++)
        await letter(a, stub(`AAMkADletter${i}000000000=`), i + 1);
      const { provider, asked } = standIn(() => ({ ok: true, value: null }));
      await pass(a, provider);
      expect(asked).toHaveLength(EXCHANGE_LOOKUPS_PER_TURN);
    });
  },
);

describe("the invitation row an event makes", () => {
  it("names no row for one day of a series, or an event with no start", () => {
    const day = eventOf([
      "UID:u",
      "DTSTAMP:20261124T080000Z",
      "RECURRENCE-ID:20261203T090000Z",
      "DTSTART:20261203T090000Z",
    ]);
    expect(invitationOf("a", "m", day, ZONES)).toBeNull();
  });

  it("keeps a whole day as a date and a moment in UTC as one", () => {
    const allDay = eventOf(["UID:u", "DTSTAMP:20261124T080000Z", "DTSTART;VALUE=DATE:20261203"]);
    expect(invitationOf("a", "m", allDay, ZONES)).toMatchObject({ startRaw: "20261203", startsAt: null });
    const utc = eventOf(["UID:u", "DTSTAMP:20261124T080000Z", "DTSTART:20261203T090000Z"]);
    expect(invitationOf("a", "m", utc, ZONES)).toMatchObject({
      startRaw: "20261203T090000Z",
      startsAt: new Date("2026-12-03T09:00:00Z"),
    });
  });
});
