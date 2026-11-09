/** @vitest-environment jsdom */
/**
 * MORE ON TWO PANES IS A LIST BESIDE ITS DESTINATION, not a window-wide list with every destination
 * pushed over it. A row opens its destination in the pane (the More route's `open` param), marked
 * selected, the destination drawn bar-less; an unsaved edit there is asked about before another row
 * replaces it; a result Search opened from the pane holds the moves only while it is open; one pane
 * still pushes. Rendered with the real More screen, MoreNav and list-detail pair; the destinations
 * stand in, saying what they were given.
 */
import { act, createElement, Fragment, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const nav = vi.hoisted(() => ({
  routes: {} as Record<string, Record<string, string>>,
  front: "more",
  hearers: new Set<() => void>(),
  push: [] as unknown[],
  dismissed: [] as unknown[],
  path: "/more",
}));
const tell = () => { for (const h of [...nav.hearers]) h(); };
vi.mock("expo-router", async () => {
  const { createContext: cc, useContext: uc, useSyncExternalStore: uses } = await import("react");
  const RouteKey = cc("more");
  const useNav = () => uses((h) => { nav.hearers.add(h); return () => { nav.hearers.delete(h); }; }, () => nav.routes);
  const write = (key: string, p: Record<string, string>) => { nav.routes = { ...nav.routes, [key]: { ...nav.routes[key], ...p } }; tell(); };
  return {
    RouteKey,
    router: {
      push: (to: unknown) => { nav.push.push(to); },
      navigate: (to: unknown) => { nav.push.push(to); },
      setParams: (p: Record<string, string>) => write(nav.front, p),
      dismissTo: (to: unknown) => { nav.dismissed.push(to); },
    },
    useLocalSearchParams: () => useNav()[uc(RouteKey)] ?? {},
    useNavigation: () => {
      const key = uc(RouteKey);
      return { setParams: (p: Record<string, string>) => write(key, p), isFocused: () => key === nav.front };
    },
    useIsFocused: () => { useNav(); return uc(RouteKey) === nav.front; },
    usePathname: () => { useNav(); return nav.path; },
  };
});
vi.mock("react-native", async () => ({
  ...(await import("./_rendered-dom")).rnDom,
  BackHandler: { addEventListener: () => ({ remove: () => undefined }) },
}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 24, bottom: 16, left: 0, right: 0 }) }));
vi.mock("../src/ui/base", () => {
  const box = (p: { children?: ReactNode }) => createElement("div", null, p.children);
  return {
    Screen: box, Scroller: box, Panel: box, Rule: () => null, Tap: () => null, TagDot: () => null,
    Section: (p: { children?: ReactNode }) => createElement("h2", null, p.children),
    TapRow: (p: { children?: ReactNode; onPress?: () => void; selected?: boolean; accessibilityLabel?: string }) =>
      createElement("button", { onClick: p.onPress, "data-selected": p.selected ? "" : undefined, "data-label": p.accessibilityLabel }, p.children),
    Empty: (p: { title: string }) => createElement("span", { "data-empty": "" }, p.title),
    Txt: (p: { children?: ReactNode }) => createElement("span", null, p.children),
  };
});
vi.mock("../src/theme", () => ({
  useTheme: () => ({ c: new Proxy({}, { get: (_, k) => (k === "tag" ? new Proxy({}, { get: () => ({ ink: "#000" }) }) : "#000") }), radius: { pill: 99 }, zLayer: { tabBar: 5 } }),
}));
vi.mock("../src/ui/chrome", () => ({ TopBar: () => null, DetailBar: () => null, PaneTop: () => null }));
vi.mock("../src/ui/Gated", () => ({ Gated: (p: { children?: ReactNode }) => p.children }));
vi.mock("../src/ui/MessageReader", () => ({ MessageReader: (p: { id: string }) => createElement("i", { "data-message-reader": p.id }) }));
vi.mock("../src/ui/ErrorBoundary", () => ({ SurfaceBoundary: (p: { children?: ReactNode }) => p.children }));
vi.mock("../src/i18n/LocaleProvider", () => ({ useLocale: () => "en" }));
vi.mock("../src/ui/glass", () => ({ GlassRail: () => null, GlassSidebar: () => null }));
vi.mock("../src/ui/Icon", () => ({ Icon: () => null }));
vi.mock("../src/ui/FadeOut", () => ({ FadeOut: () => null }));
vi.mock("../src/ui/FoldersGroup", () => ({ FoldersGroup: () => null }));
vi.mock("../src/ui/reader-rail", () => ({ useReaderRail: () => null }));
vi.mock("../src/engine/ui-marks", () => ({ beginMark: () => undefined }));
vi.mock("../src/state/live", () => ({ phoneBannerLines: () => ({ head: "", why: "" }) }));
const world = {
  message: (id: string) => ({ id, place: "ohbox", earlier: [] }),
  account: { name: "Ann", email: "" }, ohbox: { unread: 0 }, screener: { waiting: [] }, reads: { newCount: 0 }, receipts: { newCount: 0 },
  boot: { settled: true }, mailboxes: { organizer: null },
  piles: [{ kind: "setAside", items: [] }], tags: [{ id: "t1", name: "Work", hue: 0 }], tagged: { count: () => 0 },
  folders: { enabled: false }, drafts: [], scheduled: [], trash: { available: true }, actions: {},
};
vi.mock("../src/state/world", () => ({ useWorld: () => world, useBodyStamp: () => 0 }));
/* The tester's posture: the foldable open in landscape, two panes; a test may make it a phone. */
const win = { width: 897, height: 718, hasFold: true };
vi.mock("../src/ui/posture", async () => {
  const d = await import("../src/ui/posture/derive");
  const usePosture = () => d.derivePosture({ width: win.width, height: win.height, folds: [], platform: "android", hasFold: win.hasFold });
  return { ...d, usePosture, useAppWindow: () => win, useStatusCluster: () => null };
});
/* The destinations: each says what it was given; Settings may hold an unsaved edit, Search opens a result. */
const edit = vi.hoisted(() => ({ dirty: false, asked: null as null | (() => void) }));
const dest = vi.hoisted(() => (name: string) => async () => {
  const { createElement: ce, useState } = await import("react");
  const { router } = await import("expo-router");
  const { ReleaseOnReturn, useUnsavedHold } = await import("../src/ui/more-pane");
  const { holdReader } = await import("../src/ui/reader-held");
  return {
    default: (p: { inPane?: boolean; id?: string; pile?: string }) => {
      useUnsavedHold(name === "settings" && edit.dirty, (go) => { edit.asked = go; });
      const [token] = useState(() => Symbol("result"));
      const result = name === "search"
        ? [ce(ReleaseOnReturn, { key: "r", token }), ce("b", { key: "b", "data-result": "", onClick: () => { holdReader(token, true); router.push("/message/m1"); } })]
        : null;
      return ce("i", { "data-dest": name, "data-in-pane": String(p.inPane), "data-arg": p.id ?? p.pile ?? "" }, result);
    },
  };
});
vi.mock("../app/settings", dest("settings"));
vi.mock("../app/history", dest("history"));
vi.mock("../app/search", dest("search"));
vi.mock("../app/triage", dest("triage"));
vi.mock("../app/drafts/index", dest("drafts"));
vi.mock("../app/trash/index", dest("trash"));
vi.mock("../app/away", dest("away"));
vi.mock("../app/servers", dest("servers"));
vi.mock("../app/scheduled", dest("scheduled"));
vi.mock("../app/tag/[id]", dest("tag"));
vi.mock("../app/folder/[id]", dest("folder"));

const { mount } = await import("./_rendered-dom");
const { Copy } = await import("../src/copy");
const { default: MoreScreen } = await import("../app/(tabs)/more");
const { useListDetail } = await import("../src/ui/list-detail");
const { readerHeldNow } = await import("../src/ui/reader-held");
const { default: MessageScreen } = await import("../app/message/[id]");
const { YieldToMore } = await import("../src/ui/more-move");
const { RouteKey } = (await import("expo-router")) as unknown as { RouteKey: import("react").Context<string> };
const Route = (k: string, child: ReactNode) => createElement(RouteKey.Provider, { value: k }, child);
const { morePaneKeyOf, morePathOf, morePaneRouteFor } = await import("../src/ui/pane-routes");

const row = (el: HTMLElement, label: string) =>
  [...el.querySelectorAll<HTMLElement>("button")].find((b) => b.textContent?.startsWith(label))!;
const shown = (el: HTMLElement) => el.querySelector("[data-dest]");

afterEach(() => {
  nav.routes = {}; nav.front = "more"; nav.push = []; nav.dismissed = []; nav.path = "/more";
  edit.dirty = false; edit.asked = null;
  Object.assign(win, { width: 897, height: 718, hasFold: true });
});

describe("a More destination as a pane key, both ways", () => {
  it("names each row's route and gives it back", () => {
    const cases: [string | { pathname: string; params: Record<string, string> }, string, string][] = [
      ["/settings", "settings", "/settings"], ["/history", "history", "/history"], ["/search", "search", "/search"],
      ["/drafts", "drafts", "/drafts"], ["/trash", "trash", "/trash"], ["/away", "away", "/away"],
      ["/servers", "servers", "/servers"], ["/scheduled", "scheduled", "/scheduled"],
      [{ pathname: "/triage", params: { pile: "setAside" } }, "triage:setAside", "/triage?pile=setAside"],
      ["/tag/a%2Fb", "tag:a/b", "/tag/a%2Fb"], ["/folder/Receipts", "folder:Receipts", "/folder/Receipts"],
    ];
    for (const [to, key, path] of cases) {
      expect(morePaneKeyOf(to)).toBe(key);
      expect(morePathOf(key)).toBe(path);
    }
    expect(morePaneRouteFor("settings")).toEqual({ pathname: "/more", params: { open: "settings" } });
  });
  it("no pane for a route that is not a More destination", () => {
    expect(["/", "/message/m1", "/compose", "/tag/", "/tag/a/b"].map(morePaneKeyOf)).toEqual([null, null, null, null, null]);
    expect(["nope", "tag:", "message:m1"].map(morePathOf)).toEqual([null, null, null]);
  });
});

describe("two panes: More is a list beside the destination it opened", () => {
  it("a row opens its destination in the pane, selected, and pushes nothing", () => {
    const s = mount(createElement(MoreScreen));
    expect(s.el.textContent).toContain(Copy.paneNothingOpen);
    act(() => { row(s.el, Copy.settings).click(); });
    expect(nav.push).toEqual([]);
    expect(nav.routes.more!.open).toBe("settings");
    expect(shown(s.el)?.getAttribute("data-dest")).toBe("settings");
    expect(shown(s.el)?.getAttribute("data-in-pane")).toBe("true");
    expect(row(s.el, Copy.settings).hasAttribute("data-selected")).toBe(true);
    expect(row(s.el, Copy.history).hasAttribute("data-selected")).toBe(false);
    s.unmount();
  });

  it("a pile and a tag carry what their row named", () => {
    const s = mount(createElement(MoreScreen));
    act(() => { row(s.el, Copy.setAside).click(); });
    expect(nav.routes.more!.open).toBe("triage:setAside");
    expect(shown(s.el)?.getAttribute("data-arg")).toBe("setAside");
    act(() => { row(s.el, "Work").click(); });
    expect(nav.routes.more!.open).toBe("tag:t1");
    expect(shown(s.el)?.getAttribute("data-dest")).toBe("tag");
    expect(shown(s.el)?.getAttribute("data-arg")).toBe("t1");
    expect(row(s.el, "Work").hasAttribute("data-selected")).toBe(true);
    s.unmount();
  });

  it("an unsaved edit in the pane is asked about before another row replaces it, and holds a fold", () => {
    nav.routes = { more: { open: "settings" } };
    edit.dirty = true;
    const s = mount(createElement(MoreScreen));
    expect(readerHeldNow()).toBe(true);
    act(() => { row(s.el, Copy.history).click(); });
    expect(nav.routes.more!.open).toBe("settings");
    expect(edit.asked).not.toBeNull();
    act(() => { edit.asked!(); });
    expect(nav.routes.more!.open).toBe("history");
    expect(shown(s.el)?.getAttribute("data-dest")).toBe("history");
    expect(readerHeldNow()).toBe(false);
    s.unmount();
  });

  it("a list destination in the pane holds no selection of More's, and its row opens its own pair", () => {
    nav.routes = { more: { open: "drafts" } };
    const seen: { open: string | null; openRow: (id: string) => void }[] = [];
    function Nested() {
      seen.push(useListDetail((id) => `/drafts/${id}`, (id) => `/drafts?open=${encodeURIComponent(id)}`));
      return null;
    }
    const s = mount(createElement(Nested));
    expect(seen.at(-1)!.open).toBeNull();
    act(() => { seen.at(-1)!.openRow("d 1"); });
    expect(nav.push).toEqual(["/drafts?open=d%201"]);
    expect(nav.routes.more!.open).toBe("drafts");
    s.unmount();
  });
});

describe("two panes: a result Search opened in More's pane", () => {
  it("stays over it while open, and once the rail leaves it every move runs again", () => {
    nav.routes = { more: { open: "search" }, "message/m1": { id: "m1" } };
    const s = mount(Route("more", createElement(MoreScreen)));
    act(() => { s.el.querySelector<HTMLElement>("[data-result]")!.click(); });
    expect(nav.push).toEqual(["/message/m1"]);
    Object.assign(nav, { front: "message/m1", path: "/message/m1" });
    act(() => { s.render(createElement(Fragment, null, Route("more", createElement(MoreScreen)), Route("message/m1", createElement(MessageScreen)))); });
    expect(s.el.querySelector("[data-message-reader]")?.getAttribute("data-message-reader")).toBe("m1");
    expect(nav.dismissed).toEqual([]);
    expect(readerHeldNow()).toBe(true);
    // The rail's Ohbox pops the result; More's pane stays mounted behind the other tab.
    act(() => { Object.assign(nav, { front: "index", path: "/" }); s.render(createElement(Fragment, null, Route("more", createElement(MoreScreen)))); });
    expect(readerHeldNow()).toBe(false);
    expect(shown(s.el)?.getAttribute("data-dest")).toBe("search");
    // A pushed Settings moves into More's pane, and a pushed message into the Ohbox pane.
    nav.front = "settings";
    const t = mount(Route("settings", createElement(YieldToMore, { paneKey: "settings", children: createElement("i", { "data-full": "" }) })));
    expect(t.el.querySelector("[data-full]")).toBeNull();
    nav.routes = { ...nav.routes, "message/m2": { id: "m2" } };
    nav.front = "message/m2";
    const u = mount(Route("message/m2", createElement(MessageScreen)));
    expect(nav.dismissed).toEqual([{ pathname: "/more", params: { open: "settings" } }, { pathname: "/", params: { open: "m2" } }]);
    u.unmount(); t.unmount(); s.unmount();
  });
});

describe("one pane: More's rows push, as on the phone", () => {
  it("Settings pushes its route and no pane is drawn", () => {
    Object.assign(win, { width: 412, height: 915, hasFold: false });
    const s = mount(createElement(MoreScreen));
    act(() => { row(s.el, Copy.settings).click(); });
    expect(nav.push).toEqual(["/settings"]);
    expect(nav.routes.more?.open).toBeUndefined();
    expect(shown(s.el)).toBeNull();
    s.unmount();
  });
});
