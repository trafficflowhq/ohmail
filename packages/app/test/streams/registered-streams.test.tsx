/** @vitest-environment jsdom */
/**
 * NEWS AND RECEIPTS ON THEIR OWN SEATS, over the tests' door of a mount: the real registrations of
 * `mailPlaces()` and the real reader through the real `Frame`, over the fake host that hands the mail ground above
 * the panes. No shell is mounted and no context is provided by hand: what a place lists, the ground presented; what
 * a press or a read writes, the engine was sent.
 *
 * jsdom has no layout, so where a case reads the stream by scrolling, each item stands 300 px tall one under the
 * other in a window of 600 px (as the stream's own read cases stand it).
 */
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { EngineMessage, EngineMutation, FeedView } from "@ohmail/wire";
import type { MailboxFacts } from "@ohmail/app-logic/mail-state/mail-state";
import { feedPartition } from "../../../../test/support/engine-fixtures.js";
import { SEEN_QUIET_MS } from "@ohmail/app-logic/reading/seen-batch";
import { SYNC_BOOTSTRAPPING, SYNC_SETTLED } from "@ohmail/app-logic/session/sync-scheduler";
import { hitAt, issue, mountStreamFrame, receipt } from "./registered-world.js";

/** Geometry belongs to the full pile, even when the browser has mounted only one window. */
let geometryMail: ReturnType<typeof mountStreamFrame>["mail"];
function seat(options: Parameters<typeof mountStreamFrame>[0]) {
  const mounted = mountStreamFrame(options);
  geometryMail = mounted.mail;
  return {
    ...mounted,
    replaceEngine: (...args: Parameters<typeof mounted.replaceEngine>) => {
      geometryMail = mounted.replaceEngine(...args);
      return geometryMail;
    },
  };
}

/** What was sent, by kind, letters and how, in order. */
const sent = (mail: { mutations: EngineMutation[] }): string[] =>
  mail.mutations.map((m) => {
    const r = m as {
      kind: string;
      view?: string;
      upToId?: string;
      messageId?: string;
      messageIds?: string[];
      state?: string;
      unread?: boolean;
      via?: string;
    };
    const ids = r.messageId ?? r.messageIds?.join(",") ?? "";
    const how = r.state ?? (r.unread === undefined ? "" : r.unread ? "unread" : "read");
    return [r.kind, r.view, r.upToId ? `up to ${r.upToId}` : "", ids, how, r.via ?? ""]
      .filter(Boolean)
      .join(" ");
  });
const press = (key: string, more: KeyboardEventInit = {}): void => {
  fireEvent.keyDown(document.activeElement ?? document.body, { key, ...more });
};
const settle = () => act(async () => new Promise((r) => setTimeout(r, 0)));
/** The sentence the frame's one report slot says now. */
const said = (): string => screen.getByRole("status").querySelector("span")?.textContent ?? "";
const rail = () => screen.getByRole("navigation", { name: "Places" });
const expansion = (scroller: HTMLElement, id: string): string | null =>
  within(scroller.querySelector<HTMLElement>(`[data-stream-item="${id}"]`)!)
    .getByRole("button", { name: /^(?:Expand|Collapse)$/ })
    .getAttribute("aria-expanded");

/* ── the stream laid out ─────────────────────────────────────────────────────────────────────────────────────────── */

const ITEM = 300;
const VIEW = 600;
const box = (top: number, height: number) => ({
  top,
  bottom: top + height,
  left: 0,
  right: 600,
  width: 600,
  height,
  x: 0,
  y: top,
  toJSON: () => ({}),
});
interface StreamGeometry {
  height: number;
  cardHeight?: (id: string) => number;
  ids: () => readonly string[];
  receiptText: boolean;
}
let laidOutStreams = new Map<HTMLElement, StreamGeometry>();
function mockStreamRects(): void {
  const original = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    for (const [scroller, geometry] of laidOutStreams) {
      if (!scroller.contains(this)) continue;
      const card = this.closest<HTMLElement>("[data-stream-item]");
      const id = this.dataset.streamWindowItem ?? card?.dataset.streamItem;
      if (!id) continue;
      const ids = geometry.ids();
      const index = ids.indexOf(id);
      if (index < 0) continue;
      const height = geometry.cardHeight?.(id) ?? geometry.height;
      const position = geometry.cardHeight
        ? ids.slice(0, index).reduce((sum, before) => sum + geometry.cardHeight!(before), 0)
        : index * height;
      const top = position - scroller.scrollTop;
      if (this.dataset.streamWindowItem !== undefined || this === card) return box(top, height);
      if (geometry.receiptText && card) {
        const rect = card.getBoundingClientRect();
        if (this.matches("[data-sender-line]")) return box(rect.top + 16, 20);
        if (this.matches(".oh-message-clip, .oh-message-body, [data-read-body]"))
          return box(rect.top + 70, rect.height - 100);
      }
    }
    return original.call(this);
  });
}

function layOut(name: string, itemHeight = ITEM, viewport = VIEW): HTMLElement {
  const stream = screen.getByRole("region", { name });
  const scroller = stream.querySelector<HTMLElement>(".oh-sheet-scroll")!;
  const view: FeedView = name === "Receipts stream" ? "receipts" : "reads";
  const mail = geometryMail;
  let lastVersion = -1;
  let order: readonly string[] = [];
  const ids = () => {
    const reader = mail.engine.read();
    const version = reader.version();
    if (lastVersion !== version) {
      const { fresh, seen } = feedPartition(reader, view);
      order = [...fresh, ...seen].map((letter) => letter.id);
      lastVersion = version;
    }
    return order;
  };
  if (!laidOutStreams.size) mockStreamRects();
  const receiptText = laidOutStreams.get(scroller)?.receiptText ?? false;
  laidOutStreams.set(scroller, { height: itemHeight, ids, receiptText });
  Object.defineProperty(scroller, "clientHeight", { configurable: true, get: () => viewport });
  Object.defineProperty(scroller, "scrollHeight", {
    configurable: true,
    get: () => ids().length * itemHeight,
  });
  scroller.getBoundingClientRect = () => box(0, viewport);
  scroller.scrollTo = ((o: ScrollToOptions) => {
    scroller.scrollTop = o.top ?? 0;
    fireEvent.scroll(scroller);
  }) as typeof scroller.scrollTo;
  return scroller;
}

function layOutText(scroller: HTMLElement): void {
  laidOutStreams.get(scroller)!.receiptText = true;
}
let frames = new Map<number, FrameRequestCallback>();
let nextFrameId = 0;
function nextFrame(): void {
  const due = frames;
  frames = new Map();
  act(() => {
    for (const cb of due.values()) cb(performance.now());
  });
}
/** The opening screen, as a page's first frame after its layout measures it. */
function firstFrame(scroller: HTMLElement): void {
  fireEvent.scroll(scroller);
  nextFrame();
}
/** The stream's landing on an opened item, as a page lays it: a scroll no hand made. */
function land(scroller: HTMLElement, top: number): void {
  scroller.scrollTop = top;
  fireEvent.scroll(scroller);
  nextFrame();
}
/** A hand on the stream: a wheel step, and the scroll it makes. */
function wheel(scroller: HTMLElement, top: number): void {
  fireEvent.wheel(scroller, { deltaY: 120 });
  scroller.scrollTop = top;
  fireEvent.scroll(scroller);
  nextFrame();
}
function laidOutTime(clock?: "Date" | "performance"): void {
  vi.useFakeTimers({
    toFake: clock ? ["setTimeout", "clearTimeout", clock] : ["setTimeout", "clearTimeout"],
  });
  frames = new Map();
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    const id = ++nextFrameId;
    frames.set(id, cb);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
}

/* ── the open letter laid out ────────────────────────────────────────────────────────────────────────────────────── */

beforeEach(() => {
  localStorage.clear();
  Element.prototype.animate ??= () => ({ cancel() {}, finished: Promise.resolve() }) as unknown as Animation;
  Element.prototype.scrollIntoView ??= () => undefined;
  /* jsdom scrolls nothing: a landing on an opened item stands where the case lays it out. */
  HTMLElement.prototype.scrollTo ??= function () {} as typeof HTMLElement.prototype.scrollTo;
});
afterEach(() => {
  cleanup();
  laidOutStreams = new Map();
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe.each([
  { route: "reads", region: "News stream", letter: issue },
  { route: "receipts", region: "Receipts stream", letter: receipt },
])("$region's first phone frame", ({ route, region, letter }) => {
  it.each(["cold open", "saved position", "addressed card"])(
    "keeps the opening cards in place on a %s",
    (entry) => {
      laidOutTime();
      vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([
        box(0, VIEW),
      ] as unknown as DOMRectList);
      const home = `#/${route}`;
      const { address } = seat({
        at: entry === "addressed card" ? `${home}/m/later` : home,
        phone: true,
        letters: [letter("first", 10), letter("later", 9), letter("last", 8)],
      });
      const cards = () => screen.getByRole("region", { name: region }).querySelectorAll("[data-stream-item]");
      const arm = () => {
        nextFrame();
        act(() => {
          vi.advanceTimersByTime(1);
        });
      };
      if (entry === "saved position") {
        const scroller = layOut(region);
        arm();
        scroller.scrollTop = ITEM;
        act(() => address.visit("#/ohbox"));
        act(() => address.visit(home));
      }
      expect(cards()).toHaveLength(entry === "cold open" ? 3 : 0);
      arm();
      expect(cards().length).toBeGreaterThan(0);
    },
  );
});

describe("News and Receipts on their own seats, over the mail ground", () => {
  it("eases a News preview open and closed", () => {
    const style = document.createElement("style");
    style.textContent =
      ".oh-message-clip { --d-in: 220ms; --e-move: linear; --stream-clip-motion-threshold: 2px; }";
    document.head.append(style);
    const oldAnimate = Element.prototype.animate;
    const height = vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (
      this: HTMLElement,
    ) {
      return this.matches(".oh-message-clip") ? (this.hasAttribute("data-shut") ? 100 : 300) : 600;
    });
    const scrollHeight = vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(300);
    const frames: Keyframe[][] = [];
    Element.prototype.animate = function (keyframes) {
      if (this.matches(".oh-message-clip")) frames.push(keyframes as Keyframe[]);
      return { cancel() {}, addEventListener() {} } as unknown as Animation;
    };
    try {
      seat({ at: "#/reads" });
      const card = document.querySelector<HTMLElement>('[data-stream-item="n3"]')!;
      fireEvent.click(within(card).getByRole("button", { name: "Expand" }));
      expect(frames).toContainEqual([{ maxHeight: "100px" }, { maxHeight: "300px" }]);
      fireEvent.click(within(card).getByRole("button", { name: "Collapse" }));
      expect(frames).toContainEqual([{ maxHeight: "300px" }, { maxHeight: "100px" }]);
    } finally {
      height.mockRestore();
      scrollHeight.mockRestore();
      Element.prototype.animate = oldAnimate;
      style.remove();
    }
  });

  it.each([
    ["News", "reads", issue],
    ["Receipts", "receipts", receipt],
  ] as const)(
    "%s files the letter reached by scrolling, keeping the earlier opened letter",
    (place, route, make) => {
      laidOutTime();
      const letters = [7, 6, 5, 4, 3, 2, 1].map((d) => make("letter-" + d, d));
      const { mail, address } = seat({ at: "#/" + route + "/m/letter-7", letters });
      const scroller = layOut(place + " stream");
      firstFrame(scroller);
      for (let i = 0; i < 12; i++) nextFrame();
      wheel(scroller, ITEM * 3);
      expect(scroller.scrollTop).toBe(ITEM * 3);
      const selected = () =>
        scroller.querySelector<HTMLElement>("[data-stream-item][data-open]")?.dataset.streamItem;
      expect(selected()).toBe("letter-4");
      expect(address.read()).toBe("#/" + route + "/m/letter-7");
      const ids = () =>
        [...scroller.querySelectorAll<HTMLElement>("[data-stream-item]")].map((el) => el.dataset.streamItem);
      press("Delete");
      expect(screen.getByRole("button", { name: /Undo/ })).toBeTruthy();
      expect(ids()).toContain("letter-7");
      expect(ids()).not.toContain("letter-4");
      fireEvent.click(screen.getByRole("button", { name: /Undo/ }));
      expect(ids()).toContain("letter-4");
      expect(mail.mutations.filter((m) => m.kind === "message_delete")).toEqual([]);
      act(() => address.visit("#/" + route + "/m/letter-3"));
      expect(selected()).toBe("letter-3");
      act(() => address.visit("#/" + route + "/m/letter-7"));
      expect(selected()).toBe("letter-7");
    },
  );

  it("News lists the pile the ground presents, newest first, and its rail entry counts what is new off the ground, at any place", () => {
    seat({ at: "#/reads" });
    const list = screen.getByRole("region", { name: "News" });
    expect(
      within(list)
        .getAllByText(/^Issue /)
        .map((n) => n.textContent),
    ).toEqual(["Issue 13", "Issue 12", "Issue 11", "Issue 10"]);
    /* No visit drew a line yet: every unread letter is new until read. */
    expect(within(rail()).getByRole("button", { name: "News 3" })).toBeTruthy();
    expect(within(rail()).getByRole("button", { name: "Receipts 4" })).toBeTruthy();
    cleanup();
    /* At the Ohbox, with no stream's columns on screen, the counts are the ground's. */
    seat({ at: "#/ohbox" });
    expect(within(rail()).getByRole("button", { name: "News 3" })).toBeTruthy();
    expect(within(rail()).getByRole("button", { name: "Receipts 4" })).toBeTruthy();
  });

  it.each([
    ["News", "reads", issue],
    ["Receipts", "receipts", receipt],
  ] as const)("%s files only the newly expanded letter, and Undo keeps it", async (place, route, message) => {
    laidOutTime();
    const letters = Array.from({ length: 5 }, (_, i) => message(`RC${i}`, 10));
    const mount = () => seat({ at: `#/${route}/m/RC2`, letters });
    const target = "RC3";
    const list = () => screen.getByRole("region", { name: place });
    const selected = () => list().querySelector<HTMLElement>("[data-id][data-open]")?.dataset.id;
    const remaining = () =>
      [...list().querySelectorAll<HTMLElement>("[data-id]")].map((row) => row.dataset.id).sort();
    const card = () => document.querySelector<HTMLElement>('[data-stream-item="RC3"]')!;
    const expand = () => fireEvent.click(within(card()).getByRole("button", { name: "Expand" }));
    const advance = async () =>
      act(async () => {
        vi.advanceTimersByTime(30_000);
      });

    const first = mount();
    expand();
    expect(first.address.read()).toBe(`#/${route}/m/${target}`);
    const open = [...document.querySelectorAll('[data-stream-item] button[aria-expanded="true"]')].map(
      (button) => button.closest<HTMLElement>("[data-stream-item]")?.dataset.streamItem,
    );
    const cardId = document.querySelector<HTMLElement>("[data-stream-item][data-open]")?.dataset.streamItem;
    const row = selected();
    press("Delete");
    expect(screen.getByRole("button", { name: /Undo/ })).toBeTruthy();
    expect(remaining()).toEqual(["RC0", "RC1", "RC2", "RC4"]);
    expect(first.mail.mutations.filter((m) => m.kind === "message_delete")).toEqual([]);
    await advance();
    const filed = first.mail.mutations.filter((m) => m.kind === "message_delete").map((m) => m.messageId);
    expect({ open, card: cardId, row, filed }).toEqual({
      open: [target],
      card: target,
      row: target,
      filed: [target],
    });

    cleanup();
    const second = mount();
    expand();
    press("Delete");
    fireEvent.click(screen.getByRole("button", { name: /Undo/ }));
    await advance();
    expect(remaining()).toEqual(["RC0", "RC1", "RC2", "RC3", "RC4"]);
    expect(second.mail.mutations.filter((m) => m.kind === "message_delete")).toEqual([]);
  });

  it("asking about an expanded letter leaves the other selected card in place", () => {
    const { address } = seat({ at: "#/reads", letters: [issue("first", 6), issue("second", 5)] });
    const card = (id: string) => document.querySelector<HTMLElement>(`[data-stream-item="${id}"]`)!;
    fireEvent.click(card("first"));
    fireEvent.click(card("second"));
    expect(address.read()).toBe("#/reads/m/second");
    const sender = card("first").querySelector<HTMLButtonElement>("button[data-sender-line]");
    expect(sender, "the first open letter's sender").not.toBeNull();
    fireEvent.pointerDown(sender!);
    fireEvent.click(sender!);
    expect(sender!.getAttribute("aria-expanded")).toBe("true");
    expect(card("first").querySelector('[aria-current="true"]')).toBeNull();
    expect(card("second").querySelector('[aria-current="true"]')).not.toBeNull();
    expect(address.read()).toBe("#/reads/m/second");
    expect(card("second").hasAttribute("data-open")).toBe(true);
  });

  it.each([
    ["News", "reads", "n2"],
    ["Receipts", "receipts", "r2"],
  ])("%s offers the open letter's Move by keyboard and menu", (place, route, id) => {
    seat({ at: `#/${route}/m/${id}` });
    press("m");
    let menu = screen.getByRole("menu", { name: "Move" });
    expect(within(menu).getAllByRole("menuitem")[0]?.textContent).toContain("Ohbox");
    fireEvent.keyDown(menu, { key: "Escape" });
    fireEvent.click(
      within(screen.getByRole("toolbar", { name: "Actions" })).getByRole("button", { name: "Move" }),
    );
    menu = screen.getByRole("menu", { name: "Move" });
    expect(within(menu).getAllByRole("menuitem")[0]?.textContent).toContain("Ohbox");
  });

  it("a row's press opens its item in the stream and names it in the address", () => {
    const { address } = seat({ at: "#/reads" });
    const list = screen.getByRole("region", { name: "News" });
    fireEvent.click(within(list).getByText("Issue 12"));
    expect(address.read()).toBe("#/reads/m/n2");
  });

  it("j opens the next item and reads it at rest: News's read rides feed_mark_seen with its ids alone, one write a pause", () => {
    laidOutTime();
    const { mail, address } = seat({ at: "#/reads" });
    const scroller = layOut("News stream");
    firstFrame(scroller);
    act(() => void fireEvent.keyDown(window, { key: "j" }));
    expect(address.read()).toBe("#/reads/m/n2");
    nextFrame();
    expect(expansion(scroller, "n2"), "a keyboard step leaves the card's folding to the person").toBe(
      "false",
    );
    act(() => void vi.advanceTimersByTime(600));
    expect(sent(mail), "a read was written before the glances' pause").toEqual([]);
    act(() => void vi.advanceTimersByTime(500));
    expect(sent(mail)).toEqual(["feed_mark_seen reads n2"]);
  });

  it("Receipts' read rides mark_seen as a glance", () => {
    laidOutTime();
    const { mail, address } = seat({ at: "#/receipts" });
    const scroller = layOut("Receipts stream");
    firstFrame(scroller);
    act(() => void fireEvent.keyDown(window, { key: "j" }));
    expect(address.read()).toBe("#/receipts/m/r2");
    nextFrame();
    act(() => void vi.advanceTimersByTime(1100));
    expect(sent(mail)).toEqual(["mark_seen r2 read glance"]);
  });

  it("a link to an item lands on it and reads nothing", () => {
    laidOutTime();
    const { mail } = seat({ at: "#/reads/m/n2" });
    const scroller = layOut("News stream");
    firstFrame(scroller);
    land(scroller, ITEM);
    act(() => void vi.advanceTimersByTime(2000));
    expect(sent(mail)).toEqual([]);
    fireEvent.click(within(rail()).getByRole("button", { name: /^Ohbox/ }));
    expect(sent(mail), "a linked preview did not read mail or move the line on leaving").toEqual([]);
  });

  it("Back to a direct letter before a different letter's glance has rested reads neither", () => {
    laidOutTime();
    const { mail, address } = seat({ at: "#/reads/m/n3" });
    const scroller = layOut("News stream");
    firstFrame(scroller);
    fireEvent.click(within(screen.getByRole("region", { name: "News" })).getByText("Issue 12"));
    expect(address.read()).toBe("#/reads/m/n2");
    act(() => address.visit("#/reads/m/n3"));
    land(scroller, 0);
    act(() => void vi.advanceTimersByTime(2000));
    expect(sent(mail)).toEqual([]);
  });

  it.each([
    ["News", "reads", issue],
    ["Receipts", "receipts", receipt],
  ] as const)(
    "%s history preview needs a new gesture to read or move the line",
    async (name, route, make) => {
      laidOutTime("performance");
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      const letters = [8, 7, 6, 5, 4, 3, 2, 1].map((day) => make(`letter-${day}`, day));
      const linked = `#/${route}/m/letter-1`;
      const { mail, address } = seat({ at: `#/${route}`, letters });
      const scroller = layOut(`${name} stream`);
      layOutText(scroller);
      firstFrame(scroller);
      land(scroller, 4 * ITEM);
      wheel(scroller, 4 * ITEM + 30);
      act(() => void vi.advanceTimersByTime(2000));
      const beforePreview = sent(mail);
      expect(beforePreview).not.toHaveLength(0);
      expect(beforePreview.join()).not.toContain("letter-1");

      await act(async () => {
        address.visit(linked);
      });
      for (let i = 0; i < 12; i += 1) nextFrame();
      expect(expansion(scroller, "letter-1")).toBe("true");
      act(() => void vi.advanceTimersByTime(2000));
      expect
        .soft(sent(mail), "the landed screen did not inherit the wheel's read permission")
        .toEqual(beforePreview);
      fireEvent.click(within(rail()).getByRole("button", { name: /^Ohbox/ }));
      expect(sent(mail), "only the previously scanned range contributes to the waterline").toEqual([
        ...beforePreview,
        `feed_mark_seen ${route} up to letter-4 letter-4,letter-3`,
      ]);
    },
  );

  it.each([
    ["News", "reads", issue],
    ["Receipts", "receipts", receipt],
  ] as const)("%s remembers an earlier scan until leaving a passive preview", async (name, route, make) => {
    laidOutTime(name === "Receipts" ? "performance" : undefined);
    const { body: _body, ...earlier } = make("earlier-unloaded", 8);
    const letters = [earlier, ...[7, 6, 5, 4, 3, 2, 1].map((day) => make(`letter-${day}`, day))];
    const { mail, address } = seat({ at: `#/${route}`, letters });
    const scroller = layOut(`${name} stream`);
    if (name === "Receipts") {
      const focused = vi.spyOn(document, "hasFocus").mockReturnValue(true);
      onTestFinished(() => focused.mockRestore());
      layOutText(scroller);
    }
    firstFrame(scroller);
    if (name === "Receipts") {
      // A full 400px move would give the first receipt to the live band. Keep its foot below the band during dwell.
      wheel(scroller, 40);
      act(() => void vi.advanceTimersByTime(701));
    } else {
      wheel(scroller, 400);
    }
    expect(sent(mail)).toEqual([]);

    await act(async () => {
      address.visit(`#/${route}/m/letter-1`);
    });
    for (let i = 0; i < 12; i += 1) nextFrame();
    expect(expansion(scroller, "letter-1")).toBe("true");
    act(() => void vi.advanceTimersByTime(2000));
    // In the released stream, the next receipt's sender and first lines also stayed on screen.
    // Its earned glance can drain after the address changes, but the preview earns none.
    const glances = name === "Receipts" ? ["mark_seen letter-7 read glance"] : [];
    expect(sent(mail)).toEqual(glances);

    act(() => void window.dispatchEvent(new Event("pagehide")));
    act(() => void window.dispatchEvent(new Event("pagehide")));
    fireEvent.click(within(rail()).getByRole("button", { name: /^Ohbox/ }));
    expect(sent(mail)).toEqual([
      ...glances,
      `feed_mark_seen ${route} up to earlier-unloaded earlier-unloaded${name === "Receipts" ? ",letter-7" : ""}`,
    ]);
  });

  it("leaves a deferred scan with its owning account when the replacement has the same ids", async () => {
    laidOutTime();
    const { body: _body, ...earlier } = issue("earlier-unloaded", 8);
    const letters = [earlier, ...[7, 6, 5, 4, 3, 2, 1].map((day) => issue(`letter-${day}`, day))];
    const { mail, address, replaceEngine } = seat({ at: "#/reads", letters });
    const scroller = layOut("News stream");
    firstFrame(scroller);
    wheel(scroller, 400);
    await act(async () => {
      address.visit("#/reads/m/letter-1");
    });
    expect(sent(mail)).toEqual([]);

    const replacement = replaceEngine(
      "acct-2",
      letters.map((letter) => ({ ...letter, accountId: "acct-2" })),
    );
    act(() => void window.dispatchEvent(new Event("pagehide")));
    expect(sent(mail)).toEqual(["feed_mark_seen reads up to earlier-unloaded earlier-unloaded"]);
    expect(sent(replacement)).toEqual([]);
  });

  it.each([
    ["News", "reads", "n2", "n3", "Issue 12", "feed_mark_seen reads n2"],
    ["Receipts", "receipts", "r2", "r3", "Order 12", "mark_seen r2 read glance"],
  ] as const)(
    "%s Back closes only the card opened by a link",
    async (name, route, linked, manual, subject, write) => {
      laidOutTime();
      const { address, mail } = seat({ at: `#/${route}` });
      const scroller = layOut(`${name} stream`);
      firstFrame(scroller);
      fireEvent.click(
        within(scroller.querySelector<HTMLElement>(`[data-stream-item="${manual}"]`)!).getByRole("button", {
          name: "Expand",
        }),
      );
      await act(async () => {
        address.visit(`#/${route}/m/${linked}`);
      });
      for (let i = 0; i < 12; i += 1) nextFrame();
      expect(expansion(scroller, linked)).toBe("true");
      expect(expansion(scroller, manual)).toBe("true");

      fireEvent.click(
        within(scroller.querySelector<HTMLElement>(`[data-stream-item="${linked}"]`)!).getByText(subject),
      );
      act(() => void vi.advanceTimersByTime(2000));
      expect(sent(mail)).toEqual([write]);
      await act(async () => {
        address.visit(`#/${route}`);
      });
      for (let i = 0; i < 12; i += 1) nextFrame();
      expect(scroller.querySelector("[data-stream-item][data-open]")).toBeNull();
      expect(expansion(scroller, linked)).toBe("false");
      expect(expansion(scroller, manual)).toBe("true");
    },
  );

  it("opens the linked preview from the current account when another account has the same message id", () => {
    laidOutTime();
    const { mail, replaceEngine } = seat({ at: "#/reads/m/n2" });
    const first = layOut("News stream");
    firstFrame(first);
    land(first, ITEM);
    for (let i = 0; i < 12; i += 1) nextFrame();
    expect(expansion(first, "n2")).toBe("true");
    expect(within(first).getByText("Issue 12")).toBeTruthy();

    const replacement = replaceEngine("acct-2", [
      issue("n2", 12, { accountId: "acct-2", subject: "Replacement account letter" }),
    ]);
    const current = layOut("News stream");
    firstFrame(current);
    land(current, 0);
    for (let i = 0; i < 12; i += 1) nextFrame();
    expect(expansion(current, "n2")).toBe("true");
    expect(within(current).getByText("Replacement account letter")).toBeTruthy();
    expect(within(current).queryByText("Issue 12")).toBeNull();
    act(() => void vi.advanceTimersByTime(2000));
    fireEvent.click(within(rail()).getByRole("button", { name: /^Ohbox/ }));
    expect(sent(mail)).toEqual([]);
    expect(sent(replacement)).toEqual([]);
  });

  it.each([
    ["News", "reads", "n2", "n3"],
    ["Receipts", "receipts", "r2", "r3"],
  ] as const)(
    "%s opens the exact linked preview without making a read visit",
    (name, route, linked, other) => {
      laidOutTime();
      const { mail, address } = seat({ at: `#/${route}/m/${linked}` });
      const scroller = layOut(name + " stream");
      firstFrame(scroller);
      land(scroller, ITEM);
      for (let i = 0; i < 12; i += 1) nextFrame();
      expect(expansion(scroller, linked)).toBe("true");
      expect(expansion(scroller, other)).toBe("false");
      act(() => void vi.advanceTimersByTime(2000));
      fireEvent.click(within(rail()).getByRole("button", { name: /^Ohbox/ }));
      expect(sent(mail)).toEqual([]);

      act(() => address.visit(`#/${route}/m/${other}`));
      const returned = layOut(name + " stream");
      firstFrame(returned);
      land(returned, 0);
      for (let i = 0; i < 12; i += 1) nextFrame();
      expect(expansion(returned, other)).toBe("true");
      expect(expansion(returned, linked)).toBe("false");
      act(() => void vi.advanceTimersByTime(2000));
      expect(sent(mail)).toEqual([]);

      wheel(returned, 400);
      fireEvent.click(within(rail()).getByRole("button", { name: /^Ohbox/ }));
      expect(sent(mail).filter((mutation) => mutation.includes("up to"))).toEqual([
        `feed_mark_seen ${route} up to ${other} ${other}`,
      ]);
    },
  );

  it("Mark unread from the card's panel survives a glance that has not rested yet", async () => {
    laidOutTime();
    const readLetter = issue("opened", 12, { unread: false });
    const { mail } = seat({ at: "#/reads", letters: [readLetter, issue("next", 10)] });
    await act(() => vi.advanceTimersByTimeAsync(30));
    const scroller = layOut("News stream");
    firstFrame(scroller);
    fireEvent.click(within(screen.getByRole("region", { name: "News" })).getByText("Issue 12"));
    const actions = within(screen.getByRole("toolbar", { name: "Actions" }));
    fireEvent.click(actions.getByRole("button", { name: "Mark unread" }));
    const explicit = sent(mail);
    expect(explicit).toEqual(["mark_seen opened unread"]);
    act(() => mail.patch("opened", { unread: true }));
    land(layOut("News stream"), 0);
    act(() => void vi.advanceTimersByTime(2000));
    expect(sent(mail)).toEqual(explicit);
  });

  it("typing in the open stream reply leaves the other unread letter and the stream line alone", async () => {
    laidOutTime();
    const { mail } = seat({
      at: "#/reads/m/first",
      withReply: true,
      letters: [issue("first", 10, { unread: false }), issue("second", 9)],
    });
    await act(() => vi.advanceTimersByTimeAsync(30));
    const scroller = layOut("News stream");
    firstFrame(scroller);
    await act(async () => {
      fireEvent.click(
        within(screen.getByRole("toolbar", { name: "Actions" })).getByRole("button", { name: "Reply" }),
      );
    });
    await act(() => vi.dynamicImportSettled());
    const reply = within(scroller).getByRole("textbox", { name: "Reply body" });
    fireEvent.keyDown(reply, { key: "o" });
    fireEvent.keyDown(reply, { key: " " });
    fireEvent.keyDown(reply, { key: "n" });
    fireEvent.keyDown(reply, { key: "PageDown" });
    fireEvent.click(within(rail()).getByRole("button", { name: /^Ohbox/ }));
    expect(
      sent(mail).filter((write) => write.startsWith("feed_mark_seen") || write.startsWith("mark_seen")),
    ).toEqual([]);
  });

  it.each([
    ["addressed letter", "letter-7"],
    ["plain revisit", "letter-4"],
  ])("Move uses the panel's letter after scrolling from %s", async (start, target) => {
    laidOutTime();
    const letters = [7, 6, 5, 4, 3, 2, 1].map((d) => issue("letter-" + d, d));
    const at = start === "addressed letter" ? "#/reads/m/letter-7" : "#/reads";
    const { mail, address } = seat({ at, letters });
    await act(() => vi.advanceTimersByTimeAsync(30));
    const scroller = layOut("News stream");
    firstFrame(scroller);
    for (let i = 0; i < 12; i++) nextFrame();
    if (start === "plain revisit") {
      wheel(scroller, ITEM);
      act(() => address.visit("#/ohbox"));
      act(() => address.visit(at));
      firstFrame(layOut("News stream"));
    }
    const now = layOut("News stream");
    wheel(now, ITEM * 3);
    expect(now.querySelector<HTMLElement>("[data-stream-item][data-open]")?.dataset.streamItem).toBe(
      "letter-4",
    );
    expect(address.read()).toBe(at);
    const panel = within(screen.getByRole("toolbar", { name: "Actions" }));
    fireEvent.click(panel.getByRole("button", { name: "Move" }));
    fireEvent.click(
      within(screen.getByRole("menu", { name: "Move" })).getByRole("menuitem", { name: "Ohbox" }),
    );
    expect(mail.mutations.filter((m) => m.kind === "move")).toEqual([
      expect.objectContaining({ kind: "move", messageId: target, folder: "INBOX" }),
    ]);
  });

  it("a hit opened into News as entered drives the stream: the item it lands on is read at rest", () => {
    laidOutTime();
    const { mail, address } = seat({ at: "#/search", hit: hitAt("news", "n2") });
    fireEvent.click(screen.getByRole("button", { name: "Open the hit" }));
    expect(address.read()).toBe("#/reads/m/n2");
    const scroller = layOut("News stream");
    firstFrame(scroller);
    land(scroller, ITEM);
    for (let frame = 0; frame < 6; frame++) nextFrame();
    act(() => void vi.advanceTimersByTime(2000));
    expect(sent(mail)).toEqual(["feed_mark_seen reads n2"]);
  });

  it.each([
    ["news", "News", issue, "feed_mark_seen reads pending"],
    ["receipts", "Receipts", receipt, "mark_seen pending read glance"],
  ] as const)(
    "reads the chosen %s Search result only after its body arrives and rests",
    (place, name, make, write) => {
      laidOutTime();
      const { body: _body, ...pending } = make("pending", 12);
      const { mail } = seat({ at: "#/search", hit: hitAt(place, "pending"), letters: [pending] });
      fireEvent.click(screen.getByRole("button", { name: "Open the hit" }));
      const scroller = layOut(name + " stream");
      firstFrame(scroller);
      land(scroller, 0);
      for (let i = 0; i < 12; i += 1) nextFrame();
      expect(expansion(scroller, "pending")).toBe("true");
      act(() => void vi.advanceTimersByTime(2000));
      expect(sent(mail)).toEqual([]);

      act(() => mail.patch("pending", { body: "Here is the loaded letter." }));
      nextFrame();
      act(() => void vi.advanceTimersByTime(300));
      expect(sent(mail)).toEqual([]);
      act(() => void vi.advanceTimersByTime(1700));
      expect(sent(mail)).toEqual([write]);
    },
  );

  it("leaving a chosen result cancels its read even when the same letter's body arrives in a preview", async () => {
    laidOutTime();
    const { body: _body, ...pending } = issue("pending", 12);
    const { mail, address } = seat({ at: "#/search", hit: hitAt("news", "pending"), letters: [pending] });
    fireEvent.click(screen.getByRole("button", { name: "Open the hit" }));
    firstFrame(layOut("News stream"));
    act(() => address.visit("#/reads"));
    await act(async () => {
      address.visit("#/reads/m/pending");
    });
    const scroller = layOut("News stream");
    firstFrame(scroller);
    land(scroller, 0);
    for (let i = 0; i < 12; i += 1) nextFrame();
    expect(expansion(scroller, "pending")).toBe("true");

    act(() => mail.patch("pending", { body: "Here is the loaded letter." }));
    act(() => void vi.advanceTimersByTime(2000));
    fireEvent.click(within(rail()).getByRole("button", { name: /^Ohbox/ }));
    expect(sent(mail)).toEqual([]);
  });

  it.each([
    ["news", "reads", "News", "n2", "feed_mark_seen reads n2"],
    ["receipts", "receipts", "Receipts", "r2", "mark_seen r2 read glance"],
  ] as const)(
    "history cannot spend an earlier %s Search press after leaving the letter",
    (place, route, name, id, written) => {
      laidOutTime();
      const { mail, address } = seat({ at: "#/search", hit: hitAt(place, id) });
      const pick = () => {
        fireEvent.click(screen.getByRole("button", { name: "Open the hit" }));
        const scroller = layOut(name + " stream");
        firstFrame(scroller);
        land(scroller, ITEM);
        for (let frame = 0; frame < 6; frame++) nextFrame();
      };
      pick();
      act(() => void vi.advanceTimersByTime(100));
      act(() => address.visit("#/" + route));
      act(() => address.visit("#/" + route + "/m/" + id));
      land(layOut(name + " stream"), ITEM);
      act(() => void vi.advanceTimersByTime(2000));
      expect(sent(mail)).toEqual([]);
      act(() => address.visit("#/search"));
      pick();
      act(() => void vi.advanceTimersByTime(2000));
      expect(sent(mail)).toEqual([written]);
    },
  );

  it("waits for a chosen search hit to arrive before reading its letter", () => {
    laidOutTime();
    const { mail, address } = seat({ at: "#/search", hit: hitAt("news", "late") });
    fireEvent.click(screen.getByRole("button", { name: "Open the hit" }));
    expect(address.read()).toBe("#/reads/m/late");
    expect(mail.bodyAsks).not.toContain("late");
    const scroller = layOut("News stream");
    firstFrame(scroller);
    land(scroller, ITEM);
    act(() => void vi.advanceTimersByTime(2000));
    expect(sent(mail)).toEqual([]);
    act(() => mail.add(issue("late", 14)));
    const updated = layOut("News stream");
    firstFrame(updated);
    land(updated, 0);
    act(() => void vi.advanceTimersByTime(2000));
    expect(sent(mail)).toEqual(["feed_mark_seen reads late"]);
  });

  it("the tab going away after a hand drove the stream commits the line once: from the newest item shown, flipping what the hand carried past", () => {
    laidOutTime();
    const { mail } = seat({ at: "#/reads" });
    const scroller = layOut("News stream");
    firstFrame(scroller);
    wheel(scroller, 400);
    act(() => void window.dispatchEvent(new Event("pagehide")));
    const commits = sent(mail).filter((m) => m.includes("up to"));
    expect(commits).toEqual(["feed_mark_seen reads up to n3 n3"]);
  });

  it("leaving News for another place commits the line once after a hand; a visit no hand drove writes nothing", () => {
    laidOutTime();
    const first = seat({ at: "#/reads" });
    firstFrame(layOut("News stream"));
    act(() => void vi.advanceTimersByTime(3000));
    expect(sent(first.mail), "the first screen stayed unread while nobody drove it").toEqual([]);
    fireEvent.click(within(rail()).getByRole("button", { name: /^Ohbox/ }));
    expect(sent(first.mail), "a visit nobody drove wrote").toEqual([]);
    cleanup();
    const { mail } = seat({ at: "#/reads" });
    const scroller = layOut("News stream");
    firstFrame(scroller);
    wheel(scroller, 400);
    fireEvent.click(within(rail()).getByRole("button", { name: /^Ohbox/ }));
    expect(sent(mail).filter((m) => m.includes("up to"))).toEqual(["feed_mark_seen reads up to n3 n3"]);
  });

  it("leaving Receipts after a wheel moves only its line and only flips a receipt that was shown", () => {
    laidOutTime();
    const { mail } = seat({ at: "#/receipts" });
    const scroller = layOut("Receipts stream");
    firstFrame(scroller);
    wheel(scroller, 400);
    fireEvent.click(within(rail()).getByRole("button", { name: /^Ohbox/ }));
    expect(sent(mail).filter((mutation) => mutation.includes("up to"))).toEqual([
      "feed_mark_seen receipts up to r3 r3",
    ]);
  });

  it.each(["look", "leave"] as const)("reports a refused stream %s from the engine", async (kind) => {
    laidOutTime();
    const { mail } = seat({ at: "#/reads" });
    const original = mail.engine.mutate.bind(mail.engine);
    const dispatched = vi.spyOn(mail.engine, "mutate").mockImplementation((mutation) => {
      if (mutation.kind !== "feed_mark_seen" || (kind === "leave") !== Boolean(mutation.upToId)) {
        return original(mutation);
      }
      mail.mutations.push(mutation);
      return Promise.resolve({ status: "rolled_back", id: "mark", key: "mark", seq: null });
    });
    try {
      const scroller = layOut("News stream");
      firstFrame(scroller);
      if (kind === "leave") {
        wheel(scroller, 400);
        act(() => void window.dispatchEvent(new Event("pagehide")));
      } else {
        fireEvent.click(within(screen.getByRole("region", { name: "News" })).getByText("Issue 12"));
        nextFrame();
      }
      await act(async () => {
        vi.advanceTimersByTime(2000);
      });
      expect(sent(mail)).toContain(
        kind === "leave" ? "feed_mark_seen reads up to n3 n3" : "feed_mark_seen reads n2",
      );
      expect(said()).toContain("Nothing changed");
    } finally {
      dispatched.mockRestore();
    }
  });

  it("keeps a late News refusal with the engine that recorded the read", async () => {
    laidOutTime();
    const { mail, replaceEngine } = seat({ at: "#/reads" });
    const original = mail.engine.mutate.bind(mail.engine);
    type Receipt = Awaited<ReturnType<typeof mail.engine.mutate>>;
    let report!: (receipt: Receipt) => void;
    const answer = new Promise<Receipt>((resolve) => {
      report = resolve;
    });
    const dispatched = vi.spyOn(mail.engine, "mutate").mockImplementation((mutation) => {
      if (mutation.kind !== "feed_mark_seen") return original(mutation);
      mail.mutations.push(mutation);
      return answer;
    });
    try {
      const scroller = layOut("News stream");
      firstFrame(scroller);
      fireEvent.click(within(screen.getByRole("region", { name: "News" })).getByText("Issue 12"));
      nextFrame();
      await act(async () => {
        vi.advanceTimersByTime(1000);
      });
      expect(sent(mail)).toContain("feed_mark_seen reads n2");
      const replacement = replaceEngine();
      expect(sent(replacement)).not.toContain("feed_mark_seen reads n2");
      await act(async () => {
        report({ status: "rolled_back", id: "mark", key: "mark", seq: null });
      });
      expect(screen.queryByText(/^Nothing changed/)).toBeNull();
    } finally {
      dispatched.mockRestore();
    }
  });

  /* The line answers a hand alone: a press, a key or a hit drives the read rule, never the leave. */
  it("a row's press with no hand: leaving News writes no line", () => {
    laidOutTime();
    const { mail } = seat({ at: "#/reads" });
    const scroller = layOut("News stream");
    firstFrame(scroller);
    fireEvent.click(within(screen.getByRole("region", { name: "News" })).getByText("Issue 12"));
    nextFrame();
    act(() => void vi.advanceTimersByTime(2000));
    fireEvent.click(within(rail()).getByRole("button", { name: /^Ohbox/ }));
    expect(sent(mail), "only the item the press rests on is read; the line stays").toEqual([
      "feed_mark_seen reads n2",
    ]);
  });

  it("a tap on the stream with no move: leaving News writes no line", () => {
    laidOutTime();
    const { mail } = seat({ at: "#/reads" });
    const scroller = layOut("News stream");
    firstFrame(scroller);
    /* A finger that comes down and lifts without moving is no hand: it drives the reads, never the line. */
    fireEvent.touchStart(scroller);
    fireEvent.touchEnd(scroller);
    fireEvent.click(within(screen.getByRole("region", { name: "News" })).getByText("Issue 12"));
    nextFrame();
    act(() => void vi.advanceTimersByTime(2000));
    fireEvent.click(within(rail()).getByRole("button", { name: /^Ohbox/ }));
    expect(sent(mail), "only the item the press rests on is read; the line stays").toEqual([
      "feed_mark_seen reads n2",
    ]);
  });

  it("j alone, then the tab goes away: no line", () => {
    laidOutTime();
    const { mail } = seat({ at: "#/reads" });
    const scroller = layOut("News stream");
    firstFrame(scroller);
    act(() => void fireEvent.keyDown(window, { key: "j" }));
    nextFrame();
    act(() => void vi.advanceTimersByTime(2000));
    act(() => void window.dispatchEvent(new Event("pagehide")));
    expect(sent(mail), "only the item j rests on is read; the line stays").toEqual([
      "feed_mark_seen reads n2",
    ]);
  });

  it("a hit opened into News as entered: leaving writes no line", () => {
    laidOutTime();
    const { mail } = seat({ at: "#/search", hit: hitAt("news", "n2") });
    fireEvent.click(screen.getByRole("button", { name: "Open the hit" }));
    const scroller = layOut("News stream");
    firstFrame(scroller);
    land(scroller, ITEM);
    /* The landing holds, and the stream is looked at at rest: the leave knows the screen it shows. */
    for (let i = 0; i < 5; i += 1) nextFrame();
    act(() => void vi.advanceTimersByTime(2000));
    fireEvent.click(within(rail()).getByRole("button", { name: /^Ohbox/ }));
    expect(sent(mail), "only the item the hit lands on is read; the line stays").toEqual([
      "feed_mark_seen reads n2",
    ]);
  });

  it("End, then leaving News moves the line: a scroll key is a hand, and its flight reads nothing it carried past", () => {
    laidOutTime();
    const { mail } = seat({ at: "#/reads" });
    const scroller = layOut("News stream");
    firstFrame(scroller);
    act(() => void fireEvent.keyDown(scroller, { key: "End" }));
    /* The browser's flight to the foot, over two frames, then its rest and the stream's. */
    land(scroller, ITEM);
    land(scroller, VIEW);
    act(() => void vi.advanceTimersByTime(2000));
    fireEvent.click(within(rail()).getByRole("button", { name: /^Ohbox/ }));
    expect(sent(mail)).toEqual(["feed_mark_seen reads up to n3"]);
  });

  it("Mark all read marks the unread letters read and moves the line to the top; its Undo, which z presses, takes both back", async () => {
    const { mail } = seat({ at: "#/reads" });
    const head = within(screen.getByRole("region", { name: "News" })).getByRole("banner");
    fireEvent.click(within(head).getByRole("button", { name: "List" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Mark all 3 unread messages read" }));
    await settle();
    expect(sent(mail)).toEqual(["mark_seen n3,n2,n1 read", "feed_mark_seen reads up to n3"]);
    expect(said()).toBe("3 read");
    press("z");
    await settle();
    expect(sent(mail).slice(2, 3)).toEqual(["mark_seen n3,n2,n1 unread"]);
    /* The line goes back as it stood: none was drawn, so the Undo clears the one the press drew. */
    expect(mail.mutations.slice(3).map((m) => m.kind)).toEqual(["feed_mark_seen"]);
  });
});

describe("Mark all read clears WHAT THE VIEW SHOWS, not just its own button", () => {
  it("the press flips the unread ids AND commits the line to the top", async () => {
    const letters = [
      issue("new1", 13),
      issue("read1", 12, { unread: false }),
      issue("skip1", 11),
      issue("read2", 10, { unread: false }),
    ];
    const { mail } = seat({ at: "#/reads", letters });
    const head = within(screen.getByRole("region", { name: "News" })).getByRole("banner");
    expect(sent(mail)).toEqual([]);
    fireEvent.click(within(head).getByRole("button", { name: "List" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Mark all 2 unread messages read" }));
    await settle();
    expect(sent(mail)).toEqual(["mark_seen new1,skip1 read", "feed_mark_seen reads up to new1"]);
  });
});

describe("the two stream counts in the rail", () => {
  const ENTRIES = ["News", "Receipts"];
  /** Each entry's spoken name with its number, or null where it states none. */
  const counts = (): (string | null)[] =>
    ENTRIES.map((name) =>
      within(rail())
        .getByRole("button", { name: new RegExp(`^${name}( \\d+)?$`) })
        .getAttribute("aria-label"),
    );

  it("state no number until the mailbox has settled and nothing is owed, then every number", () => {
    const { again } = seat({ at: "#/ohbox", sync: SYNC_BOOTSTRAPPING });
    expect(counts(), "a count stated before the mailbox settled").toEqual([null, null]);
    again(SYNC_SETTLED);
    expect(counts()).toEqual(["News 3", "Receipts 4"]);
  });
});

it.each([
  ["#/reads", issue],
  ["#/receipts", receipt],
] as const)("uses the body request policy of the %s stream", (at, message) => {
  // Fit the fixture's pile so the observer, rather than the opening window, controls which cards approach.
  vi.stubGlobal("innerHeight", 3000);
  let report: ((entries: { target: Element; isIntersecting: boolean }[]) => void) | undefined;
  const watched = new Set<HTMLElement>();
  class Observer {
    constructor(take: NonNullable<typeof report>, options?: IntersectionObserverInit) {
      if (options?.rootMargin === "100% 0px") report = take;
    }
    observe(card: HTMLElement) {
      watched.add(card);
    }
    unobserve(card: HTMLElement) {
      watched.delete(card);
    }
    disconnect() {
      watched.clear();
    }
  }
  vi.stubGlobal("IntersectionObserver", Observer);
  const letters = Array.from({ length: 15 }, (_, i) =>
    message("entry-" + i, 28 - i, { unread: i > 0 && i < 5, body: undefined }),
  );
  const { mail } = seat({ at, letters });
  expect(report).toBeDefined();
  const cards = [...watched].filter((node) => node.dataset.streamItem);
  expect(cards).toHaveLength(letters.length);
  const near = new Set(["entry-1", "entry-3", "entry-12"]);
  const state = cards.map((target) => ({ target, isIntersecting: near.has(target.dataset.streamItem!) }));
  const requested = at === "#/reads" ? near : new Set(["entry-1"]);
  expect(mail.bodyAsks).toEqual(at === "#/reads" ? [] : ["entry-1"]);
  act(() => report!(state));
  expect(new Set(mail.bodyAsks)).toEqual(requested);
  act(() => report!(state));
  expect(mail.bodyAsks).toHaveLength(requested.size);
  cleanup();
  act(() => report!(cards.map((target) => ({ target, isIntersecting: true }))));
  expect(mail.bodyAsks).toHaveLength(requested.size);
});

it("asks for the first unread receipt and then follows the addressed cursor", () => {
  const { address, mail } = seat({
    at: "#/receipts",
    letters: [
      receipt("newer-read", 28, { unread: false, body: undefined }),
      receipt("first-unread", 27, { unread: true, body: undefined }),
      receipt("next-unread", 26, { unread: true, body: undefined }),
    ],
  });
  expect(mail.bodyAsks).toEqual(["first-unread"]);
  act(() => mail.patch("first-unread", { unread: false }));
  expect(mail.bodyAsks).toEqual(["first-unread"]);
  act(() => address.visit("#/receipts/m/next-unread"));
  expect(mail.bodyAsks).toEqual(["first-unread", "next-unread"]);
  expect(sent(mail)).toEqual([]);
});

it("loads a linked stream item before its position is reported and leaves the other bodies alone", () => {
  const letters = Array.from({ length: 15 }, (_, i) => issue("item-" + i, 28 - i, { body: undefined }));
  const { mail } = seat({ at: "#/reads/m/item-12", letters });
  expect(mail.bodyAsks).toEqual(["item-12"]);
});

function reflectReads(mail: ReturnType<typeof seat>["mail"]): void {
  // Reflect accidental writes in the mirror so a read can change the next frame, as it does in the app.
  const mutate = mail.engine.mutate.bind(mail.engine);
  mail.engine.mutate = (mutation, opts) => {
    const reply = mutate(mutation, opts);
    if (mutation.kind === "feed_mark_seen" || (mutation.kind === "mark_seen" && !mutation.unread)) {
      for (const id of mutation.messageIds ?? []) mail.patch(id, { unread: false });
    }
    return reply;
  };
}

function listReadVisit(place: "News" | "Receipts") {
  laidOutTime();
  const make = place === "News" ? issue : receipt;
  const route = place === "News" ? "#/reads" : "#/receipts";
  const ids = Array.from({ length: 20 }, (_, i) => `r${i}`);
  const letters = ids.map((id, i) => make(id, 20 - i));
  const { mail, address } = seat({ at: route, letters });
  const region = screen.getByRole("region", { name: place });
  const list = region.querySelector<HTMLElement>(".pl-scroll")!;
  const reading = layOut(`${place} stream`, 200);
  const rowHeight = 80;
  const bottom = ids.length * rowHeight - VIEW;
  Object.defineProperty(list, "clientHeight", { get: () => VIEW });
  Object.defineProperty(list, "scrollHeight", { get: () => ids.length * rowHeight });
  expect([...list.querySelectorAll("[data-id]")].map((row) => row.getAttribute("data-id"))).toEqual(ids);
  firstFrame(reading);

  reflectReads(mail);
  const unread = () => ids.filter((id) => mail.engine.read().get<EngineMessage>("message", id)?.unread);

  const scroll = (top: number) => {
    list.scrollTop = top;
    fireEvent.scroll(list);
    nextFrame();
  };
  const steps = (from: number, to: number) => {
    for (let top = from; top <= to; top += rowHeight / 2) scroll(top);
  };
  const key = (name: string) => {
    act(() => list.focus());
    expect(document.activeElement).toBe(list);
    expect(fireEvent.keyDown(list, { key: name }), "the key may scroll the list natively").toBe(true);
  };
  const end = () => {
    key("End");
    for (const part of [0.03, 0.12, 0.3, 0.55, 0.75, 0.9, 0.97, 1]) scroll(Math.round(bottom * part));
  };
  const check = (top: number) => {
    expect(list.scrollTop).toBe(top);
    expect(reading.scrollTop, "the reading column did not travel with the list").toBe(0);
    expect(address.read()).toBe(route);
    expect(sent(mail), "no write while the list moved").toEqual([]);
    act(() => void vi.advanceTimersByTime(2000));
    act(() => void window.dispatchEvent(new Event("pagehide")));
    expect(sent(mail), "no dwell or leave writes").toEqual([]);
    expect(unread()).toEqual(ids);
  };
  return { address, mail, list, reading, ids, unread, scroll, steps, key, end, check };
}

describe("Receipts: a scroll nobody made must not write \\Seen", () => {
  function expectOnlyTheOpenedReceipt(open: (visit: ReturnType<typeof listReadVisit>) => void) {
    const elapse = (ms: number) => act(() => void vi.advanceTimersByTime(ms));
    // Pagehide flushes what the existing glance batch already holds, without advancing the dwell.
    const flush = () => act(() => void window.dispatchEvent(new Event("pagehide")));
    const selectedVisit = () => {
      const visit = listReadVisit("Receipts");
      open(visit);
      expect(visit.address.read(), "the press selected the receipt").toBe("#/receipts/m/r1");
      const current = visit.reading.querySelector("[data-stream-item][data-open]");
      expect(current?.getAttribute("data-stream-item")).toBe("r1");
      expect(sent(visit.mail), "the press itself wrote nothing").toEqual([]);
      expect(visit.unread()).toEqual(visit.ids);
      elapse(50);
      expect(sent(visit.mail), "the original settle still writes nothing").toEqual([]);
      return visit;
    };

    const early = selectedVisit();
    elapse(549);
    flush();
    expect(sent(early.mail), "the glance is not eligible before the full dwell").toEqual([]);
    cleanup();

    // Leaving also ends a pending dwell. Follow the same press in a new visit for the 600 ms witness.
    const ready = selectedVisit();
    elapse(550);
    expect(sent(ready.mail), "the eligible glance is still in the batch").toEqual([]);
    flush();
    expect(sent(ready.mail)).toEqual(["mark_seen r1 read glance"]);
    cleanup();

    const { mail, ids, unread } = selectedVisit();
    elapse(550 + SEEN_QUIET_MS);
    expect(sent(mail)).toEqual(["mark_seen r1 read glance"]);
    elapse(3000);
    expect(sent(mail), "only the opened receipt can be read").toEqual(["mark_seen r1 read glance"]);
    expect(unread()).toEqual(ids.filter((id) => id !== "r1"));
  }

  it("a row click moves the cursor and marks nothing at the click", () => {
    expectOnlyTheOpenedReceipt(({ list }) => {
      fireEvent.click(within(list).getByText("Order 19"));
      nextFrame();
    });
  });

  it("`j` commits nothing at the press, and NOT the rows its scroll passed", () => {
    expectOnlyTheOpenedReceipt(({ list, scroll }) => {
      act(() => list.focus());
      expect(document.activeElement).toBe(list);
      fireEvent.keyDown(list, { key: "j" });
      scroll(400);
      expect(list.scrollTop).toBe(400);
    });
  });

  it("the user's own wheel over the list moves the list and marks nothing", () => {
    const { list, steps, check } = listReadVisit("Receipts");
    fireEvent.wheel(list, { deltaY: 400 });
    steps(40, 400);
    check(400);
  });

  it("neither a touch drag nor a `scroll` event on its own marks a list row", () => {
    const { mail, list, scroll, check } = listReadVisit("Receipts");
    scroll(400);
    expect(sent(mail)).toEqual([]);
    fireEvent.touchMove(list, { touches: [{ clientX: 0, clientY: 80 }] });
    scroll(480);
    check(480);
  });

  it("PageDown in the list scrolls it and marks nothing", () => {
    const { key, steps, check } = listReadVisit("Receipts");
    key("PageDown");
    steps(40, 400);
    check(400);
  });

  it("End in the list rests at the end and marks nothing", () => {
    const { end, check } = listReadVisit("Receipts");
    end();
    check(1000);
  });
});

describe("Reads: the same two guards, on the view that shares the machinery", () => {
  it("a jump from another view marks NOTHING", async () => {
    laidOutTime("Date");
    const ids = Array.from({ length: 20 }, (_, i) => `r${i}`);
    const letters = ids.map((id, i) => issue(id, 20 - i));
    const { address, mail } = seat({ at: "#/ohbox", letters });
    reflectReads(mail);
    expect(screen.queryByRole("region", { name: "News stream" })).toBeNull();
    await act(async () => address.visit("#/reads/m/r15"));
    const reading = layOut("News stream", 200);
    firstFrame(reading);
    for (let i = 0; i < 100; i += 1) nextFrame();
    const current = reading.querySelector("[data-stream-item][data-open]");
    expect(address.read()).toBe("#/reads/m/r15");
    expect(current?.getAttribute("data-stream-item")).toBe("r15");
    expect(expansion(reading, "r15")).toBe("true");

    act(() => void vi.advanceTimersByTime(2000));
    act(() => void window.dispatchEvent(new Event("pagehide")));
    expect(sent(mail)).toEqual([]);
    expect(ids.filter((id) => mail.engine.read().get<EngineMessage>("message", id)?.unread)).toEqual(ids);
  });

  it("a wheel, a touch or PageDown over the list moves it and marks nothing", () => {
    const { list, scroll, steps, key, check } = listReadVisit("News");
    fireEvent.wheel(list, { deltaY: 400 });
    steps(40, 400);
    fireEvent.touchMove(list, { touches: [{ clientX: 0, clientY: 80 }] });
    scroll(480);
    key("PageDown");
    steps(520, 900);
    check(880);
  });

  it("End in the list rests at the end and marks nothing", () => {
    const { end, check } = listReadVisit("News");
    end();
    check(1000);
  });
});

it.each([
  ["News", "reads", "feed_mark_seen reads r1"],
  ["Receipts", "receipts", "mark_seen r1 read glance"],
] as const)("a pending %s glance writes nothing while the tab is hidden", (place, route, mutation) => {
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  onTestFinished(() => {
    visibility.mockRestore();
  });
  const { address, mail, list, ids, unread } = listReadVisit(place);
  const row = list.querySelector<HTMLElement>('[data-id="r1"]')!;
  act(() => row.focus());
  expect(document.activeElement).toBe(row);
  const elapsed = (ms: number) => act(() => void vi.advanceTimersByTime(ms));
  const open = () => {
    fireEvent.click(row);
    nextFrame();
    expect(address.read()).toBe(`#/${route}/m/r1`);
  };
  open();
  elapsed(599);
  expect(sent(mail)).toEqual([]);
  visibility.mockReturnValue("hidden");
  fireEvent(document, new Event("visibilitychange"));
  elapsed(2000);
  expect(sent(mail), "the pending dwell came due in the background").toEqual([]);
  expect(unread()).toEqual(ids);

  visibility.mockReturnValue("visible");
  fireEvent(document, new Event("visibilitychange"));
  open();
  elapsed(600 + SEEN_QUIET_MS);
  expect(sent(mail), "a visible press can still read its exact chosen letter").toEqual([mutation]);
  expect(unread()).toEqual(ids.filter((id) => id !== "r1"));
});

describe("a jump from outside the pile leaves the message OPEN, not merely selected", () => {
  function previewVisit(itemHeight = 200) {
    laidOutTime("Date");
    const letters = Array.from({ length: 8 }, (_, i) => issue(`m${i}`, 20 - i));
    const { address, mail } = seat({ at: "#/reads", letters });
    const scroller = layOut("News stream", itemHeight, 900);
    firstFrame(scroller);
    act(() => void vi.advanceTimersByTime(20));
    nextFrame();
    const cards = [...scroller.querySelectorAll<HTMLElement>("[data-stream-item]")];
    expect(cards.map((card) => card.dataset.streamItem)).toEqual(letters.map((letter) => letter.id));

    const settle = () => {
      for (let i = 0; i < 12; i += 1) nextFrame();
      act(() => void vi.advanceTimersByTime(120));
    };
    const claim = async () => {
      const target = cards[5]!;
      expect(target.getBoundingClientRect().top).toBe(1000);
      expect(scroller.clientHeight).toBe(900);
      await act(async () => address.visit("#/reads/m/m5"));
      settle();
      expect(address.read()).toBe("#/reads/m/m5");
      expect(target.hasAttribute("data-open")).toBe(true);
      expect(target.getBoundingClientRect().top).toBeLessThan(scroller.clientHeight);
    };
    const expanded = () =>
      cards
        .filter((card) => expansion(scroller, card.dataset.streamItem!) === "true")
        .map((card) => card.dataset.streamItem);
    const noWrites = () => {
      act(() => void vi.advanceTimersByTime(2000));
      act(() => void window.dispatchEvent(new Event("pagehide")));
      expect(sent(mail)).toEqual([]);
    };

    return { address, scroller, cards, claim, settle, expanded, noWrites };
  }

  it("the landed card is OPEN — the reader asked for that message, not for its neighbourhood", async () => {
    const { claim, expanded, noWrites } = previewVisit();
    await claim();
    expect(expanded()).toEqual(["m5"]);
    noWrites();
  });

  it("exactly one card opens — a jump is not a licence to unclamp the pile", async () => {
    const { claim, expanded, noWrites } = previewVisit();
    await claim();
    expect(expanded()).toHaveLength(1);
    noWrites();
  });

  it("a visit with no jump opens nothing at all", () => {
    const { address, settle, expanded, noWrites } = previewVisit();
    settle();
    expect(address.read()).toBe("#/reads");
    expect(address.writes).toEqual([]);
    expect(expanded()).toHaveLength(0);
    noWrites();
  });

  it("a close of ANOTHER card leaves a pending jump alone", async () => {
    const { address, scroller, cards, settle, expanded, noWrites } = previewVisit(400);
    const other = within(cards[2]!);
    fireEvent.click(other.getByRole("button", { name: "Expand" }));
    settle();
    expect(expanded()).toEqual(["m2"]);
    land(scroller, 0);
    expect(cards[5]!.getBoundingClientRect().top).toBeGreaterThan(scroller.clientHeight * 2);

    const queuedBefore = nextFrameId;
    await act(async () => address.visit("#/reads/m/m5"));
    expect(
      [...frames.keys()].some((id) => id > queuedBefore),
      "the jump has a pending frame",
    ).toBe(true);
    expect(expanded(), "m5 has yet to land").toEqual(["m2"]);
    fireEvent.click(other.getByRole("button", { name: "Collapse" }));
    expect(expanded(), "only the other card closed while the jump was pending").toEqual([]);
    expect(address.read()).toBe("#/reads/m/m5");

    settle();
    expect(expanded()).toEqual(["m5"]);
    expect(cards[5]!.hasAttribute("data-open")).toBe(true);
    noWrites();
  });
});

describe("a search arrival among letters sharing one Date: Delete files the letter the reader shows", () => {
  for (const view of ["receipts", "reads"] as const) {
    it(`${view}: the opened card, the card cursor, the selected row and Delete stay on the pressed letter`, async () => {
      laidOutTime("Date");
      const news = view === "reads";
      const place = news ? "News" : "Receipts";
      const make = news ? issue : receipt;
      const target = "RC3";
      // The real mirror breaks Date ties by descending id. The hit has three cards above and one below.
      const letters = [6, 5, 4, 3, 2].map((id) => make(`RC${id}`, 10));
      const { address, mail } = seat({
        at: "#/search",
        letters,
        hit: hitAt(news ? "news" : "receipts", target),
      });
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Open the hit" }));
      });
      expect(address.read()).toBe(`#/${view}/m/${target}`);
      const scroller = layOut(`${place} stream`, 200, 860);
      const cards = () => [...scroller.querySelectorAll<HTMLElement>("[data-stream-item]")];
      const id = (card: HTMLElement) => card.dataset.streamItem!;
      expect(cards().map(id)).toEqual(letters.map((letter) => letter.id));
      const folded = (card: HTMLElement) => card.querySelector('button[aria-expanded="true"]') === null;
      const height = (card: HTMLElement) => (folded(card) ? 180 : 400);
      const above = (index: number) =>
        cards()
          .slice(0, index)
          .reduce((top, card) => top + height(card) + 20, 100);
      Object.defineProperty(scroller, "scrollHeight", {
        configurable: true,
        get: () => above(cards().length) + 48,
      });
      cards().forEach((card) => {
        card.getBoundingClientRect = () =>
          box(above(cards().indexOf(card)) - scroller.scrollTop, height(card));
      });
      firstFrame(scroller);
      const settle = (ms: number) => {
        for (let i = 0; i < ms / 20; i += 1) {
          nextFrame();
          act(() => void vi.advanceTimersByTime(20));
        }
      };
      settle(200);
      // One ordinary app scroll after the old jump's deadline must not steal the selection.
      vi.setSystemTime(Date.now() + 2000);
      fireEvent.scroll(scroller);
      settle(100);
      const list = screen.getByRole("region", { name: place });
      const open = cards()
        .filter((card) => !folded(card))
        .map(id);
      const current = scroller
        .querySelector("[data-stream-item][data-open]")
        ?.getAttribute("data-stream-item");
      const row = list.querySelector("[data-id][data-open]")?.getAttribute("data-id");

      expect(sent(mail), "the Search dwell has not come due").toEqual([]);
      press("Delete");
      expect(screen.getByRole("button", { name: /Undo/ })).toBeTruthy();
      expect(mail.mutations.filter((m) => m.kind === "message_delete")).toEqual([]);
      await act(async () => {
        vi.advanceTimersByTime(30_000);
      });
      const filed = mail.mutations.filter((m) => m.kind === "message_delete").map((m) => m.messageId);
      expect({ open, card: current, row, filed }).toEqual({
        open: [target],
        card: target,
        row: target,
        filed: [target],
      });
    });
  }

  it("a press on another card's Expand pill moves the cursor with it, so Delete files the card that shows the bar", async () => {
    laidOutTime("Date");
    const letters = [6, 5, 4, 3, 2].map((id) => receipt(`RC${id}`, 10));
    const { address, mail } = seat({ at: "#/receipts", letters });
    const reading = layOut("Receipts stream", 200, 860);
    firstFrame(reading);
    const list = screen.getByRole("region", { name: "Receipts" });
    const current = () =>
      reading.querySelector("[data-stream-item][data-open]")?.getAttribute("data-stream-item");
    const selected = () => list.querySelector("[data-id][data-open]")?.getAttribute("data-id");
    const settleSelection = () => {
      for (let i = 0; i < 6; i += 1) nextFrame();
      act(() => void vi.advanceTimersByTime(50));
    };

    // Select the preceding folded card through its own list row, without opening its fold.
    fireEvent.click(list.querySelector<HTMLElement>('[data-id="RC4"]')!);
    settleSelection();
    expect(address.read()).toBe("#/receipts/m/RC4");
    expect([current(), selected()]).toEqual(["RC4", "RC4"]);
    expect(expansion(reading, "RC4")).toBe("false");

    const target = reading.querySelector<HTMLElement>('[data-stream-item="RC3"]')!;
    fireEvent.click(within(target).getByRole("button", { name: "Expand" }));
    settleSelection();
    const open = letters.filter((m) => expansion(reading, m.id) === "true").map((m) => m.id);
    const card = current();
    const row = selected();
    const route = address.read();
    expect(screen.getByRole("toolbar", { name: "Actions" })).toBeTruthy();
    expect(sent(mail), "neither press has rested long enough to read").toEqual([]);

    press("Delete");
    expect(screen.getByRole("button", { name: /Undo/ })).toBeTruthy();
    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    const filed = mail.mutations.filter((m) => m.kind === "message_delete").map((m) => m.messageId);
    expect({ open, card, row, route, filed }).toEqual({
      open: ["RC3"],
      card: "RC3",
      row: "RC3",
      route: "#/receipts/m/RC3",
      filed: ["RC3"],
    });
  });
});

describe("the bar claims the reading, and the reading survives a reload", () => {
  function heldPreview() {
    laidOutTime("Date");
    const letters = Array.from({ length: 10 }, (_, i) => issue(`r${i}`, 20 - i));
    const { mail, address } = seat({ at: "#/reads", letters });
    const scroller = layOut("News stream");
    const target = "r7";
    const card = () => scroller.querySelector(`[data-stream-item="${target}"]`)!;
    const drain = () => {
      // The mounted frame keeps its own frame listeners alive. Exhaust the finite landing budget.
      for (let pass = 0; pass < 100; pass += 1) nextFrame();
    };
    firstFrame(scroller);
    drain();

    const visit = async (hash: string) => {
      await act(async () => address.visit(hash));
      expect(address.read()).toBe(hash);
    };
    const expanded = () => expansion(scroller, target);
    const link = async () => {
      // Reset only the test viewport so following the same link hits a far pending landing again.
      land(scroller, 0);
      drain();
      expect(card().getBoundingClientRect().top).toBeGreaterThan(2 * VIEW);
      expect(expanded()).toBe("false");

      const pendingBefore = nextFrameId;
      await visit(`#/reads/m/${target}`);
      expect(
        [...frames.keys()].some((id) => id > pendingBefore),
        "the far jump scheduled a frame",
      ).toBe(true);
      expect(card().getBoundingClientRect().top, "the jump has moved the viewport").toBe(14);
      expect(expanded(), "the far jump has yet to open the letter").toBe("false");
    };
    const back = async () => {
      await visit("#/reads");
      expect(expanded(), "the URL-owned card closes when Back reaches the pane").toBe("false");
    };
    const expectClosedAfterLanding = () => {
      drain();
      expect(expanded(), "a pending jump cannot reopen the letter after Back").toBe("false");
      expect(screen.getAllByRole("toolbar", { name: "Actions" })).toHaveLength(1);
      expect(address.read()).toBe("#/reads");
      expect(address.writes).toEqual([]);
      act(() => void vi.advanceTimersByTime(2000));
      expect(sent(mail)).toEqual([]);
    };
    return { link, back, drain, expanded, expectClosedAfterLanding };
  }

  it("a Back inside the jump's pending frame wins: the deep link does not re-open the card", async () => {
    const { link, back, expectClosedAfterLanding } = heldPreview();
    await link();
    await back();
    expectClosedAfterLanding();
  });

  it("a SECOND Back on the same message still wins over its pending jump", async () => {
    const { link, back, drain, expanded, expectClosedAfterLanding } = heldPreview();
    await link();
    drain();
    expect(expanded(), "the first link opens the letter").toBe("true");
    await back();
    expectClosedAfterLanding();

    await link();
    drain();
    expect(expanded(), "the same letter still opens after the reader closed it before").toBe("true");
    await back();
    expectClosedAfterLanding();

    await link();
    await back();
    expectClosedAfterLanding();
  });
});

describe("leaving commits the waterline — once, anchored, bounded", () => {
  it("THE STRUCTURAL MISS, CLOSED: leave at the bottom ⇒ one commit, anchored at the top, covering the last screenful", () => {
    laidOutTime("performance");
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const ids = Array.from({ length: 10 }, (_, i) => `r${i}`);
    const { mail } = seat({ at: "#/reads", letters: ids.map((id, i) => issue(id, 20 - i)) });
    const scroller = layOut("News stream", 200);
    layOutText(scroller);
    firstFrame(scroller);
    for (let top = 100; top <= 1400; top += 100) {
      wheel(scroller, top);
      act(() => void vi.advanceTimersByTime(20));
    }
    act(() => void vi.advanceTimersByTime(800));
    const commits = () => mail.mutations.filter((m) => m.kind === "feed_mark_seen" && m.upToId);
    expect(commits(), "the line stays fixed until the person leaves").toEqual([]);
    fireEvent.click(within(rail()).getByRole("button", { name: /^Ohbox/ }));
    act(() => void window.dispatchEvent(new Event("pagehide")));
    expect(commits()).toEqual([{ kind: "feed_mark_seen", view: "reads", upToId: "r0", messageIds: ids }]);
  });
});

describe("the read rule over every card on screen, after the reader's own scroll, press or open", () => {
  function keyVisit(place: "News" | "Receipts" = "News", alreadyRead?: string, clock?: "performance") {
    laidOutTime(clock);
    const news = place === "News";
    const make = news ? issue : receipt;
    const route = news ? "reads" : "receipts";
    const ids = Array.from({ length: news ? 40 : 10 }, (_, i) => `r${i}`);
    const letters = ids.map((id, i) => make(id, 20 - i, { unread: id !== alreadyRead }));
    const { mail, address } = seat({ at: `#/${route}`, letters });
    const scroller = layOut(`${place} stream`, 200);
    firstFrame(scroller);
    return {
      mail,
      address,
      scroller,
      marked: () =>
        mail.mutations.flatMap((mutation) => {
          if (news && mutation.kind === "feed_mark_seen" && mutation.view === "reads" && !mutation.upToId)
            return mutation.messageIds;
          if (!news && mutation.kind === "mark_seen" && !mutation.unread && mutation.via === "glance")
            return mutation.messageIds;
          return [];
        }),
      focusFirst: () => {
        const subject = within(screen.getByRole("region", { name: place })).getByText(letters[0]!.subject);
        const row = subject.closest<HTMLElement>('[data-id="r0"]');
        expect(row).not.toBeNull();
        act(() => row!.focus());
        expect(document.activeElement).toBe(row);
      },
    };
  }

  const elapsed = (ms: number) => act(() => void vi.advanceTimersByTime(ms));
  const step = (key: string) => {
    press(key);
    nextFrame();
  };
  const burst = (key: string) => {
    for (let i = 0; i < 3; i += 1) {
      step(key);
      elapsed(80);
    }
  };

  it("j j j 80ms apart, then a 2.5s rest: only the letter it stops on turns read", () => {
    const { address, marked } = keyVisit();
    burst("j");
    expect(address.read()).toBe("#/reads/m/r3");
    expect(marked(), "r1 and r2 were current for 80ms each").toEqual([]);
    elapsed(2500);
    expect(marked()).toEqual(["r3"]);
  });

  it("j three times 2.5s apart: nothing at a press, each letter it rests on read by the rule, nothing else on screen", () => {
    const { address, marked } = keyVisit();
    for (const id of ["r1", "r2", "r3"]) {
      step("j");
      expect(address.read()).toBe(`#/reads/m/${id}`);
      expect(marked().includes(id), `${id} at the press`).toBe(false);
      elapsed(2500);
      expect(marked().at(-1), `${id} after resting on it`).toBe(id);
    }
    expect(marked()).toEqual(["r1", "r2", "r3"]);
  });

  function focusedBurst(key: string) {
    const visit = keyVisit();
    visit.focusFirst();
    burst(key);
    expect(visit.address.read()).toBe("#/reads/m/r3");
    expect(visit.marked(), "a fast pass reads nothing").toEqual([]);
    return visit;
  }

  for (const key of ["ArrowDown", "j"])
    it(`${key} ×3 80ms apart in the list marks nothing; resting 0.8s on the third reads only it`, () => {
      const { marked } = focusedBurst(key);
      // The engine sees the write after the separate quiet period for a batch of eligible reads.
      elapsed(800 + SEEN_QUIET_MS);
      expect(marked()).toEqual(["r3"]);
      elapsed(3000);
      expect(marked(), "the step entered nothing").toEqual(["r3"]);

      // In a fresh visit, pagehide drains eligible reads without advancing the dwell clock.
      cleanup();
      const { mail } = focusedBurst(key);
      elapsed(800);
      expect(sent(mail)).toEqual([]);
      act(() => void window.dispatchEvent(new Event("pagehide")));
      expect(sent(mail), "only r3 is eligible at 800ms, with no waterline write").toEqual([
        "feed_mark_seen reads r3",
      ]);
    });

  it("↓ in the Receipts list marks nothing at the press; resting 0.8s reads only its target", () => {
    const { address, marked, focusFirst } = keyVisit("Receipts");
    focusFirst();
    step("ArrowDown");
    expect(address.read()).toBe("#/receipts/m/r1");
    elapsed(80);
    expect(marked()).toEqual([]);
    elapsed(3000);
    expect(marked()).toEqual(["r1"]);
  });

  it("a Mark unread holds when j steps away and k comes back to it", () => {
    const { address, mail, marked, scroller } = keyVisit("News", "r2");
    const stepAndRest = (key: string) => {
      step(key);
      elapsed(1000);
    };
    stepAndRest("j");
    stepAndRest("j");
    const actions = within(screen.getByRole("toolbar", { name: "Actions" }));
    fireEvent.click(actions.getByRole("button", { name: "Mark unread" }));
    expect(sent(mail)).toContain("mark_seen r2 unread");
    act(() => mail.patch("r2", { unread: true }));
    stepAndRest("j");
    stepAndRest("k");
    expect(address.read(), "the cursor is back on r2").toBe("#/reads/m/r2");
    expect(scroller.querySelector("[data-stream-item][data-open]")?.getAttribute("data-stream-item")).toBe(
      "r2",
    );
    expect(marked()).toEqual(["r1", "r3"]);
  });

  it("a Mark unread while the stream's dwell ticks holds", () => {
    const { address, mail, marked, scroller } = keyVisit("News", "r3");
    fireEvent.wheel(scroller, { deltaY: 120 });
    for (const top of [100, 200, 300, 400, 500, 3 * 200 - 14]) {
      land(scroller, top);
      elapsed(20);
    }
    elapsed(40);
    elapsed(500);
    expect(address.read()).toBe("#/reads");
    expect(scroller.querySelector("[data-stream-item][data-open]")?.getAttribute("data-stream-item")).toBe(
      "r3",
    );
    // The wheel chose the card without addressing it. Open that same row to reach its actions.
    const news = screen.getByRole("region", { name: "News" });
    fireEvent.click(news.querySelector('[role="option"][data-id="r3"]')!);
    const actions = within(screen.getByRole("toolbar", { name: "Actions" }));
    fireEvent.click(actions.getByRole("button", { name: "Mark unread" }));
    expect(sent(mail)).toContain("mark_seen r3 unread");
    act(() => mail.patch("r3", { unread: true }));
    elapsed(2500);
    expect(marked()).not.toContain("r3");
  });

  function markUnreadAtLine() {
    const visit = keyVisit("News", "r3", "performance");
    const { mail, scroller } = visit;
    const card = () => scroller.querySelector<HTMLElement>('[data-stream-item="r3"]')!;
    const current = () =>
      scroller.querySelector("[data-stream-item][data-open]")?.getAttribute("data-stream-item");
    const wheelTo = (target: number) => {
      let top = scroller.scrollTop;
      fireEvent.wheel(scroller, { deltaY: target > top ? 120 : -120 });
      while (top !== target) {
        top = target > top ? Math.min(target, top + 100) : Math.max(target, top - 100);
        land(scroller, top);
        elapsed(20);
      }
      elapsed(40);
    };
    wheelTo(3 * 200 - 14);
    elapsed(500);
    expect(current()).toBe("r3");
    expect(card().getBoundingClientRect().top).toBe(14);
    // The wheel chose the card without addressing it. Open that same row to reach its actions.
    const news = screen.getByRole("region", { name: "News" });
    fireEvent.click(news.querySelector('[role="option"][data-id="r3"]')!);
    const actions = within(screen.getByRole("toolbar", { name: "Actions" }));
    fireEvent.click(actions.getByRole("button", { name: "Mark unread" }));
    expect(sent(mail)).toContain("mark_seen r3 unread");
    act(() => mail.patch("r3", { unread: true }));
    return { ...visit, card, current, wheelTo };
  }

  it("a Mark unread holds when the stream comes back to it at the reading line", () => {
    const { card, current, marked, wheelTo } = markUnreadAtLine();
    wheelTo(6000);
    expect(current()).toBe("r30");
    wheelTo(3 * 200 - 14);
    elapsed(2500);
    expect(current()).toBe("r3");
    expect(card().getBoundingClientRect().top).toBe(14);
    expect(marked()).not.toContain("r3");
  });

  it("a Mark unread holds when an upward wheel shows only its foot", () => {
    const { card, current, marked, wheelTo } = markUnreadAtLine();
    wheelTo(6000);
    elapsed(2500);
    expect(current()).toBe("r30");
    wheelTo(4 * 200 - 14);
    elapsed(2500);
    expect(current()).toBe("r4");
    expect(card().getBoundingClientRect().bottom).toBe(14);
    expect(marked()).not.toContain("r3");
  });

  function farViewport() {
    const visit = keyVisit("News", undefined, "performance");
    const { scroller } = visit;
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    layOutText(scroller);
    const settleFrames = () => {
      for (let i = 0; i < 20; i += 1) {
        nextFrame();
        elapsed(20);
      }
    };
    const selected = () =>
      scroller.querySelector("[data-stream-item][data-open]")?.getAttribute("data-stream-item");
    const card = (id: string) => scroller.querySelector(`[data-stream-item="${id}"]`)!;
    const offset = 30 * 200 - 14;
    const backUp = () => {
      fireEvent.wheel(scroller, { deltaY: -81 });
      land(scroller, offset - 81);
      elapsed(40);
    };
    return { ...visit, settleFrames, selected, card, offset, backUp };
  }

  it("after a far open, an upward wheel that leaves the opened card's head on screen: the cursor stays on it", () => {
    const { address, mail, scroller, settleFrames, selected, card, offset, backUp } = farViewport();
    const list = screen.getByRole("region", { name: "News" }).querySelector<HTMLElement>(".pl-scroll")!;
    Object.defineProperty(list, "clientHeight", { configurable: true, get: () => VIEW });
    list.scrollTop = 2000;
    fireEvent.scroll(list);
    nextFrame();
    const row = list.querySelector<HTMLElement>('[data-id="r30"]')!;
    expect(row, "the far row is mounted").not.toBeNull();
    fireEvent.click(row);
    layOut("News stream", 200);
    settleFrames();
    expect(address.read()).toBe("#/reads/m/r30");
    expect(scroller.scrollTop, "r30 at the reading line").toBe(offset);
    elapsed(3000);
    expect(sent(mail)).toEqual(["feed_mark_seen reads r30,r31,r32"]);

    backUp();
    elapsed(2500);
    expect(card("r30").getBoundingClientRect().top).toBe(95);
    expect(selected()).toBe("r30");
    expect(sent(mail)).toEqual(["feed_mark_seen reads r30,r31,r32"]);
  });

  it("after a far leap, an upward wheel that leaves the card above 95px of its foot: its dwell reads nothing", () => {
    const { address, mail, scroller, settleFrames, selected, card, offset, backUp } = farViewport();
    land(scroller, offset);
    layOut("News stream", 200);
    land(scroller, offset);
    settleFrames();
    expect(scroller.scrollTop, "r30 at the reading line").toBe(offset);
    elapsed(3000);
    expect(sent(mail)).toEqual([]);
    backUp();
    elapsed(2500);
    expect(address.read()).toBe("#/reads");
    expect(card("r29").getBoundingClientRect().bottom).toBe(95);
    expect(selected(), "the cursor moved to r29").toBe("r29");
    expect(sent(mail), "the partly visible r29 was never read").toEqual(["feed_mark_seen reads r30,r31"]);
  });
});

describe("a letter answered in place", () => {
  const settleFrames = (afterFrame?: () => void) => {
    for (let i = 0; i < 12; i += 1) {
      nextFrame();
      afterFrame?.();
    }
  };

  function layOutReply(scroller: HTMLElement) {
    const geometry = laidOutStreams.get(scroller)!;
    const height = (id: string) =>
      scroller
        .querySelector(`[data-stream-item="${id}"]`)
        ?.parentElement?.querySelector(".oh-composer[data-reply]")
        ? 900
        : 200;
    geometry.cardHeight = height;
    Object.defineProperty(scroller, "scrollHeight", {
      configurable: true,
      get: () => geometry.ids().reduce((sum, id) => sum + height(id), 0),
    });
  }

  async function openReply(place: "News" | "Receipts" = "News") {
    laidOutTime("Date");
    const make = place === "News" ? issue : receipt;
    const route = place === "News" ? "reads" : "receipts";
    const letters = Array.from({ length: 10 }, (_, i) => make(`r${i}`, 20 - i));
    const { mail, address } = seat({ at: `#/${route}/m/r1`, withReply: true, letters });
    await act(() => vi.advanceTimersByTimeAsync(30));
    const scroller = layOut(`${place} stream`, 200);
    layOutReply(scroller);
    firstFrame(scroller);
    settleFrames();
    fireEvent.click(
      within(screen.getByRole("toolbar", { name: "Actions" })).getByRole("button", { name: "Reply" }),
    );
    const editor = () => within(scroller).queryByRole("textbox", { name: "Reply body" });
    const cursor = () =>
      scroller.querySelector("[data-stream-item][data-open]")?.getAttribute("data-stream-item");
    const reply = editor();
    expect(reply).not.toBeNull();
    const close = async () => {
      await act(async () => {
        fireEvent.keyDown(reply!, { key: "Escape" });
      });
      const cursors = [cursor()];
      settleFrames(() => cursors.push(cursor()));
      expect(editor()).toBeNull();
      return cursors;
    };
    return {
      mail,
      address,
      scroller,
      reply: reply!,
      close,
      top: (id: string) => scroller.querySelector(`[data-stream-item="${id}"]`)!.getBoundingClientRect().top,
      cursor,
    };
  }

  it("typing its reply scrolls nothing: leaving writes no \\Seen, a later app scroll marks nothing", async () => {
    for (const place of ["News", "Receipts"] as const) {
      const { mail, scroller, reply, close } = await openReply(place);
      const reads = () => mail.mutations.filter((m) => m.kind === "feed_mark_seen" || m.kind === "mark_seen");
      const beforeTyping = scroller.scrollTop;
      for (const key of ["o", " ", "End"]) fireEvent.keyDown(reply, { key });
      settleFrames();
      expect(scroller.scrollTop, place).toBe(beforeTyping);
      await close();
      land(scroller, 800);
      act(() => void vi.advanceTimersByTime(1500));
      settleFrames();
      expect.soft(reads(), place).toEqual([]);
      fireEvent.click(within(rail()).getByRole("button", { name: /^Ohbox/ }));
      expect.soft(reads(), place).toEqual([]);
      cleanup();
    }
  });

  it("after Esc the card comes back at the reading line, the cursor still on it", async () => {
    const { address, scroller, close, top, cursor } = await openReply();
    land(scroller, 400);
    act(() => void vi.advanceTimersByTime(5000));
    settleFrames();
    expect(top("r1"), "the letter's head is above the port").toBeLessThan(0);
    expect(cursor()).toBe("r1");

    expect(new Set(await close()), "the reader stays on r1 during the return").toEqual(new Set(["r1"]));
    expect(top("r1"), "its head is at the reading line").toBe(14);
    expect(cursor()).toBe("r1");
    expect(address.read()).toBe("#/reads/m/r1");
  });

  it("read on below it, Esc leaves the stream on the card being read, the cursor with it", async () => {
    const { address, scroller, close, top, cursor } = await openReply();
    const onLine = () =>
      [...scroller.querySelectorAll("[data-stream-item]")]
        .filter((card) => card.getBoundingClientRect().top <= 90)
        .at(-1)
        ?.getAttribute("data-stream-item");
    wheel(scroller, 1300);
    act(() => void vi.advanceTimersByTime(5000));
    settleFrames();
    expect(top("r2"), "the earlier letter is above the port").toBeLessThan(0);
    expect(onLine(), "the card at the reading line").toBe("r3");
    expect(cursor(), "the cursor followed the person reading on").toBe("r3");
    const beforeClose = top("r3");

    expect(new Set(await close()), "the reader stays on r3 during the return").toEqual(new Set(["r3"]));
    expect(onLine(), "the card at the reading line").toBe("r3");
    expect(cursor()).toBe("r3");
    expect(top("r3"), "the reading position is unchanged").toBe(beforeClose);
    expect(address.read()).toBe("#/reads/m/r1");
  });
});

describe("pending Receipts bodies earn read evidence in the reading viewport", () => {
  function pendingReceipts(height = 200) {
    laidOutTime("performance");
    const focused = vi.spyOn(document, "hasFocus").mockReturnValue(true);
    onTestFinished(() => focused.mockRestore());
    const letters = Array.from({ length: 10 }, (_, i) => receipt(`r${i}`, 20 - i, { body: undefined }));
    const { mail } = seat({ at: "#/receipts", letters });
    const scroller = layOut("Receipts stream", height);
    layOutText(scroller);
    firstFrame(scroller);
    return { focused, mail, scroller };
  }

  const leaveReceipts = () => fireEvent.click(within(rail()).getByRole("button", { name: /^Ohbox/ }));

  function checkSnippetLeave(rest: number, live: readonly string[], ids: readonly string[]) {
    const { mail, scroller } = pendingReceipts();
    wheel(scroller, 110);
    act(() => void vi.advanceTimersByTime(20 + 40 + rest));
    expect.soft(sent(mail), "live writes before leaving").toEqual(live);
    leaveReceipts();
    expect(mail.mutations.filter((m) => m.kind === "feed_mark_seen")).toEqual([
      { kind: "feed_mark_seen", view: "receipts", upToId: "r0", messageIds: ids },
    ]);
  }

  it("a snippet card on screen under 0.7s is not read by the leave", () => {
    checkSnippetLeave(300, [], ["r0"]);
  });

  it("Receipts snippet cards are read by the leave alone, by the same rule; the foot card is not", () => {
    checkSnippetLeave(900, ["mark_seen r0 read glance"], ["r0", "r1", "r2"]);
  });

  it("keeps the original live band glance when a wheel carries its first receipt offscreen", () => {
    const { mail, scroller } = pendingReceipts(300);
    wheel(scroller, 400);
    act(() => void vi.advanceTimersByTime(SEEN_QUIET_MS));
    expect(sent(mail)).toEqual(["mark_seen r0 read glance"]);
    leaveReceipts();
    expect(sent(mail)).toEqual(["mark_seen r0 read glance", "feed_mark_seen receipts up to r0 r0"]);
  });

  it("does not glance an old-band receipt passed by an application landing", () => {
    const { mail, scroller } = pendingReceipts(300);
    const list = screen.getByRole("region", { name: "Receipts" });
    const row = list.querySelector<HTMLElement>('[data-id="r6"]')!;
    expect(row, "the jump target is in the real list").not.toBeNull();
    fireEvent.click(row);
    for (let pass = 0; pass < 12; pass += 1) {
      nextFrame();
      act(() => void vi.advanceTimersByTime(20));
    }
    expect(scroller.scrollTop).toBeGreaterThan(1200);
    expect(sent(mail)).not.toContain("mark_seen r0 read glance");

    wheel(scroller, scroller.scrollTop + 20);
    act(() => void vi.advanceTimersByTime(SEEN_QUIET_MS));
    expect(sent(mail)).not.toContain("mark_seen r0 read glance");
  });

  it("does not renew old Receipts band evidence when End interrupts an armed rest", () => {
    const { mail, scroller } = pendingReceipts(300);
    act(() => void vi.advanceTimersByTime(599));
    expect(scroller.scrollTop).toBe(0);
    fireEvent.keyDown(scroller, { key: "End" });
    // A pending rest goes due before the first browser scroll frame of the End jump.
    act(() => void vi.advanceTimersByTime(2));
    land(scroller, scroller.scrollHeight - scroller.clientHeight);
    act(() => void vi.advanceTimersByTime(601));
    expect(sent(mail)).not.toContain("mark_seen r0 read glance");

    fireEvent.wheel(scroller, { deltaY: -20 });
    land(scroller, scroller.scrollTop - 20);
    act(() => void vi.advanceTimersByTime(SEEN_QUIET_MS));
    expect(sent(mail)).not.toContain("mark_seen r0 read glance");
  });

  it("does not owe a pending snippet only briefly visible before wheeling back", () => {
    const { mail, scroller } = pendingReceipts();
    wheel(scroller, 300);
    act(() => void vi.advanceTimersByTime(100));
    fireEvent.wheel(scroller, { deltaY: -120 });
    land(scroller, 40);
    act(() => void vi.advanceTimersByTime(100));
    expect(sent(mail)).not.toContain("mark_seen r3 read glance");
    leaveReceipts();
    expect(
      mail.mutations.filter((m) => m.kind === "feed_mark_seen").flatMap((m) => m.messageIds),
    ).not.toContain("r3");
  });

  it("owes a pending receipt when its text beginning and end dwell with the sender clipped", () => {
    const { mail, scroller } = pendingReceipts(300);
    const receipt = scroller.querySelector('[data-stream-item="r0"]')!;
    wheel(scroller, 40);
    expect(receipt.querySelector("[data-sender-line]")!.getBoundingClientRect().bottom).toBeLessThan(0);
    const text = receipt.querySelector(".oh-message-clip")!.getBoundingClientRect();
    expect(text.top).toBeGreaterThan(0);
    expect(text.bottom).toBeLessThan(scroller.clientHeight);
    act(() => void vi.advanceTimersByTime(701));
    expect(sent(mail)).toEqual([]);
    leaveReceipts();
    expect(sent(mail)).toEqual(["feed_mark_seen receipts up to r0 r0,r1"]);
  });

  it.each(["hidden", "unfocused"] as const)("does not finish a snippet dwell while %s", (state) => {
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    onTestFinished(() => visibility.mockRestore());
    const { focused, mail, scroller } = pendingReceipts();
    wheel(scroller, 110);
    act(() => void vi.advanceTimersByTime(500));
    const live = "mark_seen r0 read glance";
    expect(sent(mail)).toEqual([live]);
    if (state === "hidden") {
      visibility.mockReturnValue("hidden");
      fireEvent(document, new Event("visibilitychange"));
    } else {
      focused.mockReturnValue(false);
      fireEvent(window, new Event("blur"));
    }
    act(() => void vi.advanceTimersByTime(800));
    expect(sent(mail), "loss of attention earned nothing further").toEqual([live]);
    leaveReceipts();
    expect(sent(mail)).toEqual([live, "feed_mark_seen receipts up to r0 r0"]);
  });

  it("keeps a pending receipt unread after the visit earned its leave contribution", () => {
    const { mail, scroller } = pendingReceipts();
    wheel(scroller, 110);
    act(() => void vi.advanceTimersByTime(960));
    act(() => mail.patch("r1", { unread: false }));
    act(() => mail.patch("r1", { unread: true }));
    leaveReceipts();
    expect(sent(mail)).toEqual(["mark_seen r0 read glance", "feed_mark_seen receipts up to r0 r0,r2"]);
  });
});

it("moves only the selected account-authored News card on a phone and undoes that move", async () => {
  const own = "owner@example.invalid";
  const threadId = "conversation";
  const { mail } = seat({
    at: "#/reads",
    phone: true,
    mailboxes: async () => [
      {
        id: "mb-1",
        address: own,
        addressIsOwn: true,
        status: "active",
      } as MailboxFacts,
    ],
    letters: [
      issue("written", 13, { threadId, from: { name: "Account owner", address: own } }),
      issue("received", 12, { threadId }),
    ],
  });
  const record = mail.engine.mutate.bind(mail.engine);
  vi.spyOn(mail.engine, "mutate").mockImplementation(async (action) => {
    const answer = await record(action);
    if (action.kind === "move") mail.patch(action.messageId, { folder: action.folder, placeDecided: true });
    return answer;
  });
  await settle();
  const card = within(screen.getByRole("heading", { name: "Issue 13" }).closest("article")!);
  fireEvent.click(card.getByRole("button", { name: "Select the message" }));
  const bar = within(screen.getByRole("toolbar", { name: "Selection" }));
  fireEvent.click(bar.getByRole("button", { name: "Move" }));
  fireEvent.click(
    within(screen.getByRole("dialog", { name: "Move" })).getByRole("menuitem", { name: "Ohbox" }),
  );
  await settle();

  const moves = () => mail.mutations.filter((action) => action.kind === "move");
  expect(moves().map(({ messageId, folder }) => [messageId, folder])).toEqual([["written", "INBOX"]]);
  expect(screen.getByRole("heading", { name: "Issue 12" })).toBeTruthy();
  expect(screen.queryByRole("heading", { name: "Issue 13" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /Undo/ }));
  await settle();

  expect(moves().map(({ messageId, folder }) => [messageId, folder])).toEqual([
    ["written", "INBOX"],
    ["written", "ohmail/News"],
  ]);
  expect(screen.getByRole("heading", { name: "Issue 13" })).toBeTruthy();
});

it("screens eligible Ohbox letters from the selected sender and leaves other senders alone", async () => {
  const { mail } = seat({
    at: "#/ohbox",
    letters: [
      issue("chosen", 13, { folder: "INBOX", placeDecided: true }),
      issue("same-sender", 12, { folder: "INBOX", placeDecided: true }),
      receipt("other-sender", 11, { folder: "INBOX", placeDecided: true }),
    ],
  });
  await settle();
  const chosen = screen.getByRole("option", { name: /Issue 13/ });
  fireEvent.click(within(chosen.parentElement!).getByRole("button", { name: "Select the message" }));
  fireEvent.click(
    within(screen.getByRole("toolbar", { name: "Selection" })).getByRole("button", { name: "Screening" }),
  );
  fireEvent.click(
    within(screen.getByRole("dialog", { name: "Screen to" })).getByRole("menuitem", { name: "News" }),
  );
  fireEvent.click(
    within(screen.getByRole("dialog", { name: /senders? · News\./ })).getByRole("menuitem", {
      name: "Screen them",
    }),
  );
  await settle();

  const moves = mail.mutations.filter((action) => action.kind === "move");
  expect(moves.map(({ messageId, folder }) => [messageId, folder])).toEqual([
    ["chosen", "ohmail/News"],
    ["same-sender", "ohmail/News"],
  ]);
  expect(screen.getByRole("option", { name: /Order 11/ })).toBeTruthy();
});
