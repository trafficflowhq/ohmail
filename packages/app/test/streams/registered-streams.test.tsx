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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineMutation } from "@ohmail/wire";
import { SYNC_BOOTSTRAPPING, SYNC_SETTLED } from "@ohmail/app-logic/session/sync-scheduler";
import { hitAt, issue, mountStreamFrame as seat, receipt } from "./registered-world.js";

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
function layOut(name: string): HTMLElement {
  const stream = screen.getByRole("region", { name });
  const scroller = stream.querySelector<HTMLElement>(".oh-sheet-scroll")!;
  const items = [...scroller.querySelectorAll<HTMLElement>("[data-stream-item]")];
  Object.defineProperty(scroller, "clientHeight", { configurable: true, get: () => VIEW });
  Object.defineProperty(scroller, "scrollHeight", { configurable: true, get: () => items.length * ITEM });
  scroller.getBoundingClientRect = () => box(0, VIEW);
  items.forEach((el, i) => {
    el.getBoundingClientRect = () => box(i * ITEM - scroller.scrollTop, ITEM);
  });
  scroller.scrollTo = ((o: ScrollToOptions) => {
    scroller.scrollTop = o.top ?? 0;
    fireEvent.scroll(scroller);
  }) as typeof scroller.scrollTo;
  return scroller;
}
let frames: FrameRequestCallback[] = [];
function nextFrame(): void {
  const due = frames;
  frames = [];
  act(() => {
    for (const cb of due) cb(performance.now());
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
function laidOutTime(): void {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  frames = [];
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb));
  vi.stubGlobal("cancelAnimationFrame", () => {});
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
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("News and Receipts on their own seats, over the mail ground", () => {
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
      within(screen.getByRole("toolbar", { name: "Actions" })).getByRole("button", { name: "More" }),
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Move" }));
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
    fireEvent.click(within(screen.getByRole("toolbar", { name: "Actions" })).getByRole("button", { name: "Reply" }));
    const reply = within(scroller).getByRole("textbox", { name: "Reply body" });
    fireEvent.keyDown(reply, { key: "o" });
    fireEvent.keyDown(reply, { key: " " });
    fireEvent.keyDown(reply, { key: "n" });
    fireEvent.keyDown(reply, { key: "PageDown" });
    fireEvent.click(within(rail()).getByRole("button", { name: /^Ohbox/ }));
    expect(sent(mail).filter((write) => write.startsWith("feed_mark_seen") || write.startsWith("mark_seen"))).toEqual([]);
  });

  it.each(["addressed letter", "plain revisit"])("Move uses the visible stream card after scrolling from %s", async (start) => {
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
    expect(now.querySelector<HTMLElement>("[data-stream-item][data-open]")?.dataset.streamItem).toBe("letter-4");
    expect(address.read()).toBe(at);
    const panel = within(screen.getByRole("toolbar", { name: "Actions" }));
    fireEvent.click(panel.getByRole("button", { name: "More" }));
    fireEvent.click(within(screen.getByRole("menu", { name: "More" })).getByRole("menuitem", { name: "Move" }));
    fireEvent.click(within(screen.getByRole("menu", { name: "Move" })).getByRole("menuitem", { name: "Ohbox" }));
    expect(mail.mutations.filter((m) => m.kind === "move")).toEqual([
      expect.objectContaining({ kind: "move", messageId: "letter-4", folder: "INBOX" }),
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
    act(() => void vi.advanceTimersByTime(2000));
    expect(sent(mail)).toEqual(["feed_mark_seen reads n2"]);
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
    fireEvent.click(screen.getByRole("menuitem", { name: /Mark all read/ }));
    await settle();
    expect(sent(mail)).toEqual(["mark_seen n3,n2,n1 read", "feed_mark_seen reads up to n3"]);
    expect(said()).toBe("3 items marked read");
    press("z");
    await settle();
    expect(sent(mail).slice(2, 3)).toEqual(["mark_seen n3,n2,n1 unread"]);
    /* The line goes back as it stood: none was drawn, so the Undo clears the one the press drew. */
    expect(mail.mutations.slice(3).map((m) => m.kind)).toEqual(["feed_mark_seen"]);
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
] as const)("fetches the bodies of just the cards that approach the %s stream", (at, message) => {
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
    message("entry-" + i, 28 - i, { unread: i < 5, body: undefined }),
  );
  const { mail } = seat({ at, letters });
  expect(report).toBeDefined();
  const cards = [...watched].filter((node) => node.dataset.streamItem);
  expect(cards).toHaveLength(letters.length);
  const near = new Set(["entry-1", "entry-3", "entry-12"]);
  const state = cards.map((target) => ({ target, isIntersecting: near.has(target.dataset.streamItem!) }));
  act(() => report!(state));
  expect(new Set(mail.bodyAsks)).toEqual(near);
  act(() => report!(state));
  expect(mail.bodyAsks).toHaveLength(near.size);
  cleanup();
  act(() => report!(cards.map((target) => ({ target, isIntersecting: true }))));
  expect(mail.bodyAsks).toHaveLength(near.size);
});

it("loads a linked stream item before its position is reported and leaves the other bodies alone", () => {
  const letters = Array.from({ length: 15 }, (_, i) => issue("item-" + i, 28 - i, { body: undefined }));
  const { mail } = seat({ at: "#/reads/m/item-12", letters });
  expect(mail.bodyAsks).toEqual(["item-12"]);
});
