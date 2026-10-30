/** @vitest-environment jsdom */
/**
 * FOLDABLE POSTURES KEEP THE REPLY, rendered. The list-detail pair is mounted
 * under React DOM and driven through the Magic the postures as the platform reports them: inner
 * 718 x 897, outer 353 x 792, book (a vertical half fold), tabletop (897 x 718, a horizontal half
 * fold), and the Galaxy Z Fold's inner panel in book posture (674 x 841). The reader is a probe that
 * counts its mounts: a posture change that remounts or re-parents it has lost the reply open on it.
 */
import { useEffect, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { derivePosture, type FoldFeature, type Posture } from "../src/ui/posture/derive";
import { holdReader } from "../src/ui/reader-held";
import { flushLayout, holdLayout, mount, styleOf } from "./_rendered-dom";

/* Android's system Back: the newest listener first, until one takes the press; none takes it, the app leaves. */
const back = vi.hoisted(() => ({ subs: [] as (() => boolean)[] }));
const pressBack = (): boolean => [...back.subs].reverse().some((fn) => fn());
vi.mock("react-native", async () => ({
  ...(await import("./_rendered-dom")).rnDom,
  BackHandler: {
    addEventListener: (_e: string, fn: () => boolean) => {
      back.subs.push(fn);
      return { remove: () => { back.subs = back.subs.filter((f) => f !== fn); } };
    },
  },
}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 24, bottom: 16, left: 0, right: 0 }) }));
const nav = vi.hoisted(() => ({
  push: [] as string[], replace: [] as string[], dismissTo: [] as string[], events: [] as string[],
  focused: true, params: { open: "" as string },
}));
vi.mock("expo-router", async () => {
  const { createContext, useContext } = await import("react");
  /* A tab's own focus, where a test mounts two tabs; elsewhere the pair's (`nav.focused`). */
  const TabFocused = createContext<boolean | null>(null);
  return {
    TabFocused,
    router: {
      push: (p: string) => nav.push.push(p),
      replace: (p: { pathname: string }) => { nav.replace.push(p.pathname); nav.events.push("replace"); },
      dismissTo: (p: { pathname: string }) => { nav.dismissTo.push(p.pathname); nav.events.push("dismissTo"); },
      setParams: (p: { open: string }) => { nav.params = p; },
    },
    useLocalSearchParams: () => nav.params,
    usePathname: () => "/",
    useIsFocused: () => useContext(TabFocused) ?? nav.focused,
  };
});
vi.mock("../src/copy", () => ({ Copy: new Proxy({}, { get: (_t, k) => String(k) }) }));
vi.mock("../src/theme", () => ({
  useTheme: () => ({ c: { hairSoft: "#ccc", tint: "#eee", ink3: "#666", canvas: "#fff" }, radius: { pill: 99 }, zLayer: { tabBar: 5 } }),
}));
vi.mock("../src/state/world", () => ({ useWorld: () => ({ account: { name: "", email: "" }, ohbox: { unread: 0 }, screener: { waiting: [] }, reads: { newCount: 0 }, receipts: { newCount: 0 } }) }));
vi.mock("../src/engine/ui-marks", () => ({ beginMark: () => undefined }));
vi.mock("../src/ui/base", async () => {
  const { rnDom } = await import("./_rendered-dom");
  return {
    Screen: ({ children, style }: { children: unknown; style?: unknown }) => rnDom.View({ style, children: children as never, testID: "screen" }),
    Empty: () => null, Rule: () => null, Tap: () => null, Txt: () => null, useTopPad: (gap: number) => 24 + gap,
  };
});
vi.mock("../src/ui/FadeOut", async () => {
  const { rnDom } = await import("./_rendered-dom");
  return { FadeOut: (p: { edge?: string; height?: number }) => rnDom.View({ testID: `fade-${p.edge ?? "bottom"}`, style: { height: p.height } }) };
});
/* The chrome's own state, which a bar-less pane's top reads none of. */
vi.mock("../src/state/live", () => ({ firstSyncContinuesSaid: () => null, topLineSaid: () => null }));
vi.mock("../src/net/network-door", () => ({ useNetworkNow: () => "online" }));
vi.mock("../src/ui/UnsavedChanges", () => ({ UnsavedChanges: () => null }));
vi.mock("../src/ui/ErrorBoundary", () => ({ SurfaceBoundary: ({ children }: { children: unknown }) => children }));
vi.mock("../src/ui/glass", () => ({ GlassRail: () => null, GlassSidebar: (p: { open: boolean }) => (p.open ? "sidebar" : null) }));
vi.mock("../src/ui/Icon", () => ({ Icon: () => null }));
vi.mock("../src/ui/MoreNav", () => ({ MoreNav: () => null, Nav: () => null }));
vi.mock("../src/ui/reader-rail", () => ({ useReaderRail: () => null }));
const live = vi.hoisted(() => ({ posture: null as unknown, win: { width: 0, height: 0 } }));
vi.mock("../src/ui/posture", async () => ({
  ...(await import("../src/ui/posture/derive")),
  usePosture: () => live.posture,
  useAppWindow: () => live.win,
  useStatusCluster: () => null,
}));

const { ListDetail } = await import("../src/ui/list-detail");
const { TabFocused } = (await import("expo-router")) as unknown as { TabFocused: import("react").Context<boolean | null> };
const { usePaneMove } = await import("../src/ui/pane-move");
const { usePaneChrome } = await import("../src/ui/pane-chrome");
const { act } = await import("react");
const { railHome, scaffoldPlan } = await import("../src/ui/scaffold/plan");

const vertical = (x: number, h: number, state: "flat" | "half"): FoldFeature =>
  ({ bounds: { x, y: 0, w: 0, h }, state, orientation: "vertical", occlusion: "none" });
const horizontal = (y: number, w: number): FoldFeature =>
  ({ bounds: { x: 0, y, w, h: 0 }, state: "half", orientation: "horizontal", occlusion: "none" });
/* What the Honor foldable (394 dpi) and the Z Fold inner panel (420 dpi) report, in dp. */
const POSES = {
  inner: { width: 718, height: 897, folds: [] as FoldFeature[] },
  outer: { width: 353, height: 792, folds: [] as FoldFeature[] },
  book: { width: 718, height: 897, folds: [vertical(359, 897, "half")] },
  tabletop: { width: 897, height: 718, folds: [horizontal(359, 897)] },
  book674: { width: 674, height: 841, folds: [vertical(337, 841, "half")] },
  landscape: { width: 897, height: 718, folds: [] as FoldFeature[] },
} as const;
type Pose = keyof typeof POSES;

function setPose(pose: Pose): Posture {
  const p = POSES[pose];
  live.posture = derivePosture({ ...p, platform: "android", hasFold: true });
  live.win = { width: p.width, height: p.height };
  return live.posture as Posture;
}

/* The reader: its state is the reply being typed, and a mount it did not keep is a reply lost. */
const mounts: string[] = [];
function Reader({ id }: { id: string }) {
  const [draft] = useState(() => { mounts.push(id); return `reply-${mounts.length}`; });
  return <div data-testid="reader" data-draft={draft} />;
}
const listMounts: number[] = [];
function List() {
  useState(() => listMounts.push(1));
  return <div data-testid="list" />;
}

function Pair(_: { tick: number }) {
  return (
    <ListDetail
      key="pair"
      open={nav.params.open === "" ? null : nav.params.open}
      onClose={() => { nav.params = { open: "" }; }}
      toRoute={(id) => `/message/${id}`}
      list={<List />}
      renderDetail={(id) => <Reader id={id} />}
    />
  );
}

const slot = (el: HTMLElement, i: number) => el.querySelector('[data-testid="screen"] > div > div')!.children[i] as HTMLElement;
const token = Symbol("reply");
let tick = 0;

beforeEach(() => {
  mounts.length = 0;
  listMounts.length = 0;
  nav.push = [];
  nav.replace = [];
  nav.dismissTo = [];
  nav.events = [];
  nav.focused = true;
  nav.params = { open: "m1" };
});
afterEach(() => holdReader(token, false));

describe("a posture change keeps the open reply (R4-02, R4-03)", () => {
  it("through tabletop, book, a fold and an unfold, the reader is mounted once and stays the same node", () => {
    setPose("inner");
    const r = mount(<Pair tick={tick++} />);
    holdReader(token, true); // the reply sheet is open on the reader
    const reader = r.el.querySelector('[data-testid="reader"]');
    expect(reader, "the pair shows the reader").not.toBeNull();
    for (const pose of ["tabletop", "inner", "book", "outer", "inner", "tabletop", "book", "inner"] as Pose[]) {
      setPose(pose);
      r.render(<Pair tick={tick++} />);
      expect(r.el.querySelector('[data-testid="reader"]'), `${pose}: the reader's node`).toBe(reader);
    }
    expect(mounts, "the reader mounted again: the reply on it was lost").toEqual(["m1"]);
    expect(nav.push, "a held reader never moves to the pushed route").toEqual([]);
    r.unmount();
  });

  it("tabletop stacks the reader above the list by reversing the column, never by swapping slots", () => {
    setPose("tabletop");
    const r = mount(<Pair tick={tick++} />);
    const box = r.el.querySelector('[data-testid="screen"] > div > div') as HTMLElement;
    expect(styleOf(box).flexDirection).toBe("column-reverse");
    expect(slot(r.el, 0).querySelector('[data-testid="list"]'), "the first slot is the list's on every posture").not.toBeNull();
    expect(slot(r.el, 2).querySelector('[data-testid="reader"]')).not.toBeNull();
    expect(styleOf(slot(r.el, 2)).height, "the reader holds the upper segment").toBeGreaterThan(0);
    r.unmount();
  });
});

describe("a fold and an unfold never re-parent the list (R4-01)", () => {
  it("with nothing open the list is mounted once across fold, unfold, book and tabletop", () => {
    nav.params = { open: "" };
    setPose("inner");
    const r = mount(<Pair tick={tick++} />);
    const list = r.el.querySelector('[data-testid="list"]');
    for (const pose of ["outer", "inner", "outer", "inner", "book", "tabletop", "inner"] as Pose[]) {
      setPose(pose);
      r.render(<Pair tick={tick++} />);
      expect(r.el.querySelector('[data-testid="list"]'), `${pose}: the list's node`).toBe(list);
    }
    expect(listMounts).toHaveLength(1);
    r.unmount();
  });

  it("a fold with nothing held hands the reading to the pushed route, and the list stays mounted", () => {
    setPose("inner");
    const r = mount(<Pair tick={tick++} />);
    setPose("outer");
    r.render(<Pair tick={tick++} />);
    expect(nav.push).toEqual(["/message/m1"]);
    r.render(<Pair tick={tick++} />);
    expect(styleOf(slot(r.el, 2)).display, "the reader's slot is hidden once the param clears").toBe("none");
    expect(styleOf(slot(r.el, 0)).flex).toBe(1);
    expect(listMounts).toHaveLength(1);
    r.unmount();
  });

  /* Every tab stays mounted, each with its own selection: a sender left open in the Screener,
     then a conversation opened in the Ohbox, then a fold (tester C, round 6). */
  it("a fold moves only the focused tab's reading; a tab left behind moves its own when it is back", () => {
    const sel = { ohbox: "m1", screener: "s1" };
    let front: keyof typeof sel = "ohbox";
    const routes = { ohbox: (id: string) => `/message/${id}`, screener: (k: string) => `/sender/waiting/${k}` };
    const Tabs = (_: { tick: number }) => (
      <>
        {(["screener", "ohbox"] as const).map((tab) => (
          <TabFocused.Provider key={tab} value={front === tab}>
            <ListDetail open={sel[tab] === "" ? null : sel[tab]} onClose={() => { sel[tab] = ""; }}
              toRoute={routes[tab]} list={<List />} renderDetail={(id) => <Reader id={id} />} />
          </TabFocused.Provider>
        ))}
      </>
    );
    setPose("inner");
    const r = mount(<Tabs tick={tick++} />);
    setPose("outer");
    r.render(<Tabs tick={tick++} />);
    expect(nav.push, "the conversation is on top, and Back under it is the list, not the sender").toEqual(["/message/m1"]);
    expect(sel, "the Screener keeps its sender until it is the tab in front").toEqual({ ohbox: "", screener: "s1" });
    front = "screener";
    r.render(<Tabs tick={tick++} />);
    expect(nav.push).toEqual(["/message/m1", "/sender/waiting/s1"]);
    expect(sel.screener).toBe("");
    r.unmount();
  });
});

describe("book posture keeps every pane off the crease (R4-04)", () => {
  for (const pose of ["book", "book674"] as Pose[]) {
    it(`${pose}: two panes meet at the hinge with the keep-out band between them`, () => {
      const p = setPose(pose);
      expect(p.panes, "a book fold splits at the hinge whatever the width floor").toBe(2);
      const r = mount(<Pair tick={tick++} />);
      const box = styleOf(r.el.querySelector('[data-testid="screen"] > div > div'));
      const listW = styleOf(slot(r.el, 0)).width as number;
      const seamW = styleOf(slot(r.el, 1)).width as number;
      const hinge = p.hinge!;
      const listRight = (box.paddingLeft as number) + listW;
      expect(listRight, "the list ends before the crease").toBeLessThanOrEqual(hinge.x);
      expect(listRight + seamW, "the reader begins past it").toBeGreaterThanOrEqual(hinge.x + hinge.w);
      expect(listW, "a list a person can read").toBeGreaterThanOrEqual(240);
      r.unmount();
    });
  }
});

describe("the pushed reader hands itself to the pane and draws nothing after (R4-01)", () => {
  function Leaving() {
    useEffect(() => () => { nav.events.push("reader-gone"); }, []);
    return <Reader id="m1" />;
  }
  function Pushed({ twoPane, held }: { twoPane: boolean; held: boolean }) {
    const leaving = usePaneMove(twoPane ? { pathname: "/", params: { open: "m1" } } : null, held);
    return leaving ?? <Leaving />;
  }

  it("an unfold pops back to the pane's existing route once, and from then on the leaving screen renders nothing", () => {
    const r = mount(<Pushed twoPane={false} held={false} />);
    expect(r.el.querySelector('[data-testid="reader"]')).not.toBeNull();
    r.render(<Pushed twoPane held={false} />);
    expect(nav.dismissTo).toEqual(["/"]);
    expect(nav.replace, "a REPLACE appends a second Ohbox to the stack on every move").toEqual([]);
    expect(r.el.querySelector('[data-testid="reader"]'), "a leaving screen that re-renders can move a view its exit still holds").toBeNull();
    r.render(<Pushed twoPane held={false} />);
    expect(nav.dismissTo, "one move").toEqual(["/"]);
    expect(nav.events, "the route is emptied, and laid out, BEFORE the stack removes it").toEqual(["reader-gone", "dismissTo"]);
    r.unmount();
  });

  it("a COVERED reader never moves: the stack's top is not its to replace", () => {
    nav.focused = false; // Search, or another reader, stands over this one
    const r = mount(<Pushed twoPane={false} held={false} />);
    r.render(<Pushed twoPane held={false} />);
    expect(nav.dismissTo).toEqual([]);
    expect(r.el.querySelector('[data-testid="reader"]'), "a covered reader that emptied itself stays a blank page").not.toBeNull();
    nav.focused = true; // the cover goes: now it is this route's move
    r.render(<Pushed twoPane held={false} />);
    expect(nav.dismissTo).toEqual(["/"]);
    r.unmount();
  });

  it("a target that goes before the layout cancels the move and the reader comes back", () => {
    const r = mount(<Pushed twoPane={false} held={false} />);
    holdLayout();
    r.render(<Pushed twoPane held={false} />); // unfolded: the route empties
    expect(r.el.querySelector('[data-testid="reader"]')).toBeNull();
    r.render(<Pushed twoPane={false} held={false} />); // folded again before the layout ran
    flushLayout();
    expect(nav.dismissTo, "a move to a pane that is gone").toEqual([]);
    expect(r.el.querySelector('[data-testid="reader"]'), "a route left empty for good").not.toBeNull();
    r.unmount();
  });

  it("an open reply holds the move: no move, the reader stays", () => {
    const r = mount(<Pushed twoPane held />);
    expect(nav.dismissTo).toEqual([]);
    expect(r.el.querySelector('[data-testid="reader"]')).not.toBeNull();
    r.unmount();
  });
});

describe("system Back closes the reading pane before it leaves the app", () => {
  it("on the inner screen: the first Back closes the open reader, the next one is the system's", () => {
    setPose("inner");
    const r = mount(<Pair tick={tick++} />);
    expect(pressBack(), "Back with a reader open beside the list").toBe(true);
    expect(nav.params.open, "the reader closed").toBe("");
    r.render(<Pair tick={tick++} />);
    expect(pressBack(), "nothing open: Back leaves").toBe(false);
    r.unmount();
  });

  it("with the sidebar open, Back closes the sidebar first, then the reader, then it leaves", () => {
    setPose("inner");
    let chrome: ReturnType<typeof usePaneChrome> = null;
    function Toggle() { chrome = usePaneChrome(); return null; }
    const Shown = () => (
      <ListDetail open={nav.params.open === "" ? null : nav.params.open} onClose={() => { nav.params = { open: "" }; }}
        toRoute={(id) => `/message/${id}`} list={<Toggle />} renderDetail={(id) => <Reader id={id} />} />
    );
    const r = mount(<Shown />);
    act(() => chrome!.openDrawer());
    expect(r.el.textContent).toContain("sidebar");
    expect(pressBack(), "Back with the sidebar open").toBe(true);
    r.render(<Shown />);
    expect(r.el.textContent, "the sidebar closed").not.toContain("sidebar");
    expect(nav.params.open, "the reader is still open").toBe("m1");
    expect(pressBack()).toBe(true);
    r.render(<Shown />);
    expect(pressBack(), "nothing open: Back leaves").toBe(false);
    r.unmount();
  });

  it("a fold with the sidebar open leaves Back to the outer screen, and an unfold brings the sidebar back closed", () => {
    setPose("inner");
    nav.params = { open: "" };
    let chrome: ReturnType<typeof usePaneChrome> = null;
    function Toggle() { chrome = usePaneChrome(); return null; }
    const Shown = () => (
      <ListDetail open={nav.params.open === "" ? null : nav.params.open} onClose={() => { nav.params = { open: "" }; }}
        toRoute={(id) => `/message/${id}`} list={<Toggle />} renderDetail={(id) => <Reader id={id} />} />
    );
    const r = mount(<Shown />);
    act(() => chrome!.openDrawer());
    expect(r.el.textContent).toContain("sidebar");
    setPose("outer");
    r.render(<Shown />);
    expect(r.el.textContent, "no sidebar on the outer screen").not.toContain("sidebar");
    expect(pressBack(), "the first Back on the outer screen is the system's").toBe(false);
    setPose("inner");
    r.render(<Shown />);
    expect(r.el.textContent, "the unfold shows the sidebar closed").not.toContain("sidebar");
    r.unmount();
  });

  it("a screen over the pair (Search, a pushed route) answers Back itself; one pane leaves it to the pushed reader", () => {
    setPose("inner");
    nav.focused = false;
    const r = mount(<Pair tick={tick++} />);
    expect(pressBack()).toBe(false);
    expect(nav.params.open, "the covered pair keeps its reading").toBe("m1");
    r.unmount();
    nav.focused = true;
    nav.params = { open: "" };
    setPose("outer");
    const one = mount(<Pair tick={tick++} />);
    expect(pressBack()).toBe(false);
    one.unmount();
  });
});

/* The rail is the root's, drawn above every screen: a sidebar under it lost its labels. */
describe("the sidebar opens beside the floating rail, never under it", () => {
  it("two panes, landscape (897 x 718): the open sidebar starts past the rail and ends with the list", () => {
    const p = setPose("landscape");
    nav.params = { open: "" };
    let chrome: ReturnType<typeof usePaneChrome> = null;
    function Toggle() { chrome = usePaneChrome(); return null; }
    const r = mount(<ListDetail open={null} onClose={() => undefined} toRoute={(id) => `/message/${id}`}
      list={<Toggle />} renderDetail={(id) => <Reader id={id} />} />);
    act(() => chrome!.openDrawer());
    const drawer = r.el.querySelector('[data-testid="screen"]')!.lastElementChild as HTMLElement;
    expect(drawer.textContent).toBe("sidebar");
    const rail = railHome(scaffoldPlan(p, "android"), { top: 24, bottom: 16, left: 0, right: 0 }, { w: 897, h: 718 }, null);
    const d = styleOf(drawer) as { left: number; width: number };
    expect(d.left, "the sidebar's edge clears the rail's column").toBeGreaterThanOrEqual(rail.x + rail.width);
    const box = styleOf(r.el.querySelector('[data-testid="screen"] > div > div'));
    expect(d.left + d.width, "it covers the list pane to its edge").toBe((box.paddingLeft as number) + (styleOf(slot(r.el, 0)).width as number));
    r.unmount();
  });
});

/* A reader or a sender page in the pair's pane draws no bar; a line scrolled to its top was cut
   bare under the status bar, where the list pane beside it ends in a fade. */
describe("a bar-less pane's top edge", () => {
  it("pays the status bar's inset and ends a scrolled line in a fade, taking no room", async () => {
    const { PaneTop } = await import("../src/ui/chrome");
    const r = mount(<PaneTop />);
    const fade = r.el.querySelector('[data-testid="fade-top"]');
    expect(fade, "a scrolled line meets a bare cut").not.toBeNull();
    expect(styleOf(fade!.parentElement), "the edge takes no room").toMatchObject({ height: 0 });
    expect(styleOf(r.el.firstElementChild)).toMatchObject({ paddingTop: 24 });
    r.unmount();
  });
});
