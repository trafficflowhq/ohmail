/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ScreenerSenderDTO } from "@ohmail/wire";
import type { LetterProps, ReaderFiles } from "../../src/reader/index.js";
import { BESIDE, modelOf, mountPlace, screenerEngine, sender } from "./screener-world.js";

const bag = sender("held", "Held correspondence", {
  held: Array.from({ length: 12 }, (_, i) => ({
    id: `held-${i + 1}`,
    subject: `Letter ${i + 1}`,
    time: "09:00",
    snippet: `Preview ${i + 1}`,
  })),
}) as ScreenerSenderDTO;

const reading = () => within(screen.getByRole("region", { name: "Reading" }));

function files(hold: (id: string) => void): ReaderFiles {
  return {
    hold: (id) => {
      hold(id);
      return () => {};
    },
    itemsOf: () => ({ state: "unavailable" }),
    open: () => {},
    ensure: () => {},
    downloadAll: () => {},
    downloadingAll: () => false,
    cidImagesOf: () => new Map(),
    needCidImages: () => {},
  };
}

beforeEach(() => {
  localStorage.clear();
  Element.prototype.animate ??= () => ({ cancel() {}, finished: Promise.resolve() }) as unknown as Animation;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each(["screened", "spam"] as const)(
  "opens only the newest three %s letters and asks only for them",
  (segment) => {
    const { engine, asked } = screenerEngine();
    const loads = vi.fn();
    const hold = vi.fn();
    function Body({ messageId }: LetterProps) {
      loads(messageId);
      return <p>Body preview</p>;
    }
    const queues =
      segment === "screened" ? { screenedOut: [bag] } : { spam: [{ sender: bag, pinned: false }] };
    mountPlace(modelOf({ flushes: 0 }, queues), {
      at: `#/screener/${segment}`,
      engine,
      beside: { ...BESIDE, letters: { body: Body, files: files(hold), pictures: "none", look: "none" } },
    });
    const feed = reading().getByRole("feed", { name: "Held correspondence" });
    expect(
      within(feed)
        .getAllByRole("heading")
        .map((node) => node.textContent),
    ).toEqual(["Letter 10", "Letter 11", "Letter 12"]);
    expect(
      within(feed)
        .getAllByRole("article")
        .map((node) => node.getAttribute("aria-posinset")),
    ).toEqual(["10", "11", "12"]);
    expect(
      within(feed)
        .getAllByRole("article")
        .every((node) => node.getAttribute("aria-setsize") === "12"),
    ).toBe(true);
    expect(asked.bodies).toEqual(["held-10,held-11,held-12 urgent"]);
    expect([...new Set(loads.mock.calls.map(([id]) => id))]).toEqual(["held-10", "held-11", "held-12"]);
    expect(hold.mock.calls.map(([id]) => id)).toEqual(["held-10", "held-11", "held-12"]);
    expect(reading().getByText("12 letters")).toBeTruthy();
  },
);

function modelColumn({
  letterHeight,
  height,
  clamp,
}: {
  letterHeight: number;
  height: number;
  clamp?: boolean;
}) {
  const offsets = new WeakMap<Element, number>();
  const scroller = (el: Element) => el.querySelector(":scope > div > [role=feed]") !== null;
  vi.spyOn(Element.prototype, "clientHeight", "get").mockImplementation(function (this: Element) {
    return scroller(this) ? height : 0;
  });
  vi.spyOn(Element.prototype, "scrollTop", "get").mockImplementation(function (this: Element) {
    return offsets.get(this) ?? 0;
  });
  vi.spyOn(Element.prototype, "scrollTop", "set").mockImplementation(function (this: Element, top: number) {
    const count = this.querySelectorAll("[role=feed] article").length;
    offsets.set(this, clamp ? Math.min(top, Math.max(0, count * letterHeight - height)) : top);
  });
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    const parent = this.parentElement;
    const index = parent?.getAttribute("role") === "feed" ? [...parent.children].indexOf(this) : -1;
    const column = index >= 0 ? parent?.parentElement?.parentElement : null;
    const top = column ? letterHeight * index - (offsets.get(column) ?? 0) : 0;
    return new DOMRect(0, top, 500, column ? letterHeight : height);
  });
  const frames = new Map<number, FrameRequestCallback>();
  let frame = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++frame, callback);
    return frame;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  return async function paint() {
    const callbacks = [...frames.values()];
    frames.clear();
    await act(async () => {
      callbacks.forEach((callback) => callback(performance.now()));
    });
  };
}

it("adds older letters three at a time when scrolling up", async () => {
  const paint = modelColumn({ letterHeight: 600, height: 500 });
  const { engine, asked } = screenerEngine();
  mountPlace(modelOf({ flushes: 0 }, { screenedOut: [bag] }), { at: "#/screener/screened", engine });
  const feed = reading().getByRole("feed");
  const column = feed.parentElement!.parentElement!;
  await paint();
  expect(within(feed).getAllByRole("article")).toHaveLength(3);
  for (const count of [6, 9, 12]) {
    column.scrollTop = 0;
    fireEvent.scroll(column);
    await paint();
    expect(within(feed).getAllByRole("article")).toHaveLength(count);
    expect(within(feed).getAllByRole("article")[0]!.getAttribute("aria-posinset")).toBe(String(13 - count));
    expect(column.scrollTop).toBe(1800);
  }
  expect(asked.bodies).toHaveLength(4);
  expect(asked.bodies.map((batch) => batch.split(",")[0])).toEqual(["held-10", "held-7", "held-4", "held-1"]);
});

function phone(letterHeight: number) {
  const paint = modelColumn({ letterHeight, height: 800, clamp: true });
  const { engine } = screenerEngine();
  mountPlace(modelOf({ flushes: 0 }, { screenedOut: [bag] }), {
    at: "#/screener/screened",
    room: "phone",
    engine,
  });
  const open = () => fireEvent.click(screen.getByRole("option", { name: /^Held correspondence/ }));
  const feed = () => screen.getByRole("feed", { name: "Held correspondence" });
  const articles = () => within(feed()).getAllByRole("article");
  const close = () =>
    fireEvent.click(
      within(screen.getByRole("region", { name: "Held correspondence" })).getByRole("button", {
        name: "Screener",
      }),
    );
  return { paint, open, feed, articles, close };
}

it("adds earlier letters on a phone when the opening three fit without scrolling", async () => {
  const sheet = phone(150);
  sheet.open();
  await sheet.paint();
  expect(sheet.articles().length).toBeGreaterThan(3);
  const column = sheet.feed().parentElement!.parentElement!;
  for (let step = 0; step < 3 && sheet.articles().length < 12; step++) {
    column.scrollTop = 0;
    fireEvent.scroll(column);
    await sheet.paint();
  }
  expect(sheet.articles()).toHaveLength(12);
});

it("keeps the previously revealed letters when reopening a sender on a phone", async () => {
  const sheet = phone(600);
  sheet.open();
  await sheet.paint();
  const column = sheet.feed().parentElement!.parentElement!;
  column.scrollTop = 700;
  fireEvent.scroll(column);
  await sheet.paint();
  const first = sheet.articles()[0]!.getAttribute("aria-posinset");
  expect(first).toBe("7");
  sheet.close();
  expect(screen.queryByRole("feed")).toBeNull();
  sheet.open();
  const atTop = () => sheet.articles().find((article) => article.getBoundingClientRect().top === 0);
  expect(atTop()?.getAttribute("aria-posinset")).toBe(first);
  await sheet.paint();
  expect(atTop()?.getAttribute("aria-posinset")).toBe(first);
});

it("draws the settled body and reports each result of Retry", () => {
  const { engine, asked, land } = screenerEngine();
  const waiting = sender("correspondent", "Waiting correspondent");
  mountPlace(modelOf({ flushes: 0 }, { waiting: [waiting], waitingCount: 1 }), { engine });
  const id = "correspondent-1";
  act(() => land(id, { state: "ready", text: "Full text of the held letter" }));
  expect(reading().getByText("Full text of the held letter")).toBeTruthy();
  expect(reading().queryByRole("button", { name: "Retry" })).toBeNull();

  act(() => land(id, { state: "failed" }));
  fireEvent.click(reading().getByRole("button", { name: "Retry" }));
  expect(asked.bodies).toEqual([`${id} urgent`, `${id} retry`]);
  act(() => land(id, { state: "loading" }));
  expect(within(reading().getByRole("article")).getByRole("status")).toBeTruthy();
  expect(reading().queryByRole("button", { name: "Retry" })).toBeNull();

  act(() => land(id, { state: "failed" }));
  fireEvent.click(reading().getByRole("button", { name: "Retry" }));
  expect(asked.bodies).toEqual([`${id} urgent`, `${id} retry`, `${id} retry`]);
  act(() => land(id, { state: "ready", text: "Full text after the second try" }));
  expect(reading().getByText("Full text after the second try")).toBeTruthy();
  expect(reading().queryByRole("button", { name: "Retry" })).toBeNull();
});

it.each(["Screened out", "Spam"])(
  "draws %s rows and heads before opening bodies and files",
  async (section) => {
    const originalRects = Element.prototype.getClientRects;
    vi.spyOn(Element.prototype, "getClientRects").mockImplementation(function (this: Element) {
      return this.hasAttribute("data-reading-scroll")
        ? ([new DOMRect(0, 0, 500, 600)] as unknown as DOMRectList)
        : originalRects.call(this);
    });
    let frame = 0;
    const queued = new Map<number, FrameRequestCallback>();
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      queued.set(++frame, callback);
      return frame;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => queued.delete(id));
    const renderBody = vi.fn();
    const hold = vi.fn();
    const { engine } = screenerEngine();
    const queues = section === "Spam" ? { spam: [{ sender: bag, pinned: false }] } : { screenedOut: [bag] };
    mountPlace(modelOf({ flushes: 0 }, queues), {
      engine,
      beside: {
        ...BESIDE,
        letters: {
          body: ({ messageId }) => {
            renderBody(messageId);
            return <p>Drawn body</p>;
          },
          files: files(hold),
          pictures: "none",
          look: "none",
        },
      },
    });
    const button = screen.getByRole("button", { name: new RegExp(`^${section}`) });
    fireEvent.click(button);
    expect(screen.getByRole("option", { name: /^Held correspondence/ })).toBeTruthy();
    const feed = reading().getByRole("feed");
    expect(within(feed).getAllByRole("heading")).toHaveLength(3);
    expect(renderBody).not.toHaveBeenCalled();
    expect(hold).not.toHaveBeenCalled();
    await act(async () => {
      const callbacks = [...queued.values()];
      queued.clear();
      callbacks.forEach((callback) => callback(performance.now()));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(within(feed).getAllByText("Drawn body")).toHaveLength(3);
    expect(hold.mock.calls.map(([id]) => id)).toEqual(["held-10", "held-11", "held-12"]);
    expect(within(feed).getAllByRole("article")).toHaveLength(3);
  },
);

it.each(["screened", "spam"] as const)(
  "releases all twelve %s letters from the three-letter view",
  (segment) => {
    const moved = vi.fn();
    const model =
      segment === "screened"
        ? { screenedOut: [bag], allowScreened: (selected: ScreenerSenderDTO) => moved(selected.held) }
        : {
            spam: [{ sender: bag, pinned: false }],
            notSpamToOhbox: (selected: { sender: ScreenerSenderDTO }) => moved(selected.sender.held),
          };
    mountPlace(modelOf({ flushes: 0 }, model), { at: `#/screener/${segment}` });
    expect(within(reading().getByRole("feed")).getAllByRole("article")).toHaveLength(3);
    fireEvent.click(reading().getByRole("button", { name: "Ohbox" }));
    expect(moved.mock.calls).toEqual([[bag.held]]);
  },
);
