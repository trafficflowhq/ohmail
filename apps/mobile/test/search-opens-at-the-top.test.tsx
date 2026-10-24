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
 * pair's pane, so Back returns to the query instead of past it.
 */
import { createElement as h, useImperativeHandle, useLayoutEffect, useRef } from "react";
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
    Empty: () => null,
    Tap: (p: { children?: unknown }) => React.createElement("div", null, p.children as never),
    Txt: line,
    Section: line,
    panelSurface: () => ({}),
    pullRefreshControl: () => undefined,
    useListInsets: () => ({ paddingLeft: 0, paddingRight: 0, paddingTop: 0, paddingBottom: 0 }),
  };
});
vi.mock("../src/ui/chrome", () => ({ DetailBar: () => null }));
vi.mock("../src/ui/Gated", () => ({ Gated: ({ children }: { children: unknown }) => children }));
vi.mock("../src/ui/ErrorBoundary", () => ({ SurfaceBoundary: ({ children }: { children: unknown }) => children }));
vi.mock("../src/ui/MailRow", () => ({ MailRow: () => null }));
vi.mock("../src/ui/Segmented", () => ({ Segmented: () => null }));
vi.mock("../src/i18n/LocaleProvider", () => ({ useLocale: () => "en" }));
vi.mock("../src/net/network-door", () => ({ useNetworkNow: () => "online" }));
vi.mock("expo-router", () => ({ router: { push: () => undefined } }));
vi.mock("../src/state/live", () => ({ addressShaped: () => null, unansweredSaid: () => "" }));

/** The device's own matches: every query finds its first eleven here, newest first. */
const device = (q: string) => (q.trim().length < 2 ? [] : Array.from({ length: 11 }, (_, i) => ({ id: `${q.trim()}-d${i}` })));
vi.mock("../src/state/world", () => ({
  useWorld: () => ({
    search: { warm: () => undefined, query: (q: string) => ({ items: device(q), similar: [], indexing: false }), address: () => null },
    store: { open: () => undefined },
  }),
}));
/** The whole-mailbox pass: searching, then its page of `length` slots. */
const store = vi.hoisted(() => ({ ready: false, length: 0 }));
vi.mock("../src/state/store-views", () => ({
  useStoreSearch: (q: string) => ({
    verdict: q.trim().length < 2 ? "idle" : store.ready ? "ready" : "searching",
    ready: store.ready, length: store.length, total: store.length, totalExact: true, about: null, tier: "exact",
    ms: 47, importing: false, indexedPercent: null, bounded: false,
    rowAt: (i: number) => ({ id: `s${i}` }), sourceAt: () => null, want: () => undefined, loadMore: () => undefined, retry: () => undefined,
  }),
}));

const { default: SearchScreen } = await import("../app/search");
const { readerHeldNow } = await import("../src/ui/reader-held");

let screen: ReturnType<typeof mount> | null = null;
beforeEach(() => {
  list.offset = 0; list.total = 0; list.stack = []; list.props = null;
  store.ready = false; store.length = 0;
  screen = mount(h(SearchScreen));
});
afterEach(() => { screen?.unmount(); screen = null; });

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

describe("a result opened from Search stays over it", () => {
  it("Search holds the pushed reader's move to the pane while it is open", () => {
    expect(readerHeldNow(), "Search is open").toBe(true);
    screen!.unmount();
    screen = null;
    expect(readerHeldNow(), "Search closed").toBe(false);
  });
});
