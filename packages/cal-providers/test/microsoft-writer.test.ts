/**
 * Microsoft's calendar, written, against the bench's double of Graph (Microsoft's pages, call by
 * call; blind where the pages are). Built, tried against the double, not proven at Microsoft itself.
 */
import { formatRRule, intlZones, parseRRule, wall, zoned, floating } from "@ohmail/cal-core";
import type { HostResolver } from "@trafficflow/core/net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeReader, makeWriter, microsoftHosts } from "../src/microsoft/index.js";
import type { CalendarReader, CalendarWriter, Connection, EventDraft, WriteAnswer } from "../src/port.js";
import { fixedHostRequest, type HttpPort } from "../src/request/index.js";
import { Secret } from "./support/calendar-test-accounts.ts";
import { MsDoubleClient } from "./support/ms-double-client.ts";
// @ts-expect-error a plain module
import { startMsDouble } from "./support/ms-double.mjs";

import { draftRepeatSupported, recurrenceFor } from "../src/repeat-shapes.js";
import { caseText, coreDays, DRAFT_PROOF_CASES, PROOF_NOW } from "./support/repeat-proof.js";

const NOW = Date.UTC(2026, 10, 15, 9, 0, 0);
const KEY = "0123456789abcdef0123456789abcdef";
const zones = intlZones();
const never = new AbortController().signal;
const NOBODY: HostResolver = { resolve: async () => [] };

let double: { base: string; token: string; close: () => Promise<void> };
let ms: MsDoubleClient;
let writer: CalendarWriter;
let reader: CalendarReader;
const sent: { method: string; path: string; ifMatch: string | null; body: Record<string, unknown> | null }[] =
  [];

beforeAll(async () => {
  double = await startMsDouble({ port: 0 });
  ms = new MsDoubleClient({ base: double.base, token: new Secret(double.token) });
  const real = fixedHostRequest(microsoftHosts(double.base), {
    writes: true,
    resolver: NOBODY,
    policy: { kind: "own-network" },
  });
  const seeing: HttpPort = {
    request(url, o) {
      const { pathname, search } = new URL(url);
      sent.push({
        method: o.method,
        path: pathname + search,
        ifMatch: o.precondition?.kind === "unchanged" ? o.precondition.tag : null,
        body: o.body === null ? null : JSON.parse(o.body),
      });
      return real.request(url, o);
    },
  };
  writer = makeWriter({ http: seeing, clock: { now: () => NOW }, zones, graphBase: double.base });
  reader = makeReader({ http: real, clock: { now: () => NOW }, zones, graphBase: double.base });
});
afterAll(() => double.close());
beforeEach(async () => {
  await ms.reset();
  sent.length = 0;
});

const signedIn = (): Connection => ({
  provider: "microsoft",
  credential: { kind: "bearer", accessToken: async () => ({ ok: true, token: double.token }) },
  start: null,
});
const draft = (over: Partial<EventDraft> = {}): EventDraft => ({
  start: zoned(wall(2026, 11, 26, 9), "Europe/Zurich"),
  end: zoned(wall(2026, 11, 26, 10), "Europe/Zurich"),
  summary: "Kiln repair",
  description: "Bring the gloves",
  location: "Studio 2",
  url: null,
  busy: true,
  private: false,
  rule: null,
  organizer: null,
  attendees: [],
  alarms: [15],
  ...over,
});
const word = (a: WriteAnswer): string => (a.ok ? "ok" : a.reason);
const studio = { id: "cal-studio" };
async function held(id: string) {
  const page = await reader.readChanges(
    signedIn(),
    studio,
    null,
    {
      limit: 250,
      cursor: null,
      window: {
        start: { kind: "instant", epochMs: Date.UTC(2026, 10, 1) },
        end: { kind: "instant", epochMs: Date.UTC(2027, 1, 1) },
      },
    },
    never,
  );
  if (!page.ok) throw new Error(page.reason);
  return page.value.items.filter((i) => i.kind === "upsert" && i.id === id);
}

describe("Microsoft's writer, at the double", () => {
  it("does not notify different attendees after the pending change is rebased", async () => {
    const made = await writer.create(signedIn(), studio, { key: { hex: KEY }, event: draft() }, never);
    const item = made.ok ? made.items[0] : null;
    if (item?.kind !== "upsert") throw new Error("missing test event");
    const target = {
      id: item.id,
      version: item.version,
      text: null,
      occurrence: null,
      audience: { organizer: "studio@example.invalid", guests: ["clay@example.invalid"] },
    };
    expect(word(await writer.change(signedIn(), studio, target, { summary: "Moved firing" }, never))).toBe(
      "version_stale",
    );
    expect(sent.some((r) => r.method === "PATCH")).toBe(false);
  });

  it("makes a new event under a transactionId from the write's key; the same key again hands the first event back: ONE event", async () => {
    const first = await writer.create(signedIn(), studio, { key: { hex: KEY }, event: draft() }, never);
    const again = await writer.create(signedIn(), studio, { key: { hex: KEY }, event: draft() }, never);
    expect([word(first), word(again)]).toEqual(["ok", "ok"]);
    const id = first.ok && first.items[0]!.kind === "upsert" ? first.items[0]!.id : "";
    expect(again.ok && again.items[0]!.kind === "upsert" && again.items[0]!.id).toBe(id);
    expect(sent.map((s) => [s.method, s.path, s.body?.transactionId])).toEqual([
      ["POST", "/v1.0/me/calendars/cal-studio/events", "01234567-89ab-cdef-0123-456789abcdef"],
      ["POST", "/v1.0/me/calendars/cal-studio/events", "01234567-89ab-cdef-0123-456789abcdef"],
    ]);
    expect((await held(id)).length).toBe(1);
  });

  it("changes against the stored tag, refuses a tag Graph moved past and overwrites nothing, and takes a 412 already holding the change as done", async () => {
    const made = await writer.create(signedIn(), studio, { key: { hex: KEY }, event: draft() }, never);
    const item = made.ok ? made.items[0]! : null;
    if (item === null || item.kind !== "upsert") throw new Error("not made");
    const target = { id: item.id, version: item.version, text: null, occurrence: null };
    const changed = await writer.change(signedIn(), studio, target, { summary: "Kiln repair, moved" }, never);
    expect(word(changed)).toBe("ok");
    expect(sent.at(-1)!.ifMatch).toBe(item.version);
    const stale = await writer.change(signedIn(), studio, target, { summary: "Mine" }, never);
    expect(word(stale)).toBe("version_stale");
    expect((await held(item.id)).map((i) => i.kind === "upsert" && i.event.summary)).toEqual([
      "Kiln repair, moved",
    ]);
    expect(
      word(await writer.change(signedIn(), studio, target, { summary: "Kiln repair, moved" }, never)),
    ).toBe("ok");
  });

  it("removes against the tag; an event already gone is removed", async () => {
    const made = await writer.create(signedIn(), studio, { key: { hex: KEY }, event: draft() }, never);
    const item = made.ok ? made.items[0]! : null;
    if (item === null || item.kind !== "upsert") throw new Error("not made");
    const target = { id: item.id, version: item.version, text: null, occurrence: null };
    expect(await writer.remove(signedIn(), studio, target, never)).toEqual({
      ok: true,
      items: [{ kind: "gone", id: item.id }],
      written: true,
    });
    expect(await writer.remove(signedIn(), studio, target, never)).toEqual({
      ok: true,
      items: [{ kind: "gone", id: item.id }],
    });
  });

  it("refuses a cancellation when the live event's audience differs from the confirmation", async () => {
    const [invited] = await held("evt-catalogue-shoot");
    if (invited?.kind !== "upsert" || !invited.event.organizer?.email) throw new Error("missing test event");
    sent.length = 0;
    const target = {
      id: invited.id,
      version: invited.version,
      text: null,
      occurrence: null,
      audience: { organizer: invited.event.organizer.email, guests: [] },
    };
    expect(word(await writer.remove(signedIn(), studio, target, never))).toBe("version_stale");
    expect(sent.map((r) => r.method)).toEqual(["GET"]);
  });

  it("takes an answer whose first attempt landed as done when it is sent again, and asks nothing more; another answer on that copy is refused", async () => {
    const [invited] = await held("evt-catalogue-shoot");
    if (invited === undefined || invited.kind !== "upsert") throw new Error("the invitation is not there");
    const target = { id: invited.id, version: invited.version, text: null, occurrence: null };
    const answer = { as: "mila@lichtgrat.example", reply: "TENTATIVE" } as const;
    expect(word(await writer.answer(signedIn(), studio, target, answer, never))).toBe("ok");
    // Its answer lost, the same write is sent again under the version it was recorded on: Graph already says it.
    sent.length = 0;
    const again = await writer.answer(signedIn(), studio, target, answer, never);
    expect(word(again)).toBe("ok");
    expect(sent.map((s) => s.method)).toEqual(["GET"]);
    // Another answer on the copy that answer moved past: refused, nothing asked of Graph but the read.
    sent.length = 0;
    expect(
      word(await writer.answer(signedIn(), studio, target, { ...answer, reply: "DECLINED" }, never)),
    ).toBe("version_stale");
    expect(sent.map((s) => s.method)).toEqual(["GET"]);
  });

  it("writes nothing Graph would not keep as written, and asks nothing for it", async () => {
    for (const [over, expected] of [
      [{ rule: parseRRule("FREQ=HOURLY")! }, "repeat_unsupported"],
      [{ url: "https://call.example.test/room" }, "field_unwritable"],
      [{ alarms: [5, 15] }, "field_unwritable"],
      [{ start: floating(wall(2026, 11, 26, 9)), end: floating(wall(2026, 11, 26, 10)) }, "field_unwritable"],
    ] as const) {
      expect(
        word(
          await writer.create(
            signedIn(),
            studio,
            { key: { hex: KEY }, event: draft(over as Partial<EventDraft>) },
            never,
          ),
        ),
      ).toBe(expected);
    }
    expect(sent).toEqual([]);
  });

  it("writes no day of a series yet, and never a day's write onto its series: nothing is asked", async () => {
    const day = {
      id: "evt-any",
      version: 'W/"1"',
      text: null,
      occurrence: zoned(wall(2026, 11, 26, 9), "Europe/Zurich"),
    };
    const answers = [
      await writer.change(signedIn(), studio, day, { summary: "Only that day" }, never),
      await writer.remove(signedIn(), studio, day, never),
      await writer.answer(signedIn(), studio, day, { as: "mila@example.test", reply: "ACCEPTED" }, never),
      // Nor a series' end, nor its days from one on as a series of their own.
      await writer.endSeries(signedIn(), studio, day, { then: null, mayBeDone: false }, never),
      await writer.continueSeries(
        signedIn(),
        studio,
        {
          key: { hex: "0".repeat(32) },
          from: day,
          start: day.occurrence,
          end: day.occurrence,
          rule: parseRRule("FREQ=WEEKLY")!,
          change: {},
        },
        never,
      ),
    ];
    expect(answers.map(word)).toEqual(Array(5).fill("repeat_unsupported"));
    expect(sent).toEqual([]);
  });

  it("refuses a recurring invitation Microsoft would silently clamp", async () => {
    const rule = parseRRule("FREQ=MONTHLY;BYMONTHDAY=31;COUNT=6")!;
    const guest = ["tess", "example.com"].join("@");
    const made = await writer.create(
      signedIn(),
      studio,
      {
        key: { hex: KEY },
        event: draft({
          rule,
          organizer: ["organiser", "example.com"].join("@"),
          attendees: [{ email: guest, name: "Tess Vale", optional: false }],
        }),
      },
      never,
    );
    expect(word(made)).toBe("repeat_unsupported");
    expect(sent).toEqual([]);
  });
});

it("hands Graph the guest and a numbered last Friday and reads the repeat back", async () => {
  const guest = ["fern", "example.com"].join("@");
  const made = await writer.create(
    signedIn(),
    studio,
    {
      key: { hex: KEY },
      event: draft({
        start: zoned(wall(2026, 10, 30, 9), "Europe/Zurich"),
        end: zoned(wall(2026, 10, 30, 10), "Europe/Zurich"),
        rule: parseRRule("FREQ=MONTHLY;BYDAY=-1FR;COUNT=5")!,
        attendees: [{ email: guest, name: "Fern Pike", optional: false }],
      }),
    },
    never,
  );
  expect(word(made)).toBe("ok");
  expect(sent[0]?.body).toMatchObject({
    attendees: [{ emailAddress: { address: guest } }],
    recurrence: {
      pattern: { type: "relativeMonthly", index: "last", daysOfWeek: ["friday"] },
      range: { type: "numbered", numberOfOccurrences: 5 },
    },
  });
  const item = made.ok && made.items[0];
  if (!item || item.kind !== "upsert") throw new Error("The new series did not read back");
  expect(formatRRule(item.event.rules[0]!.rule!)).toBe("FREQ=MONTHLY;COUNT=5;BYDAY=-1FR");
  const days = await ms.graph("GET", `/me/events/${item.id}/instances`, {
    query: { startDateTime: "2026-10-01T00:00:00Z", endDateTime: "2027-04-01T00:00:00Z" },
  });
  expect(days.status).toBe(200);
  const instances = days.json.value as { start: { dateTime: string } }[];
  expect(instances.map(({ start }) => start.dateTime.slice(0, 10))).toEqual([
    "2026-10-30",
    "2026-11-27",
    "2026-12-25",
    "2027-01-29",
    "2027-02-26",
  ]);
});

it.each(DRAFT_PROOF_CASES)("round-trips Graph recurrence or refuses clamping: $name", async (c) => {
  const event = c.draft;
  const clamped = /from the 31st|on the 31st|on the 29th|29 February/.test(c.name);
  expect(draftRepeatSupported("microsoft", event.rule!, event.start, zones, PROOF_NOW)).toBe(!clamped);
  const made = await writer.create(signedIn(), studio, { key: { hex: KEY }, event }, never);
  if (clamped) {
    expect(word(made)).toBe("repeat_unsupported");
    expect(sent).toEqual([]);
    return;
  }
  expect(word(made)).toBe("ok");
  expect(sent[0]?.body?.recurrence).toEqual(recurrenceFor(event.rule!, event.start, zones));
  const item = made.ok && made.items[0];
  if (!item || item.kind !== "upsert") throw new Error("The new series did not read back");
  expect(item.event.start).toEqual(event.start);
  expect(item.event.end).toEqual(event.end);
  const back = { ...c, draft: { ...event, rule: item.event.rules[0]!.rule } };
  expect(coreDays(c, caseText(back, "read-back"))).toEqual(coreDays(c, caseText(c, "sent")));
});

it("reads a timed last Friday with an indexed weekday and UTC ending", async () => {
  const made = await writer.create(
    signedIn(),
    studio,
    {
      key: { hex: KEY },
      event: draft({
        start: zoned(wall(2026, 11, 27, 9), "Europe/Zurich"),
        end: zoned(wall(2026, 11, 27, 10), "Europe/Zurich"),
        rule: parseRRule("FREQ=MONTHLY;BYDAY=-1FR;UNTIL=20270430T070000Z")!,
      }),
    },
    never,
  );
  const item = made.ok && made.items[0];
  if (!item || item.kind !== "upsert") throw new Error("The new series did not read back");
  const rule = item.event.rules[0]!.rule!;
  expect(rule.byDay).toEqual([{ weekday: "FR", ordinal: -1 }]);
  expect(rule.bySetPos).toEqual([]);
  expect(rule.until).toMatchObject({ kind: "instant" });
  expect(recurrenceFor(rule, item.event.start!, zones)).toMatchObject({
    range: { type: "endDate", endDate: "2027-04-30" },
  });
});

it("sends a multi-day selection with an exclusive midnight end in Graph", async () => {
  const event = draft({
    start: { kind: "date", year: 2026, month: 10, day: 24 },
    end: { kind: "date", year: 2026, month: 10, day: 27 },
  });
  expect(word(await writer.create(signedIn(), studio, { key: { hex: KEY }, event }, never))).toBe("ok");
  expect(sent.find(({ method }) => method === "POST")?.body).toMatchObject({
    isAllDay: true,
    start: { dateTime: "2026-10-24T00:00:00", timeZone: "UTC" },
    end: { dateTime: "2026-10-27T00:00:00", timeZone: "UTC" },
  });
});
