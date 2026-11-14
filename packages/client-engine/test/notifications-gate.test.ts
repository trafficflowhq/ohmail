import { describe, expect, it } from "vitest";
import {
  DEFAULT_CHANNELS,
  decideNotices,
  channelsAreLive,
  mayPost,
  type NotificationChannels,
} from "../src/notifications.js";
import { noticeChoicesOf, type NoticeChoices } from "../src/notices/choices.js";
import { NOTICE_COUNT_MAX, NOTICE_KINDS, type Notice } from "../src/notices/kinds.js";
import type { NoticeSample, SendStanding } from "../src/notices/gate.js";

/**
 * THE GATE — the behavioural half of "fully off means no code path fires".
 *
 * The other half is the source census (`notifications-gate-census`), which asserts no surface
 * draws a notice without coming through here. This file asserts that coming through here with the
 * master off produces nothing to draw. Neither is sufficient alone: the census cannot tell whether
 * the gate's answer is right, and this cannot tell whether somebody added a fourth emitter that
 * skips it.
 */

const sample = (over: Partial<NoticeSample> = {}): NoticeSample =>
  ({ ohboxUnread: 0, screenerWaiting: 0, sends: new Map(), devices: 1, ...over });
const sends = (...rows: [string, SendStanding][]): ReadonlyMap<string, SendStanding> => new Map(rows);
const base = sample();
/** A device's stored record with `over` on top, as the gate is handed it. */
const all = (over: Partial<NoticeChoices> = {}): NoticeChoices =>
  ({ ...noticeChoicesOf(DEFAULT_CHANNELS, null, { ohcalPhone: false }), ...over });
const channels = (over: Partial<NotificationChannels> = {}): NotificationChannels => ({ ...DEFAULT_CHANNELS, ...over });
const EVERY = NOTICE_KINDS;

/** Everything happened at once: mail, a waiting sender, a send that went, one that did not, a new device. */
const busy = sample({
  ohboxUnread: 3, screenerWaiting: 2, devices: 2,
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
    ...sample({ ohboxUnread: 1, screenerWaiting: 1, devices: 2, sends: sends(["failed-one", "failed"]) }),
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
  it("says a device joined, and that one left", () => {
    expect(decideNotices(base, sample({ devices: 2 }), all(), "granted", EVERY)).toEqual([{ kind: "pairing", change: "paired", device: null }]);
    expect(decideNotices(sample({ devices: 2 }), base, all(), "granted", EVERY)).toEqual([{ kind: "pairing", change: "revoked", device: null }]);
  });

  it("says nothing where a sample does not know the number", () => {
    expect(decideNotices(sample({ devices: null }), sample({ devices: 2 }), all(), "granted", EVERY)).toEqual([]);
    expect(decideNotices(base, sample({ devices: null }), all(), "granted", EVERY)).toEqual([]);
    expect(decideNotices(base, sample({ devices: Number.NaN }), all(), "granted", EVERY)).toEqual([]);
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
