/**
 * THE WALK: EVERY ORDER OF WHAT CAN HAPPEN AROUND A PRESS ON A DAY OF A SERIES AND THE DAYS AFTER IT.
 *
 * Three rechecks in a row found new orders of the same few events by hand. A list of orders is never
 * whole, so this file tries every order of them to a stated depth, and random longer ones from a
 * seed: on a real Postgres, through the services' door, the worker's queue and its drain in whole
 * turns, the real CalDAV writer, and the CalDAV stand-in on this machine. Nothing leaves this machine;
 * every address is on a reserved domain.
 *
 * THE MEMBER: ten Mondays from 23 November 2026 (`COUNT=10`), once at 09:00 in Zurich and once as
 * whole days (another program ends a series of whole days the day before, which every program writes).
 *
 * THE ALPHABET: each letter is one thing a person, a device, the network, the worker, time or another
 * program can cause (`LETTERS` below says each in a sentence).
 *   a person, a device   `press`             the days from 14 December on get a new title (a series of their own); pressed again, a new press
 *                        `press-2nd-device`  the same day pressed on another device, which still holds the copy the first press was made on
 *                        `press-other-day`   the days from 21 December on get a new title
 *                        `cancel-day`        28 December cancelled
 *                        `cancel-no-day`     15 December cancelled, a day the series does not have
 *                        `let-go`            the days from 14 December on let go
 *                        `delete-series`     the whole series deleted (the days its record shows)
 *                        `repeat-series`     a new repeat for the whole series: weekly on Mondays ten times, the days it has
 *                                            (pressed only on a copy that still runs to its last day)
 *                        `retitle-series`    a new title for the whole series (no day is named)
 *                        `retitle-day`       a new title for 21 December alone (no day is named: the day stays where it is)
 *                        `retry:<key>`       the retry of a write shown as refused (a press's first part, its second, any other)
 *                        `dismiss:<key>`     the letting go of a write: one shown as refused, or one not yet tried
 *   the network, the     `turn`              a drain turn in which every request is answered
 *   provider, the worker `turn-lost`         the turn's next request lands and its answer is lost
 *                        `turn-down`         it never lands and is not answered
 *                        `turn-refused`      the provider refuses it with a content word (403)
 *                        `turn-later`        the provider refuses it with a word that waits for time (503)
 *                        `turn-signin`       the provider refuses it and asks for the person (401)
 *                        `turn-stop`       it lands, and the worker stops before the answer is settled
 *                        `turn-overdue`      it lands, and the turn's own time runs out
 *                        `turn-done-500`     the provider carries the turn's next write out and answers 500
 *                        `turn2-lost`        the turn's SECOND call of the writer (a press's second part in the turn its first
 *                                            part is carried out, or the next write) lands and its answer is lost
 *                        `turn2-refused`     the provider refuses that second call with a content word (403)
 *                        `turn2-later`       the provider refuses that second call with a word that waits for time (503)
 *                        `outage`            turn after turn it never lands, until the write's attempts are spent and it is refused
 *   time                 `72h`               73 hours pass (the queue's age)
 *                        `7d`                eight days pass (the days an applied row is kept)
 *   another program      `theirs`            it ends the series at 14 December and makes the rest a series of its own
 * A letter is offered only where it can happen (`applies`): a turn's fault needs a write that is owed, a retry a
 * write shown as refused, and so on. An order whose last letter changed nothing (the door refused the press, a
 * turn found nothing to do, a fault found no request to hit) is counted and not walked further: what follows it
 * follows the order before it.
 *
 * THE PERSON'S INTENT, by day: the days the series had before the first press, less every day a press the door
 * took asked to remove (one day cancelled, the days from a day on let go, the whole series deleted), unless that
 * press was refused for the copy it was made on (`version_stale`: the door takes no retry of it, "made again as a
 * new act") or was let go before anything of it showed in the series' record; and less the days the person gave
 * up by letting go of the write whose own request ended them at the provider (THE FIRST DECIDED EXCEPTION, below).
 * The whole series deleted names the days its record showed when it was pressed, less the days a press on a day
 * and the days after it, pressed before it and standing, gave a series of their own: those are that new series'
 * days, on its own record, and the person did not delete that one. Which presses stand is read when the intent is
 * read: a press let go since, or refused for its copy, gave its days no series, and they are the deleted series'.
 *
 * THE TWO SENTENCES, asserted after every step of every order by reading what the stand-in holds:
 *   I1  NO DAY TWICE. No day stands twice, in one member or in two (but as THE SECOND DECIDED EXCEPTION, below,
 *       has it); the server holds no day the series did not have; it holds no day whose removal is done (an applied
 *       cancel, an applied letting go): the days there are never more than the person's intent names; and a day the
 *       person gave up stands there only where a press that stands names it.
 *   I2  NEVER STUCK. From every state reached there is ONE press the door accepts (the retry of a write shown as
 *       refused, the same press again under its key, or the same press pressed afresh on the copy the store holds)
 *       after which, with every further request answered, the server holds every day of the person's intent. The
 *       walk proves it by doing it, and tries EVERY such press, each on the state as the order left it (the order
 *       walked again from the start for each; the walk checks that walking an order again reaches the same state):
 *       after none of them may the first sentence break. The sentence is read AT THE STATE ITSELF: where no one press
 *       brought the days, it is broken. To tell what kind of break it is, where something was owed the walk then
 *       answers what is owed and tries the presses of the state at rest (a write shown as owed has no retry yet): a
 *       state repaired only so is told as `I2 stuck for a turn` (broken, and walked further: the press after the turn
 *       repairs it); one repaired by nothing is told as `I2 never stuck` and is not walked further. Every order to
 *       the stated depth is walked, so every state on the way is some order's end; of a longer random order every
 *       step past that depth is proved the same way.
 *       ONE PRESS EACH, where more than one press is half carried out. Where no one press brought the days and more
 *       than one press on a day and the days after it stands with a write of its own shown as refused whose retry
 *       the door takes (two presses half carried out at once: each has its own repair, its retry, and neither's
 *       retry makes the other's days), the sentence asks one press EACH: the retry of each such press's refused
 *       write, in every order. After each of them, with every further request answered, the server holds every day
 *       of the intent but days that the presses not yet tried again name; after the last of them it holds every
 *       day; and the first sentence holds after each. It counts presses, not writes: one press that needs two
 *       retries is broken as before, and so is a state where one of these retries is refused, leaves a day missing
 *       that no press still to be tried again names, or makes a day twice.
 * THE FIRST DECIDED EXCEPTION (the third recheck, "Decided"; the direction ruling's half-done state; read as the
 * fourth recheck rules it): days are given up only by the letting go of the write whose own request changed the
 * series (a press's first part or the letting go of those days, its end at the server; a day's cancel whose line
 * stands there: the bench wraps the writer and knows whose request it was), or of a press's second part once its
 * first is done (its first part's own row reads done); any other write let go gives up nothing. What such a letting go gives up is every day that write
 * names which the provider's own records no longer show, whether or not another removal of the person's names the
 * day too: what becomes of that other removal later (done, refused for its copy, let go) gives the day back to
 * nobody. The walk asserts exactly that: from then on the intent does not name those days, and the door refuses
 * that day pressed afresh (400).
 * THE SECOND DECIDED EXCEPTION (the fourth recheck, "Decided: it stays"): another program's end at that very
 * day is taken for a press's own after an unheard attempt. The walk asserts it exactly: every doubled day stands
 * once in the other program's member and once in the new series of a press that had an attempt end unheard, with a
 * word that waits for time, or cut, before it found the end (the bench sees each call of the writer and its
 * answer). Anything else twice is a finding. Nothing else is excepted.
 *
 * ITS DEPTH. By default (the ordinary test run): `SMALL` below: every order of the whole alphabet to its `depth`,
 * on from there the orders made of the same-day letters alone (the letters the three rechecks' findings were made
 * of: `family`) to its `family`, every order of the whole days' letters to its `days`, and `orders` random longer
 * ones, each letter picked from the seed among what can happen, by its weight. With `OHCAL_WALK=full` (the lane's
 * own flag, for the batch runs): `FULL`. `OHCAL_WALK_SLICE=k/n` walks the k-th of n shares, so that several
 * processes walk it at once (each prints its own count; an order shorter than three letters is counted by the
 * first share); `OHCAL_WALK_SEED` sets the random orders' seed (printed with every run), `OHCAL_WALK_DEPTH`,
 * `OHCAL_WALK_FAMILY`, `OHCAL_WALK_DAYS` and `OHCAL_WALK_ORDERS` each bound, `OHCAL_WALK_ORDER` walks one order
 * (letters by comma, `clock:` or `days:` before them) and prints it, `OHCAL_WALK_EVID` names a folder for what was
 * found, whole. What breaks a sentence is printed by the way it broke: of each way the shortest order whole, with
 * the queue's rows, what the server holds and the writing requests it received after each letter.
 *
 * WHAT IT DOES NOT COVER: Google's and Microsoft's writers and any real server; invitees; a press on the new
 * series a press made; a new time, or a new repeat that names other days than the series has (its presses name a
 * title or a place, and its one new repeat the days the series has, so that the days stay the days); a new repeat
 * pressed on a copy a write has already ended (it asks for days a second series may have, by the person's own
 * word: the walk's book holds each day once and cannot tell that from a day doubled; a case of the door-to-stand-in
 * file holds it); other writes of another program than the one above, and that one into a press half carried out
 * or beside a removal still owed; two workers draining at once; more than three presses in one order. The lane's
 * notes hold every act the door takes against these letters, one by one (`ALPHABET.md`).
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DEFAULT_LIMITS, expandSeries, fold, intlZones, momentOrUtc, readCalendar, seriesOf, vtimezoneFrom, writeComponent, zonesOf,
} from "@ohmail/cal-core";
import { BENCH_CALDAV_PLACE, PROVEN_REPEATS, makeCalendarProviders, proofPlaceOf, type CalendarProvider, type CalendarWriter } from "@ohmail/cal-providers";
import type { HostResolver } from "@trafficflow/core/net";
import { calCalendars, calConnections, calEvents, calWrites } from "@trafficflow/db";
import { ServiceError, type ServiceContext } from "@trafficflow/services";
import { dismissCalendarWrite, recordCalendarWrite, retryCalendarWrite } from "@trafficflow/services/calendar";
import { calendarSyncPass } from "../packages/organizer/src/calendar/sync-pass.js";
import { CalendarTurnOverdue, WORD_PLAN } from "../packages/organizer/src/calendar/words.js";
import { calendarWriteDrain } from "../packages/organizer/src/calendar/write-drain.js";
import { AVAILABLE, Secret, and, asc, capturedLog, depsFor, eq, openWorld, providersOf, seedConnection, sql, type World } from "../packages/organizer/test/_calendar-world.js";
import { startCalDavStandIn } from "../packages/cal-providers/test/caldav-stand-in.js";

// ── the bounds ───────────────────────────────────────────────────────────────────

/**
 * The ordinary run's walk, and the full one behind the lane's flag (`OHCAL_WALK=full`). The ordinary one is the depth that
 * stays under 90 seconds in one process beside other work, sixteen orders at once (`AT_ONCE`): the same-day letters one level
 * deeper took 84 to 111 seconds there before the fourth recheck's letters were added.
 */
const SMALL = { depth: 2, family: 3, days: 3, orders: 64, longest: 6 };
const FULL = { depth: 3, family: 5, days: 3, orders: 2000, longest: 8 };
const ENV = process.env;
const BOUNDS = ENV.OHCAL_WALK === "full" ? FULL : SMALL;
const numberOf = (text: string | undefined, or: number): number => (text !== undefined && /^\d{1,9}$/.test(text) ? Number(text) : or);
const DEPTH = numberOf(ENV.OHCAL_WALK_DEPTH, BOUNDS.depth);
const FAMILY_DEPTH = numberOf(ENV.OHCAL_WALK_FAMILY, BOUNDS.family);
const DAYS_DEPTH = numberOf(ENV.OHCAL_WALK_DAYS, BOUNDS.days);
const ORDERS = numberOf(ENV.OHCAL_WALK_ORDERS, BOUNDS.orders);
const SEED = numberOf(ENV.OHCAL_WALK_SEED, 20261116);
const SLICE = /^(\d{1,3})\/(\d{1,3})$/.exec(ENV.OHCAL_WALK_SLICE ?? "");
const SHARE = SLICE === null ? { k: 0, n: 1 } : { k: Number(SLICE[1]) - 1, n: Number(SLICE[2]) };
/**
 * Orders walked at once in this process: each has its own account and its own stand-in. The ordinary run walks sixteen at once
 * in its one process (it stays under 90 seconds so); the full one eight in each of its shares, which run side by side.
 */
const AT_ONCE = numberOf(ENV.OHCAL_WALK_AT_ONCE, ENV.OHCAL_WALK === "full" ? 8 : 16);
/** The most presses one order holds: a person presses a few times, not for ever. */
const MOST_PRESSES = 3;

// ── the member ───────────────────────────────────────────────────────────────────

const ZONES = intlZones();
const NOBODY: HostResolver = { resolve: async () => [] };
const ZH = "Europe/Zurich";
const MILA = "mila@studio.example.test";

function zoneLines(tz: string): string[] {
  const made = vtimezoneFrom(tz, ZONES, { startMs: Date.UTC(2026, 9, 1), endMs: Date.UTC(2028, 0, 1) });
  const text = made === null ? null : writeComponent(made);
  if (text === null || !text.ok) throw new Error(`the zone ${tz} did not write`);
  return text.text.trimEnd().split("\r\n");
}

/** A weekly series on Mondays as another program wrote it: at 09:00 in Zurich, or as whole days. */
function mondays(o: { readonly uid: string; readonly clock: boolean; readonly from: string; readonly rule: string; readonly summary: string; readonly excluded?: readonly string[] }): string {
  const t = (name: string, day: string, time: string): string => (o.clock ? `${name};TZID=${ZH}:${day}T${time}` : `${name};VALUE=DATE:${day}`);
  const next = (day: string): string => new Date(Date.UTC(+day.slice(0, 4), +day.slice(4, 6) - 1, +day.slice(6, 8) + 1)).toISOString().slice(0, 10).replaceAll("-", "");
  return [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//elsewhere//calendar//EN", ...(o.clock ? zoneLines(ZH) : []),
    "BEGIN:VEVENT", `UID:${o.uid}@studio.example.test`, "DTSTAMP:20261113T120000Z", t("DTSTART", o.from, "090000"),
    o.clock ? t("DTEND", o.from, "100000") : t("DTEND", next(o.from), ""), `RRULE:${o.rule}`,
    ...(o.excluded ?? []).map((d) => t("EXDATE", d, "090000")), `SUMMARY:${o.summary}`, "SEQUENCE:0", "X-ELSEWHERE-COLOUR:ochre",
    "END:VEVENT", "END:VCALENDAR",
  ].map((line) => `${fold(line)}\r\n`).join("");
}

/** The days a text holds, as the calendar core expands them: each start, as a moment in UTC or a whole day. */
function daysOf(text: string): string[] {
  const read = readCalendar(text, DEFAULT_LIMITS);
  if (!read.ok) throw new Error("the core does not read the text");
  const zones = zonesOf(read.calendar, ZONES);
  return seriesOf(read.calendar.events, zones).flatMap((s) => {
    const found = expandSeries(s, { startMs: Date.UTC(2026, 0, 1), endMs: Date.UTC(2031, 0, 1), viewerZone: "Etc/UTC" }, zones);
    if (found.capped) throw new Error("the series did not expand whole");
    return found.occurrences.map((o) => (o.start.kind === "date"
      ? `${o.start.year}-${String(o.start.month).padStart(2, "0")}-${String(o.start.day).padStart(2, "0")}`
      : new Date(momentOrUtc(o.start, zones)).toISOString()));
  }).sort();
}

/** Of a text's events, the lines a press or another program changes: start, repeat, excluded days, title, place. */
const eventLines = (text: string): string[] => {
  const lines = text.replace(/\r\n[ \t]/g, "").split("\r\n");
  return lines.slice(Math.max(0, lines.indexOf("BEGIN:VEVENT"))).filter((l) => /^(RRULE|SUMMARY|EXDATE|DTSTART|LOCATION)[;:]/.test(l));
};

type WorldName = "clock" | "days";
interface Place {
  readonly text: string;
  /** A day's key as an act names it, and the same day as `daysOf` tells it. */
  readonly key: (december: number) => string;
  readonly day: (december: number) => string;
  /** The rule another program leaves the series with when it ends it at 14 December. */
  readonly theirEnd: string;
}
const PLACES: Record<WorldName, Place> = {
  clock: {
    text: mondays({ uid: "walk", clock: true, from: "20261123", rule: "FREQ=WEEKLY;BYDAY=MO;COUNT=10", summary: "Kiln" }),
    key: (d) => String(Date.UTC(2026, 11, d, 8)), day: (d) => new Date(Date.UTC(2026, 11, d, 8)).toISOString(),
    theirEnd: "RRULE:FREQ=WEEKLY;UNTIL=20261214T075959Z;BYDAY=MO",
  },
  days: {
    text: mondays({ uid: "walkd", clock: false, from: "20261123", rule: "FREQ=WEEKLY;BYDAY=MO;COUNT=10", summary: "Kiln" }),
    key: (d) => String(Date.UTC(2026, 11, d)), day: (d) => `2026-12-${String(d).padStart(2, "0")}`,
    theirEnd: "RRULE:FREQ=WEEKLY;UNTIL=20261213;BYDAY=MO",
  },
};

// ── the bench: one account at its own stand-in, the door, the drain in whole turns ──

/** What a turn's next request meets (`done-500`: its next write is carried out and answered 500). */
type Fault = "lost" | "down" | "refused" | "later" | "signin" | "stop" | "overdue" | "done-500";
/**
 * What the bench saw of the writer's calls, by whose they were: a press by its second part's row id (its own key's hex), `l`
 * the letting go of those days, `c` and `n` a day's cancel. `landed`: its own request changed the series' member. `unheard`: an
 * attempt of a series' end ended unheard (the call threw, or answered a word that waits for time; a cut turn among them).
 * `foundAfterUnheard`: a series' end answered done without changing the member, after an attempt of it ended unheard.
 */
interface Calls {
  readonly landed: Set<string>;
  readonly unheard: Set<string>;
  readonly foundAfterUnheard: Set<string>;
}
interface WriteRow {
  readonly id: string; readonly key: string; readonly op: string; readonly state: string; readonly refusal: string | null; readonly attempts: number;
  readonly payload: unknown; readonly base: string | null; readonly eventId: string | null;
  /**
   * How old the row is, by when it was recorded (`past…`) and by when it was last touched (`kept…`): past the queue's 72 hours, past
   * seven days, and within 73 hours of seven days (`…95h`: the letter `72h` adds 73 hours, so its next one passes them). Time that
   * passed is never nothing: two waits of 73 hours are another state than one, since a third passes seven days where a second does not.
   */
  readonly past72h: boolean; readonly past95h: boolean; readonly past7d: boolean;
  readonly kept72h: boolean; readonly kept95h: boolean; readonly keptPast7d: boolean;
}
interface EventRow {
  readonly id: string; readonly providerId: string; readonly versionTag: string | null; readonly repeatRule: string | null;
  readonly original: string | null; readonly updatedAt: Date; readonly recurrenceId: string;
}
/** What the walk reads after every step: the queue, the store's records, the server's members, the connection. */
interface Seen {
  readonly rows: readonly WriteRow[];
  readonly events: readonly EventRow[];
  readonly members: ReadonlyMap<string, { readonly ics: string; readonly etag: string }>;
  readonly connection: string;
}
type Bench = Awaited<ReturnType<typeof benchOf>>;

async function benchOf(w: World, world: WorldName) {
  const place = PLACES[world];
  const dav = await startCalDavStandIn({ autoSchedule: false });
  const held = dav.addCalendar("studio", { name: "Studio" }) as unknown as { members: Map<string, { ics: string; etag: string }> };
  dav.put("studio", "s.ics", place.text, '"s.ics-1"');
  const serverUrl = `http://127.0.0.1:${dav.port}${dav.paths.start}`;
  const t = await seedConnection(w, {
    provider: "caldav", credential: { kind: "basic", user: dav.options.user, password: new Secret(dav.options.password) }, serverUrl, principal: null, mailboxAddress: MILA,
  });
  const real = makeCalendarProviders({
    clock: { now: () => Date.now() }, zones: ZONES, resolver: NOBODY, policy: { kind: "own-network" }, enabled: new Set(["caldav"]), microsoft: null, writes: true,
  }).get("caldav")!;
  // The turn's fault meets the first call the drain makes of the writer (or, `skip` calls on, a later one), and of that call its
  // first request.
  let armed: Fault | null = null;
  let skip = 0;
  let hit = false;
  let stop = new AbortController();
  const unasked = async (): Promise<void> => { await fetch(`http://127.0.0.1:${dav.port}/`, { method: "GET" }).then((r) => r.arrayBuffer(), () => undefined); };
  const meeting = <A extends unknown[], R>(call: (...args: A) => Promise<R>) => async (...args: A): Promise<R> => {
    if (armed !== null && skip > 0) {
      skip -= 1;
      return call(...args);
    }
    const fault = armed;
    armed = null;
    if (fault === null) return call(...args);
    if (fault === "done-500") {
      // The next write the call makes is carried out and answered 500; a call that wrote nothing met nothing.
      dav.doneThen(500);
      const answer = await call(...args);
      if (dav.doneThenPending()) dav.doneThen(null);
      else hit = true;
      return answer;
    }
    if (fault === "down") {
      hit = true;
      throw new Error("the connection is down");
    }
    if (fault === "lost") {
      hit = true;
      await call(...args);
      throw new Error("the connection dropped after the server answered");
    }
    if (fault === "refused" || fault === "later" || fault === "signin") {
      const before = dav.seen.length;
      dav.answerNext(fault === "refused" ? 403 : fault === "signin" ? 401 : 503);
      const answer = await call(...args);
      // A call that asked nothing left the answer waiting for whoever asks next: taken back, the fault met nothing.
      if (dav.seen.length === before) await unasked();
      else hit = true;
      return answer;
    }
    // The request is carried out; before its answer goes out the turn's signal ends: the worker's stop, or the turn's own time.
    dav.afterNextWrite(() => {
      hit = true;
      stop.abort(fault === "overdue" ? new CalendarTurnOverdue() : undefined);
    });
    return call(...args);
  };
  const r = real.writer!;
  // Whose request changed the series' member, and which attempt of a series' end ended unheard: read off each call as it was made.
  const calls: Calls = { landed: new Set(), unheard: new Set(), foundAfterUnheard: new Set() };
  const tagNow = (): string | undefined => held.members.get("s.ics")?.etag;
  const waits = (reason: string): boolean => Object.hasOwn(WORD_PLAN, reason) && WORD_PLAN[reason as keyof typeof WORD_PLAN] === "retry";
  const endSeries = meeting(r.endSeries.bind(r));
  const remove = meeting(r.remove.bind(r));
  const writer: CalendarWriter = {
    ...r, create: meeting(r.create.bind(r)), change: meeting(r.change.bind(r)), answer: meeting(r.answer.bind(r)),
    continueSeries: meeting(r.continueSeries.bind(r)),
    remove: async (c, cal, target, signal) => {
      const before = tagNow();
      try {
        return await remove(c, cal, target, signal);
      } finally {
        const day = target.occurrence === null ? null : momentOrUtc(target.occurrence, ZONES);
        if (tagNow() !== before && day !== null) calls.landed.add(day === Number(place.key(28)) ? "c" : "n");
      }
    },
    endSeries: async (c, cal, target, req, signal) => {
      const who = req.then === null ? "l" : req.then.key.hex;
      const before = tagNow();
      let answer: Awaited<ReturnType<CalendarWriter["endSeries"]>>;
      try {
        answer = await endSeries(c, cal, target, req, signal);
      } catch (err) {
        if (tagNow() !== before) calls.landed.add(who);
        // A writer's throw is answered `unknown` by the drain: a word that waits for time.
        calls.unheard.add(who);
        throw err;
      }
      if (tagNow() !== before) calls.landed.add(who);
      if (!answer.ok && waits(answer.reason)) calls.unheard.add(who);
      if (answer.ok && tagNow() === before && calls.unheard.has(who)) calls.foundAfterUnheard.add(who);
      return answer;
    },
  };
  const provider: CalendarProvider = { ...real, writer };
  const proven = { [proofPlaceOf("caldav", serverUrl)!]: PROVEN_REPEATS[BENCH_CALDAV_PLACE]! };
  const drain = calendarWriteDrain({ clock: { now: () => Date.now() }, zones: ZONES, log: capturedLog().log, proven });
  const withDrain = depsFor(w, providersOf({ caldav: provider }), { drainWrites: drain });
  const due = async (): Promise<void> => {
    await w.db.update(calCalendars).set({ nextPollAt: null }).where(eq(calCalendars.accountId, t.accountId));
    await w.db.update(calConnections).set({ nextPollAt: null }).where(eq(calConnections.accountId, t.accountId));
    await w.db.update(calWrites).set({ nextAttemptAt: sql`now() - interval '1 second'` }).where(and(eq(calWrites.accountId, t.accountId), eq(calWrites.state, "pending")));
  };
  const first = await calendarSyncPass(withDrain, t.due, new AbortController().signal);
  if (first.kind !== "synced") throw new Error(`the first reading ended ${first.kind}`);
  const ctx = (): ServiceContext => ({ db: w.db as unknown as ServiceContext["db"], accountId: t.accountId, userId: null, now: () => new Date(), requestId: `walk-${randomUUID().slice(0, 8)}` });
  const refusalOf = (err: unknown): string => {
    if (err instanceof ServiceError) return `${err.httpStatus} ${err.code}`;
    throw err;
  };
  const idOf = async (key: string): Promise<string | null> =>
    (await w.db.select({ id: calWrites.id }).from(calWrites).where(and(eq(calWrites.accountId, t.accountId), eq(calWrites.idempotencyKey, key))))[0]?.id ?? null;
  let sentFrom = dav.seen.length;
  return {
    world, place, dav,
    close: () => dav.close(),
    /**
     * One whole turn: the drain, then the reading; its next request meeting `fault` (in the writer's call `skipCalls` calls on).
     * Says how the turn ended and whether the fault met a request.
     */
    turn: async (fault: Fault | null, skipCalls = 0): Promise<{ readonly kind: string; readonly hit: boolean }> => {
      await due();
      armed = fault;
      skip = fault === null ? 0 : skipCalls;
      hit = false;
      stop = new AbortController();
      const kind = (await calendarSyncPass(withDrain, t.due, stop.signal)).kind;
      armed = null;
      skip = 0;
      if ((fault === "stop" || fault === "overdue") && !hit) dav.afterNextWrite(() => undefined);
      return { kind, hit };
    },
    /** What the bench saw of the writer's calls so far. */
    calls: (): Calls => calls,
    /** A press as the door takes it: its receipt's state and word, or the door's refusal. */
    door: async (key: string, act: unknown): Promise<string> => {
      try {
        const done = await recordCalendarWrite(ctx(), key, act, { proven });
        return `${done.answer.write?.state}${done.answer.write?.reason == null ? "" : ` ${done.answer.write.reason}`}`;
      } catch (err) {
        return refusalOf(err);
      }
    },
    retry: async (key: string): Promise<string> => {
      const id = await idOf(key);
      if (id === null) return "(no such write)";
      try {
        return (await retryCalendarWrite(ctx(), id)).answer.write?.state ?? "(none)";
      } catch (err) {
        return refusalOf(err);
      }
    },
    dismiss: async (key: string): Promise<string> => {
      const id = await idOf(key);
      if (id === null) return "(no such write)";
      try {
        await dismissCalendarWrite(ctx(), id);
        return "let go";
      } catch (err) {
        return refusalOf(err);
      }
    },
    /** Time passes: every write of the account recorded and last touched this many hours earlier. */
    age: (hours: number) => w.db.update(calWrites).set({
      createdAt: sql`${calWrites.createdAt} - make_interval(hours => ${hours})`, updatedAt: sql`${calWrites.updatedAt} - make_interval(hours => ${hours})`,
    }).where(eq(calWrites.accountId, t.accountId)),
    /** Another program's write of a member, under a tag of its own. */
    theirs: (name: string, text: string): void => dav.put("studio", name, text),
    seen: async (): Promise<Seen> => {
      const rows = await w.db.select({
        id: calWrites.id, key: calWrites.idempotencyKey, op: calWrites.op, state: calWrites.state, refusal: calWrites.refusal, attempts: calWrites.attempts,
        payload: calWrites.payload, base: calWrites.baseVersionTag, eventId: calWrites.eventId,
        past72h: sql<boolean>`${calWrites.createdAt} < now() - interval '72 hours'`, past95h: sql<boolean>`${calWrites.createdAt} < now() - interval '95 hours'`,
        past7d: sql<boolean>`${calWrites.createdAt} < now() - interval '7 days'`,
        kept72h: sql<boolean>`${calWrites.updatedAt} < now() - interval '72 hours'`, kept95h: sql<boolean>`${calWrites.updatedAt} < now() - interval '95 hours'`,
        keptPast7d: sql<boolean>`${calWrites.updatedAt} < now() - interval '7 days'`,
      }).from(calWrites).where(eq(calWrites.accountId, t.accountId))
        .orderBy(asc(calWrites.createdAt), asc(sql`coalesce((${calWrites.payload}->'part'->>'n')::int, 1)`), asc(calWrites.idempotencyKey));
      const events = await w.db.select({
        id: calEvents.id, providerId: calEvents.providerId, versionTag: calEvents.versionTag, repeatRule: calEvents.repeatRule, original: calEvents.original,
        updatedAt: calEvents.updatedAt, recurrenceId: calEvents.recurrenceId,
      }).from(calEvents).where(eq(calEvents.accountId, t.accountId)).orderBy(asc(calEvents.providerId), asc(calEvents.recurrenceId));
      const [c] = await w.db.select({ status: calConnections.status, errorCode: calConnections.errorCode }).from(calConnections).where(eq(calConnections.accountId, t.accountId));
      return { rows, events, members: new Map([...held.members].map(([name, m]) => [name, { ics: m.ics, etag: m.etag }] as const)), connection: `${c?.status} ${c?.errorCode ?? "-"}` };
    },
    /** The writing requests the server received since the last asking, short: method, member, precondition, and of a body its rule and title. */
    requests: (): string[] => {
      const out = dav.seen.slice(sentFrom).filter((s) => s.method === "PUT" || s.method === "DELETE").map((s) => {
        const name = decodeURIComponent(s.path.split("/").pop() ?? "");
        const lines = eventLines(s.body);
        return `${s.method} ${name === "s.ics" || name === "theirs.ics" ? name : "<new>"}${s.headers["if-match"] ? ` If-Match: ${s.headers["if-match"]}` : ""}${s.headers["if-none-match"] ? ` If-None-Match: ${s.headers["if-none-match"]}` : ""}${lines.length === 0 ? "" : ` [${lines.join(" | ")}]`}`;
      });
      sentFrom = dav.seen.length;
      return out;
    },
  };
}

// ── the person's intent ──────────────────────────────────────────────────────────

interface Act {
  readonly key: string;
  readonly kind: "split" | "cancel" | "let-go" | "delete" | "repeat" | "title";
  /** The act as the door was handed it: pressed again under its key, it is this very act. */
  readonly body: unknown;
  /** The days it names: the day cancelled, or the day pressed and the days after it; of the whole series deleted, the days its record showed (`named`). */
  readonly days: readonly string[];
  /** The door took it (`pending`); one the door recorded refused was never the person's standing wish. */
  readonly taken: boolean;
  /** How its row stood when the walk last saw it, and whether the person let it go. */
  state: string;
  letGo: boolean;
}
interface Mind {
  readonly before: readonly string[];
  readonly acts: Act[];
  readonly givenUp: Set<string>;
  /** The letters an order holds once, used. */
  readonly used: Set<string>;
  presses: number;
  /** The series' record as the walk's two devices first read it. */
  readonly first: { readonly id: string; readonly updatedAt: Date };
  /** Of each press, by its key: the key of its second part's row, by that row's id (a new series' member is named from it). */
  readonly pressOf: Map<string, string>;
  /** The writes, by key, whose own request changed the series at the server (`landed`), and the presses that found their end after an attempt of it ended unheard. */
  readonly landed: Set<string>;
  readonly foundAfterUnheard: Set<string>;
  /** The days the second decided exception found doubled so far. */
  readonly decided: Set<string>;
}

const stateOf = (r: WriteRow): string => `${r.state}${r.refusal === null ? "" : ` ${r.refusal}`}`;
const removes = (a: Act): boolean => a.kind === "cancel" || a.kind === "let-go" || a.kind === "delete";
/** A removal still shapes the intent while it stands: taken by the door, not let go, not refused for the copy it was made on. */
const stands = (a: Act): boolean => a.taken && !a.letGo && a.state !== "refused version_stale";

/**
 * The days a removal names, as things stand now. The whole series deleted names the days its record showed, less the days a press
 * on a day and the days after it, pressed before it and standing now, gave a series of their own (those days are on that new
 * series' record, which the person did not delete); a press let go since, or refused for its copy, moved none.
 */
function named(m: Mind, a: Act): readonly string[] {
  if (a.kind !== "delete") return a.days;
  const moved = new Set(m.acts.slice(0, m.acts.indexOf(a)).filter((p) => p.kind === "split" && stands(p)).flatMap((p) => p.days));
  return a.days.filter((d) => !moved.has(d));
}

/** The days the server must hold once everything owed is answered: the person's intent. */
function intentOf(m: Mind): string[] {
  const gone = new Set<string>(m.givenUp);
  for (const a of m.acts) if (removes(a) && stands(a)) for (const d of named(m, a)) gone.add(d);
  return m.before.filter((d) => !gone.has(d));
}

/** The days the provider's own records show in the store: every record a reading or an answer stored, none a press stands in for. */
function shownOf(seen: Seen): Set<string> {
  const texts = new Map<string, string>();
  for (const e of seen.events) if (!e.providerId.startsWith("pending:") && e.original !== null) texts.set(e.providerId, e.original);
  return new Set([...texts.values()].flatMap((text) => daysOf(text)));
}

/** How the rows stand now, and what the bench saw of the writer's calls, each by the key of the write it was. */
function note(m: Mind, seen: Seen, calls: Calls): void {
  for (const a of m.acts) {
    const row = seen.rows.find((r) => r.key === a.key);
    if (row !== undefined) a.state = stateOf(row);
  }
  for (const r of seen.rows) m.pressOf.set(r.id.replaceAll("-", ""), r.key.replace(/:2$/, ""));
  const keyOf = (who: string): string | undefined => (/^[0-9a-f]{32}$/.test(who) ? m.pressOf.get(who) : who);
  for (const who of calls.landed) {
    const k = keyOf(who);
    if (k !== undefined) m.landed.add(k);
  }
  for (const who of calls.foundAfterUnheard) {
    const k = keyOf(who);
    if (k !== undefined) m.foundAfterUnheard.add(k);
  }
}

/**
 * I1, read off the stand-in: what breaks it, or nothing. THE SECOND DECIDED EXCEPTION is asserted here, exactly: a day that
 * stands twice is no finding only where it stands once in the other program's member and once in the new series of a press
 * that found its end after an attempt of it ended unheard (a word that waits for time, or cut); such days are noted.
 */
function daysTwice(m: Mind, seen: Seen): string | null {
  const by = [...seen.members].map(([name, member]) => ({ name, days: daysOf(member.ics) }));
  const all = by.flatMap((x) => x.days);
  const twice = [...new Set(all.filter((d, i) => all.indexOf(d) !== i))];
  const pressOfMember = (name: string): string | undefined =>
    (name === "s.ics" || name === "theirs.ics" ? undefined : m.pressOf.get(name.replace(/\.ics$/, "").replaceAll("-", "")));
  const decided = (d: string): boolean => {
    const holders = by.filter((x) => x.days.includes(d));
    if (holders.length !== 2 || holders.some((x) => x.days.filter((y) => y === d).length !== 1)) return false;
    const ours = holders.find((x) => x.name !== "theirs.ics");
    const press = ours === undefined ? undefined : pressOfMember(ours.name);
    return holders.some((x) => x.name === "theirs.ics") && press !== undefined && m.foundAfterUnheard.has(press);
  };
  const other = twice.filter((d) => !decided(d));
  if (other.length > 0) return `${other.length} day(s) stand twice at the server (${all.length} days of ${m.before.length}): ${other.join(", ")}`;
  for (const d of twice) m.decided.add(d);
  const strange = all.filter((d) => !m.before.includes(d));
  if (strange.length > 0) return `the server holds day(s) the series never had: ${strange.join(", ")}`;
  const done = new Set(m.acts.filter((a) => removes(a) && a.state === "applied").flatMap((a) => named(m, a)));
  const back = all.filter((d) => done.has(d));
  if (back.length > 0) return `the server holds day(s) whose removal is done: ${back.join(", ")}`;
  // A day the person gave up stands at the server only where a press that stands names it.
  const standing = new Set(m.acts.filter((a) => a.kind === "split" && a.taken && !a.letGo).flatMap((a) => a.days));
  const returned = all.filter((d) => m.givenUp.has(d) && !standing.has(d));
  if (returned.length > 0) return `the server holds day(s) the person gave up, and no press that stands names them: ${returned.join(", ")}`;
  return null;
}

/** A row's age as the signature tells it: every step a wait of 73 hours or of eight days can take it, by either of its two times. */
const age = (r: WriteRow): string =>
  `${r.past72h ? "72h" : ""}${r.past95h ? "95h" : ""}${r.past7d ? "7d" : ""}${r.kept72h ? "k72h" : ""}${r.kept95h ? "k95h" : ""}${r.keptPast7d ? "k7d" : ""}`;

/** What the walk tells two states apart by: everything that decides what a further letter does. */
function signature(m: Mind, seen: Seen): string {
  const tagOf = new Map([...seen.members].map(([name, member]) => [member.etag, name] as const));
  const keyOf = new Map(seen.rows.map((r) => [r.id, r.key] as const));
  const eventName = (e: EventRow): string => {
    if (e.providerId.startsWith("pending:")) return `pending:${keyOf.get(e.providerId.slice(8)) ?? "?"}`;
    const name = decodeURIComponent(e.providerId.split("/").pop() ?? "");
    return name === "s.ics" || name === "theirs.ics" ? name : `new:${e.repeatRule}`;
  };
  const tag = (v: string | null): string => (v === null ? "none" : tagOf.has(v) ? `at:${tagOf.get(v) === "s.ics" || tagOf.get(v) === "theirs.ics" ? tagOf.get(v) : "new"}` : "old");
  const kept = (r: WriteRow): string => {
    const p = r.payload as { act?: { kind?: string; scope?: { kind?: string; at?: string } }; after?: string | null; part?: { n?: number } | null; ended?: string } | null;
    if (r.state === "applied") return JSON.stringify(p);
    return `${p?.act?.kind}/${p?.act?.scope?.kind ?? "-"}/${p?.act?.scope?.at ?? "-"}/${p?.part?.n ?? "-"}/${p?.after == null ? "-" : keyOf.get(p.after) ?? "gone"}`;
  };
  return JSON.stringify({
    rows: seen.rows.map((r) => `${r.key} ${r.op} ${stateOf(r)} attempts=${r.attempts} ${age(r)} base=${tag(r.base)} ${kept(r)}`),
    events: seen.events.map((e) => `${eventName(e)} ${e.recurrenceId} ${tag(e.versionTag)} ${e.repeatRule}${e.id === m.first.id && e.updatedAt.getTime() === m.first.updatedAt.getTime() ? " as first read" : ""}`).sort(),
    members: [...seen.members].map(([name, member]) => `${name === "s.ics" || name === "theirs.ics" ? name : "new"} ${eventLines(member.ics).join("|")}`).sort(),
    connection: seen.connection,
    mind: {
      acts: m.acts.map((a) => `${a.key} ${a.kind} ${a.taken} ${a.letGo} ${a.state}`), givenUp: [...m.givenUp].sort(), used: [...m.used].sort(), presses: m.presses,
      landed: [...m.landed].sort(), foundAfterUnheard: [...m.foundAfterUnheard].sort(),
    },
  });
}

// ── the alphabet ─────────────────────────────────────────────────────────────────

interface Letter {
  readonly id: string;
  readonly says: string;
  /** One of the same-day letters: the events the three rechecks' findings were made of, walked deeper. */
  readonly family: boolean;
  /** How often a random order picks it, beside the others that can happen. */
  readonly weight: number;
  applies(m: Mind, seen: Seen): boolean;
  /** Does it; says what the door or the turn answered. */
  run(b: Bench, m: Mind, seen: Seen): Promise<string>;
}

const owed = (seen: Seen): boolean => seen.rows.some((r) => r.state === "pending");
const seriesRow = (seen: Seen): EventRow | undefined =>
  seen.events.find((e) => decodeURIComponent(e.providerId.split("/").pop() ?? "") === "s.ics" && e.recurrenceId === "");
const on = (row: { readonly id: string; readonly updatedAt: Date }) => ({ eventId: row.id, base: row.updatedAt.toISOString() });
/** The days from `day` on, of the days the record a press was made on shows (`null`: the copy the walk's devices first read). */
const from = (m: Mind, day: string, record: EventRow | null = null): string[] => {
  const shown = record === null || record.original === null ? m.before : daysOf(record.original);
  return m.before.filter((d) => d >= day && shown.includes(d));
};
const only = (m: Mind, day: string, record: EventRow): string[] => from(m, day, record).filter((d) => d === day);
/** Does the series' record, as the store holds it, still run to the series' last day? */
const runsOut = (m: Mind, seen: Seen): boolean => {
  const row = seriesRow(seen);
  return row !== undefined && (row.original === null || daysOf(row.original).includes(m.before.at(-1)!));
};

/** A press at the door, and what the person's intent keeps of it. */
async function pressed(b: Bench, m: Mind, id: string, key: string, kind: Act["kind"], days: readonly string[], body: unknown): Promise<string> {
  const said = await b.door(key, body);
  // A press the door did not record (400, 409) is no press at all.
  if (/^\d/.test(said)) return said;
  m.used.add(id);
  m.acts.push({ key, kind, body, days, taken: said === "pending", state: said, letGo: false });
  m.presses += 1;
  return said;
}

const split = (row: { readonly id: string; readonly updatedAt: Date }, at: string, change: Record<string, unknown>) =>
  ({ kind: "calendar_event_update", ...on(row), scope: { kind: "following", at, newEventId: randomUUID() }, change });

function pressLetters(): Letter[] {
  const once = (id: string) => (m: Mind): boolean => !m.used.has(id) && m.presses < MOST_PRESSES;
  // A removal of the person's and another program's write of the same days are not walked together (see `theirs`).
  const removal = (id: string) => (m: Mind): boolean => once(id)(m) && !m.used.has("theirs");
  return [
    {
      id: "press", family: true, weight: 4,
      says: "a person: the days from 14 December on get a new title, on the copy the store holds now (a second time: the same press pressed again, a new press)",
      applies: (m, seen) => m.acts.filter((a) => a.key.startsWith("p")).length < 2 && m.presses < MOST_PRESSES && seriesRow(seen) !== undefined,
      run: (b, m, seen) => {
        const key = `p${m.acts.filter((a) => a.key.startsWith("p")).length + 1}`;
        return pressed(b, m, "press", key, "split", from(m, b.place.day(14), seriesRow(seen)!), split(seriesRow(seen)!, b.place.key(14), { title: "The new term" }));
      },
    },
    {
      id: "press-2nd-device", family: true, weight: 3,
      says: "another device: the same day pressed there, on the copy the first press was made on (a new place)",
      applies: (m) => m.used.has("press") && once("press-2nd-device")(m),
      run: (b, m) => {
        return pressed(b, m, "press-2nd-device", "q", "split", from(m, b.place.day(14)), split(m.first, b.place.key(14), { place: "Studio 3" }));
      },
    },
    {
      id: "press-other-day", family: false, weight: 1,
      says: "a person: the days from 21 December on get a new title",
      applies: (m, seen) => once("press-other-day")(m) && seriesRow(seen) !== undefined,
      run: (b, m, seen) => {
        return pressed(b, m, "press-other-day", "r", "split", from(m, b.place.day(21), seriesRow(seen)!), split(seriesRow(seen)!, b.place.key(21), { title: "After the solstice" }));
      },
    },
    {
      id: "cancel-day", family: false, weight: 1,
      says: "a person: 28 December cancelled",
      applies: (m, seen) => removal("cancel-day")(m) && seriesRow(seen) !== undefined,
      run: (b, m, seen) => {
        return pressed(b, m, "cancel-day", "c", "cancel", only(m, b.place.day(28), seriesRow(seen)!), { kind: "calendar_event_delete", ...on(seriesRow(seen)!), scope: { kind: "occurrence", at: b.place.key(28) } });
      },
    },
    {
      id: "cancel-no-day", family: false, weight: 1,
      says: "a person: 15 December cancelled, a day the series does not have",
      applies: (m, seen) => removal("cancel-no-day")(m) && seriesRow(seen) !== undefined,
      run: (b, m, seen) => {
        return pressed(b, m, "cancel-no-day", "n", "cancel", [], { kind: "calendar_event_delete", ...on(seriesRow(seen)!), scope: { kind: "occurrence", at: b.place.key(15) } });
      },
    },
    {
      id: "retitle-series", family: false, weight: 1,
      says: "a person: a new title for the whole series",
      applies: (m, seen) => once("retitle-series")(m) && seriesRow(seen) !== undefined,
      run: (b, m, seen) => {
        return pressed(b, m, "retitle-series", "t", "title", [], { kind: "calendar_event_update", ...on(seriesRow(seen)!), scope: { kind: "record" }, change: { title: "Kiln, mornings" } });
      },
    },
    {
      // One day changed keeps its day. Not walked beside another program's write: what that one makes of a day changed here is its own.
      id: "retitle-day", family: false, weight: 1,
      says: "a person: a new title for 21 December alone",
      applies: (m, seen) => once("retitle-day")(m) && !m.used.has("theirs") && seriesRow(seen) !== undefined,
      run: (b, m, seen) => {
        return pressed(b, m, "retitle-day", "y", "title", [], { kind: "calendar_event_update", ...on(seriesRow(seen)!), scope: { kind: "occurrence", at: b.place.key(21) }, change: { title: "Glaze day" } });
      },
    },
    {
      // The fifth recheck's other alphabet hole: a new repeat for the whole series. It names the days the series has, and is offered
      // only where the store's copy still runs to its last day: there the days stay the days whatever copy it is written onto.
      id: "repeat-series", family: false, weight: 1,
      says: "a person: a new repeat for the whole series, weekly on Mondays ten times (the days it has), on a copy that still runs to its last day",
      applies: (m, seen) => once("repeat-series")(m) && !m.used.has("theirs") && runsOut(m, seen),
      run: (b, m, seen) => {
        return pressed(b, m, "repeat-series", "u", "repeat", [], { kind: "calendar_event_update", ...on(seriesRow(seen)!), scope: { kind: "record" }, change: { repeat: "FREQ=WEEKLY;BYDAY=MO;COUNT=10" } });
      },
    },
    {
      id: "let-go", family: true, weight: 2,
      says: "a person: the days from 14 December on let go",
      applies: (m, seen) => removal("let-go")(m) && seriesRow(seen) !== undefined,
      run: (b, m, seen) => {
        return pressed(b, m, "let-go", "l", "let-go", from(m, b.place.day(14), seriesRow(seen)!), { kind: "calendar_event_delete", ...on(seriesRow(seen)!), scope: { kind: "following", at: b.place.key(14) } });
      },
    },
    {
      // The fifth recheck's alphabet hole: the whole series removed under a press half carried out. One of the same-day letters in
      // the full walk (that recheck's finding is made of it); the ordinary run walks it with the whole alphabet and in its random
      // orders, which keeps that run under its 90 seconds.
      id: "delete-series", family: ENV.OHCAL_WALK === "full", weight: 2,
      says: "a person: the whole series deleted, on the copy the store holds now (the days that record shows)",
      applies: (m, seen) => removal("delete-series")(m) && seriesRow(seen) !== undefined,
      run: (b, m, seen) => {
        return pressed(b, m, "delete-series", "d", "delete", from(m, m.before[0]!, seriesRow(seen)!), { kind: "calendar_event_delete", ...on(seriesRow(seen)!), scope: { kind: "record" } });
      },
    },
  ];
}

/** A fault that met no request left the turn an answered one: that order is the order with `turn` in its place. */
const NOTHING = "(nothing happened)";

function turnLetters(): Letter[] {
  const turn = (id: string, fault: Fault | null, family: boolean, weight: number, says: string, skipCalls = 0): Letter => ({
    id, family, weight, says,
    // A fault needs a request to meet: a write owed; on the turn's second call of the writer, a second write owed behind the first.
    applies: (_m, seen) => fault === null || seen.rows.filter((r) => r.state === "pending").length > skipCalls,
    run: async (b) => {
      const { kind, hit } = await b.turn(fault, skipCalls);
      return fault !== null && !hit ? NOTHING : kind;
    },
  });
  return [
    turn("turn", null, true, 6, "the network and the provider: a drain turn in which every request is answered"),
    turn("turn-lost", "lost", true, 3, "the network: the turn's next request lands and its answer is lost"),
    turn("turn-down", "down", false, 1, "the network: the turn's next request never lands and is not answered"),
    turn("turn-refused", "refused", false, 2, "the provider: it refuses the turn's next request with a content word (403)"),
    turn("turn-later", "later", false, 1, "the provider: it refuses the turn's next request with a word that waits for time (503)"),
    turn("turn-stop", "stop", false, 2, "the worker: the turn's next write lands, and the worker stops before its answer is settled"),
    turn("turn-overdue", "overdue", false, 1, "the worker: the turn's next write lands, and the turn's own time runs out"),
    // The fourth recheck's alphabet hole: a fault on the second part's request in the turn its first part is carried out (and
    // the provider carrying a write out and answering an error).
    turn("turn-done-500", "done-500", true, 2, "the provider: it carries the turn's next write out and answers 500"),
    turn("turn2-lost", "lost", true, 2, "the network: the turn's second call of the writer lands and its answer is lost", 1),
    turn("turn2-refused", "refused", true, 2, "the provider: it refuses the turn's second call of the writer with a content word (403)", 1),
    turn("turn2-later", "later", true, 1, "the provider: it refuses the turn's second call of the writer with a word that waits for time (503)", 1),
    {
      // The sixth recheck's letter: the provider asks for the person. It refused before it acted, so the attempt is given back
      // whole and the queue stands as it stood: the walk is told that it happened (the mind's `used`), so that the order is
      // walked on and not cut as a letter that changed nothing. What follows a sign-in refusal is what this letter is for.
      id: "turn-signin", family: false, weight: 1,
      says: "the provider: it refuses the turn's next request and asks for the person (401)",
      applies: (_m, seen) => owed(seen),
      run: async (b, m) => {
        const { kind, hit } = await b.turn("signin");
        if (!hit) return NOTHING;
        m.used.add("turn-signin");
        return kind;
      },
    },
    {
      id: "outage", family: true, weight: 3,
      says: "the network: turn after turn the next request never lands, until the write's attempts are spent and it is refused",
      applies: (_m, seen) => owed(seen),
      run: async (b, _m, seen) => {
        const head = seen.rows.find((r) => r.state === "pending")!.key;
        let met = 0;
        for (let i = 0; i < 9; i++) {
          const { hit } = await b.turn("down");
          if (!hit) break;
          met += 1;
          if ((await b.seen()).rows.find((r) => r.key === head)?.state !== "pending") break;
        }
        return met === 0 ? NOTHING : `${met} turns`;
      },
    },
  ];
}

function otherLetters(): Letter[] {
  return [
    {
      id: "72h", family: true, weight: 1, says: "time: 73 hours pass", applies: (_m, seen) => seen.rows.length > 0,
      run: async (b) => {
        await b.age(73);
        return "73 hours";
      },
    },
    {
      id: "7d", family: false, weight: 1, says: "time: eight days pass", applies: (_m, seen) => seen.rows.length > 0,
      run: async (b) => {
        await b.age(8 * 24);
        return "eight days";
      },
    },
    {
      id: "theirs", family: false, weight: 1,
      says: "another program: it ends the series at 14 December and makes the rest a series of its own",
      // Only while the series at the server still runs to its last day (no end of the person's has landed there: what another
      // program writes into a press half carried out is not this walk's to judge), and no removal of the person's is owed or
      // refused (nor what it writes over a day whose cancel is still owed).
      applies: (m, seen) => !m.used.has("theirs") && !m.used.has("retitle-day") && !m.acts.some((a) => removes(a) && a.state !== "applied")
        && seen.members.has("s.ics") && daysOf(seen.members.get("s.ics")!.ics).includes(m.before.at(-1)!),
      run: async (b, m, seen) => {
        m.used.add("theirs");
        const text = seen.members.get("s.ics")!.ics;
        const there = daysOf(text);
        const rest = from(m, b.place.day(14));
        const excluded = rest.filter((d) => !there.includes(d)).map((d) => d.slice(0, 10).replaceAll("-", ""));
        b.theirs("s.ics", text.replace(/^RRULE:.*$/m, b.place.theirEnd));
        b.theirs("theirs.ics", mondays({ uid: "theirs", clock: b.world === "clock", from: "20261214", rule: "FREQ=WEEKLY;BYDAY=MO;COUNT=7", summary: "Kiln, their way", excluded }));
        return "written";
      },
    },
  ];
}

/** The retry and the letting go of each write the queue holds: a letter per key, offered where the write stands so. */
function writeLetters(keys: readonly string[]): Letter[] {
  return keys.flatMap((key): Letter[] => [
    {
      id: `retry:${key}`, family: !key.endsWith(":2"), weight: 4,
      says: "a person: the retry of a write shown as refused",
      applies: (_m, seen) => seen.rows.some((r) => r.key === key && r.state === "refused"),
      run: (b) => b.retry(key),
    },
    {
      id: `dismiss:${key}`, family: false, weight: 1,
      says: "a person: the letting go of a write, refused or not yet tried",
      applies: (_m, seen) => seen.rows.some((r) => r.key === key && r.state !== "applied"),
      run: async (b, m, seen) => {
        const said = await b.dismiss(key);
        if (said !== "let go") return said;
        // What the person lets go of goes with what waited for it; the days the provider's own records no longer show are given up.
        const head = key.endsWith(":2") ? key.slice(0, -2) : key;
        const act = m.acts.find((a) => a.key === head);
        if (act === undefined) return said;
        const shown = shownOf(seen);
        act.letGo = true;
        // The days of the write that the provider's own records no longer show (and that were not given up before). Whether another
        // removal of the person's names them too decides nothing: whatever becomes of that removal later gives them back to nobody.
        const gone = named(m, act).filter((d) => !m.givenUp.has(d) && !shown.has(d));
        if (gone.length === 0) return said;
        // Only the letting go of the write whose own request changed the series (its end at the server), or of a press's second
        // part once its first is done, gives days up (the fourth recheck's ruling). Any other write let go gives up nothing. Whether
        // the first part is done is read off its own row: the door lets a second part go alone also where its first part's row is
        // gone with its series (the series removed whole before the press was carried out), and that first part was never done.
        if (key.endsWith(":2") && act.state !== "applied") {
          return `${said}: nothing given up (the press's first part was never done; ${gone.length} day(s) the record does not show stay the person's)`;
        }
        if (!key.endsWith(":2") && !m.landed.has(head)) {
          return `${said}: nothing given up (no request of this write changed the series; ${gone.length} day(s) the record does not show stay the person's)`;
        }
        for (const d of gone) m.givenUp.add(d);
        if (act.kind === "cancel" || !gone.includes(act.days[0]!)) return `${said}: ${gone.length} day(s) given up`;
        // THE DECIDED EXCEPTION: the days are gone for good, and the door says so: that day pressed afresh is refused.
        const row = seriesRow(await b.seen());
        const afresh = row === undefined ? "404" : await b.door(`x${m.givenUp.size}-${key.replace(":", "-")}`, split(row, (act.body as { scope: { at: string } }).scope.at, { title: "The new term" }));
        return /^400 /.test(afresh) ? `${said}: ${gone.length} day(s) given up, the door refuses that day afresh (${afresh})` : `${said}: ${gone.length} day(s) given up, AND THE DOOR TAKES THAT DAY AFRESH (${afresh})`;
      },
    },
  ]);
}

const KEYS = ["p1", "p1:2", "p2", "p2:2", "q", "q:2", "r", "r:2", "c", "n", "l", "d", "u", "t", "y"];
/** Beside the same-day letters, what the series of whole days is walked with: what another program writes there differs. */
const WHOLE_DAYS = ["turn-refused", "theirs", "72h"];
const LETTERS: readonly Letter[] = [...pressLetters(), ...turnLetters(), ...otherLetters(), ...writeLetters(KEYS)];
const letter = (id: string): Letter => {
  const found = LETTERS.find((l) => l.id === id);
  if (found === undefined) throw new Error(`the walk has no letter ${id}`);
  return found;
};

// ── walking an order ─────────────────────────────────────────────────────────────

interface Step {
  readonly letter: string;
  readonly said: string;
  readonly rows: readonly string[];
  readonly requests: readonly string[];
  readonly server: string;
}
interface Walked {
  readonly b: Bench;
  readonly m: Mind;
  seen: Seen;
  readonly steps: Step[];
  /** The last letter changed nothing. */
  readonly nothing: boolean;
  /** What broke the first sentence on the way, with the step it broke at. */
  readonly twice: string | null;
  readonly sig: string;
  /** The signature before each step, and the one after the last: what a further walk of the same order must reach. */
  readonly sigs: readonly string[];
}
interface Finding {
  readonly sentence: "I1 no day twice" | "I2 never stuck" | "I2 stuck for a turn" | "the decided exception" | "the walk itself";
  readonly world: WorldName;
  readonly order: readonly string[];
  readonly what: string;
  readonly steps: readonly Step[];
}

const serverOf = (seen: Seen): string => [...seen.members].map(([name, member]) => `${name === "s.ics" || name === "theirs.ics" ? name : "<new>"}: ${daysOf(member.ics).length}`).join(", ");
const rowsOf = (seen: Seen): string[] => seen.rows.map((r) => `${r.key} ${stateOf(r)} attempts=${r.attempts}${r.state === "applied" ? ` kept=${JSON.stringify(r.payload)}` : ""}`);

/** The order walked from the start, on an account and a stand-in of its own: each letter done, the first sentence read after each. */
async function walkOrder(w: World, world: WorldName, order: readonly string[], pick?: (can: readonly Letter[], m: Mind, seen: Seen) => Letter | null): Promise<Walked> {
  const b = await benchOf(w, world);
  let seen = await b.seen();
  const row = seriesRow(seen);
  if (row === undefined) throw new Error("the first reading stored no series");
  const m: Mind = {
    before: daysOf(b.place.text), acts: [], givenUp: new Set(), used: new Set(), presses: 0, first: { id: row.id, updatedAt: row.updatedAt },
    pressOf: new Map(), landed: new Set(), foundAfterUnheard: new Set(), decided: new Set(),
  };
  b.requests();
  const steps: Step[] = [];
  const sigs = [signature(m, seen)];
  let twice: string | null = null;
  let nothing = false;
  const letters: Letter[] = order.map(letter);
  for (let i = 0; pick !== undefined || i < letters.length; i++) {
    let l = letters[i];
    if (l === undefined) {
      const next = pick!(LETTERS.filter((x) => x.applies(m, seen)), m, seen);
      if (next === null) break;
      l = next;
    } else if (!l.applies(m, seen)) {
      steps.push({ letter: l.id, said: "(cannot happen here)", rows: rowsOf(seen), requests: [], server: serverOf(seen) });
      nothing = true;
      break;
    }
    const said = await l.run(b, m, seen);
    seen = await b.seen();
    note(m, seen, b.calls());
    const sig = signature(m, seen);
    nothing = said === NOTHING || sig === sigs.at(-1);
    sigs.push(sig);
    steps.push({ letter: l.id, said, rows: rowsOf(seen), requests: b.requests(), server: serverOf(seen) });
    twice ??= daysTwice(m, seen);
    if (twice !== null || /AND THE DOOR TAKES/.test(said)) break;
    if (nothing && pick === undefined) break;
  }
  return { b, m, seen, steps, nothing, twice, sig: sigs.at(-1)!, sigs };
}

/** Every further request answered: turns until nothing is owed. The first sentence is read after each. */
async function answered(x: Walked, steps: Step[]): Promise<string | null> {
  for (let i = 0; i < 12; i++) {
    if (!owed(x.seen)) return null;
    const { kind } = await x.b.turn(null);
    x.seen = await x.b.seen();
    note(x.m, x.seen, x.b.calls());
    steps.push({ letter: "turn", said: kind, rows: rowsOf(x.seen), requests: x.b.requests(), server: serverOf(x.seen) });
    const twice = daysTwice(x.m, x.seen);
    if (twice !== null) return twice;
  }
  return owed(x.seen) ? "a write is still owed after twelve answered turns" : null;
}

const missing = (x: Walked): string[] => {
  const held = new Set([...x.seen.members.values()].flatMap((member) => daysOf(member.ics)));
  return intentOf(x.m).filter((d) => !held.has(d));
};

/** Every order of a few things. */
const permutations = <T>(items: readonly T[]): T[][] => (items.length <= 1
  ? [[...items]]
  : items.flatMap((item, i) => permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest])));

/**
 * I2, proved by doing it, and I1 one press further. The presses a person has at a state: the retry of each write
 * shown as refused, the same press again under its key (which changes nothing: what is owed is answered), each
 * press pressed afresh on the copy the store holds. EVERY ONE is tried, each on the state as the order left it (one
 * the door refuses changed nothing, and the next is tried on the same state; one the door took spent the state, and
 * the next is tried on the order walked again): after none of them, with every further request answered, may a day
 * stand twice, and after at least one the server holds every day of the intent: where none did, the sentence is
 * broken. Where none brought the days and more than one press on a day and the days after it stands with a refused
 * write whose retry the door took, the retries of all of them are tried, one press EACH, in every order (`each`):
 * that is the sentence's second half. Where none brought the days and something was owed, the presses of the state at
 * rest are tried too (what is owed answered first: a write shown as owed has no retry yet), to tell the break's kind:
 * a state repaired only so is stuck for a turn (`late`: told as broken, and walked further), and one repaired by
 * nothing is stuck.
 */
async function neverStuck(
  w: World, world: WorldName, order: readonly string[], first: Walked, close: (b: Bench) => Promise<void>,
): Promise<{ readonly found: Finding[]; readonly stuck: boolean; readonly late: boolean; readonly each: number }> {
  const found: Finding[] = [];
  const finding = (sentence: Finding["sentence"], what: string, steps: readonly Step[], more: readonly string[] = []): void => {
    found.push({ sentence, world, order: [...order, ...more], what, steps });
  };
  type Press = { readonly id: string; readonly press: (x: Walked) => Promise<string> };
  const pressesAt = (x: Walked): Press[] => [
    ...x.seen.rows.filter((r) => r.state === "refused").map((r): Press => ({ id: `retry:${r.key}`, press: (y) => y.b.retry(r.key) })),
    { id: "the same press again", press: async (y) => {
      const act = y.m.acts.find((a) => y.seen.rows.some((r) => r.key === a.key));
      if (act === undefined) return owed(y.seen) ? "as it stands" : "(no press to press again)";
      const said = await y.b.door(act.key, act.body);
      return /^\d/.test(said) ? said : `as it stands: ${said}`;
    } },
    ...[...new Map(x.m.acts.filter((a) => a.kind === "split").map((a) => [(a.body as { scope: { at: string } }).scope.at, a] as const)).values()].map((a, i): Press => ({
      id: `afresh:${a.key}`,
      press: async (y) => {
        const row = seriesRow(y.seen);
        return row === undefined ? "404" : y.b.door(`again${i}`, split(row, (a.body as { scope: { at: string } }).scope.at, { title: "The new term" }));
      },
    })),
  ];
  const tried: string[] = [];
  /** The presses the door took in the trials of one press alone, by their ids. */
  const taken = new Set<string>();
  let x = first;
  let spent = false;
  // Nothing owed and every day of the intent there: the same press again under its key changes nothing, and the days are there.
  const owedAtFirst = owed(first.seen);
  const missingAtFirst = missing(first).length;
  let brought = !owedAtFirst && missingAtFirst === 0;
  let doubled = false;
  /** One press and every further request answered, on `x`: did it bring the days? The first sentence is read on the way. */
  const pressed = async (p: Press, before: readonly string[]): Promise<boolean> => {
    const said = await p.press(x);
    tried.push(`${[...before, p.id].join(" > ")}: ${said}`);
    // The door refused it (4xx), or it names nothing to press: the state is as it was.
    if (/^\d|^\(/.test(said)) return false;
    // The same press again where nothing is owed changes nothing: the state is as it was, and nothing follows.
    if (p.id === "the same press again" && !owed(x.seen)) return false;
    if (before.length === 0) taken.add(p.id);
    spent = true;
    const steps: Step[] = [...x.steps];
    x.seen = await x.b.seen();
    note(x.m, x.seen, x.b.calls());
    steps.push({ letter: p.id, said, rows: rowsOf(x.seen), requests: x.b.requests(), server: serverOf(x.seen) });
    const twice = daysTwice(x.m, x.seen) ?? await answered(x, steps);
    if (twice !== null) {
      finding("I1 no day twice", twice, steps, [...before, p.id, "turn"]);
      doubled = true;
      return false;
    }
    x.steps.splice(0, x.steps.length, ...steps);
    const lost = missing(x);
    if (lost.length > 0) tried[tried.length - 1] += ` -> ${lost.length} day(s) of the intent not at the server (${serverOf(x.seen)}; ${rowsOf(x.seen).join("; ")})`;
    return lost.length === 0;
  };
  /** The order walked again, where the state was spent: the same state, or the walk is not the same twice. */
  const again = async (): Promise<boolean> => {
    if (!spent) return true;
    if (x !== first) await close(x.b);
    x = await walkOrder(w, world, order);
    spent = false;
    if (x.sig === first.sig) return true;
    finding("the walk itself", `walked again, the order reached another state:\n${first.sig}\n${x.sig}`, x.steps);
    return false;
  };
  /**
   * The sentence's second half: one press EACH. The presses on a day and the days after it that stand with a refused write whose
   * retry the door took (the first part's where that is refused, else the second's) are all tried again, one after another, in
   * every order, each order on the order walked again: after each the server holds every day of the intent but days the presses
   * not yet tried again name, after the last every day, and no day twice on the way. Answers how many presses it took: 0 where
   * fewer than two presses stand so, or where it did not hold.
   */
  const eachPress = async (): Promise<number> => {
    const half = first.m.acts.filter((a) => a.kind === "split" && a.taken && !a.letGo).flatMap((a) => {
      const id = [`retry:${a.key}`, `retry:${a.key}:2`].find((r) => taken.has(r));
      return id === undefined ? [] : [{ id, key: id.slice("retry:".length), days: a.days }];
    });
    if (half.length < 2) return 0;
    for (const inOrder of permutations(half)) {
      if (!(await again())) return 0;
      spent = true;
      const steps: Step[] = [...x.steps];
      const done: string[] = [];
      for (const [i, press] of inOrder.entries()) {
        done.push(press.id);
        const said = await x.b.retry(press.key);
        if (/^\d|^\(/.test(said)) {
          tried.push(`${done.join(" > ")}: ${said}`);
          return 0;
        }
        x.seen = await x.b.seen();
        note(x.m, x.seen, x.b.calls());
        steps.push({ letter: press.id, said, rows: rowsOf(x.seen), requests: x.b.requests(), server: serverOf(x.seen) });
        const twice = daysTwice(x.m, x.seen) ?? await answered(x, steps);
        if (twice !== null) {
          finding("I1 no day twice", twice, steps, done.flatMap((id) => [id, "turn"]));
          doubled = true;
          return 0;
        }
        x.steps.splice(0, x.steps.length, ...steps);
        const later = new Set(inOrder.slice(i + 1).flatMap((other) => other.days));
        const lost = missing(x).filter((d) => !later.has(d));
        if (lost.length > 0) {
          tried.push(`${done.join(" > ")}: ${lost.length} day(s) of the intent not at the server that no press still to be tried again names (${serverOf(x.seen)}; ${rowsOf(x.seen).join("; ")})`);
          return 0;
        }
      }
      tried.push(`${done.join(" > ")}: every day of the intent`);
    }
    return half.length;
  };
  try {
    for (const p of pressesAt(first)) {
      if (!(await again())) return { found, stuck: false, late: false, each: 0 };
      if (await pressed(p, [])) brought = true;
    }
    // No one press brought the days: one press EACH, where more than one press is half carried out.
    const each = !brought && !doubled ? await eachPress() : 0;
    if (each > 0) brought = true;
    let late = false;
    if (!brought && !doubled && owedAtFirst) {
      // What is owed is answered first; then each press of the state at rest, each on the order walked again and answered so.
      const rest = async (): Promise<boolean> => {
        if (!(await again())) return false;
        spent = true;
        const steps: Step[] = [...x.steps];
        const twice = await answered(x, steps);
        x.steps.splice(0, x.steps.length, ...steps);
        return twice === null;
      };
      if (await rest()) {
        const count = pressesAt(x).length;
        for (let i = 0; i < count && !late; i++) {
          if (i > 0 && !(await rest())) break;
          const p = pressesAt(x)[i];
          if (p !== undefined && await pressed(p, ["turn"])) late = true;
        }
      }
    }
    // A press that broke the first sentence says nothing of the second: the state is walked on, and what broke is told above.
    const stuck = !brought && !late && !doubled;
    if (stuck) finding("I2 never stuck", `no press brings the days back: ${missingAtFirst || "some"} day(s) of the intent are nowhere. Tried: ${tried.join(" || ")}`, x.steps);
    // The sentence as it is written, at the state itself: no one press brought the days. A press made after a turn did.
    if (late) finding("I2 stuck for a turn", `no one press brings the days back at the state itself; a press made once what was owed had been answered does. Tried: ${tried.join(" || ")}`, x.steps);
    return { found, stuck, late, each };
  } finally {
    if (x !== first) await close(x.b);
  }
}

// ── the walk ─────────────────────────────────────────────────────────────────────

interface Tally {
  orders: number;
  nothing: number;
  proofs: number;
  /** The states repaired only by a press made once what was owed had been answered: each a finding (`I2 stuck for a turn`). */
  readonly late: string[];
  /** The states repaired by one press each of more than one press half carried out: the second sentence's second half. */
  readonly each: string[];
  exceptions: number;
  /** The orders in which the second decided exception was met: days doubled as it decides. */
  decided: number;
  readonly byDepth: Record<number, number>;
  readonly findings: Finding[];
}
const tally = (): Tally => ({ orders: 0, nothing: 0, proofs: 0, late: [], each: [], exceptions: 0, decided: 0, byDepth: {}, findings: [] });
const hash = (text: string): number => {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
};
/** A small generator of the same numbers from the same seed (mulberry32). */
const random = (seed: number) => (): number => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

async function pool<T>(items: readonly T[], each: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(AT_ONCE, items.length) }, async () => {
    while (next < items.length) await each(items[next++]!);
  }));
}

/**
 * One order: walked, both sentences asserted at its end. Answers the letters that can happen after it, or `null` where it is not
 * walked further. `drawn`: the order was drawn letter by letter, each of its letters kept because it changed something: walked
 * again its last letter must change something too, or the walk is not the same twice.
 */
async function tryOrder(w: World, world: WorldName, order: readonly string[], t: Tally, drawn = false): Promise<string[] | null> {
  const x = await walkOrder(w, world, order);
  const close = async (b: Bench): Promise<void> => { await b.close(); };
  const found = (sentence: Finding["sentence"], what: string): null => {
    t.findings.push({ sentence, world, order, what, steps: x.steps });
    return null;
  };
  try {
    t.orders += 1;
    t.byDepth[order.length] = (t.byDepth[order.length] ?? 0) + 1;
    if (x.steps.some((s) => /day\(s\) given up/.test(s.said))) t.exceptions += 1;
    if (x.m.decided.size > 0) t.decided += 1;
    const bad = x.steps.find((s) => /AND THE DOOR TAKES/.test(s.said));
    if (bad !== undefined) return found("the decided exception", bad.said);
    if (x.twice !== null) return found("I1 no day twice", x.twice);
    // Every letter before the last happened when the order before it was walked: here too, or the walk is not the same twice.
    if (x.steps.length !== order.length || x.steps.some((s) => s.said === "(cannot happen here)")) {
      return found("the walk itself", `walked again, the order stopped at its letter ${x.steps.length} of ${order.length}`);
    }
    if (x.nothing) {
      t.nothing += 1;
      return drawn ? found("the walk itself", "walked again, the order's last letter changed nothing, where it changed something when the order was drawn") : null;
    }
    const next = LETTERS.filter((l) => l.applies(x.m, x.seen)).map((l) => l.id);
    t.proofs += 1;
    const proof = await neverStuck(w, world, order, x, close);
    t.findings.push(...proof.found);
    if (proof.late) t.late.push(`[${world}] ${order.join(" > ")}`);
    if (proof.each > 0) t.each.push(`[${world}] ${order.join(" > ")}`);
    // A state no press repairs is not walked further: what follows it is told by the order that reached it.
    return proof.stuck ? null : next;
  } finally {
    await close(x.b);
  }
}

/**
 * Every order of the alphabet, in this process's share of them: of every letter `whole` admits to `depth`, and on
 * from there, to `deeper`, the orders made of the same-day letters alone.
 */
async function everyOrder(
  w: World, world: WorldName, o: { readonly depth: number; readonly deeper: number; readonly whole: (l: Letter) => boolean }, t: Tally,
  mine: (order: readonly string[]) => boolean,
): Promise<void> {
  const follows = (order: readonly string[], can: readonly string[]): string[] => {
    if (order.length < o.depth) return can.filter((id) => o.whole(letter(id)));
    return order.every((id) => letter(id).family) ? can.filter((id) => letter(id).family) : [];
  };
  const start = await walkOrder(w, world, []);
  let level: { readonly order: string[]; readonly can: string[] }[] = [{ order: [], can: LETTERS.filter((l) => l.applies(start.m, start.seen)).map((l) => l.id) }];
  await start.b.close();
  for (let d = 1; d <= Math.max(o.depth, o.deeper) && level.length > 0; d++) {
    const orders = level.flatMap(({ order, can }) => follows(order, can).map((id) => [...order, id]));
    // An order shorter than three letters is walked by every share (each needs what can follow it) and counted by the first.
    const walked = orders.filter((order) => order.length < 3 || mine(order));
    const next: { readonly order: string[]; readonly can: string[] }[] = [];
    await pool(walked, async (order) => {
      const can = await tryOrder(w, world, order, order.length >= 3 || SHARE.k === 0 ? t : tally());
      if (can !== null) next.push({ order, can });
    });
    level = next;
  }
}

/** A random order past `depth`, picked letter by letter from the seed among what can happen; every step of it past `depth` proved. */
async function randomOrder(w: World, index: number, depth: number, t: Tally): Promise<void> {
  const rnd = random(SEED ^ Math.imul(index + 1, 0x9e3779b1));
  const world: WorldName = rnd() < 0.85 ? "clock" : "days";
  const length = depth + 1 + Math.floor(rnd() * (BOUNDS.longest - depth));
  let n = 0;
  const x = await walkOrder(w, world, [], (can) => {
    if (n >= length || can.length === 0) return null;
    n += 1;
    let at = rnd() * can.reduce((sum, l) => sum + l.weight, 0);
    for (const l of can) {
      at -= l.weight;
      if (at < 0) return l;
    }
    return can.at(-1)!;
  });
  await x.b.close();
  // Its letters that changed nothing are left out, and a fault that met no request is the answered turn it was: the order
  // that is left is the order walked. (What a letter changed is read off the signature, which therefore tells time that passed
  // too: a wait left out here would be missing from the order walked again.)
  const kept = x.steps.flatMap((s, i) => (x.sigs[i] === x.sigs[i + 1] ? [] : [s.said === NOTHING ? "turn" : s.letter]));
  for (let d = Math.min(depth + 1, kept.length); d <= kept.length; d++) {
    if (await tryOrder(w, world, kept.slice(0, d), t, true) === null) break;
  }
}

const told = (f: Finding): string => [
  `${f.sentence} [${f.world}] ${f.order.join(" > ")}`, `  ${f.what}`,
  ...f.steps.map((s, i) => `  ${i + 1}. ${s.letter}: ${s.said}\n       rows: ${s.rows.join("; ") || "(none)"}\n       server: ${s.server}${s.requests.length === 0 ? "" : `\n       requests: ${s.requests.join("; ")}`}`),
].join("\n");

/**
 * What broke, by the way it broke (the sentence, and how the queue stood): of each way the shortest order whole, and the
 * others by their letters.
 */
function classes(findings: readonly Finding[]): string[] {
  const by = new Map<string, Finding[]>();
  for (const f of findings) {
    const stood = (f.steps.at(-1)?.rows ?? []).map((r) => r.replace(/ attempts=\d+/, "").replace(/ kept=.*$/, "")).join("; ");
    const key = `${f.sentence}: ${f.sentence === "I1 no day twice" ? f.what.replace(/:.*$/s, "").replace(/\d+ day\(s\)/, "days") : ""} [${stood}]`;
    by.set(key, [...(by.get(key) ?? []), f]);
  }
  return [...by.entries()].map(([key, all]) => {
    const sorted = [...all].sort((a, b) => a.order.length - b.order.length || a.order.join().localeCompare(b.order.join()));
    const others = [...new Set(sorted.slice(1).map((f) => `[${f.world}] ${f.order.join(" > ")}`))];
    return `${key}\n${told(sorted[0]!)}${others.length === 0 ? "" : `\n  and ${others.length} more order(s): ${others.slice(0, 6).join("; ")}${others.length > 6 ? "; ..." : ""}`}`;
  }).sort();
}

function evidence(name: string, data: unknown): void {
  if (ENV.OHCAL_WALK_EVID === undefined) return;
  mkdirSync(ENV.OHCAL_WALK_EVID, { recursive: true });
  writeFileSync(join(ENV.OHCAL_WALK_EVID, `${name}-${SHARE.k + 1}of${SHARE.n}.json`), `${JSON.stringify(data, null, 1)}\n`);
}

describe.skipIf(!AVAILABLE)("the walk: every order of what can happen around a press on a day of a series and the days after it", () => {
  let w: World;
  beforeAll(async () => { w = await openWorld(2 * AT_ONCE + 2); }, 120_000);
  afterAll(async () => { await w?.close(); });
  const mine = (order: readonly string[]): boolean => hash(order.slice(0, 3).join(">")) % SHARE.n === SHARE.k;
  const said = (name: string, t: Tally, startedAt: number): void => {
    const line = `THE WALK ${name}: ${t.orders} orders (${Object.entries(t.byDepth).map(([d, n]) => `depth ${d}: ${n}`).join(", ")}), ${t.nothing} of them changed nothing, `
      + `${t.proofs} states' repair tried (${t.late.length} of them repaired only by a press made once what was owed had been answered, ${t.each.length} by one press each of more than one press half carried out), the first decided exception met in ${t.exceptions}, the second in ${t.decided}, `
      + `${t.findings.length} broke a sentence in ${classes(t.findings).length} way(s); share ${SHARE.k + 1} of ${SHARE.n}, seed ${SEED}, ${Math.round((Date.now() - startedAt) / 100) / 10} s`;
    console.log(line);
    evidence(name.replace(/[^a-z0-9]+/gi, "-"), { line, seed: SEED, share: SHARE, tally: { ...t, findings: undefined }, findings: t.findings });
  };

  if (ENV.OHCAL_WALK_ORDER !== undefined) {
    it("walks the one order asked for, and prints it", async () => {
      const [, place, text] = /^(?:(clock|days):)?(.*)$/.exec(ENV.OHCAL_WALK_ORDER!)!;
      const order = text!.split(",").map((s) => s.trim()).filter((s) => s !== "");
      const t = tally();
      const next = await tryOrder(w, (place as WorldName | undefined) ?? "clock", order, t);
      const x = await walkOrder(w, (place as WorldName | undefined) ?? "clock", order);
      await x.b.close();
      const decided = x.m.decided.size === 0 ? "" : `; the second decided exception met: ${[...x.m.decided].sort().join(", ")} doubled as it decides`;
      const each = t.each.length === 0 ? "" : "; its end is repaired by one press each of more than one press half carried out, in every order";
      console.log(told({ sentence: "the walk itself", world: (place as WorldName | undefined) ?? "clock", order, what: `as walked; can follow: ${next === null ? "(not walked further)" : next.join(", ")}${decided}${each}`, steps: x.steps }));
      expect(classes(t.findings)).toEqual([]);
    }, 120_000);
    return;
  }

  it(`holds both sentences after every order of the whole alphabet to depth ${DEPTH}, and of the same-day letters to depth ${FAMILY_DEPTH}`, async () => {
    const t = tally();
    const startedAt = Date.now();
    await everyOrder(w, "clock", { depth: DEPTH, deeper: FAMILY_DEPTH, whole: () => true }, t, mine);
    said(`every order to depth ${DEPTH}, of the same-day letters to depth ${FAMILY_DEPTH}, at a clock time`, t, startedAt);
    expect(classes(t.findings)).toEqual([]);
  }, 3_600_000);

  it(`holds both sentences after every order of the whole days' letters to depth ${DAYS_DEPTH}`, async () => {
    const t = tally();
    const startedAt = Date.now();
    await everyOrder(w, "days", { depth: DAYS_DEPTH, deeper: 0, whole: (l) => l.family || WHOLE_DAYS.includes(l.id) }, t, mine);
    said(`every order of the whole days' letters to depth ${DAYS_DEPTH}`, t, startedAt);
    expect(classes(t.findings)).toEqual([]);
  }, 3_600_000);

  it(`holds both sentences after every step of ${ORDERS} random longer orders (seed ${SEED})`, async () => {
    const t = tally();
    const startedAt = Date.now();
    const indexes = Array.from({ length: ORDERS }, (_, i) => i).filter((i) => i % SHARE.n === SHARE.k);
    await pool(indexes, (i) => randomOrder(w, i, DEPTH, t));
    said(`${ORDERS} random orders past depth ${DEPTH}`, t, startedAt);
    expect(classes(t.findings)).toEqual([]);
  }, 3_600_000);
});
