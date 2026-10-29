/** @vitest-environment jsdom */
/**
 * THE SCREENER'S KNOCK SAYS ITS WHOLE SENTENCE AT LARGE TEXT, rendered. At Android font 2.0 on a
 * 360 dp phone and at the iPhone's AX3 the capsule cut "5 new senders waiting" to "5 new send…": the
 * one place the count is said in words. The sentence wraps, and the faces give way to it.
 */
import { createElement as h, useEffect, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const screen = vi.hoisted(() => ({ fontScale: 1, width: 340 }));

vi.mock("react-native", async () => ({
  ...(await import("./_rendered-dom")).rnDom,
  AccessibilityInfo: { announceForAccessibility: () => undefined },
  Animated: { View: () => null, Value: class { setValue() {} }, timing: () => ({ start: () => undefined }) },
  Easing: { bezier: () => (x: number) => x },
  useWindowDimensions: () => ({ width: 360, height: 780, scale: 3, fontScale: screen.fontScale }),
}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock("expo-router", () => ({ router: { push: () => undefined } }));
vi.mock("../src/ui/base", () => ({
  /* The capsule's own width, as the device lays it out. */
  Tap: (p: { children?: ReactNode; onLayout?: (e: unknown) => void }) => {
    useEffect(() => { p.onLayout?.({ nativeEvent: { layout: { width: screen.width, height: 44 } } }); }, []);
    return h("div", { "data-tap": "" }, p.children);
  },
  Txt: (p: { children?: ReactNode; numberOfLines?: number }) =>
    h("span", { "data-txt": "", "data-lines": p.numberOfLines ?? "" }, p.children),
  useTopPad: () => 0,
}));
vi.mock("../src/theme", () => ({
  useTheme: () => ({ c: new Proxy({}, { get: () => "#000" }), radius: new Proxy({}, { get: () => 8 }), lift: () => ({}) }),
}));
vi.mock("../src/engine/engine-log", () => ({ logNotice: () => undefined }));
vi.mock("../src/state/world", () => ({ useWorld: () => ({}), useWorldToast: () => ({ say: () => undefined }) }));
vi.mock("../src/state/toast-one", () => ({}));
vi.mock("../src/state/live", () => ({ firstSyncContinuesSaid: () => null, topLineSaid: () => null }));
vi.mock("../src/net/network-door", () => ({ useNetworkNow: () => "online" }));
vi.mock("../src/ui/Icon", () => ({ Icon: () => null }));
vi.mock("../src/ui/pane-chrome", () => ({ usePaneChrome: () => null }));
vi.mock("../src/ui/posture", () => ({ useAppWindow: () => null, usePosture: () => null }));
vi.mock("../src/ui/scaffold/plan", () => ({ scaffoldPlan: () => null, screenHingeClearance: () => 0 }));
vi.mock("../src/ui/bottom-chrome", () => ({ toastBottom: () => 0, toastSpan: () => ({}), useBottomChromeExtent: () => 0 }));
vi.mock("../src/ui/glass", () => ({ GlassPill: () => null }));
vi.mock("../src/ui/UnsavedChanges", () => ({ UnsavedChanges: () => null }));
vi.mock("../src/ui/FadeOut", () => ({ FadeOut: () => null }));

const { mount } = await import("./_rendered-dom");
const { Doorbell } = await import("../src/ui/chrome");
const { Copy } = await import("../src/copy");

const FACES = ["A", "B", "C", "D", "E"];
const knock = () => mount(h(Doorbell, { initials: FACES, count: 5 }));
const sentence = (el: HTMLElement) =>
  [...el.querySelectorAll<HTMLElement>("[data-txt]")].find((n) => n.textContent?.startsWith(Copy.doorbell(5)));
const faces = (el: HTMLElement) =>
  [...el.querySelectorAll<HTMLElement>("[data-txt]")].filter((n) => FACES.includes(n.textContent ?? "")).length;

afterEach(() => { screen.fontScale = 1; });

describe("the doorbell at large text", () => {
  it("wraps its sentence rather than cutting it, and leaves the faces out at font 2.0", () => {
    screen.fontScale = 2;
    const { el, unmount } = knock();
    const said = sentence(el);
    expect(said?.textContent).toBe(`${Copy.doorbell(5)} ${Copy.doorbellRest(5)}`);
    expect(said?.getAttribute("data-lines"), "the sentence is capped at a line count").toBe("");
    expect(faces(el), "faces took the sentence's room").toBe(0);
    unmount();
  });

  it("CONTROL: at the default size the same capsule keeps three faces", () => {
    const { el, unmount } = knock();
    expect(faces(el)).toBe(3);
    unmount();
  });
});
