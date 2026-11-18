/**
 * THE CALENDAR'S CONTRACT, HELD: what is set ahead to ring, and what the page leaves the phone.
 * An alert set ahead rings with the app closed, on a locked screen, so everything it carries is a
 * number, a closed word, an id, or an event's label. One maker mints an alert and one makes a set;
 * whatever crosses to a native side is read closed, member by member: a spare member, a word
 * outside its list or a number outside its range is no record at all.
 *
 * The suite's runner strips types, so the last case compiles this file itself and expects it clean.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  AHEAD_DAYS, AHEAD_ID_MAX, AHEAD_LATE_MS, AHEAD_MAX, CALENDAR_SNAPSHOT_FILE, CALENDAR_SNAPSHOT_VERSION, NOTICE_LEAD_MAX_MIN,
  SNAPSHOT_DAYS, SNAPSHOT_DAY_EVENTS_MAX, aheadAlert, aheadSet, readAhead, readAheadSet, readCalendarSnapshot,
  type AheadSet, type CalendarSnapshot, type NoticeAct, type NoticeAhead, type NoticeEmitter, type SnapshotEvent,
} from "@ohmail/client-engine";

const HERE = fileURLToPath(import.meta.url);
const MIN = 60_000;
const DAY = 86_400_000;
/** Tuesday 10 November 2026, 09:24 UTC: the demo's morning. */
const NOW = Date.UTC(2026, 10, 10, 9, 24);
const TWO = Date.UTC(2026, 10, 10, 14, 0);

type HoldsText<T> = string extends T ? true
  : T extends readonly (infer E)[] ? HoldsText<E>
  : T extends object ? (true extends { [K in keyof T]-?: HoldsText<T[K]> }[keyof T] ? true : false)
  : false;
type FreeText<T> = T extends unknown ? { [K in keyof T]-?: true extends HoldsText<T[K]> ? K : never }[keyof T] : never;
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Holds<T extends true> = T;

/** An alert takes two ids and its label; a set its scope and its alerts. Nothing else can hold text. */
export type AnAlertTakesItsIdsAndItsLabel = Holds<Same<FreeText<NoticeAhead>, "id" | "eventId" | "label">>;
export type ASetTakesItsScopeAndItsAlerts = Holds<Same<FreeText<AheadSet>, "scope" | "alerts">>;
export type AnAlertHasEightMembers = Holds<Same<keyof NoticeAhead, "id" | "eventId" | "atMs" | "startMs" | "allDay" | "label" | "leadMin" | "acts">>;

const shown = { id: "0b6f5c1e-2f0a-4c55-9d53-1f0d6b0a7c11", title: "Catalogue weekly", private: false, heldBack: false };
const when = { startMs: TWO, allDay: false, leadMin: 10, acts: ["join", "again"] as readonly NoticeAct[] };
const alert = (over: Partial<typeof when> = {}, event = shown): NoticeAhead => aheadAlert(event, true, { ...when, ...over })!;

describe("what the compiler refuses", () => {
  it("a surface that does not say whether it sets alerts, and an alert with words of its own", () => {
    const post = (): void => {};
    // @ts-expect-error a surface answers the calendar's half: a function, or `none` in words
    const silent: NoticeEmitter = { carries: [], acts: [], post };
    // @ts-expect-error nothing unsaid stands for "cannot": no default
    const unsaid: NoticeEmitter = { carries: [], acts: [], post, ahead: undefined };
    const cannot: NoticeEmitter = { carries: [], acts: [], post, ahead: "none" };
    const sets: NoticeEmitter = { carries: ["cal_alert"], acts: [], post, ahead: (set) => { void set.scope; } };
    // @ts-expect-error an alert has no place for a sentence
    const worded: NoticeAhead = { ...alert(), body: "14:00 in the main hall" };
    // @ts-expect-error nor for where the event is, who is invited or what its notes say
    const placed: NoticeAhead = { ...alert(), place: "Main hall" };
    // @ts-expect-error a set is one scope's: an alert carries none of its own
    const scoped: NoticeAhead = { ...alert(), scope: "another" };
    expect([silent, unsaid, cannot, sets].map((e) => typeof e.ahead)).toEqual(["undefined", "undefined", "string", "function"]);
    expect([worded, placed, scoped]).toHaveLength(3);
  });

  it("this file type-checks clean under the options its folder is checked with", () => {
    const said = (d: ts.Diagnostic): string => ts.flattenDiagnosticMessageText(d.messageText, " ");
    const parsed = ts.getParsedCommandLineOfConfigFile(join(dirname(HERE), "..", "tsconfig.test-dirs.json"), {}, {
      ...ts.sys, onUnRecoverableConfigFileDiagnostic: (d) => { throw new Error(said(d)); },
    })!;
    const program = ts.createProgram({ rootNames: [HERE], options: parsed.options });
    const self = program.getSourceFile(HERE)!;
    const read = program.getSourceFiles().map((f) => f.fileName.replace(/\\/g, "/"));
    expect(read.some((f) => f.endsWith("/packages/client-engine/src/notices/emitter.ts"))).toBe(true);
    const refused = [...parsed.errors, ...program.getSyntacticDiagnostics(self), ...program.getSemanticDiagnostics(self)].map((d) =>
      `${d.file && d.start !== undefined ? `line ${d.file.getLineAndCharacterOfPosition(d.start).line + 1}` : "options"}: TS${d.code} ${said(d)}`);
    expect(refused).toEqual([]);
  }, 120_000);
});

describe("an alert set ahead is made in one place", () => {
  it("rings its lead before the start, under an id of its own occurrence and alarm", () => {
    expect(aheadAlert(shown, true, when)).toEqual({
      id: `${shown.id}.${TWO}.10`, eventId: shown.id, atMs: TWO - 10 * MIN, startMs: TWO, allDay: false,
      label: { as: "title", text: "Catalogue weekly" }, leadMin: 10, acts: ["join", "again"],
    });
    // Another start, or another alarm of the same start, is another alert: a moved occurrence leaves its old id behind.
    const ids = [alert(), alert({ startMs: TWO + 30 * MIN }), alert({ leadMin: 0 }), alert({}, { ...shown, id: "another" })].map((a) => a.id);
    expect(new Set(ids).size).toBe(4);
    for (const id of ids) expect(id.length).toBeLessThanOrEqual(AHEAD_ID_MAX);
    expect(alert({}, { ...shown, id: "x".repeat(128) }).id.length).toBeLessThanOrEqual(AHEAD_ID_MAX);
  });

  it("a whole day's alert rings its lead before the day starts", () => {
    const day = Date.UTC(2026, 10, 12, 23, 0); // local midnight of a zone an hour ahead
    expect(alert({ startMs: day, allDay: true, leadMin: 900 })).toMatchObject({ atMs: day - 900 * MIN, startMs: day, allDay: true, leadMin: 900 });
  });

  it("a lead is a whole number of minutes from none to four weeks: any such number rings, any other makes no alert", () => {
    // The product's own steps, and an event's own alarms from its provider, which may be any number.
    for (const leadMin of [0, 5, 10, 15, 30, 60, 120, 1440, 2880, 10080, 1, 7, 45, 90, 1441, 20_000, NOTICE_LEAD_MAX_MIN]) {
      expect(alert({ leadMin }), String(leadMin)).toMatchObject({ leadMin, atMs: TWO - leadMin * MIN });
    }
    for (const leadMin of [-1, -0.5, 1.5, NOTICE_LEAD_MAX_MIN + 1, Number.NaN, Number.POSITIVE_INFINITY, "10" as never, null as never]) {
      expect(aheadAlert(shown, true, { ...when, leadMin }), String(leadMin)).toBeNull();
    }
  });

  it("a start that is no instant, or an id that could be words, makes no alert", () => {
    for (const startMs of [-1, 1.5, Number.NaN, 8.64e15 + 1, "0" as never]) expect(aheadAlert(shown, true, { ...when, startMs }), String(startMs)).toBeNull();
    // A lead that reaches before the first instant.
    expect(aheadAlert(shown, true, { ...when, startMs: 5 * MIN, leadMin: 10 })).toBeNull();
    for (const id of ["", "an id with words", "x".repeat(129), "a\nb", "a/b"]) expect(aheadAlert({ ...shown, id }, true, when), id).toBeNull();
  });

  it("names the event as the label says, and takes nothing else of what it was handed", () => {
    expect(aheadAlert({ ...shown, heldBack: true }, true, when)).toBeNull();
    expect(alert({}, { ...shown, private: true }).label).toEqual({ as: "busy" });
    expect(aheadAlert(shown, false, when)!.label).toEqual({ as: "event" });
    const loud = { ...shown, notes: "Zqnotes", place: "Zqplace", organizer: { name: "Zqorganizer" }, invitees: [{ address: "zq@example.org" }] };
    const made = aheadAlert(loud as never, true, { ...when, allDay: "yes" as never, acts: ["again", "again", "open" as never], zone: "Zqzone" } as never)!;
    expect(Object.keys(made).sort()).toEqual(["acts", "allDay", "atMs", "eventId", "id", "label", "leadMin", "startMs"]);
    expect(made).toMatchObject({ allDay: false, acts: ["again"] });
    expect(JSON.stringify(made).toLowerCase()).not.toContain("zq");
  });
});

describe("a set is one scope's alerts, bounded", () => {
  const many = (n: number, stepMs = MIN): NoticeAhead[] => Array.from({ length: n }, (_, i) => alert({ startMs: TWO + i * stepMs }));

  it("ascending by their minute, each id once, the nearest first when there are too many", () => {
    const late = alert({ startMs: TWO + 3 * DAY });
    const soon = alert({ leadMin: 30 });
    const set = aheadSet("mb-1", [late, alert(), soon, alert()], NOW)!;
    expect(set.scope).toBe("mb-1");
    expect(set.alerts.map((a) => a.id)).toEqual([soon.id, alert().id, late.id]);
    const cut = aheadSet("mb-1", many(AHEAD_MAX + 9).reverse(), NOW)!;
    expect(cut.alerts).toHaveLength(AHEAD_MAX);
    expect(cut.alerts[0]!.startMs).toBe(TWO);
    expect(cut.alerts.every((a, i, all) => i === 0 || all[i - 1]!.atMs <= a.atMs)).toBe(true);
  });

  it("holds nothing whose minute passed longer ago than an alert may ring late, and nothing further ahead than the window", () => {
    const passed = alert({ startMs: NOW + 5 * MIN });                          // its minute was five minutes ago
    const tooLate = alert({ startMs: NOW + 10 * MIN - AHEAD_LATE_MS - 1 });    // one millisecond past the bound
    const justPassed = alert({ startMs: NOW + 10 * MIN - AHEAD_LATE_MS });     // the last instant it may still ring
    const atNow = alert({ startMs: NOW + 10 * MIN });                          // rings this very minute
    const edge = alert({ startMs: NOW + AHEAD_DAYS * DAY + 10 * MIN });        // the window's last instant
    const beyond = alert({ startMs: NOW + AHEAD_DAYS * DAY + 10 * MIN + 1 });  // one millisecond further
    expect(aheadSet("mb-1", [passed, tooLate, justPassed, atNow, edge, beyond], NOW)!.alerts.map((a) => a.id))
      .toEqual([justPassed.id, atNow.id, edge.id]);
    expect(aheadSet("mb-1", [], NOW)).toEqual({ scope: "mb-1", alerts: [] });
    expect(AHEAD_LATE_MS).toBe(2 * MIN);
  });

  it("a scope that is no account's id makes no set, and an alert not made by the maker is left out", () => {
    for (const scope of ["", "local scope", "demo:fixtures", "x".repeat(129), "a/b", null as never, 7 as never]) {
      expect(aheadSet(scope, [alert()], NOW), String(scope)).toBeNull();
    }
    expect(aheadSet("mb-1", [alert()], Number.NaN)).toBeNull();
    const forged = { ...alert(), label: { as: "title", text: "Zq‮title", html: "<b>" }, body: "Zqbody" } as unknown as NoticeAhead;
    const wrongLead = { ...alert({ leadMin: 30 }), leadMin: 99_999 };
    const set = aheadSet("mb-1", [forged, wrongLead, alert({ leadMin: 5 })], NOW)!;
    // The forged one is read closed (a spare member: no alert); the other's lead is out of its range.
    expect(set.alerts.map((a) => a.id)).toEqual([alert({ leadMin: 5 }).id]);
  });
});

describe("what crosses to a native side is read closed", () => {
  const good = alert();
  const raw = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ ...JSON.parse(JSON.stringify(good)), ...over });

  it("an alert with exactly its eight members, each of its own kind, is read as a copy", () => {
    const handed = raw();
    const read = readAhead(handed)!;
    expect(read).toEqual(good);
    expect(read).not.toBe(handed);
    expect(read.label).not.toBe(handed.label);
    expect(readAhead(raw({ label: { as: "busy" }, acts: [] }))).toMatchObject({ label: { as: "busy" }, acts: [] });
    expect(readAhead(raw({ label: { as: "event" } }))).toMatchObject({ label: { as: "event" } });
  });

  it("a spare member, a missing one, an inherited one or anything that is no plain record is none", () => {
    for (const spare of ["title", "body", "subject", "sender", "place", "notes", "scope", "url", "__proto__x"]) {
      expect(readAhead(raw({ [spare]: "Zq" })), spare).toBeNull();
    }
    for (const missing of Object.keys(good)) {
      const less = raw();
      delete less[missing];
      expect(readAhead(less), missing).toBeNull();
      // The member inherited instead of owned.
      expect(readAhead(Object.assign(Object.create({ [missing]: (good as never)[missing] }), less)), `inherited ${missing}`).toBeNull();
    }
    const withSymbol = raw();
    (withSymbol as Record<symbol, unknown>)[Symbol("spare")] = 1;
    expect(readAhead(withSymbol)).toBeNull();
    for (const not of [null, undefined, "alert", 7, [good], new Map(), () => good]) expect(readAhead(not)).toBeNull();
  });

  it("a word outside its list, a number outside its range or a text that is no id is none", () => {
    const wrong: Record<string, unknown>[] = [
      { id: "an id with words" }, { id: "x".repeat(AHEAD_ID_MAX + 1) }, { id: 7 }, { eventId: "a b" }, { eventId: "" },
      { atMs: -1 }, { atMs: 1.5 }, { atMs: "0" }, { startMs: 8.64e15 + 1 }, { startMs: null },
      { allDay: "false" }, { allDay: 0 }, { leadMin: -1 }, { leadMin: 1.5 }, { leadMin: NOTICE_LEAD_MAX_MIN + 1 }, { leadMin: "10" },
      { acts: "join" }, { acts: ["open"] }, { acts: ["join", "join"] }, { acts: ["again", "join"] }, { acts: [7] }, { acts: { 0: "join", length: 1 } },
      { label: "Busy" }, { label: null }, { label: { as: "titled", text: "x" } }, { label: { as: "busy", text: "x" } }, { label: { as: "event", why: 1 } },
      { label: { as: "title" } }, { label: { as: "title", text: 7 } }, { label: { as: "title", text: "" } }, { label: { as: "title", text: "​‮" } },
      { label: { as: "title", text: "x", html: "<b>x</b>" } }, { label: ["title", "x"] },
      // The minute it rings is the start less the lead, for every alert.
      { atMs: good.atMs + MIN }, { startMs: good.startMs + MIN },
    ];
    for (const over of wrong) expect(readAhead(raw(over)), JSON.stringify(over)).toBeNull();
  });

  it("a title is taken as one clean line, never as it was handed", () => {
    const read = readAhead(raw({ label: { as: "title", text: "  Zq‮title\n<b>second</b>​  " } }))!;
    expect(read.label).toEqual({ as: "title", text: "Zqtitle <b>second</b>" });
    expect((readAhead(raw({ label: { as: "title", text: "é".repeat(500) } }))!.label as { text: string }).text).toHaveLength(80);
  });

  it("a set is read with its scope, at most its bound of alerts, ascending, each id once", () => {
    const two = [alert({ leadMin: 30 }), alert()];
    const set = JSON.parse(JSON.stringify({ scope: "mb-1", alerts: two })) as Record<string, unknown>;
    expect(readAheadSet(set)).toEqual({ scope: "mb-1", alerts: two });
    expect(readAheadSet({ scope: "mb-1", alerts: [] })).toEqual({ scope: "mb-1", alerts: [] });
    const refused: unknown[] = [
      { ...set, scope: "demo:fixtures" }, { ...set, scope: "" }, { ...set, scope: 7 }, { alerts: two }, { scope: "mb-1" },
      { ...set, live: true }, { ...set, alerts: [...two].reverse() }, { ...set, alerts: [two[0], two[0]] },
      { ...set, alerts: [two[0], { ...two[1], body: "Zq" }] }, { ...set, alerts: "none" }, { ...set, alerts: { length: 0 } },
      { ...set, alerts: Array.from({ length: AHEAD_MAX + 1 }, (_, i) => alert({ startMs: TWO + i * MIN })) },
      [set], null, "set",
    ];
    for (const not of refused) expect(readAheadSet(not), JSON.stringify(not)?.slice(0, 80)).toBeNull();
    // One alert that is none refuses the whole set: a ringer never holds half of what the page meant.
    expect(readAheadSet({ ...set, alerts: [two[0], null] })).toBeNull();
  });
});

describe("the page's record for the phone, version 1", () => {
  const event: SnapshotEvent = { eventId: shown.id, label: { as: "title", text: "Catalogue weekly" }, startMs: TWO, endMs: TWO + 60 * MIN, allDay: false, toAnswer: false };
  const snapshot = (): CalendarSnapshot => ({
    v: CALENDAR_SNAPSHOT_VERSION, scope: "mb-1", writtenAt: NOW, zone: "Europe/Zurich",
    alerts: [alert({ leadMin: 30 }), alert()],
    days: [
      { year: 2026, date: { month: 11, dom: 10, dow: 2 }, events: [event, { ...event, eventId: "e-2", label: { as: "busy" }, endMs: null, allDay: true, toAnswer: true }], more: 0 },
      { year: 2026, date: { month: 11, dom: 11, dow: 3 }, events: [], more: 2 },
      { year: 2026, date: { month: 11, dom: 12, dow: 4 }, events: [], more: 0 },
    ],
    month: { year: 2026, month: 11, marked: [3, 10, 11, 30] },
    toAnswer: 3,
    summary: { atMs: NOW + DAY, events: 4, first: { hour: 9, minute: 0, day: "tomorrow" }, toAnswer: 3 },
  });
  const raw = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ ...JSON.parse(JSON.stringify(snapshot())), ...over });
  const day = (over: Record<string, unknown>): Record<string, unknown> => ({ ...(raw().days as Record<string, unknown>[])[0]!, ...over });

  it("is named once, and carries the scope it was written under", () => {
    expect(CALENDAR_SNAPSHOT_FILE).toBe("ohcal-snapshot.json");
    expect(CALENDAR_SNAPSHOT_VERSION).toBe(1);
    const read = readCalendarSnapshot(raw())!;
    expect(read).toEqual(snapshot());
    expect(read.scope).toBe("mb-1");
    expect(readCalendarSnapshot(raw({ summary: null }))).toMatchObject({ summary: null });
  });

  it("another version, a spare member or a missing one is no record", () => {
    for (const v of [0, 2, "1", null]) expect(readCalendarSnapshot(raw({ v })), String(v)).toBeNull();
    for (const spare of ["account", "address", "titles", "calendars", "token"]) expect(readCalendarSnapshot(raw({ [spare]: "Zq" })), spare).toBeNull();
    for (const missing of Object.keys(snapshot())) {
      const less = raw();
      delete less[missing];
      expect(readCalendarSnapshot(less), missing).toBeNull();
    }
    for (const not of [null, "{}", [], 1]) expect(readCalendarSnapshot(not)).toBeNull();
  });

  it("every member is read closed, to its bound", () => {
    const wrong: Record<string, unknown>[] = [
      { scope: "demo:fixtures" }, { scope: "" }, { writtenAt: -1 }, { writtenAt: "now" },
      { zone: "" }, { zone: "Europe/Zurich; rm" }, { zone: "x".repeat(65) }, { zone: 1 },
      { alerts: [{ ...alert(), body: "Zq" }] }, { alerts: [alert(), alert({ leadMin: 30 })] }, { alerts: "none" },
      { days: "today" }, { days: [day({}), day({}), day({}), day({})] },
      { days: [day({ year: 0 })] }, { days: [day({ date: { month: 13, dom: 1, dow: 0 } })] }, { days: [day({ date: { month: 1, dom: 1, dow: 0, name: "Zq" } })] },
      { days: [day({ more: -1 })] }, { days: [day({ more: 1.5 })] }, { days: [day({ note: "Zq" })] },
      { days: [day({ events: Array.from({ length: SNAPSHOT_DAY_EVENTS_MAX + 1 }, () => event) })] },
      { days: [day({ events: [{ ...event, place: "Zqplace" }] })] }, { days: [day({ events: [{ ...event, label: { as: "title", text: "x", by: "Zq" } }] })] },
      { days: [day({ events: [{ ...event, endMs: "later" }] })] }, { days: [day({ events: [{ ...event, endMs: event.startMs - 1 }] })] },
      { days: [day({ events: [{ ...event, toAnswer: "yes" }] })] }, { days: [day({ events: [{ ...event, eventId: "an id with words" }] })] },
      { month: { year: 2026, month: 0, marked: [] } }, { month: { year: 2026, month: 11, marked: [10, 3] } }, { month: { year: 2026, month: 11, marked: [3, 3] } },
      { month: { year: 2026, month: 11, marked: [32] } }, { month: { year: 2026, month: 11, marked: [], name: "November" } }, { month: null },
      { toAnswer: -1 }, { toAnswer: 10_000 }, { toAnswer: "3" },
      { summary: { atMs: NOW, events: 4, first: { hour: 24, minute: 0, day: "today" }, toAnswer: 3 } },
      { summary: { atMs: NOW, events: 4, first: null, toAnswer: 3, title: "Zq" } }, { summary: { atMs: NOW, events: -1, first: null, toAnswer: 0 } }, { summary: "none" },
    ];
    for (const over of wrong) expect(readCalendarSnapshot(raw(over)), JSON.stringify(over).slice(0, 100)).toBeNull();
    expect(SNAPSHOT_DAYS).toBe(3);
  });
});
