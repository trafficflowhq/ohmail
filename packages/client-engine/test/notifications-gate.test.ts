import { describe, expect, it } from "vitest";
import {
  DEFAULT_CHANNELS,
  decideNotices,
  channelsAreLive,
  mayPost,
  type NotificationChannels,
} from "../src/notifications.js";
import { noticeChoicesOf, type NoticeChoices } from "../src/notices/choices.js";
import { NOTICE_COUNT_MAX, NOTICE_KINDS, type Clock, type Notice, type NoticeKind } from "../src/notices/kinds.js";
import type { CalendarLook, CalendarSample, NoticeDevices, NoticeSample, SendStanding } from "../src/notices/gate.js";

/**
 * THE GATE — the behavioural half of "fully off means no code path fires".
 *
 * The other half is the source census (`notifications-gate-census`), which asserts no surface
 * draws a notice without coming through here. This file asserts that coming through here with the
 * master off produces nothing to draw. Neither is sufficient alone: the census cannot tell whether
 * the gate's answer is right, and this cannot tell whether somebody added a fourth emitter that
 * skips it.
 */

/** The account's named devices: how many were ever made, how many were taken back, how many are signed in now. */
const named = (made: number, revoked = 0, live = made - revoked): NoticeDevices => ({ made, revoked, live });
const sample = (over: Partial<NoticeSample> = {}): NoticeSample =>
  ({ ohboxUnread: 0, screenerWaiting: 0, sends: new Map(), devices: named(1), calendar: null, ...over });
const sends = (...rows: [string, SendStanding][]): ReadonlyMap<string, SendStanding> => new Map(rows);
const base = sample();
/** A device's stored record with `over` on top, as the gate is handed it. */
const all = (over: Partial<NoticeChoices> = {}): NoticeChoices =>
  ({ ...noticeChoicesOf(DEFAULT_CHANNELS, null, { ohcalPhone: false }), ...over });
const channels = (over: Partial<NotificationChannels> = {}): NotificationChannels => ({ ...DEFAULT_CHANNELS, ...over });
const EVERY: readonly NoticeKind[] = NOTICE_KINDS;

/** Everything happened at once: mail, a waiting sender, a send that went, one that did not, a new device. */
const busy = sample({
  ohboxUnread: 3, screenerWaiting: 2, devices: named(2),
  sends: sends(["failed-one", "failed"]),
});
const before = sample({ sends: sends(["sent-one", "waiting"], ["failed-one", "waiting"]) });

describe("the two absolute refusals", () => {
  it("draws NOTHING when the master is off, however much arrived", () => {
    expect(decideNotices(before, busy, all({ master: false }), "granted", EVERY), "the master switch did not silence every channel").toEqual([]);
  });

  it("draws NOTHING when the OS has not granted permission — for each non-granted state", () => {
    for (const p of ["denied", "default", "unsupported"] as const) {
      expect(decideNotices(before, busy, all(), p, EVERY), `a notice was produced while the OS said ${p}`).toEqual([]);
    }
  });

  it("the first sample seeds and never notifies — eleven unread is not eleven arrivals", () => {
    expect(decideNotices(null, sample({ ohboxUnread: 11, screenerWaiting: 3 }), all(), "granted", EVERY)).toEqual([]);
  });
});

describe("each switch silences its own event and nothing else", () => {
  it("all four on ⇒ all four fire", () => {
    const kinds = decideNotices(before, busy, all(), "granted", EVERY).map((n) => n.kind);
    expect(new Set(kinds)).toEqual(new Set(["ohbox", "screener", "scheduled", "pairing"]));
  });

  for (const off of ["ohbox", "screener", "scheduled", "pairing"] as const) {
    it(`${off} off ⇒ no ${off} notice, and the other three still fire`, () => {
      const kinds = new Set(decideNotices(before, busy, all({ [off]: false }), "granted", EVERY).map((n) => n.kind));
      expect(kinds, `${off} fired with its own switch off`).not.toContain(off);
      expect(kinds.size, `turning ${off} off silenced something else too`).toBe(3);
    });
  }

  it("a surface is answered only the kinds its emitter carries", () => {
    expect(decideNotices(before, busy, all(), "granted", ["ohbox"])).toEqual([{ kind: "ohbox", count: 3 }]);
    expect(decideNotices(before, busy, all(), "granted", [])).toEqual([]);
  });
});

describe("a rise is an event; a fall is somebody reading their mail", () => {
  it("notifies on a rise, with the DELTA and not the total", () => {
    const out = decideNotices(sample({ ohboxUnread: 2 }), sample({ ohboxUnread: 5 }), all(), "granted", EVERY);
    expect(out).toEqual([{ kind: "ohbox", count: 3 }]);
  });

  it("says nothing when the count falls or holds", () => {
    for (const now of [2, 0]) {
      expect(decideNotices(sample({ ohboxUnread: 2 }), sample({ ohboxUnread: now }), all(), "granted", EVERY)).toEqual([]);
    }
  });

  it("a count is a whole number within the bound, and a sample that is no number says nothing", () => {
    expect(decideNotices(base, sample({ ohboxUnread: 1_000_000 }), all(), "granted", EVERY)).toEqual([{ kind: "ohbox", count: NOTICE_COUNT_MAX }]);
    expect(decideNotices(base, sample({ ohboxUnread: Number.NaN, screenerWaiting: Number.POSITIVE_INFINITY }), all(), "granted", EVERY)).toEqual([]);
  });
});

describe("the content rule", () => {
  /** A sample that carries a letter's words under every name one has ever been handed by. */
  const wordy = {
    ...sample({ ohboxUnread: 1, screenerWaiting: 1, devices: named(2), sends: sends(["failed-one", "failed"]) }),
    latestSender: "Petra Muhr", latestSubject: "Thursday", sender: "stranger@example.com", subject: "Re: hi",
    scheduledOutcomes: [{ id: "failed-one", outcome: "failed", reason: "no connection", subject: "Re: hi" }],
    pairingEvents: [{ id: "p", kind: "paired", device: "old laptop" }],
  } as NoticeSample;
  const handed = (choices: NoticeChoices): Notice[] => decideNotices(before, wordy, choices, "granted", EVERY);

  it("never a sender or a subject, also where a device's stored record still says to show them", () => {
    const stored = noticeChoicesOf(channels({ showSenderAndSubject: true }), null, { ohcalPhone: false });
    for (const choices of [all(), stored, { ...stored, showSenderAndSubject: true } as NoticeChoices]) {
      expect(handed(choices)).toEqual([
        { kind: "ohbox", count: 1 },
        { kind: "screener", count: 1 },
        { kind: "scheduled", outcome: "sent", count: 1 },
        { kind: "scheduled", outcome: "failed", count: 1 },
        { kind: "pairing", change: "paired", device: null },
      ]);
    }
  });

  it("every member of every notice is a number, a closed word or nothing", () => {
    const words = new Set(["ohbox", "screener", "scheduled", "pairing", "sent", "failed", "paired", "revoked"]);
    for (const notice of handed(all())) {
      for (const [member, value] of Object.entries(notice)) {
        const closed = value === null || typeof value === "number" || (typeof value === "string" && words.has(value));
        expect(closed, `${notice.kind}.${member} holds ${String(value)}`).toBe(true);
      }
    }
  });
});

describe("scheduled sends — both outcomes, because silence reports one of them wrongly", () => {
  const waiting = sample({ sends: sends(["s1", "waiting"]) });

  it("reports a failure, as a count and without the server's sentence", () => {
    expect(decideNotices(waiting, sample({ sends: sends(["s1", "failed"]) }), all(), "granted", EVERY))
      .toEqual([{ kind: "scheduled", outcome: "failed", count: 1 }]);
  });

  it("reports a success too: the draft is among the unsent no more", () => {
    expect(decideNotices(waiting, base, all(), "granted", EVERY)).toEqual([{ kind: "scheduled", outcome: "sent", count: 1 }]);
  });

  it("says nothing while it still waits, or when the person made it a plain draft again", () => {
    expect(decideNotices(waiting, waiting, all(), "granted", EVERY)).toEqual([]);
    expect(decideNotices(waiting, sample({ sends: sends(["s1", "draft"]) }), all(), "granted", EVERY)).toEqual([]);
  });

  it("a draft that never waited is no scheduled send, whatever becomes of it", () => {
    const plain = sample({ sends: sends(["d1", "draft"], ["d2", "failed"]) });
    expect(decideNotices(plain, base, all(), "granted", EVERY)).toEqual([]);
    expect(decideNotices(plain, sample({ sends: sends(["d1", "failed"]) }), all(), "granted", EVERY)).toEqual([]);
  });
});

describe("pairing — a security event that names no device's own label", () => {
  const paired: Notice = { kind: "pairing", change: "paired", device: null };
  const revoked: Notice = { kind: "pairing", change: "revoked", device: null };
  const told = (before: NoticeDevices | null, after: NoticeDevices | null): Notice[] =>
    decideNotices(sample({ devices: before }), sample({ devices: after }), all(), "granted", EVERY);

  it("says a device was paired when the number of devices ever made rose", () => {
    expect(told(named(1), named(2))).toEqual([paired]);
  });

  it("says one was signed out when the number taken back in Devices rose", () => {
    expect(told(named(2), named(2, 1))).toEqual([revoked]);
  });

  it("a device signed itself out and another was paired: as many are signed in as before, and the pairing is told", () => {
    // Two made and both signed in; one signs itself out (nothing rings, no sample is taken); a
    // third is paired. Two are signed in before and after: the count alone reads as no change.
    const before = named(2, 0, 2);
    const after = named(3, 0, 2);
    expect(after.live).toBe(before.live);
    expect(told(before, after)).toEqual([paired]);
  });

  it("is never decided from how many are signed in now", () => {
    // A device signed itself out, a newer sign-in replaced an install's previous one, a sweep or a
    // change of a second factor ended sessions: fewer are signed in, and neither rising number moved.
    expect(told(named(3, 0, 3), named(3, 0, 1))).toEqual([]);
    expect(told(named(3, 1, 2), named(3, 1, 0))).toEqual([]);
    // And a count that reads higher with neither number risen is no new device.
    expect(told(named(3, 0, 1), named(3, 0, 3))).toEqual([]);
  });

  it("two pairings between two samples are one notice, and so are two take-backs", () => {
    expect(told(named(1), named(3))).toEqual([paired]);
    expect(told(named(3), named(3, 2))).toEqual([revoked]);
  });

  it("a take-back and a pairing between two samples are both told, the pairing last", () => {
    // A surface with one place for the kind keeps the last notice it is handed.
    expect(told(named(2), named(3, 1))).toEqual([revoked, paired]);
  });

  it("says nothing where a sample does not know the numbers", () => {
    expect(told(null, named(2))).toEqual([]);
    expect(told(named(1), null)).toEqual([]);
    expect(told(null, null)).toEqual([]);
  });

  it("says nothing for a number that is no whole number, or that fell", () => {
    const odd = (made: unknown, taken: unknown = 0): NoticeDevices => ({ made, revoked: taken, live: 0 }) as NoticeDevices;
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, 2.5, -1, "2", null, undefined, {}]) {
      expect(told(named(1), odd(value)), `made: ${String(value)}`).toEqual([]);
      expect(told(odd(value), named(5)), `made before: ${String(value)}`).toEqual([]);
      expect(told(named(1), odd(1, value)), `revoked: ${String(value)}`).toEqual([]);
    }
    // A store that lost rows reads lower: no event, and the next rise is one again.
    expect(told(named(3, 2), named(2, 1))).toEqual([]);
    // A sample of the shape an older build handed in (one number) knows nothing.
    expect(told(1 as unknown as NoticeDevices, 2 as unknown as NoticeDevices)).toEqual([]);
  });

  it("the kind's switch off, or the master off, tells neither", () => {
    const before = sample({ devices: named(2) });
    const after = sample({ devices: named(3, 1) });
    expect(decideNotices(before, after, all({ pairing: false }), "granted", EVERY)).toEqual([]);
    expect(decideNotices(before, after, all({ master: false }), "granted", EVERY)).toEqual([]);
    expect(decideNotices(before, after, all(), "granted", ["ohbox"])).toEqual([]);
  });
});

describe("a notice no comparison makes passes the same refusals", () => {
  const summary: Notice = { kind: "cal_summary", events: 4, first: null, toAnswer: 3 };
  const on = all({ cal_summary: true });

  it("is drawn only with the master and its switch on, the platform granting and the surface carrying it", () => {
    expect(mayPost(summary, on, "granted", EVERY)).toBe(true);
    expect(mayPost(summary, all(), "granted", EVERY)).toBe(false);
    expect(mayPost(summary, { ...on, master: false }, "granted", EVERY)).toBe(false);
    expect(mayPost(summary, on, "default", EVERY)).toBe(false);
    expect(mayPost(summary, on, "granted", ["ohbox"])).toBe(false);
  });
});

describe("channelsAreLive — what the pane renders", () => {
  it("is false whenever the OS refuses, whatever the master says", () => {
    for (const p of ["denied", "default", "unsupported"] as const) {
      expect(channelsAreLive(channels(), p)).toBe(false);
    }
  });
  it("is false when the master is off even on a granted OS", () => {
    expect(channelsAreLive(channels({ master: false }), "granted")).toBe(false);
  });
  it("is true only when both agree", () => {
    expect(channelsAreLive(channels(), "granted")).toBe(true);
  });
});

describe("the calendar: what a sync turn brought, each kind once and never twice", () => {
  const H = 3_600_000;
  const cal = (over: Partial<CalendarSample> = {}): CalendarSample =>
    ({ invitations: new Set(), standing: new Map(), answers: new Map(), found: new Set(), ...over });
  const stands = (startHour: number, status: "confirmed" | "tentative" | "cancelled" = "confirmed") =>
    ({ startMs: startHour * H, status });
  /** A clock that says the hour an instant names, today: enough to tell two starts apart. */
  const clock = (ms: number): Clock => ({ hour: Math.floor(ms / H) % 24, minute: 0, day: "today" });
  const EVENTS: Readonly<Record<string, { title: string; private: boolean }>> = {
    inv: { title: "Kickoff", private: false }, mv: { title: "Review", private: false }, cx: { title: "Shoot", private: false },
    own: { title: "Studio day", private: false }, doc: { title: "Doctor", private: true },
  };
  const FOUND: Readonly<Record<string, number>> = { f1: 19 * H, f2: 18 * H };
  const look: CalendarLook = {
    event: (id) => (id in EVENTS
      ? { noticed: { id, title: EVENTS[id]!.title, private: EVENTS[id]!.private, heldBack: false }, allDay: false }
      : null),
    found: (id) => FOUND[id] ?? null,
    clock,
  };
  const ON = all({ cal_invitation: true, cal_change: true, cal_answer: true, cal_found: true });
  const turn = (was: CalendarSample | null, now: CalendarSample | null, choices = ON, carries = EVERY, seen: CalendarLook | null = look) =>
    decideNotices(sample({ calendar: was }), sample({ calendar: now }), choices, "granted", carries, seen);
  const label = (text: string) => ({ as: "title", text });

  const before = cal({
    standing: new Map([["mv", stands(9)], ["cx", stands(10)]]),
    answers: new Map([["own", [1, 0, 0] as const]]),
    found: new Set(["f0"]),
  });
  const after = cal({
    invitations: new Set(["inv"]),
    standing: new Map([["inv", stands(14)], ["mv", stands(11)], ["cx", stands(10, "cancelled")]]),
    answers: new Map([["own", [3, 0, 0] as const]]),
    found: new Set(["f0", "f1", "f2"]),
  });

  it("an invitation, a move, a cancellation, answers and found events: one notice each, made by the makers", () => {
    expect(turn(before, after)).toEqual([
      { kind: "cal_invitation", eventId: "inv", label: label("Kickoff"), at: clock(14 * H), allDay: false },
      { kind: "cal_change", change: "moved", eventId: "mv", label: label("Review"), at: clock(11 * H), was: clock(9 * H), allDay: false },
      { kind: "cal_change", change: "cancelled", eventId: "cx", label: label("Shoot"), at: clock(10 * H), allDay: false },
      { kind: "cal_answer", eventId: "own", label: label("Studio day"), answer: "yes", count: 2 },
      { kind: "cal_found", count: 2, at: clock(18 * H) },
    ]);
  });

  it("the first sample of a calendar, and a sample with none, say nothing; nor does a second settle with no change", () => {
    expect(decideNotices(null, sample({ calendar: after }), ON, "granted", EVERY, look)).toEqual([]);
    expect(turn(null, after)).toEqual([]);
    expect(turn(before, null)).toEqual([]);
    expect(turn(after, after)).toEqual([]);
  });

  it("a moved event that is private says Busy; with titles hidden an event says Event", () => {
    const moved = (choices = ON) => turn(cal({ standing: new Map([["doc", stands(9)], ["mv", stands(9)]]) }),
      cal({ standing: new Map([["doc", stands(10)], ["mv", stands(10)]]) }), choices).map((n) => (n as { label?: unknown }).label);
    expect(moved()).toEqual([{ as: "busy" }, label("Review")]);
    expect(moved({ ...ON, showTitles: false })).toEqual([{ as: "busy" }, { as: "event" }]);
  });

  it("each kind's own switch, the master and what the surface carries", () => {
    const kinds = (choices = ON, carries = EVERY) => turn(before, after, choices, carries).map((n) => n.kind);
    expect(kinds({ ...ON, cal_invitation: false })).toEqual(["cal_change", "cal_change", "cal_answer", "cal_found"]);
    expect(kinds({ ...ON, cal_change: false, cal_found: false })).toEqual(["cal_invitation", "cal_answer"]);
    expect(kinds({ ...ON, cal_answer: false })).not.toContain("cal_answer");
    expect(kinds({ ...ON, master: false })).toEqual([]);
    expect(kinds(ON, ["ohbox", "cal_alert"])).toEqual([]);
    expect(kinds(all())).toEqual(["cal_invitation", "cal_change", "cal_change"]);
  });

  it("a cancelled event that is then deleted: one notice, at the cancel", () => {
    const one = cal({ standing: new Map([["cx", stands(10)]]) });
    const off = cal({ standing: new Map([["cx", stands(10, "cancelled")]]) });
    expect(turn(one, off).map((n) => n.kind)).toEqual(["cal_change"]);
    expect(turn(off, cal())).toEqual([]);
    expect(turn(one, cal()), "a record that only vanished names nothing").toEqual([]);
  });

  it("twelve events found at once: one notice that says twelve, at the first start; none found with no start", () => {
    const twelve = new Set(Array.from({ length: 12 }, (_, i) => `n${i}`));
    expect(turn(cal(), cal({ found: twelve }))).toEqual([{ kind: "cal_found", count: 12, at: null }]);
    expect(turn(cal(), cal({ found: new Set(["f1", "n0"]) }))).toEqual([{ kind: "cal_found", count: 2, at: clock(19 * H) }]);
  });

  it("an answer that rose says how many more; one that fell, a new record and a status that only changed say nothing", () => {
    const own = (counts: readonly [number, number, number]) => cal({ answers: new Map([["own", counts]]) });
    expect(turn(own([2, 1, 0]), own([1, 2, 1])).map((n) => n.kind === "cal_answer" && [n.answer, n.count])).toEqual([
      ["maybe", 1], ["no", 1],
    ]);
    expect(turn(cal(), own([3, 0, 0]))).toEqual([]);
    const tentative = cal({ standing: new Map([["mv", stands(9, "tentative")]]) });
    expect(turn(cal({ standing: new Map([["mv", stands(9)]]) }), tentative)).toEqual([]);
    expect(turn(cal({ standing: new Map([["mv", stands(9, "cancelled")]]) }), cal({ standing: new Map([["mv", stands(11)]]) }))).toEqual([]);
  });

  it("without a look, or with one that fails, no calendar notice is made and mail's still are", () => {
    const thrown: CalendarLook = { ...look, event: () => { throw new Error("the copy is gone"); } };
    const was = sample({ calendar: before, ohboxUnread: 1 });
    const now = sample({ calendar: after, ohboxUnread: 2 });
    expect(decideNotices(was, now, ON, "granted", EVERY)).toEqual([{ kind: "ohbox", count: 1 }]);
    expect(decideNotices(was, now, ON, "granted", EVERY, thrown)).toEqual([{ kind: "ohbox", count: 1 }]);
    expect(turn(before, after, ON, EVERY, { ...look, event: () => null }).map((n) => n.kind)).toEqual(["cal_found"]);
  });
});
