import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { ANCHOR_SETTLE_MS, createOpenAnchor, placeAt, placeY, type OpenAnchor } from "../src/ui/open-anchor";
import { withoutComments } from "../../../scripts/lib/source-scan.mjs";

/**
 * THE OPEN ANCHOR ON A FRESH START: a conversation opened in the Ohbox stands with its opened message
 * at the top, or at the content's end where the content is shorter, once its layout settles. On a
 * fresh start the members' bodies lay out after the first anchor scroll, and React Native's scroll
 * view runs a scroll command before it mounts the taller content of the same commit, so it clamps
 * the scroll to the old end and no later layout comes to move it again. The anchor keeps aiming each
 * frame until the view stands where it asked (or the content's end), and the read rule hears only
 * the offsets the view reached, never the one asked for. The person's own scroll ends it.
 *
 * The scroll view here is a model of the native one: its content height lags the layout the reader
 * was told about until `mount()`, a scroll clamps to the content it has, and a scroll that moves it
 * reports its new offset on the next delivery (a scroll that does not move it reports nothing).
 */

const VIEW = 800;
let native = { content: 0, at: 0 };
let told = { content: 0, view: VIEW };
let openedTop: number | null = null;
let events: number[] = [];
let frames: (() => void)[] = [];
let clock = 0;
let heard: number[] = [];
let positions: Set<number>;
let asked = 0;
let placed = 0;
let anchor: OpenAnchor;

const scrollTo = (y: number): void => {
  asked++;
  const to = Math.min(Math.max(0, y), Math.max(0, native.content - VIEW));
  if (to === native.at) return;
  native.at = to;
  positions.add(to);
  events.push(to);
};
/** One frame: the scroll events the view sent are delivered, then what was asked for the frame runs. */
const frame = (): void => {
  clock += 16;
  const sent = events;
  events = [];
  for (const y of sent) anchor.reached(y);
  const run = frames;
  frames = [];
  for (const f of run) f();
};
const frameFor = (ms: number): void => { for (let t = 0; t < ms; t += 16) frame(); };
/** The native content view takes the height the reader was already told about. */
const mount = (): void => { native.content = told.content; };

beforeEach(() => {
  native = { content: 0, at: 0 };
  told = { content: 0, view: VIEW };
  openedTop = null;
  events = [];
  frames = [];
  clock = 0;
  heard = [];
  positions = new Set([0]);
  asked = 0;
  placed = 0;
  anchor = build();
});

const build = (applies?: () => boolean, start = 0): OpenAnchor =>
  createOpenAnchor({
    holding: true,
    ...(applies ? { applies } : {}),
    start,
    target: () => (openedTop === null ? null : openedTop - 8),
    extent: () => told,
    scrollTo,
    stand: (y) => heard.push(y),
    onPlaced: () => { placed++; },
    frame: (run) => { frames.push(run); return () => { frames = frames.filter((f) => f !== run); }; },
    now: () => clock,
  });

/** The members as snippets: three short panels above the opened message, all of it mounted. */
const snippets = (): void => {
  openedTop = 3 * 112 + 34 + 18;
  told.content = 1000;
  mount();
  anchor.layout();
};

describe("the open anchor on a fresh start", () => {
  it("members whose bodies lay out after the first anchor scroll: the opened message ends at the top once layout settles", () => {
    snippets();
    frameFor(100);
    expect(native.at, "the snippets' content ends at 200").toBe(200);
    // The bodies arrive: the reader is told, the scroll is asked before the taller content mounts.
    openedTop = 1600;
    told.content = 2600;
    anchor.layout();
    expect(native.at, "the premise: the view clamped the scroll to the old end").toBe(200);
    frame();
    mount();
    frameFor(200);
    expect(native.at, "the opened message stands at the top").toBe(1592);
    expect(heard.at(-1), "the read rule stands where the view stands").toBe(native.at);
    expect(heard.every((y) => positions.has(y)), `the read rule heard only reached offsets: ${heard.join(", ")}`).toBe(true);
  });

  it("the content is shorter than the opened message's top: it stands at the content's end", () => {
    openedTop = 1600;
    told.content = 2000;
    anchor.layout();
    frame();
    mount();
    frameFor(200);
    expect(native.at).toBe(1200);
    expect(heard.at(-1)).toBe(1200);
    expect(placed).toBeGreaterThan(0);
  });

  it("the column stays hidden until the view reached the opened message", () => {
    openedTop = 1600;
    told.content = 2600;
    native.content = 1000;
    anchor.layout();
    frameFor(48);
    expect(native.at, "clamped short of it").toBe(200);
    expect(placed, "not placed while the view stands short of a place it can reach").toBe(0);
    mount();
    frameFor(100);
    expect(native.at).toBe(1592);
    expect(placed).toBe(1);
  });

  it("a scroll report while it aims is its own (moving) until the view stands where it asked", () => {
    openedTop = 1600;
    told.content = 2600;
    native.content = 1000;
    expect(anchor.moving, "nothing asked yet").toBe(false);
    anchor.layout();
    expect(anchor.moving, "a scroll asked").toBe(true);
    frameFor(48);
    expect(native.at, "clamped short of it").toBe(200);
    expect(anchor.moving, "still on its way past the clamp").toBe(true);
    mount();
    frameFor(100);
    expect(native.at).toBe(1592);
    expect(anchor.moving, "it stands there: a report now is not the anchor's").toBe(false);
    anchor.layout();
    expect(anchor.moving, "a layout that leaves it in place asks nothing").toBe(false);
  });

  it("the person's own scroll before the layout settles ends the anchor", () => {
    snippets();
    frameFor(100);
    openedTop = 1600;
    told.content = 2600;
    anchor.layout();
    anchor.handOver();
    const before = asked;
    mount();
    frameFor(300);
    anchor.layout();
    frameFor(100);
    expect(asked, "no scroll asked after the hand-over").toBe(before);
    expect(native.at).toBe(200);
    expect(anchor.holding).toBe(false);
  });

  it("a later layout above the opened message, after it was reached, puts it back at the top", () => {
    snippets();
    openedTop = 1600;
    told.content = 2600;
    mount();
    anchor.layout();
    frameFor(100);
    expect(native.at).toBe(1592);
    openedTop = 1900;
    told.content = 2900;
    anchor.layout();
    frame();
    mount();
    frameFor(100);
    expect(native.at).toBe(1892);
    expect(heard.at(-1)).toBe(1892);
  });

  it("a view that never takes the content stops being asked after the settle bound", () => {
    openedTop = 1600;
    told.content = 2600;
    native.content = 1000;
    anchor.layout();
    frameFor(ANCHOR_SETTLE_MS + 200);
    const after = asked;
    frameFor(500);
    expect(asked, "no scroll asked past the bound").toBe(after);
    expect(native.at).toBe(200);
    expect(heard.at(-1)).toBe(200);
  });
});

describe("settling: what the view shows is no place the person chose", () => {
  it("from the open until the view stands at its place", () => {
    openedTop = 1600;
    told.content = 2600;
    native.content = 1000;
    expect(anchor.settling, "before any layout").toBe(true);
    anchor.layout();
    frameFor(48);
    expect(anchor.settling, "clamped short of it").toBe(true);
    mount();
    frameFor(100);
    expect(native.at).toBe(1592);
    expect(anchor.settling).toBe(false);
  });

  it("again after a layout that moves the place, and after a rearm (a new width)", () => {
    snippets();
    openedTop = 1600;
    told.content = 2600;
    mount();
    anchor.layout();
    frameFor(100);
    expect(anchor.settling).toBe(false);
    openedTop = 1900;
    told.content = 2900;
    anchor.layout();
    expect(anchor.settling, "the place moved").toBe(true);
    mount();
    frameFor(100);
    expect(anchor.settling).toBe(false);
    anchor.handOver();
    openedTop = 2200;
    told.content = 3200;
    anchor.rearm();
    expect(anchor.settling, "a new width aims again").toBe(true);
    mount();
    frameFor(100);
    expect([native.at, anchor.settling]).toEqual([2192, false]);
  });

  it("past the settle bound short of its place it stays settling until the person's own scroll", () => {
    openedTop = 1600;
    told.content = 2600;
    native.content = 1000;
    anchor.layout();
    frameFor(ANCHOR_SETTLE_MS + 200);
    expect(native.at, "the premise: given up short of it").toBe(200);
    expect(anchor.settling).toBe(true);
    anchor.handOver();
    expect(anchor.settling).toBe(false);
  });

  it("a kept start past the end of a content that now fits stands at once: the view clamped it to 0 and reported nothing", () => {
    anchor = build(undefined, 2600);
    openedTop = 600;
    told.content = 700;
    mount();
    anchor.layout();
    frameFor(ANCHOR_SETTLE_MS + 200);
    expect({ at: native.at, heard, settling: anchor.settling, placed }).toEqual({ at: 0, heard: [], settling: false, placed: 1 });
  });

  it("never where no place applies", () => {
    anchor = build(() => false);
    openedTop = 1600;
    told.content = 2600;
    anchor.layout();
    expect(anchor.settling).toBe(false);
  });

  it("a view above every panel keeps the first panel, as far above its top, and lands there at any width", () => {
    const at = placeAt([{ id: "a", top: 18, height: 200 }, { id: "b", top: 230, height: 500 }], 0, { content: 2000, view: 640 });
    expect(at).toEqual({ id: "a", dy: -18, h: 200 });
    expect(placeY([{ id: "a", top: 18, height: 400 }, { id: "b", top: 430, height: 900 }], at!, { content: 3000, view: 400 })).toBe(0);
  });
});

describe("the reader wires the anchor", () => {
  const reader = withoutComments(readFileSync(fileURLToPath(new URL("../src/ui/MessageReader.tsx", import.meta.url)), "utf8"));
  it("every scroll report goes through the anchor's reached offset; no requested offset is stood on", () => {
    expect(reader).toMatch(/onScroll = \(e: NativeSyntheticEvent<NativeScrollEvent>\) => anchor\.reached\(e\.nativeEvent\.contentOffset\.y\)/);
    expect(reader).toMatch(/onContentSizeChange=\{\(cw, h\) => \{ box\.current\.content = h; seen\.content\(h\); widthSeen\("content", cw\); anchor\.layout\(\); \}\}/);
    expect(reader).not.toMatch(/scrollTo\(\{ y, animated: false \}\);\s*stand\(y\)/);
  });
  it("a member's top starts at its text: the body's margin stands above the marker, not under it", () => {
    expect(reader).toMatch(/<View style=\{\{ height: 0, marginTop: 10 \}\} onLayout=\{\(e\) => seen\.panelBody\(h\.id/);
    expect(reader).toMatch(/<BodyPages variant="streamBody" tone="ink2" text=\{h\.body\} \/>/);
  });
});
