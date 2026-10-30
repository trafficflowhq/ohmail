import { describe, expect, it } from "vitest";
import { screenerMetaOf } from "../src/state/world-projection";
import { EN } from "../src/copy.en";
import { DE } from "../src/copy.de";
import {
  answersPerMailbox, presentedOptions, screeningAnswered, widestWindowOfAnswer, SCREENING_UNANSWERED, SCREENING_UNSUPPLIED,
} from "../src/state/live";

/**
 * THE PHONE'S SCREENER META SAYS WHY ITS COUNT IS THE FOLDER WHOLE (RULING-026): beside the count,
 * the holder whose window is unread or unstated; nothing more while every window is stated, and
 * nothing in the postures that carry no map (the unanswered read is withheld elsewhere).
 */
const BASE = { dormancyDays: 60, baselineAt: null, scope: "window" } as const;
/** One `screeningByMailbox` entry as `GET /consent` sends it. */
const W = (source: "own" | "organizer" | "unread" | "unstated", name: string | null = "Studio Mac") =>
  ({ baselineAt: null, dormancyDays: 60, scope: "all_time", source, holder: { kind: "local", name, since: null }, asOf: null });

describe("the phone's Screener meta", () => {
  it("unstated names the holder", () => {
    expect(screenerMetaOf("server", 40, screeningAnswered({ ...BASE, byMailbox: { mb: W("unstated") } })))
      .toBe("40 first-time senders waiting. Studio Mac runs an older ohmail that doesn’t share its screening window — showing everyone in the Screener folder.");
  });
  it("unread names the holder, or the organizing device", () => {
    expect(screenerMetaOf("server", 1, screeningAnswered({ ...BASE, byMailbox: { mb: W("unread") } })))
      .toBe("1 first-time sender waiting. Showing everyone in the Screener folder — Studio Mac’s screening settings haven’t been read yet.");
    expect(screenerMetaOf("server", 1, screeningAnswered({ ...BASE, byMailbox: { mb: W("unread", null) } })))
      .toContain("the organizing device’s screening settings");
  });
  it("on a standalone phone that organizes the mailbox, a window read before it started is not another device's", () => {
    for (const w of [W("unread", null), W("unread"), W("unstated")]) {
      const said = screenerMetaOf("server", 0, screeningAnswered({ ...BASE, byMailbox: { mb: w } }), true);
      expect(said).toBe("0 first-time senders waiting. Showing everyone in the Screener folder until this phone’s own screening settings apply at its next check.");
    }
    expect(screenerMetaOf("server", 2, screeningAnswered({ ...BASE, byMailbox: { mb: W("own") } }), true)).toBe("2 first-time senders waiting");
    expect(DE.screeningUnreadHere).not.toBe(EN.screeningUnreadHere);
  });
  it("CONTROL: stated windows, no map, and the two map-less postures say the count alone", () => {
    expect(screenerMetaOf("server", 3, screeningAnswered({ ...BASE, byMailbox: { mb: W("organizer"), mc: W("own") } })))
      .toBe("3 first-time senders waiting");
    expect(screenerMetaOf("server", 3, screeningAnswered(BASE))).toBe("3 first-time senders waiting");
    expect(screenerMetaOf("device", 3, SCREENING_UNSUPPLIED)).toBe("3 first-time senders waiting, counted on this phone");
    expect(screenerMetaOf("server", 3, SCREENING_UNANSWERED)).toBe("3 first-time senders waiting");
  });
});

describe("the standalone door partitions by the map when its engine sends one", () => {
  it("answersPerMailbox reads the wire map, and the options carry the windows alone", () => {
    const answered = screeningAnswered({ ...BASE, byMailbox: { mb: W("organizer") } });
    expect(answersPerMailbox(answered)).toBe(true);
    expect(answersPerMailbox(screeningAnswered(BASE))).toBe(false);
    expect(answersPerMailbox(SCREENING_UNANSWERED)).toBe(false);
    expect(presentedOptions(new Date(), false, answered).byMailbox)
      .toEqual({ mb: { baselineAt: null, dormancyDays: 60, scope: "all_time" } });
  });

  it("the mirror's prune is told the organizers' widest window, never the phone's own row", () => {
    const own7 = { dormancyDays: 7, baselineAt: null, scope: "window" } as const;
    const windows = { mb: { ...W("organizer"), scope: "window", dormancyDays: 365 }, mc: { ...W("own"), scope: "window", dormancyDays: 30 } };
    expect(widestWindowOfAnswer(screeningAnswered({ ...own7, byMailbox: windows }))).toEqual({ dormancyDays: 365, scope: "window" });
    expect(widestWindowOfAnswer(screeningAnswered(own7))).toBeNull();
  });
});
