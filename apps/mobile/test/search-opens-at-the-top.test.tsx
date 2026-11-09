/** @vitest-environment jsdom */
/**
 * A SEARCH OPENS AT ITS TOP, rendered: Search over the real MailList, under React DOM. The
 * list's scroll view is a model of Android's: rows stack at fixed heights under the head, and with
 * `maintainVisibleContentPosition` it holds the first child whose bottom passes the offset (else the
 * last one) where it stood across a commit. The belt that scrolls back to 0 near the top is a smooth
 * scroll the next commit's hold cancels; the model leaves it out, as the device was seen to (4/4).
 * The empty Search held its footer, the device's first paint pushed it down, and the list opened
 * scrolled down with the count line and the newest matches above the view.
 *
 * And a result opened from Search stays over it: Search holds the pushed reader's move to the
 * pair's pane, so Back returns to the query instead of past it. In More's pane, which stays mounted
 * behind the other tabs, only until a tab is in front again.
 */
import { act, createElement as h, useImperativeHandle, useLayoutEffect, useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "./_rendered-dom";

const list = vi.hoisted(() => ({
  offset: 0,
  view: 600,
  total: 0,
  props: null as null | Record<string, any>,
  /** The last commit's stack: each child's key, top and height. */
  stack: [] as { key: string; top: number; h: number }[],
}));
const input = vi.hoisted(() => ({ change: null as null | ((text: string) => void) }));

vi.mock("react-native", async () => {
  const { rnDom } = await import("./_rendered-dom");
  const clamp = (y: number) => Math.max(0, Math.min(y, Math.max(0, list.total - list.view)));
  function SectionList(p: Record<string, any>) {
    list.props = p;
    const head = useRef<HTMLDivElement>(null);
    useImperativeHandle(p.ref, () => ({ getScrollResponder: () => ({ scrollTo: ({ y }: { y: number }) => { list.offset = clamp(y); } }) }));
    useLayoutEffect(() => {
      const lines = [...head.current!.querySelectorAll("[data-line]")].length;
      const keys = [{ key: "head", h: 20 * lines }];
      for (const s of p.sections as { key: string; data: unknown[] }[]) {
        keys.push({ key: `section:${s.key}`, h: 30 });
        for (const row of s.data) keys.push({ key: `row:${p.keyExtractor(row)}`, h: 72 });
      }
      keys.push({ key: "foot", h: 16 });
      let y = 0;
      const stack = keys.map((k) => { const at = { ...k, top: y }; y += k.h; return at; });
      const mvcp = p.maintainVisibleContentPosition;
      if (mvcp) {
        const before = list.stack;
        const anchor = before.find((c, i) => c.top + c.h > list.offset || i === before.length - 1);
        const now = anchor ? stack.find((c) => c.key === anchor.key) : undefined;
        if (anchor && now) list.offset += now.top - anchor.top;
      }
      list.stack = stack;
      list.total = y;
      list.offset = clamp(list.offset);
    });
    const sections = p.sections as { key: string; data: unknown[] }[];
    return h("div", null,
      h("div", { ref: head }, p.ListHeaderComponent),
      ...sections.map((s) => h("div", { key: s.key }, p.renderSectionHeader({ section: s }),
        ...s.data.map((row) => h("div", { key: p.keyExtractor(row) }, p.renderItem({ item: row }))))),
      sections.length === 0 ? p.ListEmptyComponent ?? null : null,
      p.ListFooterComponent);
  }
  return {
    ...rnDom,
    SectionList,
    Keyboard: { addListener: () => ({ remove: () => undefined }) },
    TextInput: (p: { onChangeText: (t: string) => void }) => { input.change = p.onChangeText; return null; },
  };
});
vi.mock("../src/theme", () => ({
  useTheme: () => ({ c: new Proxy({}, { get: () => "#000" }), type: { body: {} }, radius: new Proxy({}, { get: () => 10 }), textCap: 2 }),
}));
vi.mock("../src/ui/base", async () => {
  const React = await import("react");
  const line = (p: { children?: unknown }) => React.createElement("span", { "data-line": "" }, p.children as never);
  return {
    Screen: (p: { children?: unknown }) => React.createElement("div", null, p.children as never),
    Empty: (p: { title: string }) => React.createElement("span", { "data-empty": "" }, p.title),
    Tap: (p: { children?: unknown; onPress?: () => void; accessibilityLabel?: string }) =>
      React.createElement("div", { onClick: p.onPress, "data-label": p.accessibilityLabel }, p.children as never),
    Txt: line,
    Section: line,
    panelSurface: () => ({}),
    pullRefreshControl: () => undefined,
    useListInsets: () => ({ paddingLeft: 0, paddingRight: 0, paddingTop: 0, paddingBottom: 0 }),
  };
});
vi.mock("../src/ui/chrome", () => ({ DetailBar: () => null, PaneTop: () => null }));
vi.mock("../src/ui/Gated", () => ({ Gated: ({ children }: { children: unknown }) => children }));
vi.mock("../src/ui/ErrorBoundary", () => ({ SurfaceBoundary: ({ children }: { children: unknown }) => children }));
vi.mock("../src/ui/MailRow", async () => {
  const React = await import("react");
  return { MailRow: (p: { m: { id: string }; onPress: () => void }) => React.createElement("button", { "data-row": p.m.id, onClick: p.onPress }) };
});
vi.mock("../src/ui/Segmented", async () => {
  const React = await import("react");
  return {
    Segmented: (p: { segments: { value: string; label: string }[]; onChange: (v: string) => void }) =>
      React.createElement("div", null, ...p.segments.map((g) =>
        React.createElement("div", { key: g.value, "data-label": g.label, onClick: () => p.onChange(g.value) }))),
  };
});
vi.mock("../src/i18n/LocaleProvider", () => ({ useLocale: () => "en" }));
vi.mock("../src/net/network-door", () => ({ useNetworkNow: () => "online" }));
const nav = vi.hoisted(() => ({ pushed: [] as unknown[], path: "/more" }));
vi.mock("expo-router", () => ({
  router: { push: (to: unknown) => { nav.pushed.push(to); } },
  usePathname: () => nav.path,
}));
vi.mock("../src/state/live", () => ({ addressShaped: (q: string) => (q.includes("@") ? q.trim() : null), unansweredSaid: () => "" }));

/** The device's own matches: every query finds its first eleven here, newest first. */
const device = (q: string) => (q.trim().length < 2 ? [] : Array.from({ length: 11 }, (_, i) => ({ id: `${q.trim()}-d${i}` })));
vi.mock("../src/state/world", () => ({
  useWorld: () => ({
    search: {
      warm: () => undefined, query: (q: string) => ({ items: q.includes("@") ? [] : device(q), similar: [], indexing: false }),
      address: (_a: string, d: "any" | "from" | "to") => ({ items: around[d], counts: { any: 2, from: 1, to: 1 }, indexing: false }),
    },
    store: {
      open: () => undefined,
      rowOf: (m: { id: string }) => m,
      addressSearch: (a: string, d: string) => new Promise((resolve) => { archive.asked.push([a, d, resolve]); }),
    },
  }),
}));
/** The address view's device half per direction, and the archive's asks, each answered by the test. */
const around = vi.hoisted(() => ({ any: [{ id: "d0" }, { id: "d1" }], from: [{ id: "d0" }], to: [{ id: "d1" }] }));
const archive = vi.hoisted(() => ({ asked: [] as [string, string, (o: unknown) => void][] }));
/** The whole-mailbox pass: searching, then its page of `length` slots. */
const store = vi.hoisted(() => ({ ready: false, length: 0 }));
vi.mock("../src/state/store-views", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useStoreSearch: (q: string) => ({
    verdict: q.trim().length < 2 ? "idle" : store.ready ? "ready" : "searching",
    ready: store.ready, length: store.length, total: store.length, totalExact: true, about: null, tier: "exact",
    ms: 47, importing: false, indexedPercent: null, bounded: false,
    rowAt: (i: number) => ({ id: `s${i}` }), sourceAt: () => null, want: () => undefined, loadMore: () => undefined, retry: () => undefined,
  }),
}));

const { default: SearchScreen } = await import("../app/search");
const { Copy } = await import("../src/copy");
const { readerHeldNow } = await import("../src/ui/reader-held");

let screen: ReturnType<typeof mount> | null = null;
beforeEach(() => {
  list.offset = 0; list.total = 0; list.stack = []; list.props = null;
  store.ready = false; store.length = 0;
  archive.asked = [];
  screen = mount(h(SearchScreen));
});
afterEach(() => { screen?.unmount(); screen = null; nav.pushed = []; nav.path = "/more"; });

const type = (text: string): void => { screen!.render(h(SearchScreen)); input.change!(text); screen!.render(h(SearchScreen)); };
const answer = (length: number): void => { store.ready = true; store.length = length; screen!.render(h(SearchScreen)); };
const dragTo = (y: number): void => { list.props!.onScrollBeginDrag?.(); list.offset = y; };
const topOf = (key: string): number => list.stack.find((c) => c.key === key)!.top;

describe("a search opens at its top", () => {
  it("the device's paint and then the mailbox's page: the count line and the newest match stay in view", () => {
    type("fenwick");
    expect(list.offset, "the device's paint").toBe(0);
    answer(12);
    expect(list.offset, "the mailbox's page").toBe(0);
    expect(topOf("row:slot-0") - list.offset, "the newest match is on screen").toBeLessThan(list.view);
  });

  it("a new question opens at the top, wherever the last answer was scrolled to", () => {
    type("fenwick");
    answer(40);
    dragTo(900);
    store.ready = false;
    type("brimstone");
    expect(list.offset).toBe(0);
    answer(5);
    expect(list.offset).toBe(0);
  });

  it("control: within one answer the person's place stays while its pages arrive", () => {
    type("receipt");
    answer(40);
    dragTo(900);
    answer(80);
    expect(list.offset).toBe(900);
  });
});

describe("a press on a result lands with the keyboard up", () => {
  it("the list keeps the press instead of spending it on closing the keyboard", () => {
    type("fenwick");
    expect(list.props!.keyboardShouldPersistTaps).toBe("handled");
    expect(list.props!.automaticallyAdjustKeyboardInsets).toBe(true);
  });
});

describe("a result opened from Search stays over it", () => {
  it("Search holds the pushed reader's move to the pane while it is open", () => {
    expect(readerHeldNow(), "Search is open").toBe(true);
    screen!.unmount();
    screen = null;
    expect(readerHeldNow(), "Search closed").toBe(false);
  });

  it("in More's pane: held while its result is open, given back when another tab pops it", () => {
    screen!.unmount();
    const pane = () => h(SearchScreen, { inPane: true });
    screen = mount(pane());
    expect(readerHeldNow(), "the pane holds nothing by itself").toBe(false);
    input.change!("fenwick");
    screen.render(pane());
    act(() => (screen!.el.querySelector('[data-row="fenwick-d0"]') as HTMLElement).click());
    expect(nav.pushed).toEqual(["/message/fenwick-d0"]);
    nav.path = "/message/fenwick-d0";
    screen.render(pane());
    expect(readerHeldNow(), "the result is open").toBe(true);
    // The rail's Ohbox pops the result; More stays mounted behind it.
    nav.path = "/";
    screen.render(pane());
    expect(readerHeldNow()).toBe(false);
  });
});

describe("the address view asks the archive, one direction at a time", () => {
  const ADDR = "ann@example.test";
  const press = (label: string): void => {
    const el = screen!.el.querySelector(`[data-label="${label}"]`) as HTMLElement | null;
    expect(el, label).not.toBeNull();
    act(() => el!.click());
  };
  const keys = (): string[] =>
    (list.props!.sections as { data: unknown[] }[]).flatMap((s) => s.data.map((r) => list.props!.keyExtractor(r) as string));
  const answerArchive = async (i: number, outcome: unknown): Promise<void> => {
    await act(async () => { archive.asked[i]![2](outcome); });
  };
  const said = (): string => screen!.el.textContent ?? "";

  it("adds the archive's rows the device lacks under All, and says the archive's count", async () => {
    type(ADDR);
    answer(0);
    press(Copy.searchEmptyAddressScopes(ADDR));
    expect(archive.asked.map(([a, d]) => [a, d])).toEqual([[ADDR, "any"]]);
    expect(said()).toContain(Copy.searchWholeSearching);
    expect(keys()).toEqual(["d0", "d1"]);
    await answerArchive(0, { state: "ready", items: [{ id: "d1" }, { id: "a1" }, { id: "a2" }], total: 40, direction: "any" });
    expect(keys()).toEqual(["d0", "d1", "archive:a1", "archive:a2"]);
    expect(said()).toContain(Copy.searchAddressArchive(40, false, false, false));
  });

  it("an older server answers To them by sender: its rows stay out and the line says why; a toggle back asks nothing", async () => {
    type(ADDR);
    answer(0);
    press(Copy.searchEmptyAddressScopes(ADDR));
    await answerArchive(0, { state: "ready", items: [{ id: "a1" }], total: 1, direction: "any" });
    press(Copy.searchAddressTo);
    expect(archive.asked.map(([, d]) => d)).toEqual(["any", "to"]);
    await answerArchive(1, { state: "ready", items: [{ id: "a9" }], total: 7, direction: "from" });
    expect(keys()).toEqual(["d1"]);
    expect(said()).toContain(Copy.searchAddressArchiveNoRecipients);
    press(Copy.searchAddressAll);
    expect(archive.asked).toHaveLength(2);
    expect(keys()).toEqual(["d0", "d1", "archive:a1"]);
  });

  it("an archive that refused is said with its retry, and nothing is claimed empty meanwhile", async () => {
    around.any = [];
    try {
      type(ADDR);
      answer(0);
      press(Copy.searchEmptyAddressScopes(ADDR));
      expect(screen!.el.querySelector("[data-empty]"), "no empty claim while the archive is asked").toBeNull();
      await answerArchive(0, { state: "failed", error: "boom", errorClass: "network" });
      press(Copy.searchWholeRetry);
      expect(archive.asked.map(([, d]) => d)).toEqual(["any", "any"]);
    } finally {
      around.any = [{ id: "d0" }, { id: "d1" }];
    }
  });
});
