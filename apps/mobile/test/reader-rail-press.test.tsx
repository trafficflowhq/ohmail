/** @vitest-environment jsdom */
/**
 * THE PHONE READER, rendered: a press on a rail square reaches that square, and a reader another
 * screen covers reads nothing. MessageReader runs under React DOM with React Native's primitives
 * drawn as divs; layout events are fired by hand. The scroll view clamps a scroll to the content
 * mounted and reports an offset only when it moved, as Android's does.
 *
 * The rail: React Native hit-tests later siblings first, each square's rect grown by its hit slop
 * (`Tap`'s default, `hitSlopFor(height)`, where none is passed). With that default the squares of a
 * long conversation overlapped by up to 7dp a side, so a press on one face reached the next square.
 *
 * The cover: on two panes (an unfolded foldable, an iPad) the pane reader stays mounted and laid out
 * under Search, Settings or another tab; a reply arriving then was read without being seen.
 */
import { createElement as h, act, type ReactNode } from "react";
import { createRequire } from "node:module";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const nav = vi.hoisted(() => ({ focused: true }));
vi.mock("expo-router", () => ({ useIsFocused: () => nav.focused }));

const native = vi.hoisted(() => ({
  offset: 0,
  content: 0,
  view: 640,
  events: [] as (() => void)[],
  props: null as null | Record<string, any>,
  asked: [] as number[],
}));

vi.mock("react-native", async () => {
  const React = await import("react");
  const keep = (props: any) => (el: any) => { if (el) el.__props = props; };
  const View = (props: any) => React.createElement("div", { "data-rn": "View", ref: keep(props) }, props.children);
  return {
    View,
    Text: (props: any) => React.createElement("span", null, props.children),
    ScrollView: (props: any) => React.createElement("div", { "data-rn": "RailScroll" }, props.children),
    Animated: {
      View: (props: any) => React.createElement("div", { "data-rn": "Animated" }, props.children),
      Value: class { constructor(_v: number) {} setValue() {} },
      timing: () => ({ start: () => undefined }),
    },
    AppState: { addEventListener: () => ({ remove: () => undefined }), currentState: "active" },
    Easing: { bezier: () => (x: number) => x },
    Linking: { openURL: async () => undefined },
    Platform: { OS: "android", select: (o: any) => o.android ?? o.default },
    StyleSheet: { absoluteFill: {}, create: (s: any) => s, hairlineWidth: 1 },
    useWindowDimensions: () => ({ width: 400, height: 800 }),
    ActivityIndicator: () => null,
  };
});

vi.mock("../src/ui/base", async () => {
  const React = await import("react");
  const keep = (props: any) => (el: any) => { if (el) el.__props = props; };
  /** The reader's scroll view, as Android's: clamped against the mounted content, an event only on a move. */
  const Scroller = (p: any) => {
    const { scrollRef, children } = p;
    native.props = p;
    const handle = {
      scrollTo: ({ y }: { y: number }) => {
        native.asked.push(y);
        const max = Math.max(0, native.content - native.view);
        const next = Math.max(0, Math.min(y, max));
        if (next !== native.offset) {
          native.offset = next;
          native.events.push(() => native.props?.onScroll?.({ nativeEvent: { contentOffset: { x: 0, y: next } } }));
        }
      },
    };
    if (typeof scrollRef === "function") scrollRef(handle);
    else if (scrollRef) scrollRef.current = handle;
    return React.createElement("div", { "data-rn": "ScrollView", ref: keep(p) }, children);
  };
  return {
    Chip: () => null,
    TagChip: () => null,
    Panel: (p: any) => React.createElement("div", { "data-rn": "Panel", ref: keep(p) }, p.children),
    Screen: (p: any) => React.createElement("div", { "data-rn": "Screen" }, p.children),
    Scroller,
    Tap: (p: any) => React.createElement("div", { "data-rn": "Tap", "data-test": p.testID, ref: keep(p) }, p.children),
    Txt: (p: any) => React.createElement("span", null, p.children),
  };
});

vi.mock("../src/theme", () => ({
  useTheme: () => ({
    c: new Proxy({}, { get: () => "#000" }),
    type: { readerBody: { lineHeight: 29 }, streamBody: { lineHeight: 25 } },
    radius: new Proxy({}, { get: () => 10 }),
    layout: { proseMax: 600 },
    reduceMotion: true,
    lift: () => ({}),
  }),
}));

const world = vi.hoisted(() => ({ mail: null as any, glanced: [] as string[][] }));
vi.mock("../src/state/world", () => ({
  useBodyStamp: () => 0,
  useFilesStamp: () => 0,
  useWorldToast: () => ({ say: () => undefined }),
  useWorld: () => ({
    worldKey: 1,
    message: (id: string) => (world.mail && world.mail.id === id ? world.mail : undefined),
    actions: {
      openMessage: () => undefined,
      releaseAttachments: () => undefined,
      leaveMessage: () => undefined,
      hydrateMessage: () => undefined,
      hydrateHeld: () => undefined,
      markSeen: () => undefined,
      markGlanced: (ids: string[]) => { world.glanced.push([...ids]); },
    },
  }),
}));
vi.mock("../src/state/live", () => ({ JUNK_REFILL_BOUND_MS: 10_000 }));
vi.mock("../src/ui/body-note", () => ({ invitationNote: () => null, junkLeaving: () => false, withheldNote: () => "" }));
vi.mock("../src/ui/attachment-fault-note", () => ({ attachmentFaultNote: () => "" }));
vi.mock("../src/mail/frame-nav", () => ({ openConfirmedLink: () => undefined }));
vi.mock("../src/engine/ui-marks", () => ({ endMark: () => undefined }));
vi.mock("../src/mail/open-attachment-native", () => ({ shareAttachmentBytes: async () => true }));
vi.mock("../src/ui/chrome", () => ({ DetailBar: () => null, PaneTop: () => null }));
vi.mock("../src/ui/Icon", () => ({ Icon: () => null }));
vi.mock("../src/ui/BodyPages", async () => {
  const React = await import("react");
  return { BodyPages: (p: any) => React.createElement("div", { "data-rn": "BodyPages", "data-text": p.text }) };
});
vi.mock("../src/ui/HistoryFold", async () => {
  const React = await import("react");
  return { HistoryFold: (p: any) => React.createElement(React.Fragment, null, p.children, p.end), HistoryRow: () => null };
});
vi.mock("../src/ui/EventCard", () => ({ EventCards: () => null }));
vi.mock("../src/ui/MailBodyFrame", () => ({ MailBodyFrame: () => null }));
vi.mock("../src/ui/FadeOut", () => ({ FadeOut: () => null }));
vi.mock("../src/ui/MessageActions", () => ({ MessageActions: () => null }));
vi.mock("../src/ui/posture", () => ({ usePosture: () => ({}) }));
vi.mock("../src/ui/reader-verbs", () => ({ readerVerbMode: () => "compact" }));
vi.mock("../src/ui/scaffold/plan", () => ({ scaffoldPlan: () => ({}) }));
vi.mock("../src/ui/Sheet", () => ({ Sheet: () => null, SheetRow: () => null }));
vi.mock("../src/ui/bottom-chrome", () => ({ useBottomChromeExtent: () => 0 }));
vi.mock("../src/ui/thread-heading", () => ({ threadHeading: () => "" }));

const require_ = createRequire(join(__dirname, "../../webapp/package.json"));
const client = require_("react-dom/client") as { createRoot(el: Element): { render(n: ReactNode): void; unmount(): void } };

const { MessageReader } = await import("../src/ui/MessageReader");
const { VISIT_HANDOFF_MS, endIdleVisit, resetVisitsForTests } = await import("../src/ui/visit-records");
const { hitSlopFor } = await import("../src/theme/tokens");
const { RAIL_TOP, railFit } = await import("../src/ui/reader-marks");

type El = HTMLElement & { __props?: Record<string, any> };
const src = (el: El) => String(el.__props?.onLayout ?? "");
const all = (root: Element): El[] => [...root.querySelectorAll<El>("[data-rn]")];
const lay = (el: El | undefined, layout: { y: number; height: number }) => {
  if (!el) throw new Error("no such view");
  act(() => { el.__props!.onLayout({ nativeEvent: { layout: { x: 0, width: 360, ...layout } } }); });
};
const flushNative = () => act(() => { for (const run of native.events.splice(0)) run(); });
const pass = (ms: number) => { for (let i = 0; i < ms; i += 16) act(() => { vi.advanceTimersByTime(16); }); };

function views(root: Element) {
  const els = all(root);
  const by = (needle: string) => els.find((el) => src(el).includes(needle));
  const panels = els.filter((el) => el.getAttribute("data-rn") === "Panel");
  const member = (id: string) => {
    const p = panels.find((el) => el.querySelector(`[data-text="body of ${id}"]`));
    if (!p) throw new Error(`no panel ${id}`);
    const inner = all(p);
    return {
      panel: p,
      header: inner.find((el) => src(el).includes("panelHeader")),
      body: inner.find((el) => src(el).includes("panelBody")),
      end: inner.find((el) => src(el).includes("panelEnd")),
    };
  };
  return {
    scroll: els.find((el) => el.getAttribute("data-rn") === "ScrollView")!,
    padded: by('offset("padded"'),
    above: by('offset("above"'),
    below: by('offset("below"'),
    opened: by('offset("opened"'),
    from: by("openedFrom("),
    obody: by("openedBody("),
    oend: by("openedEnd("),
    member,
  };
}

const memberOf = (id: string, sender: string) =>
  ({ id, subject: "Q3 plan", time: "09:00", body: `body of ${id}`, seen: false, ready: true as const, sender });
const mailOf = (id: string, earlier: (ReturnType<typeof memberOf> & { later?: boolean })[]) => ({
  id, unread: true, ownMail: false, from: { name: "Ben", address: "ben@fake.test" }, subject: "Q3 plan", time: "10:00",
  body: `body of ${id}`, bodyState: "full", html: null, place: "ohbox", earlier,
});

let root: { render(n: ReactNode): void; unmount(): void } | null = null;
let host: HTMLElement | null = null;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame", "Date"] });
  native.offset = 0; native.content = 0; native.view = 640; native.events = []; native.asked = [];
  world.glanced = [];
  nav.focused = true;
  resetVisitsForTests();
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  vi.useRealTimers();
});
const mountReader = (id: string) => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = client.createRoot(host);
  act(() => root!.render(h(MessageReader, { id })));
  return host;
};

type Slop = { top: number; bottom: number; left: number; right: number };
const slopOf = (p: Record<string, any>): Slop => {
  const s = p.hitSlop ?? hitSlopFor(Number(p.style?.height ?? 0)); // the real Tap's default
  return typeof s === "number" ? { top: s, bottom: s, left: s, right: s } : { top: s.top ?? 0, bottom: s.bottom ?? 0, left: s.left ?? 0, right: s.right ?? 0 };
};

describe("a press on a rail square reaches that square", () => {
  for (const [n, room] of [[2, 580], [30, 580], [40, 600], [30, 700]] as const) {
    it(`${n} messages on a ${room}dp rail${railFit(n, room).scrolls ? " (it scrolls)" : ""}: each face, and the jump to its message`, () => {
      const members = Array.from({ length: n - 1 }, (_, i) => ({ ...memberOf(`p${i + 1}`, "Ada"), later: false }));
      world.mail = mailOf(`p${n}`, members);
      const el = mountReader(`p${n}`);
      const toolbar = all(el).find((x) => String(x.__props?.accessibilityRole) === "toolbar");
      lay(toolbar, { y: 0, height: room });
      const v = views(el);
      lay(v.padded, { y: 0, height: 200 * n });
      lay(v.above, { y: 18, height: 200 * (n - 1) });
      for (let i = 0; i < n - 1; i++) lay(v.member(`p${i + 1}`).panel, { y: 200 * i, height: 180 });
      lay(v.opened, { y: 18 + 200 * (n - 1) + 34, height: 180 });

      const taps = all(el).filter((x) => (x.getAttribute("data-test") ?? "").startsWith("rail-"));
      expect(taps.map((x) => x.getAttribute("data-test"))).toEqual([...members.map((m) => `rail-${m.id}`), `rail-p${n}`]);
      const pitch = railFit(n, room).pitch;
      expect(taps.map((x) => Number(x.__props!.style.height)), "each square is drawn at the fit's pitch").toEqual(taps.map(() => pitch));
      // Later siblings first; the first rect grown by its slop that holds the point wins.
      const hit = (y: number): number => {
        for (let i = taps.length - 1; i >= 0; i--) {
          const s = slopOf(taps[i]!.__props!);
          if (y >= RAIL_TOP + i * pitch - s.top && y < RAIL_TOP + (i + 1) * pitch + s.bottom) return i;
        }
        return -1;
      };
      const wrong: string[] = [];
      for (let i = 0; i < n; i++) {
        for (const at of [0.25, 0.5, 0.75]) {
          const got = hit(RAIL_TOP + i * pitch + at * pitch);
          if (got !== i) wrong.push(`square ${i} at ${at}: ${got}`);
        }
      }
      expect(wrong, "a press on a square's face reaches another square").toEqual([]);

      const topOf = (i: number): number => (i < n - 1 ? 18 + 200 * i : 18 + 200 * (n - 1) + 34);
      for (const i of new Set([0, Math.floor(n / 2), n - 1])) {
        act(() => { taps[i]!.__props!.onPress(); });
        expect(native.asked.at(-1), `square ${i} brings its message to the top`).toBe(Math.max(0, topOf(i) - 8));
      }
    });
  }
});

describe("a reader another screen covers reads nothing", () => {
  /** A conversation of two, on screen and read; then a reply arrives and lays out in view. */
  const arrive = (focused: boolean): HTMLElement => {
    world.mail = mailOf("p2", [memberOf("p1", "Ada")]);
    const el = mountReader("p2");
    const v = views(el);
    native.content = 18 + 118 + 34 + 180 + 34 + 118 + 100;
    lay(v.scroll, { y: 0, height: 640 });
    lay(v.padded, { y: 0, height: 500 });
    lay(v.above, { y: 18, height: 118 });
    const p1 = v.member("p1");
    lay(p1.panel, { y: 0, height: 118 });
    lay(p1.header, { y: 18, height: 22 });
    lay(p1.body, { y: 50, height: 0 });
    lay(p1.end, { y: 100, height: 0 });
    lay(v.opened, { y: 18 + 118 + 34, height: 180 });
    lay(v.from, { y: 0, height: 20 });
    lay(v.obody, { y: 120, height: 0 });
    lay(v.oend, { y: 180, height: 0 });
    act(() => { native.props!.onContentSizeChange?.(360, native.content); });
    flushNative();
    pass(3000);
    flushNative();
    expect(world.glanced.flat(), "what is on screen reads").toEqual(expect.arrayContaining(["p1", "p2"]));
    nav.focused = focused;
    world.mail = mailOf("p2", [memberOf("p1", "Ada"), { ...memberOf("p3", "Cleo"), later: true }]);
    act(() => root!.render(h(MessageReader, { id: "p2" })));
    lay(views(el).below, { y: 18 + 118 + 34 + 180 + 34, height: 118 });
    const p3 = views(el).member("p3");
    lay(p3.panel, { y: 0, height: 118 });
    lay(p3.header, { y: 18, height: 22 });
    lay(p3.body, { y: 50, height: 0 });
    lay(p3.end, { y: 100, height: 0 });
    return el;
  };

  it("a reply laid out while another screen stands over the reader stays unread; shown again, it reads after one dwell", () => {
    arrive(false);
    pass(3000);
    flushNative();
    expect(world.glanced.flat(), "a reply laid out under another screen was read, never seen").not.toContain("p3");
    nav.focused = true;
    act(() => root!.render(h(MessageReader, { id: "p2" })));
    pass(1000);
    flushNative();
    expect(world.glanced.flat(), "shown again, its top on screen for the dwell").toContain("p3");
  });

  it("control: the same reply with the reader in front reads after one dwell", () => {
    arrive(true);
    pass(1000);
    flushNative();
    expect(world.glanced.flat()).toContain("p3");
  });
});

/**
 * A CONVERSATION OPENS ON ITS NEWEST, EVERY TIME (the c3 design; the four-message reopen case):
 * four members, the second and third taller than the screen, all unread. The first open lands at the
 * bottom end and reads the newest only. A reopen (the person left, or opened another conversation,
 * or pressed the row again inside the handoff grace) is a fresh open: it lands at the bottom end
 * again and reads nothing it never showed. The remembered offset outlived the visit, so the open
 * anchor stood down and the read rule looked from offset 0: it read q1 and q2, never shown.
 * A posture remount inside the visit still resumes its place.
 */
describe("a conversation opens on its newest, every time", () => {
  const tall = (id: string) => ({ ...memberOf(id, "Mara"), later: false });
  const a20 = (id: string) =>
    ({ ...mailOf(id, [tall("q1"), tall("q2"), tall("q3")]), from: { name: "Mara", address: "mara@fake.test" } });
  const CONTENT = 18 + 4142 + 34 + 180 + 100;
  const BOTTOM = CONTENT - 640;
  const layReopen = (el: HTMLElement) => {
    const v = views(el);
    native.content = CONTENT;
    lay(v.scroll, { y: 0, height: 640 });
    lay(v.padded, { y: 0, height: 4474 });
    lay(v.above, { y: 18, height: 4142 });
    for (const [mid, y, height] of [["q1", 0, 118], ["q2", 130, 2000], ["q3", 2142, 2000]] as const) {
      const p = v.member(mid);
      lay(p.panel, { y, height });
      lay(p.header, { y: 18, height: 22 });
      lay(p.body, { y: 50, height: 0 });
      lay(p.end, { y: height - 18, height: 0 });
    }
    lay(v.opened, { y: 18 + 4142 + 34, height: 180 });
    lay(v.from, { y: 0, height: 20 });
    lay(v.obody, { y: 120, height: 0 });
    lay(v.oend, { y: 180, height: 0 });
    act(() => { native.props!.onContentSizeChange?.(360, native.content); });
    flushNative();
  };
  const open = (id: string): HTMLElement => {
    native.offset = 0; native.content = 0; native.events = []; native.asked = [];
    world.glanced = [];
    const el = mountReader(id);
    layReopen(el);
    pass(3000);
    flushNative();
    return el;
  };
  const leave = (): void => {
    act(() => root?.unmount());
    host?.remove();
    root = null;
  };
  const firstOpen = (id: string): void => {
    world.mail = a20(id);
    open(id);
    expect(native.offset, "the first open: the bottom end").toBe(BOTTOM);
    expect(world.glanced.flat(), "the first open reads the newest only").toEqual([id]);
    leave();
    world.mail = { ...world.mail, unread: false };
  };

  it("reopened after the person left: the bottom end, nothing read", () => {
    firstOpen("a4");
    pass(VISIT_HANDOFF_MS + 500);
    open("a4");
    expect(world.glanced.flat(), "the reopen read what it never showed").toEqual([]);
    expect(native.offset, "the reopen: the bottom end").toBe(BOTTOM);
  });

  it("reopened after another conversation: the bottom end, nothing read", () => {
    firstOpen("b4");
    const back = world.mail;
    world.mail = { ...mailOf("o1", []), earlier: [] };
    mountReader("o1");
    pass(500);
    leave();
    world.mail = back;
    open("b4");
    expect(world.glanced.flat(), "the reopen read what it never showed").toEqual([]);
    expect(native.offset, "the reopen: the bottom end").toBe(BOTTOM);
  });

  it("a row press inside the handoff grace opens afresh: the bottom end, nothing read", () => {
    firstOpen("c4");
    pass(500);
    endIdleVisit("c4"); // what the row press (list-detail openRow) does first
    open("c4");
    expect(world.glanced.flat(), "the reopen read what it never showed").toEqual([]);
    expect(native.offset, "the reopen: the bottom end").toBe(BOTTOM);
  });

  it("control: a posture remount inside the visit resumes its place", () => {
    world.mail = a20("d4");
    open("d4");
    act(() => { native.props!.onScroll?.({ nativeEvent: { contentOffset: { x: 0, y: 3000 } } }); });
    leave();
    pass(500);
    mountReader("d4");
    expect(native.props!.contentOffset, "the remount starts where the person stood").toEqual({ x: 0, y: 3000 });
  });
});
