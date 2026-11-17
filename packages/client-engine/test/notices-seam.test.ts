/**
 * THE NOTICES' SEAM, HELD. A notice is read on a locked screen by whoever stands there, so what a
 * notice can say is decided by its type: a mail notice has no member that could hold a letter's
 * sender or subject, and something found in a letter has no title. The suite's runner strips
 * types, so the last case compiles this file itself and expects it clean: each line marked below
 * expects the compiler's refusal, and a member that became free text leaves its line unrefused.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  MAIL_NOTICE_KINDS, NOTICE_COUNT_MAX, NOTICE_KINDS, NOTICE_KIND_FACTS, NOTICE_LEAD_MAX_MIN, NOTICE_TEXT_MAX, SUMMARY_AT_START,
  alertNotice, answeredNotice, calendarChoicesOf, cancelledNotice, cleanNoticeText, eventLabel, foundNotice, invitationNotice,
  mailChoicesOf, movedNotice, noticeChoicesOf, noticeCount, noticeFields, noticeKindsOf, summaryNotice,
  type CalendarNotice, type Clock, type EventLabel, type MailNotice, type Notice, type NoticeAct, type NoticeGate,
  type NoticeKind, type NoticeKindFacts, type NoticeWording,
} from "@ohmail/client-engine";

const HERE = fileURLToPath(import.meta.url);

/** Any text at all can be reached in `T`: itself, an element of a list, or a member at any depth. */
type HoldsText<T> = string extends T ? true
  : T extends readonly (infer E)[] ? HoldsText<E>
  : T extends object ? (true extends { [K in keyof T]-?: HoldsText<T[K]> }[keyof T] ? true : false)
  : false;
/** The members of each arm of `T` that could hold any text at all, not only words of a closed set. */
type FreeText<T> = T extends unknown ? { [K in keyof T]-?: true extends HoldsText<T[K]> ? K : never }[keyof T] : never;
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Holds<T extends true> = T;

/** No mail notice has a member that takes text. The calendar's take an id, and a title only inside its label. */
export type MailTakesNoText = Holds<Same<FreeText<MailNotice>, never>>;
export type CalendarTakesAnIdAndItsLabel = Holds<Same<FreeText<CalendarNotice>, "eventId" | "label">>;
export type LabelTakesItsTextOnly = Holds<Same<FreeText<EventLabel>, "text">>;

describe("what the compiler refuses", () => {
  it("a mail notice with a letter's words, a device's own label, and a title on a found event", () => {
    const handed: Notice[] = [
      // @ts-expect-error a mail notice has no place for a subject
      { kind: "ohbox", count: 1, subject: "Thursday" },
      // @ts-expect-error nor for a sender
      { kind: "ohbox", count: 1, sender: "Petra Muhr" },
      // @ts-expect-error a waiting sender is a number, never a name
      { kind: "screener", count: 1, sender: "stranger@example.com" },
      // @ts-expect-error a failed send says so, without the server's sentence
      { kind: "scheduled", outcome: "failed", count: 1, reason: "no connection" },
      // @ts-expect-error a pairing names a kind of device, never the label the device chose
      { kind: "pairing", change: "paired", device: "Petra's phone" },
      // @ts-expect-error what a letter seems to propose has no title until the person adds it
      { kind: "cal_found", count: 1, at: null, label: { as: "title", text: "Winternacht" } },
      // @ts-expect-error an event's words stand in its label, not beside it
      { kind: "cal_invitation", eventId: "e1", label: { as: "event" }, at: { hour: 9, minute: 0, day: "today" }, allDay: false, organizer: "Petra Wyss" },
    ];
    expect(handed).toHaveLength(7);
  });

  it("a kind that no surface emits, and a kind left out of the table", () => {
    // @ts-expect-error the list of surfaces is never empty
    const nowhere: NoticeKindFacts = { product: "mail", start: "on", surfaces: [] };
    const rest: Omit<typeof NOTICE_KIND_FACTS, "cal_summary"> = NOTICE_KIND_FACTS;
    // @ts-expect-error every kind stands in the table
    const partial: Readonly<Record<NoticeKind, NoticeKindFacts>> = rest;
    expect([nowhere.surfaces.length, Object.keys(partial).length]).toEqual([0, NOTICE_KINDS.length]);
  });

  it("a gate that is handed a letter's words", () => {
    // @ts-expect-error the sample the gate compares has no newest subject
    const gate: NoticeGate = (_before, after) => [{ kind: "ohbox", count: after.latestSubject.length }];
    expect(typeof gate).toBe("function");
  });

  it("this file type-checks clean under the options its folder is checked with", () => {
    const said = (d: ts.Diagnostic): string => ts.flattenDiagnosticMessageText(d.messageText, " ");
    const parsed = ts.getParsedCommandLineOfConfigFile(join(dirname(HERE), "..", "tsconfig.test-dirs.json"), {}, {
      ...ts.sys, onUnRecoverableConfigFileDiagnostic: (d) => { throw new Error(said(d)); },
    })!;
    const program = ts.createProgram({ rootNames: [HERE], options: parsed.options });
    const self = program.getSourceFile(HERE)!;
    // The kinds it read are the source the suite runs, not a copy built earlier.
    const read = program.getSourceFiles().map((f) => f.fileName.replace(/\\/g, "/"));
    expect(read.some((f) => f.endsWith("/packages/client-engine/src/notices/kinds.ts"))).toBe(true);
    const refused = [...parsed.errors, ...program.getSyntacticDiagnostics(self), ...program.getSemanticDiagnostics(self)].map((d) =>
      `${d.file && d.start !== undefined ? `line ${d.file.getLineAndCharacterOfPosition(d.start).line + 1}` : "options"}: TS${d.code} ${said(d)}`);
    expect(refused).toEqual([]);
  }, 120_000);
});

describe("the kinds", () => {
  it("mail keeps the ids a device's stored choices already use, and every kind has its facts", () => {
    expect([...MAIL_NOTICE_KINDS]).toEqual(["ohbox", "screener", "scheduled", "pairing"]);
    expect(Object.keys(NOTICE_KIND_FACTS).sort()).toEqual([...NOTICE_KINDS].sort());
    for (const kind of NOTICE_KINDS) {
      expect(NOTICE_KIND_FACTS[kind].product, kind).toBe(kind.startsWith("cal_") ? "calendar" : "mail");
    }
  });

  it("the iPhone carries no mail kind, and only what is set ahead", () => {
    expect(noticeKindsOf("iphone")).toEqual(["cal_alert", "cal_summary"]);
    expect(noticeKindsOf("desktop")).toEqual([...NOTICE_KINDS]);
  });

  it("a count is a whole number from 1 to 9999, or nothing to say", () => {
    expect([0, -3, Number.NaN, Number.POSITIVE_INFINITY, 0.4].map(noticeCount)).toEqual([null, null, null, null, null]);
    expect([1, 2.9, 9999, 1_000_000].map(noticeCount)).toEqual([1, 2, 9999, 9999]);
  });
});

describe("an event's words in a notice", () => {
  const event = (over: Partial<{ title: string; private: boolean; heldBack: boolean }> = {}) =>
    ({ title: "Catalogue weekly", private: false, heldBack: false, ...over });

  it("an invitation not yet shown on the calendar makes no notice, whatever else is true", () => {
    expect(eventLabel(event({ heldBack: true }), true)).toBeNull();
    expect(eventLabel(event({ heldBack: true, private: true }), false)).toBeNull();
  });

  it("a private event says Busy whatever the switch", () => {
    expect(eventLabel(event({ private: true }), true)).toEqual({ as: "busy" });
    expect(eventLabel(event({ private: true }), false)).toEqual({ as: "busy" });
  });

  it("titles hidden, or nothing left of the title: Event", () => {
    expect(eventLabel(event(), false)).toEqual({ as: "event" });
    expect(eventLabel(event({ title: " ​‮\n " }), true)).toEqual({ as: "event" });
  });

  it("a record that does not say it is shown and public is not titled", () => {
    const silent = { title: "Catalogue weekly" } as unknown as { title: string; private: boolean; heldBack: boolean };
    expect(eventLabel(silent, true)).toBeNull();
    expect(eventLabel({ ...silent, heldBack: false }, true)).toEqual({ as: "busy" });
  });

  it("a title comes out as one clean line", () => {
    expect(eventLabel(event({ title: "  Tech\tcheck,\r\n main hall  " }), true)).toEqual({ as: "title", text: "Tech check, main hall" });
  });

  it("controls, direction marks and characters without width never reach a notice", () => {
    const hostile = "‮evil‬ \u0007<b>bold</b>​⁦x⁩؜‎‏﻿­\u0085end\ud800";
    expect(cleanNoticeText(hostile)).toBe("evil <b>bold</b>x end");
    expect(cleanNoticeText("\u0000\u001b[31m")).toBe("[31m");
    expect(cleanNoticeText("​‍⁠")).toBeNull();
    expect(cleanNoticeText("")).toBeNull();
  });

  it("each character is spaced, dropped or kept as the table the desktop's shell reads too says", () => {
    const table = JSON.parse(readFileSync(join(dirname(HERE), "notice-text-dropped.json"), "utf8")) as Record<"space" | "dropped", string[]>;
    const outcome = new Uint8Array(0x110000); // 0 kept, 1 space, 2 dropped
    for (const [list, mark] of [[table.dropped, 2], [table.space, 1]] as const) {
      for (const range of list) {
        const [from, to = from] = range.split("-").map((hex) => parseInt(hex, 16));
        outcome.fill(mark, from, to! + 1);
      }
    }
    const wrong: string[] = [];
    for (let cp = 0; cp <= 0x10ffff; cp += 1) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue; // the shell's strings cannot hold half a pair
      const ch = String.fromCodePoint(cp);
      const want = outcome[cp] === 1 ? "a b" : outcome[cp] === 2 ? "ab" : `a${ch}b`;
      if (cleanNoticeText(`a${ch}b`) !== want) wrong.push(cp.toString(16).toUpperCase().padStart(4, "0"));
    }
    expect({ differ: wrong.length, first: wrong.slice(0, 24) }).toEqual({ differ: 0, first: [] });
  });

  it("cuts at the bound in code points, and never ends on a gap", () => {
    const long = cleanNoticeText("😀".repeat(200))!;
    expect([...long]).toHaveLength(NOTICE_TEXT_MAX);
    const gapAtTheCut = cleanNoticeText(`${"a".repeat(NOTICE_TEXT_MAX - 1)} b`)!;
    expect(gapAtTheCut).toBe("a".repeat(NOTICE_TEXT_MAX - 1));
    expect([...cleanNoticeText("a".repeat(10_000))!]).toHaveLength(NOTICE_TEXT_MAX);
  });
});

describe("the device's choices", () => {
  const elsewhere = { ohcalPhone: false };
  const ohcal = { ohcalPhone: true };

  it("no record, or one that cannot be read, is the start values: mail on, alerts only in the calendar's phone app", () => {
    for (const raw of [undefined, null, "{}", 7, [], [true], { master: "true", ohbox: 1, cal_alert: "on" }]) {
      const c = noticeChoicesOf(raw, raw, elsewhere);
      expect(c, JSON.stringify(raw)).toEqual({
        master: true, showTitles: true, ohbox: true, screener: true, scheduled: true, pairing: true,
        cal_alert: false, cal_invitation: true, cal_change: true, cal_answer: false, cal_found: false, cal_summary: false,
      });
    }
    expect(noticeChoicesOf(null, null, ohcal).cal_alert).toBe(true);
  });

  it("a stored switch is taken as it stands", () => {
    const mail = { master: false, ohbox: false, screener: true, scheduled: false, pairing: true };
    expect(mailChoicesOf(mail, elsewhere)).toEqual(mail);
    const cal = calendarChoicesOf({ cal_alert: true, cal_invitation: false, showTitles: false, widgetTitles: false, summaryAt: 0 }, elsewhere);
    expect(cal).toMatchObject({ cal_alert: true, cal_invitation: false, cal_change: true, showTitles: false, widgetTitles: false, summaryAt: 0 });
  });

  it("reads each member by its own name and takes nothing else of the record", () => {
    const stored = JSON.parse('{"master":true,"ohbox":true,"showSenderAndSubject":true,"__proto__":{"pairing":false},"endpoint":"https://x.example"}') as unknown;
    const mail = mailChoicesOf(stored, elsewhere);
    expect(Object.keys(mail).sort()).toEqual(["master", "ohbox", "pairing", "scheduled", "screener"]);
    expect(mail.pairing).toBe(true);
    const inherited = Object.create({ master: false, ohbox: false }) as unknown;
    expect(mailChoicesOf(inherited, elsewhere)).toMatchObject({ master: true, ohbox: true });
    expect(Object.keys(noticeChoicesOf(stored, stored, elsewhere))).not.toContain("showSenderAndSubject");
  });

  it("the summary's time is a whole minute of the day, or the start value", () => {
    for (const at of [-1, 1440, 7.5, "420", null]) {
      expect(calendarChoicesOf({ summaryAt: at }, elsewhere).summaryAt, String(at)).toBe(SUMMARY_AT_START);
    }
    expect(calendarChoicesOf({ summaryAt: 1439 }, elsewhere).summaryAt).toBe(1439);
  });
});

describe("a calendar record becomes a notice in one place", () => {
  const shown = { id: "0b6f5c1e-2f0a-4c55-9d53-1f0d6b0a7c11", title: "Catalogue weekly", private: false, heldBack: false };
  const two: Clock = { hour: 14, minute: 0, day: "today" };
  const when = { at: two, allDay: false, leadMin: 10, acts: ["join", "again"] as readonly NoticeAct[] };

  it("an alert says the label, the time as numbers, the lead and the closed acts", () => {
    expect(alertNotice(shown, true, when)).toEqual({
      kind: "cal_alert", eventId: shown.id, label: { as: "title", text: "Catalogue weekly" }, at: two, allDay: false, leadMin: 10, acts: ["join", "again"],
    });
  });

  it("a time out of its ranges, a lead out of its bound or an id that could be words makes no notice", () => {
    const day = { month: 11, dom: 20, dow: 5 };
    const wrong: Clock[] = [
      { hour: 24, minute: 0, day: "today" }, { hour: 9, minute: 60, day: "today" }, { hour: 9.5, minute: 0, day: "today" },
      { hour: 9, minute: 0, day: { ...day, month: 13 } }, { hour: 9, minute: 0, day: { ...day, dom: 0 } }, { hour: 9, minute: 0, day: { ...day, dow: 7 } },
      { hour: 9, minute: 0, day: "soon" as never }, { hour: "9" as never, minute: 0, day: "today" },
    ];
    for (const at of wrong) {
      expect(alertNotice(shown, true, { ...when, at }), JSON.stringify(at)).toBeNull();
      expect(invitationNotice(shown, true, { at, allDay: false })).toBeNull();
      expect(cancelledNotice(shown, true, { at, allDay: false })).toBeNull();
      expect(movedNotice(shown, true, { at, was: null, allDay: false })).toBeNull();
    }
    for (const leadMin of [-1, 1.5, NOTICE_LEAD_MAX_MIN + 1, Number.NaN]) expect(alertNotice(shown, true, { ...when, leadMin })).toBeNull();
    for (const id of ["", "an id with words", "x".repeat(129), "a\nb"]) expect(invitationNotice({ ...shown, id }, true, { at: two, allDay: false })).toBeNull();
  });

  it("takes nothing of what it was handed but numbers in range and closed words", () => {
    const loud = { hour: 14, minute: 0, day: { month: 11, dom: 20, dow: 5, note: "a letter's words" }, zone: "words" } as unknown as Clock;
    const made = movedNotice({ ...shown, notes: "words", place: "words" } as never, true, { at: loud, was: { hour: 30, minute: 0, day: "today" }, allDay: "yes" as never });
    expect(made).toEqual({
      kind: "cal_change", change: "moved", eventId: shown.id, label: { as: "title", text: "Catalogue weekly" },
      at: { hour: 14, minute: 0, day: { month: 11, dom: 20, dow: 5 } }, was: null, allDay: false,
    });
    expect(alertNotice(shown, true, { ...when, acts: ["again", "again", "open" as never] })!).toMatchObject({ acts: ["again"] });
  });

  it("an answer is a closed word and a count; what letters propose is a count and never a title", () => {
    expect(answeredNotice(shown, true, "maybe", 2)).toEqual({ kind: "cal_answer", eventId: shown.id, label: { as: "title", text: "Catalogue weekly" }, answer: "maybe", count: 2 });
    expect(answeredNotice(shown, true, "perhaps" as never, 2)).toBeNull();
    expect(answeredNotice(shown, true, "yes", 0)).toBeNull();
    const proposed = [{ proposed: { title: "Winternacht" } }, { proposed: { title: "Vernissage" } }];
    expect(foundNotice(proposed, two)).toEqual({ kind: "cal_found", count: 2, at: two });
    expect(foundNotice([], two)).toBeNull();
    expect(summaryNotice({ events: -4, first: { hour: 99, minute: 0, day: "today" }, toAnswer: Number.NaN })).toEqual({ kind: "cal_summary", events: 0, first: null, toAnswer: 0 });
    expect(summaryNotice({ events: 1e9, first: two, toAnswer: 3.7 })).toEqual({ kind: "cal_summary", events: NOTICE_COUNT_MAX, first: two, toAnswer: 3 });
  });

  it("a held-back, a private and a hidden event are named as the label says, through every maker", () => {
    expect(invitationNotice({ ...shown, heldBack: true }, true, { at: two, allDay: false })).toBeNull();
    expect(answeredNotice({ ...shown, heldBack: true }, true, "yes", 1)).toBeNull();
    expect(cancelledNotice({ ...shown, private: true }, true, { at: two, allDay: false })).toMatchObject({ label: { as: "busy" } });
    expect(alertNotice(shown, false, when)).toMatchObject({ label: { as: "event" } });
  });
});

describe("the two fields a platform draws", () => {
  const handed: unknown[] = [];
  const wording: NoticeWording = {
    title: (facts) => { handed.push(facts); return `[${facts.kind}]`; },
    body: (facts) => { handed.push(facts); return `(${facts.kind})`; },
    label: (as) => (as === "busy" ? "Busy" : "Event"),
  };
  const at: Clock = { hour: 14, minute: 0, day: "today" };
  const invited = (label: EventLabel): Notice => ({ kind: "cal_invitation", eventId: "e1", label, at, allDay: false });

  it("an event's label is the title; the body is the surface's words, which are never handed the label", () => {
    handed.length = 0;
    expect(noticeFields(invited({ as: "title", text: "Tech check, main hall" }), wording)).toEqual({ title: "Tech check, main hall", body: "(cal_invitation)" });
    expect(noticeFields(invited({ as: "busy" }), wording).title).toBe("Busy");
    expect(noticeFields(invited({ as: "event" }), wording).title).toBe("Event");
    expect(JSON.stringify(handed)).not.toContain("Tech check");
    expect(handed.every((facts) => !("label" in (facts as object)))).toBe(true);
  });

  it("a notice that names no event takes both fields from the surface", () => {
    expect(noticeFields({ kind: "ohbox", count: 3 }, wording)).toEqual({ title: "[ohbox]", body: "(ohbox)" });
    expect(noticeFields({ kind: "cal_found", count: 1, at: null }, wording)).toEqual({ title: "[cal_found]", body: "(cal_found)" });
  });

  it("cleans a title once more, whatever made the notice", () => {
    expect(noticeFields(invited({ as: "title", text: "\u202eTech\ncheck\u0007" }), wording).title).toBe("Tech check");
    expect(noticeFields(invited({ as: "title", text: "\u200b" }), wording).title).toBe("Event");
    expect(noticeFields(invited({ as: "elsewhere" } as never), wording).title).toBe("Event");
  });
});
