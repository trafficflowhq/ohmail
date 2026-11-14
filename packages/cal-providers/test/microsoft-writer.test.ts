/**
 * Microsoft's calendar, written, against the bench's double of Graph (Microsoft's pages, call by
 * call; blind where the pages are). Built, tried against the double, not proven at Microsoft itself.
 */
import { intlZones, parseRRule, wall, zoned, floating } from "@ohmail/cal-core";
import type { HostResolver } from "@trafficflow/core/net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeReader, makeWriter, microsoftHosts } from "../src/microsoft/index.js";
import type { CalendarReader, CalendarWriter, Connection, EventDraft, WriteAnswer } from "../src/port.js";
import { fixedHostRequest, type HttpPort } from "../src/request/index.js";
import { Secret } from "./support/calendar-test-accounts.ts";
import { MsDoubleClient } from "./support/ms-double-client.ts";
// @ts-expect-error a plain module
import { startMsDouble } from "./support/ms-double.mjs";

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
      [{ rule: parseRRule("FREQ=WEEKLY")! }, "repeat_unsupported"],
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
});
