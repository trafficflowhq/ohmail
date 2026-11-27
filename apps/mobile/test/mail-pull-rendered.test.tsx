/** @vitest-environment jsdom */
import { act, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount } from "./_rendered-dom";
import { pullMove, pullStart, type PullTrack } from "@ohmail/app-logic/touch";

const rig = vi.hoisted(() => ({
  scrollEnabled: vi.fn(),
  scrollY: 0,
  nativeEvent: vi.fn(),
  scrollTo: vi.fn(),
  animate: vi.fn(),
  loop: vi.fn(),
  reduceMotion: false,
  platform: "android" as "android" | "ios",
}));

vi.mock("react-native", async () => {
  const React = await import("react");
  const { rnDom } = await import("./_rendered-dom");
  const host = (kind: string) => (props: Record<string, any>) => (
    <div data-kind={kind} ref={(el) => { if (el) Object.assign(el, { nativeProps: props }); }}>
      {props.children}
    </div>
  );
  const ScrollHost = host("ScrollView");
  class ScrollView extends React.Component<Record<string, any>> {
    setNativeProps = rig.scrollEnabled;
    scrollTo = rig.scrollTo;
    render() {
      return <ScrollHost {...this.props} onScroll={(e: { nativeEvent: { contentOffset: { y: number } } }) => {
        rig.scrollY = e.nativeEvent.contentOffset.y;
        this.props.onScroll?.(e);
      }} />;
    }
  }
  function SectionList(p: Record<string, any>) {
    return React.cloneElement(p.renderScrollComponent({
      onScroll: p.onScroll,
      scrollEventThrottle: p.scrollEventThrottle,
      maintainVisibleContentPosition: p.maintainVisibleContentPosition,
      contentContainerStyle: p.contentContainerStyle,
    }), {}, p.ListHeaderComponent,
    p.sections.flatMap(({ data }: { data: unknown[] }) => data.map((item) =>
      <React.Fragment key={p.keyExtractor(item)}>{p.renderItem({ item })}</React.Fragment>)),
    p.ListEmptyComponent, p.ListFooterComponent);
  }
  class Value {
    constructor(public value: number) {}
    setValue(value: number) { this.value = value; }
    stopAnimation() {}
    interpolate() { return this; }
  }
  function timing(value: Value, config: { toValue: number; useNativeDriver: boolean }) {
    rig.animate(config);
    return { start: () => value.setValue(config.toValue), stop: () => undefined };
  }
  return {
    ...rnDom, View: host("View"), ScrollView, SectionList, RefreshControl: host("RefreshControl"),
    Platform: { ...rnDom.Platform, get OS() { return rig.platform; } },
    Easing: { bezier: () => (n: number) => n, linear: (n: number) => n },
    Animated: {
      View: host("AnimatedView"), Value, timing,
      event: ([mapping]: [{ nativeEvent: { offset: Value } }], config: { useNativeDriver: boolean }) => {
        rig.nativeEvent(config);
        return (e: { nativeEvent: { offset: number } }) => mapping.nativeEvent.offset.setValue(e.nativeEvent.offset);
      },
      subtract: (a: Value, b: Value) => ({ get value() { return a.value - b.value; } }),
      loop: () => ({ start: rig.loop, stop: () => undefined }),
    },
  };
});
vi.mock("../src/ui/android-pull-native", () => {
  function NativeSurface(props: Record<string, any>) {
    return <div data-kind="AndroidPullView" ref={(node) => { if (node) Object.assign(node, { nativeProps: props }); }}>
      {props.children}
    </div>;
  }
  return { androidPullSurface: () => NativeSurface };
});
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock("../src/ui/posture", async () => ({
  ...(await import("../src/ui/posture/derive")),
  usePosture: () => ({ fold: "none", hinge: null, split: "full", panes: 1, sizeClass: "compact", heightClass: "regular" }),
  useAppWindow: () => ({ width: 390, height: 844 }),
}));
vi.mock("../src/ui/keyboard-room", () => ({ KeyboardRoom: ({ children }: { children: ReactNode }) => children }));
vi.mock("../src/ui/Icon", () => ({ Icon: () => null }));
vi.mock("../src/theme", async () => {
  const { space, radius } = await import("../src/theme/tokens");
  return {
    useTheme: () => ({
      mail: true, scheme: "light", reduceMotion: rig.reduceMotion, space, radius,
      c: { canvas: "white", accent: "red", ink3: "gray" },
    }),
  };
});

const { Scroller } = await import("../src/ui/base");
const { MailList } = await import("../src/ui/MailList");

type Host = HTMLElement & { nativeProps: Record<string, any> };
const hostProps = (el: Element | null) => (el as Host | null)?.nativeProps;
const touch = (x: number, y: number, count: number) => {
  const point = { identifier: 1, pageX: x, pageY: y };
  return { nativeEvent: { ...point, touches: Array.from({ length: count }, () => point), changedTouches: [point] } };
};

function nativeGesture(surface: Element) {
  let track: PullTrack | null = null;
  const props = () => hostProps(surface)!;
  const sample = (x: number, y: number) => {
    const wasClaimed = track?.claimed;
    track = pullMove(track, x, y, rig.scrollY <= 1);
    if (!track?.claimed) return false;
    act(() => {
      if (!wasClaimed) props().onPullClaim();
      props().onPullMotion({ nativeEvent: { offset: Math.max(track!.offset, props().hold) } });
    });
    return true;
  };
  const finish = (cancelled: boolean, y: number) => {
    const released = track;
    track = null;
    if (released?.claimed) act(() => props().onPullFinish({ nativeEvent: { cancelled, distance: y - released.y } }));
  };
  return {
    start: (x = 100, y = 100, count = 1) => {
      track = pullStart(x, y, props().enabled && count === 1 && rig.scrollY <= 1);
    },
    claim: sample,
    move: sample,
    end: (_x: number, y: number) => finish(false, y),
    cancel: () => finish(true, 0),
    tapEnd: () => { track = null; },
  };
}

function gesture(root: Element) {
  const native = root.querySelector('[data-kind="AndroidPullView"]');
  if (native) return nativeGesture(native);
  const surface = [...root.querySelectorAll("[data-kind]")].find((el) => hostProps(el)?.onMoveShouldSetResponderCapture);
  expect(surface, "a real refreshing scroll view captures an eligible pull").toBeDefined();
  const p = hostProps(surface ?? null)!;
  return {
    start: (x = 100, y = 100, count = 1) => act(() => p.onTouchStart(touch(x, y, count))),
    claim: (x: number, y: number) => {
      let accepted: boolean | undefined;
      act(() => {
        const event = touch(x, y, 1);
        accepted = p.onMoveShouldSetResponderCapture(event);
        if (accepted) p.onResponderGrant(event);
      });
      return accepted;
    },
    move: (x: number, y: number) => act(() => p.onResponderMove(touch(x, y, 1))),
    end: (x: number, y: number) => act(() => p.onResponderRelease(touch(x, y, 0))),
    cancel: () => act(() => p.onResponderTerminate(touch(100, 300, 0))),
    tapEnd: () => act(() => p.onTouchEnd(touch(100, 100, 0))),
  };
}

const scroller = (root: Element) => hostProps(root.querySelector('[data-kind="ScrollView"]'))!;
const offset = (root: Element) => {
  const list = root.querySelector('[data-kind="ScrollView"]');
  const styles = hostProps(list?.parentElement ?? null)?.style;
  const transform = (Array.isArray(styles) ? styles : [styles]).find((style) => style?.transform)?.transform;
  return transform?.[0].translateY.value;
};
const scrollReport = (y: number) => ({ nativeEvent: { contentOffset: { y }, contentInset: { top: 0 } } });
function mark(root: Element) {
  return [...root.querySelectorAll('[data-kind="AnimatedView"]')]
    .find((el) => hostProps(el)?.accessibilityElementsHidden === true);
}

let view: ReturnType<typeof mount> | undefined;
afterEach(() => {
  view?.unmount();
  rig.reduceMotion = false;
  rig.scrollY = 0;
  rig.platform = "android";
  vi.clearAllMocks();
});

describe("pulling on native mail lists", () => {
  it("moves a flow list under the finger, pulls once at release, and holds while the mail check runs", async () => {
    let finish!: () => void;
    const onRefresh = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    view = mount(<Scroller refresh={{ refreshing: false, onRefresh }}><span>Mail</span></Scroller>);
    const { el } = view;
    const pull = gesture(el);
    expect(scroller(el).refreshControl).toBeUndefined();
    pull.start();
    expect(pull.claim(100, 135)).toBe(true);
    expect(offset(el)).toBeGreaterThan(0);
    expect(hostProps(mark(el)?.firstElementChild ?? null)?.style.borderColor).toBe("red");
    pull.move(100, 250);
    expect(offset(el)).toBeGreaterThan(64);
    expect(onRefresh).not.toHaveBeenCalled();
    pull.end(100, 250);
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(offset(el)).toBe(48);
    expect(rig.loop).toHaveBeenCalledTimes(1);
    expect(mark(el)?.firstElementChild?.children).toHaveLength(3);
    expect(hostProps(mark(el)?.firstElementChild?.lastElementChild ?? null)?.style.backgroundColor).toBe("red");
    pull.start();
    expect(pull.claim(100, 270)).toBe(true);
    expect(offset(el)).toBeGreaterThan(48);
    pull.end(100, 270);
    expect(offset(el)).toBe(48);
    expect(onRefresh).toHaveBeenCalledTimes(1);
    await act(async () => { finish(); });
    expect(offset(el)).toBe(0);
    expect(rig.animate).toHaveBeenLastCalledWith(expect.objectContaining({ toValue: 0, useNativeDriver: true }));
  });

  it("keeps native Android scroll enabled on the original touch down", () => {
    view = mount(<Scroller refresh={{ refreshing: false, onRefresh: vi.fn() }}><span>Mail</span></Scroller>);
    const pull = gesture(view.el);
    pull.start();
    expect(rig.scrollEnabled).not.toHaveBeenCalled();
    expect(scroller(view.el).scrollEnabled).toBe(true);
    pull.tapEnd();
  });

  it("connects Expo drag offsets to native animation while JS checks exactly one armed release", async () => {
    let finish!: () => void;
    const onRefresh = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    view = mount(<Scroller refresh={{ refreshing: false, onRefresh }}><span>Mail</span></Scroller>);
    const { el } = view;
    const surface = el.querySelector('[data-kind="AndroidPullView"]');
    expect(surface).not.toBeNull();
    const touchProps = () => hostProps(surface)!;
    expect(rig.nativeEvent).toHaveBeenCalledOnce();
    expect(rig.nativeEvent).toHaveBeenCalledWith({ useNativeDriver: true });
    expect(touchProps()).toEqual(expect.objectContaining({ slop: 12, rate: 0.55, maximum: 120, hold: 0 }));
    act(() => {
      touchProps().onPullClaim();
      touchProps().onPullMotion({ nativeEvent: { offset: 62.15 } });
    });
    expect(offset(el)).toBe(62.15);
    expect(onRefresh).not.toHaveBeenCalled();
    act(() => touchProps().onPullFinish({ nativeEvent: { distance: 125, cancelled: false } }));
    expect(onRefresh).not.toHaveBeenCalled();
    expect(offset(el)).toBe(0);
    act(() => {
      touchProps().onPullClaim();
      touchProps().onPullMotion({ nativeEvent: { offset: 67.65 } });
      touchProps().onPullFinish({ nativeEvent: { distance: 135, cancelled: false } });
    });
    expect(onRefresh).toHaveBeenCalledOnce();
    expect(offset(el)).toBe(48);
    expect(touchProps().hold).toBe(48);
    await act(async () => { finish(); });
    expect(touchProps().hold).toBe(0);
    expect(offset(el)).toBe(0);
  });

  it("leaves horizontal and upward gestures free and ignores a downward drag that began below top", () => {
    const onRefresh = vi.fn();
    const onScroll = vi.fn();
    view = mount(<Scroller refresh={{ refreshing: false, onRefresh }} onScroll={onScroll}><span>Mail</span></Scroller>);
    const { el } = view;
    const pull = gesture(el);
    act(() => scroller(el).onScroll(scrollReport(30)));
    pull.start();
    act(() => scroller(el).onScroll(scrollReport(0)));
    expect(pull.claim(100, 250)).toBe(false);
    expect(onScroll).toHaveBeenCalledTimes(2);
    pull.start();
    expect(pull.claim(180, 110)).toBe(false);
    pull.start();
    expect(pull.claim(100, 40)).toBe(false);
    expect(rig.scrollEnabled).not.toHaveBeenCalled();
    pull.start();
    pull.tapEnd();
    expect(rig.scrollEnabled).not.toHaveBeenCalled();
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it("joins a check already started by another control without asking for new mail again", async () => {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    const onRefresh = vi.fn();
    const refresh = { refreshing: true, pending, onRefresh };
    view = mount(<Scroller refresh={refresh}><span>Mail</span></Scroller>);
    const { el } = view;
    const pull = gesture(el);
    pull.start();
    expect(pull.claim(100, 250)).toBe(true);
    pull.end(100, 250);
    expect(onRefresh).not.toHaveBeenCalled();
    expect(offset(el)).toBe(48);
    await act(async () => { finish(); });
    expect(offset(el)).toBe(0);
  });

  it("keeps the visible row when someone scrolls on while the check runs", async () => {
    let finish!: () => void;
    const onRefresh = () => new Promise<void>((resolve) => { finish = resolve; });
    view = mount(<Scroller refresh={{ refreshing: false, onRefresh }}><span>Mail</span></Scroller>);
    const { el } = view;
    const pull = gesture(el);
    pull.start();
    expect(pull.claim(100, 250)).toBe(true);
    pull.end(100, 250);
    act(() => scroller(el).onScroll(scrollReport(100)));
    await act(async () => { finish(); });
    expect(rig.scrollTo).toHaveBeenCalledWith({ y: 52, animated: false });
    expect(offset(el)).toBe(0);
  });

  it("returns after a synchronous refusal and can recognize another pull", async () => {
    const onRefresh = vi.fn(() => { throw new Error("refused"); });
    view = mount(<Scroller refresh={{ refreshing: false, onRefresh }}><span>Mail</span></Scroller>);
    const { el } = view;
    const pull = gesture(el);
    pull.start();
    expect(pull.claim(100, 250)).toBe(true);
    pull.end(100, 250);
    await act(async () => {});
    expect(offset(el)).toBe(0);
    expect(onRefresh).toHaveBeenCalledTimes(1);
    pull.start();
    expect(pull.claim(100, 250)).toBe(true);
    pull.cancel();
  });

  it("keeps the empty virtualized list and declines retreat, cancellation and multiple fingers", async () => {
    rig.reduceMotion = true;
    const onRefresh = vi.fn();
    view = mount(<MailList<string> refresh={{ refreshing: false, onRefresh }} groups={[]} surface={false}
      rowKey={(row) => row} renderRow={() => null} head={<span>Mail</span>} empty={<span>No mail</span>} />);
    const { el } = view;
    expect(el.textContent).toContain("No mail");
    expect(scroller(el).maintainVisibleContentPosition).toBeDefined();
    const pull = gesture(el);
    pull.start();
    expect(pull.claim(100, 140)).toBe(true);
    pull.move(100, 250);
    pull.end(100, 140);
    pull.start();
    expect(pull.claim(100, 250)).toBe(true);
    pull.cancel();
    pull.start(100, 100, 2);
    expect(pull.claim(100, 250)).toBe(false);
    expect(onRefresh).not.toHaveBeenCalled();
    expect(offset(el)).toBe(0);
    pull.start();
    expect(pull.claim(100, 250)).toBe(true);
    pull.end(100, 250);
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(rig.loop).not.toHaveBeenCalled();
    expect(rig.animate).not.toHaveBeenCalled();
    await act(async () => {});
    expect(offset(el)).toBe(0);
  });

  it("keeps ordinary non-mail scrolling free of a pull recognizer", () => {
    view = mount(<Scroller><span>Settings</span></Scroller>);
    expect(view.el.querySelector('[data-kind="AndroidPullView"]')).toBeNull();
    expect([...view.el.querySelectorAll("[data-kind]")].some((el) => hostProps(el)?.onMoveShouldSetResponderCapture)).toBe(false);
  });

  it("opens the gap after the fixed place heading, and moves the tools and rows together", () => {
    const sheet = { sheetHead: <span data-part="tools">Filter the sheet</span> };
    const refresh = { refreshing: false, onRefresh: vi.fn() };
    view = mount(<MailList<string> {...sheet} refresh={refresh} groups={[{ key: "letters", rows: ["Review"] }]}
      rowKey={(row) => row} renderRow={(row) => <span data-part="row">{row}</span>}
      head={<span data-part="heading">Letters</span>} />);
    const { el } = view;
    const heading = el.querySelector('[data-part="heading"]')!;
    const list = el.querySelector('[data-kind="ScrollView"]')!;
    const pullHost = el.querySelector('[data-kind="AndroidPullView"]');
    expect(pullHost).not.toBeNull();
    expect(pullHost?.contains(heading)).toBe(false);
    expect(pullHost?.contains(list)).toBe(true);
    expect(list.contains(heading)).toBe(false);
    expect(list.querySelector('[data-part="tools"]')?.textContent).toBe("Filter the sheet");
    expect(list.querySelector('[data-part="row"]')?.textContent).toBe("Review");
    const pull = gesture(el);
    pull.start();
    expect(pull.claim(100, 170)).toBe(true);
    expect(offset(el)).toBeGreaterThan(0);
    expect(heading.compareDocumentPosition(mark(el)!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(mark(el)?.compareDocumentPosition(list)! & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(el.querySelector('[data-part="heading"]')).toBe(heading);
    pull.cancel();
  });

  it("allows a short phone sheet to end after its own content and still refresh", async () => {
    const onRefresh = vi.fn();
    const props = {
      refresh: { refreshing: false, onRefresh },
      groups: [{ key: "letters", rows: ["Review"] }],
      rowKey: (row: string) => row,
      renderRow: (row: string) => <span>{row}</span>,
      head: <span>Letters</span>,
    };
    view = mount(<MailList {...props} />);
    const before = scroller(view.el).contentContainerStyle;
    expect(before.minHeight).toBe("100%");
    view.render(<MailList {...props} fitSurface />);
    const fitted = scroller(view.el).contentContainerStyle;
    expect(fitted.minHeight).toBeUndefined();
    expect(fitted.paddingLeft).toBe(before.paddingLeft);
    expect(fitted.paddingRight).toBe(before.paddingRight);
    expect(fitted.paddingBottom).toBe(before.paddingBottom);
    const pull = gesture(view.el);
    pull.start();
    expect(pull.claim(100, 250)).toBe(true);
    pull.end(100, 250);
    expect(onRefresh).toHaveBeenCalledOnce();
    await act(async () => {});
  });

  it("keeps a refreshable flow heading above the whole moving panel", () => {
    const paper = { head: <span data-part="heading">Drafts</span> };
    view = mount(<Scroller {...paper} bounded refresh={{ refreshing: false, onRefresh: vi.fn() }}>
      <span data-part="panel">Half-written letter</span>
    </Scroller>);
    const { el } = view;
    const heading = el.querySelector('[data-part="heading"]');
    const list = el.querySelector('[data-kind="ScrollView"]')!;
    expect(heading?.textContent).toBe("Drafts");
    expect(list.contains(heading)).toBe(false);
    expect(list.querySelector('[data-part="panel"]')?.textContent).toBe("Half-written letter");
    const pull = gesture(el);
    pull.start();
    expect(pull.claim(100, 170)).toBe(true);
    expect(offset(el)).toBeGreaterThan(0);
    expect(heading?.compareDocumentPosition(mark(el)!)! & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    pull.cancel();
  });

  it("uses iOS scrolling from its top in one swipe and cancels an interrupted pull", async () => {
    rig.platform = "ios";
    let finish!: () => void;
    const onRefresh = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const onScroll = vi.fn();
    view = mount(<Scroller refresh={{ refreshing: false, onRefresh }} onScroll={onScroll}><span>Mail</span></Scroller>);
    const { el } = view;
    const surface = [...el.querySelectorAll("[data-kind]")].find((node) => hostProps(node)?.onTouchStart);
    expect(surface).toBeDefined();
    const p = hostProps(surface ?? null)!;
    act(() => {
      p.onTouchStart(touch(100, 100, 1));
      p.onTouchMove(touch(100, 50, 1));
      scroller(el).onScroll(scrollReport(45));
      p.onTouchEnd(touch(100, 50, 0));
    });
    expect(rig.scrollEnabled).not.toHaveBeenCalled();
    expect(onScroll).toHaveBeenCalledTimes(1);
    expect(onRefresh).not.toHaveBeenCalled();
    act(() => {
      scroller(el).onScroll(scrollReport(0));
      p.onTouchStart(touch(100, 100, 1));
      scroller(el).onScroll(scrollReport(-75));
      p.onTouchMove(touch(100, 250, 1));
    });
    expect(offset(el)! + 75).toBeGreaterThan(64);
    act(() => {
      p.onTouchCancel(touch(100, 250, 0));
      scroller(el).onScroll(scrollReport(0));
    });
    expect(onRefresh).not.toHaveBeenCalled();
    expect(offset(el)).toBe(0);
    act(() => {
      p.onTouchStart(touch(100, 100, 1));
      scroller(el).onScroll(scrollReport(-75));
      p.onTouchMove(touch(100, 250, 1));
      p.onTouchEnd(touch(100, 250, 0));
      scroller(el).onScroll(scrollReport(0));
    });
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(offset(el)).toBe(48);
    await act(async () => { finish(); });
    expect(offset(el)).toBe(0);
  });
});
