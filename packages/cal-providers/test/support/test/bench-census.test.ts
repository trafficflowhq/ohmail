import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { describe, it } from "vitest";
import { fileURLToPath } from "node:url";
import { BENCH_EVENTS, BENCH_INVITATION, BENCH_KEYS, GOOGLE_PLANTED_KEYS, caldavNotAsPlanted, googleNotAsPlanted, toGoogleEvent, toICalendar } from "../bench-events.ts";
import { davResponses } from "../caldav-test-client.ts";
import { assertClean } from "../recorder.ts";

/**
 * FICTIONAL CONTENT ONLY, AND NO LIVE FILE IN THE DEFAULT RUN.
 *
 * Every fixture, the Microsoft double's seed and the bench's own events are read: every address is on a
 * reserved domain (RFC 2606 / 6761, the rule of the repository's demo-domain census) and every person is
 * one of the fixtures' invented people. When this lands, INVENTED_PEOPLE becomes the registry's own list
 * (`fictionalNames` of the fixtures package, verdict `invented-person`).
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const INVENTED_PEOPLE = new Set(["Mila Brunner", "Giulia Ferrari", "Petra Wyss", "Ben Arnold", "Anna Odermatt", "Reto Frei", "Flurina Caduff", "Tim Berger", "Carla Meier", "Lena Kaufmann"]);
const RESERVED_TLD = new Set(["example", "invalid", "test", "localhost"]);
const RESERVED_DOMAIN = /(^|\.)example\.(com|net|org)$/;

function files(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) files(full, out);
    else out.push(full);
  }
  return out;
}
function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) strings(v, out);
  else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) (out.push(k), strings(v, out));
  return out;
}
/** What is wrong with a text's addresses: the offending domains' count, never the addresses. */
function foreignAddresses(text: string): number {
  let n = 0;
  for (const m of text.matchAll(/[A-Za-z0-9._%+-]+@((?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,})/g)) {
    const domain = m[1]!.toLowerCase();
    if (!RESERVED_TLD.has(domain.slice(domain.lastIndexOf(".") + 1)) && !RESERVED_DOMAIN.test(domain)) n++;
  }
  return n;
}
function people(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) for (const v of value) people(v, out);
  else if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    if (typeof o.name === "string" && typeof o.address === "string") out.push(o.name);
    if (typeof o.displayName === "string" && typeof o.email === "string") out.push(o.displayName);
    for (const v of Object.values(o)) people(v, out);
  }
  return out;
}

const fixtures = files(join(ROOT, "fixtures")).filter((f) => f.endsWith(".json"));
const seed = JSON.parse(readFileSync(join(ROOT, "ms-seed.json"), "utf8")) as unknown;

describe("the bench's content is invented", () => {
  it("has fixtures to read from each of the three places", () => {
    for (const place of ["bench", "icloud", "google"]) assert.ok(fixtures.some((f) => relative(ROOT, f).startsWith(join("fixtures", place))), place);
  });
  it("carries no address outside the reserved domains, in any fixture, the seed or the events", () => {
    const texts: [string, string][] = [...fixtures.map((f): [string, string] => [relative(ROOT, f), strings(JSON.parse(readFileSync(f, "utf8"))).join("\n")]), ["ms-seed.json", strings(seed).join("\n")], ["bench-events", [...BENCH_EVENTS, BENCH_INVITATION].map((e) => toICalendar(e) + JSON.stringify(toGoogleEvent(e))).join("\n")]];
    assert.deepEqual(texts.filter(([, t]) => foreignAddresses(t) > 0).map(([name]) => name), []);
  });
  it("names only the fixtures' invented people", () => {
    const named = [...people(seed), ...fixtures.flatMap((f) => people(JSON.parse(readFileSync(f, "utf8"))))];
    assert.ok(named.length >= 4);
    assert.deepEqual(named.filter((n) => !INVENTED_PEOPLE.has(n)), []);
  });
  it("keeps every fixture inside what the recorder itself would have refused", () => {
    for (const f of fixtures) assert.doesNotThrow(() => assertClean(readFileSync(f, "utf8")), relative(ROOT, f));
  });
  it("is a check that bites: one planted real-shaped address, one person outside the registry", () => {
    const planted = JSON.parse(JSON.stringify(seed)) as { events: { organizer?: { emailAddress: { name: string; address: string } } }[] };
    planted.events.push({ organizer: { emailAddress: { name: "Somebody Real", address: ["somebody", ["pottery-studio", "ch"].join(".")].join("@") } } });
    assert.equal(foreignAddresses(strings(planted).join("\n")), 1);
    assert.deepEqual(people(planted).filter((n) => !INVENTED_PEOPLE.has(n)), ["Somebody Real"]);
  });
});

describe("a recorded report holds what the server sent", () => {
  // The members each recorded report must hold. A recording that lost one, or took markup for an event's
  // text, is a fixture that teaches the adapter a wrong answer.
  const MEMBERS: Record<string, number> = { "calendar-query-with-data": BENCH_EVENTS.length, "calendar-query-one-uid": 1, "sync-collection-first": BENCH_EVENTS.length };
  const reports = fixtures.map((f) => ({ name: relative(ROOT, f), fixture: JSON.parse(readFileSync(f, "utf8")) as { provider: string; name: string; response: { status: number; body: unknown } } })).filter((r) => r.fixture.provider === "caldav" && r.fixture.name in MEMBERS);
  const members = (body: string) => davResponses(body).filter((x) => /\.ics\s*<\//.test(x));

  it("has the reports of both CalDAV servers", () => {
    assert.ok(reports.length >= 5, String(reports.length));
  });
  it("counts the planted members in each, every one answered 207", () => {
    assert.deepEqual(reports.map((r) => [r.name, r.fixture.response.status, members(String(r.fixture.response.body)).length]), reports.map((r) => [r.name, 207, MEMBERS[r.fixture.name]]));
  });
  it("holds an event's text as text, one whole calendar object per member, and no tag a server made", () => {
    for (const r of reports) {
      const body = String(r.fixture.response.body);
      const texts = [...body.matchAll(/<(?:[\w-]+:)?calendar-data(?![\w-])[^>]*(?<!\/)>([\s\S]*?)<\/(?:[\w-]+:)?calendar-data>/g)].map((m) => m[1]!);
      assert.deepEqual(texts.filter((t) => !/^(?:<!\[CDATA\[)?BEGIN:VCALENDAR[\s\S]*END:VCALENDAR\s*(?:&#13;\s*)?(?:\]\]>)?$/.test(t.trim()) || /&lt;[\w/]/.test(t)).length, 0, r.name);
      if (r.fixture.name === "calendar-query-with-data") assert.equal(texts.length, BENCH_EVENTS.length, r.name);
      assert.deepEqual([...body.matchAll(/<(?:[\w-]+:)?getetag(?![\w-])[^>]*(?<!\/)>([^<]*)</g)].map((m) => m[1]!).filter((t) => !/^&quot;etag-\d+&quot;$/.test(t)), [], r.name);
    }
  });
});

describe("the planted set, judged (what the nightly's count steps exit on)", () => {
  const caldav = { listStatus: 207, queryStatus: 207, objects: 5, keys: BENCH_KEYS, marked: 5 };
  const google = { listStatus: 200, keys: GOOGLE_PLANTED_KEYS, invitees: [] as number[] };

  it("passes a CalDAV server that holds the five, and names what is wrong otherwise", () => {
    assert.deepEqual(caldavNotAsPlanted(caldav), []);
    assert.deepEqual(caldavNotAsPlanted({ ...caldav, queryStatus: undefined, objects: 0, keys: [], marked: 0 }), ["the bench's calendar is absent"]);
    assert.deepEqual(caldavNotAsPlanted({ ...caldav, listStatus: 503 }), ["the home's list answered 503"]);
    assert.deepEqual(caldavNotAsPlanted({ ...caldav, queryStatus: 412 }), ["the calendar's report answered 412"]);
    assert.deepEqual(caldavNotAsPlanted({ ...caldav, objects: 0, keys: [], marked: 0 }).slice(0, 2), ["0 objects, planted 5", "glaze-firing is missing"]);
    assert.deepEqual(caldavNotAsPlanted({ ...caldav, objects: 4, keys: BENCH_KEYS.slice(1), marked: 4 }), ["4 objects, planted 5", "glaze-firing is missing"]);
    assert.deepEqual(caldavNotAsPlanted({ ...caldav, keys: [...BENCH_KEYS.slice(1), "market-day"] }), ["glaze-firing is missing", "market-day is there more than once"]);
    assert.deepEqual(caldavNotAsPlanted({ ...caldav, marked: 3 }), ["3 of 5 carry the bench's mark"]);
  });

  it("passes Google in two states only: the six records, or the six and the one invitation with one invitee", () => {
    const invited = { ...google, keys: [...GOOGLE_PLANTED_KEYS, BENCH_INVITATION.key], invitees: [1] };
    assert.deepEqual([googleNotAsPlanted(google), googleNotAsPlanted(invited)], [[], []]);
    assert.deepEqual(googleNotAsPlanted({ ...google, listStatus: 401 }), ["the marked list answered 401"]);
    assert.deepEqual(googleNotAsPlanted({ ...google, keys: [] }).slice(0, 2), ["0 records, planted 6", "glaze-firing is missing"]);
    assert.deepEqual(googleNotAsPlanted({ ...google, keys: GOOGLE_PLANTED_KEYS.slice(0, 3) }), ["3 records, planted 6", "market-day is missing", "stall-planning-call is missing", "wheel-class-moved is missing"]);
    assert.deepEqual(googleNotAsPlanted({ ...google, keys: [...GOOGLE_PLANTED_KEYS.slice(0, 5), undefined] }), ["wheel-class-moved is missing"]);
    assert.deepEqual(googleNotAsPlanted({ ...invited, invitees: [2] }), ["an invitation with 2 invitees, planted with 1"]);
    assert.deepEqual(googleNotAsPlanted({ ...invited, invitees: [1, 1], keys: [...invited.keys, BENCH_INVITATION.key] }), ["8 records, planted 7", "kiln-handover is there more than once", "2 records carry the invitation's mark, planted 1"]);
    assert.deepEqual(googleNotAsPlanted({ ...invited, invitees: [] }), ["0 records carry the invitation's mark, planted 1"]);
  });
});

describe("what dials a provider is named for it", () => {
  // The repository's default include is `**/*.test.{ts,tsx}`; a file that reaches a provider is `*.live.ts`.
  const defaultRun = (f: string) => /\.test\.tsx?$/.test(f);
  const all = files(ROOT).map((f) => relative(ROOT, f)).filter((f) => !f.startsWith("radicale"));
  it("has live files, and none of them is in the default run", () => {
    const live = all.filter((f) => f.endsWith(".live.ts"));
    assert.ok(live.includes("cal-bench.live.ts"));
    assert.deepEqual(live.filter(defaultRun), []);
  });
});
