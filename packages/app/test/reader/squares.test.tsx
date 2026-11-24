/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createThreadWalkChannel, type ListMeeting } from "@ohmail/app-logic/reading";
import { scrollProgrammatically } from "@ohmail/app-logic/session/programmatic-scroll";
import { READER_DOM, scrollerOf } from "../../src/reader/read-dom.js";
import { freshRecord, letter, mountReader } from "./support/mail.js";

/**
 * THE SQUARES' WALK in the column: one square a letter beside the sheets; a conversation opens at the latest letter
 * and stays there while bodies land, until the person's first gesture; a press puts that letter's top on the reading
 * line and holds it until a hand scroll; a wheel beside the sheets scrolls them as the person's own scroll. jsdom lays
 * nothing out: the scroller is 800 tall, each letter's top read live from `tops` against the scroll.
 */

const thread = { threadId: "t1" };
const LETTERS = ["a", "b", "c"].map((id, i) =>
  letter(id, { ...thread, date: new Date(Date.UTC(2026, 10, 10 + i, 9)).toISOString() }),
);
const unreadFrom = (first: string) => LETTERS.map((m) => ({ ...m, unread: m.id >= first }));

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

function layOut(letters = LETTERS): HTMLElement {
  const scroller = scrollerOf(document.querySelector(READER_DOM.stopsRoot!))!;
  Object.defineProperty(scroller, "clientHeight", { value: 800, configurable: true });
  Object.defineProperty(scroller, "scrollHeight", { get: () => geo.height, configurable: true });
  scroller.getBoundingClientRect = () => rect(0, 800);
  letters.forEach((m, i) => {
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
const squaresOf = (name: string | RegExp = "3 messages, 3 unread") =>
  screen.getByRole("group", { name }).querySelectorAll<HTMLElement>("[data-square]");
/** The square the ring stands in (the kit draws it inside that square). */
const ringAt = (): number =>
  [...squaresOf(/^3 messages,/)].findIndex((sq) => sq.querySelector(".oh-readsquares-ring") !== null);

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

  it("keeps the sent square named as sent when it is current and distinguishes read and unread messages", () => {
    const letters = [
      { ...LETTERS[0]!, unread: false },
      { ...LETTERS[1]!, folder: "Sent", unread: true },
      LETTERS[2]!,
    ];
    mountReader({ letters, open: "a" });
    layOut(letters);
    const group = screen.getByRole("group", { name: "3 messages, 1 unread" });
    const sent = screen.getByRole("button", { name: "Message 2 of 3, sent by you" });
    expect(screen.getByRole("button", { name: /^Message 1 of 3 .*?, read$/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Message 3 of 3 .*?, unread$/ })).toBeTruthy();

    fireEvent.click(sent);
    expect(screen.getByRole("button", { name: "Message 2 of 3, sent by you", current: true })).toBe(sent);
    expect(group.getAttribute("aria-label")).toBe("3 messages, 1 unread");
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

  it("the ring stands on the latest letter even when earlier ones are unread", () => {
    mountReader({ letters: unreadFrom("b"), open: "c", wholeThread: true });
    layOut();
    expect(ringAt()).toBe(2);
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
    fireEvent.click(squaresOf()[0]!);
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
        letter(`l${i}`, {
          ...thread,
          date: new Date(Date.UTC(2026, 10, 1, 8, i)).toISOString(),
          unread: i === 39,
        }),
      );
      mountReader({ letters: forty, open: "l39" });
      const scroller = scrollerOf(document.querySelector(READER_DOM.stopsRoot!))!;
      Object.defineProperty(scroller, "clientHeight", { value: 400, configurable: true });
      grow();
      const group = screen.getByRole("group", { name: "40 messages, 1 unread" });
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
  it("a conversation opens on its final message even if that is not the first unread, and it stays read-free", () => {
    const { mail } = mountReader({ letters: unreadFrom("b"), open: "a" });
    const scroller = layOut();
    expect(scroller.scrollTop).toBeGreaterThan(1000);
    expect(topOf("c")).toBeGreaterThanOrEqual(0);
    expect(topOf("c")).toBeLessThan(400);
    // Anchoring is the app's own scroll: it enters no visit and reads nothing by itself.
    expect(mail.mutations).toEqual([]);
  });

  it("opens as today's reader opens: the opened letter's top 14 px under the head that stays over the column", () => {
    mountReader({ letters: unreadFrom("c"), open: "c" });
    const head = screen.getByRole("heading", { level: 2 }).closest("header")!;
    head.style.position = "sticky";
    head.getBoundingClientRect = () => rect(0, 100);
    layOut();
    expect(topOf("c")).toBe(114);
    // Where nothing stays over it, 14 px under the column's top.
    cleanup();
    mountReader({ letters: unreadFrom("b"), open: "b" });
    layOut();
    expect(topOf("c")).toBe(14);
  });

  it("a sibling growing above keeps the opened letter where it stood", () => {
    mountReader({ letters: unreadFrom("c"), open: "c" });
    layOut();
    const before = topOf("c");
    geo.tops = [0, 1500, 2400];
    geo.height = 3600;
    grow();
    expect(topOf("c")).toBe(before);
  });

  it("a hand scroll lets it go: a body landing after it moves nothing", () => {
    mountReader({ letters: unreadFrom("c"), open: "c" });
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
      geo.height = 2200;
      const letters = unreadFrom("c").map((m) => (m.id === "c" ? { ...m, body: undefined } : m));
      mountReader({ letters, open: "c" });
      const scroller = layOut();
      const held = scroller.scrollTop;
      const visibleTop = topOf("c");
      expect(held).toBe(1400);
      act(() => {
        if (gesture === "ceiling") vi.advanceTimersByTime(6000);
        else window.dispatchEvent(new Event(gesture));
      });
      // Growth below the opened top would let the opening pull it up to the reading line.
      geo.height = 3000;
      grow();
      expect(scroller.scrollTop).toBe(held);
      // Growth above the same letter should move scrollTop by the same amount as the letter.
      geo.tops = [0, 1500, 2400];
      geo.height = 3600;
      grow();
      expect(scroller.scrollTop).toBe(held + 600);
      expect(topOf("c")).toBe(visibleTop);
      cleanup();
    }
  });

  it("a square's press wins over the anchor", () => {
    mountReader({ letters: unreadFrom("c"), open: "c" });
    const scroller = layOut();
    fireEvent.click(squaresOf("3 messages, 1 unread")[0]!);
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
    fireEvent.click(squaresOf()[0]!);
    expect(way()).toBeTruthy();
    fireEvent.click(way()!);
    grow();
    expect(topOf("c")).toBeGreaterThanOrEqual(0);
    expect(topOf("c")).toBeLessThan(400);
    expect(ringAt()).toBe(2);
    expect(way()).toBeNull();
  });

  it("does not stand where the column is at the end, nor for a single letter", () => {
    mountReader({ letters: unreadFrom("c"), open: "c" });
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
    expect(channel.get()).toMatchObject({ here: "c", openedId: "a" });
    act(() => {
      expect(channel.press("b")).toBe(true);
    });
    grow();
    expect(topOf("b")).toBeGreaterThanOrEqual(0);
    expect(topOf("b")).toBeLessThan(400);
    expect(channel.get()).toMatchObject({ here: "b" });
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

function mountThread(count: number, unread: readonly number[]) {
  const letters = Array.from({ length: count }, (_, i) =>
    letter(`message-${i + 1}`, {
      ...thread,
      date: new Date(Date.UTC(2026, 10, 1, 8, i)).toISOString(),
      unread: unread.includes(i + 1),
    }),
  );
  geo.tops = letters.map((_, i) => i * 900);
  geo.height = count * 900;
  const { mail } = mountReader({ letters, open: letters.at(-1)!.id, wholeThread: true });
  return { mail, scroller: layOut(letters) };
}

describe("the read state in the squares", () => {
  function square(position: number, count: number, state?: "read" | "unread") {
    const suffix = state ? `.*, ${state}$` : "";
    return screen.getByRole("button", { name: new RegExp(`^Message ${position} of ${count} ${suffix}`) });
  }

  it("shows four read and two unread squares and keeps each status in sync with the mirror", () => {
    const { mail } = mountThread(6, [3, 4]);
    expect(screen.getByRole("group", { name: "6 messages, 2 unread" })).toBeTruthy();
    for (const i of [1, 2, 5, 6]) expect(square(i, 6, "read")).toBeTruthy();
    for (const i of [3, 4]) expect(square(i, 6, "unread")).toBeTruthy();
    expect(mail.mutations).toEqual([]);

    fireEvent.click(square(3, 6));
    expect(screen.getByRole("button", { name: /^Message 3 of 6 /, current: true })).toBeTruthy();
    expect(topOf("message-3")).toBeGreaterThanOrEqual(0);
    expect(topOf("message-3")).toBeLessThan(400);
    act(() => mail.patch("message-3", { unread: false }));
    expect(screen.getByRole("group", { name: "6 messages, 1 unread" })).toBeTruthy();
    expect(square(3, 6, "read")).toBeTruthy();
    act(() => mail.patch("message-3", { unread: true }));
    expect(screen.getByRole("group", { name: "6 messages, 2 unread" })).toBeTruthy();
    expect(square(3, 6, "unread")).toBeTruthy();
  });

  it("lets the keyboard reach either end of a 60-message thread through the squares", () => {
    const root = document.documentElement.style;
    const tokens = { "--sq-y": "10px", "--sq-y-gap": "8px", "--sq-more-y": "16px" };
    for (const [name, value] of Object.entries(tokens)) root.setProperty(name, value);
    try {
      const { scroller } = mountThread(60, [29, 30]);
      fireEvent.click(square(59, 60));
      expect(square(59, 60).getAttribute("aria-current")).toBe("true");
      fireEvent.keyDown(square(59, 60), { key: "End" });
      expect(document.activeElement).toBe(square(60, 60));
      fireEvent.keyDown(square(60, 60), { key: "Enter" });
      expect(square(60, 60).getAttribute("aria-current")).toBe("true");
      fireEvent.keyDown(square(60, 60), { key: "Home" });
      expect(document.activeElement).toBe(square(1, 60));
      fireEvent.keyDown(square(1, 60), { key: "Enter" });
      expect(scroller.scrollTop).toBe(0);
      expect(square(1, 60).getAttribute("aria-current")).toBe("true");
    } finally {
      for (const name of Object.keys(tokens)) root.removeProperty(name);
    }
  });
});

describe("reading a thread from the squares", () => {
  it("starts at the latest message and updates an earlier square as it is read and marked unread", () => {
    const { mail } = mountThread(6, [3, 4]);
    const group = () => screen.getByRole("group", { name: /^6 messages/ });
    const square = (position: number) =>
      screen.getByRole("button", { name: new RegExp(`^Message ${position} of 6 `) });
    expect(group().getAttribute("aria-label")).toBe("6 messages, 2 unread");
    expect([1, 2, 3, 4, 5, 6].map((i) => square(i).getAttribute("aria-label")?.split(", ").at(-1))).toEqual([
      "read",
      "read",
      "unread",
      "unread",
      "read",
      "read",
    ]);
    expect(topOf("message-6")).toBe(14);
    expect(square(6).getAttribute("aria-current")).toBe("true");
    expect(mail.mutations).toEqual([]);

    act(() => mail.patch("message-3", { unread: false }));
    grow();
    expect(group().getAttribute("aria-label")).toBe("6 messages, 1 unread");
    expect(square(3).getAttribute("aria-label")).toMatch(/, read$/);
    expect(topOf("message-6")).toBe(14);
    act(() => mail.patch("message-3", { unread: true }));
    expect(group().getAttribute("aria-label")).toBe("6 messages, 2 unread");
    expect(square(3).getAttribute("aria-label")).toMatch(/, unread$/);
    fireEvent.click(square(4));
    expect(square(4).getAttribute("aria-current")).toBe("true");
    expect(topOf("message-4")).toBeGreaterThanOrEqual(0);
    expect(topOf("message-4")).toBeLessThan(400);
  });

  it("starts at the latest message of an all-read thread", () => {
    const { scroller, mail } = mountThread(6, []);
    expect(scroller.scrollTop).toBe(4486);
    expect(screen.getByRole("button", { name: /^Message 6 of 6 /, current: true })).toBeTruthy();
    expect(mail.mutations).toEqual([]);
  });

  it("starts at the latest message of 60 and can navigate to either end by square", () => {
    const root = document.documentElement.style;
    const tokens = { "--sq-y": "10px", "--sq-y-gap": "8px", "--sq-more-y": "16px" };
    for (const [name, value] of Object.entries(tokens)) root.setProperty(name, value);
    try {
      const { scroller, mail } = mountThread(60, [29, 30]);
      expect(topOf("message-60")).toBe(14);
      const square = (position: number) =>
        screen.getByRole("button", { name: new RegExp(`^Message ${position} of 60 `) });
      const current = square(60);
      expect(current.getAttribute("aria-current")).toBe("true");
      expect(screen.getByRole("group", { name: "60 messages, 2 unread" }).textContent).toMatch(/^\+\d+$/);
      expect(mail.mutations).toEqual([]);
      fireEvent.keyDown(current, { key: "Home" });
      fireEvent.keyDown(square(1), { key: "Enter" });
      expect(scroller.scrollTop).toBe(0);
      expect(square(1).getAttribute("aria-current")).toBe("true");
      fireEvent.keyDown(square(1), { key: "End" });
      fireEvent.keyDown(square(60), { key: "Enter" });
      expect(square(60).getAttribute("aria-current")).toBe("true");
    } finally {
      for (const name of Object.keys(tokens)) root.removeProperty(name);
    }
  });
});
