/**
 * The bench's hands on the calendar test accounts: plant the invented events, count them, remove them,
 * record scrubbed answers. LIVE: it dials iCloud and Google. Workstation only; the default suite never
 * runs a `*.live.ts` file.
 *
 *   OHCAL_TEST_ACCOUNTS_FILE=<the accounts file> OHCAL_CAL_BENCH_ENV_FILE=<.cal-bench.env> \
 *     node cal-bench.live.ts <bench|icloud|google> <status|plant|count|remove|prove|record>
 *     node cal-bench.live.ts <bench|icloud> uid-filter   how the server answers a query filtered on one UID
 *     node cal-bench.live.ts google invite          the one invitation, Google to iCloud
 *     node cal-bench.live.ts icloud find-invite     reads iCloud for that invitation, up to ten minutes
 *
 * `status` is a reading and exits 0 whatever it reads. `count` is the same reading JUDGED: it exits 1 with a
 * NOT AS PLANTED line unless the planted set stands whole (the nightly's form). `record` keeps its fixtures
 * all or none. `find-invite` exits 1 when a place could not be read: that is a fault, never "not there".
 *     node cal-bench.live.ts google remove --with-invitation   also removes the invitation (one cancellation)
 *
 * It prints status codes, counts, booleans and names from its own lists. Never a value of the accounts
 * file, an address, an identifier a provider made, a header or a body.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BENCH_CALENDAR, BENCH_EVENTS, BENCH_ID, BENCH_INVITATION, BENCH_INVITE_MARKER, BENCH_KEY, BENCH_KEYS, GOOGLE_PLANTED_KEYS, ZONE, benchResource, benchUid, caldavNotAsPlanted, googleMove, googleNotAsPlanted, toGoogleEvent, toICalendar, type CalDavReading, type GoogleReading } from "./bench-events.ts";
import { CalDavTestClient, readPlacesByUid, uidsOf } from "./caldav-test-client.ts";
import { readCalBenchEnv, readCalendarTestAccounts, Secret, type CalendarTestAccounts } from "./calendar-test-accounts.ts";
import { GoogleTestClient, type GoogleJson } from "./google-test-client.ts";
import { Recorder, Scrubber } from "./recorder.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const say = (line: string) => process.stdout.write(line + "\n");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const privateOf = (e: GoogleJson) => (e.extendedProperties as { private?: Record<string, string> } | undefined)?.private ?? {};
const known = (keys: (string | undefined)[], list: readonly string[]) => list.filter((k) => keys.includes(k)).join(",") || "-";

/** The instant of a wall-clock time in the bench's zone. */
function instant(local: string): number {
  const asUtc = Date.parse(local + "Z");
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: ZONE, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(asUtc));
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  const shown = Date.parse(`${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}Z`);
  return asUtc - (shown - asUtc);
}

// ---------------------------------------------------------------- CalDAV: the bench's server and iCloud

function caldavClient(provider: "bench" | "icloud", accounts: CalendarTestAccounts | undefined, fetchImpl?: typeof fetch) {
  const f = fetchImpl ? (input: string, init?: RequestInit) => fetchImpl(input, init) : undefined;
  if (provider === "icloud") return new CalDavTestClient({ baseUrl: "https://caldav.icloud.com/", user: accounts!.ICLOUD_APPLE_ID, password: accounts!.ICLOUD_APP_PASSWORD, fetch: f });
  const env = readCalBenchEnv(process.env);
  if (!env.OHCAL_CALDAV_BENCH_URL || !env.OHCAL_CALDAV_BENCH_USER || !env.OHCAL_CALDAV_BENCH_PASSWORD) throw new Error("the CalDAV bench is not named: start caldav-bench.sh and name its env file");
  return new CalDavTestClient({ baseUrl: env.OHCAL_CALDAV_BENCH_URL, user: new Secret(env.OHCAL_CALDAV_BENCH_USER), password: new Secret(env.OHCAL_CALDAV_BENCH_PASSWORD), fetch: f });
}

/** The line a judged count ends with, and its exit code. */
function judged(label: string, wrong: string[]): number {
  say(wrong.length === 0 ? `${label}: as planted` : `${label}: NOT AS PLANTED: ${wrong.join("; ")}`);
  return wrong.length === 0 ? 0 : 1;
}

async function caldavCount(c: CalDavTestClient, label: string): Promise<{ calendars: number; bench: boolean; events: number; reading: CalDavReading }> {
  const d = await c.discover();
  const list = await c.collections(d.home);
  const calendars = list.collections.filter((x) => x.isCalendar);
  const bench = calendars.find((x) => new URL(x.href).pathname.endsWith(`/${BENCH_CALENDAR}/`));
  say(`${label}: discover ${d.status} | home list ${list.status} | calendars ${calendars.length} | for events ${calendars.filter((x) => x.components.includes("VEVENT")).length} | bench calendar present ${bench !== undefined}`);
  if (!bench) {
    const gone = await c.request("PROPFIND", new URL(`${BENCH_CALENDAR}/`, d.home).href, { depth: "0", body: '<d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>' });
    say(`${label}: the bench calendar's own address answers ${gone.status}`);
    return { calendars: calendars.length, bench: false, events: 0, reading: { listStatus: list.status, queryStatus: undefined, objects: 0, keys: [], marked: 0 } };
  }
  const q = await c.query(bench.href, { data: true });
  const uids = q.objects.map((o) => uidsOf(o.data ?? "")[0]);
  const keys = uids.flatMap((u) => BENCH_KEYS.filter((k) => u === benchUid(k)));
  const all = q.objects.map((o) => (o.data ?? "").replace(/\r?\n[ \t]/g, ""));
  const marked = all.filter((t) => t.includes(`X-OHMAIL-BENCH:${BENCH_ID}`)).length;
  say(`${label}: calendar-query ${q.status} | objects ${q.objects.length} | keys ${known(keys, BENCH_KEYS)}`);
  say(
    `${label}: marked X-OHMAIL-BENCH ${marked} | with a rule ${all.filter((t) => (t.match(/BEGIN:VEVENT[\s\S]*?END:VEVENT/g) ?? []).some((v) => /^RRULE:/m.test(v))).length} | with a changed day ${all.filter((t) => /^RECURRENCE-ID/m.test(t)).length} | all-day ${all.filter((t) => /^DTSTART;VALUE=DATE:/m.test(t)).length} | call link kept in URL ${all.filter((t) => /^URL(;[^:]*)?:https:\/\/call\.ohmail-bench\.example\//m.test(t)).length} | with a zone definition ${all.filter((t) => t.includes("BEGIN:VTIMEZONE")).length}`,
  );
  return { calendars: calendars.length, bench: true, events: q.objects.length, reading: { listStatus: list.status, queryStatus: q.status, objects: q.objects.length, keys, marked } };
}

async function caldavPlant(c: CalDavTestClient, label: string): Promise<number[]> {
  const d = await c.discover();
  const made = await c.makeCalendar(d.home, BENCH_CALENDAR, BENCH_CALENDAR);
  say(`${label}: MKCALENDAR ${made.status}`);
  if (made.status !== 201) {
    say(`${label}: not planted (the calendar was not made; an existing one answers 405)`);
    return [];
  }
  const statuses: number[] = [];
  for (const e of BENCH_EVENTS) statuses.push((await c.put(new URL(benchResource(e.key), made.href).href, toICalendar(e), { onlyIfNew: true })).status);
  say(`${label}: PUT ${statuses.join(" ")}`);
  return statuses;
}

async function caldavRemove(c: CalDavTestClient, label: string): Promise<void> {
  // Members first, then the calendar: iCloud keeps a deleted calendar's events and hands them back when a
  // calendar is made again at the same address, so deleting the calendar alone removes nothing for good.
  const d = await c.discover();
  const href = new URL(`${BENCH_CALENDAR}/`, d.home).href;
  const members = await c.query(href);
  const statuses: number[] = [];
  if (members.status === 207) for (const m of members.objects) statuses.push((await c.delete(m.href)).status);
  const r = await c.delete(href);
  say(`${label}: DELETE of ${statuses.length} members ${statuses.join(" ") || "-"} | DELETE of the bench calendar ${r.status}`);
}

async function caldavRecord(provider: "bench" | "icloud", accounts: CalendarTestAccounts | undefined): Promise<void> {
  const recorder = new Recorder({ dir: join(HERE, "fixtures", provider), scrubber: new Scrubber({ accounts }) });
  const tap = recorder.tap((input, init) => fetch(input, init));
  const c = caldavClient(provider, accounts, tap.fetch as typeof fetch);
  const d = await c.discover();
  const benchOnly = { response: (x: string) => x.includes(`/${BENCH_CALENDAR}/`) };
  tap.next("caldav", "home-collections", benchOnly);
  const list = await c.collections(d.home);
  const bench = list.collections.find((x) => new URL(x.href).pathname.endsWith(`/${BENCH_CALENDAR}/`));
  if (!bench) return say(`${provider}: nothing to record, the bench calendar is absent`);
  tap.next("caldav", "calendar-query-with-data");
  const whole = await c.query(bench.href, { data: true });
  // The standard's filter on one UID: the bench's server answers it, iCloud refuses it (412) and is
  // recorded as the refusal it is. A server that changes its mind fails the run.
  const filtered = provider === "icloud" ? { name: "calendar-query-one-uid-refused", status: 412 } : { name: "calendar-query-one-uid", status: 207 };
  tap.next("caldav", filtered.name, { status: filtered.status });
  const one = await c.query(bench.href, { uid: benchUid("wheel-class"), data: true });
  tap.next("caldav", "sync-collection-first");
  const first = await c.sync(bench.href, "");
  tap.next("caldav", "get-series-with-changed-day");
  await c.get(new URL(benchResource("wheel-class"), bench.href).href);
  say(`${provider}: recorded ${tap.commit().length} fixtures | the whole report ${whole.status} with ${whole.objects.length} members | filtered on one UID ${one.status} with ${one.objects.length} | first sync report ${first.status} with ${first.objects.length} members, a token ${first.token !== undefined}`);
}

/** How a server answers a calendar-query that filters on one UID, in the three ways the filter can be written. */
async function uidFilter(c: CalDavTestClient, label: string): Promise<void> {
  const d = await c.discover();
  const href = new URL(`${BENCH_CALENDAR}/`, d.home).href;
  const ns = 'xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"';
  const out: string[] = [];
  for (const [name, attribute] of [["i;octet", ' collation="i;octet"'], ["i;ascii-casemap", ' collation="i;ascii-casemap"'], ["no collation named", ""]] as const) {
    const body = `<c:calendar-query ${ns}><d:prop><d:getetag/></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:prop-filter name="UID"><c:text-match${attribute}>${benchUid("wheel-class")}</c:text-match></c:prop-filter></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>`;
    const r = await c.request("REPORT", href, { depth: "1", body });
    out.push(`${name} ${r.status} (${(r.text.match(/\.ics<\//g) ?? []).length} members)`);
  }
  say(`${label}: the UID filter | ${out.join(" | ")}`);
}

/**
 * iCloud's copy of Google's invitation, looked for in every calendar and in the scheduling inbox, by reading
 * each place whole and matching the UID in the text (iCloud refuses a query filtered on UID).
 * Exit 0: observed, or not observed while every place answered. Exit 1: a place could not be read.
 */
async function findInvite(accounts: CalendarTestAccounts): Promise<number> {
  const google = new GoogleTestClient({ accounts, benchId: BENCH_ID });
  const standing = await google.listMarked(await google.writableCalendar(), BENCH_INVITE_MARKER);
  const uid = standing.items[0]?.iCalUID as string | undefined;
  say(`icloud find-invite: Google's standing invitations ${standing.items.length} (list ${standing.status})`);
  if (standing.status !== 200) return 1;
  if (!uid) return 0;
  const recorder = new Recorder({ dir: join(HERE, "fixtures", "icloud"), scrubber: new Scrubber({ accounts }) });
  const tap = recorder.tap((input, init) => fetch(input, init));
  const c = caldavClient("icloud", accounts, tap.fetch as typeof fetch);
  const d = await c.discover();
  const started = Date.now();
  for (let round = 0; Date.now() - started < 10 * 60_000; round++) {
    const list = await c.collections(d.home);
    const places = [...list.collections.filter((x) => x.isCalendar).map((x) => ({ where: "a calendar", href: x.href })), ...(d.scheduleInbox ? [{ where: "the scheduling inbox", href: d.scheduleInbox }] : [])];
    const read = await readPlacesByUid(c, places, uid);
    const answers = [...new Set(read.readings.map((r) => r.status))].map((s) => `${s} x${read.readings.filter((r) => r.status === s).length}`).join(", ");
    if (round === 0 || read.found || read.faults.length > 0 || list.status !== 207) say(`icloud find-invite: round ${round + 1} | home list ${list.status} | places read ${places.length}, the scheduling inbox among them ${d.scheduleInbox !== undefined} | answers ${answers || "-"}`);
    const faults = read.faults.length + (list.status === 207 ? 0 : 1);
    if (read.found) {
      const t = (read.found.object!.data ?? "").replace(/\r?\n[ \t]/g, "");
      const partstat = /^ATTENDEE[^:]*PARTSTAT=([A-Z-]+)/m.exec(t)?.[1];
      say(`icloud find-invite: observed true | in ${read.found.where} | after ${Math.round((Date.now() - started) / 1000)} s | attendee lines ${(t.match(/^ATTENDEE/gm) ?? []).length} | has an organizer ${/^ORGANIZER/m.test(t)} | answer state ${["NEEDS-ACTION", "ACCEPTED", "DECLINED", "TENTATIVE"].includes(partstat ?? "") ? partstat : "-"} | has Google's own link ${/google\.com/.test(t)}`);
      // The place is read once more for the fixture, and only the invitation's own response is kept.
      tap.next("caldav", "invitation-from-google", { response: (x) => uidsOf(x.replace(/&#13;/g, "\r")).includes(uid) });
      await c.query(read.found.href, { data: true });
      say(`icloud find-invite: recorded ${tap.commit().length}`);
      if (faults > 0) say(`icloud find-invite: FAULT: ${faults} of the other places could not be read`);
      return faults > 0 ? 1 : 0;
    }
    if (faults > 0) {
      say(`icloud find-invite: FAULT: ${faults} places could not be read. This is NO reading of whether the invitation arrived.`);
      return 1;
    }
    if (round === 0) say("icloud find-invite: not there at once; reading every 30 s");
    await sleep(30_000);
  }
  say("icloud find-invite: observed false | not observed in ten minutes, and every place answered 207 every time (a reading, not a fault)");
  return 0;
}

// ---------------------------------------------------------------- Google

const GOOGLE_KEYS = [...GOOGLE_PLANTED_KEYS, BENCH_INVITATION.key];

async function googleCount(g: GoogleTestClient, calendar: string): Promise<{ total: number; lists: number; reading: GoogleReading }> {
  const lists = await g.calendarList();
  const marked = await g.listMarked(calendar);
  const items = marked.items;
  const invitations = items.filter((e) => privateOf(e)[BENCH_INVITE_MARKER] !== undefined);
  say(`google: calendar list ${lists.status} | calendars ${lists.items.length} | marked list ${marked.status} | events ${items.length} | keys ${known(items.map((e) => privateOf(e)[BENCH_KEY]), GOOGLE_KEYS)}`);
  say(
    `google: with a rule ${items.filter((e) => Array.isArray(e.recurrence)).length} | changed days ${items.filter((e) => e.recurringEventId !== undefined).length} | all-day ${items.filter((e) => (e.start as { date?: string } | undefined)?.date !== undefined).length} | with a Meet link ${items.filter((e) => typeof e.hangoutLink === "string").length} | invitations ${invitations.length} | their invitees ${invitations.map((e) => (e.attendees as unknown[] | undefined)?.length ?? 0).join(",") || "-"} | invitee answers ${invitations.flatMap((e) => ((e.attendees as { responseStatus?: string }[] | undefined) ?? []).map((a) => (["needsAction", "accepted", "declined", "tentative"].includes(a.responseStatus ?? "") ? a.responseStatus : "-"))).join(",") || "-"}`,
  );
  return { total: items.length, lists: lists.items.length, reading: { listStatus: marked.status, keys: items.map((e) => privateOf(e)[BENCH_KEY]), invitees: invitations.map((e) => (e.attendees as unknown[] | undefined)?.length ?? 0) } };
}

async function googlePlant(g: GoogleTestClient, calendar: string): Promise<void> {
  const before = await g.listMarked(calendar);
  const others = before.items.filter((e) => privateOf(e)[BENCH_INVITE_MARKER] === undefined);
  if (before.status !== 200 || others.length > 0) return say(`google: not planted (the marked list answered ${before.status} with ${others.length} bench events already there)`);
  const statuses: number[] = [];
  for (const e of BENCH_EVENTS) {
    const body = toGoogleEvent(e);
    const r = await g.insertEvent(calendar, body, { sendUpdates: "none", conference: body.conferenceData !== undefined });
    statuses.push(r.status);
    const move = googleMove(e);
    if (r.status === 200 && move) {
      const days = await g.instances(calendar, r.json.id as string);
      const day = days.items.find((i) => Date.parse((i.originalStartTime as { dateTime: string }).dateTime) === instant(move.was));
      const moved = day ? (await g.patchEvent(calendar, day.id as string, move.patch, { sendUpdates: "none" })).status : 0;
      say(`google: the series' days ${days.items.length} | the day to move found ${day !== undefined} | moved ${moved}`);
    }
    if (r.status === 200 && body.conferenceData) {
      let code = "";
      for (let i = 0; i < 10 && code !== "success" && code !== "failure"; i++) {
        if (i > 0) await sleep(2000);
        const got = await g.getEvent(calendar, r.json.id as string);
        code = ((got.json.conferenceData as { createRequest?: { status?: { statusCode?: string } } } | undefined)?.createRequest?.status?.statusCode ?? "") as string;
      }
      say(`google: the Meet request ended ${["success", "failure", "pending"].includes(code) ? code : "unknown"}`);
    }
  }
  say(`google: insert ${statuses.join(" ")}`);
}

async function googleRecord(accounts: CalendarTestAccounts): Promise<void> {
  const recorder = new Recorder({ dir: join(HERE, "fixtures", "google"), scrubber: new Scrubber({ accounts }) });
  const tap = recorder.tap((input, init) => fetch(input, init));
  const g = new GoogleTestClient({ accounts, benchId: BENCH_ID, fetch: tap.fetch });
  await g.signIn();
  tap.next("google", "calendar-list-writable", { item: (c) => c.accessRole === "owner" || c.accessRole === "writer" });
  const calendar = await g.writableCalendar();
  tap.next("google", "events-list-marked");
  const marked = await g.listMarked(calendar);
  const series = marked.items.find((e) => privateOf(e)[BENCH_KEY] === "wheel-class");
  const call = marked.items.find((e) => privateOf(e)[BENCH_KEY] === "stall-planning-call");
  if (series) {
    tap.next("google", "events-instances-series");
    await g.instances(calendar, series.id as string);
  }
  if (call) {
    tap.next("google", "event-get-with-meet");
    await g.getEvent(calendar, call.id as string);
  }
  say(`google: recorded ${tap.commit().length} fixtures from ${marked.items.length} marked events`);
}

// ---------------------------------------------------------------- the verbs

async function main(): Promise<number> {
  const [provider, verb, flag] = process.argv.slice(2);
  if (provider === "bench" || provider === "icloud") {
    const accounts = provider === "icloud" ? readCalendarTestAccounts(process.env) : undefined;
    if (verb === "record") return (await caldavRecord(provider, accounts), 0);
    if (verb === "find-invite" && provider === "icloud") return findInvite(accounts!);
    const c = caldavClient(provider, accounts);
    if (verb === "uid-filter") return (await uidFilter(c, provider), 0);
    if (verb === "status") return (await caldavCount(c, provider), 0);
    if (verb === "count") return judged(provider, caldavNotAsPlanted((await caldavCount(c, provider)).reading));
    if (verb === "plant") return (await caldavPlant(c, provider), await caldavCount(c, provider), 0);
    if (verb === "remove") return (await caldavRemove(c, provider), await caldavCount(c, provider), 0);
    if (verb === "prove") {
      const before = await caldavCount(c, provider);
      if (before.bench) return (say(`${provider}: NOT PROVEN, the bench calendar stands already; remove it first`), 1);
      const puts = await caldavPlant(c, provider);
      const planted = await caldavCount(c, provider);
      await caldavRemove(c, provider);
      const after = await caldavCount(c, provider);
      const ok = puts.length === BENCH_EVENTS.length && puts.every((p) => p === 201) && planted.bench && planted.events === BENCH_EVENTS.length && planted.calendars === before.calendars + 1 && !after.bench && after.calendars === before.calendars;
      say(`${provider}: plant, count ${planted.events} of ${BENCH_EVENTS.length}, remove, count ${after.events}; calendars ${before.calendars} -> ${planted.calendars} -> ${after.calendars}: ${ok ? "PROVEN" : "NOT PROVEN"}`);
      return ok ? 0 : 1;
    }
  }
  if (provider === "google") {
    const accounts = readCalendarTestAccounts(process.env);
    if (verb === "record") return (await googleRecord(accounts), 0);
    const g = new GoogleTestClient({ accounts, benchId: BENCH_ID });
    say(`google: sign-in ${await g.signIn()}`);
    const calendar = await g.writableCalendar();
    if (verb === "status") return (await googleCount(g, calendar), 0);
    if (verb === "count") return judged("google", googleNotAsPlanted((await googleCount(g, calendar)).reading));
    if (verb === "plant") return (await googlePlant(g, calendar), await googleCount(g, calendar), 0);
    if (verb === "remove") {
      const r = await g.removeMarked(calendar, { withInvitation: flag === "--with-invitation" });
      say(`google: removed ${r.removed} | kept ${r.kept} | delete ${r.statuses.join(" ") || "-"}`);
      return (await googleCount(g, calendar), 0);
    }
    if (verb === "prove") {
      const before = await googleCount(g, calendar);
      if (before.total > 0) return (say("google: NOT PROVEN, marked events stand already; remove them first"), 1);
      await googlePlant(g, calendar);
      const planted = await googleCount(g, calendar);
      const r = await g.removeMarked(calendar, { withInvitation: false });
      say(`google: removed ${r.removed} | delete ${r.statuses.join(" ")}`);
      const after = await googleCount(g, calendar);
      const want = BENCH_EVENTS.length + 1; // the changed day is a record of its own at Google
      const ok = planted.total === want && after.total === 0 && after.lists === before.lists;
      say(`google: plant, count ${planted.total} of ${want}, remove, count ${after.total}; calendar list ${before.lists} -> ${after.lists}: ${ok ? "PROVEN" : "NOT PROVEN"}`);
      return ok ? 0 : 1;
    }
    if (verb === "invite") {
      const r = await g.inviteOnce(calendar, toGoogleEvent(BENCH_INVITATION));
      say(`google: the invitation planted ${r.planted} | insert ${r.status} | ${r.planted ? `invitees ${(r.json.attendees as unknown[] | undefined)?.length ?? 0}` : `why not: ${r.why}`}`);
      return (await googleCount(g, calendar), r.planted ? 0 : 1);
    }
  }
  say("usage: cal-bench.live.ts <bench|icloud|google> <status|plant|count|remove|prove|record> | <bench|icloud> uid-filter | google invite | icloud find-invite");
  return 64;
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    // A system error's message can quote what it was parsing; only our own messages are shown.
    const own = e instanceof Error && !(e instanceof SyntaxError) && !(e instanceof TypeError);
    say(`stopped: ${e instanceof Error ? e.constructor.name : "error"}${own ? `: ${(e as Error).message}` : ""}`);
    process.exit(1);
  },
);
