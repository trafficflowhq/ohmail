/** @vitest-environment jsdom */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";
import {
  BAR_VERB_ORDER,
  BAR_SEGMENTS,
  verbCost,
  type BarSeg,
  type BarVerb,
} from "../app/shell/bar-density";

/**
 * THE PILL USES THE WIDTH IT HAS — the fold driven from a stubbed row width, both ways.
 *
 * ══ WHAT WAS REPORTED, AND WHAT IT TURNED OUT TO BE ═══════════════════════════════════════
 *
 * *"The pill shows Reply · Reply all · Forward · Mark unread · ▾ and folds Later, Park,
 * Resurface, Tag, Screening, Move, Draft reply and Delete behind the ▾ — while the row has room
 * for several more."* The measurement was not wrong: `bar-density.ts` reads the row it is given
 * and always has. The GRANULARITY was. The three horizons were admitted as one block and the two
 * filing verbs as another, so a row with room for Later and Park folded both of them along with
 * Resurface — measured in Chromium at 1440 in the widest reading column the product has, 150px of
 * the pill's own room standing empty with eight verbs behind More.
 *
 * ══ THE THREE ARMS, AND THE ONE THAT WAS NOT SATISFIABLE ══════════════════════════════════
 *
 *  · MAXIMALITY — the room left over cannot seat the next folded verb. This is the reading that
 *    refuses the old rule, and it is the report translated into something a gate can check per
 *    row width. `scripts/fit-render.mjs` holds the same reading in a real browser.
 *  · MONOTONE IN THE PILL'S OWN ROOM — widen the row and the inline count never falls.
 *    NOT monotone in the VIEWPORT's width, which is what a first reading of the report asks for
 *    and which no fold rule can deliver: the pill's room is not monotone in the window either
 *    (measured 560 · 604 · 280 · 512 · 560 across 640 · 768 · 1024 · 1280 · 1440, because the
 *    shell is three columns at 1024 and the reading column is 292px wide there), and the type
 *    step at the 640/768 breakpoint grows every control at once (Forward 65 → 96). So the arm is
 *    stated over the room, which is the thing the fold actually decides against.
 *  · ONE ORDER, ONE RULE, FOR EVERY MESSAGE — a single message and a threaded one fold by the
 *    same walk, and the only verb that legitimately depends on the message is Reply all. It is
 *    NOT a set equality apart from Reply all: dropping `rall` frees room the tail then takes
 *    (measured at paper/en/1440 — the 1:1 shape seats Resurface, the reply-all shape does not).
 *    What holds is containment plus both being prefixes of the one order.
 *
 * ══ WHY THE WIDTHS ARE STUBBED, AND WHERE THEY COME FROM ══════════════════════════════════
 *
 * jsdom has no layout, so the hook's own reads — `offsetWidth` on each measured element and the
 * container's rectangle — are the seam. They are stubbed with the widths MEASURED IN CHROMIUM on
 * the shipped bar at paper/en/1440 (see {@link W}), so the arithmetic here is the browser's and
 * not an invention: put a different number in and the reported cell's expectation is a fiction
 * that happens to be self-consistent. The pixels at which each set occurs across faces, locales
 * and widths stay the browser sweep's job; what this file owns is that the WALK is right.
 */

// See `sync-liveness-shell.test.ts` for why React is published as a global.
(globalThis as unknown as { React: unknown }).React = React;
process.env.NEXT_PUBLIC_API_BASE = "/api";

const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = new Date("2026-08-04T12:00:00.000Z");

/**
 * THE MEASURED WIDTHS, from Chromium at paper/en/1440 on the shipped bar (the reply-all shape).
 *
 * The floor is `reply` + gap + `fwd` + gap + `read` = 60 + 6 + 96 + 6 + 139 = 307 since Forward
 * joined it (DESIGN-026 §2.1); the report's cell showed 205 before that. The pill's room there was
 * 560. Group admission seated `rall` — 410 used, 150 empty — because the horizons cost
 * 6 + 65 + 62 + 93 = 226 as a block.
 */
const W = {
  reply: 60,
  read: 139,
  rall: 97,
  fwd: 96,
  later: 65,
  aside: 62,
  resurface: 93,
  tag: 36,
  screen: 92,
  move: 67,
} as const;
/** The pill's own horizontal padding, which `bar-density.ts` subtracts from the container. */
const PILL_PAD = 12;
const GAP = 6;

/** The row width that gives the pill the room the report's cell had. */
const WIDE = 560 + PILL_PAD;
/** A phone-width row: the floor plus Reply all and nothing after it. */
const NARROW = 410 + PILL_PAD;

/** The read switch's label and button, for the compact-floor cases; 0 elsewhere (no compact). */
let LAB = 0;
let READ_BTN = 0;
/** The answer verbs' word spans, for the icon-face cases; 0 elsewhere (no icon face). */
let FWD_LAB = 0;
let REPLY_LAB = 0;
/** Extra width on the leading Reply group, for the arms that need a floor above 400px of room
 *  (under 400 the read switch folds whole, so a compact-floor property is measured above it). */
let REPLY_EXTRA = 0;

function widthOf(el: HTMLElement): number {
  if (el.classList.contains("abar-read-lab")) return LAB;
  if (el.classList.contains("abar-fwd-lab")) return FWD_LAB;
  if (el.classList.contains("abar-reply-lab")) return REPLY_LAB;
  if (el.classList.contains("abar-read") && !el.classList.contains("abar-read-g")) return READ_BTN;
  for (const { verb } of BAR_VERB_ORDER) if (el.classList.contains(`abar-${verb}`)) return W[verb];
  if (el.classList.contains("abar-read-g")) return W.read;
  if (el.classList.contains("abar-fwd")) return W.fwd; // floor, beside Reply
  if (el.classList.contains("abar-g")) return W.reply + REPLY_EXTRA; // the leading Reply group
  return 0;
}

function msg(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "m1", accountId: "a", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: "Glaze order #2214",
    from: { name: "Giulia", address: "giulia@example.invalid" },
    to: [], cc: [], date: "2026-08-04T09:00:00.000Z", folder: "INBOX", snippet: "preview",
    unread: false, hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: "2026-08-04T09:00:00.000Z",
    ...over,
  };
}
/** Two listed recipients and no `ownAddresses`: what `replyAllRecipients` admits. */
const AUDIENCE = {
  to: [
    { name: null, address: "me@example.test" },
    { name: "Piet", address: "piet@atelier.example" },
  ],
} as const;

/** The bar's chords, so the caps render off a real registry rather than off a typed string. */
const BAR_CHORDS = ["r", "shift+r", "shift+f", "a", "e", "b", "t", "s", "m", "u", "shift+i"] as const;

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let rerender: ((m: Record<string, unknown>) => Promise<void>) | null = null;
let rowWidth = WIDE;
/** The reading pane's width, or 0 for "this mount has no pane" — see the rect stub. */
let paneWidth = 0;
/** Every `ResizeObserver` callback the hook installed, so a width change can be delivered. */
let fire: Array<() => void> = [];
/**
 * THE FRAME QUEUE, and it is a real queue rather than an inline call for a reason worth writing
 * down: the hook COALESCES measurements behind `requestAnimationFrame` and remembers the id it
 * was given (`frameRef`), returning early while one is outstanding. A stub that ran the callback
 * inline and then returned the id left that id latched for ever — the first width change landed
 * and every later one was dropped, which reads exactly like a fold rule that ignores the width.
 * Queue, then drain: the callback clears the ref before the id is stored, as a browser does.
 */
let frames: Array<() => void> = [];
let frameSeq = 0;

const realRO = globalThis.ResizeObserver;
const realRAF = globalThis.requestAnimationFrame;
const realCAF = globalThis.cancelAnimationFrame;
const realRect = Element.prototype.getBoundingClientRect;
const realOffset = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth");

async function unmount(): Promise<void> {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null;
  host = null;
}

beforeEach(() => {
  fire = [];
  frames = [];
  frameSeq = 0;
  rowWidth = WIDE;
  paneWidth = 0;
  REPLY_EXTRA = 0;
  LAB = 0;
  READ_BTN = 0;
  FWD_LAB = 0;
  REPLY_LAB = 0;
  class RO {
    constructor(cb: () => void) { fire.push(cb); }
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  (globalThis as unknown as Record<string, unknown>).ResizeObserver = RO;
  (globalThis as unknown as Record<string, unknown>).requestAnimationFrame =
    (cb: () => void) => { frames.push(cb); return ++frameSeq; };
  (globalThis as unknown as Record<string, unknown>).cancelAnimationFrame = () => {};
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get(this: HTMLElement) { return widthOf(this); },
  });
  Element.prototype.getBoundingClientRect = function (this: Element) {
    let w = 0;
    if (this.classList.contains("msg-actions")) w = rowWidth;
    /* The READING PANE, and 0 by default so every case above measures the row exactly as it did
       before the room moved to the pane — the hook ignores a pane that reads 0. */
    else if (this.classList.contains("read-col")) w = paneWidth;
    /* Every measured element answers through its RECT as well as through `offsetWidth`, because
       the hook reads the float now (`widthOf`) — a stub that fed only the rounded accessor would
       leave the walk measuring zero. */
    else if (this instanceof HTMLElement) w = widthOf(this);
    return { x: 0, y: 0, top: 0, left: 0, right: w, bottom: 0, width: w, height: 0, toJSON: () => ({}) } as DOMRect;
  };
});

afterEach(async () => {
  await unmount();
  (globalThis as unknown as Record<string, unknown>).ResizeObserver = realRO;
  (globalThis as unknown as Record<string, unknown>).requestAnimationFrame = realRAF;
  (globalThis as unknown as Record<string, unknown>).cancelAnimationFrame = realCAF;
  Element.prototype.getBoundingClientRect = realRect;
  if (realOffset) Object.defineProperty(HTMLElement.prototype, "offsetWidth", realOffset);
});

async function mountBar(open: Record<string, unknown>): Promise<void> {
  await unmount();
  const { MessagePane } = await import("../app/shell/MessagePane.js");
  const { MessageChromeProvider } = await import("../app/shell/message-chrome.js");
  const { KeymapProvider, useKeyBindings } = await import("../app/shell/keymap.js");

  function Declare(): null {
    (useKeyBindings as (b: unknown[]) => void)(
      BAR_CHORDS.map((chord) => ({
        chord, group: "message", label: `runs ${chord}`, disabled: false, run: () => {},
      })),
    );
    return null;
  }

  host = document.createElement("div");
  host.className = "read-col";
  document.body.appendChild(host);
  root = createRoot(host);

  const tree = (message: Record<string, unknown>) =>
    h(NextIntlClientProvider, {
      locale: "en", messages, timeZone: "UTC", now: NOW,
      children: h(KeymapProvider as never, {
        children: [
          h(Declare, { key: "d" }),
          h(MessageChromeProvider as never, {
            key: "c",
            value: {
              replyTo: null, replyBody: "", onReplyBody: () => {}, closeReply: () => {},
              sendReply: () => {}, replySendState: () => ({ phase: "idle" }),
              openSenderMenu: () => {}, conversationOf: () => [],
              bodyOf: (m: Record<string, unknown>) => ({ text: m.snippet as string, state: "snippet" }),
              hydrateBody: () => {},
            },
            children: h(MessagePane as never, {
              message, tags: [], now: NOW, onAction: () => {}, onAddTag: () => {},
            } as never),
          } as never),
        ],
      } as never),
    });

  rerender = async (m) => { await act(async () => { root!.render(tree(m)); }); };
  await rerender(open);
}

/** Deliver a new row width to the hook the way a resize does: observe, then run the frame. */
async function setRow(px: number): Promise<void> {
  rowWidth = px;
  await act(async () => {
    for (const cb of fire) cb();
    const due = frames;
    frames = [];
    for (const cb of due) cb();
  });
}

const pill = (): HTMLElement => host!.querySelector<HTMLElement>(".msg-actions > .abar")!;
/** The admitted verbs, in order — the measurement's own answer, `compact` dropped. */
const admitted = (): BarVerb[] => {
  const raw = pill().getAttribute("data-admit");
  const named = raw === null ? [] : raw.split(" ").filter((x) => x !== "compact");
  return BAR_VERB_ORDER.map((v) => v.verb).filter((v) => named.includes(v));
};
/** The verbs THIS message renders at all, in row order. */
const present = (): Array<{ verb: BarVerb; seg: BarSeg | null }> =>
  BAR_VERB_ORDER.filter((v) => host!.querySelector(`.abar-row:not(.abar-measure) .abar-${v.verb}`) !== null)
    .map((v) => ({ verb: v.verb, seg: v.seg ?? null }));

/** What the admitted row costs, walked with the module's own cost rule. */
function used(): number {
  let total = W.reply + GAP + W.fwd + GAP + W.read;
  let open: BarSeg | null = null;
  for (const name of admitted()) {
    const seg = BAR_VERB_ORDER.find((v) => v.verb === name)!.seg ?? null;
    total += verbCost({ name, width: W[name], seg }, open, GAP);
    open = seg;
  }
  return total;
}

/* ══ 1. THE REPORTED CELL, BOTH WAYS ══════════════════════════════════════════════════════ */

describe("the fold uses the room the row has", () => {
  it("seats Later and Park at the reported width — the room group admission left empty", async () => {
    await mountBar(msg(AUDIENCE));
    expect(admitted(), "the reported cell does not seat the verbs its room can hold")
      .toEqual(["rall", "later", "aside"]);
    /* Named rather than counted, because the ORDER is the thing a reader sees: Later and Park
       inline, Resurface still folded because it genuinely does not fit (its width past the room left). */
    expect(admitted()).toContain("later");
    expect(admitted()).toContain("aside");
    expect(admitted(), "Resurface was seated in room that cannot hold it").not.toContain("resurface");
    expect(used()).toBe(543);
    expect(WIDE - PILL_PAD - used()).toBe(17);
  });

  it("a phone-width row folds exactly what it folds today — no regression at the narrow end", async () => {
    await mountBar(msg(AUDIENCE));
    await setRow(NARROW);
    expect(admitted(), "a narrow row grew a verb it has no room for").toEqual(["rall"]);
    expect(used()).toBe(410);
  });

  it("an unmeasured bar is its floor — the attribute is absent, not empty", async () => {
    /* The server render, the hydration pass and any client with no `ResizeObserver`. Asserted
       here because the walk's first result must not be able to arrive as "everything fits". */
    (globalThis as unknown as Record<string, unknown>).ResizeObserver = undefined;
    await mountBar(msg(AUDIENCE));
    expect(pill().hasAttribute("data-admit"), "an unmeasured bar published an admission").toBe(false);
  });
});

describe("the compact floor counts the read switch's touch floor", () => {
  it("a 44px minimum is what the words cannot give back — no verb is seated in room that is not there", async () => {
    /* The same arithmetic as before, lifted by 200 on the Reply group so the room (490) is above
       the 400 at which the read switch folds whole (the next describe): the floor is 507 and
       the room 490, so the read switch drops its words. The label is 100 of a 118 button whose
       `min-width` is 44: dropping it saves 74, not 100. Counting 100 would seat Later
       (507 - 100 + 71 = 478 <= 490) in a row the browser paints at 504 — the overflow the frames
       measured in German at 375 and 430 once the 44px target landed. */
    const style = document.createElement("style");
    style.textContent = ".abar-read { min-width: 44px; }";
    document.head.appendChild(style);
    try {
      LAB = 100;
      READ_BTN = 118;
      REPLY_EXTRA = 200;
      await mountBar(msg());
      await setRow(490 + PILL_PAD);
      const raw = pill().getAttribute("data-admit") ?? "";
      expect(raw.split(" "), "the floor did not yield its words").toContain("compact");
      expect(raw.split(" "), "the switch folded above 400 on a fine pointer").not.toContain("read-folded");
      expect(admitted(), "Later was seated with the whole label counted as saved").toEqual([]);
      // CONTROL: 505 still needs the compact floor, and the true saving seats Later (504 <= 505).
      await setRow(505 + PILL_PAD);
      expect((pill().getAttribute("data-admit") ?? "").split(" ")).toContain("compact");
      expect(admitted()).toEqual(["later"]);
    } finally {
      REPLY_EXTRA = 0;
      style.remove();
    }
  });
});

/* ══ UNDER 400px OF ROOM THE READ SWITCH LEAVES THE ROW WHOLE ═══════════════════════════ */

describe("the read switch folds into More under 400px of room", () => {
  it("at 290 the switch is in the menu, the floor loses the whole button, and Later takes the room it frees", async () => {
    /* The floor is 307 (Reply 60 + 6 + Forward 70 + 6 + the read group 165); folding the 118
       button and its gap leaves room enough that Later is seated — a bar that reads
       Reply · Forward · Later · ⌄ with no dot standing alone. No `compact`: the words did not
       have to go, the button did. */
    LAB = 100;
    READ_BTN = 118;
    await mountBar(msg());
    await setRow(290 + PILL_PAD);
    const raw = (pill().getAttribute("data-admit") ?? "").split(" ");
    expect(raw, "the switch did not fold under 400").toContain("read-folded");
    expect(raw, "a compact token that hides nothing — the switch is already gone").not.toContain("compact");
    expect(admitted()).toEqual(["later"]);
    // the pair rule in the DOM: the row's switch hidden, the menu's twin shown — never both
    expect(pill().querySelector(".abar-row .abar-read")).not.toBeNull();
  });

  it("at the desktop — 1024 and up, a fine pointer — the switch never folds; the compact form stands as before", async () => {
    /* jsdom has no matchMedia, which the hook reads as the narrow shell; a desktop answers both
       questions no, so the 290px room that folds above takes the compact concession instead. */
    Object.defineProperty(window, "matchMedia", {
      configurable: true, writable: true,
      value: (query: string) => ({ matches: false, media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; } }),
    });
    try {
      LAB = 100;
      READ_BTN = 118;
      await mountBar(msg());
      await setRow(290 + PILL_PAD);
      const raw = (pill().getAttribute("data-admit") ?? "").split(" ");
      expect(raw, "the fold reached the desktop").not.toContain("read-folded");
      expect(raw, "the desktop's compact concession is gone").toContain("compact");
    } finally {
      delete (window as unknown as Record<string, unknown>).matchMedia;
    }
  });

  it("at 400 of room nothing folds on a fine pointer — the edge is exact", async () => {
    /* The threshold is the BAR's room — the container's content box, what `--abar-room`
       publishes — not the width left after the pill's own padding. */
    LAB = 100;
    READ_BTN = 118;
    await mountBar(msg());
    await setRow(400);
    const raw = (pill().getAttribute("data-admit") ?? "").split(" ");
    expect(raw).not.toContain("read-folded");
    await setRow(399);
    expect((pill().getAttribute("data-admit") ?? "").split(" ")).toContain("read-folded");
  });
});

describe("the words give way, never the targets (DESIGN-026 §2.1, the 320px ruling)", () => {
  /* The floor is 307; the read switch's label 100 saves 100 (no min-width in jsdom). Forward's
     word is 80 and Reply's 50; an icon face is 14 wide, so they save 66 and 36. */
  const token = () => (pill().getAttribute("data-admit") ?? "").split(" ");
  it("room for the floor keeps every word — no concession", async () => {
    LAB = 100; FWD_LAB = 80; REPLY_LAB = 50;
    await mountBar(msg());
    await setRow(307 + PILL_PAD);
    expect(token()).not.toContain("compact");
    expect(token()).not.toContain("compact-fwd");
  });
  it("the read switch's words go first; Forward and Reply keep theirs while that is enough", async () => {
    LAB = 100; FWD_LAB = 80; REPLY_LAB = 50;
    await mountBar(msg());
    await setRow(207 + PILL_PAD);
    expect(token()).toContain("compact");
    expect(token(), "Forward gave up its word while the floor already fitted").not.toContain("compact-fwd");
  });
  it("THEN FORWARD'S WORD, before Reply's", async () => {
    LAB = 100; FWD_LAB = 80; REPLY_LAB = 50;
    await mountBar(msg());
    await setRow(150 + PILL_PAD);
    expect(token(), "the floor overflowed with Forward still spelling its word").toContain("compact-fwd");
    expect(token(), "Reply gave up its word before Forward's was enough").not.toContain("compact-reply");
  });
  it("an icon face is not free: the word saves its width LESS the icon's", async () => {
    // 207 - (80 - 14) = 141 > 135, so Reply's word must go too; counting the whole word (127)
    // would leave a row the browser paints 6px wider than its room.
    LAB = 100; FWD_LAB = 80; REPLY_LAB = 50;
    await mountBar(msg());
    await setRow(135 + PILL_PAD);
    expect(token()).toContain("compact-reply");
  });
  it("THEN REPLY'S — and the row is never measured wider than its room while a word can go", async () => {
    LAB = 100; FWD_LAB = 80; REPLY_LAB = 50;
    await mountBar(msg());
    await setRow(120 + PILL_PAD);
    expect(token()).toEqual(expect.arrayContaining(["compact", "compact-fwd", "compact-reply"]));
    expect(admitted(), "a verb was seated on a floor that does not fit").toEqual([]);
  });
});

/* ══ 2. MAXIMALITY — the reading that refuses group admission ══════════════════════════════ */

describe("the room left over cannot seat the next folded verb", () => {
  it("holds at every row width from the compact floor to everything seated", async () => {
    await mountBar(msg(AUDIENCE));
    const all = present();
    expect(all.map((x) => x.verb), "the widest shape did not mount all seven admissible verbs")
      .toEqual(["rall", "later", "aside", "resurface", "tag", "screen", "move"]);
    let sawFolded = 0;
    let sawSeated = 0;
    for (let px = 307; px <= 900; px += 1) {
      await setRow(px + PILL_PAD);
      const seated = admitted();
      const slack = px - used();
      expect(slack, `${px}px: the admitted row is wider than the pill`).toBeGreaterThanOrEqual(0);
      const next = all[seated.length];
      if (next === undefined) { sawSeated += 1; continue; }
      sawFolded += 1;
      const openSeg = seated.length === 0
        ? null
        : BAR_VERB_ORDER.find((v) => v.verb === seated[seated.length - 1]!)!.seg ?? null;
      const cost = verbCost({ name: next.verb, width: W[next.verb], seg: next.seg }, openSeg, GAP);
      expect(
        cost,
        `${px}px: ${seated.length} verbs seated with ${slack}px left, and ${next.verb} needs ` +
          `${cost}px — the row has room the fold is not using`,
      ).toBeGreaterThan(slack);
    }
    /* NOT VACUOUS IN EITHER DIRECTION: the sweep has to meet rows that fold something (or the
       assertion above never runs) and rows that seat everything (or "no verb is refused with
       room to spare" is being claimed about a sweep that never had room to spare). */
    expect(sawFolded, "the sweep never met a row with a folded verb").toBeGreaterThan(100);
    expect(sawSeated, "the sweep never met a row with every verb seated").toBeGreaterThan(10);
  });

  it("the inline count never falls as the pill's own room grows", async () => {
    /* MONOTONE IN THE ROOM, not in the viewport — see the header. At a fixed control size this
       is the greedy prefix's own property, and it is the half of the report that IS checkable. */
    await mountBar(msg(AUDIENCE));
    let last = -1;
    for (let px = 200; px <= 900; px += 1) {
      await setRow(px + PILL_PAD);
      const n = admitted().length;
      expect(n, `${px}px: widening the row TOOK a verb off the pill`).toBeGreaterThanOrEqual(last);
      last = n;
    }
    expect(last, "the sweep never reached a fully seated row").toBe(7);
  });
});

/* ══ 3. ONE ORDER, ONE RULE — a single message and a threaded one ══════════════════════════ */

describe("the fold does not branch on the message", () => {
  it("the only verb the message decides is Reply all — and the code says why", async () => {
    /* WHAT THE CODE DECIDES TODAY, stated so the claim is checkable: the row grows a Reply-all
       group exactly when `replyAllRecipients(message, ownAddresses) !== null`, i.e. when "all" is
       more people than plain Reply's one recipient. Forward has its own two predicates
       (`no_forward`, and the mirror holding the row) and neither is about threading. Nothing else
       in the bar reads the message's shape. */
    await mountBar(msg());
    const solo = present().map((x) => x.verb);
    await rerender!(msg(AUDIENCE));
    const thread = present().map((x) => x.verb);
    expect(solo, "a single message rendered a Reply-all verb").not.toContain("rall");
    expect(thread, "a threaded message rendered no Reply-all verb").toContain("rall");
    expect(
      thread.filter((v) => v !== "rall"),
      "the two shapes differ by something other than Reply all",
    ).toEqual(solo);
  });

  it("at ONE row width, the threaded set minus Reply all is contained in the single set", async () => {
    /**
     * AND IT IS CONTAINMENT, NOT EQUALITY, which is the correction the measurement forced.
     * Dropping `rall` frees 103px the tail then takes: at the reported width the 1:1 shape seats
     * `later aside resurface` and the threaded one `rall later aside`. Asserting equality
     * apart from Reply all would refuse the mechanism working exactly as it should.
     */
    await mountBar(msg(AUDIENCE));
    const thread = admitted();
    await rerender!(msg());
    await setRow(WIDE);
    const solo = admitted();

    expect(thread).toEqual(["rall", "later", "aside"]);
    expect(solo).toEqual(["later", "aside", "resurface"]);
    for (const v of thread.filter((x) => x !== "rall")) {
      expect(solo, `${v} stands on the threaded bar and is folded on the single one`).toContain(v);
    }
    /* Both are prefixes of the ONE order restricted to the verbs each message renders — which is
       what "one fold rule for threaded and single alike" means when the sets are not equal. */
    for (const [label, set] of [["threaded", thread], ["single", solo]] as const) {
      const order = BAR_VERB_ORDER.map((v) => v.verb).filter(
        (v) => set.includes(v) || set.length === 0 || BAR_VERB_ORDER.findIndex((x) => x.verb === v) > 0,
      );
      const restricted = order.filter((v) => v === "rall" ? set.includes("rall") : true);
      expect(set, `the ${label} set is not a prefix of the one order`)
        .toEqual(restricted.slice(0, set.length));
    }
  });
});

/* ══ 4. A FOLDED VERB KEEPS ITS MENU ROW AND ITS SHORTCUT ═════════════════════════════════ */

describe("folding a verb takes nothing away from it", () => {
  /** `action-bar.css`, read from the tree, so the cascade below is the shipped one. */
  function abar(): string {
    const REL = "app/shell/action-bar.css";
    const p = [resolve(process.cwd(), REL), resolve(process.cwd(), "apps/webapp", REL)].find(existsSync);
    expect(p, `could not find ${REL} from ${process.cwd()}`).toBeTruthy();
    return readFileSync(p!, "utf8");
  }

  it("every verb the row folds is displayed in the menu, at the reported width and narrow", async () => {
    const style = document.createElement("style");
    style.textContent = abar();
    document.head.appendChild(style);
    try {
      await mountBar(msg(AUDIENCE));
      for (const px of [WIDE, NARROW]) {
        await setRow(px);
        const more = host!.querySelector<HTMLButtonElement>(".abar-more")!;
        await act(async () => { more.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
        const seated = admitted();
        const folded = present().map((x) => x.verb).filter((v) => !seated.includes(v));
        expect(folded.length, `${px}px: nothing was folded, so nothing is being checked`)
          .toBeGreaterThan(0);
        for (const v of folded) {
          const twin = host!.querySelector<HTMLElement>(`.mmenu .mm-${v}`);
          expect(twin, `${px}px: ${v} is folded and has no menu row at all`).not.toBeNull();
          expect(
            getComputedStyle(twin!).display,
            `${px}px: ${v} is folded in the row AND hidden in the menu — reachable from nowhere`,
          ).not.toBe("none");
        }
        for (const v of seated) {
          const twin = host!.querySelector<HTMLElement>(`.mmenu .mm-${v}`);
          expect(
            twin === null || getComputedStyle(twin).display === "none",
            `${px}px: ${v} stands in the row AND in the menu`,
          ).toBe(true);
        }
        await act(async () => { more.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
      }
    } finally {
      style.remove();
    }
  });

  it("the keycaps the pill carries do not change with the width — a fold takes no shortcut", async () => {
    /**
     * The caps are drawn from the live registry by `<Key>`, and the row button for a folded verb
     * stays in the markup with its cap — the stylesheet hides it, nothing unmounts it. So the
     * chord a reader learned at one width is still the chord at another, and the verb is still
     * reachable by it: the bindings are declared by the VIEW over its cursor
     * (`message-verbs.ts`), and no admission token is an operand anywhere in that path.
     *
     * Read as a SET rather than as a list, because the DOM order of the caps is the row's and the
     * row is what the fold rearranges the visibility of.
     */
    await mountBar(msg(AUDIENCE));
    const caps = (): string[] =>
      [...host!.querySelectorAll<HTMLElement>(".abar-row:not(.abar-measure) kbd")]
        .map((k) => (k.textContent ?? "").trim())
        .sort();
    await setRow(WIDE);
    const wide = caps();
    expect(wide.length, "the pill printed no keycaps — the registry is not behind it")
      .toBeGreaterThan(5);
    await setRow(NARROW);
    expect(caps(), "a narrower row lost a keycap, so a folded verb lost its shortcut").toEqual(wide);
  });
});

/* ══ 4b. THE ROOM IS THE READING PANE, AND PUBLISHING IT IS NOT A FEEDBACK LOOP ═══════════ */

describe("the bar's room is the reading pane, not the reading column", () => {
  /**
   * Ruled 2026-09-10: the body keeps its column, the bar uses the pane. Measured in Chromium at
   * 1440, the pane is 740px on paper against the column's 572 — which is what brings Later, Park
   * and Resurface inline there.
   *
   * The property is what SETS the row's width in `action-bar.css`, so it may only ever carry the
   * PANE's number. Publishing the row's own width back onto the row was a feedback loop and it
   * was measured: `width: <the row's 310px>` against a `calc(50% - 155px)` margin resolved
   * against `.msg`'s 322px content box took 12px off every pass, and the phone cells drifted —
   * 390's room 310 → 292, and the 640 reply-all bar lost a verb. Both halves are asserted here.
   */
  it("admits more from the pane's width than from the row's, and publishes it", async () => {
    await mountBar(msg(AUDIENCE));
    const fromRow = admitted();
    expect(fromRow, "the row-only reading is not the reported cell").toEqual([
      "rall", "later", "aside",
    ]);
    const box = () => host!.querySelector<HTMLElement>(".msg-actions")!;
    expect(box().style.getPropertyValue("--abar-room"), "a mount with no pane published a room")
      .toBe("");

    /* The pane, 740px — the measured 1440 value — while the row's own box stays at the column. */
    paneWidth = 740 + PILL_PAD;
    await setRow(WIDE);
    expect(box().style.getPropertyValue("--abar-room"), "the pane's room was not published")
      .toBe(`${740 + PILL_PAD}px`);
    expect(admitted(), "the pane's extra room seated nothing").toEqual([
      "rall", "later", "aside", "resurface", "tag",
    ]);
    /* The reported three, by name, at the width the report came from. */
    for (const v of ["later", "aside", "resurface"] as const) {
      expect(admitted(), `${v} is folded in a 740px pane`).toContain(v);
    }
  });

  it("a long letter's vertical scrollbar is not room: the row stays inside the pane's scrollport", async () => {
    /* A pane's border box includes its classic scrollbar; the row set to that width overflowed the
       scrollport by the gutter, and the pane drew a sideways scrollbar under every long letter. */
    paneWidth = 740 + PILL_PAD;
    await mountBar(msg(AUDIENCE));
    Object.defineProperty(host!, "offsetWidth", { configurable: true, get: () => paneWidth });
    Object.defineProperty(host!, "clientWidth", { configurable: true, get: () => paneWidth - 15 });
    await setRow(WIDE);
    const box = host!.querySelector<HTMLElement>(".msg-actions")!;
    expect(box.style.getPropertyValue("--abar-room")).toBe(`${740 + PILL_PAD - 15}px`);
  });

  it("a pane reading 0 leaves the row measuring itself, and the property removed", async () => {
    /* A mid-layout frame, or a mount with no pane at all (the selection pill in the list
       column's foot, a stream card's bar): the row is what it has always been. */
    paneWidth = 740 + PILL_PAD;
    await mountBar(msg(AUDIENCE));
    await setRow(WIDE);
    const box = () => host!.querySelector<HTMLElement>(".msg-actions")!;
    expect(box().style.getPropertyValue("--abar-room")).toBe(`${740 + PILL_PAD}px`);
    paneWidth = 0;
    await setRow(WIDE);
    expect(box().style.getPropertyValue("--abar-room"), "a pane that stopped reading left a room behind")
      .toBe("");
    expect(admitted(), "the row did not fall back to its own width").toEqual([
      "rall", "later", "aside",
    ]);
  });
});

/* ══ 5. THE SEGMENTS STILL READ AS ONE CONTROL ════════════════════════════════════════════ */

describe("a partly seated segment is still one control", () => {
  it("the trailing cap rides the LAST seated member, at every partial fill", async () => {
    /**
     * `.abar-seg .abar-b:last-child` names Resurface and Move structurally, which is the wrong
     * button for every partial segment — a segment ending at Later would draw a square right
     * edge against the pill's ground. The rules key on "admitted, and the next member is not",
     * which the prefix law makes exactly the last one that stands.
     *
     * jsdom resolves attribute selectors and `:not()`, which is all those rules use, so WHICH
     * rule wins here is the answer a browser gives. Two of its limits shape the reading, and
     * both are read rather than assumed: it does not resolve custom properties (so the capped
     * button answers the literal `var(--r-pill)`), and it does not expand the `border-radius`
     * SHORTHAND into longhands (so anything whose radius comes from a shorthand answers the
     * empty string). Read through `getPropertyValue`, not the camelCase accessor, which answers
     * only a longhand the cascade set DIRECTLY.
     *
     * So the reading is scoped to a PARTIAL segment — a segment seated up to a member that is
     * not its structural last — which is precisely the case the new rules exist for and the case
     * `:last-child` gets wrong. A FULL segment's cap comes from that pre-existing shorthand and
     * is not this slice's to assert here; the two counters keep either arm from being vacuous.
     */
    const CAP = "var(--r-pill)";
    const style = document.createElement("style");
    style.textContent = abarCss();
    document.head.appendChild(style);
    try {
      await mountBar(msg(AUDIENCE));
      const cap = (el: HTMLElement): string =>
        getComputedStyle(el).getPropertyValue("border-top-right-radius").trim();
      let sawLast = 0;
      let sawMiddle = 0;
      for (const px of [200, 300, 400, 500, 560, 620, 700, 800, 900]) {
        await setRow(px + PILL_PAD);
        const seated = admitted();
        for (const { seg } of BAR_SEGMENTS) {
          const members = BAR_VERB_ORDER.filter((v) => v.seg === seg).map((v) => v.verb);
          const on = members.filter((m) => seated.includes(m));
          if (on.length === 0) continue;
          const last = on[on.length - 1]!;
          const structuralLast = members[members.length - 1]!;
          if (last !== structuralLast) {
            const el = host!.querySelector<HTMLElement>(`.abar-row:not(.abar-measure) .abar-${last}`)!;
            expect(
              cap(el),
              `${px}px: ${seg} is seated up to ${last} and that button has no trailing cap — ` +
                `\`:last-child\` names ${structuralLast}, which is folded`,
            ).toBe(CAP);
            sawLast += 1;
          }
          /* …and the members before it do NOT get one, or the segment reads as loose capsules. */
          for (const mid of on.slice(0, -1)) {
            const m = host!.querySelector<HTMLElement>(`.abar-row:not(.abar-measure) .abar-${mid}`)!;
            expect(
              cap(m),
              `${px}px: ${mid} carries a trailing cap in the middle of ${seg}`,
            ).not.toBe(CAP);
            sawMiddle += 1;
          }
        }
      }
      /* Neither arm may be vacuous: the sweep has to reach segments that END at their last
         member (so the cap assertion runs) and segments with a member BEFORE the last one (so
         the not-capped assertion runs on a real middle button). */
      expect(sawLast, "the sweep never met a PARTIALLY seated segment — nothing was asserted")
        .toBeGreaterThan(3);
      expect(sawMiddle, "the sweep never met a segment with a member before its last")
        .toBeGreaterThan(3);
    } finally {
      style.remove();
    }
  });

  it("a segment with every member folded is not in the row at all", async () => {
    /* An empty `.abar-seg` at `display: flex` would paint its panel ground and pay the row's
       gap for nothing, which is the hollow the pill's hug reading refuses. The wrapper follows
       its FIRST member — exact, by the prefix law. */
    const style = document.createElement("style");
    style.textContent = abarCss();
    document.head.appendChild(style);
    try {
      await mountBar(msg(AUDIENCE));
      await setRow(NARROW);
      expect(admitted(), "the narrow row seated a horizon, so nothing is being checked")
        .toEqual(["rall"]);
      for (const { seg } of BAR_SEGMENTS) {
        const wrap = host!.querySelector<HTMLElement>(`.abar-row:not(.abar-measure) .abar-${seg}`)!;
        expect(getComputedStyle(wrap).display, `${seg} stands in the row with every member folded`)
          .toBe("none");
      }
      await setRow(WIDE);
      const defer = host!.querySelector<HTMLElement>(".abar-row:not(.abar-measure) .abar-defer")!;
      expect(getComputedStyle(defer).display, "the horizons' wrapper is folded with Later seated")
        .not.toBe("none");
      const file = host!.querySelector<HTMLElement>(".abar-row:not(.abar-measure) .abar-file")!;
      expect(getComputedStyle(file).display, "filing's wrapper stands with every member folded")
        .toBe("none");
    } finally {
      style.remove();
    }
  });
});

function abarCss(): string {
  const REL = "app/shell/action-bar.css";
  const p = [resolve(process.cwd(), REL), resolve(process.cwd(), "apps/webapp", REL)].find(existsSync);
  expect(p, `could not find ${REL} from ${process.cwd()}`).toBeTruthy();
  return readFileSync(p!, "utf8");
}
