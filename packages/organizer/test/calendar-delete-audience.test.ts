import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { accounts, calCalendars, calConnections, calEvents, calWrites, type Tx } from "@trafficflow/db";
import { makeTestDb } from "@trafficflow/db/testing";
import { eventOf, instant, intlZones, newEventComponent } from "@ohmail/cal-core";
import { BENCH_CALDAV_PLACE } from "@ohmail/cal-providers";
import type { CalendarRemoveScope } from "@ohmail/wire";
import { writeCallOf, type StoredEvent } from "../src/calendar/write-request.js";
import { calendarPool, passDb } from "../src/calendar/connection.js";
import { settleApplied } from "../src/calendar/write-settle.js";

const organizer = "organizer@example.invalid";
const guest = "guest@example.invalid";
const at = String(Date.UTC(2026, 10, 18));
const base = "2026-11-16T00:00:00.000Z";
const zones = intlZones();

function series(guestOnChangedDay: boolean): StoredEvent {
  const changed = guestOnChangedDay
    ? [
        "BEGIN:VEVENT",
        "UID:kiln",
        "DTSTAMP:20261101T000000Z",
        "RECURRENCE-ID;VALUE=DATE:20261118",
        "DTSTART;VALUE=DATE:20261118",
        "DTEND;VALUE=DATE:20261119",
        `ORGANIZER:mailto:${organizer}`,
        `ATTENDEE:mailto:${guest}`,
        "END:VEVENT",
      ]
    : [];
  const original = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Test//EN",
    "BEGIN:VEVENT",
    "UID:kiln",
    "DTSTAMP:20261101T000000Z",
    "DTSTART;VALUE=DATE:20261116",
    "DTEND;VALUE=DATE:20261117",
    "RRULE:FREQ=DAILY;COUNT=4",
    "END:VEVENT",
    ...changed,
    "END:VCALENDAR",
    "",
  ].join("\r\n");
  return {
    providerId: "kiln.ics",
    original,
    versionTag: '"one"',
    startKind: "date",
    startLocal: "20261116",
    startZone: null,
    endKind: "date",
    endLocal: "20261117",
    endZone: null,
    repeatRule: "FREQ=DAILY;COUNT=4",
    recurrenceId: "",
    addedDates: [],
    excludedDates: [],
    organizer: guestOnChangedDay ? organizer : null,
    myAnswer: null,
    excludesByRule: false,
    reachesForward: false,
    changedDays: Number(guestOnChangedDay),
    ownInvitee: null,
  };
}

function remove(
  event: StoredEvent,
  scope: CalendarRemoveScope,
  audience?: { organizer: string; guests: string[] },
  recorded = event.versionTag,
  place = BENCH_CALDAV_PLACE,
) {
  return writeCallOf({
    place,
    organizer,
    owners: new Set([organizer]),
    access: "owner",
    to: null,
    zones,
    now: Date.UTC(2026, 10, 15),
    event,
    base: recorded,
    act: { kind: "calendar_event_delete", eventId: "kiln", base, scope, ...(audience && { audience }) },
  });
}

describe("dispatching a stored recurring deletion", () => {
  it.each<CalendarRemoveScope>([{ kind: "record" }, { kind: "occurrence", at }, { kind: "following", at }])(
    "requires the confirmed guest for $kind",
    (scope) => {
      const event = series(true);
      expect(remove(event, scope)).toEqual({ kind: "refuse", reason: "version_stale" });
      expect(remove(event, scope, { organizer, guests: [] })).toEqual({
        kind: "refuse",
        reason: "version_stale",
      });
      expect(remove(event, scope, { organizer, guests: [guest] }).kind).toBe(
        scope.kind === "following" ? "end" : "remove",
      );
    },
  );

  it("allows an unconfirmed legacy deletion only when the scope is known to be guest-free", () => {
    const event = series(true);
    expect(remove(event, { kind: "occurrence", at: String(Date.UTC(2026, 10, 17)) }).kind).toBe("remove");
    expect(remove(series(false), { kind: "record" }).kind).toBe("remove");
    expect(remove({ ...series(false), original: null }, { kind: "record" })).toEqual({
      kind: "refuse",
      reason: "version_stale",
    });
  });
});

function single(guests: boolean): StoredEvent {
  const raw = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "BEGIN:VEVENT",
    "UID:kiln",
    "DTSTAMP:20261101T000000Z",
    "DTSTART;VALUE=DATE:20261116",
    "DTEND;VALUE=DATE:20261117",
    ...(guests ? [`ORGANIZER:mailto:${organizer}`, `ATTENDEE:mailto:${guest}`] : []),
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ].join("\r\n");
  return { ...series(false), original: raw, organizer: guests ? organizer : null, repeatRule: null };
}

it("refuses a provider command for a one-off cancellation without its guest confirmation", () => {
  const event = single(true);
  expect(remove(event, { kind: "record" }).kind).toBe("refuse");
});

it("requires the one-off guest confirmation to match the current provider version and audience", () => {
  const event = single(true);
  const scope = { kind: "record" } as const;
  const confirmed = { organizer, guests: [guest] };
  const refused = { kind: "refuse", reason: "version_stale" };
  expect(remove(event, scope, { organizer, guests: [] })).toEqual(refused);
  expect(remove(event, scope, { organizer: guest, guests: [guest] })).toEqual(refused);
  expect(remove(event, scope, confirmed, '"earlier"')).toEqual(refused);
  expect(remove(event, scope, confirmed).kind).toBe("remove");
});

it("keeps only a verified guest-free one-off cancellation eligible without confirmation", () => {
  const event = single(false);
  const scope = { kind: "record" } as const;
  expect(remove(event, scope).kind).toBe("remove");
  expect(remove({ ...event, original: null }, scope)).toEqual({ kind: "refuse", reason: "version_stale" });
});

it.each(["google", "microsoft"])(
  "verifies the stored %s guest list and binds the provider precondition",
  (place) => {
    const event = {
      ...single(true),
      original: null,
      deleteGuests: [
        { address: organizer, name: null },
        { address: guest, name: null },
      ],
    };
    const scope = { kind: "record" } as const;
    const confirmed = { organizer, guests: [guest] };
    const refused = { kind: "refuse", reason: "version_stale" };
    expect(remove(event, scope, undefined, event.versionTag, place)).toEqual(refused);
    expect(remove(event, scope, { organizer, guests: [] }, event.versionTag, place)).toEqual(refused);
    expect(remove(event, scope, confirmed, '"earlier"', place)).toEqual(refused);
    expect(remove(event, scope, confirmed, event.versionTag, place)).toMatchObject({
      kind: "remove",
      target: { audience: confirmed },
    });
    expect(remove({ ...event, deleteGuests: [] }, scope, undefined, event.versionTag, place)).toMatchObject({
      kind: "remove",
      target: { audience: { organizer, guests: [] } },
    });
    expect(remove({ ...event, deleteGuests: undefined }, scope, undefined, event.versionTag, place)).toEqual(
      refused,
    );
  },
);

it("keeps a queued cancellation on its original version when an earlier edit lands", async () => {
  const db = await makeTestDb();
  const [account] = await db.insert(accounts).values({ name: "Studio" }).returning({ id: accounts.id });
  const accountId = account!.id;
  const [connection] = await db
    .insert(calConnections)
    .values({
      accountId,
      provider: "google",
      status: "active",
      label: "Studio",
    })
    .returning({ id: calConnections.id });
  const [calendar] = await db
    .insert(calCalendars)
    .values({
      accountId,
      connectionId: connection!.id,
      providerId: "studio",
      name: "Studio",
      access: "owner",
    })
    .returning({ id: calCalendars.id });
  const calendarId = calendar!.id;
  const [event] = await db
    .insert(calEvents)
    .values({
      accountId,
      calendarId,
      providerId: "event",
      versionTag: '"one"',
      uid: "kiln",
      startKind: "instant",
      startLocal: "20261116T090000Z",
      endKind: "instant",
      endLocal: "20261116T100000Z",
      startsAt: new Date("2026-11-16T09:00:00Z"),
      endsAt: new Date("2026-11-16T10:00:00Z"),
    })
    .returning({ id: calEvents.id });
  const eventId = event!.id;
  const [edit, cancel] = await db
    .insert(calWrites)
    .values([
      {
        accountId,
        calendarId,
        eventId,
        op: "update",
        baseVersionTag: '"one"',
        idempotencyKey: "edit",
        payload: {},
        attempts: 1,
      },
      {
        accountId,
        calendarId,
        eventId,
        op: "delete",
        baseVersionTag: '"one"',
        idempotencyKey: "cancel",
        payload: {},
      },
    ])
    .returning({ id: calWrites.id });
  const changed = eventOf(
    newEventComponent({
      uid: "kiln",
      dtstamp: instant(Date.UTC(2026, 10, 16)),
      start: instant(Date.UTC(2026, 10, 16, 9)),
      end: instant(Date.UTC(2026, 10, 16, 10)),
    }),
  );
  await settleApplied(
    {
      db: passDb(calendarPool(db as unknown as Tx), accountId),
      key: { accountId, id: connection!.id },
      map: { zones, ownAddresses: new Set() },
      word: "google",
    },
    {
      id: edit!.id,
      op: "update",
      calendarId,
      calendarProviderId: "studio",
      eventId,
      baseVersionTag: '"one"',
      attempts: 1,
      provisional: false,
      toCalendarId: null,
      kept: {},
    },
    [{ kind: "upsert", id: "event", version: '"two"', event: changed, text: null }],
    "event",
    true,
  );
  const [after] = await db
    .select({ version: calWrites.baseVersionTag })
    .from(calWrites)
    .where(eq(calWrites.id, cancel!.id));
  const [stored] = await db
    .select({ version: calEvents.versionTag })
    .from(calEvents)
    .where(eq(calEvents.id, eventId));
  expect(stored?.version).toBe('"two"');
  expect(after?.version).toBe('"one"');
}, 40_000);
