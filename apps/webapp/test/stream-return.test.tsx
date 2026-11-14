/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { issue, mountStreamFrame, receipt } from "../../../packages/app/test/streams/registered-world.js";

beforeEach(() => {
  localStorage.clear();
  Element.prototype.animate ??= () => ({ cancel() {}, finished: Promise.resolve() }) as unknown as Animation;
  HTMLElement.prototype.scrollTo ??= () => undefined;
  HTMLElement.prototype.scrollIntoView ??= () => undefined;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const places = [
  ["News", "reads", issue, "Receipts", "Issue"],
  ["Receipts", "receipts", receipt, "News", "Order"],
] as const;

function start(route: string) {
  const letters = places.flatMap(([, pile, letter]) =>
    Array.from({ length: 10 }, (_, i) => letter(`${pile}-${i}`, 20 - i)),
  );
  const { address, mail } = mountStreamFrame({ at: `#/${route}`, letters, withReply: true });
  const rail = within(screen.getByRole("navigation", { name: "Places" }));
  const go = (name: string) => fireEvent.click(rail.getByRole("button", { name: new RegExp(`^${name}`) }));
  const reading = (name: string) => screen.getByRole("region", { name: `${name} stream` });
  return { address, mail, go, reading };
}

it.each(places)("%s shows mirror changes on the first draw after a return", (name, route, letter, other, subject) => {
  const { go, mail, reading } = start(route);
  expect(within(reading(name)).getByRole("heading", { name: `${subject} 18` })).toBeTruthy();
  go(other);
  act(() => {
    mail.patch(`${route}-2`, { subject: "A changed subject" });
    mail.patch(`${route}-4`, { folder: "INBOX" });
    mail.add(letter("just-in", 21, { subject: "New while away" }));
  });
  go(name);
  const cards = within(reading(name));
  expect(cards.getByRole("heading", { name: "A changed subject" })).toBeTruthy();
  expect(cards.getByRole("heading", { name: "New while away" })).toBeTruthy();
  expect(cards.queryByRole("heading", { name: `${subject} 18` })).toBeNull();
  expect(cards.queryByRole("heading", { name: `${subject} 16` })).toBeNull();
});

it.each(places)("%s discards earlier openings and resets the shared action target on return", (name, route, _letter, other, subject) => {
  const { go, mail, reading } = start(route);
  const press = (day: number) => fireEvent.click(within(reading(name)).getByRole("heading", { name: `${subject} ${day}` }));
  press(20);
  press(19);
  expect(within(reading(name)).getAllByRole("button", { name: "Collapse" })).toHaveLength(2);
  expect(screen.getAllByRole("toolbar", { name: "Actions" })).toHaveLength(1);
  go(other);
  const writes = [...mail.mutations];
  go(name);
  expect(within(reading(name)).queryByRole("button", { name: "Collapse" })).toBeNull();
  expect(screen.getAllByRole("toolbar", { name: "Actions" })).toHaveLength(1);
  expect(screen.getByRole("option", { name: new RegExp(`${subject} 20`), selected: true })).toBeTruthy();
  go(other);
  expect(mail.mutations).toEqual(writes);
});

it("repeated rail switches leave only the final stream visible and commit nothing", () => {
  const { go, mail, reading } = start("ohbox");
  for (const place of ["News", "Receipts", "News", "Receipts", "News"]) go(place);
  expect(within(reading("News")).getByRole("heading", { name: "Issue 20" })).toBeTruthy();
  expect(screen.queryByRole("region", { name: "Receipts stream" })).toBeNull();
  act(() => void window.dispatchEvent(new Event("pagehide")));
  expect(mail.mutations).toEqual([]);
});

const CARD = 200;
const VIEW = 600;

function geometry() {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  let frames = new Map<number, FrameRequestCallback>();
  let serial = 0;
  vi.stubGlobal("requestAnimationFrame", (run: FrameRequestCallback) => {
    frames.set(++serial, run);
    return serial;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  const frame = (ms = 20) => {
    const pending = frames;
    frames = new Map();
    act(() => {
      vi.advanceTimersByTime(ms);
      for (const run of pending.values()) run(performance.now());
    });
  };
  const rootClass = ".oh-sheet-scroll";
  const original = HTMLElement.prototype.getBoundingClientRect;
  const shown = (card: HTMLElement, scroller: HTMLElement) => {
    const id = card.dataset.streamItem ?? card.dataset.streamWindowItem!;
    const number = id === "just-in" ? 0 : Number(id.split("-").at(-1)) +
      Number(Boolean(scroller.querySelector('[data-stream-item="just-in"]')));
    return number * CARD - scroller.scrollTop;
  };
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const scroller = this.closest<HTMLElement>(rootClass);
    if (!scroller) return original.call(this);
    if (this === scroller) return new DOMRect(0, 0, VIEW, VIEW);
    const wrapper = this.dataset.streamWindowItem;
    const card = this.closest<HTMLElement>("[data-stream-item]");
    if (!wrapper && !card) return original.call(this);
    const top = shown(card ?? this, scroller);
    if (wrapper || this === card) return new DOMRect(0, top, VIEW, CARD);
    if (this.matches("[data-sender-line]")) return new DOMRect(0, top + 16, VIEW, 20);
    if (this.matches(".oh-message-clip, .oh-message-body, [data-read-body]")) return new DOMRect(0, top + 70, VIEW, 100);
    return original.call(this);
  });
  const track = (region: HTMLElement) => {
    const scroller = region.querySelector<HTMLElement>(rootClass)!;
    Object.defineProperties(scroller, {
      clientHeight: { get: () => VIEW },
      scrollHeight: { get: () => 10 * CARD },
      scrollTo: { value: ({ top = 0 }: ScrollToOptions) => move(top) },
    });
    function move(top: number) {
      scroller.scrollTop = top;
      fireEvent.scroll(scroller);
    }
    move(scroller.scrollTop);
    frame();
    const displayed = new Set<string>();
    function record() {
      for (const card of scroller.querySelectorAll<HTMLElement>("[data-stream-item]")) {
        const top = shown(card, scroller);
        if (top >= 0 && top + CARD <= VIEW) displayed.add(card.dataset.streamItem!);
      }
    }
    return {
      scroller,
      displayed,
      wheel(top: number) {
        record();
        fireEvent.wheel(scroller, { deltaY: top - scroller.scrollTop });
        for (let p = scroller.scrollTop + 100; p <= top; p += 100) {
          move(p);
          frame();
          record();
        }
        frame();
        frame();
        frame(850);
        record();
      },
    };
  };
  return { track, frame };
}

it.each(places)("%s returns at the top, and pagehide only commits cards seen in the visible visit",
  (name, route, letter, other) => {
    const { track, frame } = geometry();
    const { go, mail, reading } = start(route);
    const commits = (feed: string) => mail.mutations.flatMap((mutation) =>
      mutation.kind === "feed_mark_seen" && mutation.upToId && mutation.view === feed ? [mutation] : [],
    );
    const first = track(reading(name));
    first.wheel(800);
    expect(first.scroller.scrollTop).toBe(800);
    go(other);
    const firstCommit = commits(route);
    expect(firstCommit).toHaveLength(1);
    expect(firstCommit[0]!.upToId).toBe(`${route}-0`);
    expect(firstCommit[0]!.messageIds!.every((id) => first.displayed.has(id))).toBe(true);

    const otherView = name === "News" ? "receipts" : "reads";
    track(reading(other)).wheel(400);
    go(name);
    const idle = track(reading(name));
    expect(idle.scroller.scrollTop).toBe(0);
    frame(2500);
    go(other);
    expect(commits(route)).toEqual(firstCommit);
    const otherCommits = commits(otherView);
    expect(otherCommits).toHaveLength(1);

    act(() => {
      for (let i = 0; i < 10; i++) mail.patch(`${route}-${i}`, { unread: i === 1 });
      mail.add(letter("just-in", 21));
    });
    go(name);
    const second = track(reading(name));
    expect(second.scroller.scrollTop).toBe(0);
    second.wheel(800);
    act(() => void window.dispatchEvent(new Event("pagehide")));
    expect(commits(otherView)).toEqual(otherCommits);
    const secondCommit = commits(route);
    expect(secondCommit).toHaveLength(2);
    expect(secondCommit[1]!.upToId).toBe("just-in");
    expect(second.displayed.has(secondCommit[1]!.upToId!)).toBe(true);
    expect(secondCommit[1]!.messageIds).toContain("just-in");
    expect(secondCommit[1]!.messageIds!.every((id) => second.displayed.has(id))).toBe(true);
    act(() => void window.dispatchEvent(new Event("pagehide")));
    expect(commits(route)).toEqual(secondCommit);

    go("Ohbox");
    go(name);
    expect(track(reading(name)).scroller.scrollTop).toBe(800);
  });

it.each(places)("%s starts keyboard steps from the new top and then honors a linked return",
  (name, route, letter, other, subject) => {
    const { track, frame } = geometry();
    const { address, go, mail, reading } = start(route);
    const press = () => {
      fireEvent.keyDown(document.body, { key: "j" });
      frame();
    };
    track(reading(name));
    for (let i = 0; i < 3; i++) press();
    expect(screen.getByRole("option", { name: new RegExp(`${subject} 17`), selected: true })).toBeTruthy();
    go(other);
    act(() => mail.add(letter("just-in", 21, { subject: "New while away" })));
    go(name);
    track(reading(name));
    expect(screen.getByRole("option", { name: /New while away/, selected: true })).toBeTruthy();
    press();
    expect(screen.getByRole("option", { name: new RegExp(`${subject} 20`), selected: true })).toBeTruthy();
    go(other);
    act(() => address.visit(`#/${route}/m/${route}-6`));
    track(reading(name));
    frame();
    expect(screen.getByRole("option", { name: new RegExp(`${subject} 14`), selected: true })).toBeTruthy();
  });

for (const [name, route, letter, other, subject] of places) {
  it.each(["an arrival", "an unread change"] as const)(`${name} list reopens at the top and never marks rows after %s`, (change) => {
    const { go, mail, reading } = start(route);
    const list = () => screen.getByRole("region", { name }).querySelector<HTMLElement>(".pl-scroll")!;
    const wheel = (at: number) => {
      const scroller = list();
      fireEvent.wheel(scroller, { deltaY: at - scroller.scrollTop });
      scroller.scrollTop = at;
      fireEvent.scroll(scroller);
      expect(scroller.scrollTop).toBe(at);
    };
    wheel(800);
    expect(mail.mutations).toEqual([]);
    go(other);
    act(() => {
      if (change === "an arrival") mail.add(letter("just-in", 21, { subject: "New while away" }));
      else {
        mail.patch(`${route}-5`, { unread: false });
        mail.patch(`${route}-5`, { unread: true });
      }
    });
    go(name);
    expect(list().scrollTop).toBe(0);
    expect(within(reading(name)).getByRole("heading", {
      name: change === "an arrival" ? "New while away" : `${subject} 20`,
    })).toBeTruthy();
    wheel(40);
    expect(mail.mutations).toEqual([]);
  });
}
