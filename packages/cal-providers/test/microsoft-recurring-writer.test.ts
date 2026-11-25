import { instant, intlZones, parseRRule, plainDate, wall, zoned } from "@ohmail/cal-core";
import { describe, expect, it } from "vitest";
import { makeWriter } from "../src/microsoft/index.js";
import type { Connection, EventDraft, SeriesContinuation, WriteTarget } from "../src/port.js";
import type { HttpPort } from "../src/request/index.js";

const signal = new AbortController().signal;
const connection: Connection = {
  provider: "microsoft",
  credential: { kind: "bearer", accessToken: async () => ({ ok: true, token: "fixture" }) },
  start: null,
};
const cal = { id: "calendar" };
const attendees = [{ emailAddress: { address: "guest@example.invalid" }, type: "required" }];
const organizer = { emailAddress: { address: "owner@example.invalid" } };
const audience = { organizer: organizer.emailAddress.address, guests: [attendees[0]!.emailAddress.address] };
const seriesTime = (day: number, hour: number) => zoned(wall(2026, 10, day, hour), "Europe/Zurich");
const cut = instant(Date.UTC(2026, 9, 26, 8));
const range = { type: "noEnd", startDate: "2026-10-19", recurrenceTimeZone: "W. Europe Standard Time" };
const pattern = { type: "weekly", interval: 1, daysOfWeek: ["monday"], firstDayOfWeek: "monday" };
const master = {
  id: "master",
  type: "seriesMaster",
  "@odata.etag": 'W/"master-1"',
  changeKey: "master-1",
  iCalUId: "series",
  isOrganizer: true,
  organizer,
  attendees,
  subject: "Studio",
  recurrence: { pattern, range },
  cancelledOccurrences: [],
  exceptionOccurrences: [],
  originalStartTimeZone: "W. Europe Standard Time",
  originalEndTimeZone: "W. Europe Standard Time",
  start: { dateTime: "2026-10-19T07:00:00", timeZone: "UTC" },
  end: { dateTime: "2026-10-19T08:00:00", timeZone: "UTC" },
};
const occurrence = {
  ...master,
  id: "some-day",
  type: "occurrence",
  seriesMasterId: "master",
  recurrence: null,
  "@odata.etag": 'W/"day-1"',
  changeKey: "day-1",
  originalStart: "2026-10-26T08:00:00Z",
  start: { dateTime: "2026-10-26T08:00:00", timeZone: "UTC" },
  end: { dateTime: "2026-10-26T09:00:00", timeZone: "UTC" },
};
const target: WriteTarget & { readonly recurringSeries: true } = {
  id: "master",
  version: 'W/"master-1"',
  text: null,
  occurrence: cut,
  recurringSeries: true,
  audience,
};
const rule = parseRRule("FREQ=WEEKLY;BYDAY=MO")!;
const draft: EventDraft = {
  start: seriesTime(26, 10),
  end: seriesTime(26, 11),
  summary: "Later studio",
  description: null,
  location: null,
  url: null,
  busy: true,
  private: false,
  attendees: [{ email: audience.guests[0]!, name: null, optional: false }],
  organizer: audience.organizer,
  alarms: [],
  rule,
};
const then: SeriesContinuation & { readonly event: EventDraft } = {
  key: { hex: "1".repeat(32) },
  start: draft.start,
  end: draft.end,
  rule,
  change: { summary: draft.summary },
  event: draft,
};
const modern = { ...then, requireExisting: true as const };
const transaction = "11111111-1111-1111-1111-111111111111";
const continuation = {
  ...master,
  id: "continuation",
  iCalUId: "continuation",
  transactionId: transaction,
  isAllDay: false,
  "@odata.etag": 'W/"continuation-1"',
  changeKey: "continuation-1",
  subject: draft.summary,
  recurrence: { pattern, range: { ...range, startDate: "2026-10-26", recurrenceTimeZone: "Europe/Zurich" } },
  originalStartTimeZone: "Europe/Zurich",
  originalEndTimeZone: "Europe/Zurich",
  start: { dateTime: "2026-10-26T09:00:00", timeZone: "UTC" },
  end: { dateTime: "2026-10-26T10:00:00", timeZone: "UTC" },
};
const ended = {
  ...master,
  "@odata.etag": 'W/"master-2"',
  changeKey: "master-2",
  recurrence: { pattern, range: { ...range, type: "endDate", endDate: "2026-10-25" } },
};

function graph(respond: (method: string, path: string) => object | number | "timeout") {
  const calls: { method: string; path: string; tag: string | null; body: unknown }[] = [];
  const http: HttpPort = {
    async request(url, request) {
      const path = new URL(url).pathname.replace(/^\/v1\.0/, "");
      const { method } = request;
      calls.push({
        method,
        path,
        tag: request.precondition?.kind === "unchanged" ? request.precondition.tag : null,
        body: request.body === null ? null : JSON.parse(request.body),
      });
      const answer = respond(method, path);
      if (answer === "timeout") return { arrived: false, reason: "timeout" };
      const status =
        typeof answer === "number"
          ? answer
          : "fixtureStatus" in answer
            ? Number(answer.fixtureStatus)
            : method === "POST"
              ? 201
              : 200;
      return {
        arrived: true,
        status,
        header: () => null,
        location: null,
        hops: 0,
        body: new TextEncoder().encode(JSON.stringify(answer)),
        url,
      };
    },
  };
  return {
    writer: makeWriter({
      http,
      graphBase: "https://graph.example.invalid/v1.0",
      zones: intlZones(),
      clock: { now: () => 0 },
    }),
    writes: () => calls.filter(({ method }) => method !== "GET"),
  };
}

describe("Microsoft recurring event edits", () => {
  it("answers only the selected occurrence of a meeting", async () => {
    const meeting = { ...master, isOrganizer: false };
    const day = { ...occurrence, isOrganizer: false };
    const fixture = graph((method, path) => {
      if (method === "POST") return 202;
      if (path.endsWith("/instances")) return { value: [day] };
      return path.endsWith("/master") ? meeting : day;
    });
    const result = await fixture.writer.answer(
      connection,
      cal,
      target,
      { as: audience.guests[0]!, reply: "TENTATIVE" },
      signal,
    );
    expect(result.ok).toBe(true);
    expect(fixture.writes()).toMatchObject([
      { method: "POST", path: "/me/events/some-day/tentativelyAccept", body: { sendResponse: true } },
    ]);
  });

  it("answers one day of a meeting whose series moved on at Microsoft without that day changing", async () => {
    // Exchange gives the series a new version for things nobody sees on the day (an exception made elsewhere, its own
    // bookkeeping); the day the person answers is the same day, so the answer goes to it.
    const meeting = { ...master, isOrganizer: false, changeKey: "master-2", "@odata.etag": 'W/"master-2"' };
    const day = { ...occurrence, isOrganizer: false };
    const fixture = graph((method, path) => {
      if (method === "POST") return 202;
      if (path.endsWith("/instances")) return { value: [day] };
      // Graph's single read of the day may carry another tag than its listing did.
      return path.endsWith("/master") ? meeting : { ...day, "@odata.etag": 'W/"day-read"' };
    });
    const result = await fixture.writer.answer(
      connection,
      cal,
      target,
      { as: audience.guests[0]!, reply: "ACCEPTED" },
      signal,
    );
    expect(result.ok).toBe(true);
    expect(fixture.writes()).toMatchObject([{ method: "POST", path: "/me/events/some-day/accept" }]);
  });

  it("still refuses an answer for a day that moved at Microsoft since it was shown", async () => {
    const meeting = { ...master, isOrganizer: false };
    const moved = {
      ...occurrence,
      isOrganizer: false,
      type: "exception",
      start: { dateTime: "2026-10-26T12:00:00", timeZone: "UTC" },
    };
    const fixture = graph((method, path) => {
      if (method === "POST") return 202;
      if (path.endsWith("/instances")) return { value: [moved] };
      return path.endsWith("/master") ? meeting : moved;
    });
    const result = await fixture.writer.answer(
      connection,
      cal,
      target,
      { as: audience.guests[0]!, reply: "ACCEPTED" },
      signal,
    );
    expect(result).toMatchObject({ ok: false, reason: "version_stale" });
    expect(fixture.writes()).toEqual([]);
  });

  it("recovers an occurrence answer after Microsoft applied it but the reply was lost", async () => {
    const meeting = { ...master, isOrganizer: false };
    let day: Record<string, unknown> = { ...occurrence, isOrganizer: false };
    const fixture = graph((method, path) => {
      if (method === "POST") {
        day = {
          ...day,
          type: "exception",
          "@odata.etag": 'W/"changed-answer"',
          responseStatus: { response: "tentativelyAccepted" },
        };
        return "timeout";
      }
      if (path.endsWith("/instances")) return { value: [day] };
      return path.endsWith("/master") ? meeting : day;
    });
    const write = (retry?: true) =>
      fixture.writer.answer(
        connection,
        cal,
        target,
        { as: audience.guests[0]!, reply: "TENTATIVE", retry },
        signal,
      );
    expect(await write()).toMatchObject({ ok: false, reason: "timeout" });
    expect(await write(true)).toMatchObject({ ok: true });
    expect(fixture.writes()).toHaveLength(1);
  });

  it("refuses to use a Microsoft event with attachments for a portable move", async () => {
    const personal = {
      type: "singleInstance",
      "@odata.etag": 'W/"one"',
      iCalUId: "personal",
      isOrganizer: true,
      organizer,
      attendees: [],
      subject: "Studio",
      start: master.start,
      end: master.end,
    };
    const fixture = graph((_method, path) =>
      path.endsWith("/attached")
        ? { ...personal, id: "attached", hasAttachments: true, attachments: [{ id: "document" }] }
        : { ...personal, id: "plain", hasAttachments: false },
    );
    await expect(fixture.writer.readForMove!(connection, cal, "plain", signal)).resolves.toMatchObject({
      ok: true,
      items: [{ kind: "upsert", portableCopy: true }],
    });
    const read = await fixture.writer.readForMove!(connection, cal, "attached", signal);
    expect(read).toMatchObject({ ok: true, items: [{ kind: "upsert" }] });
    expect(read.ok && read.items[0]).not.toHaveProperty("portableCopy");
    expect(fixture.writes()).toEqual([]);
  });

  it("answers a previously changed meeting instance under its recorded key", async () => {
    const meeting = { ...master, isOrganizer: false };
    const day = { ...occurrence, isOrganizer: false, type: "exception" };
    const fixture = graph((method, path) => {
      if (method === "POST") return 202;
      if (path.endsWith("/instances")) return { value: [day] };
      return path.endsWith("/master") ? meeting : day;
    });
    const reply = { as: audience.guests[0]!, reply: "DECLINED" as const };
    const write = (version: string) =>
      fixture.writer.answer(
        connection,
        cal,
        { ...target, exception: { id: day.id, version, occurrence: cut } },
        reply,
        signal,
      );
    expect((await write('W/"stale"')).ok).toBe(false);
    expect(fixture.writes()).toHaveLength(0);
    expect((await write(day["@odata.etag"])).ok).toBe(true);
    expect(fixture.writes()).toMatchObject([{ method: "POST", path: "/me/events/some-day/decline" }]);
  });

  it("sends one series cancellation with the message after verifying all changed days", async () => {
    const extra = "extra" + "@example.test";
    const day = {
      ...occurrence,
      type: "exception",
      attendees: [{ emailAddress: { address: extra }, type: "required" }],
    };
    let cancelStatus = 412;
    const fixture = graph((method, path) =>
      method === "POST"
        ? cancelStatus
        : path.endsWith("/some-day")
          ? day
          : { ...master, exceptionOccurrences: [day] },
    );
    const remove = (version: string) =>
      fixture.writer.remove(
        connection,
        cal,
        {
          ...target,
          occurrence: null,
          audience: { ...audience, guests: [...audience.guests, extra] },
          seriesCancellation: {
            overrides: [{ id: day.id, version }],
            message: "The event has been cancelled",
          },
        },
        signal,
      );
    expect((await remove('"stale"')).ok).toBe(false);
    expect(fixture.writes()).toHaveLength(0);
    expect(await remove(day["@odata.etag"])).toMatchObject({ ok: false, reason: "version_stale" });
    cancelStatus = 202;
    expect((await remove(day["@odata.etag"])).ok).toBe(true);
    expect(fixture.writes()).toMatchObject(
      Array.from({ length: 2 }, () => ({
        method: "POST",
        path: "/me/events/master/cancel",
        tag: master["@odata.etag"],
        body: { comment: "The event has been cancelled" },
      })),
    );
  });

  it("cancels the whole reviewed series with its confirmed guests", async () => {
    let exceptions: object[] = [occurrence];
    const fixture = graph((method) =>
      method === "DELETE" ? 204 : { ...master, exceptionOccurrences: exceptions },
    );
    const remove = () => fixture.writer.remove(connection, cal, { ...target, occurrence: null }, signal);
    expect((await remove()).ok).toBe(false);
    expect(fixture.writes()).toHaveLength(0);
    exceptions = [];
    expect((await remove()).ok).toBe(true);
    expect(fixture.writes()).toMatchObject([
      { method: "DELETE", path: "/me/events/master", tag: master["@odata.etag"] },
    ]);
  });

  it("cancels one verified occurrence instead of the series", async () => {
    const fixture = graph((method, path) => {
      if (method === "DELETE") return 204;
      return path.endsWith("/instances") ? { value: [occurrence] } : master;
    });
    const answer = await fixture.writer.remove(connection, cal, target, signal);
    expect(answer).toMatchObject({
      ok: true,
      items: [{ kind: "cancelled_occurrence", uid: master.iCalUId }],
    });
    expect(fixture.writes()).toMatchObject([
      { method: "DELETE", path: "/me/events/some-day", tag: occurrence["@odata.etag"] },
    ]);
  });

  it("updates the exact occurrence using its own version and returns the changed day under the series", async () => {
    const fixture = graph((method, path) => {
      if (method === "PATCH") return { ...occurrence, subject: "Today only", type: "exception" };
      if (path.endsWith("/instances"))
        return {
          value: [{ ...occurrence, id: "other-day", originalStart: "2026-10-25T08:00:00Z" }, occurrence],
        };
      return master;
    });
    const result = await fixture.writer.change(connection, cal, target, { summary: "Today only" }, signal);
    expect(fixture.writes()).toEqual([
      { method: "PATCH", path: "/me/events/some-day", tag: 'W/"day-1"', body: { subject: "Today only" } },
    ]);
    expect(result).toMatchObject({
      ok: true,
      written: true,
      items: [
        {
          id: "some-day",
          event: { uid: "series", recurrenceId: zoned(wall(2026, 10, 26, 9), "Europe/Berlin") },
        },
      ],
    });
  });

  it("updates an already changed occurrence by the selected exception's own version", async () => {
    const detached = {
      ...occurrence,
      type: "exception",
      subject: "Separately named",
      location: { displayName: "Upstairs" },
      start: { dateTime: "2026-10-28T08:00:00", timeZone: "UTC" },
      end: { dateTime: "2026-10-28T09:00:00", timeZone: "UTC" },
    };
    const selected = {
      ...target,
      exception: { id: detached.id, version: detached.changeKey, occurrence: cut },
    };
    const fixture = graph((method, path) => {
      if (path.endsWith("/instances")) return { value: [] };
      if (path === "/me/events/some-day")
        return method === "PATCH" ? { ...detached, subject: "New title" } : detached;
      return master;
    });
    const result = await fixture.writer.change(connection, cal, selected, { summary: "New title" }, signal);
    expect(fixture.writes()).toEqual([
      { method: "PATCH", path: "/me/events/some-day", tag: 'W/"day-1"', body: { subject: "New title" } },
    ]);
    expect(result).toMatchObject({
      ok: true,
      written: true,
      items: [{ id: "some-day", event: { uid: "series", summary: "New title", location: "Upstairs" } }],
    });
  });

  it.each([
    { changeKey: "newer-copy", "@odata.etag": 'W/"newer-copy"' },
    { seriesMasterId: "another-series" },
    { originalStart: "2026-10-25T08:00:00Z" },
    { isOrganizer: false },
  ])("never writes a selected exception whose version, identity or ownership changed", async (changed) => {
    const detached = { ...occurrence, type: "exception", ...changed };
    const selected = {
      ...target,
      exception: { id: occurrence.id, version: occurrence.changeKey, occurrence: cut },
    };
    const fixture = graph((_method, path) => {
      if (path.endsWith("/instances")) return { value: [] };
      return path === "/me/events/some-day" ? detached : master;
    });
    expect(
      await fixture.writer.change(connection, cal, selected, { summary: "New title" }, signal),
    ).toMatchObject({ ok: false });
    expect(fixture.writes()).toEqual([]);
  });

  it("replaces the reviewed occurrence only after creating and verifying its following series", async () => {
    const detached = { ...occurrence, type: "exception", subject: "Separately named" };
    const attached = { ...master, exceptionOccurrences: [detached] };
    const selected = {
      ...target,
      exception: { id: detached.id, version: detached.changeKey, occurrence: cut },
    };
    let shortened = false;
    const fixture = graph((method, path) => {
      if (method === "POST" || path === "/me/events/continuation") return continuation;
      if (path === "/me/events/some-day") return shortened ? 404 : detached;
      if (method === "PATCH") {
        shortened = true;
        return ended;
      }
      return shortened ? ended : attached;
    });
    const result = await fixture.writer.endSeries(
      connection,
      cal,
      selected,
      { then: modern, mayBeDone: false },
      signal,
    );
    expect(fixture.writes().map(({ method, path, tag }) => [method, path, tag])).toEqual([
      ["POST", "/me/calendars/calendar/events", null],
      ["PATCH", "/me/events/master", 'W/"master-1"'],
    ]);
    expect(result).toMatchObject({
      ok: true,
      written: true,
      items: [
        { kind: "upsert", id: "master" },
        { kind: "gone", id: "some-day" },
      ],
    });
  });

  it.each([false, true])(
    "only removes a surviving source exception if its exact version still holds (%s)",
    async (changed) => {
      const detached = { ...occurrence, type: "exception", subject: "Separately named" };
      const attached = { ...master, exceptionOccurrences: [detached] };
      const newer = { ...detached, changeKey: "new-exception", "@odata.etag": 'W/"new-exception"' };
      const selected = {
        ...target,
        exception: { id: detached.id, version: detached.changeKey, occurrence: cut },
      };
      let shortened = false;
      const fixture = graph((method, path) => {
        if (method === "POST" || path === "/me/events/continuation") return continuation;
        if (path === "/me/events/some-day") {
          if (method === "DELETE") return 204;
          return shortened && changed ? newer : detached;
        }
        if (method === "PATCH") {
          shortened = true;
          return ended;
        }
        return shortened ? ended : attached;
      });
      const result = await fixture.writer.endSeries(
        connection,
        cal,
        selected,
        { then: modern, mayBeDone: false },
        signal,
      );
      expect(fixture.writes().map(({ method, path, tag }) => [method, path, tag])).toEqual([
        ["POST", "/me/calendars/calendar/events", null],
        ["PATCH", "/me/events/master", 'W/"master-1"'],
        ...(!changed ? [["DELETE", "/me/events/some-day", 'W/"day-1"']] : []),
      ]);
      expect(result).toMatchObject(
        changed
          ? { ok: false, reason: "version_stale" }
          : {
              ok: true,
              written: true,
              items: [
                { kind: "upsert", id: "master" },
                { kind: "gone", id: "some-day" },
              ],
            },
      );
    },
  );

  it("keeps an aged split check read-only when a source exception survived", async () => {
    const detached = { ...occurrence, type: "exception", subject: "Separately named" };
    const selected = {
      ...target,
      exception: { id: detached.id, version: detached.changeKey, occurrence: cut },
    };
    const fixture = graph((method, path) => {
      if (path === "/me/calendars/calendar/events") return { value: [continuation] };
      if (path === "/me/events/continuation") return continuation;
      if (path === "/me/events/some-day") return method === "DELETE" ? 204 : detached;
      return ended;
    });
    const result = await fixture.writer.endSeries(
      connection,
      cal,
      selected,
      {
        then: { ...modern, createdVersion: continuation["@odata.etag"] },
        mayBeDone: true,
        late: true,
      },
      signal,
    );
    expect(fixture.writes()).toEqual([]);
    expect(result).toMatchObject({ ok: false, reason: "version_stale" });
  });

  it("changes only the named field of the selected exception when editing all events", async () => {
    const detached = {
      ...occurrence,
      type: "exception",
      subject: "Separately named",
      location: { displayName: "Upstairs" },
    };
    const attached = { ...master, exceptionOccurrences: [detached] };
    const selected = {
      ...target,
      occurrence: null,
      exception: { id: detached.id, version: detached.changeKey, occurrence: cut },
    };
    let current = attached;
    const fixture = graph((method, path) => {
      if (path === "/me/events/some-day")
        return method === "PATCH" ? { ...detached, subject: "New title" } : detached;
      if (method === "PATCH")
        current = { ...current, subject: "New title", changeKey: "master-2", "@odata.etag": 'W/"master-2"' };
      return current;
    });
    const result = await fixture.writer.change(connection, cal, selected, { summary: "New title" }, signal);
    expect(fixture.writes()).toEqual([
      { method: "PATCH", path: "/me/events/master", tag: 'W/"master-1"', body: { subject: "New title" } },
      { method: "PATCH", path: "/me/events/some-day", tag: 'W/"day-1"', body: { subject: "New title" } },
    ]);
    expect(result).toMatchObject({
      ok: true,
      written: true,
      items: [
        { id: "master", event: { summary: "New title" } },
        { id: "some-day", event: { summary: "New title", location: "Upstairs" } },
      ],
    });
  });

  it.each(["version only", "independent field", "retry"] as const)(
    "keeps the separately named child bound when a master edit moves its version (%s)",
    async (scenario) => {
      const child = {
        ...occurrence,
        type: "exception",
        subject: "Separately named",
        location: { displayName: "Upstairs" },
        lastModifiedDateTime: "2026-10-21T09:00:00Z",
      };
      const advanced = {
        ...child,
        changeKey: "day-2",
        "@odata.etag": 'W/"day-2"',
        lastModifiedDateTime: "2026-10-22T09:00:00Z",
        ...(scenario === "independent field" && { location: { displayName: "Outside" } }),
      };
      const initial = { ...master, exceptionOccurrences: [child] };
      const changed = {
        ...initial,
        subject: "New title",
        changeKey: "master-2",
        "@odata.etag": 'W/"master-2"',
        exceptionOccurrences: [advanced],
      };
      let current = initial;
      let receipt: import("../src/port.js").MasterEditReceipt | undefined;
      let childAttempts = 0;
      const fixture = graph((method, path) => {
        if (path === "/me/events/some-day") {
          if (method === "PATCH") {
            if (scenario === "retry" && childAttempts++ === 0) return "timeout";
            return { ...advanced, subject: "New title" };
          }
          return current === initial ? child : advanced;
        }
        if (method === "PATCH") current = changed;
        return current;
      });
      const chosen = {
        ...target,
        occurrence: null,
        exception: { id: child.id, version: child.changeKey, occurrence: cut },
      };
      const edit = { summary: "New title" };
      const first = await fixture.writer.change(
        connection,
        cal,
        {
          ...chosen,
          rememberMasterReceipt: async (saved) => {
            receipt = saved;
          },
        },
        edit,
        signal,
      );
      if (scenario === "retry") expect(first).toMatchObject({ ok: false, reason: "timeout" });
      const final =
        scenario === "retry"
          ? await fixture.writer.change(connection, cal, { ...chosen, masterReceipt: receipt }, edit, signal)
          : first;
      expect(fixture.writes().map(({ path, tag, body }) => [path, tag, body])).toEqual([
        ["/me/events/master", 'W/"master-1"', { subject: "New title" }],
        ...Array.from({ length: scenario === "retry" ? 2 : scenario === "version only" ? 1 : 0 }, () => [
          "/me/events/some-day",
          'W/"day-2"',
          { subject: "New title" },
        ]),
      ]);
      expect(final).toMatchObject(
        scenario === "independent field"
          ? { ok: false, reason: "version_stale" }
          : {
              ok: true,
              items: [
                { id: "master" },
                { id: "some-day", event: { summary: "New title", location: "Upstairs" } },
              ],
            },
      );
    },
  );

  it("keeps a secondary location independently changed during a master location edit", async () => {
    const primary = { displayName: "Upstairs" };
    const child = {
      ...occurrence,
      type: "exception",
      location: primary,
      locations: [primary, { displayName: "Side room" }],
    };
    const advanced = {
      ...child,
      changeKey: "day-2",
      "@odata.etag": 'W/"day-2"',
      locations: [primary, { displayName: "Outside" }],
    };
    const initial = { ...master, exceptionOccurrences: [child] };
    const changed = {
      ...initial,
      location: { displayName: "New studio" },
      changeKey: "master-2",
      "@odata.etag": 'W/"master-2"',
      exceptionOccurrences: [advanced],
    };
    let current = initial;
    const fixture = graph((method, path) => {
      if (path === "/me/events/some-day") {
        const shown = current === initial ? child : advanced;
        return method === "PATCH" ? { ...shown, location: changed.location } : shown;
      }
      if (method === "PATCH") current = changed;
      return current;
    });
    const selected = {
      ...target,
      occurrence: null,
      exception: { id: child.id, version: child.changeKey, occurrence: cut },
    };
    const result = await fixture.writer.change(connection, cal, selected, { location: "New studio" }, signal);
    expect(fixture.writes().map(({ path, tag, body }) => [path, tag, body])).toEqual([
      ["/me/events/master", 'W/"master-1"', { location: { displayName: "New studio" } }],
    ]);
    expect(result).toMatchObject({ ok: false, reason: "version_stale" });
  });

  it("uses the invited guests on the exact exception even when the master has a different audience", async () => {
    const detached = { ...occurrence, attendees: [], type: "exception", subject: "Separately named" };
    const selected = {
      ...target,
      audience: { ...audience, guests: [] },
      exception: { id: detached.id, version: detached.changeKey, occurrence: cut },
    };
    const fixture = graph((method, path) => {
      if (path === "/me/events/some-day")
        return method === "PATCH" ? { ...detached, subject: "New title" } : detached;
      return master;
    });
    const result = await fixture.writer.change(connection, cal, selected, { summary: "New title" }, signal);
    expect(fixture.writes().map(({ path, tag }) => [path, tag])).toEqual([
      ["/me/events/some-day", 'W/"day-1"'],
    ]);
    expect(result).toMatchObject({ ok: true, written: true });
  });

  it("keeps an exception's start while resizing all events relative to their own dates", async () => {
    const detached = {
      ...occurrence,
      type: "exception",
      start: { dateTime: "2026-10-26T08:30:00", timeZone: "UTC" },
      end: { dateTime: "2026-10-26T09:30:00", timeZone: "UTC" },
      attendees: [],
    };
    const attached = { ...master, exceptionOccurrences: [detached] };
    const selected = {
      ...target,
      occurrence: null,
      exception: { id: detached.id, version: detached.changeKey, occurrence: cut },
    };
    let current = attached;
    const fixture = graph((method, path) => {
      if (path === "/me/events/some-day")
        return method === "PATCH"
          ? { ...detached, end: { dateTime: "2026-10-26T10:30:00", timeZone: "UTC" } }
          : detached;
      if (method === "PATCH")
        current = {
          ...current,
          changeKey: "master-2",
          "@odata.etag": 'W/"master-2"',
          end: { dateTime: "2026-10-19T09:00:00", timeZone: "UTC" },
        };
      return current;
    });
    const result = await fixture.writer.change(
      connection,
      cal,
      selected,
      {
        start: zoned(wall(2026, 10, 19, 9), "Europe/Berlin"),
        end: zoned(wall(2026, 10, 19, 11), "Europe/Berlin"),
      },
      signal,
    );
    expect(fixture.writes()).toEqual([
      {
        method: "PATCH",
        path: "/me/events/master",
        tag: 'W/"master-1"',
        body: { end: { dateTime: "2026-10-19T11:00:00", timeZone: "Europe/Berlin" } },
      },
      {
        method: "PATCH",
        path: "/me/events/some-day",
        tag: 'W/"day-1"',
        body: { end: { dateTime: "2026-10-26T11:30:00", timeZone: "Europe/Berlin" } },
      },
    ]);
    expect(result).toMatchObject({ ok: true, written: true, items: [{ id: "master" }, { id: "some-day" }] });
  });

  it("does not start a whole-series edit after the selected exception changes", async () => {
    const detached = { ...occurrence, type: "exception", subject: "Separately named" };
    const newer = { ...detached, changeKey: "day-2", "@odata.etag": 'W/"day-2"' };
    const selected = {
      ...target,
      occurrence: null,
      exception: { id: detached.id, version: detached.changeKey, occurrence: cut },
    };
    let expandedReads = 0;
    const fixture = graph((_method, path) =>
      path === "/me/events/some-day"
        ? detached
        : { ...master, exceptionOccurrences: [++expandedReads > 1 ? newer : detached] },
    );
    const result = await fixture.writer.change(connection, cal, selected, { summary: "New title" }, signal);
    expect(fixture.writes()).toEqual([]);
    expect(result).toMatchObject({ ok: false, reason: "version_stale" });
  });

  it("reconciles a generated occurrence's lost answer even when its master version also moved", async () => {
    const saved = {
      ...occurrence,
      type: "exception",
      subject: "Only this day",
      changeKey: "day-2",
      "@odata.etag": 'W/"day-2"',
    };
    let landed = false;
    const fixture = graph((method, path) => {
      if (method === "PATCH") {
        landed = true;
        return "timeout";
      }
      if (path.endsWith("/instances")) return { value: [landed ? saved : occurrence] };
      return landed ? { ...master, changeKey: "master-2", "@odata.etag": 'W/"master-2"' } : master;
    });
    const edit = { summary: "Only this day" };
    expect(await fixture.writer.change(connection, cal, target, edit, signal)).toMatchObject({
      ok: false,
      reason: "timeout",
    });
    expect(await fixture.writer.change(connection, cal, target, edit, signal)).toEqual({
      ok: true,
      items: [expect.objectContaining({ id: "some-day" })],
    });
    expect(fixture.writes().map(({ path, tag }) => [path, tag])).toEqual([
      ["/me/events/some-day", 'W/"day-1"'],
    ]);
  });

  it("recognizes the lost response to the same exception edit without writing again", async () => {
    const detached = { ...occurrence, type: "exception", subject: "Separately named" };
    const applied = {
      ...detached,
      subject: "Saved title",
      changeKey: "day-2",
      "@odata.etag": 'W/"day-2"',
    };
    const selected = {
      ...target,
      exception: { id: detached.id, version: detached.changeKey, occurrence: cut },
    };
    const fixture = graph((_method, path) => (path === "/me/events/some-day" ? applied : master));
    const result = await fixture.writer.change(connection, cal, selected, { summary: "Saved title" }, signal);
    expect(fixture.writes()).toEqual([]);
    expect(result).toEqual({ ok: true, items: [expect.objectContaining({ id: "some-day" })] });
  });

  it.each(["timeout", 403] as const)(
    "resumes the child after the acknowledged master update and a %s child answer",
    async (fault) => {
      const detached = { ...occurrence, type: "exception", subject: "Separately named" };
      const selected = {
        ...target,
        occurrence: null,
        exception: { id: detached.id, version: detached.changeKey, occurrence: cut },
      };
      let receipt: { version: string; exceptionEndMs?: number } | undefined;
      let masterChanged = false;
      let childCalls = 0;
      const seen = {
        ...master,
        subject: "New title",
        changeKey: "master-2",
        "@odata.etag": 'W/"master-2"',
      };
      const fixture = graph((method, path) => {
        if (path === "/me/events/some-day") {
          if (method !== "PATCH") return detached;
          expect(receipt).toEqual({
            version: 'W/"master-2"',
            exceptionSnapshot: expect.stringMatching(/^[a-f0-9]{64}$/),
          });
          return childCalls++ === 0 ? fault : { ...detached, subject: "New title" };
        }
        if (method === "PATCH") masterChanged = true;
        return { ...(masterChanged ? seen : master), exceptionOccurrences: [detached] };
      });
      const change = { summary: "New title" };
      const first = await fixture.writer.change(
        connection,
        cal,
        {
          ...selected,
          rememberMasterReceipt: async (r: { version: string; exceptionEndMs?: number }) => {
            receipt = r;
          },
        },
        change,
        signal,
      );
      expect(first).toMatchObject({ ok: false, reason: fault === "timeout" ? "timeout" : "read_only" });
      const retry = await fixture.writer.change(
        connection,
        cal,
        {
          ...selected,
          masterReceipt: receipt,
        },
        change,
        signal,
      );
      expect(fixture.writes().map(({ path, tag }) => [path, tag])).toEqual([
        ["/me/events/master", 'W/"master-1"'],
        ["/me/events/some-day", 'W/"day-1"'],
        ["/me/events/some-day", 'W/"day-1"'],
      ]);
      expect(retry).toMatchObject({ ok: true, items: [{ id: "master" }, { id: "some-day" }] });
    },
  );

  it.each(["no receipt", "independent master", "independent exception", "intended exception"] as const)(
    "never rewrites from an unapproved master or child on recovery (%s)",
    async (scenario) => {
      const detached = { ...occurrence, type: "exception", subject: "Separately named" };
      const masterTag = scenario === "independent master" ? 'W/"master-3"' : 'W/"master-2"';
      const masterNow = {
        ...master,
        subject: "New title",
        "@odata.etag": masterTag,
        changeKey: "new master",
      };
      const childNow = scenario.endsWith("exception")
        ? {
            ...detached,
            changeKey: "other-day",
            "@odata.etag": 'W/"other-day"',
            subject: scenario === "intended exception" ? "New title" : "Someone else's title",
          }
        : detached;
      const selected = {
        ...target,
        occurrence: null,
        exception: { id: detached.id, version: detached.changeKey, occurrence: cut },
        ...(scenario !== "no receipt" && { masterReceipt: { version: 'W/"master-2"' } }),
      };
      const fixture = graph((_method, path) =>
        path === "/me/events/some-day" ? childNow : { ...masterNow, exceptionOccurrences: [childNow] },
      );
      const result = await fixture.writer.change(connection, cal, selected, { summary: "New title" }, signal);
      expect(fixture.writes()).toEqual([]);
      expect(result).toMatchObject(
        scenario === "intended exception"
          ? { ok: true, items: [{ id: "master" }, { id: "some-day" }] }
          : { ok: false, reason: "version_stale" },
      );
    },
  );

  it("resumes a resize using the end recorded with the acknowledged master version", async () => {
    const detached = { ...occurrence, type: "exception" };
    const resized = { ...detached, end: { dateTime: "2026-10-26T10:00:00", timeZone: "UTC" } };
    const changedMaster = {
      ...master,
      changeKey: "master-2",
      "@odata.etag": 'W/"master-2"',
      end: { dateTime: "2026-10-19T09:00:00", timeZone: "UTC" },
      exceptionOccurrences: [detached],
    };
    const selected = {
      ...target,
      occurrence: null,
      exception: { id: detached.id, version: detached.changeKey, occurrence: cut },
      masterReceipt: { version: 'W/"master-2"', exceptionEndMs: Date.UTC(2026, 9, 26, 10) },
    };
    const fixture = graph((method, path) =>
      path === "/me/events/some-day" ? (method === "PATCH" ? resized : detached) : changedMaster,
    );
    const result = await fixture.writer.change(
      connection,
      cal,
      selected,
      {
        start: zoned(wall(2026, 10, 19, 9), "Europe/Berlin"),
        end: zoned(wall(2026, 10, 19, 11), "Europe/Berlin"),
      },
      signal,
    );
    expect(fixture.writes()).toEqual([
      {
        method: "PATCH",
        path: "/me/events/some-day",
        tag: 'W/"day-1"',
        body: { end: { dateTime: "2026-10-26T11:00:00", timeZone: "Europe/Berlin" } },
      },
    ]);
    expect(result).toMatchObject({ ok: true, items: [{ id: "master" }, { id: "some-day" }] });
  });

  it("updates the all-day master for all events and retains its recurrence", async () => {
    const allDay = {
      ...master,
      isAllDay: true,
      start: { dateTime: "2026-10-19T00:00:00", timeZone: "UTC" },
      end: { dateTime: "2026-10-20T00:00:00", timeZone: "UTC" },
    };
    const fixture = graph((method) => (method === "PATCH" ? { ...allDay, subject: "All days" } : allDay));
    const result = await fixture.writer.change(
      connection,
      cal,
      { ...target, occurrence: null },
      { summary: "All days" },
      signal,
    );
    expect(fixture.writes()).toEqual([
      { method: "PATCH", path: "/me/events/master", tag: 'W/"master-1"', body: { subject: "All days" } },
    ]);
    expect(result).toMatchObject({
      ok: true,
      items: [
        { id: "master", event: { summary: "All days", start: plainDate(2026, 10, 19), rules: [{ rule }] } },
      ],
    });
  });

  it("updates the timed master with a counted Graph recurrence pattern", async () => {
    const recurrence = {
      pattern: { type: "daily", interval: 2 },
      range: {
        startDate: "2026-10-19",
        recurrenceTimeZone: "Europe/Berlin",
        type: "numbered",
        numberOfOccurrences: 4,
      },
    };
    const fixture = graph((method) => (method === "PATCH" ? { ...master, recurrence } : master));
    const changedRule = parseRRule("FREQ=DAILY;INTERVAL=2;COUNT=4")!;
    const result = await fixture.writer.change(
      connection,
      cal,
      { ...target, occurrence: null },
      { rule: changedRule },
      signal,
    );
    expect(fixture.writes()).toEqual([
      { method: "PATCH", path: "/me/events/master", tag: 'W/"master-1"', body: { recurrence } },
    ]);
    expect(result).toMatchObject({ ok: true, items: [{ event: { rules: [{ rule: changedRule }] } }] });
  });

  it("finds an all-day occurrence by its local date when Graph returns the previous UTC date", async () => {
    const allDay = {
      ...master,
      isAllDay: true,
      start: { dateTime: "2026-10-18T22:00:00", timeZone: "UTC" },
      end: { dateTime: "2026-10-19T22:00:00", timeZone: "UTC" },
    };
    const day = {
      ...occurrence,
      isAllDay: true,
      originalStart: "2026-10-25T23:00:00Z",
      start: { dateTime: "2026-10-25T23:00:00", timeZone: "UTC" },
      end: { dateTime: "2026-10-26T23:00:00", timeZone: "UTC" },
    };
    const fixture = graph((method, path) =>
      method === "PATCH"
        ? { ...day, type: "exception", subject: "A day" }
        : path.endsWith("/instances")
          ? { value: [day] }
          : allDay,
    );
    const result = await fixture.writer.change(
      connection,
      cal,
      { ...target, occurrence: instant(Date.UTC(2026, 9, 26)) },
      { summary: "A day" },
      signal,
    );
    expect(fixture.writes()).toMatchObject([
      { method: "PATCH", path: "/me/events/some-day", tag: 'W/"day-1"' },
    ]);
    expect(result).toMatchObject({ ok: true, items: [{ event: { recurrenceId: plainDate(2026, 10, 26) } }] });
  });

  it.each(["version", "attendee", "invitee", "occurrence audience"])(
    "sends nothing when the live %s differs",
    async (moved) => {
      const fixture = graph((_method, path) =>
        path.endsWith("/instances")
          ? { value: [{ ...occurrence, ...(moved === "occurrence audience" && { attendees: [] }) }] }
          : {
              ...master,
              ...(moved === "version" && { "@odata.etag": 'W/"other"' }),
              ...(moved === "attendee" && { attendees: [] }),
              ...(moved === "invitee" && { isOrganizer: false }),
            },
      );
      const result = await fixture.writer.change(
        connection,
        cal,
        target,
        { summary: "Studio, changed" },
        signal,
      );
      expect(result).toMatchObject({
        ok: false,
        reason: moved === "invitee" ? "read_only" : "version_stale",
      });
      expect(fixture.writes()).toEqual([]);
    },
  );

  it("does not send a master update to guests from outside the confirmed audience on an exception", async () => {
    const exception = {
      ...occurrence,
      type: "exception",
      attendees: [{ emailAddress: { address: "other@example.invalid" } }],
    };
    const fixture = graph(() => ({ ...master, exceptionOccurrences: [exception] }));
    const result = await fixture.writer.change(
      connection,
      cal,
      { ...target, occurrence: null },
      { summary: "Updated all days" },
      signal,
    );
    expect(result).toMatchObject({ ok: false, reason: "version_stale" });
    expect(fixture.writes()).toEqual([]);
  });

  it("creates following first, ends on the local day before the cut, and recovers the same continuation", async () => {
    let shortened = false;
    let creations = 0;
    const fixture = graph((method, path) => {
      if (method === "POST") {
        if (creations === 1) return { ...continuation, fixtureStatus: 200 };
        creations++;
        return continuation;
      }
      if (method === "PATCH") {
        shortened = true;
        return ended;
      }
      if (path === "/me/events/continuation") return continuation;
      if (path === "/me/calendars/calendar/events") return { value: [continuation] };
      if (path.endsWith("/instances")) return { value: [occurrence] };
      return shortened ? ended : master;
    });
    const result = await fixture.writer.endSeries(
      connection,
      cal,
      target,
      { then, mayBeDone: false },
      signal,
    );
    expect(fixture.writes()).toMatchObject([
      {
        method: "POST",
        path: "/me/calendars/calendar/events",
        body: { transactionId: transaction, recurrence: { range: { startDate: "2026-10-26" } } },
      },
      {
        method: "PATCH",
        path: "/me/events/master",
        tag: 'W/"master-1"',
        body: { recurrence: { range: { type: "endDate", endDate: "2026-10-25" } } },
      },
    ]);
    expect(result).toMatchObject({ ok: true, items: [{ id: "master" }] });
    expect(await fixture.writer.continueSeries(connection, cal, { ...modern, from: target }, signal)).toEqual(
      {
        ok: true,
        items: [expect.objectContaining({ id: "continuation" })],
      },
    );
    expect(fixture.writes().map(({ method }) => method)).toEqual(["POST", "PATCH"]);
    expect(creations).toBe(1);
  });

  it("splits a whole-day series on the selected date and keeps the exclusive next-day end", async () => {
    const date = (day: number) => plainDate(2026, 10, day);
    const midnight = "00:00:00";
    const graphDate = (day: number) => ({ dateTime: `2026-10-${day}T${midnight}`, timeZone: "UTC" });
    const allDay = { ...master, isAllDay: true, start: graphDate(19), end: graphDate(20) };
    const allDayOccurrence = {
      ...occurrence,
      isAllDay: true,
      originalStart: "2026-10-25T23:00:00Z",
      start: graphDate(26),
      end: graphDate(27),
    };
    const newDraft = { ...draft, start: date(26), end: date(27) };
    const next = { ...then, event: newDraft, start: newDraft.start, end: newDraft.end };
    const fixture = graph((method, path) => {
      if (method === "POST" || path === "/me/events/continuation")
        return {
          ...continuation,
          isAllDay: true,
          start: graphDate(26),
          end: graphDate(27),
          recurrence: { pattern, range: { ...continuation.recurrence.range, recurrenceTimeZone: "UTC" } },
        };
      if (method === "PATCH") return { ...ended, isAllDay: true, start: graphDate(19), end: graphDate(20) };
      return path.endsWith("/instances") ? { value: [allDayOccurrence] } : allDay;
    });
    expect(
      await fixture.writer.endSeries(
        connection,
        cal,
        { ...target, occurrence: date(26) },
        { then: next, mayBeDone: false },
        signal,
      ),
    ).toMatchObject({ ok: true });
    expect(fixture.writes()).toMatchObject([
      {
        method: "POST",
        body: {
          isAllDay: true,
          start: graphDate(26),
          end: graphDate(27),
          recurrence: { range: { startDate: "2026-10-26" } },
        },
      },
      { method: "PATCH", body: { recurrence: { range: { endDate: "2026-10-25" } } } },
    ]);
  });

  it("rolls back only the created copy and only when Graph definitively refuses the end", async () => {
    const fixture = graph((method, path) => {
      if (method === "POST") return continuation;
      if (method === "PATCH") return 412;
      if (method === "DELETE") return 204;
      if (path === "/me/events/continuation") return continuation;
      return path.endsWith("/instances") ? { value: [occurrence] } : master;
    });
    expect(
      await fixture.writer.endSeries(connection, cal, target, { then, mayBeDone: false }, signal),
    ).toMatchObject({ ok: false, reason: "version_stale" });
    expect(fixture.writes().map(({ method, path, tag }) => [method, path, tag])).toEqual([
      ["POST", "/me/calendars/calendar/events", null],
      ["PATCH", "/me/events/master", 'W/"master-1"'],
      ["DELETE", "/me/events/continuation", 'W/"continuation-1"'],
    ]);
  });

  it("keeps the continuation when a lost create response left no saved creation version", async () => {
    let retried = false;
    const live = { ...continuation, "@odata.etag": 'W/"live-continuation"', changeKey: "live-continuation" };
    const fixture = graph((method, path) => {
      if (method === "POST") {
        if (retried) return { ...continuation, fixtureStatus: 200 };
        retried = true;
        return "timeout";
      }
      if (method === "PATCH") return 403;
      if (method === "DELETE") return 204;
      if (path === "/me/events/continuation") return live;
      return path.endsWith("/instances") ? { value: [occurrence] } : master;
    });
    expect(
      await fixture.writer.endSeries(connection, cal, target, { then, mayBeDone: false }, signal),
    ).toMatchObject({ ok: false, reason: "timeout" });
    expect(
      await fixture.writer.endSeries(connection, cal, target, { then, mayBeDone: true }, signal),
    ).toMatchObject({ ok: false, reason: "read_only" });
    expect(fixture.writes().map(({ method, path, tag }) => [method, path, tag])).toEqual([
      ["POST", "/me/calendars/calendar/events", null],
      ["POST", "/me/calendars/calendar/events", null],
      ["PATCH", "/me/events/master", 'W/"master-1"'],
    ]);
  });

  it("records the creation tag before trimming and clears it only after acknowledged cleanup", async () => {
    let version: string | undefined;
    let trims = 0;
    const remember = async (tag: string | null) => {
      version = tag ?? undefined;
    };
    const fixture = graph((method, path) => {
      if (method === "POST") return continuation;
      if (method === "PATCH") {
        expect(version).toBe('W/"continuation-1"');
        trims++;
        return trims === 1 ? "timeout" : 403;
      }
      if (method === "DELETE") {
        expect(version).toBe('W/"continuation-1"');
        return 204;
      }
      if (path === "/me/calendars/calendar/events") return { value: [continuation] };
      if (path === "/me/events/continuation") return continuation;
      return path.endsWith("/instances") ? { value: [occurrence] } : master;
    });
    const dispatched = { ...then, rememberCreatedVersion: remember };
    expect(
      await fixture.writer.endSeries(connection, cal, target, { then: dispatched, mayBeDone: false }, signal),
    ).toMatchObject({ ok: false, reason: "timeout" });
    expect(
      await fixture.writer.endSeries(
        connection,
        cal,
        target,
        { then: { ...dispatched, createdVersion: version }, mayBeDone: true },
        signal,
      ),
    ).toMatchObject({ ok: false, reason: "read_only" });
    expect(fixture.writes().map(({ method, tag }) => [method, tag])).toEqual([
      ["POST", null],
      ["PATCH", 'W/"master-1"'],
      ["PATCH", 'W/"master-1"'],
      ["DELETE", 'W/"continuation-1"'],
    ]);
    expect(version).toBeUndefined();
  });

  it("does not trim or delete a recovered continuation whose saved tag moved", async () => {
    const changed = { ...continuation, "@odata.etag": 'W/"continuation-2"', changeKey: "continuation-2" };
    const fixture = graph((method, path) => {
      if (method === "POST") return { ...continuation, fixtureStatus: 200 };
      if (method === "PATCH") return 403;
      if (path === "/me/calendars/calendar/events") return { value: [changed] };
      if (path === "/me/events/continuation") return changed;
      return path.endsWith("/instances") ? { value: [occurrence] } : master;
    });
    const recovered = { ...then, createdVersion: 'W/"continuation-1"' };
    expect(
      await fixture.writer.endSeries(connection, cal, target, { then: recovered, mayBeDone: true }, signal),
    ).toMatchObject({ ok: false, reason: "version_stale" });
    expect(fixture.writes()).toEqual([]);
  });

  it("keeps a recovered continuation if a live provider field on it differs", async () => {
    const fixture = graph((method, path) => {
      if (method === "POST") return { ...continuation, fixtureStatus: 200 };
      if (method === "PATCH") return 403;
      if (path === "/me/events/continuation") return { ...continuation, categories: ["Different category"] };
      if (path === "/me/calendars/calendar/events") return { value: [continuation] };
      return path.endsWith("/instances") ? { value: [occurrence] } : master;
    });
    expect(
      await fixture.writer.endSeries(
        connection,
        cal,
        target,
        { then: { ...then, createdVersion: 'W/"continuation-1"' }, mayBeDone: true },
        signal,
      ),
    ).toMatchObject({ ok: false, reason: "read_only" });
    expect(fixture.writes().map(({ method }) => method)).toEqual(["PATCH"]);
  });

  it("keeps a recovered continuation when the source's exact version moved after trimming was requested", async () => {
    let moved = false;
    const fixture = graph((method, path) => {
      if (method === "POST") return { ...continuation, fixtureStatus: 200 };
      if (method === "PATCH") {
        moved = true;
        return 403;
      }
      if (path === "/me/events/continuation") return continuation;
      if (path === "/me/calendars/calendar/events") return { value: [continuation] };
      if (path.endsWith("/instances")) return { value: [occurrence] };
      return moved
        ? {
            ...master,
            subject: "Changed source title",
            "@odata.etag": 'W/"master-moved"',
            changeKey: "master-moved",
          }
        : master;
    });
    expect(
      await fixture.writer.endSeries(
        connection,
        cal,
        target,
        { then: { ...then, createdVersion: 'W/"continuation-1"' }, mayBeDone: true },
        signal,
      ),
    ).toMatchObject({ ok: false, reason: "read_only" });
    expect(fixture.writes().map(({ method }) => method)).toEqual(["PATCH"]);
  });

  it("rechecks a timed-out cleanup and never trims when Graph replays a deleted continuation", async () => {
    let deleted = false;
    const fixture = graph((method, path) => {
      if (method === "POST") return deleted ? { ...continuation, fixtureStatus: 200 } : continuation;
      if (method === "PATCH") return 403;
      if (method === "DELETE") {
        deleted = true;
        return "timeout";
      }
      if (path === "/me/events/continuation") return deleted ? 404 : continuation;
      return path.endsWith("/instances") ? { value: [occurrence] } : master;
    });
    expect(
      await fixture.writer.endSeries(connection, cal, target, { then, mayBeDone: false }, signal),
    ).toMatchObject({ ok: false, reason: "timeout" });
    expect(
      await fixture.writer.endSeries(connection, cal, target, { then, mayBeDone: true }, signal),
    ).toMatchObject({ ok: false, reason: "version_stale" });
    expect(fixture.writes().map(({ method }) => method)).toEqual(["POST", "PATCH", "DELETE", "POST"]);
  });

  it("does not retry a cleanup when Graph reports that the continuation was edited", async () => {
    const fixture = graph((method, path) => {
      if (method === "POST") return continuation;
      if (method === "PATCH") return 403;
      if (method === "DELETE") return 412;
      if (path === "/me/events/continuation") return continuation;
      return path.endsWith("/instances") ? { value: [occurrence] } : master;
    });
    expect(
      await fixture.writer.endSeries(connection, cal, target, { then, mayBeDone: false }, signal),
    ).toMatchObject({ ok: false, reason: "read_only" });
    expect(fixture.writes().map(({ method }) => method)).toEqual(["POST", "PATCH", "DELETE"]);
  });

  it.each([
    ["a title-only exception", { subject: "Changed day" }, true],
    ["a moved exception", { start: { dateTime: "2026-10-26T08:30:00", timeZone: "UTC" } }, false],
    ["a cancelled exception", { isCancelled: true }, false],
    ["an exception with missing coverage", { originalStart: null }, false],
  ] as const)("preserves the original when %s appears during creation", async (_name, change, cleanup) => {
    let created = false;
    const lateException = {
      ...occurrence,
      type: "exception",
      isCancelled: false,
      occurrenceId: "OID.master.2026-10-26",
      ...change,
    };
    const fixture = graph((method, path) => {
      if (method === "POST") {
        created = true;
        return continuation;
      }
      if (method === "PATCH") return ended;
      if (method === "DELETE") return 204;
      if (path === "/me/events/continuation") return continuation;
      if (path.endsWith("/instances")) return { value: [occurrence] };
      return created ? { ...master, exceptionOccurrences: [lateException] } : master;
    });
    expect(
      await fixture.writer.endSeries(connection, cal, target, { then, mayBeDone: false }, signal),
    ).toMatchObject({ ok: false, reason: "version_stale" });
    expect(fixture.writes().map(({ method, path, tag }) => [method, path, tag])).toEqual(
      cleanup
        ? [
            ["POST", "/me/calendars/calendar/events", null],
            ["DELETE", "/me/events/continuation", 'W/"continuation-1"'],
          ]
        : [["POST", "/me/calendars/calendar/events", null]],
    );
  });

  it.each(["before trimming", "after a refused trim"])(
    "preserves a separately edited new continuation %s when its master tag stays the same",
    async (when) => {
      let trimAttempted = false;
      const edited = { ...continuation, exceptionOccurrences: [{ id: "different-day" }] };
      const fixture = graph((method, path) => {
        if (method === "POST") return continuation;
        if (method === "PATCH") {
          trimAttempted = true;
          return 403;
        }
        if (path === "/me/events/continuation")
          return when === "before trimming" || trimAttempted ? edited : continuation;
        return path.endsWith("/instances") ? { value: [occurrence] } : master;
      });
      const result = await fixture.writer.endSeries(
        connection,
        cal,
        target,
        { then, mayBeDone: false },
        signal,
      );
      expect(result).toMatchObject({
        ok: false,
        reason: when === "before trimming" ? "version_stale" : "read_only",
      });
      expect(fixture.writes().map(({ method }) => method)).toEqual(
        when === "before trimming" ? ["POST"] : ["POST", "PATCH"],
      );
    },
  );

  it("retries timed-out late-exception compensation without recreating or trimming", async () => {
    let created = false;
    let cleanupAttempts = 0;
    let version: string | undefined;
    const dispatched = {
      ...then,
      rememberCreatedVersion: async (tag: string | null) => {
        version = tag ?? undefined;
      },
    };
    const late = { ...occurrence, type: "exception", isCancelled: false, subject: "Changed day" };
    const fixture = graph((method, path) => {
      if (method === "POST") {
        created = true;
        return continuation;
      }
      if (method === "DELETE") {
        cleanupAttempts++;
        return cleanupAttempts === 1 ? "timeout" : 204;
      }
      if (path === "/me/events/continuation") return continuation;
      if (path === "/me/calendars/calendar/events") return { value: [continuation] };
      if (path.endsWith("/instances")) return { value: [occurrence] };
      return created ? { ...master, exceptionOccurrences: [late] } : master;
    });
    expect(
      await fixture.writer.endSeries(connection, cal, target, { then: dispatched, mayBeDone: false }, signal),
    ).toMatchObject({ ok: false, reason: "timeout" });
    expect(
      await fixture.writer.endSeries(
        connection,
        cal,
        target,
        { then: { ...dispatched, createdVersion: version }, mayBeDone: true },
        signal,
      ),
    ).toMatchObject({ ok: false, reason: "version_stale" });
    expect(fixture.writes().map(({ method, tag }) => [method, tag])).toEqual([
      ["POST", null],
      ["DELETE", 'W/"continuation-1"'],
      ["DELETE", 'W/"continuation-1"'],
    ]);
    expect(version).toBeUndefined();
  });

  it("keeps the continuation when the original shrinks during recovery lookup", async () => {
    let shrunk = false;
    const late = { ...occurrence, type: "exception", isCancelled: false, subject: "Changed day" };
    const fixture = graph((_method, path) => {
      if (path === "/me/calendars/calendar/events") {
        shrunk = true;
        return { value: [continuation] };
      }
      if (path === "/me/events/continuation") return continuation;
      return { ...(shrunk ? ended : master), exceptionOccurrences: [late] };
    });
    const recovered = { ...then, createdVersion: 'W/"continuation-1"' };
    expect(
      await fixture.writer.endSeries(connection, cal, target, { then: recovered, mayBeDone: true }, signal),
    ).toMatchObject({ ok: false, reason: "version_stale" });
    expect(fixture.writes()).toEqual([]);
  });

  it("does not reshape a series with an earlier exception, while allowing title edits to its confirmed audience", async () => {
    const earlier = { ...occurrence, type: "exception", occurrenceId: "OID.master.2026-10-19" };
    const fixture = graph((method, path) => {
      if (method === "POST") return continuation;
      if (method === "PATCH") return { ...master, subject: "All days renamed" };
      if (path.endsWith("/instances")) return { value: [occurrence] };
      return { ...master, exceptionOccurrences: [earlier] };
    });
    expect(
      await fixture.writer.endSeries(connection, cal, target, { then, mayBeDone: false }, signal),
    ).toMatchObject({ ok: false, reason: "repeat_unsupported" });
    const all = { ...target, occurrence: null };
    expect(
      await fixture.writer.change(connection, cal, all, { rule: parseRRule("FREQ=DAILY")! }, signal),
    ).toMatchObject({ ok: false, reason: "repeat_unsupported" });
    expect(
      await fixture.writer.change(
        connection,
        cal,
        all,
        { start: seriesTime(19, 10), end: seriesTime(19, 11) },
        signal,
      ),
    ).toMatchObject({ ok: false, reason: "repeat_unsupported" });
    expect(fixture.writes()).toEqual([]);
    expect(
      await fixture.writer.change(connection, cal, all, { summary: "All days renamed" }, signal),
    ).toMatchObject({ ok: true });
    expect(fixture.writes().map(({ method }) => method)).toEqual(["PATCH"]);
  });

  it("keeps following when the shortening response was lost and recognizes the completed end on retry", async () => {
    let shortened = false;
    const fixture = graph((method, path) => {
      if (method === "POST") return continuation;
      if (method === "PATCH") {
        shortened = true;
        return "timeout";
      }
      if (path === "/me/events/continuation") return continuation;
      if (path.endsWith("/instances")) return { value: [occurrence] };
      if (path === "/me/calendars/calendar/events") return { value: [continuation] };
      return shortened ? ended : master;
    });
    expect(
      await fixture.writer.endSeries(connection, cal, target, { then, mayBeDone: false }, signal),
    ).toMatchObject({ ok: false, reason: "timeout" });
    expect(
      await fixture.writer.endSeries(connection, cal, target, { then, mayBeDone: true }, signal),
    ).toMatchObject({ ok: true, items: [{ id: "master" }] });
    expect(fixture.writes().map(({ method }) => method)).toEqual(["POST", "PATCH"]);
  });

  it("requires its own exact continuation before accepting a source that already shortened", async () => {
    const fixture = graph((_method, path) =>
      path === "/me/calendars/calendar/events"
        ? { value: [{ ...continuation, transactionId: "another-transaction" }] }
        : ended,
    );
    expect(
      await fixture.writer.endSeries(connection, cal, target, { then, mayBeDone: true }, signal),
    ).toMatchObject({ ok: false, reason: "version_stale" });
    expect(fixture.writes()).toEqual([]);
  });

  it("recovers the modern second half through the calendar's existing transaction without a POST", async () => {
    const fixture = graph((_method, path) =>
      path === "/me/calendars/calendar/events" ? { value: [continuation] } : ended,
    );
    const request = { ...modern, from: target };
    expect(await fixture.writer.continueSeries(connection, cal, request, signal)).toMatchObject({
      ok: true,
      items: [{ id: "continuation" }],
    });
    expect(fixture.writes()).toEqual([]);
  });

  it("refuses an unbound second row without attempting an insert", async () => {
    const fixture = graph((method) => (method === "POST" ? { ...continuation, fixtureStatus: 200 } : ended));
    expect(
      await fixture.writer.continueSeries(connection, cal, { ...then, from: target }, signal),
    ).toMatchObject({
      ok: false,
      reason: "version_stale",
    });
    expect(fixture.writes()).toEqual([]);
  });

  it("does not recreate a missing modern continuation or accept one with different content", async () => {
    for (const value of [[], [{ ...continuation, subject: "Different notes" }]]) {
      const fixture = graph((_method, path) =>
        path === "/me/calendars/calendar/events" ? { value } : ended,
      );
      const request = { ...modern, from: target };
      expect(await fixture.writer.continueSeries(connection, cal, request, signal)).toMatchObject({
        ok: false,
        reason: "version_stale",
      });
      expect(fixture.writes()).toEqual([]);
    }
  });

  it("keeps the continuation when the original already ends before the cut by the time Graph refuses", async () => {
    let shortened = false;
    const fixture = graph((method, path) => {
      if (method === "POST") return continuation;
      if (method === "PATCH") {
        shortened = true;
        return 412;
      }
      if (path === "/me/events/continuation") return continuation;
      if (path.endsWith("/instances")) return { value: [occurrence] };
      return shortened ? ended : master;
    });
    expect(
      await fixture.writer.endSeries(connection, cal, target, { then, mayBeDone: false }, signal),
    ).toMatchObject({ ok: false, reason: "version_stale" });
    expect(fixture.writes().map(({ method }) => method)).toEqual(["POST", "PATCH"]);
  });

  it.each([
    [
      "shortened its range after the cut",
      { recurrence: { pattern, range: { ...range, type: "endDate", endDate: "2026-11-02" } } },
    ],
    ["cancelled a later date", { cancelledOccurrences: ["OID.master.2026-11-02"] }],
    ["changed the duration", { end: { dateTime: "2026-10-19T08:30:00", timeZone: "UTC" } }],
  ])(
    "retains the continuation when the source %s and lost full pre-split coverage",
    async (_reason, changed) => {
      let moved = false;
      const fixture = graph((method, path) => {
        if (method === "POST") return continuation;
        if (method === "PATCH") {
          moved = true;
          return 412;
        }
        if (path === "/me/events/continuation") return continuation;
        if (path.endsWith("/instances")) return { value: [occurrence] };
        return moved ? { ...master, "@odata.etag": 'W/"master-moved"', ...changed } : master;
      });
      expect(
        await fixture.writer.endSeries(connection, cal, target, { then, mayBeDone: false }, signal),
      ).toMatchObject({ ok: false, reason: "version_stale" });
      expect(fixture.writes().map(({ method }) => method)).toEqual(["POST", "PATCH"]);
    },
  );

  it.each([
    { cancelledOccurrences: ["OID.master.2026-11-02"] },
    { exceptionOccurrences: [{ occurrenceId: "OID.master.2026-11-02" }] },
    { "exceptionOccurrences@odata.nextLink": "unread-entries" },
  ])("keeps the unshortened series when it cannot carry changes on following days", async (changed) => {
    const fixture = graph(() => ({ ...master, ...changed }));
    expect(
      await fixture.writer.endSeries(connection, cal, target, { then, mayBeDone: false }, signal),
    ).toMatchObject({ ok: false, reason: "repeat_unsupported" });
    expect(fixture.writes()).toEqual([]);
  });
});

it("refuses to send a Friday pattern on a master that starts Monday", async () => {
  const fixture = graph(() => master);
  const result = await fixture.writer.change(
    connection,
    cal,
    { ...target, occurrence: null },
    { rule: parseRRule("FREQ=WEEKLY;BYDAY=FR")! },
    signal,
  );
  expect(fixture.writes()).toEqual([]);
  expect(result).toMatchObject({ ok: false, reason: "repeat_unsupported" });
});
