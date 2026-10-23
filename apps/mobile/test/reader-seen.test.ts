import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { THREAD_READ_HOLD_MS, createThreadRead, type ThreadRead } from "@ohmail/client-engine";
import { createPhoneThreadRead, type PhoneThreadRead } from "../src/ui/reader-seen";
import {
  RAIL_PITCH, RAIL_PITCH_MIN, RAIL_TOP, openedBodyFinal, railFit, railOffsetFor, readerChromeOverlap,
} from "../src/ui/reader-marks";
import { VISIT_HANDOFF_MS, hideVisit, resetVisitsForTests, showVisit, visitRecordFor } from "../src/ui/visit-records";
import {
  coverReader, onReaderCover, readerSees, resetReaderCoverForTests, setReaderWindowFocused,
} from "../src/ui/reader-cover";
import { FRAME_SEED_DP, frameFinal, frameHeightFor, nextFrameHeight } from "../src/mail/frame-height";
import { withoutComments } from "../../../scripts/lib/source-scan.mjs";

/**
 * THE PHONE READER'S THREAD-READ ADAPTER, numbers only (owner ruling 2026-10-23: having seen the
 * top of a message is reading it): the engine's rule over React Native's layout reports, in content
 * coordinates. An 800dp scroll view; the opened message's sender row at 0..40 of its section, its body
 * from 100, its end at 300; members below from 400, each with its header at 18..48, its body from 60
 * and its end at 360. A body's first lines are 74dp (three of the stream's 24.65dp lines). A message
 * turns read once its top has been in view for the 0.7 s dwell. Frames and the dwell's timer run by hand.
 */

const HOLD = THREAD_READ_HOLD_MS;
let reads: string[][] = [];
let heres: (string | null)[] = [];
let frames: (() => void)[] = [];
let timers: { at: number; run: () => void }[] = [];
let clock = 0;
let unread = new Set<string>();
let ready = (_id: string): boolean => true;
let opened: string | null = "open";
let active = true;
let record: ThreadRead;
const flush = (): void => { for (let i = 0; i < 10 && frames.length > 0; i++) { const run = frames; frames = []; for (const f of run) f(); } };
/** Time passes by `ms` (the looks already asked for run first): the dwell's timers that fall due run, and the looks they ask for. */
const pass = (ms: number): void => {
  flush();
  clock += ms;
  for (;;) {
    const due = timers.filter((t) => t.at <= clock);
    if (due.length === 0) break;
    timers = timers.filter((t) => t.at > clock);
    for (const t of due) t.run();
    flush();
  }
};
function core(): PhoneThreadRead {
  return createPhoneThreadRead({
    record,
    openedId: () => opened,
    unread: (id) => unread.has(id),
    ready: (id) => ready(id),
    onRead: (ids) => { reads.push(ids); for (const id of ids) unread.delete(id); },
    onHere: (id) => heres.push(id),
    active: () => active,
    now: () => clock,
    frame: (run) => { frames.push(run); return () => { frames = frames.filter((f) => f !== run); }; },
    after: (ms, run) => { const t = { at: clock + ms, run }; timers.push(t); return () => { timers = timers.filter((x) => x !== t); }; },
  });
}
function member(c: PhoneThreadRead, id: string, y: number, h = 400, group: "above" | "below" = "below"): void {
  c.panel(id, group, y, h);
  c.panelHeader(id, 18, 30);
  c.panelBody(id, 60);
  c.panelEnd(id, h - 40);
}
/** The opened section at the column's top, two members of 400dp below it from y 400. */
function laidOut(c: PhoneThreadRead): void {
  c.viewport(800);
  c.chrome(0);
  c.offset("padded", 0);
  c.offset("opened", 0);
  c.openedFrom(0, 40);
  c.openedBody(100);
  c.openedEnd(300);
  c.offset("below", 400);
  member(c, "m1", 0);
  member(c, "m2", 420);
}

beforeEach(() => {
  reads = []; heres = []; frames = []; timers = []; clock = 1000; opened = "open"; active = true;
  unread = new Set(["open", "m1", "m2"]);
  ready = () => true;
  record = createThreadRead();
  record.enter(clock);
});

describe("a message turns read once its top has been in view for the dwell", () => {
  it("the opened message and the member whose top is in view read once the dwell is done (the control)", () => {
    const c = core();
    laidOut(c);
    flush();
    expect(reads, "the dwell has only started").toEqual([]);
    pass(HOLD - 50);
    expect(reads, "not a moment before it is done").toEqual([]);
    pass(51);
    expect(reads, "m1's top ends at 534; m2's starts at 838, off screen").toEqual([["open", "m1"]]);
  });

  it("its end is not needed: a member whose end is screens below reads", () => {
    const c = core();
    laidOut(c);
    member(c, "m1", 0, 4000);
    pass(HOLD + 1);
    expect(reads).toEqual([["open", "m1"]]);
  });

  it("a fast scroll past reads nothing it passes", () => {
    const c = core();
    laidOut(c);
    unread = new Set(["m2"]);
    flush();
    for (let y = 0; y <= 1600; y += 100) { c.onScroll(y); pass(16); }
    pass(5 * HOLD);
    expect(reads).toEqual([]);
  });

  it("outside the Ohbox the opened message is not the rule's (the open reads it)", () => {
    opened = null;
    const c = core();
    laidOut(c);
    pass(HOLD + 1);
    expect(reads).toEqual([["m1"]]);
  });

  it("nothing before the layout: a zero viewport reads nothing", () => {
    const c = core();
    c.openedFrom(0, 40);
    c.openedBody(100);
    c.openedEnd(300);
    pass(5 * HOLD);
    expect(reads).toEqual([]);
  });

  it("many reports before a frame are one look", () => {
    const c = core();
    laidOut(c);
    expect(frames.length).toBe(1);
  });

  it("a kept message is not read", () => {
    record.keepUnread("open");
    const c = core();
    laidOut(c);
    pass(5 * HOLD);
    expect(reads).toEqual([["m1"]]);
  });

  it("the ring follows the panel most in view, and the jump lands on a panel's top", () => {
    const c = core();
    laidOut(c);
    flush();
    expect(heres.at(-1)).toBe("m1");
    expect(c.topOf("m2")).toBe(820);
    expect(c.topOf("open")).toBe(0);
    c.onScroll(820);
    flush();
    expect(heres.at(-1)).toBe("m2");
  });
});

describe("the read zone is what the person sees", () => {
  it("only chrome standing OVER the scroll view shortens it: the compact bar stands below it", () => {
    expect(readerChromeOverlap("compact", 210), "the compact bar is in the column, under the scroll view").toBe(0);
    expect(readerChromeOverlap("rail", 210), "the rail is at the side").toBe(0);
    expect(readerChromeOverlap("bar", 120), "the pinned bar floats over the scroll").toBe(120);
  });

  it("a top just above the scroll view's foot counts; under chrome standing over it, it does not", () => {
    const c = core();
    laidOut(c);
    c.viewport(540); // the scroll view ends at the bar's top: m1's top ends at 534
    pass(HOLD + 1);
    expect(reads).toEqual([["open", "m1"]]);
    const d = createThreadRead();
    d.enter(clock);
    record = d;
    reads = [];
    unread = new Set(["m1"]);
    const e = core();
    laidOut(e);
    e.viewport(800);
    e.chrome(300); // a pinned bar over the scroll's foot: the view ends at 500
    pass(5 * HOLD);
    expect(reads).toEqual([]);
  });
});

describe("only while the person can be reading", () => {
  it("nothing while the app is away; back in the foreground, the dwell starts over", () => {
    const c = core();
    laidOut(c);
    flush();
    pass(HOLD - 100);
    active = false;
    c.poke();
    pass(5 * HOLD);
    expect(reads).toEqual([]);
    active = true;
    c.poke();
    pass(HOLD - 100);
    expect(reads, "the dwell counts from the return").toEqual([]);
    pass(101);
    expect(reads).toEqual([["open", "m1"]]);
  });

  it("a reply that arrives into the open reader reads once its top has been in view, no touch needed", () => {
    const c = core();
    laidOut(c);
    pass(HOLD + 1);
    expect(reads).toEqual([["open", "m1"]]);
    unread.add("m3");
    member(c, "m3", -300, 200); // synced in, wholly in view (the list sits at 400)
    flush();
    pass(HOLD - 50);
    expect(reads).toEqual([["open", "m1"]]);
    pass(51);
    expect(reads).toEqual([["open", "m1"], ["m3"]]);
  });
});

describe("only while nothing covers the reader and its window has the focus", () => {
  /** The adapter as the reader wires it: it looks only while `readerSees`, and again when a cover goes. */
  function wired(): { c: PhoneThreadRead; off: () => void } {
    const c = createPhoneThreadRead({
      record,
      openedId: () => opened,
      unread: (id) => unread.has(id),
      ready: (id) => ready(id),
      onRead: (ids) => { reads.push(ids); for (const id of ids) unread.delete(id); },
      active: () => readerSees("active"),
      now: () => clock,
      frame: (run) => { frames.push(run); return () => { frames = frames.filter((f) => f !== run); }; },
      after: (ms, run) => { const t = { at: clock + ms, run }; timers.push(t); return () => { timers = timers.filter((x) => x !== t); }; },
    });
    return { c, off: onReaderCover(() => c.poke()) };
  }
  afterEach(() => resetReaderCoverForTests());

  it("a reply that arrives while the composer covers the reader stays unread until it closes and its top is then seen", () => {
    const { c, off } = wired();
    laidOut(c);
    pass(HOLD + 1);
    expect(reads).toEqual([["open", "m1"]]);
    const release = coverReader(); // Reply: the composer's Modal over the still-mounted reader
    unread.add("m3");
    member(c, "m3", -300, 200); // synced in while the person types, laid out in view under the sheet
    flush();
    pass(10 * HOLD);
    expect(reads, "a reply under the composer was read, never seen").toEqual([["open", "m1"]]);
    release();
    pass(HOLD - 50);
    expect(reads, "the dwell counts from the uncovering").toEqual([["open", "m1"]]);
    pass(51);
    expect(reads).toEqual([["open", "m1"], ["m3"]]);
    off();
  });

  it("CONTROL: the same arrival with nothing over the reader reads once its top was in view", () => {
    const { c, off } = wired();
    laidOut(c);
    pass(HOLD + 1);
    unread.add("m3");
    member(c, "m3", -300, 200);
    flush();
    pass(HOLD + 1);
    expect(reads).toEqual([["open", "m1"], ["m3"]]);
    off();
  });

  it("a sheet over the reader holds every dwell under way; it starts over once the sheet is gone", () => {
    const { c, off } = wired();
    laidOut(c);
    pass(HOLD - 100);
    const release = coverReader();
    pass(5 * HOLD);
    expect(reads).toEqual([]);
    release();
    release(); // idempotent: a second release uncovers nothing else
    pass(HOLD - 100);
    expect(reads).toEqual([]);
    pass(101);
    expect(reads).toEqual([["open", "m1"]]);
    off();
  });

  it("the window's blur (the notification shade) reads nothing; its focus starts the dwell over", () => {
    const { c, off } = wired();
    laidOut(c);
    pass(HOLD - 100);
    setReaderWindowFocused(false);
    pass(5 * HOLD);
    expect(reads).toEqual([]);
    setReaderWindowFocused(true);
    pass(HOLD - 100);
    expect(reads).toEqual([]);
    pass(101);
    expect(reads).toEqual([["open", "m1"]]);
    off();
  });

  it("two covers: the reader is in sight only once both are gone", () => {
    const one = coverReader();
    const two = coverReader();
    expect(readerSees("active")).toBe(false);
    one();
    expect(readerSees("active")).toBe(false);
    two();
    expect(readerSees("active")).toBe(true);
    expect(readerSees("background"), "an app away is never in sight").toBe(false);
  });
});

describe("nothing is read before its body is laid out and its top was on screen for the dwell", () => {
  it("a member's snippet layout does not count: the body's real layout starts the dwell over", () => {
    unread = new Set(["m1"]);
    let full = false;
    ready = (id) => id !== "m1" || full;
    const c = core();
    laidOut(c);
    member(c, "m1", 0, 120); // the snippet: five lines
    flush();
    pass(5 * HOLD);
    expect(reads, "not ready: a snippet").toEqual([]);
    full = true; // the body lands; the look runs before its layout comes
    c.poke();
    pass(HOLD - 300);
    member(c, "m1", 0, 1600); // the real layout: its top still in view, its end two screens down
    flush();
    pass(400);
    expect(reads, "the snippet's look started no dwell that counts").toEqual([]);
    pass(HOLD);
    expect(reads, "its top, laid out, on screen for the dwell").toEqual([["m1"]]);
  });

  it("a member on screen only under the frame's seed, pushed off when the frame grows, is never read; the letter reads by its frame's top", () => {
    let final = false;
    ready = (id) => (id === "open" ? openedBodyFinal({ bodyState: "full" }, { framed: true, final }) : true);
    unread = new Set(["open", "m1"]);
    const c = core();
    c.viewport(800);
    c.offset("padded", 0);
    c.offset("opened", 0);
    c.openedFrom(0, 40);
    c.openedBody(102);
    c.openedEnd(102 + FRAME_SEED_DP); // the end marker under the frame at its seed
    c.offset("below", 102 + FRAME_SEED_DP + 40);
    member(c, "m1", 0, 300); // wholly on screen, just under the seed frame
    flush();
    pass(400);
    final = true; // the WebView answered: the document is 3000dp, and m1 is pushed far down
    c.openedEnd(3102);
    c.offset("below", 3142);
    flush();
    pass(5 * HOLD);
    expect(reads, "m1 was on screen 0.4 s; the letter's top for the dwell").toEqual([["open"]]);
  });

  it("the opened letter at the frame's seed reads nothing however long it stands", () => {
    ready = (id) => (id === "open" ? openedBodyFinal({ bodyState: "full" }, { framed: true, final: false }) : true);
    unread = new Set(["open"]);
    const c = core();
    laidOut(c);
    pass(10 * HOLD);
    expect(reads).toEqual([]);
  });

  it("a jump's last frames that never reached onScroll leave no stale place: the landing reported, the passed message is not read", () => {
    unread = new Set(["m2"]);
    const c = core();
    laidOut(c);
    member(c, "m3", 840, 2000);
    flush();
    c.onScroll(600); // the last throttled event mid-jump: m2's top in view
    pass(HOLD - 300);
    c.onScroll(2400); // the jump's landing, reported once it is done
    pass(5 * HOLD);
    expect(reads, "m2 only flew past").toEqual([]);
    expect(heres.at(-1), "the ring on the landing's panel").toBe("m3");
  });
});

describe("a framed opened message is ready once its frame has its document's height", () => {
  it("openedBodyFinal: a framed body waits for the frame; text, withheld and protected do not", () => {
    expect(openedBodyFinal({ bodyState: "full" }, { framed: true, final: false })).toBe(false);
    expect(openedBodyFinal({ bodyState: "full" }, { framed: true, final: true })).toBe(true);
    expect(openedBodyFinal({ bodyState: "full" }, { framed: false, final: false })).toBe(true);
    expect(openedBodyFinal({ bodyState: "loading" }, { framed: false, final: true })).toBe(false);
    expect(openedBodyFinal({ bodyState: "snippet" }, { framed: false, final: true })).toBe(false);
    expect(openedBodyFinal({ bodyState: "withheld" }, { framed: true, final: false })).toBe(true);
    expect(openedBodyFinal({ protected: {}, bodyState: "snippet" }, { framed: true, final: false })).toBe(true);
  });
  it("frameFinal: not at the seed, yes after a reading, not while re-measuring, yes as text", () => {
    const seed = frameHeightFor(null, "k", 400);
    expect(frameFinal(seed, false)).toBe(false);
    const read = nextFrameHeight(seed, 3000, FRAME_SEED_DP, 0);
    expect(frameFinal(read, false)).toBe(true);
    expect(frameFinal(frameHeightFor(read, "k", 700), false), "a new width re-measures").toBe(false);
    expect(frameFinal(seed, true)).toBe(true);
  });
});

describe("a fold keeps the visit (the reader remounts for the same message)", () => {
  const after = (_ms: number, run: () => void): (() => void) => { ended.push(run); return () => { ended = ended.filter((r) => r !== run); }; };
  let ended: (() => void)[] = [];
  beforeEach(() => { ended = []; resetVisitsForTests(); });
  afterEach(() => resetVisitsForTests());

  it("Mark unread, a fold and an unfold: the new mount's record keeps it unread", () => {
    const first = visitRecordFor("open", clock);
    showVisit("open", clock);
    first.keepUnread("open"); // ⋯ → Mark unread
    unread = new Set(["open"]);
    hideVisit("open", after); // the pane's reader unmounts…
    const again = visitRecordFor("open", clock + 50); // …and the pushed route's mounts
    showVisit("open", clock + 50);
    expect(again, "the same visit").toBe(first);
    for (const run of ended.splice(0)) run(); // the grace runs out: the visit is shown, it stays
    expect(visitRecordFor("open", clock + 100)).toBe(first);
    record = again;
    const c = core();
    laidOut(c);
    pass(5 * HOLD);
    expect(reads.flat(), "read back after the fold").not.toContain("open");
  });

  it("a real leave ends the visit after the grace; the next visit is a fresh record", () => {
    const first = visitRecordFor("open", clock);
    showVisit("open", clock);
    hideVisit("open", after);
    expect(ended.length, "the end waits the handoff's grace").toBe(1);
    expect(VISIT_HANDOFF_MS).toBeGreaterThan(0);
    for (const run of ended.splice(0)) run();
    expect(visitRecordFor("open", clock)).not.toBe(first);
  });

  it("opening another message ends a visit nobody shows at once", () => {
    const first = visitRecordFor("open", clock);
    showVisit("open", clock);
    hideVisit("open", after);
    showVisit("other", clock);
    expect(visitRecordFor("open", clock)).not.toBe(first);
  });
});

describe("the rail fits the reader", () => {
  it("30dp a square where they fit, closer down to 16dp, and past that it scrolls", () => {
    expect(railFit(5, 700)).toEqual({ pitch: RAIL_PITCH, scrolls: false });
    expect(railFit(30, 700)).toEqual({ pitch: 23, scrolls: false });
    expect(railFit(40, 600)).toEqual({ pitch: RAIL_PITCH_MIN, scrolls: true });
  });
  it("every square of a 30-message conversation lies inside the room above the chrome", () => {
    const room = 700;
    const { pitch } = railFit(30, room);
    expect(RAIL_TOP + 30 * pitch).toBeLessThanOrEqual(room);
  });
  it("a scrolling rail keeps the ringed square in view, the newest reachable", () => {
    const n = 40, room = 600, { pitch } = railFit(n, room);
    for (const i of [0, 20, 39]) {
      const off = railOffsetFor(i, n, pitch, room);
      const top = RAIL_TOP + i * pitch;
      expect(top - off).toBeGreaterThanOrEqual(0);
      expect(top + pitch - off).toBeLessThanOrEqual(room);
    }
  });
});

describe("the reader wires it", () => {
  const reader = withoutComments(readFileSync(fileURLToPath(new URL("../src/ui/MessageReader.tsx", import.meta.url)), "utf8"));
  it("one record per visit, held outside the tree, entered at the mount; the rule's reads go out as one glance", () => {
    expect(reader).toMatch(/const record = visitRecordFor\(id, Date\.now\(\)\);/);
    expect(reader).toMatch(/showVisit\(id, Date\.now\(\)\);\s*return \(\) => hideVisit\(id\);/);
    expect(reader).not.toMatch(/createThreadRead\(/);
    expect(reader).toMatch(/onRead: \(ids\) => glance\.current\(ids\)/);
  });
  it("a body's first lines in its own type, and the start of each body reported", () => {
    expect(reader).toMatch(/lines: \(mid\) => THREAD_TOP_LINES \* /);
    expect(reader).toMatch(/seen\.openedBody\(e\.nativeEvent\.layout\.y\)/);
    expect(reader).toMatch(/seen\.panelBody\(h\.id, e\.nativeEvent\.layout\.y\)/);
  });
  it("only chrome standing over the scroll view is taken off the read zone", () => {
    expect(reader).toMatch(/const chromeOver = readerChromeOverlap\(verbMode, chromeExtent\);/);
    expect(reader).toMatch(/seen\.chrome\(chromeOver\)/);
  });
  it("the scroll starts at the remembered place once; every scroll, drag end, fling end and settled jump is reported", () => {
    expect(reader).toMatch(/const startAt = useMemo\(\(\) => \(\{ x: 0, y: paneScrollOf\(scrollKey\) \}\), \[scrollKey\]\);/);
    expect(reader).toMatch(/contentOffset=\{startAt\}/);
    expect(reader).not.toMatch(/contentOffset=\{\{/);
    expect(reader).toMatch(/scrollEventThrottle=\{16\}/);
    expect(reader).toMatch(/onScrollEndDrag=\{onScroll\}/);
    expect(reader).toMatch(/onMomentumScrollEnd=\{onScroll\}/);
    expect(reader).toMatch(/jumpEnd\.current = setTimeout\(\(\) => \{ jumpEnd\.current = null; end\(\); \}, RAIL_JUMP_SETTLE_MS\)/);
  });
  it("looks only while its screen is in front, the app active, its window focused and no modal over it, and again when that changes", () => {
    expect(reader).toMatch(/const screenShown = useIsFocused\(\);\s+const shown = useRef\(screenShown\);\s+shown\.current = screenShown;/);
    expect(reader).toMatch(/active: \(\) => shown\.current && readerSees\(AppState\.currentState\)/);
    expect(reader).not.toMatch(/AppState\.currentState === "active"/);
    expect(reader).toMatch(/AppState\.addEventListener\("change", \(s\) => \{ if \(s === "active"\) seen\.poke\(\); \}\)/);
    expect(reader).toMatch(/AppState\.addEventListener\("blur", \(\) => setReaderWindowFocused\(false\)\)/);
    expect(reader).toMatch(/AppState\.addEventListener\("focus", \(\) => setReaderWindowFocused\(true\)\)/);
    expect(reader).toMatch(/onReaderCover\(\(\) => seen\.poke\(\)\)/);
  });
  it("every modal over the reader covers it while shown: each Sheet and the composer", () => {
    const src = (p: string) => withoutComments(readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8"));
    const sheet = src("../src/ui/Sheet.tsx");
    expect(sheet).toMatch(/useReaderCover\(open\);[\s\S]*if \(!open\) return null;/);
    const actions = src("../src/ui/MessageActions.tsx");
    expect(actions).toMatch(/export function ComposeSheet\([\s\S]*?useReaderCover\(true\);/);
    /* Every Modal in the app is one of these two (a new one must cover the reader too). */
    const modals = (s: string) => (s.match(/<Modal\b/g) ?? []).length;
    expect(modals(sheet)).toBe(1);
    expect(modals(actions)).toBe(1);
  });
  it("the opened message is ready only once its frame is final", () => {
    expect(reader).toMatch(/openedBodyFinal\(m, \{ framed, final: frameFinalFor === m\.id \}\)/);
    expect(reader).toMatch(/<MailBodyFrame[\s\S]{0,200}onFinal=/);
  });
  it("in the Ohbox's time order the reader draws older members above the opened message and opens at it, until the person's first drag or square", () => {
    expect(reader).toMatch(/const \{ above, below \} = readerGroups\(m, inOhbox\);/);
    expect(reader).toMatch(/\{above\.map\(\(h\) => memberPanel\(h, "above"\)\)\}[\s\S]*seen\.offset\("opened"[\s\S]*\{below\.map\(\(h\) => memberPanel\(h, "below"\)\)\}/);
    expect(reader).toMatch(/anchorFacts\.current = \(\) => \(facts\.current\.inOhbox && aboveCount\.current > 0 \? seen\.topOf\(id\) : null\);/);
    expect(reader).toMatch(/holding: !hasPaneScroll\(scrollKey\),/);
    expect(reader, "the oldest member is not flashed before the anchor places the opened one").toMatch(/opacity: unplaced \? 0 : 1/);
    expect(reader).toMatch(/onScrollBeginDrag=\{\(\) => \{ handOver\(\); seen\.poke\(\); \}\}/);
  });
  it("a reply that syncs into the open reader is asked its text", () => {
    expect(reader).toMatch(/const fresh = arrivalsToAsk\(m\.earlier, asked\.current\);\s*if \(fresh\.length > 0\) hydrateHeld\(fresh\);/);
  });
  it("the rail fits the reader's room above the chrome, and scrolls past it", () => {
    expect(reader).toMatch(/const \{ pitch, scrolls \} = railFit\(n, room\);/);
    expect(reader).toMatch(/over=\{chromeOver\}/);
    expect(reader).toMatch(/railOffsetFor\(at, n, pitch, room\)/);
  });
});
