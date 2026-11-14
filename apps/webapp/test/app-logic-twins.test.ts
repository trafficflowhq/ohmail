/** @vitest-environment jsdom */
/**
 * TWO THINGS EXIST TWICE: the geometry under the web door's text size, and the keys a browser
 * scrolls with. Behaviour may not import the component kit, and the kit needs both for itself.
 * Until the kit stops exporting them, each pair answers the same for the same page.
 */
import { afterEach, describe, expect, expectTypeOf, it } from "vitest";
import * as kit from "@ohmail/ui";
import * as geometry from "@ohmail/app-logic/geometry";
import { SCROLL_KEYS } from "@ohmail/app-logic/keys";
import type { ToastFn, ToastOptions } from "@ohmail/app-logic/press/report";
import {
  DECISION_KEY,
  DECISION_ORDER,
  DECISION_QUIET,
  PILE_KEY,
  PILE_VERB_KEY,
  type DecisionDestination,
  type DecisionScope,
} from "@ohmail/app-logic/screener/decision";
import * as decisionCopy from "../app/shell/decision-copy";
import type { ConsentStateWire as ConsentReadOfTheRow } from "@ohmail/app-logic/consent/consent-wire";
import type { ConsentStateWire as ConsentReadOfTheClient } from "../app/api-client";
import type * as JunkAnswers from "@ohmail/app-logic/screener/junk-answers";
import type * as SuggestAnswers from "@ohmail/app-logic/screener/suggest-answers";
import type * as ServerClient from "../app/api-client";
import type * as Host from "@ohmail/app/host";
import type * as Junk from "@ohmail/app-logic/screener/junk-window";
import type * as Suggest from "@ohmail/app-logic/screener/screener-suggest";
import { autoLoadsImages as readerAutoLoads } from "@ohmail/app-logic/reader";
import { HELD_FOLDERS } from "@trafficflow/core/destinations";
import { autoLoadsImages as shellAutoLoads } from "../app/shell/remote-images";
import * as horizons from "@ohmail/app-logic/reader";
import * as shellFormat from "../app/shell/format";
import { setActiveFormatZone } from "../app/shell/locale";

const html = (): HTMLElement => document.documentElement;
afterEach(() => html().removeAttribute("style"));

function boxAt(x: number, y: number, width: number, height: number): HTMLElement {
  const el = document.createElement("div");
  const r = { x, y, width, height, left: x, top: y, right: x + width, bottom: y + height };
  el.getBoundingClientRect = () => ({ ...r, toJSON: () => r }) as DOMRect;
  document.body.appendChild(el);
  return el;
}

const numbers = ({ top, left, right, bottom, width, height, x, y }: geometry.CssRect) =>
  ({ top, left, right, bottom, width, height, x, y });

describe("the geometry's twin", () => {
  for (const stamp of [null, "1", "1.25", "0.9", "0", "wide"]) {
    it(`answers as the kit does with ${stamp === null ? "no zoom stamped" : `--ui-zoom: ${stamp}`}`, () => {
      if (stamp !== null) html().style.setProperty(kit.UI_ZOOM_VAR, stamp);
      const el = boxAt(50, 100, 250, 125);
      expect(geometry.UI_ZOOM_VAR).toBe(kit.UI_ZOOM_VAR);
      expect(geometry.uiZoom()).toBe(kit.uiZoom());
      expect(numbers(geometry.cssRect(el))).toEqual(numbers(kit.cssRect(el)));
      expect(geometry.cssPoint({ clientX: 30, clientY: 40 })).toEqual(kit.cssPoint({ clientX: 30, clientY: 40 }));
      expect(geometry.cssViewport()).toEqual(kit.cssViewport());
      expect(geometry.cssViewport(null)).toEqual(kit.cssViewport(null));
    });
  }

  it("hands back the browser's own rect where no zoom is stamped, as the kit does", () => {
    const el = boxAt(1, 2, 3, 4);
    const rect = el.getBoundingClientRect();
    el.getBoundingClientRect = () => rect;
    expect(geometry.cssRect(el)).toBe(rect);
    expect(kit.cssRect(el)).toBe(rect);
  });
});

describe("the scroll keys' twin", () => {
  it("names the keys the kit names, and no other", () => {
    expect([...SCROLL_KEYS].sort()).toEqual([...kit.SCROLL_KEYS].sort());
  });
});

/**
 * AND FOUR TYPES ARE DECLARED TWICE: what a toast takes, and where a decision sends a sender. The
 * press seam and the Screener's rules name them without the kit; the compiler holds each pair equal
 * here, and the decision's members are compared with the keys the kit's bar really binds.
 */
describe("the types behaviour declares beside the kit's", () => {
  it("a decision's destinations are the ones the kit's decision bar binds a key to", () => {
    const destinations: Record<DecisionDestination, true> = { ohbox: true, reads: true, receipts: true, screened: true, spam: true };
    expect(Object.keys(destinations).sort()).toEqual(Object.keys(kit.DECISION_KEY).sort());
    expectTypeOf<DecisionDestination>().toEqualTypeOf<kit.DecisionDestination>();
    expectTypeOf<DecisionScope>().toEqualTypeOf<kit.DecisionScope>();
  });

  it("the destinations that take no read verb are the ones the kit's bar keeps quiet", () => {
    expect([...DECISION_QUIET].sort()).toEqual([...kit.DECISION_QUIET].sort());
  });

  it("each decision's key, in the order the kit's bar lists them, and the pile names the shell's table reads", () => {
    expect(DECISION_KEY).toEqual(kit.DECISION_KEY);
    expect(DECISION_ORDER).toEqual(Object.keys(kit.DECISION_KEY));
    expect(PILE_KEY).toEqual(decisionCopy.PILE_KEY);
    expect(PILE_VERB_KEY).toEqual(decisionCopy.PILE_VERB_KEY);
  });

  it("the press seam's report is the kit's toast, option for option", () => {
    expectTypeOf<ToastOptions>().toEqualTypeOf<kit.ToastOptions>();
    expectTypeOf<ToastFn>().toEqualTypeOf<kit.ToastFn>();
  });
});

/**
 * AND THE CONSENT READ IS DECLARED TWICE: by the server client and by the consent row, which may not import it. The
 * row's is the client's own, narrowed to the fields the row reads. (The desktop's stand-in for the client is held to
 * the row's in the desktop's tests: no file of this app may import that one.)
 */
describe("the consent read as the consent row declares it", () => {
  it("is the server client's, field for field, but for the one field the row hands on unread", () => {
    type Shared = Exclude<keyof ConsentReadOfTheRow, "screeningByMailbox">;
    expectTypeOf<ConsentReadOfTheClient>().toMatchTypeOf<ConsentReadOfTheRow>();
    expectTypeOf<keyof ConsentReadOfTheRow>().toMatchTypeOf<keyof ConsentReadOfTheClient>();
    expectTypeOf<Pick<ConsentReadOfTheRow, Shared>>().toEqualTypeOf<Pick<ConsentReadOfTheClient, Shared>>();
    const heldEqual: Record<Shared, true> = {
      seedConfirmedAt: true, dormancyDays: true, screeningBaselineAt: true, autoSuggestAt: true, autoActAt: true,
      blockRemoteImagesAt: true, loadTrackingPixelsAt: true, blockAutoUnsubscribeAt: true, foldersEnabledAt: true,
      folderMailboxesOff: true, signatures: true, signaturesHtml: true, signatureSources: true, signatureChanges: true,
      dormancyChange: true, locale: true, themeFace: true, resurfaceTime: true, onboardingCompletedAt: true,
      screeningScope: true,
    };
    expect(Object.keys(heldEqual)).toHaveLength(20);
  });
});

/**
 * AND THE ANSWERS OF THE SCREENER'S TWO WIRES ARE DECLARED TWICE: by the server client, and beside the Junk window
 * and the suggestion run, which may not import it. Each is the client's own, field for field: a host's wire that
 * answers the one answers the other. And the two wires themselves: the host contract's and the hooks' own, which the
 * ground's mount casts the one to the other, hold the same members.
 */
describe("the answers of the Junk wire and of the suggestion wire as the Screener's logic declares them", () => {
  it("are the server client's, type for type", () => {
    expectTypeOf<JunkAnswers.JunkItemWire>().toEqualTypeOf<ServerClient.JunkItemWire>();
    expectTypeOf<JunkAnswers.JunkMailboxWire>().toEqualTypeOf<ServerClient.JunkMailboxWire>();
    expectTypeOf<JunkAnswers.JunkPageWire>().toEqualTypeOf<ServerClient.JunkPageWire>();
    expectTypeOf<JunkAnswers.JunkRescueWire>().toEqualTypeOf<ServerClient.JunkRescueWire>();
    expectTypeOf<JunkAnswers.JunkSearchWire>().toEqualTypeOf<ServerClient.JunkSearchWire>();
    expectTypeOf<JunkAnswers.JunkSweepWire>().toEqualTypeOf<ServerClient.JunkSweepWire>();
    expectTypeOf<SuggestAnswers.ScreenerWirePage>().toEqualTypeOf<ServerClient.ScreenerWirePage>();
    expectTypeOf<SuggestAnswers.ScreenerSkipReason>().toEqualTypeOf<ServerClient.ScreenerSkipReason>();
    expectTypeOf<SuggestAnswers.ScreenerSuggestWire>().toEqualTypeOf<ServerClient.ScreenerSuggestWire>();
  });

  it("the code for a server never reached is the server client's own", async () => {
    const { UNREACHED_CODE } = await import("../app/shell/screener-suggest");
    const { OFFLINE_CODE } = await import("../app/api-client");
    expect(UNREACHED_CODE).toBe(OFFLINE_CODE);
  });

  it("the wires a host hands are the Junk window's and the suggestion run's own, member for member", () => {
    expectTypeOf<keyof Host.JunkWire>().toEqualTypeOf<keyof Junk.JunkWire>();
    expectTypeOf<keyof Host.SuggestWire>().toEqualTypeOf<keyof Suggest.SuggestWire>();
  });
});

/**
 * AND THE PICTURES' ONE DEFAULT-READ TERM: the reader decides a letter's pictures with `autoLoadsImages` of
 * `@ohmail/app-logic/reader`, today's reader with the web shell's. Each answers the same for every letter until the
 * shell's becomes a re-export of the reader's.
 */
describe("whether a letter loads its pictures on open, twice", () => {
  const held = HELD_FOLDERS[0]!;
  const checks = [undefined, null, { reason: "impersonation" }, { reason: "unverified" }, { reason: "other" }];
  const folders = [undefined, "INBOX", held];
  for (const auto of [true, false]) {
    for (const senderCheck of checks) {
      for (const folder of folders) {
        for (const physicalFolder of folders) {
          const m = { senderCheck, folder, physicalFolder };
          it(`auto ${auto}, check ${JSON.stringify(senderCheck)}, shown in ${folder}, filed in ${physicalFolder}`, () => {
            expect(readerAutoLoads({ auto }, m)).toBe(shellAutoLoads({ auto }, m));
          });
        }
      }
    }
  }
  it("no seam loads nothing", () => {
    expect(readerAutoLoads(undefined, {})).toBe(shellAutoLoads(undefined, {}));
  });
});

describe("the resurface horizons, twice", () => {
  afterEach(() => setActiveFormatZone(null));
  /* Ordinary days, a Sunday, a Monday, the small hours, the two nights a year a clock skips or repeats, the turn of a year. */
  const instants = [
    "2026-11-10T08:00:00Z", "2026-11-15T10:00:00Z", "2026-11-16T06:30:00Z", "2026-11-11T01:30:00Z",
    "2026-03-28T12:00:00Z", "2026-10-24T12:00:00Z", "2026-12-31T22:45:00Z", "2026-03-07T23:30:00Z",
  ];
  const zones = ["Europe/Zurich", "America/New_York", "Asia/Kolkata", "Pacific/Auckland", "UTC"];
  const clocks = [null, "02:30", "09:00", "23:59", "7:5", "08:15"];
  it("the reader's answer what the shell's answer, in every zone, at every clock", () => {
    for (const zone of zones) {
      setActiveFormatZone(zone);
      for (const at of instants) {
        const base = new Date(at);
        for (const clock of clocks) {
          expect(horizons.resurfaceHorizonsIn(base, clock, zone)).toEqual(shellFormat.resurfaceHorizons(base, clock));
          expect(horizons.firstDayAtIn(base, clock, zone)).toEqual(shellFormat.firstDayAt(base, clock));
          expect(horizons.dayAtIn("2026-03-29", clock, zone)).toEqual(shellFormat.dayAt("2026-03-29", clock));
          expect(horizons.dayAtIn(at, clock, zone)).toEqual(shellFormat.dayAt(at, clock));
        }
        expect(horizons.dayValueIn(at, zone)).toBe(shellFormat.dayValue(at));
      }
    }
    expect(horizons.DEFAULT_RESURFACE_TIME).toBe(shellFormat.DEFAULT_RESURFACE_TIME);
  });
});
