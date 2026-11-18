/**
 * WHAT A NOTICE'S TITLE MAY BE, PER KIND AND SURFACE. An event's title is the only free text that
 * can enter a notice. It stands in the title field of the kinds that name an event, on the surfaces
 * that draw them, under the person's switch; every other notice has the app's own words there, and
 * a surface that does not draw a kind has nothing. A locked screen's public version never holds a
 * title. The makers ask the same rule, and the compiler holds it against the notices' own types.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  LOCKED_LABEL, NOTICE_KINDS, NOTICE_NAMES_EVENT, alertNotice, answeredNotice, cancelledNotice, foundNotice, invitationNotice,
  movedNotice, noticeKindsOf, noticeTitleOf, summaryNotice,
  type EventLabel, type Notice, type NoticeKind, type NoticeSurface, type NoticeTitle,
} from "@ohmail/client-engine";

const HERE = fileURLToPath(import.meta.url);
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Holds<T extends true> = T;
/** The kinds whose notice has a label, by the notices' own types, and the kinds the rule says name an event. */
type Labelled = Extract<Notice, { readonly label: EventLabel }>["kind"];
type Named = { [K in NoticeKind]: (typeof NOTICE_NAMES_EVENT)[K] extends true ? K : never }[NoticeKind];
export type TheRuleAndTheTypesAgree = Holds<Same<Labelled, Named>>;

/** The security ruling's table (2.2), by kind: what the title field holds on each surface. */
const L: NoticeTitle = "label";
const W: NoticeTitle = "words";
const N: NoticeTitle = "none";
const RULED: Readonly<Record<NoticeKind, Readonly<Record<NoticeSurface, NoticeTitle>>>> = {
  ohbox: { web: W, desktop: W, android: W, iphone: N },
  screener: { web: W, desktop: W, android: W, iphone: N },
  scheduled: { web: W, desktop: W, android: W, iphone: N },
  pairing: { web: W, desktop: W, android: W, iphone: N },
  cal_alert: { web: L, desktop: L, android: L, iphone: L },
  cal_invitation: { web: L, desktop: L, android: L, iphone: N },
  cal_change: { web: L, desktop: L, android: L, iphone: N },
  cal_answer: { web: L, desktop: L, android: L, iphone: N },
  cal_found: { web: W, desktop: W, android: W, iphone: N },
  cal_summary: { web: W, desktop: W, android: W, iphone: W },
};

describe("what a notice's title may be", () => {
  it("is the event's label for the kinds that name an event, the app's own words for the rest, and nothing where a surface draws none", () => {
    for (const kind of NOTICE_KINDS) {
      for (const surface of ["web", "desktop", "android", "iphone"] as const) {
        expect(noticeTitleOf(kind, surface), `${kind} on ${surface}`).toBe(RULED[kind][surface]);
      }
    }
    // A surface draws a title exactly for the kinds it carries.
    for (const surface of ["web", "desktop", "android", "iphone"] as const) {
      expect(NOTICE_KINDS.filter((kind) => noticeTitleOf(kind, surface) !== "none")).toEqual(noticeKindsOf(surface));
    }
    expect(noticeTitleOf("cal_everything" as never, "web")).toBe("none");
    expect(noticeTitleOf("cal_alert", "watch" as never)).toBe("none");
  });

  it("no mail kind, nothing found in a letter and no summary names an event", () => {
    expect(NOTICE_KINDS.filter((kind) => NOTICE_NAMES_EVENT[kind])).toEqual(["cal_alert", "cal_invitation", "cal_change", "cal_answer"]);
  });

  it("a locked screen's public version says Event, never a title and never that the event is private", () => {
    expect(LOCKED_LABEL).toEqual({ as: "event" });
    expect(Object.isFrozen(LOCKED_LABEL)).toBe(true);
  });

  it("the makers give a label to exactly the kinds the rule names", () => {
    const shown = { id: "ev-1", title: "Catalogue weekly", private: false, heldBack: false };
    const two = { hour: 14, minute: 0, day: "today" as const };
    const made = [
      alertNotice(shown, true, { at: two, allDay: false, leadMin: 10, acts: [] }),
      invitationNotice(shown, true, { at: two, allDay: false }),
      movedNotice(shown, true, { at: two, was: null, allDay: false }),
      cancelledNotice(shown, true, { at: two, allDay: false }),
      answeredNotice(shown, true, "yes", 1),
      foundNotice([{ proposed: { title: "Winternacht" } }], two),
      summaryNotice({ events: 2, first: two, toAnswer: 0 }),
    ];
    for (const notice of made) {
      expect(notice).not.toBeNull();
      expect("label" in notice!, notice!.kind).toBe(NOTICE_NAMES_EVENT[notice!.kind]);
    }
  });

  it("this file type-checks clean under the options its folder is checked with", () => {
    const said = (d: ts.Diagnostic): string => ts.flattenDiagnosticMessageText(d.messageText, " ");
    const parsed = ts.getParsedCommandLineOfConfigFile(join(dirname(HERE), "..", "tsconfig.test-dirs.json"), {}, {
      ...ts.sys, onUnRecoverableConfigFileDiagnostic: (d) => { throw new Error(said(d)); },
    })!;
    const program = ts.createProgram({ rootNames: [HERE], options: parsed.options });
    const self = program.getSourceFile(HERE)!;
    const refused = [...parsed.errors, ...program.getSyntacticDiagnostics(self), ...program.getSemanticDiagnostics(self)].map((d) =>
      `${d.file && d.start !== undefined ? `line ${d.file.getLineAndCharacterOfPosition(d.start).line + 1}` : "options"}: TS${d.code} ${said(d)}`);
    expect(refused).toEqual([]);
  }, 120_000);
});
