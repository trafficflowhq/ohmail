/** @vitest-environment jsdom */
/**
 * NEWS AND RECEIPTS MARK ONLY WHAT YOU SCROLLED THROUGH, rendered: both streams over the real
 * MailList. The list stand-in mounts the window of rows the test names (the first sixteen always,
 * and three screens around the view), each inside MailList's own cell, lays every mounted cell out
 * where its row stands now, and hands the test the list's scroll reports. A report with no finger
 * on the screen is the list's own: holding the place while letters arrive above, the place coming
 * back on a tab return, the glide of a fling.
 */
import { createElement as h, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const win = vi.hoisted(() => ({ ids: null as null | string[], scroller: null as any }));
vi.mock("react-native", async () => {
  const React = await import("react");
  const keep = (props: any) => (el: any) => { if (el) el.__props = props; };
  const host = (name: string) => (props: any) => React.createElement("div", { "data-rn": name, ref: keep(props) }, props.children);
  const SectionList = (p: any) => {
    win.scroller = p;
    const rows = p.sections.flatMap((s: any) => s.data).filter((r: any) => win.ids === null || win.ids.includes(p.keyExtractor(r)));
    const Cell = p.CellRendererComponent;
    return React.createElement("div", null, ...rows.map((r: any) =>
      React.createElement(Cell, { key: p.keyExtractor(r), item: r, onLayout: () => undefined, style: null },
        React.createElement("i", { "data-row": p.keyExtractor(r) }, p.renderItem({ item: r })))));
  };
  return {
    View: host("View"), Text: host("Text"), ScrollView: host("ScrollView"), Pressable: host("Pressable"), SectionList,
    AppState: { addEventListener: () => ({ remove: () => undefined }), currentState: "active" },
    Platform: { OS: "android", select: (o: any) => o.android ?? o.default },
    StyleSheet: { absoluteFill: {}, create: (s: any) => s, hairlineWidth: 1 },
  };
});
vi.mock("../src/ui/base", async () => {
  const React = await import("react");
  const box = (p: any) => React.createElement("div", null, p.children);
  return { Badge: () => null, Empty: () => null, Tail: () => null, Waterline: () => null, Panel: box, Screen: box, TapRow: box,
    Txt: () => null, Section: () => null, panelSurface: () => ({}), pullRefreshControl: () => undefined,
    useListInsets: () => ({ paddingLeft: 0, paddingRight: 0, paddingBottom: 0 }) };
});
vi.mock("../src/theme", () => ({ useTheme: () => ({ c: new Proxy({}, { get: () => "#000" }), radius: new Proxy({}, { get: () => 8 }) }) }));
const focus = vi.hoisted(() => ({ cb: null as null | (() => (() => void) | void), cleanup: undefined as undefined | (() => void) | void }));
vi.mock("expo-router", async () => {
  const React = await import("react");
  return {
    useFocusEffect: (cb: () => (() => void) | void) => {
      focus.cb = cb;
      React.useEffect(() => {
        focus.cleanup = cb();
        return () => { if (typeof focus.cleanup === "function") focus.cleanup(); };
      }, [cb]);
    },
  };
});
const st = vi.hoisted(() => {
  const s = { items: [] as any[], marked: [] as string[], actions: null as any };
  // One object for the app's life, as the world's actions are: a new one per render re-runs the focus effect.
  s.actions = {
    markSeenThrough: (_p: string, ids: string[]) => { for (const id of ids) if (!s.marked.includes(id)) s.marked.push(id); },
    leaveFeed: () => undefined, markAllSeen: () => undefined, hydrateMessage: () => undefined, holdFiles: () => undefined, releaseFiles: () => undefined,
  };
  return s;
});
vi.mock("../src/state/world", () => ({
  useWorld: () => ({
    reads: { items: st.items, waterlineAboveId: null, waterLabel: "", meta: "", unreadIds: [], newCount: 0 },
    receipts: { groups: [{ label: "Today", items: st.items }], waterlineAboveId: null, waterLabel: "", total: st.items.length, meta: "" },
    boot: { settled: true, syncFailure: false },
    actions: st.actions,
    worldKey: "w", mailboxes: { rows: [] }, eventsOf: () => [], filesOf: () => [],
  }),
  useMessageBody: () => null,
  useFilesStamp: () => undefined,
}));
vi.mock("../src/state/pull", () => ({ usePullToSync: () => undefined }));
vi.mock("../src/ui/BodyPages", () => ({ BodyPages: () => null }));
vi.mock("../src/ui/body-note", () => ({ mailboxStatusOf: () => null, withheldNote: () => null }));
vi.mock("../src/ui/chrome", () => ({ TopBar: () => null }));
vi.mock("../src/ui/list-detail", () => ({
  ListDetail: (p: { list: ReactNode }) => p.list,
  useListDetail: () => ({ open: null, openRow: () => undefined, close: () => undefined, twoPane: false }),
}));
vi.mock("../src/ui/MailRow", () => ({ MailRow: () => null }));
vi.mock("../src/ui/MessageReader", () => ({ MessageReader: () => null, AttachmentTiles: () => null }));
vi.mock("../src/ui/EventCard", () => ({ EventCards: () => null }));
vi.mock("../src/ui/FadeOut", () => ({ FadeOut: () => null }));
vi.mock("../src/ui/MarkAllRead", () => ({ MarkAllRead: () => null, VIEW_HEAD_ROW: {} }));
vi.mock("../src/ui/Skeleton", () => ({ SkeletonList: () => null }));
vi.mock("../src/i18n/LocaleProvider", () => ({ useLocale: () => "en" }));
vi.mock("../src/ui/ErrorBoundary", () => ({ SurfaceBoundary: (p: { children: ReactNode }) => p.children }));

const { mount } = await import("./_rendered-dom");
const { act } = await import("react");
const { default: ReadsScreen } = await import("../app/(tabs)/reads");
const { default: ReceiptsScreen } = await import("../app/(tabs)/receipts");

const ROW = 300, HEAD = 100, VIEW = 900, REACH = 3 * VIEW;
const letter = (id: string) => ({ id, from: { name: "L", address: "x@fake.test" }, subject: id, time: "08:00", unread: true, body: "", bodyState: "full" });
/** Newest first: `NW39` heads a stream of forty. */
const letters = (p: string, n: number) => Array.from({ length: n }, (_, i) => letter(`${p}${n - 1 - i}`));
const ids = (rows: { id: string }[]) => rows.map((m) => m.id);
const topOf = (id: string) => HEAD + st.items.findIndex((m) => m.id === id) * ROW;
/** Where the stream's last rows fill the screen. */
const endOf = (n: number) => HEAD + n * ROW - VIEW;

let screen: ReturnType<typeof mount> | null = null;
let Shown: () => ReturnType<typeof h> = () => h(ReadsScreen);
/** Every row on screen at a look the person drove: the finger moving, lifting, a fling landing. */
const onScreen = new Set<string>();

/** The window moves to `y`; every mounted cell lays out where its row stands now. */
const place = (y: number) => {
  win.ids = st.items.filter((m, i) => i < 16 || (topOf(m.id) + ROW > y - REACH && topOf(m.id) < y + VIEW + REACH)).map((m) => m.id);
  screen!.render(Shown());
  const cells = [...screen!.el.querySelectorAll("[data-row]")].map((el) => el.parentElement as any);
  act(() => {
    for (const c of cells) c.__props.onLayout({ nativeEvent: { layout: { x: 0, y: topOf(c.firstChild.getAttribute("data-row")), width: 400, height: ROW } } });
  });
};
const report = (name: string, y: number) =>
  act(() => { win.scroller[name]?.({ nativeEvent: { contentOffset: { x: 0, y }, layoutMeasurement: { width: 400, height: VIEW } } }); });
const look = (y: number) => { for (const m of st.items) if (topOf(m.id) < y + VIEW && topOf(m.id) + ROW > y) onScreen.add(m.id); };
/** The list scrolls itself to `y`: no finger on the screen. */
const listMoves = (y: number) => { place(y); report("onScroll", y); };
/** The person drags from `from` to `to`, a report every `step`. */
const drag = (from: number, to: number, step = 100) => {
  report("onScrollBeginDrag", from);
  const dir = Math.sign(to - from) || 1;
  for (let y = from; dir * (to - y) >= 0; y += dir * step) { place(y); look(y); report("onScroll", y); }
  place(to); look(to); report("onScroll", to);
  report("onScrollEndDrag", to);
};
/** A hard fling: a short flick, then the glide's far-apart reports, then the landing. */
const fling = (to: number) => {
  drag(0, 120, 60);
  report("onMomentumScrollBegin", 120);
  for (let y = 120; y < to; y += 700) listMoves(y);
  place(to); look(to); report("onScroll", to);
  report("onMomentumScrollEnd", to);
};
const open = (rows: any[], shown: () => ReturnType<typeof h> = () => h(ReadsScreen)) => {
  Shown = shown;
  st.items = rows;
  st.marked = [];
  onScreen.clear();
  win.ids = null;
  screen = mount(Shown());
  place(0);
};
const arrive = (rows: any[]) => { st.items = [...rows, ...st.items]; };

afterEach(() => { screen?.unmount(); screen = null; win.ids = null; });

describe("phone News marks only the letters a person scrolled through", () => {
  it("letters arriving above a deep place stay unread while the list holds the place", () => {
    open(letters("NW", 40));
    drag(0, endOf(40), 150);
    arrive(letters("NX", 20));
    const held = endOf(40) + 20 * ROW;
    listMoves(held); // the list keeps the place: its own scroll report
    expect(st.marked.filter((id) => id.startsWith("NX"))).toEqual([]);
    drag(held, held - 200); // a short move at the deep place: the arrivals are still far above
    expect(st.marked.filter((id) => id.startsWith("NX"))).toEqual([]);
  });

  it("News shown again after the Ohbox marks none of the letters that arrived meanwhile", () => {
    open(letters("NW", 40));
    drag(0, endOf(40), 150);
    act(() => { if (typeof focus.cleanup === "function") focus.cleanup(); focus.cleanup = undefined; }); // the Ohbox is shown
    st.marked = [];
    arrive(letters("NZ", 3));
    act(() => { focus.cleanup = focus.cb?.(); }); // News tapped: the deep place comes back
    listMoves(endOf(40) + 3 * ROW);
    expect(st.marked).toEqual([]);
  });

  it("a fling marks what was on screen under the finger and where it lands, never what it flew past", () => {
    open(letters("NW", 40));
    fling(endOf(40));
    // NW39 and NW38 were on screen under the finger and the fling carried them past the line;
    // NW2 is the one on the landing screen above the line. The thirty-five between were never seen.
    expect(st.marked.sort()).toEqual(["NW2", "NW38", "NW39"]);
  });

  it("a letter measured before arrivals pushed it down is not marked from where it stood", () => {
    open(letters("NW", 40));
    fling(endOf(40));
    arrive(letters("NX", 20));
    listMoves(endOf(40) + 20 * ROW);
    listMoves(0); // back at the top in one move (a status-bar tap): nothing drawn between
    drag(0, 3600, 150);
    expect(st.marked.filter((id) => !onScreen.has(id))).toEqual([]);
    expect(st.marked).toContain("NX19"); // the arrivals the person did scroll through turn seen
  });

  it("control: a person's own slow scroll marks each letter as its foot passes the line", () => {
    open(letters("NW", 40));
    drag(0, 3000);
    // The line stands at 3000 + 0.62 × 900: feet at 400, 700 … 3400 have cleared it.
    expect(st.marked).toEqual(ids(letters("NW", 40)).slice(0, 11));
  });
});

describe("phone Receipts marks only the receipts a person scrolled through", () => {
  it("receipts arriving above a deep place stay unread while the list holds the place", () => {
    open(letters("RW", 40), () => h(ReceiptsScreen));
    drag(0, endOf(40), 150);
    expect(st.marked).toContain("RW20");
    arrive(letters("RX", 20));
    const held = endOf(40) + 20 * ROW;
    listMoves(held);
    drag(held, held - 200);
    expect(st.marked.filter((id) => id.startsWith("RX"))).toEqual([]);
  });
});
