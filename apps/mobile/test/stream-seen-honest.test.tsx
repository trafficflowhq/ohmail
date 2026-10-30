/** @vitest-environment jsdom */
/**
 * NEWS AND RECEIPTS READ ONLY WHAT RESTS ON SCREEN, rendered: both streams over the real
 * MailList. The list stand-in mounts the window of rows the test names (the first sixteen always,
 * and three screens around the view), each inside MailList's own cell, lays every mounted cell out
 * where its row stands now, and hands the test the list's scroll reports. A report with no finger
 * on the screen is the list's own: holding the place while letters arrive above, the place coming
 * back on a tab return, the glide of a fling.
 */
import { createElement as h, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** `at`: where the list stands, by its last report or the last scroll it was told. */
const win = vi.hoisted(() => ({ ids: null as null | string[], scroller: null as any, held: "", scrolls: [] as number[], at: 0, view: null as any }));
vi.mock("react-native", async () => {
  const React = await import("react");
  const keep = (props: any) => (el: any) => { if (el) el.__props = props; };
  const host = (name: string) => (props: any) => React.createElement("div", { "data-rn": name, ref: keep(props) }, props.children);
  /** React Native 0.86's ScrollView: it takes a touch for itself, stopping the glide, while a momentum it was told began has not ended (`_isAnimating`). */
  class ScrollView extends React.Component<any> {
    began = 0;
    ended = 0;
    componentDidMount() { win.view = this; }
    getScrollResponder = () => this;
    _handleMomentumScrollBegin = (e: any) => { this.began = Date.now(); this.props.onMomentumScrollBegin?.(e); };
    _handleMomentumScrollEnd = (e: any) => { this.ended = Date.now(); this.props.onMomentumScrollEnd?.(e); };
    takesTouch = () => Date.now() - this.ended < 16 || this.ended < this.began;
    render() { return React.createElement("div", { "data-rn": "ScrollView", ref: keep(this.props) }, this.props.children); }
  }
  /** The key VirtualizedSectionList gives a cell: the section's header, then its rows. */
  const cellKey = (p: any, at: number) => {
    const s = p.sections[0];
    return at === 0 ? `${s.key}:header` : `${s.key}:${p.keyExtractor(s.data[at - 1])}`;
  };
  const SectionList = (p: any) => {
    win.scroller = p;
    // The device's list: it scrolls where it is told, and it does not hold the place by itself.
    React.useImperativeHandle(p.ref, () => ({ getScrollResponder: () => ({ scrollTo: ({ y }: { y: number }) => { win.scrolls.push(y); win.at = y; } }) }));
    const mvcp = p.maintainVisibleContentPosition;
    win.held = mvcp ? cellKey(p, mvcp.minIndexForVisible) : "";
    const rows = p.sections.flatMap((s: any) => s.data).filter((r: any) => win.ids === null || win.ids.includes(p.keyExtractor(r)));
    const Cell = p.CellRendererComponent;
    // VirtualizedList hands the scroll view the hold one further on, past its own head cell.
    const scroll = p.renderScrollComponent({
      maintainVisibleContentPosition: mvcp && { ...mvcp, minIndexForVisible: mvcp.minIndexForVisible + 1 },
      onScroll: p.onScroll, onScrollBeginDrag: p.onScrollBeginDrag, onScrollEndDrag: p.onScrollEndDrag,
      onMomentumScrollBegin: p.onMomentumScrollBegin, onMomentumScrollEnd: p.onMomentumScrollEnd,
    });
    return React.cloneElement(scroll, {}, ...rows.map((r: any) =>
      React.createElement(Cell, { key: p.keyExtractor(r), item: r, onLayout: () => undefined, style: null },
        React.createElement("i", { "data-row": p.keyExtractor(r) }, p.renderItem({ item: r })))));
  };
  return {
    View: host("View"), Text: host("Text"), ScrollView, Pressable: host("Pressable"), SectionList,
    AppState: { addEventListener: () => ({ remove: () => undefined }), currentState: "active" },
    Platform: { OS: "android", select: (o: any) => o.android ?? o.default },
    StyleSheet: { absoluteFill: {}, create: (s: any) => s, hairlineWidth: 1 },
  };
});
vi.mock("../src/ui/base", async () => {
  const React = await import("react");
  const box = (p: any) => React.createElement("div", null, p.children);
  const tap = (p: any) => React.createElement("div", { "data-tap": "", ref: (el: any) => { if (el) el.__props = p; } }, p.children);
  return { Badge: () => null, Empty: () => null, Tail: () => null, Waterline: () => null, Panel: box, Screen: box, TapRow: tap,
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
  const s = { items: [] as any[], marked: [] as string[], opened: [] as string[], actions: null as any };
  // One object for the app's life, as the world's actions are: a new one per render re-runs the focus effect.
  s.actions = {
    markSeenThrough: (_p: string, ids: string[]) => { for (const id of ids) if (!s.marked.includes(id)) s.marked.push(id); },
    leaveFeed: () => undefined, markAllSeen: () => undefined, hydrateMessage: (id: string) => { s.opened.push(id); }, holdFiles: () => undefined, releaseFiles: () => undefined,
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
const { DECKS } = await import("../src/copy");

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
  act(() => { win.at = y; win.scroller[name]?.({ nativeEvent: { contentOffset: { x: 0, y }, layoutMeasurement: { width: 400, height: VIEW } } }); });
const look = (y: number) => { for (const m of st.items) if (topOf(m.id) < y + VIEW && topOf(m.id) + ROW > y) onScreen.add(m.id); };
/** The list scrolls itself to `y`: no finger on the screen. */
const listMoves = (y: number) => { place(y); report("onScroll", y); };
/** Time goes by on the device's clock. */
const pass = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });
/** The person drags from `from` to `to`, a report every `step`, `ms` apart. */
const drag = (from: number, to: number, step = 100, ms = 0) => {
  report("onScrollBeginDrag", from);
  const dir = Math.sign(to - from) || 1;
  for (let y = from; dir * (to - y) >= 0; y += dir * step) { place(y); look(y); report("onScroll", y); if (ms) pass(ms); }
  place(to); look(to); report("onScroll", to);
  report("onScrollEndDrag", to);
};
/** A hard fling: a short flick, then the glide's reports a frame apart, then the landing. */
const fling = (to: number, from = 0) => {
  drag(from, from + 120, 60, 16);
  report("onMomentumScrollBegin", from + 120);
  for (let y = from + 120; y < to; y += 700) { listMoves(y); pass(16); }
  place(to); look(to); report("onScroll", to);
  report("onMomentumScrollEnd", to);
};
/** A real fling from `from`: a flick, then a glide slowing by 0.998 a ms (iOS's normal rate) to below 0.05 dp/ms; where it lands. */
const glide = (from: number) => {
  drag(from, from + 120, 60, 16);
  report("onMomentumScrollBegin", from + 120);
  let y = from + 120;
  for (let v = 4; v >= 0.05; v *= 0.998 ** 16) { y = Math.round(y + v * 16); listMoves(y); pass(16); }
  report("onMomentumScrollEnd", y);
  return y;
};
/** The letters whose first lines (140 px) stand on a screen at `y`. */
const resting = (y: number) => st.items.map((m) => m.id).filter((id) => topOf(id) >= y && topOf(id) + 140 <= y + VIEW).sort();
/** The stream goes behind (a tab switch). */
const leave = () => act(() => { if (typeof focus.cleanup === "function") focus.cleanup(); focus.cleanup = undefined; });
const open = (rows: any[], shown: () => ReturnType<typeof h> = () => h(ReadsScreen)) => {
  Shown = shown;
  st.items = rows;
  st.marked = [];
  onScreen.clear();
  win.ids = null;
  win.scrolls = [];
  win.at = 0;
  screen = mount(Shown());
  place(0);
};
const arrive = (rows: any[]) => { st.items = [...rows, ...st.items]; };

beforeEach(() => { vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] }); });
afterEach(() => { screen?.unmount(); screen = null; win.ids = null; vi.restoreAllMocks(); vi.useRealTimers(); });

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

  it("a fling reads none of the letters it carries past, and the screen it lands on once that rests", () => {
    open(letters("NW", 40));
    fling(endOf(40));
    expect(st.marked).toEqual([]);
    pass(800);
    // The landing screen's three letters rested there; NW39 and NW38 were under the finger a moment only.
    expect(st.marked.sort()).toEqual(["NW0", "NW1", "NW2"]);
  });

  it("a letter measured before arrivals pushed it down is not marked from where it stood", () => {
    open(letters("NW", 40));
    fling(endOf(40));
    arrive(letters("NX", 20));
    listMoves(endOf(40) + 20 * ROW);
    listMoves(0); // back at the top in one move (a status-bar tap): nothing drawn between
    drag(0, 3600, 50, 100);
    expect(st.marked.filter((id) => !onScreen.has(id))).toEqual([]);
    expect(st.marked).toContain("NX18"); // the arrivals the person did read through turn read
  });

  it("News shown again after the Ohbox opens at the letter the reader left, though the list slipped meanwhile", () => {
    open(letters("NW", 40));
    drag(0, topOf("NW16"));
    act(() => { if (typeof focus.cleanup === "function") focus.cleanup(); focus.cleanup = undefined; });
    arrive(letters("NZ", 3));
    place(topOf("NW16") - 3 * ROW); // the letters are drawn above; the window has not moved
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_000);
    report("onScroll", HEAD + 3 * ROW); // a minute on, the device's list slips to the top of the old block
    act(() => { focus.cleanup = focus.cb?.(); });
    expect(win.at, "News opens at the letter the reader left").toBe(topOf("NW16"));
  });

  it("letters arriving at the end of News keep the last letters in view, and the list's window follows the rows", () => {
    open(letters("NW", 40));
    drag(0, endOf(40), 150);
    expect(win.held, "the list moves its window by the first row, not the group's header").toBe("issues:NW39");
    const scroll = screen!.el.querySelector('[data-rn="ScrollView"]') as any;
    expect(scroll.__props.maintainVisibleContentPosition.minIndexForVisible, "the scroll view's hold starts past the head").toBe(1);
    arrive(letters("NY", 5));
    place(endOf(40));
    expect(win.held).toBe("issues:NY4");
    expect(win.at, "the last letters are still in view").toBe(endOf(45));
    report("onScroll", endOf(45));
    const before = win.scrolls.length;
    drag(endOf(45), endOf(45) - 900); // the person's own scroll is never pulled back
    expect(win.scrolls.length).toBe(before);
  });

  it("control: at the top, letters arriving show above; nothing is scrolled", () => {
    open(letters("NW", 40));
    arrive(letters("NY", 5));
    place(0);
    report("onScroll", 0);
    expect(win.scrolls).toEqual([]);
  });

  it("control: a person's own slow scroll reads each letter whose first lines stayed on screen 0.7 s", () => {
    open(letters("NW", 40));
    drag(0, 3000, 50, 100);
    // 500 px a second: a letter's first lines (140 of 300) stay in a 900 view 1.5 s. NW39 left
    // 0.2 s after the drag began; NW28's lines came in 0.72 s before it stopped, NW27's 0.12 s.
    expect(st.marked).toEqual(ids(letters("NW", 40)).slice(1, 12));
  });
});

describe("phone Receipts marks only the receipts a person scrolled through", () => {
  it("receipts arriving above a deep place stay unread while the list holds the place", () => {
    open(letters("RW", 40), () => h(ReceiptsScreen));
    drag(0, endOf(40), 150, 250);
    expect(st.marked).toContain("RW20");
    arrive(letters("RX", 20));
    const held = endOf(40) + 20 * ROW;
    listMoves(held);
    drag(held, held - 200);
    expect(st.marked.filter((id) => id.startsWith("RX"))).toEqual([]);
  });
});

/* The web's rule (#415): a letter turns read once its first lines rest on screen 0.7 s; a fling or a fast
   drive reads nothing it carries past, and a letter showing only its sender line at the foot stays unread. */
describe("phone News and Receipts read only what rests on screen", () => {
  it("a fast fling over fifteen letters reads none of them; the screen it lands on reads after the rest", () => {
    open(letters("NW", 40));
    fling(topOf("NW24"));
    pass(600);
    expect(st.marked).toEqual([]);
    pass(200);
    expect(st.marked.sort()).toEqual(["NW22", "NW23", "NW24"]);
  });

  it("three fast flings from the top, then the stream left, read nothing", () => {
    open(letters("NW", 40));
    fling(topOf("NW35"));
    pass(200);
    fling(topOf("NW30"), topOf("NW35"));
    pass(200);
    fling(topOf("NW25"), topOf("NW30"));
    pass(300);
    leave();
    pass(5000);
    expect(st.marked).toEqual([]);
  });

  it("a fast drive that stops on a letter reads it after the rest time, and nothing it passed", () => {
    open(letters("NW", 40));
    drag(0, topOf("NW30"), 100, 16);
    // Each letter's first lines came in at the screen's foot a moment before the stop: 0.7 s from then.
    pass(300);
    expect(st.marked).toEqual([]);
    pass(500);
    expect(st.marked.sort()).toEqual(["NW28", "NW29", "NW30"]);
  });

  it("leaving before the rest reads nothing", () => {
    open(letters("NW", 40));
    drag(0, topOf("NW30"), 100, 16);
    pass(400);
    leave();
    pass(3000);
    expect(st.marked).toEqual([]);
  });

  it("a letter showing only its sender line at the foot stays unread", () => {
    open(letters("NW", 40));
    drag(0, topOf("NW28") - VIEW + 50, 100, 16);
    pass(2000);
    leave();
    expect(st.marked.sort()).toEqual(["NW29", "NW30"]);
  });

  it("a scroll the app makes after a drive reads nothing until the person drags again", () => {
    open(letters("NW", 40));
    drag(0, 600, 100, 16);
    pass(200);
    listMoves(topOf("NW10")); // a status-bar tap's jump: the list's own scroll
    pass(3000);
    expect(st.marked).toEqual([]);
    drag(topOf("NW10"), topOf("NW10") + 30);
    pass(800);
    expect(st.marked.sort()).toEqual(["NW8", "NW9"]);
  });

  it("three real flings back to back, each slowing to a stop, then the stream left, read nothing", () => {
    open(letters("NW", 40));
    glide(glide(glide(0)));
    leave();
    pass(5000);
    expect(st.marked).toEqual([]);
  });

  it("a real fling's slow end reads nothing; its landing screen reads 0.7 s after the landing", () => {
    open(letters("NW", 40));
    const y = glide(0);
    pass(650);
    expect(st.marked).toEqual([]);
    pass(100);
    expect(st.marked.sort()).toEqual(resting(y));
  });

  it("the list holding its place during the rest still reads the letters resting on screen", () => {
    open(letters("NW", 40));
    drag(topOf("NW20") - 100, topOf("NW20"));
    pass(300);
    arrive(letters("NX", 2));
    listMoves(topOf("NW20")); // the place held: the same letters stand still on the glass
    pass(5000);
    expect(st.marked.sort()).toEqual(["NW18", "NW19", "NW20"]);
  });

  it("the place held when the list's report comes before the cells' new layout still reads the resting letters", () => {
    open(letters("NW", 40));
    fling(topOf("NW24"));
    pass(150);
    arrive(letters("NX", 1));
    report("onScroll", topOf("NW24")); // the offset moves first...
    pass(16);
    place(topOf("NW24")); // ...the cells lay out where they now stand a frame later
    pass(5000);
    expect(st.marked.sort()).toEqual(["NW22", "NW23", "NW24"]);
  });

  it("Receipts: the list holding its place after a fling still reads the receipts resting on screen", () => {
    open(letters("RW", 40), () => h(ReceiptsScreen));
    fling(topOf("RW24"));
    pass(150);
    arrive(letters("RX", 1));
    listMoves(topOf("RW24"));
    pass(5000);
    expect(st.marked.sort()).toEqual(["RW22", "RW23", "RW24"]);
  });

  it("Receipts: a receipt marked unread on screen stays unread through a small drag and a rest until the leave", () => {
    open(letters("RW", 40).map((m) => ({ ...m, unread: false })), () => h(ReceiptsScreen));
    st.items = st.items.map((m) => (m.id === "RW38" ? { ...m, unread: true } : m)); // the row's swipe: Mark unread
    place(0);
    drag(0, 40);
    pass(2000);
    expect(st.marked).not.toContain("RW38");
    expect(st.marked, "a read receipt resting on screen still anchors the leave").toContain("RW39");
    leave();
    act(() => { focus.cleanup = focus.cb?.(); }); // a new visit: Mark unread starts it over
    drag(40, 80);
    pass(2000);
    expect(st.marked).toContain("RW38");
  });

  it("Receipts: a fast fling over fifteen receipts reads none of them", () => {
    open(letters("RW", 40), () => h(ReceiptsScreen));
    fling(topOf("RW24"));
    pass(600);
    expect(st.marked).toEqual([]);
    pass(200);
    expect(st.marked.sort()).toEqual(["RW22", "RW23", "RW24"]);
  });

  it("the phone's words state the rest rule, English and German", () => {
    const says = { en: ["rests on screen", "quick scroll past leaves it unread"], de: ["auf dem Bildschirm stehen bleibt", "Vorbeiscrollen lässt ihn ungelesen"] };
    for (const locale of ["en", "de"] as const) {
      const deck = DECKS[locale];
      for (const line of [deck.streamSeenHint, deck.readsTail(3)]) expect(line).not.toMatch(/scrolling past[^.]*marks|Vorbeiscrollen markiert/i);
      expect(deck.streamSeenHint).toContain(says[locale][0]);
      expect(deck.readsTail(3)).toContain(says[locale][0]);
      expect(deck.readsTail(3)).toContain(says[locale][1]);
    }
  });
});

/* Android ends no glide its next touch cancels: a fast fling toward the top with the list already there
   (the touch taken by the pull to refresh) leaves one begun for good, and the scroll view took every
   press as stopping it until a small scroll. */
describe("phone lists: a fling at the top edge leaves every press live", () => {
  /** The device's own report, through the scroll view as the native view sends it. */
  const native = (name: string, y: number) => act(() => {
    const e = { nativeEvent: { contentOffset: { x: 0, y }, layoutMeasurement: { width: 400, height: VIEW }, velocity: { x: 0, y: 0 } } };
    if (name === "onMomentumScrollBegin") win.view._handleMomentumScrollBegin(e);
    else if (name === "onMomentumScrollEnd") win.view._handleMomentumScrollEnd(e);
    else win.view.props[name]?.(e);
  });
  /** A fast fling toward the top at the top (200 ms over 1300 px): the list cannot move, a glide begins, the next touch comes 50 ms on.
      `cancelled`: each starts with a touch the pull to refresh takes, which Android ends with no end drag and no glide end. */
  const edgeFlings = (n: number, cancelled = false) => {
    for (let i = 0; i < n; i++) {
      if (cancelled) {
        native("onScrollBeginDrag", 0);
        pass(120);
      }
      native("onScrollBeginDrag", 0);
      pass(200);
      native("onScrollEndDrag", 0);
      native("onMomentumScrollBegin", 0);
      pass(50);
    }
  };
  /** A press on a letter's card: the scroll view keeps it while it holds a glide running, else the card's own press runs. */
  const press = (id: string) => act(() => {
    if (win.view.takesTouch()) return;
    (screen!.el.querySelector(`[data-row="${id}"] [data-tap]`) as any).__props.onPress();
  });
  beforeEach(() => { st.opened = []; });

  it("three fast flings at the top: a press on a letter opens it", () => {
    open(letters("NW", 40));
    edgeFlings(3);
    pass(450);
    press("NW39");
    expect(st.opened).toEqual(["NW39"]);
  });

  it("eight fast flings at the top: a press on a letter opens it, and one a minute later too", () => {
    open(letters("NW", 40));
    edgeFlings(8);
    pass(450);
    press("NW38");
    pass(60_000);
    press("NW37");
    expect(st.opened).toEqual(["NW38", "NW37"]);
  });

  it("a touch the pull to refresh takes after the flings (a begin drag, no end drag, no glide end): presses open, and a minute later too", () => {
    open(letters("NW", 40));
    edgeFlings(2);
    native("onScrollBeginDrag", 0);
    pass(450);
    press("NW39");
    pass(60_000);
    press("NW38");
    expect(st.opened).toEqual(["NW39", "NW38"]);
    expect(st.marked.sort()).toEqual(["NW37", "NW38", "NW39"]);
  });

  it("three and eight flings each starting with a touch the pull to refresh takes: a press on a letter opens it", () => {
    open(letters("NW", 40));
    edgeFlings(3, true);
    native("onScrollBeginDrag", 0);
    pass(450);
    press("NW39");
    expect(st.opened).toEqual(["NW39"]);
    edgeFlings(8, true);
    native("onScrollBeginDrag", 0);
    pass(450);
    press("NW38");
    pass(60_000);
    press("NW37");
    expect(st.opened).toEqual(["NW39", "NW38", "NW37"]);
  });

  it("control: a finger dragging the list keeps it, its glide still pressing nothing until it lands", () => {
    open(letters("NW", 40));
    native("onScrollBeginDrag", 0);
    native("onScrollEndDrag", 120);
    native("onMomentumScrollBegin", 120);
    pass(100);
    native("onScrollBeginDrag", 120);
    let y = 120;
    for (let i = 0; i < 30; i++) {
      y += 20;
      place(y);
      native("onScroll", y);
      pass(16);
    }
    native("onScrollEndDrag", y);
    native("onMomentumScrollBegin", y);
    for (let i = 0; i < 20; i++) {
      y += 20;
      place(y);
      native("onScroll", y);
      pass(16);
      if (i === 10) press("NW38");
    }
    expect(st.opened).toEqual([]);
    native("onMomentumScrollEnd", y);
    pass(100);
    press("NW38");
    expect(st.opened).toEqual(["NW38"]);
  });

  it("the glide at the edge ends without the device's end: the letters resting at the top read after the rest, none other", () => {
    open(letters("NW", 40));
    edgeFlings(3);
    pass(5000);
    expect(st.marked.sort()).toEqual(["NW37", "NW38", "NW39"]);
  });

  /* A finger catching a glide and holding still: Android sends a begin drag and cancels its own end, so
     only the list's still end comes; the finger then drags on. */
  for (const hold of [400, 1500]) {
    it(`a glide caught and held ${hold} ms, the list redrawn, then dragged on: the list follows the finger, never back to the held place`, () => {
      open(letters("NW", 40));
      let y = 3000;
      native("onScrollBeginDrag", y);
      for (; y < 3120; y += 60) { place(y); native("onScroll", y); pass(16); }
      native("onScrollEndDrag", y);
      native("onMomentumScrollBegin", y);
      for (; y < 3550; y += 100) { place(y); native("onScroll", y); pass(16); }
      y = 3550;
      place(y);
      native("onScroll", y);
      native("onScrollBeginDrag", y);
      pass(hold);
      place(y);
      for (let i = 0; i < 6; i++) { y += 40; place(y); native("onScroll", y); pass(16); }
      expect(win.scrolls).toEqual([]);
      native("onScrollEndDrag", y);
    });
  }

  it("control: a press while a fling still glides stops it and opens nothing; once it lands a press opens", () => {
    open(letters("NW", 40));
    native("onScrollBeginDrag", 0);
    native("onScrollEndDrag", 120);
    native("onMomentumScrollBegin", 120);
    let y = 120;
    for (let i = 0; i < 40; i++) {
      y += 30;
      place(y);
      native("onScroll", y);
      pass(16);
      if (i === 20) press("NW38");
    }
    expect(st.opened).toEqual([]);
    native("onMomentumScrollEnd", y);
    pass(100);
    press("NW38");
    expect(st.opened).toEqual(["NW38"]);
  });

  it("control: a fling the device ends reads its landing after the rest, as before", () => {
    open(letters("NW", 40));
    native("onScrollBeginDrag", 0);
    native("onScrollEndDrag", 0);
    native("onMomentumScrollBegin", 0);
    pass(60);
    native("onMomentumScrollEnd", 0);
    pass(650);
    expect(st.marked).toEqual([]);
    pass(100);
    expect(st.marked.sort()).toEqual(["NW37", "NW38", "NW39"]);
    press("NW39");
    expect(st.opened).toEqual(["NW39"]);
  });
});
