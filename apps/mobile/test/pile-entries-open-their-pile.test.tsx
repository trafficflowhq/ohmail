/** @vitest-environment jsdom */
/**
 * MORE'S PILE ENTRIES OPEN THEIR OWN PILE: Answer Later, Parked and Resurface each push the Piles
 * screen naming their pile, and the screen given a pile shows that pile alone under its title.
 * Without a pile it stays the three-pile screen. On two panes the entry opens the pile beside More's
 * rows instead, and the Piles screen shown full-screen there moves into that pane. Rendered through
 * React DOM with the world and the screen primitives stood in.
 */
import { createElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Copy } from "../src/copy";
import { pileParam } from "../src/state/model";

vi.mock("react-native", async () => ({ ...(await import("./_rendered-dom")).rnDom }));
vi.mock("../src/ui/base", async () => {
  const { rnDom } = await import("./_rendered-dom");
  const box = (p: { children?: ReactNode }) => createElement("div", null, p.children);
  return {
    Screen: box, Scroller: box, Panel: box, Rule: () => null, TagDot: () => null,
    Badge: (p: { children?: ReactNode }) => createElement("i", null, p.children),
    Section: (p: { children?: ReactNode }) => createElement("h2", null, p.children),
    TapRow: (p: { children?: ReactNode; onPress?: () => void; selected?: boolean }) =>
      createElement("div", { "data-rn": "Pressable", "data-selected": p.selected ? "" : undefined, onClick: p.onPress }, p.children),
    Txt: (p: { variant?: string; children?: ReactNode }) => createElement("span", { "data-variant": p.variant }, p.children),
  };
});
vi.mock("../src/theme", () => ({
  useTheme: () => ({ c: new Proxy({}, { get: () => "#000" }), radius: { card: 8 }, lift: () => ({}) }),
}));
vi.mock("../src/ui/chrome", () => ({ DetailBar: () => null, PaneTop: () => null }));
vi.mock("../src/ui/Gated", () => ({ Gated: (p: { children?: ReactNode }) => p.children }));
vi.mock("../src/ui/ErrorBoundary", () => ({ SurfaceBoundary: (p: { children?: ReactNode }) => p.children }));
vi.mock("../src/i18n/LocaleProvider", () => ({ useLocale: () => "en" }));
vi.mock("../src/ui/Skeleton", () => ({ SkeletonList: () => null }));
vi.mock("../src/ui/Icon", () => ({ Icon: () => null }));
vi.mock("../src/ui/FoldersGroup", () => ({ FoldersGroup: () => null }));
vi.mock("../src/state/pull", () => ({ usePullToSync: () => undefined }));
const route = vi.hoisted(() => ({ params: {} as Record<string, string>, push: vi.fn(), dismissTo: vi.fn() }));
vi.mock("expo-router", () => ({
  router: { push: (to: unknown) => route.push(to), dismissTo: (to: unknown) => route.dismissTo(to) },
  useLocalSearchParams: () => route.params,
  useIsFocused: () => true,
}));
/* A phone in portrait, one pane; a test may open it to the foldable's two panes. */
const win = { width: 412, height: 915, hasFold: false };
vi.mock("../src/ui/posture", async () => {
  const d = await import("../src/ui/posture/derive");
  const usePosture = () => d.derivePosture({ width: win.width, height: win.height, folds: [], platform: "android", hasFold: win.hasFold });
  return { ...d, usePosture };
});

const pile = (kind: string, title: string, items: string[]) => ({
  kind, title, note: `${title} note`,
  items: items.map((id) => ({ id, messageId: id, title: `from ${id}`, subtitle: "", preview: "" })),
});
const world = {
  boot: { settled: true, syncFailure: null },
  pilesMeta: "3 waiting",
  piles: [pile("replyLater", Copy.replyLater, ["a"]), pile("setAside", Copy.setAside, ["b"]), pile("resurface", Copy.resurface, ["c"])],
  tags: [], folders: { enabled: false }, drafts: [], scheduled: [], trash: { available: false },
  actions: {},
};
vi.mock("../src/state/world", () => ({ useWorld: () => world }));

const { mount } = await import("./_rendered-dom");
const { MoreNav } = await import("../src/ui/MoreNav");
const { default: TriageScreen } = await import("../app/triage");

const titles = (el: HTMLElement) => [...el.querySelectorAll('[data-variant="pileTitle"]')].map((n) => n.textContent);
const heading = (el: HTMLElement) => el.querySelector('[data-variant="h1"]')?.textContent;

afterEach(() => {
  route.params = {}; route.push.mockReset(); route.dismissTo.mockReset();
  Object.assign(win, { width: 412, height: 915, hasFold: false });
});

describe("a pile route param", () => {
  it("names a pile or nothing", () => {
    expect(["replyLater", "setAside", "resurface"].map(pileParam)).toEqual(["replyLater", "setAside", "resurface"]);
    expect([undefined, "", "triage", ["setAside"], "SetAside"].map(pileParam)).toEqual([null, null, null, null, null]);
  });
});

describe("More's pile entries", () => {
  it.each([
    [Copy.replyLater, "replyLater"], [Copy.setAside, "setAside"], [Copy.resurface, "resurface"],
  ])("%s opens its own pile", (label, kind) => {
    const s = mount(createElement(MoreNav));
    const row = [...s.el.querySelectorAll('[data-rn="Pressable"]')].find((n) => n.textContent?.startsWith(label))!;
    (row as HTMLElement).click();
    expect(route.push).toHaveBeenCalledWith({ pathname: "/triage", params: { pile: kind } });
    s.unmount();
  });

  it("beside More's rows, picks its pile for the pane and is marked while it is open there", () => {
    const pick = vi.fn();
    const s = mount(createElement(MoreNav, { onPick: pick, selected: "triage:setAside" }));
    const rows = [...s.el.querySelectorAll<HTMLElement>('[data-rn="Pressable"]')];
    const at = (label: string) => rows.find((n) => n.textContent?.startsWith(label))!;
    at(Copy.resurface).click();
    expect(pick).toHaveBeenCalledWith("triage:resurface");
    expect(route.push).not.toHaveBeenCalled();
    expect(at(Copy.setAside).hasAttribute("data-selected")).toBe(true);
    expect(at(Copy.replyLater).hasAttribute("data-selected")).toBe(false);
    s.unmount();
  });
});

describe("the Piles screen", () => {
  it("given a pile shows that pile alone under its title, with no three-pile line", () => {
    route.params = { pile: "setAside" };
    const s = mount(createElement(TriageScreen));
    expect(titles(s.el)).toEqual([Copy.setAside]);
    expect(heading(s.el)).toBe(Copy.setAside);
    expect(s.el.textContent).not.toContain("3 waiting");
    expect(s.el.textContent).toContain("from b");
    expect(s.el.textContent).not.toContain("from a");
    s.unmount();
  });

  it("without a pile, or with an unknown one, shows all three", () => {
    for (const params of [{}, { pile: "nope" }] as Record<string, string>[]) {
      route.params = params;
      const s = mount(createElement(TriageScreen));
      expect(titles(s.el)).toEqual([Copy.replyLater, Copy.setAside, Copy.resurface]);
      expect(heading(s.el)).toBe(Copy.triage);
      expect(s.el.textContent).toContain("3 waiting");
      s.unmount();
    }
  });
});

describe("the Piles screen and More's pane", () => {
  it("in the pane shows the pile its row named, whatever the route's params, and stays", () => {
    Object.assign(win, { width: 897, height: 718, hasFold: true });
    route.params = { open: "triage:setAside" };
    const s = mount(createElement(TriageScreen, { inPane: true, pile: "resurface" }));
    expect(titles(s.el)).toEqual([Copy.resurface]);
    expect(route.dismissTo).not.toHaveBeenCalled();
    s.unmount();
  });

  it("full-screen on two panes moves into More's pane with its pile selected", () => {
    Object.assign(win, { width: 897, height: 718, hasFold: true });
    route.params = { pile: "setAside" };
    const s = mount(createElement(TriageScreen));
    expect(route.dismissTo).toHaveBeenCalledWith({ pathname: "/more", params: { open: "triage:setAside" } });
    s.unmount();
  });

  it("full-screen on one pane stays where it is", () => {
    route.params = { pile: "setAside" };
    const s = mount(createElement(TriageScreen));
    expect(titles(s.el)).toEqual([Copy.setAside]);
    expect(route.dismissTo).not.toHaveBeenCalled();
    s.unmount();
  });
});
