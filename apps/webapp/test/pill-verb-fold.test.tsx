/** @vitest-environment jsdom */
import { act, cleanup, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountPanel, openMore, panel } from "./_reader-1-panel.js";

/**
 * THE PANEL USES THE WIDTH IT HAS — the fold driven from a stubbed room, both ways.
 *
 * ══ WHAT WAS REPORTED, AND WHAT IT TURNED OUT TO BE ═══════════════════════════════════════
 *
 * *"The pill shows Reply · Reply all · Forward · Mark unread · ▾ and folds Later, Park,
 * Resurface, Tag, Screening, Move, Draft reply and Delete behind the ▾ — while the row has room
 * for several more."* The GRANULARITY of the fold was wrong: verbs were admitted in blocks, so a
 * row with room for Later and Park folded both along with Resurface.
 *
 * ══ THE THREE ARMS ═════════════════════════════════════════════════════════════════════════
 *
 *  · MAXIMALITY — the room left over cannot seat the next folded verb.
 *  · MONOTONE IN THE PANEL's OWN ROOM — widen the room and the inline count never falls.
 *  · ONE ORDER, ONE RULE, FOR EVERY MESSAGE — the only verb that depends on the message is Reply
 *    all.
 *
 * RE-POINTED (share reader-1, the switch's older tests): the bar is the new reader's action panel (the kit's
 * `ActionPanel`, fitted by `fitPanel` on the nodes themselves: what does not fit folds behind More by rank, the
 * highest first, and then the floor (Reply, Forward, the read slot) gives up its words, the read slot's first, then
 * Forward's, then Reply's). Mounted through the share's door over the reader (`_reader-1-panel.tsx`). jsdom lays
 * nothing out, so the panel's own reads are the seam: the bar's `scrollWidth` is the sum of what it shows (each
 * verb's width with its word or as its sign, and a gap between two), the panel's `clientWidth` is the room. The
 * widths are today's MEASURED ones (Chromium, paper/en/1440): the floor is 60 + 6 + 96 + 6 + 139 = 307, More is not
 * counted, as today's floor did not count it. Each expectation as it stood; the verbs the panel holds are the new
 * design's (Screening and Move stand behind More, never in the panel: `action-bar.test.ts`'s rows).
 */

/** Each verb's width with its word, and as its sign alone (a floor verb's word saves its width LESS the icon's). */
const W: Record<string, { word: number; sign: number }> = {
  reply: { word: 60, sign: 24 },
  forward: { word: 96, sign: 30 },
  read: { word: 139, sign: 39 },
  reply_all: { word: 97, sign: 97 },
  later: { word: 65, sign: 65 },
  aside: { word: 62, sign: 62 },
  resurface: { word: 93, sign: 93 },
  tag: { word: 36, sign: 36 },
};
const GAP = 6;
/** The floor: Reply, Forward and the read slot, every word kept. */
const FLOOR = W.reply!.word + GAP + W.forward!.word + GAP + W.read!.word;
/** The panel's room the report's cell had, and a phone-width one: the floor plus Reply all. */
const WIDE = 560;
const NARROW = 410;
/** The verbs the panel can fold, in the order they come back as the room grows (the lowest rank first). */
const FOLDABLE = ["reply_all", "later", "aside", "resurface", "tag"] as const;

/** Two listed recipients besides the sender: Reply all is more people than Reply. */
const AUDIENCE = {
  to: [
    { name: null, address: "me@example.test" },
    { name: "Piet", address: "piet@atelier.example" },
  ],
} as const;
const TAGS = { "t-kiln": "Kiln" };

let room = WIDE;
/** Every `ResizeObserver` callback the panel installed, so a change of room can be delivered. */
let fire: Array<() => void> = [];
const realRO = globalThis.ResizeObserver;

const verbsOf = (bar: Element): HTMLElement[] => [...bar.querySelectorAll<HTMLElement>("[data-rank]")];
function barWidth(bar: Element): number {
  const shown = verbsOf(bar).filter((v) => !v.hidden);
  const sum = shown.reduce((n, v) => {
    const w = W[v.dataset.id ?? ""] ?? { word: 0, sign: 0 };
    return n + (v.dataset.short === undefined ? w.word : w.sign);
  }, 0);
  return sum + GAP * Math.max(0, shown.length - 1);
}

beforeEach(() => {
  fire = [];
  room = WIDE;
  class RO {
    constructor(cb: () => void) {
      fire.push(cb);
    }
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  (globalThis as unknown as Record<string, unknown>).ResizeObserver = RO;
  vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(function (this: HTMLElement) {
    return this.getAttribute("role") === "toolbar" ? barWidth(this) : 0;
  });
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("oh-actionpanel") ? room : 0;
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  (globalThis as unknown as Record<string, unknown>).ResizeObserver = realRO;
});

/** The open letter's panel, at the room `room` stands at. */
async function mountBar(over: Record<string, unknown> = {}, tags = true): Promise<void> {
  cleanup();
  fire = [];
  mountPanel(over, tags ? { tags: TAGS } : {});
  await act(async () => {});
}

/** Deliver a new room to the panel the way a resize does. */
async function setRow(px: number): Promise<void> {
  room = px;
  await act(async () => {
    for (const cb of fire) cb();
  });
}

const byId = (id: string): HTMLElement | null => panel().querySelector<HTMLElement>(`[data-id="${id}"]`);
/** The verbs this letter's panel holds at all, foldable ones only, in their order of coming back. */
const present = (): string[] => FOLDABLE.filter((id) => byId(id) !== null);
/** The foldable verbs standing in the panel, in that order. */
const admitted = (): string[] => present().filter((id) => !byId(id)!.hidden);
/** Which floor verbs gave up their words: today's tokens (`compact` the read slot's, then Forward's, Reply's). */
const token = (): string[] =>
  [
    ["read", "compact"],
    ["forward", "compact-fwd"],
    ["reply", "compact-reply"],
  ]
    .filter(([id]) => byId(id!)?.dataset.short !== undefined)
    .map(([, name]) => name!);
/** What the standing panel costs. */
const used = (): number => barWidth(panel());

/* ══ 1. THE WORDS GIVE WAY, NEVER THE TARGETS ═════════════════════════════════════════════ */

describe("the words give way, never the targets (DESIGN-026 §2.1, the 320px ruling)", () => {
  /* The floor is 307; the read slot's word saves 100, Forward's 66 and Reply's 36 (the word LESS its sign). */
  it("room for the floor keeps every word — no concession", async () => {
    room = FLOOR;
    await mountBar({}, false);
    expect(token()).not.toContain("compact");
    expect(token()).not.toContain("compact-fwd");
  });
  it("the read switch's words go first; Forward and Reply keep theirs while that is enough", async () => {
    room = 207;
    await mountBar({}, false);
    expect(token()).toContain("compact");
    expect(token(), "Forward gave up its word while the floor already fitted").not.toContain("compact-fwd");
  });
  it("THEN FORWARD'S WORD, before Reply's", async () => {
    room = 150;
    await mountBar({}, false);
    expect(token(), "the floor overflowed with Forward still spelling its word").toContain("compact-fwd");
    expect(token(), "Reply gave up its word before Forward's was enough").not.toContain("compact-reply");
  });
  it("an icon face is not free: the word saves its width LESS the icon's", async () => {
    // 207 - (96 - 30) = 141 > 135, so Reply's word must go too; counting the whole word
    // would leave a row the browser paints 6px wider than its room.
    room = 135;
    await mountBar({}, false);
    expect(token()).toContain("compact-reply");
  });
  it("THEN REPLY'S — and the row is never measured wider than its room while a word can go", async () => {
    room = 120;
    await mountBar({}, false);
    expect(token()).toEqual(expect.arrayContaining(["compact", "compact-fwd", "compact-reply"]));
    expect(admitted(), "a verb was seated on a floor that does not fit").toEqual([]);
  });
});

/* ══ 2. MAXIMALITY ═════════════════════════════════════════════════════════════════════════ */

describe("the room left over cannot seat the next folded verb", () => {
  it("holds at every row width from the compact floor to everything seated", async () => {
    await mountBar(AUDIENCE);
    const all = present();
    expect(all, "the widest shape did not mount every verb the panel can fold").toEqual([
      "reply_all",
      "later",
      "aside",
      "resurface",
      "tag",
    ]);
    let sawFolded = 0;
    let sawSeated = 0;
    for (let px = FLOOR; px <= 900; px += 1) {
      await setRow(px);
      const seated = admitted();
      const slack = px - used();
      expect(slack, `${px}px: the standing panel is wider than its room`).toBeGreaterThanOrEqual(0);
      const next = all[seated.length];
      if (next === undefined) {
        sawSeated += 1;
        continue;
      }
      sawFolded += 1;
      expect(seated, `${px}px: the panel did not fold from the end of its order`).toEqual(all.slice(0, seated.length));
      const cost = W[next]!.word + GAP;
      expect(
        cost,
        `${px}px: ${seated.length} verbs seated with ${slack}px left, and ${next} needs ` +
          `${cost}px — the row has room the fold is not using`,
      ).toBeGreaterThan(slack);
    }
    /* NOT VACUOUS IN EITHER DIRECTION: the sweep has to meet rows that fold something and rows that seat
       everything. */
    expect(sawFolded, "the sweep never met a row with a folded verb").toBeGreaterThan(100);
    expect(sawSeated, "the sweep never met a row with every verb seated").toBeGreaterThan(10);
  });

  it("the inline count never falls as the pill's own room grows", async () => {
    await mountBar(AUDIENCE);
    let last = -1;
    for (let px = 200; px <= 900; px += 1) {
      await setRow(px);
      const n = admitted().length;
      expect(n, `${px}px: widening the row TOOK a verb off the panel`).toBeGreaterThanOrEqual(last);
      last = n;
    }
    expect(last, "the sweep never reached a fully seated row").toBe(FOLDABLE.length);
  });
});

/* ══ 3. ONE ORDER, ONE RULE — a single message and one to several people ══════════════════ */

describe("the fold does not branch on the message", () => {
  it("the only verb the message decides is Reply all — and the code says why", async () => {
    /* The panel grows Reply all exactly when "all" is more people than plain Reply's one recipient; nothing
       else in it reads the message's shape. */
    await mountBar();
    const solo = present();
    await mountBar(AUDIENCE);
    const thread = present();
    expect(solo, "a single message rendered a Reply-all verb").not.toContain("reply_all");
    expect(thread, "a threaded message rendered no Reply-all verb").toContain("reply_all");
    expect(
      thread.filter((v) => v !== "reply_all"),
      "the two shapes differ by something other than Reply all",
    ).toEqual(solo);
  });
});

/* ══ 4. A FOLDED VERB KEEPS ITS MENU ROW AND ITS SHORTCUT ═════════════════════════════════ */

describe("folding a verb takes nothing away from it", () => {
  it("every verb the row folds is displayed in the menu, at the reported width and narrow", async () => {
    await mountBar(AUDIENCE);
    for (const px of [WIDE, NARROW]) {
      await setRow(px);
      const seated = admitted();
      const folded = present().filter((v) => !seated.includes(v));
      expect(folded.length, `${px}px: nothing was folded, so nothing is being checked`).toBeGreaterThan(0);
      await openMore();
      const menu = within(screen.getByRole("menu", { name: "More" }));
      const named = (id: string): string => byId(id)!.getAttribute("aria-label") ?? "";
      for (const v of folded) {
        expect(
          menu.queryByRole("menuitem", { name: named(v) }),
          `${px}px: ${v} is folded and has no menu row at all`,
        ).not.toBeNull();
      }
      for (const v of seated) {
        expect(menu.queryByRole("menuitem", { name: named(v) }), `${px}px: ${v} stands in the row AND in the menu`)
          .toBeNull();
      }
      await openMore();
    }
  });

  it("the keycaps the pill carries do not change with the width — a fold takes no shortcut", async () => {
    /* Read as a SET rather than as a list, because the DOM order of the caps is the row's and the row is what the
       fold rearranges the visibility of. */
    await mountBar(AUDIENCE);
    const caps = (): string[] =>
      [...panel().querySelectorAll<HTMLElement>("kbd")].map((k) => (k.textContent ?? "").trim()).sort();
    await setRow(WIDE);
    const wide = caps();
    expect(wide.length, "the pill printed no keycaps — the registry is not behind it").toBeGreaterThan(5);
    await setRow(NARROW);
    expect(caps(), "a narrower row lost a keycap, so a folded verb lost its shortcut").toEqual(wide);
  });
});
