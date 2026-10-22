/* @reads: apps/mobile/src/ui/MailBodyFrame.tsx apps/mobile/src/ui/MessageReader.tsx patches/react-native-webview@13.16.1.patch
   Read by a path built at runtime, so no landing pass selects this file when those sources move —
   the shape `reads-list.mjs` exists for. The native half is read as source: no device runs here. */
/**
 * THE MESSAGE FRAME IS AS TALL AS ITS DOCUMENT (`src/mail/frame-height.ts`). Measured on an AVD before
 * this: the frame was a 593 dp box with its own scroller, and no drag that started on the message ever
 * moved the reader. The height rules are pure; the wiring and the native report are read as source.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  armFrameTimer,
  FRAME_GROW_STEP_DP,
  FRAME_MAX_DP,
  FRAME_MAX_READINGS,
  FRAME_RUNAWAY_GROWS,
  FRAME_SEED_DP,
  FRAME_SETTLE_BOUND_MS,
  FRAME_SETTLE_MS,
  FRAME_UNANSWERED_MS,
  frameHeightFor,
  frameLayout,
  nextFrameHeight,
  rememberedFrameHeight,
  rememberFrameHeight,
  settleDelayMs,
  settleFrameHeight,
  unansweredFrameHeight,
  type FrameHeight,
} from "../src/mail/frame-height";
import { resolvedFrom, unpatchedIn, versionOf } from "./helpers/installed-copies";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const FRAME = read("../src/ui/MailBodyFrame.tsx");
const READER = read("../src/ui/MessageReader.tsx");
const PATCH = read("../../../patches/react-native-webview@13.16.1.patch");
const APP = fileURLToPath(new URL("..", import.meta.url));
/** Code lines only: a docblock may name what the code no longer does. */
const code = (src: string): string => src.split("\n").filter((l) => {
  const t = l.trimStart();
  return !t.startsWith("*") && !t.startsWith("//") && !t.startsWith("/*");
}).join("\n");
const W = 411;
/** Readings in order, each made at the frame's own height then, from the seed (or `from`). */
const feed = (readings: number[], from: FrameHeight | null = null, w = W): FrameHeight =>
  readings.reduce((s, r) => nextFrameHeight(s, r, frameLayout(s).frame, 0), frameHeightFor(from, "m1", w));

/**
 * The component's effects, on a fake clock: the state commits, the settle is armed from the settle key
 * exactly as `MailBodyFrame` keys it, and the unanswered bound from the load end. `blank` is the height
 * the frame and spacer occupy below the document's true end.
 */
function reader(start: FrameHeight, documentDp: number) {
  let s = start;
  let cancel = () => undefined as void;
  let key: string | null = null;
  let cancelWait = () => undefined as void;
  const settleKey = (x: FrameHeight) => (x.measured === null ? null : `${x.key}@${x.width}:${x.measured}`);
  const commit = (n: FrameHeight) => {
    s = n;
    const k = settleKey(s);
    if (k === key) return;
    cancel();
    key = k;
    cancel = armFrameTimer(settleDelayMs(s, Date.now()), () => commit(settleFrameHeight(s)));
  };
  commit(s);
  return {
    /** The WebView reports max(its own height, the document). */
    report: (doc = documentDp) => commit(nextFrameHeight(s, Math.max(frameLayout(s).frame, doc), frameLayout(s).frame, Date.now())),
    loadEnd: () => {
      cancelWait();
      cancelWait = s.answered ? () => undefined : armFrameTimer(FRAME_UNANSWERED_MS, () => commit(unansweredFrameHeight(s)));
    },
    get state() { return s; },
    get blank() { const l = frameLayout(s); return l.frame + l.spacer - documentDp; },
  };
}

describe("the frame takes its document's height", () => {
  it("starts at the seed, and takes the document's reading", () => {
    expect(frameHeightFor(null, "m1", W).dp).toBe(FRAME_SEED_DP);
    // The three rig mails' readings on the AVD: a thread, a fixed-height table, a mail at the frame budget.
    for (const dp of [3_456, 7_880, 112_960]) expect(feed([dp]).dp).toBe(dp);
  });

  it("never shrinks at one width: a WebView reports at least its own height, so a shorter reading says nothing", () => {
    const tall = feed([7_880]);
    expect(nextFrameHeight(tall, 7_880, 7_880, 0)).toBe(tall);
    expect(nextFrameHeight(tall, 7_000, 7_880, 0)).toBe(tall);
  });

  it("ignores the rounding creep, and returns the same state so the render bails out", () => {
    const at = feed([3_450]);
    expect(nextFrameHeight(at, 3_450 + FRAME_GROW_STEP_DP, 3_450, 0)).toBe(at);
    expect(nextFrameHeight(at, 3_450 + FRAME_GROW_STEP_DP + 1, 3_450, 0).dp).toBe(3_455);
  });

  it("a reading that is not a number changes nothing", () => {
    const at = feed([3_456]);
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1, 0]) expect(nextFrameHeight(at, bad, 3_456, 0)).toBe(at);
  });
});

describe("a fold or a rotation: the floor is a spacer, the height is a reading at the new width", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
  afterEach(() => { vi.useRealTimers(); });
  // The rig's fixed-height table: 7,880 dp folded (411 dp), 4,131 dp unfolded (673 dp).
  const folded = feed([7_880]);

  it("a new width shrinks the frame to the seed and holds the old height in a spacer, armed by nothing yet", () => {
    const unfolded = frameHeightFor(folded, "m1", 673);
    expect(frameLayout(unfolded)).toEqual({ frame: FRAME_SEED_DP, spacer: 7_880 - FRAME_SEED_DP });
    expect(settleDelayMs(unfolded, 0)).toBeNull();
    expect(settleFrameHeight(unfolded)).toBe(unfolded);
  });

  it("the remount sim leaves no blank tail on open, nor on reopen", () => {
    rememberFrameHeight(folded);
    const open = reader(frameHeightFor(null, "m1", 673, rememberedFrameHeight("m1")), 4_131);
    vi.advanceTimersByTime(900);
    expect(open.blank).toBe(7_880 - 4_131);
    open.report();
    vi.advanceTimersByTime(FRAME_SETTLE_MS);
    expect(open.blank).toBe(0);
    rememberFrameHeight(open.state);
    const reopen = reader(frameHeightFor(null, "m1", 673, rememberedFrameHeight("m1")), 4_131);
    expect(reopen.blank).toBe(0);
  });

  it("a first reading 600, 1,500 or 4,000 ms after mount still settles to the reading, never to the floor", () => {
    for (const after of [600, 1_500, 4_000]) {
      vi.setSystemTime(0);
      const r = reader(frameHeightFor(folded, "m1", 673), 4_131);
      vi.advanceTimersByTime(after);
      expect(r.state.floor, `at ${after} ms the spacer still holds the offset`).toBe(7_880);
      r.report();
      vi.advanceTimersByTime(FRAME_SETTLE_MS);
      expect(frameLayout(r.state), `a reading at ${after} ms`).toEqual({ frame: 4_131, spacer: 0 });
    }
  });

  it("a taller document at the new width (a rotation narrower still) settles taller", () => {
    const r = reader(frameHeightFor(folded, "m1", 360), 9_020);
    r.report();
    vi.advanceTimersByTime(FRAME_SETTLE_MS);
    expect(frameLayout(r.state)).toEqual({ frame: 9_020, spacer: 0 });
  });

  it("no reading at all: text at 5 s after the load end, with the existing sentence", () => {
    const r = reader(frameHeightFor(folded, "m1", 673), 4_131);
    r.loadEnd();
    vi.advanceTimersByTime(FRAME_UNANSWERED_MS - 1);
    expect(r.state.text).toBeNull();
    vi.advanceTimersByTime(1);
    expect(r.state.text).toBe("unanswered");
    // A first open no reading answers: the same, never a clipped 220 dp frame.
    const first = reader(frameHeightFor(null, "m2", W), 3_456);
    first.loadEnd();
    vi.advanceTimersByTime(FRAME_UNANSWERED_MS);
    expect(first.state.text).toBe("unanswered");
    // A short mail answers at the seed's own height and is NOT text.
    const short = reader(frameHeightFor(null, "m3", W), 120);
    short.report();
    short.loadEnd();
    vi.advanceTimersByTime(FRAME_UNANSWERED_MS);
    expect(short.state.text).toBeNull();
  });

  it("LOW 2: a reading every 300 ms for 10 s settles by 2 s after the first, on the latest", () => {
    // A sender's height animation: every reading differs, so each one re-arms the 500 ms settle.
    const r = reader(frameHeightFor(folded, "m1", 673), 4_131);
    let settledAt: number | null = null;
    for (let t = 0; t < 10_000 && settledAt === null; t += 300) {
      r.report(4_131 + t / 30);
      vi.advanceTimersByTime(300);
      if (r.state.floor === null) settledAt = Date.now();
    }
    expect(settledAt).not.toBeNull();
    expect(settledAt!).toBeLessThanOrEqual(FRAME_SETTLE_BOUND_MS + 300);
    expect(r.state.dp).toBeGreaterThan(4_131);
  });

  it("a remembered height is only ever a settled reading at its own width", () => {
    const folded9 = nextFrameHeight(frameHeightFor(null, "m9", W), 7_880, FRAME_SEED_DP, 0);
    const remeasuring = nextFrameHeight(frameHeightFor(folded9, "m9", 673), 4_131, FRAME_SEED_DP, 0);
    expect(remeasuring.floor).toBe(7_880);
    rememberFrameHeight(remeasuring);
    expect(rememberedFrameHeight("m9")).toBeNull();
    rememberFrameHeight(frameHeightFor(null, "m9", W));
    expect(rememberedFrameHeight("m9"), "a seed no reading answered").toBeNull();
    rememberFrameHeight(unansweredFrameHeight(frameHeightFor(null, "m9", W)));
    expect(rememberedFrameHeight("m9"), "text for want of a reading is not a height").toBeNull();
    const settled = settleFrameHeight(remeasuring);
    rememberFrameHeight(settled);
    expect(rememberedFrameHeight("m9")).toBe(settled);
    expect(settled.width).toBe(673);
  });
});

describe("a document too tall to draw as one page reads as text, never as a box", () => {
  it("past the ceiling: the 170,000 px element mail", () => {
    const s = feed([170_034]);
    expect(s.text).toBe("ceiling");
    expect(nextFrameHeight(s, 180_000, 220, 0)).toBe(s);
    expect(feed([112_960]).text).toBeNull();
  });

  it("a runaway: more than the allowed grows by a near-constant step (a min-height:100vh mail)", () => {
    const climb = (n: number, step: number) => Array.from({ length: n }, (_, i) => 900 + step * (i + 1));
    // The first reading is the document; every one after it is the frame's own padding again.
    expect(feed([900, ...climb(FRAME_RUNAWAY_GROWS, 34)]).text).toBeNull();
    expect(feed([900, ...climb(FRAME_RUNAWAY_GROWS + 1, 34)]).text).toBe("runaway");
    // Within the tolerance the step is still "constant": the padding rounds a pixel apart per reading.
    expect(feed([900, ...Array.from({ length: FRAME_RUNAWAY_GROWS + 1 }, (_, i) => 900 + 34 * (i + 1) + (i % 2))]).text).toBe("runaway");
  });

  it("LOW 1: the verifier's alternating and 3-cycle climbs reach text within the readings cap", () => {
    const shapes: [string, (v: number) => number][] = [
      ["alternating 34/40", (v) => v + (Math.floor(v / 100) % 2 ? 34 : 40)],
      ["alternating 30/60", (v) => v + (Math.floor(v / 100) % 2 ? 30 : 60)],
      ["3-cycle 30/40/55", (v) => v + [30, 40, 55][Math.floor(v / 100) % 3]!],
    ];
    for (const [name, f] of shapes) {
      let s = frameHeightFor(null, "m1", W);
      let n = 0;
      for (; n < 10_000 && s.text === null; n++) {
        const view = frameLayout(s).frame;
        const next = nextFrameHeight(s, Math.max(view, f(view)), view, 0);
        if (next === s) break;
        s = next;
      }
      expect(s.text, name).toBe("readings");
      expect(n, name).toBeLessThanOrEqual(FRAME_MAX_READINGS + 1);
    }
  });

  it("a document that grows by varying steps a few times is not text", () => {
    let h = 900;
    expect(feed(Array.from({ length: 60 }, (_, i) => (h += 40 + (i % 3) * 25))).text).toBeNull();
  });
});

describe("LOW 3: every frame timer is cancelled by what arms it", () => {
  it("a cancelled timer never fires; a re-armed settle fires once", () => {
    const fired: number[] = [];
    let id = 0;
    const timers = new Map<number, () => void>();
    const clock = {
      setTimeout: ((fn: () => void) => { timers.set(++id, fn); return id; }) as unknown as typeof setTimeout,
      clearTimeout: ((t: number) => { timers.delete(t); }) as unknown as typeof clearTimeout,
    };
    const cancel1 = armFrameTimer(500, () => fired.push(1), clock);
    cancel1();
    armFrameTimer(500, () => fired.push(2), clock);
    for (const fn of timers.values()) fn();
    expect(fired).toEqual([2]);
    expect(armFrameTimer(null, () => fired.push(3), clock)).toBeTypeOf("function");
    expect(timers.size).toBe(1);
  });
});

describe("the frame is wired to that height, with JavaScript still off", () => {
  it("its height is the learned one; the settle is armed only by a seed-size reading", () => {
    expect(FRAME).toContain("const sized = frameHeightFor(frameHeight, m.id, windowWidth, rememberedFrameHeight(m.id));");
    expect(FRAME).toContain("if (frameHeight !== null) rememberFrameHeight(frameHeight);");
    expect(FRAME).toContain("update((s) => nextFrameHeight(s, reported, view, at));");
    expect(FRAME).toContain("const reported = e.nativeEvent.contentSize.height;");
    expect(FRAME).toContain("const view = e.nativeEvent.layoutMeasurement.height;");
    expect(FRAME).toContain("const { frame: height, spacer } = frameLayout(sized);");
    expect(FRAME).toContain("{spacer > 0 ? <View style={{ height: spacer }} /> : null}");
    // The settle key is null until a seed-size reading: no timer runs from mount or from a width change.
    expect(FRAME).toContain("const settleKey = sized.measured === null ? null : `${sized.key}@${sized.width}:${sized.measured}`;");
    expect(FRAME).toContain("useEffect(() => armFrameTimer(settleDelayMs(sized, Date.now()), () => update(settleFrameHeight)), [settleKey]);");
    expect(FRAME).toContain("onLoadEnd={() => setLoadedFor(m.id)}");
    expect(FRAME).toContain("useEffect(() => armFrameTimer(awaiting === null ? null : FRAME_UNANSWERED_MS, () => update(unansweredFrameHeight)), [awaiting]);");
    expect(code(FRAME)).not.toMatch(/\bsetTimeout\(|\bclearTimeout\(/);
  });

  it("the frame never scrolls itself: whatever cannot be one page takes the oversize text path", () => {
    expect(FRAME).toContain("scrollEnabled={false}");
    // `nestedScrollEnabled` in any form is the trap: the library then refuses the reader every touch.
    expect(code(FRAME)).not.toContain("nestedScrollEnabled");
    expect(FRAME).toContain('if (shows.show === "text" || sized.text !== null) {');
    expect(code(FRAME)).not.toContain("frameHeightEstimate");
  });

  it("JavaScript stays off: the height is reported natively, not measured by a script", () => {
    expect(FRAME).toContain("javaScriptEnabled={false}");
    expect(code(FRAME)).not.toMatch(/injectedJavaScript|onMessage=/);
  });

  it("the reader's top edge fades into the canvas, taking no room and no touch", () => {
    expect(READER).toContain('<View pointerEvents="none" style={{ height: 0, zIndex: 1 }}>');
    expect(READER).toContain('<FadeOut color={t.c.canvas} height={10} edge="top" />');
  });
});

describe("the native half reports the DOCUMENT's height", () => {
  const added = PATCH.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).join("\n");

  it("is applied to the copy the phone build resolves, the version the patch is named for", () => {
    const copy = resolvedFrom(APP, "react-native-webview");
    expect(versionOf(copy)).toBe("13.16.1");
    expect(unpatchedIn(copy, PATCH), copy).toEqual([]);
  });

  it("Android: getContentHeight on the draw that changes it, never the scroll range, and again after a resize", () => {
    expect(added).toContain('private static final String DOCUMENT_HEIGHT_TAG = "ohmail-webview-document-height";');
    expect(added).toContain("int css = getContentHeight();");
    expect(added).toContain("protected void onDraw(android.graphics.Canvas canvas)");
    expect(added).toContain("reportedDocumentHeight = -1;");
    // The dex guard's literal must survive code shrinking: release builds strip Log.v and Log.d (proguard-rules.pro).
    expect(added).toContain("android.util.Log.w(DOCUMENT_HEIGHT_TAG,");
    expect(added).not.toMatch(/Log\.[vd]\(DOCUMENT_HEIGHT_TAG/);
    // The scroll range reads about twice the document mid-resize: the frame oscillated on it.
    expect(PATCH).toMatch(/^-\s+this\.computeVerticalScrollRange\(\),$/m);
    expect(PATCH).toMatch(/^\+\s+documentHeightPx\(\),$/m);
  });

  it("iOS: the scroll view's contentSize is observed, reported scrolling or not, and the observer removed", () => {
    expect(added).toContain('[_webView.scrollView addObserver:self forKeyPath:@"contentSize" options:NSKeyValueObservingOptionNew context:(__bridge void *)RNCWebViewDocumentHeightContext];');
    expect(added).toContain('[_webView.scrollView removeObserver:self forKeyPath:@"contentSize" context:(__bridge void *)RNCWebViewDocumentHeightContext];');
    expect(added).toContain("[self reportScroll:_webView.scrollView];");
    // The literal a Pods build guard reads: the observer's own KVO context, so it is used, not decoration.
    expect(added).toContain('static NSString *const RNCWebViewDocumentHeightContext = @"ohmail-webview-document-height-ios";');
    expect(added).toContain("} else if (context == (__bridge void *)RNCWebViewDocumentHeightContext && object == self.webView.scrollView) {");
  });
});
