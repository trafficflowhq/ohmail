/** @vitest-environment jsdom */
/**
 * THE LIST ROW FOLLOWS THE READER (o9), rendered: the Ohbox screen over its real rows, under React
 * DOM with React Native's primitives drawn as divs that keep their props. The conversation the
 * reader showed last carries its squares under the row (the strip), ringed where the person stopped;
 * a press on one opens the row and leaves that member for the reader to land on; another
 * conversation opening moves the strip there. The strip rides the row's swipe surface, but a drag
 * that starts on it scrolls the strip and never swipes the row.
 */
import { createElement as h, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const pan = vi.hoisted(() => ({ configs: [] as Record<string, any>[] }));

vi.mock("react-native", async () => {
  const React = await import("react");
  const keep = (props: any) => (el: any) => { if (el) el.__props = props; };
  const host = (name: string) => (props: any) =>
    React.createElement("div", { "data-rn": name, "data-test": props.testID, ref: keep(props) }, props.children);
  return {
    View: host("View"),
    Text: host("Text"),
    ScrollView: host("ScrollView"),
    Pressable: host("Pressable"),
    Animated: {
      View: host("Animated"),
      Value: class { setValue() {} },
      ValueXY: class { x = { interpolate: () => 0 }; setValue() {} },
      spring: () => ({ start: () => undefined }),
      timing: () => ({ start: () => undefined }),
    },
    Easing: { bezier: () => (x: number) => x },
    PanResponder: {
      create: (cfg: Record<string, any>) => { pan.configs.push(cfg); return { panHandlers: { "data-pan": pan.configs.length - 1 } }; },
    },
    AppState: { addEventListener: () => ({ remove: () => undefined }), currentState: "active" },
    Platform: { OS: "android", select: (o: any) => o.android ?? o.default },
    StyleSheet: { absoluteFill: {}, create: (s: any) => s, hairlineWidth: 1 },
  };
});

vi.mock("../src/ui/base", async () => {
  const React = await import("react");
  const keep = (props: any) => (el: any) => { if (el) el.__props = props; };
  const box = (name: string) => (p: any) =>
    React.createElement("div", { "data-rn": name, "data-test": p.testID, ref: keep(p) }, p.children);
  return {
    Badge: () => null, TagChip: () => null, Button: () => null, Empty: () => null, Tail: () => null,
    Panel: box("Panel"), Screen: box("Screen"), Tap: box("Tap"), TapRow: box("TapRow"),
    Txt: (p: any) => React.createElement("span", null, p.children),
  };
});
vi.mock("../src/theme", () => ({
  useTheme: () => ({
    c: new Proxy({}, { get: () => "#000" }),
    radius: new Proxy({}, { get: () => 8 }),
    reduceMotion: true,
  }),
}));
vi.mock("expo-router", () => ({
  useFocusEffect: () => undefined,
  useIsFocused: () => true,
  useNavigation: () => ({ getState: () => ({ index: 0, routes: [{ name: "index" }] }), addListener: () => () => undefined }),
}));

const lists = vi.hoisted(() => ({ fresh: [] as any[], opened: [] as string[], messages: {} as Record<string, any> }));
vi.mock("../src/state/world", () => ({
  useEngineQueuesAsk: () => () => undefined,
  useWorld: () => ({
    ohbox: { resurfaced: [], fresh: lists.fresh, seen: [], total: lists.fresh.length, meta: "", unreadIds: [], unscreened: null, filed: null },
    doorbell: { initials: [], count: 0 },
    boot: { settled: true, syncFailure: false, firstSync: null },
    standalone: false,
    mailboxes: { known: false, rows: [] },
    rowOpenTarget: (id: string) => `${id}-target`,
    message: (id: string) => lists.messages[id],
    actions: { markOhboxVisit: () => undefined, markAllSeen: () => undefined, screenUnscreened: async () => true },
  }),
}));
vi.mock("../src/state/live", () => ({
  ohboxVisitStep: (v: unknown) => ({ next: v, leave: false }),
  moveTargetsFor: () => [],
  moveTargetLabel: () => "",
}));
vi.mock("../src/ui/list-detail", () => ({
  ListDetail: (p: { list: ReactNode }) => p.list,
  useListDetail: () => ({ open: null, openRow: (id: string) => { lists.opened.push(id); }, close: () => undefined }),
}));
vi.mock("../src/ui/MailList", async () => {
  const React = await import("react");
  return {
    MailList: (p: any) => React.createElement("div", null, ...p.groups.flatMap((g: any) =>
      g.rows.map((r: any) => React.createElement("div", { key: r.id, "data-row": r.id }, p.renderRow(r))))),
  };
});
vi.mock("../src/engine/organizer-session", () => ({
  onOrganizerState: () => () => undefined, organizerStateVersion: () => 0, readingAtConnectSaid: () => null, sayReadingAtConnect: () => undefined,
}));
vi.mock("../src/state/pull", () => ({ usePullToSync: () => undefined }));
vi.mock("../src/ui/OhboxWhere", () => ({ OhboxWhere: () => null }));
vi.mock("../src/ui/chrome", () => ({ Doorbell: () => null, StateKnock: () => null, TopBar: () => null }));
vi.mock("../src/ui/MarkAllRead", () => ({ MarkAllRead: () => null, VIEW_HEAD_ROW: {} }));
vi.mock("../src/ui/MessageReader", () => ({ MessageReader: () => null }));
vi.mock("../src/ui/OrganizerStrip", () => ({ OrganizerStrip: () => null, useStandaloneClaim: () => ({ claim: null, strip: null }) }));
vi.mock("../src/ui/not-organizing", () => ({ knockSlotOf: () => ({ k: "none" }), noneOrganizedWhy: () => null, notOrganizingSay: () => "" }));
vi.mock("../src/ui/WaitingStrip", () => ({ WaitingStrip: () => null }));
vi.mock("../src/ui/Skeleton", () => ({ SkeletonList: () => null }));
vi.mock("../src/ui/standalone-form", () => ({ readingAtConnectLine: () => "", readingAtConnectNow: () => null }));
vi.mock("../src/i18n/LocaleProvider", () => ({ useLocale: () => "en" }));
vi.mock("../src/ui/ErrorBoundary", () => ({ SurfaceBoundary: (p: { children: ReactNode }) => p.children }));
vi.mock("../src/ui/Icon", () => ({ Icon: () => null }));

const { mount } = await import("./_rendered-dom");
const { act } = await import("react");
const { default: OhboxScreen } = await import("../app/(tabs)/index");
const place = await import("../src/state/thread-place");

type El = HTMLElement & { __props?: Record<string, any> };
const rowOf = (mail: { id: string; memberIds?: string[]; marks?: ("unread" | "read" | "mine")[] }) => ({
  from: { name: "Ada", address: "ada@fake.test" }, subject: "Q3 plan", time: "10:00", snippet: "the plan", unread: false,
  earlier: [], ...mail,
});
const A = rowOf({ id: "a3", rowKey: "a", memberIds: ["a1", "a2", "a3"], marks: ["read", "mine", "read"] } as never);
const B = rowOf({ id: "b2", rowKey: "b", memberIds: ["b1", "b2"], marks: ["read", "read"] } as never);
const itemsA = [{ id: "a1", kind: "read", sender: "Ada" }, { id: "a2", kind: "mine", sender: "" }, { id: "a3", kind: "read", sender: "Ada" }] as const;
const itemsB = [{ id: "b1", kind: "read", sender: "Ben" }, { id: "b2", kind: "read", sender: "Ben" }] as const;

let screen: ReturnType<typeof mount> | null = null;
beforeEach(() => {
  place.resetThreadPlaceForTests();
  pan.configs = [];
  lists.fresh = [A, B];
  lists.opened = [];
  lists.messages = {};
});
afterEach(() => { screen?.unmount(); screen = null; });

const rowEl = (id: string): El => screen!.el.querySelector<El>(`[data-row="${id}"]`)!;
const squares = (id: string): El[] => [...rowEl(id).querySelectorAll<El>("[data-test^='strip-']")];
const ringed = (id: string): string[] =>
  squares(id).filter((s) => s.__props?.accessibilityState?.selected === true).map((s) => s.getAttribute("data-test")!.slice(6));
const marksShown = (id: string): boolean => rowEl(id).querySelector("[data-test='row-marks']") !== null;

describe("the open conversation's row carries the reader's squares", () => {
  it("back from the reader, the row shows the strip ringed where the person stopped; the others keep their marks", () => {
    place.publishThreadPlace([...itemsA], "a2");
    screen = mount(h(OhboxScreen));
    expect(squares("a3").map((s) => s.getAttribute("data-test"))).toEqual(["strip-a1", "strip-a2", "strip-a3"]);
    expect(ringed("a3")).toEqual(["a2"]);
    expect(squares("a3")[1]!.__props?.accessibilityLabel, "each square says what the rail's says").toMatch(/2 of 3/);
    expect(marksShown("a3"), "the row's small marks give way to the strip").toBe(false);
    expect(squares("b2")).toEqual([]);
    expect(marksShown("b2")).toBe(true);
  });

  it("the ring follows the reader while it moves on", () => {
    place.publishThreadPlace([...itemsA], "a1");
    screen = mount(h(OhboxScreen));
    act(() => place.publishThreadPlace([...itemsA], "a3"));
    expect(ringed("a3")).toEqual(["a3"]);
  });

  it("a press with no reader mounted opens the row's own target and leaves the pressed member for it to land on", () => {
    place.publishThreadPlace([...itemsA], "a3");
    screen = mount(h(OhboxScreen));
    act(() => { squares("a3")[0]!.__props!.onPress(); });
    expect(lists.opened).toEqual(["a3-target"]);
    expect(place.threadPending()).toBe("a1");
  });

  it("a press with the reader mounted beside the list jumps it and opens nothing", () => {
    place.publishThreadPlace([...itemsA], "a3");
    const jumped: string[] = [];
    place.bindThreadJump((id) => { jumped.push(id); });
    screen = mount(h(OhboxScreen));
    act(() => { squares("a3")[1]!.__props!.onPress(); });
    expect(jumped).toEqual(["a2"]);
    expect(lists.opened).toEqual([]);
  });

  it("another conversation opened: the strip moves to its row", () => {
    place.publishThreadPlace([...itemsA], "a3");
    screen = mount(h(OhboxScreen));
    act(() => place.publishThreadPlace([...itemsB], "b1"));
    expect(squares("a3")).toEqual([]);
    expect(marksShown("a3")).toBe(true);
    expect(ringed("b2")).toEqual(["b1"]);
  });
});

/** The world's reading row for `id`: the conversation as it stands, the reader rail's own source. */
type Member = { id: string; kind: "unread" | "read" | "mine" };
const conversation = (opened: string, members: readonly Member[]) => {
  const at = members.findIndex((x) => x.id === opened);
  const me = members[at]!;
  return {
    id: opened, unread: me.kind === "unread", ownMail: me.kind === "mine", from: { name: "Ada" },
    earlier: members.filter((x) => x.id !== opened).map((x) => ({
      id: x.id, seen: x.kind !== "unread", ...(x.kind === "mine" ? { mine: true } : {}),
      ...(members.indexOf(x) > at ? { later: true } : {}), sender: x.kind === "mine" ? "" : "Ada",
    })),
  };
};
/** What each strip square says it is, as the rail and the row's marks name it. */
const stripKinds = (id: string): string[] => squares(id).map((s) => {
  const said = String(s.__props?.accessibilityLabel ?? "");
  return /sent by you/.test(said) ? "mine" : /, unread$/.test(said) ? "unread" : "read";
});

describe("closed, the strip draws the conversation as it stands, not the reader's last picture", () => {
  const A1to3: Member[] = [{ id: "a1", kind: "read" }, { id: "a2", kind: "mine" }, { id: "a3", kind: "read" }];
  /** The reader showed a1..a3 and went (Back): no reader is mounted, the place stays. */
  const backFromTheReader = (): void => {
    lists.messages = { a3: conversation("a3", A1to3) };
    place.publishThreadPlace([...itemsA], "a2");
    screen = mount(h(OhboxScreen));
  };

  it("a reply that arrives while the reader is closed gains its square, unread", () => {
    backFromTheReader();
    expect(stripKinds("a3")).toEqual(["read", "mine", "read"]);
    const members: Member[] = [...A1to3, { id: "a4", kind: "unread" }];
    lists.messages = { a4: conversation("a4", members) };
    lists.fresh = [rowOf({ id: "a4", rowKey: "a", memberIds: ["a1", "a2", "a3", "a4"], marks: ["read", "mine", "read", "unread"], unread: true } as never), B];
    screen!.render(h(OhboxScreen));
    expect(squares("a4").map((s) => s.getAttribute("data-test"))).toEqual(["strip-a1", "strip-a2", "strip-a3", "strip-a4"]);
    expect(stripKinds("a4")).toEqual(["read", "mine", "read", "unread"]);
    expect(ringed("a4"), "the ring stays where the person stopped").toEqual(["a2"]);
  });

  it("a Mark unread while the reader is closed turns the square unread", () => {
    backFromTheReader();
    const members: Member[] = [{ id: "a1", kind: "unread" }, A1to3[1]!, A1to3[2]!];
    lists.messages = { a3: conversation("a3", members) };
    lists.fresh = [rowOf({ id: "a3", rowKey: "a", memberIds: ["a1", "a2", "a3"], marks: ["unread", "mine", "read"], unread: true } as never), B];
    screen!.render(h(OhboxScreen));
    expect(stripKinds("a3")).toEqual(["unread", "mine", "read"]);
  });

  it("the strip's squares are the row's live marks", () => {
    backFromTheReader();
    const members: Member[] = [{ id: "a1", kind: "unread" }, A1to3[1]!, A1to3[2]!, { id: "a4", kind: "unread" }];
    const row = rowOf({ id: "a4", rowKey: "a", memberIds: ["a1", "a2", "a3", "a4"], marks: ["unread", "mine", "read", "unread"], unread: true } as never) as { marks: string[] };
    lists.messages = { a4: conversation("a4", members) };
    lists.fresh = [row, B];
    screen!.render(h(OhboxScreen));
    expect(stripKinds("a4")).toEqual(row.marks);
  });

  it("a ringed message gone from the conversation rings nothing, and the strip never names it", () => {
    backFromTheReader();
    const members: Member[] = [A1to3[0]!, A1to3[2]!];
    lists.messages = { a3: conversation("a3", members) };
    lists.fresh = [rowOf({ id: "a3", rowKey: "a", memberIds: ["a1", "a3"], marks: ["read", "read"] } as never), B];
    screen!.render(h(OhboxScreen));
    expect(squares("a3").map((s) => s.getAttribute("data-test"))).toEqual(["strip-a1", "strip-a3"]);
    expect(ringed("a3")).toEqual([]);
  });
});

describe("a drag that starts on the strip scrolls the strip, never swipes the row", () => {
  const surfaceOf = (id: string): El =>
    [...rowEl(id).querySelectorAll<El>("[data-rn='Animated']")].find((e) => e.__props?.["data-pan"] !== undefined)!;
  const cfgOf = (id: string): Record<string, any> => pan.configs[Number(surfaceOf(id).__props!["data-pan"])]!;
  const claims = (id: string): boolean => cfgOf(id).onMoveShouldSetPanResponder({}, { dx: 80, dy: 0 }) as boolean;
  /** A touch down: the responder's capture pass from the root first, then the touch-start handlers from the target up. */
  const touchDown = (id: string, target: El): void => {
    expect(cfgOf(id).onStartShouldSetPanResponderCapture?.({}, {}) ?? false, "the row never takes the touch down").toBe(false);
    const surface = surfaceOf(id);
    for (let at: El | null = target; at && at !== surface; at = at.parentElement as El | null) at.__props?.onTouchStart?.({});
  };
  it("on the strip the row lets the drag go; on the row's text it swipes", () => {
    place.publishThreadPlace([...itemsA], "a3");
    screen = mount(h(OhboxScreen));
    touchDown("a3", rowEl("a3").querySelector<El>("[data-test='strip-a2']")!);
    expect(claims("a3"), "a drag that started on the strip swiped the row").toBe(false);
    touchDown("a3", rowEl("a3").querySelector<El>("[data-rn='TapRow']")!);
    expect(claims("a3"), "the control: a drag on the row swipes it").toBe(true);
  });
});
