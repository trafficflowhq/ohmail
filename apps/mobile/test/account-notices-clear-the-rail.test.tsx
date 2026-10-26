/** @vitest-environment jsdom */
/**
 * THE ACCOUNT NOTICES STAND IN THE SAFE AREA AND BESIDE THE RAIL, rendered. `Gated` draws the storage
 * notice and the lifecycle strip above every screen, outside the `Screen` that pays the insets and the
 * rail. On a 7.6in foldable's inner screen the notice sat under the status bar (the clock inside its
 * border) and, in two panes, under the floating rail: "The" read "…he", and Dismiss overlapped the
 * Screener item. Mounted at the inner screen's portrait (718 x 897) and two-pane landscape (897 x 718),
 * and on the outer screen (353 x 792, a dock, no rail) as the control.
 */
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { derivePosture } from "../src/ui/posture/derive";
import { mount, styleOf } from "./_rendered-dom";

vi.mock("react-native", async () => ({
  ...(await import("./_rendered-dom")).rnDom,
  Linking: { openURL: async () => undefined },
  ActivityIndicator: () => null,
}));
const live = vi.hoisted(() => ({
  posture: null as unknown, insets: { top: 0, bottom: 0, left: 0, right: 0 }, feed: null as unknown,
}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => live.insets }));
vi.mock("../src/ui/posture", async () => ({
  ...(await import("../src/ui/posture/derive")),
  usePosture: () => live.posture,
  useAppWindow: () => ({ width: 0, height: 0 }),
}));
vi.mock("../src/theme", () => ({
  useTheme: () => ({
    c: new Proxy({}, { get: () => "#000" }), radius: new Proxy({}, { get: () => 8 }),
    space: new Proxy({}, { get: () => 8 }), type: new Proxy({}, { get: () => ({}) }),
    lift: () => ({}), textCap: 2, textKey: 1, reduceMotion: true,
  }),
}));
vi.mock("../src/ui/Icon", () => ({ Icon: () => null }));
vi.mock("../src/i18n/LocaleProvider", () => ({ useLocale: () => "en" }));
vi.mock("../src/state/world", () => ({ useWorld: () => ({ mailboxes: { known: false, rows: [] } }) }));
vi.mock("../src/ui/AccountWall", () => ({ appLifecycle: {} }));
vi.mock("../src/ui/wall-lift", () => ({ RETURN_DEBOUNCE_MS: 0, wallLift: () => ({ stop: () => undefined, armPoll: () => undefined }) }));
vi.mock("../src/net/account", async () => ({
  ...(await vi.importActual<object>("../src/net/account")),
  accessFeedFor: () => live.feed,
  onAccessFeed: () => () => undefined,
  readAccess: async () => null,
}));

const { accessOf } = await vi.importActual<typeof import("../src/net/account")>("../src/net/account");
const { StorageNotice } = await import("../src/ui/StorageNotice");
const { LifecycleStrip } = await import("../src/ui/LifecycleStrip");
const { listNavClearance, scaffoldPlan } = await import("../src/ui/scaffold/plan");

const EMPTIED = {
  usedBytes: 1_868_000_000, limitBytes: 2_000_000_000, emptiedForSpace: 3,
  firstEmptiedAt: "2026-10-20T03:00:00.000Z", keptFrom: null, withheldOnArrival: 0, emptyingNow: true,
};
const trialEnds = new Date(Date.now() + 24 * 3600_000).toISOString();
const session = { standalone: false, profile: { id: "p-1" }, ownerKey: "o-1" } as never;
const STATUS_BAR = 24;

function pose(width: number, height: number, sides = 0) {
  live.posture = derivePosture({ width, height, platform: "android", folds: [], hasFold: true });
  live.insets = { top: STATUS_BAR, bottom: 16, left: sides, right: sides };
  live.feed = {
    answer: accessOf({
      metered: true, access: "open",
      lifecycle: { state: "trialing", closedReason: null, trialEndsAt: trialEnds }, storage: EMPTIED,
    }),
    caughtUp: null, at: 0,
  };
  return listNavClearance(scaffoldPlan(live.posture as never, "android"), 0);
}
/** The card's own box: the outermost view, whose margins place it. */
const card = (el: HTMLElement) => styleOf(el.querySelector('[data-rn="View"]'));

let open: { unmount(): void } | null = null;
afterEach(() => { open?.unmount(); open = null; });

describe.each([
  ["the storage notice", () => createElement(StorageNotice, { session })],
  ["the lifecycle strip", () => createElement(LifecycleStrip, { session })],
])("%s on a 7.6in foldable", (_name, render) => {
  it("portrait, inner screen: below the status bar, past the rail's column", () => {
    const rail = pose(718, 897);
    expect(rail.left, "the inner portrait has no rail to clear").toBeGreaterThan(16);
    const m = mount(render()); open = m;
    expect(card(m.el)).toMatchObject({ marginTop: STATUS_BAR + 8, marginLeft: rail.left, marginRight: 16 });
  });

  it("two panes, landscape: beside the floating rail, never under it", () => {
    const rail = pose(897, 718);
    const m = mount(render()); open = m;
    expect(card(m.el)).toMatchObject({ marginTop: STATUS_BAR + 8, marginLeft: rail.left, marginRight: 16 });
  });

  it("a side cutout is paid on top of the rail's column", () => {
    const rail = pose(897, 718, 30);
    const m = mount(render()); open = m;
    expect(card(m.el)).toMatchObject({ marginLeft: 30 + rail.left, marginRight: 30 + 16 });
  });

  it("the control: the outer screen has a dock, so the card keeps its own gutter", () => {
    expect(pose(353, 792).left).toBe(0);
    const m = mount(render()); open = m;
    expect(card(m.el)).toMatchObject({ marginTop: STATUS_BAR + 8, marginLeft: 16, marginRight: 16 });
  });
});
