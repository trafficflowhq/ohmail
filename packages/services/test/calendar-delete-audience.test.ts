import { beforeAll, expect, it } from "vitest";
import { accounts, calAttendees, calCalendars, calConnections, calEvents, calSettings, mailboxes } from "@trafficflow/db";
import { makeTestDb } from "@trafficflow/db/testing";
import { BENCH_CALDAV_PLACE, PROVEN_REPEATS, proofPlaceOf } from "@ohmail/cal-providers";
import type { CalendarEventAct } from "@ohmail/wire";
import { recordCalendarWrite } from "../src/calendar/writes.js";
import { dbFor, type ServiceContext } from "../src/context.js";

const organizer = "organizer@example.invalid";
const guest = "guest@example.invalid";
const dav = "https://calendar.example.invalid/";
const proven = { [proofPlaceOf("caldav", dav)!]: PROVEN_REPEATS[BENCH_CALDAV_PLACE]! };
const now = new Date("2026-11-15T00:00:00Z");
const at = String(Date.UTC(2026, 10, 18));
let db: Awaited<ReturnType<typeof makeTestDb>>;

beforeAll(async () => { db = await makeTestDb(); }, 40_000);

function original(guests: boolean) {
  return [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Test//EN",
    "BEGIN:VEVENT", "UID:kiln", "DTSTAMP:20261101T000000Z",
    "DTSTART;VALUE=DATE:20261116", "DTEND;VALUE=DATE:20261117",
    "RRULE:FREQ=DAILY;COUNT=4", "END:VEVENT",
    ...(guests ? [
      "BEGIN:VEVENT", "UID:kiln", "DTSTAMP:20261101T000000Z",
      "RECURRENCE-ID;VALUE=DATE:20261118", "DTSTART;VALUE=DATE:20261118",
      "DTEND;VALUE=DATE:20261119", `ORGANIZER:mailto:${organizer}`, `ATTENDEE:mailto:${guest}`,
      "END:VEVENT",
    ] : []),
    "END:VCALENDAR", "",
  ].join("\r\n");
}

async function mounted(
  text: string | null,
  repeating = true,
  cloud?: { provider: "google" | "microsoft"; guests: string[]; partial?: boolean },
) {
  const [account] = await db.insert(accounts).values({ name: "Calendar tests" }).returning();
  const accountId = account!.id;
  await db.insert(calSettings).values({ accountId, enabledAt: now });
  await db.insert(mailboxes).values({ accountId, provider: "imap", address: organizer });
  const [connection] = await db.insert(calConnections).values({
    accountId, provider: cloud?.provider ?? "caldav", label: "Study", status: "active", serverUrl: dav,
  }).returning();
  const [calendar] = await db.insert(calCalendars).values({
    accountId, connectionId: connection!.id, providerId: dav, name: "Study", access: "owner",
  }).returning();
  const [event] = await db.insert(calEvents).values({
    accountId, calendarId: calendar!.id, providerId: dav + "kiln.ics", versionTag: '"one"', uid: "kiln",
    title: "Kiln", original: text, organizer: cloud ? organizer : null, partial: cloud?.partial, repeatRule: repeating ? "FREQ=DAILY;COUNT=4" : null,
    startKind: "date", startLocal: "20261116", endKind: "date", endLocal: "20261117",
    startsAt: new Date("2026-11-16T00:00:00Z"), endsAt: new Date("2026-11-20T00:00:00Z"),
  }).returning();
  if (cloud?.guests.length) {
    await db.insert(calAttendees).values(cloud.guests.map((address) => ({ accountId, eventId: event!.id, address })));
  }
  const ctx: ServiceContext = { db: dbFor(db, accountId), accountId, userId: null, now: () => now, requestId: "test" };
  const act = { kind: "calendar_event_delete", eventId: event!.id, base: event!.updatedAt.toISOString() } as const;
  return (key: string, scope: Extract<CalendarEventAct, {kind: "calendar_event_delete"}>["scope"], audience?: { organizer: string; guests: string[] }, base = act.base) =>
    recordCalendarWrite(ctx, key, { ...act, base, scope, ...(audience && { audience }) }, { proven });
}

it.each([{ kind: "record" }, { kind: "occurrence", at }, { kind: "following", at }] as const)(
  "refuses missing and incomplete audiences at enqueue for a guest on a changed date under $kind",
  async (scope) => {
    const remove = await mounted(original(true));
    for (const [i, audience] of [undefined, { organizer, guests: [] }].entries()) {
      const { answer } = await remove(`refused-${i}`, scope, audience);
      expect([answer.write?.state, answer.write?.reason]).toEqual(["refused", "version_stale"]);
    }
    expect((await remove("confirmed", scope, { organizer, guests: [guest] })).answer.write?.state).toBe("pending");
  },
);

it("keeps a legacy delete eligible for a known guest-free scope and refuses an unverifiable object", async () => {
  const known = await mounted(original(false));
  expect((await known("known", { kind: "record" })).answer.write?.state).toBe("pending");
  const unknown = await mounted(null);
  const { answer } = await unknown("unknown", { kind: "record" });
  expect([answer.write?.state, answer.write?.reason]).toEqual(["refused", "version_stale"]);
});

function single(guests: boolean) {
  return [
    "BEGIN:VCALENDAR", "VERSION:2.0", "BEGIN:VEVENT", "UID:kiln",
    "DTSTAMP:20261101T000000Z", "DTSTART;VALUE=DATE:20261116", "DTEND;VALUE=DATE:20261117",
    ...(guests ? [`ORGANIZER:mailto:${organizer}`, `ATTENDEE:mailto:${guest}`] : []), "END:VEVENT", "END:VCALENDAR", "",
  ].join("\r\n");
}

it("refuses enqueue of a one-off cancellation without its guest confirmation", async () => {
  const remove = await mounted(single(true), false);
  const { answer } = await remove("unconfirmed-single", { kind: "record" });
  expect(answer.write?.state).toBe("refused");
});

it("checks one-off confirmation against the stored event version and audience", async () => {
  const remove = await mounted(single(true), false);
  const scope = { kind: "record" } as const;
  const confirmed = { organizer, guests: [guest] };
  const mismatch = await remove("mismatch", scope, { organizer, guests: [] });
  expect([mismatch.answer.write?.state, mismatch.answer.write?.reason]).toEqual(["refused", "version_stale"]);
  const stale = await remove("stale", scope, confirmed, now.toISOString());
  expect([stale.answer.write?.state, stale.answer.write?.reason]).toEqual(["refused", "version_stale"]);
  expect((await remove("match", scope, confirmed)).answer.write?.state).toBe("pending");
});

it("accepts a verified guest-free one-off event and refuses an unverifiable one", async () => {
  const scope = { kind: "record" } as const;
  const known = await mounted(single(false), false);
  expect((await known("known-single", scope)).answer.write?.state).toBe("pending");
  const unknown = await mounted(null, false);
  const { answer } = await unknown("unknown-single", scope);
  expect([answer.write?.state, answer.write?.reason]).toEqual(["refused", "version_stale"]);
});

it.each(["google", "microsoft"] as const)("checks the stored %s guest list before enqueue", async (provider) => {
  const scope = { kind: "record" } as const;
  const remove = await mounted(null, false, { provider, guests: [guest] });
  for (const [i, audience] of [undefined, { organizer, guests: [] }].entries()) {
    const { answer } = await remove(`unverified-${i}`, scope, audience);
    expect([answer.write?.state, answer.write?.reason]).toEqual(["refused", "version_stale"]);
  }
  expect((await remove("confirmed", scope, { organizer, guests: [guest] })).answer.write?.state).toBe("pending");
  const empty = await mounted(null, false, { provider, guests: [organizer] });
  expect((await empty("no-guests", scope)).answer.write?.state).toBe("pending");
  const partial = await mounted(null, false, { provider, guests: [], partial: true });
  const { answer } = await partial("partial", scope);
  expect([answer.write?.state, answer.write?.reason]).toEqual(["refused", "version_stale"]);
});
