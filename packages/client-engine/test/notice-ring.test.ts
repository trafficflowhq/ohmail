/**
 * WHO HEARS A CALENDAR ALERT, AND WHEN. An alert is asked for twice: when the calendar's alerts are
 * made (does this event ring at all, and for which of its alarms), and again the moment one is due
 * (is the account it was set under still the signed-in one, does the calendar still want it, is it
 * not too late for its words to be true). After an account switch, a sign-out, a moved or deleted
 * event, a removed alarm or a declined invitation nothing rings, and what was set under the account
 * left is gone, not waiting.
 *
 * The scripted cases are one table (`notice-ring-cases.json`), which the desktop shell's own book
 * is held to as well.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  AHEAD_LATE_MS, AlertBook, NOTICE_LEAD_MAX_MIN, aheadAlert, dueNotice, eventRings, mayRing, readAhead, ringingLeads,
  type AheadSet, type NoticeAhead, type RungCalendar, type RungEvent,
} from "@ohmail/client-engine";

interface Step {
  set?: { scope: string; alerts: string[] };
  clear?: true;
  due?: { live: string | null; at: string; plusMs: number };
  rings?: string[];
  next?: string | null;
}
const TABLE = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "notice-ring-cases.json"), "utf8")) as {
  lateMs: number; alerts: Record<string, NoticeAhead>; cases: { name: string; steps: Step[] }[];
};
const named = (name: string): NoticeAhead => {
  const alert = TABLE.alerts[name];
  if (alert === undefined) throw new Error(`the table names no alert ${name}`);
  return alert;
};
const nameOf = (id: string): string => Object.keys(TABLE.alerts).find((name) => TABLE.alerts[name]!.id === id) ?? id;

describe("the table is the maker's own alerts", () => {
  it("each alert is what aheadAlert makes for its event, start and lead, and reads closed as itself", () => {
    expect(TABLE.lateMs).toBe(AHEAD_LATE_MS);
    for (const [name, alert] of Object.entries(TABLE.alerts)) {
      const label = alert.label;
      const event = { id: alert.eventId, title: label.as === "title" ? label.text : "hidden", private: label.as === "busy", heldBack: false };
      const made = aheadAlert(event, label.as !== "event", { startMs: alert.startMs, allDay: alert.allDay, leadMin: alert.leadMin, acts: alert.acts });
      expect(made, name).toEqual(alert);
      expect(readAhead(alert), name).toEqual(alert);
    }
  });
});

describe("the page's book, by the table", () => {
  for (const scripted of TABLE.cases) {
    it(scripted.name, () => {
      const book = new AlertBook();
      scripted.steps.forEach((step, i) => {
        const where = `step ${i + 1} of "${scripted.name}"`;
        if (step.set) book.set({ scope: step.set.scope, alerts: step.set.alerts.map(named) });
        else if (step.clear) book.clear();
        else if (step.due) {
          const rang = book.due(step.due.live, named(step.due.at).atMs + step.due.plusMs).map((a) => nameOf(a.id));
          expect(rang, where).toEqual(step.rings ?? []);
        } else if ("next" in step) expect(book.nextAtMs(), where).toBe(step.next == null ? null : named(step.next).atMs);
        else throw new Error(`${where} is no step`);
      });
    });
  }
});

describe("the book beyond the table", () => {
  const weekly = named("weekly10");
  const set = (scope: string, ...alerts: NoticeAhead[]): AheadSet => ({ scope, alerts });

  it("a set that is not read closed leaves nothing to ring", () => {
    const book = new AlertBook();
    book.set(set("mb-1", weekly));
    book.set({ scope: "mb-1", alerts: [{ ...weekly, body: "Zqbody" } as unknown as NoticeAhead] });
    expect(book.scope()).toBeNull();
    expect(book.due("mb-1", weekly.atMs)).toEqual([]);
    book.set(set("demo:fixtures", weekly));
    expect(book.due("demo:fixtures", weekly.atMs)).toEqual([]);
  });

  it("holds a copy: what a caller does to its own set afterwards changes nothing", () => {
    const book = new AlertBook();
    const mine = { scope: "mb-1", alerts: [{ ...weekly, label: { as: "title" as const, text: "Catalogue weekly" } }] };
    book.set(mine);
    (mine.alerts[0]!.label as { text: string }).text = "Zqchanged";
    (mine as { scope: string }).scope = "mb-2";
    expect(book.scope()).toBe("mb-1");
    expect(book.due("mb-1", weekly.atMs)).toEqual([weekly]);
  });

  it("the one question, asked of any ringer: its set, who is signed in, and the time", () => {
    const held = set("mb-1", weekly, named("books60"));
    const ask = { held, live: "mb-1", nowMs: weekly.atMs };
    expect(mayRing(weekly, ask)).toBe(true);
    expect(mayRing(weekly, { ...ask, nowMs: weekly.atMs - 1 }), "before its minute").toBe(false);
    expect(mayRing(weekly, { ...ask, nowMs: weekly.atMs + AHEAD_LATE_MS + 1 }), "too late").toBe(false);
    expect(mayRing(weekly, { ...ask, live: "mb-2" }), "another account").toBe(false);
    expect(mayRing(weekly, { ...ask, live: null }), "nobody signed in").toBe(false);
    expect(mayRing(weekly, { ...ask, live: "" }), "no scope").toBe(false);
    expect(mayRing(weekly, { ...ask, held: null }), "no set").toBe(false);
    expect(mayRing(weekly, { ...ask, held: set("mb-1", named("books60")) }), "no longer in the set").toBe(false);
    expect(mayRing(named("weeklyMoved10"), { ...ask, nowMs: named("weeklyMoved10").atMs }), "an alert the set never held").toBe(false);
    // A set and a live scope that agree on a word that is no account's: nothing.
    expect(mayRing(weekly, { held: { scope: "demo:fixtures", alerts: [weekly] }, live: "demo:fixtures", nowMs: weekly.atMs })).toBe(false);
  });
});

describe("which events ring at all, and for which alarms", () => {
  const shown: RungCalendar = { shown: true };
  const event = (over: Partial<RungEvent> = {}): RungEvent => ({
    status: "confirmed", myAnswer: null, heldBack: false,
    alarms: [{ minutesBefore: 10, method: "notice" }, { minutesBefore: 0, method: "notice" }], ...over,
  });

  it("an event on a shown calendar, not called off, shown and not declined, rings its notice alarms", () => {
    expect(eventRings(event(), shown)).toBe(true);
    expect(ringingLeads(event(), shown)).toEqual([0, 10]);
    for (const myAnswer of [null, "none", "accepted", "tentative", "delegated"] as const) expect(eventRings(event({ myAnswer }), shown), String(myAnswer)).toBe(true);
    expect(eventRings(event({ status: "tentative" }), shown)).toBe(true);
  });

  it("deleted, called off, declined, held back, or on a calendar that is gone or not shown: no alarm rings", () => {
    const silent: [string, RungEvent | null | undefined, RungCalendar | null | undefined][] = [
      ["an event deleted", null, shown], ["an event the copy never held", undefined, shown],
      ["an event called off", event({ status: "cancelled" }), shown],
      ["an invitation declined", event({ myAnswer: "declined" }), shown],
      ["an invitation not yet shown", event({ heldBack: true }), shown],
      ["a calendar removed", event(), null], ["a calendar never read", event(), undefined],
      ["a calendar not shown", event(), { shown: false }],
      // A word or a value the rule does not know never rings.
      ["a status of another word", event({ status: "postponed" as never }), shown],
      ["held back unsaid", event({ heldBack: undefined as never }), shown],
      ["shown unsaid", event(), { shown: "yes" as never }],
    ];
    for (const [why, e, calendar] of silent) {
      expect(eventRings(e, calendar), why).toBe(false);
      expect(ringingLeads(e, calendar), why).toEqual([]);
    }
  });

  it("an alarm removed is not rung; a letter's alarm never rings; a lead out of its range is kept and not rung here", () => {
    expect(ringingLeads(event({ alarms: [] }), shown)).toEqual([]);
    expect(ringingLeads(event({ alarms: [{ minutesBefore: 10, method: "mail" }] }), shown)).toEqual([]);
    expect(ringingLeads(event({ alarms: [{ minutesBefore: 10, method: "sms" as never }] }), shown)).toEqual([]);
    const mixed = [
      { minutesBefore: 45, method: "notice" as const }, { minutesBefore: 45, method: "notice" as const }, { minutesBefore: 5, method: "notice" as const },
      { minutesBefore: NOTICE_LEAD_MAX_MIN, method: "notice" as const }, { minutesBefore: NOTICE_LEAD_MAX_MIN + 1, method: "notice" as const },
      { minutesBefore: -5, method: "notice" as const }, { minutesBefore: 7.5, method: "notice" as const }, { minutesBefore: "10" as never, method: "notice" as const },
      null as never, "10" as never,
    ];
    // An event's own alarms from its provider, any whole number of minutes: each once, ascending.
    expect(ringingLeads(event({ alarms: mixed }), shown)).toEqual([5, 45, NOTICE_LEAD_MAX_MIN]);
    expect(ringingLeads(event({ alarms: "none" as never }), shown)).toEqual([]);
  });
});

describe("the notice an alert becomes when its minute has come", () => {
  const two = { hour: 14, minute: 0, day: "today" as const };
  const weekly = named("weekly10");

  it("is the alert read closed again, with its start as the reader's clock says it, and only the acts the surface carries", () => {
    const acting = aheadAlert({ id: "ev-weekly", title: "Catalogue weekly", private: false, heldBack: false }, true,
      { startMs: weekly.startMs, allDay: false, leadMin: 10, acts: ["join", "again"] })!;
    expect(dueNotice(acting, two, ["again"])).toEqual({
      kind: "cal_alert", eventId: "ev-weekly", label: { as: "title", text: "Catalogue weekly" }, at: two, allDay: false, leadMin: 10, acts: ["again"],
    });
    expect(dueNotice(acting, two, [])).toMatchObject({ acts: [] });
    expect(dueNotice({ ...weekly, body: "Zqbody" } as never, two, [])).toBeNull();
    expect(dueNotice(weekly, { hour: 24, minute: 0, day: "today" }, [])).toBeNull();
    expect(dueNotice(weekly, null as never, [])).toBeNull();
  });
});
