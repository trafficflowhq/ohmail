/**
 * A meeting invitation that came as an Outlook Web App link, looked up in the person's own
 * Microsoft calendar: the link's Exchange id translated to Graph's, the event read by it, and
 * nothing else asked. No request leaves the process: the lookup is handed a request port that
 * answers from a table and throws on any other address. Every value is invented.
 */
import { intlZones } from "@ohmail/cal-core";
import { describe, expect, it } from "vitest";
import { makeExchangeInvitations, MS_GRAPH_BASE, restIdOf } from "../src/microsoft/index.js";
import type { Connection } from "../src/port.js";
import type { HttpPort } from "../src/request/index.js";

const BASE = MS_GRAPH_BASE;
const TRANSLATE = `${BASE}/me/translateExchangeIds`;
const EWS_ID = "AAMkADJh/TaHJ8AAV95f1jAAA+==";
const REST_ID = "AAMkADJh-TaHJ8AAV95f1jAAA_==";
const EVENT = `${BASE}/me/events/${encodeURIComponent(REST_ID)}`;
const NOW = Date.UTC(2026, 10, 24, 9, 0, 0);

type Reply = { status?: number; json?: unknown };

function serving(routes: Record<string, Reply>) {
  const sent: { url: string; method: string; body: string | null; token: string | null }[] = [];
  const http: HttpPort = {
    async request(url, o) {
      const token = o.auth !== null && o.auth.credential.kind === "bearer" ? o.auth.credential.token : null;
      sent.push({ url, method: o.method, body: o.body, token });
      const reply = routes[url];
      if (reply === undefined) throw new Error(`the test serves nothing at ${url}`);
      const body = new TextEncoder().encode(JSON.stringify(reply.json ?? {}));
      return {
        arrived: true,
        status: reply.status ?? 200,
        header: () => null,
        body,
        location: null,
        url,
        hops: 0,
      };
    },
  };
  return { http, sent };
}

const lookupOver = (routes: Record<string, Reply>) => {
  const { http, sent } = serving(routes);
  return {
    lookup: makeExchangeInvitations({ http, clock: { now: () => NOW }, zones: intlZones(), graphBase: BASE }),
    sent,
  };
};
const signedIn: Connection = {
  provider: "microsoft",
  credential: { kind: "bearer", accessToken: async () => ({ ok: true, token: "t1" }) },
  start: null,
};
const never = new AbortController().signal;
const utc = (dateTime: string) => ({ dateTime: `${dateTime}.0000000`, timeZone: "UTC" });

const invitation = (over: Record<string, unknown> = {}) => ({
  id: REST_ID,
  type: "singleInstance",
  iCalUId: "040000008200E00074C5B7101A82E0080000000001@example.test",
  subject: "Review planning",
  start: utc("2026-12-03T09:00:00"),
  end: utc("2026-12-03T10:00:00"),
  originalStartTimeZone: "W. Europe Standard Time",
  originalEndTimeZone: "W. Europe Standard Time",
  location: { displayName: "Room 4" },
  organizer: { emailAddress: { name: "Lena Example", address: "lena@org.example" } },
  attendees: [
    {
      type: "required",
      status: { response: "none" },
      emailAddress: { name: "Mila", address: "mila@org.example" },
    },
    {
      type: "optional",
      status: { response: "accepted" },
      emailAddress: { name: "Tom", address: "tom@org.example" },
    },
  ],
  responseStatus: { response: "tentativelyAccepted" },
  "@odata.etag": 'W/"etag-1"',
  ...over,
});

const translated = { json: { value: [{ sourceId: EWS_ID, targetId: REST_ID }] } };

describe("the event an Outlook Web App link names", () => {
  it("translates the link's id, reads the event by Graph's id, and maps it onto the card's fields", async () => {
    const { lookup, sent } = lookupOver({ [TRANSLATE]: translated, [EVENT]: { json: invitation() } });
    const answer = await lookup.eventOfItem(signedIn, EWS_ID, never);
    expect(answer.ok).toBe(true);
    if (!answer.ok || answer.value === null) throw new Error("no event");
    const { event, id, answer: mine } = answer.value;
    expect(id).toBe(REST_ID);
    expect(mine).toBe("tentative");
    expect(event.uid).toBe("040000008200E00074C5B7101A82E0080000000001@example.test");
    expect(event.summary).toBe("Review planning");
    expect(event.location).toBe("Room 4");
    expect(event.start).toEqual({
      kind: "zoned",
      wall: { year: 2026, month: 12, day: 3, hour: 10, minute: 0, second: 0 },
      tzid: "Europe/Berlin",
    });
    expect(event.organizer?.email).toBe("lena@org.example");
    expect(event.attendees.map((a) => a.email)).toEqual(["mila@org.example", "tom@org.example"]);
    // Two fixed requests, the second by Graph's id, both with the connection's own sign-in.
    expect(sent.map((s) => [s.method, s.url])).toEqual([
      ["POST", TRANSLATE],
      ["GET", EVENT],
    ]);
    expect(JSON.parse(sent[0]!.body!)).toEqual({
      inputIds: [EWS_ID],
      sourceIdType: "ewsId",
      targetIdType: "restId",
    });
    expect(sent.every((s) => s.token === "t1")).toBe(true);
  });

  it.each([
    ["accepted", "accepted"],
    ["declined", "declined"],
    ["notResponded", null],
    ["none", null],
    ["organizer", null],
  ])("reads my answer %s as %s", async (response, expected) => {
    const { lookup } = lookupOver({
      [TRANSLATE]: translated,
      [EVENT]: { json: invitation({ responseStatus: { response } }) },
    });
    const answer = await lookup.eventOfItem(signedIn, EWS_ID, never);
    expect(answer.ok && answer.value?.answer).toBe(expected);
  });

  it("writes Graph's form itself where the translation is refused for the calendar-only permission", async () => {
    expect(restIdOf(EWS_ID)).toBe(REST_ID);
    const { lookup, sent } = lookupOver({
      [TRANSLATE]: { status: 403, json: { error: { code: "ErrorAccessDenied" } } },
      [EVENT]: { json: invitation() },
    });
    const answer = await lookup.eventOfItem(signedIn, EWS_ID, never);
    expect(answer.ok && answer.value?.event.summary).toBe("Review planning");
    expect(sent.map((s) => s.url)).toEqual([TRANSLATE, EVENT]);
  });

  it("an id Graph cannot translate names nothing, and nothing more is asked", async () => {
    const { lookup, sent } = lookupOver({
      [TRANSLATE]: {
        json: { value: [{ sourceId: EWS_ID, errorDetails: { code: "ErrorInvalidIdMalformed" } }] },
      },
    });
    expect(await lookup.eventOfItem(signedIn, EWS_ID, never)).toEqual({
      ok: false,
      reason: "not_found",
      retryAfterMs: null,
    });
    expect(sent).toHaveLength(1);
  });

  it("an event that is gone, or another mailbox's item, is not_found", async () => {
    const { lookup } = lookupOver({
      [TRANSLATE]: translated,
      [EVENT]: { status: 404, json: { error: { code: "ErrorItemNotFound" } } },
    });
    expect(await lookup.eventOfItem(signedIn, EWS_ID, never)).toEqual({
      ok: false,
      reason: "not_found",
      retryAfterMs: null,
    });
  });

  it("a refused sign-in and a busy Graph are said as such", async () => {
    const refused = lookupOver({ [TRANSLATE]: { status: 401 } });
    expect(await refused.lookup.eventOfItem(signedIn, EWS_ID, never)).toMatchObject({
      ok: false,
      reason: "sign_in_refused",
    });
    const busy = lookupOver({ [TRANSLATE]: translated, [EVENT]: { status: 429 } });
    expect(await busy.lookup.eventOfItem(signedIn, EWS_ID, never)).toMatchObject({
      ok: false,
      reason: "throttled",
    });
  });

  it("one day of a series is no event the card shows", async () => {
    const day = invitation({
      type: "occurrence",
      seriesMasterId: "m-1",
      originalStart: "2026-12-03T09:00:00Z",
    });
    const { lookup } = lookupOver({ [TRANSLATE]: translated, [EVENT]: { json: day } });
    expect(await lookup.eventOfItem(signedIn, EWS_ID, never)).toEqual({ ok: true, value: null });
  });
});

describe("a malformed id is refused before anything is asked", () => {
  it.each([
    ["a path that climbs", "../../me/messages"],
    ["a query", "AAMkADJhTaHJ8AAV95f1jAAA?$select=body"],
    ["a whole address", "https://evil.example/AAMkADJhTaHJ8AAV95"],
    ["a space", "AAMkADJh TaHJ8AAV95f1jAAA="],
    ["nothing", ""],
    ["too long", "A".repeat(600)],
  ])("refuses %s", async (_what, id) => {
    const { lookup, sent } = lookupOver({});
    expect(await lookup.eventOfItem(signedIn, id, never)).toEqual({
      ok: false,
      reason: "not_found",
      retryAfterMs: null,
    });
    expect(sent).toHaveLength(0);
  });

  it("a translation that answers no id of Graph's shape is not followed", async () => {
    const { lookup, sent } = lookupOver({
      [TRANSLATE]: { json: { value: [{ sourceId: EWS_ID, targetId: "../../me/messages" }] } },
    });
    expect(await lookup.eventOfItem(signedIn, EWS_ID, never)).toMatchObject({
      ok: false,
      reason: "unreadable",
    });
    expect(sent).toHaveLength(1);
  });
});
