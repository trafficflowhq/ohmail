/** @vitest-environment jsdom */
import { act, createElement as h } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { derivePosture } from "../src/ui/posture/derive";

const scene = vi.hoisted(() => ({ width: 403, height: 905, top: 62, bottom: 34, push: vi.fn() }));
vi.mock("react-native", async () => (await import("./_rendered-dom")).rnDom);
vi.mock("react-native-svg", () => ({ default: () => null, Circle: () => null }));
vi.mock("expo-router", () => ({ router: { push: scene.push }, Redirect: () => null }));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: scene.bottom }) }));
vi.mock("../src/engine/engine-artifact", () => ({ phoneEngineStart: () => () => undefined }));
vi.mock("../src/engine/standalone-door", () => ({ standaloneAvailable: () => true }));
vi.mock("../src/i18n/LocaleProvider", () => ({ useLocale: () => "en" }));
vi.mock("../src/net/connection", () => ({ useConnection: () => ({ state: { k: "setup" } }) }));
vi.mock("../src/ui/ErrorBoundary", () => ({ SurfaceBoundary: ({ children }: React.PropsWithChildren) => children }));
vi.mock("../src/ui/UnsavedChanges", () => ({ UnsavedChanges: () => null }));
vi.mock("../src/ui/nav-drawn", () => ({ useNavDrawn: () => false }));
vi.mock("../src/ui/posture", () => ({
  usePosture: () => derivePosture({ platform: "ios", width: scene.width, height: scene.height, folds: [], hasFold: false }),
}));
vi.mock("../src/theme", () => ({ useTheme: () => ({ face: "paper", scheme: "light" }) }));
vi.mock("../src/ui/Icon", () => ({
  Icon: () => null,
  WelcomeWordmark: ({ em }: { em: number }) => h("svg", { height: 0.825 * em, "aria-label": "ohmail" }),
}));
vi.mock("../src/ui/base", async () => {
  const { rnDom } = await import("./_rendered-dom");
  return {
    Screen: rnDom.View,
    Tap: rnDom.Pressable,
    Txt: ({ style, children }: React.PropsWithChildren<{ style: unknown }>) => h(rnDom.Text, { style, accessibilityRole: "header" }, children),
    Scroller: ({ children, contentStyle, bounded }: React.PropsWithChildren<{ contentStyle: unknown; bounded: boolean }>) =>
      h(rnDom.ScrollView, { style: contentStyle, accessibilityLabel: bounded ? "Bounded onboarding" : undefined }, children),
    Button: ({ label, appearance, style, onPress }: {
      label: string; appearance: { surface: object }; style: unknown; onPress: () => void;
    }) => h("button", { "data-height": appearance.surface && ("minHeight" in appearance.surface ? appearance.surface.minHeight : 0), style: style as object, onClick: onPress }, label),
    useTopPad: () => scene.top,
  };
});

const { buttonByName, mount, styleOf } = await import("./_rendered-dom");
const { default: WelcomeScreen } = await import("../app/welcome");

afterEach(() => scene.push.mockClear());

it("keeps all welcome actions above the home indicator after rotating to the short phone window", () => {
  const page = mount(h(WelcomeScreen));
  try {
    const connect = () => buttonByName(page.el, "Sign in");
    const scan = () => buttonByName(page.el, "Scan QR");
    const servers = () => buttonByName(page.el, "Sign in self hosted");
    expect(styleOf(connect().parentElement).flexDirection).not.toBe("row");

    Object.assign(scene, { width: 905, height: 403, top: 0, bottom: 21 });
    page.render(h(WelcomeScreen));
    const actions = connect().parentElement!;
    expect(scan().parentElement).toBe(actions);
    const scroller = actions.closest('[data-label="Bounded onboarding"]')!;
    expect(servers().parentElement).not.toBe(actions);
    expect(scroller.getAttribute("data-label")).toBe("Bounded onboarding");
    const px = (el: Element | null, key: string) => Number(styleOf(el)[key] ?? 0);
    const heights = [connect(), scan()].map((button) => Number(button.dataset.height));
    const actionsHeight = styleOf(actions).flexDirection === "row"
      ? Math.max(...heights)
      : heights.reduce((sum, value) => sum + value, 0) + px(actions, "gap");
    const title = scroller.querySelector('[data-role="header"]')!;
    const mark = scroller.querySelector('svg[aria-label="ohmail"]')!;
    const hero = title.parentElement!;
    const center = hero.parentElement!;
    const header = scroller.previousElementSibling!.firstElementChild!;
    const required = scene.top + px(header, "height") + px(center, "paddingTop") + 2 * px(center, "paddingVertical")
      + px(hero, "paddingTop") + Number(mark.getAttribute("height")) + px(hero, "gap") + 2 * px(title, "lineHeight")
      + px(actions.parentElement, "paddingTop") + px(actions.parentElement, "gap")
      + actionsHeight + Number(servers().dataset.height);
    expect(px(scroller, "paddingBottom")).toBeGreaterThanOrEqual(scene.bottom);
    expect(required + px(scroller, "paddingBottom")).toBeLessThanOrEqual(scene.height);

    act(() => { scan().click(); });
    expect(scene.push.mock.calls).toEqual([["/scan"]]);

    Object.assign(scene, { width: 403, height: 905, top: 62, bottom: 34 });
    page.render(h(WelcomeScreen));
    expect(styleOf(connect().parentElement).flexDirection).not.toBe("row");
  } finally {
    page.unmount();
    Object.assign(scene, { width: 403, height: 905, top: 62, bottom: 34 });
  }
});
