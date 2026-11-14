/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createThreadWalkChannel, type ListMeeting } from "@ohmail/app-logic/reading";
import { scrollProgrammatically } from "@ohmail/app-logic/session/programmatic-scroll";
import { READER_DOM, scrollerOf } from "../../src/reader/read-dom.js";
import { freshRecord, letter, mountReader } from "./support/mail.js";

/**
 * THE SQUARES' WALK in the column: one square a letter beside the sheets; a conversation opens AT the opened letter
 * and stays there while bodies land, until the person's first gesture; a press puts that letter's top on the reading
 * line and holds it until a hand scroll; a wheel beside the sheets scrolls them as the person's own scroll. jsdom lays
 * nothing out: the scroller is 800 tall, each letter's top read live from `tops` against the scroll.
 */

const thread = { threadId: "t1" };
const LETTERS = ["a", "b", "c"].map((id, i) =>
  letter(id, { ...thread, date: new Date(Date.UTC(2026, 10, 10 + i, 9)).toISOString() }),
);

/** The layout a browser would give; change it and call `grow()` as landing bodies would. */
const geo = { tops: [0, 900, 1800], height: 3000 };

function rect(top: number, height: number): DOMRect {
  return {
    top,
    bottom: top + height,
    left: 0,
    right: 600,
    width: 600,
    height,
    x: 0,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

function layOut(): HTMLElement {
  const scroller = scrollerOf(document.querySelector(READER_DOM.stopsRoot!))!;
  Object.defineProperty(scroller, "clientHeight", { value: 800, configurable: true });
  Object.defineProperty(scroller, "scrollHeight", { get: () => geo.height, configurable: true });
  scroller.getBoundingClientRect = () => rect(0, 800);
  LETTERS.forEach((m, i) => {
    const panel = document.querySelector<HTMLElement>(`[data-conv-id="${m.id}"]`)!;
    panel.getBoundingClientRect = () => rect(geo.tops[i]! - scroller.scrollTop, 800);
  });
  grow();
  return scroller;
}
/** A layout change: what the walk measures again a frame later. */
function grow(): void {
  act(() => {
    window.dispatchEvent(new Event("resize"));
    vi.advanceTimersByTime(50);
  });
}
const topOf = (id: string): number =>
  document.querySelector<HTMLElement>(`[data-conv-id="${id}"]`)!.getBoundingClientRect().top;
const squaresOf = (name = "3 messages, 3 unread") =>
  screen.getByRole("group", { name }).querySelectorAll<HTMLElement>("[data-square]");
/** The square the ring stands in (the kit draws it inside that square). */
const ringAt = (): number =>
  [...squaresOf()].findIndex((sq) => sq.querySelector(".oh-readsquares-ring") !== null);

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame"],
  });
  geo.tops = [0, 900, 1800];
  geo.height = 3000;
  localStorage.clear();
  Element.prototype.animate ??= () => ({ cancel() {} }) as unknown as Animation;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("the squares", () => {
  it("one square a letter, named by the conversation's count; none for a single letter", () => {
    mountReader({ letters: LETTERS, open: "c" });
    expect(screen.getByRole("group", { name: "3 messages, 3 unread" })).toBeTruthy();
    cleanup();
    mountReader({ letters: [letter("solo")], open: "solo" });
    expect(screen.queryByRole("group", { name: /messages/ })).toBeNull();
  });

  it("a press on a square brings that letter up to the reading line; the first, back to the top", () => {
    mountReader({ letters: LETTERS, open: "c" });
    const scroller = layOut();
    const squares = squaresOf();
    fireEvent.click(squares[1]!);
    const atSecond = scroller.scrollTop;
    expect(topOf("b")).toBeGreaterThanOrEqual(0);
    expect(topOf("b")).toBeLessThan(400);
    fireEvent.click(squares[2]!);
    expect(scroller.scrollTop).toBeGreaterThan(atSecond);
    fireEvent.click(squares[0]!);
    expect(scroller.scrollTop).toBe(0);
  });

  it("the ring stands on the opened letter once the column is laid out", () => {
    mountReader({ letters: LETTERS, open: "b" });
    layOut();
    expect(ringAt()).toBe(1);
  });

  it("after a press, the app's own scroll keeps the ring on that letter; a hand scroll gives it to the one on the line", () => {
    mountReader({ letters: LETTERS, open: "a" });
    const scroller = layOut();
    fireEvent.click(squaresOf()[1]!);
    grow();
    expect(ringAt()).toBe(1);
    act(() => {
      scrollProgrammatically(scroller, 0);
      // jsdom sends no scroll event of its own.
      scroller.dispatchEvent(new Event("scroll"));
    });
    grow();
    expect(ringAt()).toBe(1);
    act(() => {
      scroller.scrollTop = 2200;
      scroller.dispatchEvent(new Event("scroll"));
    });
    grow();
    expect(ringAt()).toBe(2);
  });

  it("a wheel beside the sheets scrolls them", () => {
    mountReader({ letters: LETTERS, open: "a" });
    const scroller = layOut();
    const beside = screen.getByRole("group", { name: "3 messages, 3 unread" });
    fireEvent.wheel(beside, { deltaY: 120, deltaMode: 0 });
    expect(scroller.scrollTop).toBe(120);
  });
});

describe("a long conversation's squares", () => {
  it("stand a run around the letter the reader is on, each hidden edge saying how many; a short one stands whole", () => {
    const root = document.documentElement.style;
    root.setProperty("--sq-y", "10px");
    root.setProperty("--sq-y-gap", "8px");
    root.setProperty("--sq-more-y", "16px");
    try {
      const forty = Array.from({ length: 40 }, (_, i) =>
        letter(`l${i}`, { ...thread, date: new Date(Date.UTC(2026, 10, 1, 8, i)).toISOString() }),
      );
      mountReader({ letters: forty, open: "l39" });
      const scroller = scrollerOf(document.querySelector(READER_DOM.stopsRoot!))!;
      Object.defineProperty(scroller, "clientHeight", { value: 400, configurable: true });
      grow();
      const group = screen.getByRole("group", { name: "40 messages, 40 unread" });
      expect(group.textContent).toMatch(/^\+\d+$/);
      expect(Number(group.textContent!.slice(1))).toBeGreaterThan(10);
      cleanup();
      mountReader({ letters: LETTERS, open: "c" });
      layOut();
      expect(squaresOf().length).toBe(3);
      expect(screen.getByRole("group", { name: "3 messages, 3 unread" }).textContent).toBe("");
    } finally {
      for (const name of ["--sq-y", "--sq-y-gap", "--sq-more-y"]) root.removeProperty(name);
    }
  });
});

describe("the open", () => {
  it("a conversation opens at the opened letter, not at its oldest, and it stays read-free", () => {
    const { mail } = mountReader({ letters: LETTERS, open: "c" });
    const scroller = layOut();
    expect(scroller.scrollTop).toBeGreaterThan(1000);
    expect(topOf("c")).toBeGreaterThanOrEqual(0);
    expect(topOf("c")).toBeLessThan(400);
    // Anchoring is the app's own scroll: it enters no visit and reads nothing by itself.
    expect(mail.mutations).toEqual([]);
  });

  it("opens as today's reader opens: the opened letter's top 14 px under the head that stays over the column", () => {
    mountReader({ letters: LETTERS, open: "c" });
    const head = screen.getByRole("heading", { level: 1 }).closest("header")!;
    head.style.position = "sticky";
    head.getBoundingClientRect = () => rect(0, 100);
    layOut();
    expect(topOf("c")).toBe(114);
    // Where nothing stays over it, 14 px under the column's top.
    cleanup();
    mountReader({ letters: LETTERS, open: "b" });
    layOut();
    expect(topOf("b")).toBe(14);
  });

  it("a sibling growing above keeps the opened letter where it stood", () => {
    mountReader({ letters: LETTERS, open: "c" });
    layOut();
    const before = topOf("c");
    geo.tops = [0, 1500, 2400];
    geo.height = 3600;
    grow();
    expect(topOf("c")).toBe(before);
  });

  it("a hand scroll lets it go: a body landing after it moves nothing", () => {
    mountReader({ letters: LETTERS, open: "c" });
    const scroller = layOut();
    act(() => {
      scroller.scrollTop = 200;
      scroller.dispatchEvent(new Event("scroll"));
    });
    geo.tops = [0, 1500, 2400];
    geo.height = 3600;
    grow();
    expect(scroller.scrollTop).toBe(200);
  });

  it("the person's first key or press lets it go, and so does the ceiling", () => {
    for (const gesture of ["keydown", "pointerdown", "ceiling"] as const) {
      geo.tops = [0, 900, 1800];
      geo.height = 3000;
      mountReader({ letters: LETTERS, open: "c" });
      const scroller = layOut();
      const held = scroller.scrollTop;
      act(() => {
        if (gesture === "ceiling") vi.advanceTimersByTime(6000);
        else window.dispatchEvent(new Event(gesture));
      });
      geo.tops = [0, 1500, 2400];
      geo.height = 3600;
      grow();
      expect(scroller.scrollTop).toBe(held);
      cleanup();
    }
  });

  it("a square's press wins over the anchor", () => {
    mountReader({ letters: LETTERS, open: "c" });
    const scroller = layOut();
    fireEvent.click(squaresOf()[0]!);
    geo.tops = [0, 1500, 2400];
    geo.height = 3600;
    grow();
    expect(scroller.scrollTop).toBe(0);
  });
});

describe("the way to the latest message", () => {
  const way = () => screen.queryByRole("button", { name: "Latest message" });

  it("stands while the column is far above the conversation's end; its press lands the last letter, and it leaves", () => {
    mountReader({ letters: LETTERS, open: "a" });
    layOut();
    expect(way()).toBeTruthy();
    fireEvent.click(way()!);
    grow();
    expect(topOf("c")).toBeGreaterThanOrEqual(0);
    expect(topOf("c")).toBeLessThan(400);
    expect(ringAt()).toBe(2);
    expect(way()).toBeNull();
  });

  it("does not stand where the column is at the end, nor for a single letter", () => {
    mountReader({ letters: LETTERS, open: "c" });
    layOut();
    expect(way()).toBeNull();
    cleanup();
    mountReader({ letters: [letter("solo")], open: "solo" });
    expect(screen.queryByRole("button", { name: "Latest message", hidden: true })).toBeNull();
  });
});

describe("the walk's channel", () => {
  function meetingWith(channel: ReturnType<typeof createThreadWalkChannel>): ListMeeting {
    return {
      blank: null,
      visit: {
        openId: "a",
        unread: true,
        readSet: ["a"],
        act: () => undefined,
        wiring: {
          look: "tint",
          record: freshRecord(),
          onRead: () => undefined,
          onEnter: () => undefined,
          onMarkUnread: () => undefined,
          walk: channel,
        },
        step: {
          up: { disabled: true, run: () => undefined, label: "up" },
          down: { disabled: true, run: () => undefined, label: "down" },
        },
      },
    };
  }

  it("the list row's press lands the letter as a square's does, and the row is told where the reader is", () => {
    const channel = createThreadWalkChannel();
    mountReader({ letters: LETTERS, open: "a", meeting: meetingWith(channel) });
    layOut();
    expect(channel.get()).toMatchObject({ here: "a", openedId: "a" });
    act(() => {
      expect(channel.press("c")).toBe(true);
    });
    grow();
    expect(topOf("c")).toBeGreaterThanOrEqual(0);
    expect(topOf("c")).toBeLessThan(400);
    expect(channel.get()).toMatchObject({ here: "c" });
  });

  it("a press made while no column stood lands once the column is laid out", () => {
    const channel = createThreadWalkChannel();
    channel.pending = "b";
    mountReader({ letters: LETTERS, open: "a", meeting: meetingWith(channel) });
    layOut();
    act(() => {
      vi.advanceTimersByTime(50);
    });
    expect(topOf("b")).toBeGreaterThanOrEqual(0);
    expect(topOf("b")).toBeLessThan(400);
    expect(channel.pending).toBeNull();
  });
});
