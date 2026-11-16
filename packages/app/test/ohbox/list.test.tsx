/** @vitest-environment jsdom */
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ResurfacedThreadRow } from "@ohmail/client-engine";
import { at, beside, msg, ohbox, type Said } from "./ohbox-world.js";

const said0 = (): Said => ({ marked: [], bulk: [], went: [], pulled: 0, markedAll: [] });
import { wideWindow } from "./setup.js";

beforeEach(wideWindow);
afterEach(cleanup);

const pinned = (): ResurfacedThreadRow => {
  const p = {
    ...msg({ id: "p1", from: "Petra Wyss", subject: "Your talk", date: at(7) }),
    triage: { state: "resurfaced" },
  } as never;
  return {
    key: "msg:p1",
    threadId: null,
    members: [p],
    pinned: [p],
    openTarget: p,
    count: 1,
    countFromThread: false,
    resurfacedAt: null,
    newSince: [],
    badge: false,
    pulledForward: false,
  };
};

describe("the Ohbox's list", () => {
  it("is named once, Ohbox, and draws its three groups in order", () => {
    ohbox({
      resurfacedRows: [pinned()],
      newForYou: [msg({ id: "a", from: "Ada Lund", subject: "Kiln", date: at(10) })],
      previouslySeen: [msg({ id: "r", from: "Bo Ek", subject: "Glaze", unread: false, date: at(6) })],
    });
    expect(screen.getAllByRole("heading", { level: 1 }).map((h) => h.textContent)).toEqual(["Ohbox"]);
    expect(screen.getAllByRole("listbox").map((b) => b.getAttribute("aria-label"))).toEqual([
      "Resurfaced",
      "New",
      "Earlier",
    ]);
  });

  it("draws no heading over nothing", () => {
    ohbox({ newForYou: [msg({ id: "a" })] });
    expect(screen.getAllByRole("listbox").map((b) => b.getAttribute("aria-label"))).toEqual(["New"]);
    expect(screen.queryByText("Earlier")).toBeNull();
    expect(screen.queryByText("Resurfaced")).toBeNull();
  });

  it("names each row as the letter, and says unread after the name", () => {
    ohbox({
      newForYou: [msg({ id: "a", from: "Ada Lund", subject: "Kiln is fixed", date: at(10) })],
      previouslySeen: [msg({ id: "r", from: "Bo Ek", subject: "Glaze", unread: false, date: at(6) })],
    });
    const fresh = within(screen.getByRole("listbox", { name: "New" })).getByRole("option", {
      name: "Ada Lund: Kiln is fixed",
    });
    expect(fresh.getAttribute("aria-description")).toContain("Unread");
    const read = within(screen.getByRole("listbox", { name: "Earlier" })).getByRole("option", {
      name: "Bo Ek: Glaze",
    });
    expect(read.getAttribute("aria-description")).toContain("Read");
    expect(read.getAttribute("aria-description")).not.toContain("Unread");
  });

  it("says when a letter arrived, written out, before whether it is read", () => {
    ohbox(
      { newForYou: [msg({ id: "a", from: "Ada Lund", subject: "Kiln", date: at(10) })] },
      {
        side: {
          words: {
            ...beside(said0()).words,
            stamp: () => ({ when: "Sat", spoken: "Saturday 14 November 2026, 10:00" }),
          },
        },
      },
    );
    expect(screen.getByRole("option", { name: "Ada Lund: Kiln" }).getAttribute("aria-description")).toBe(
      "Saturday 14 November 2026, 10:00 · Unread",
    );
  });

  it("keeps one tab stop in the list, on the open row", () => {
    ohbox({
      newForYou: [
        msg({ id: "a", date: at(10) }),
        msg({ id: "b", date: at(9) }),
        msg({ id: "c", date: at(8) }),
      ],
      selectedId: "b",
    });
    const stops = screen.getAllByRole("option").filter((r) => r.getAttribute("tabindex") === "0");
    expect(stops.map((r) => r.dataset.id)).toEqual(["b"]);
  });

  it("lists New and Earlier as many-selectable, each row its place in its group", () => {
    ohbox({ newForYou: [msg({ id: "a", date: at(10) }), msg({ id: "b", date: at(9) })] });
    const box = screen.getByRole("listbox", { name: "New" });
    expect(box.getAttribute("aria-multiselectable")).toBe("true");
    const second = within(box).getAllByRole("option")[1]!;
    expect([second.getAttribute("aria-posinset"), second.getAttribute("aria-setsize")]).toEqual(["2", "2"]);
  });

  it("turns every time to its other form from a press on a row's time, and opens nothing", () => {
    let flipped = 0;
    const stamp = () => ({ when: "09:00", title: "Sunday 2 August 2026, 09:00" });
    const world = ohbox(
      { newForYou: [msg({ id: "a" }), msg({ id: "b" })] },
      { side: { flipTime: () => (flipped += 1), words: { ...beside(said0()).words, stamp } } },
    );
    const time = within(screen.getByRole("option", { name: /^a:/ })).getByText("09:00");
    expect(time.getAttribute("title")).toBe("Sunday 2 August 2026, 09:00");
    fireEvent.click(time);
    expect(flipped).toBe(1);
    expect(screen.getByRole("option", { name: /^a:/ }).getAttribute("aria-selected")).toBe("false");
    expect(world.said.marked).toEqual([]);
  });

  it("marks the row a search took the person to while the shell names it, and only that row", () => {
    const world = ohbox(
      { newForYou: [msg({ id: "a" }), msg({ id: "b1", threadId: "t" }), msg({ id: "b2", threadId: "t" })] },
      { side: { located: "b2" } },
    );
    const marked = () => screen.getAllByRole("option").filter((o) => o.hasAttribute("data-located"));
    expect(
      marked().map((o) => o.getAttribute("data-id")),
      "the conversation's one row, led by b1",
    ).toEqual(["b1"]);
    world.again({}, { located: null });
    expect(marked()).toEqual([]);
  });

  it("speaks German where the person reads German", () => {
    ohbox({ newForYou: [msg({ id: "a", from: "Ada Lund", subject: "Ofen" })] }, { lang: "de" });
    expect(screen.getByRole("listbox", { name: "Neu" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "Ada Lund: Ofen" }).getAttribute("aria-description")).toContain(
      "Ungelesen",
    );
  });
});

describe("a row's people cost a conversation each, once", () => {
  const twenty = () =>
    Array.from({ length: 20 }, (_, i) => msg({ id: `c${i}`, threadId: `t${i}`, date: at(9, i) }));
  /* Each conversation: its letter and a reply from somebody else, so every row names two people. */
  const counted = (letters: ReturnType<typeof twenty>) => {
    const asked = { n: 0 };
    const conversationOf = (id: string) => {
      asked.n += 1;
      const m = letters.find((x) => x.id === id)!;
      return [m, msg({ id: `${id}-re`, threadId: m.threadId ?? undefined, from: "Ben Arnold", date: at(8) })];
    };
    return { asked, conversationOf };
  };

  it("twenty rows draw with no more conversation reads than conversations shown, and the clock alone asks none", () => {
    const letters = twenty();
    const { asked, conversationOf } = counted(letters);
    const world = ohbox({ newForYou: letters, conversationOf });
    expect(screen.getAllByRole("option")).toHaveLength(20);
    expect(asked.n, "one read a conversation shown").toBeLessThanOrEqual(20);
    const drawn = asked.n;
    world.again({ now: new Date(at(12, 1)) });
    expect(asked.n - drawn, "a redraw that only moves the clock").toBe(0);
  });

  it("the people's names are joined by one list format a language, not one a row", () => {
    const Real = Intl.ListFormat;
    let made = 0;
    class Counted extends Real {
      constructor(...args: ConstructorParameters<typeof Real>) {
        super(...args);
        made += 1;
      }
    }
    const intl = Intl as { ListFormat: typeof Intl.ListFormat };
    intl.ListFormat = Counted;
    try {
      const letters = twenty();
      const world = ohbox({ newForYou: letters, conversationOf: counted(letters).conversationOf });
      world.again({ now: new Date(at(12, 1)) });
      expect(made).toBeLessThanOrEqual(1);
    } finally {
      intl.ListFormat = Real;
    }
  });
});
