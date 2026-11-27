/** @vitest-environment jsdom */
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { firstNameOf } from "@ohmail/app-logic/ohbox/people";
import { at, msg, ohbox } from "./ohbox-world.js";
import { wideWindow } from "./setup.js";

beforeEach(wideWindow);
afterEach(cleanup);

describe("what a row says", () => {
  it("a conversation with several unread voices names them by first name, and its row by every whole name", () => {
    ohbox({
      newForYou: [
        msg({ id: "c2", threadId: "t", from: "Bo Ek", subject: "Kiln", date: at(11) }),
        msg({ id: "c1", threadId: "t", from: "Ada Lund", subject: "Kiln", date: at(10) }),
      ],
    });
    const row = screen.getByRole("option", { name: "Bo Ek, Ada Lund: Kiln" });
    expect(row.textContent).toContain("Bo, Ada");
    expect(row.textContent).not.toContain("@ex.example");
  });

  it("a conversation's circles are everybody in it, voices first and you in your place, a read one too", () => {
    const own = {
      ...msg({
        id: "o1",
        threadId: "m",
        from: "Mila Brunner",
        subject: "Menu",
        unread: false,
        date: at(8),
        folder: "Sent",
      }),
    };
    const anna = msg({
      id: "a2",
      threadId: "m",
      from: "Anna Odermatt",
      subject: "Menu",
      unread: false,
      date: at(9),
    });
    const ben = msg({ id: "b1", threadId: "g", from: "Ben Arnold", subject: "Glaze", date: at(11) });
    const giulia = msg({ id: "g1", threadId: "g", from: "Giulia Rossi", subject: "Glaze", date: at(10) });
    const ownGlaze = msg({
      id: "o2",
      threadId: "g",
      from: "Mila Brunner",
      subject: "Glaze",
      unread: false,
      date: at(7),
      folder: "Sent",
    });
    const reto = msg({
      id: "r3",
      threadId: "r",
      from: "Reto Frei",
      subject: "Ridge",
      unread: false,
      date: at(6),
    });
    const ownRidge = msg({
      id: "o3",
      threadId: "r",
      from: "Mila Brunner",
      subject: "Ridge",
      unread: false,
      date: at(5),
      folder: "Sent",
    });
    const lea = msg({
      id: "l3",
      threadId: "r",
      from: "Lea Brunner",
      subject: "Ridge",
      unread: false,
      date: at(4),
    });
    const conversations: Record<string, ReturnType<typeof msg>[]> = {
      r3: [lea, ownRidge, reto],
      a2: [own, anna],
      b1: [ownGlaze, giulia, ben],
      g1: [ownGlaze, giulia, ben],
    };
    ohbox({
      newForYou: [ben, giulia],
      previouslySeen: [anna, reto],
      conversationOf: (id) => conversations[id] ?? [],
      threadMarksOf: (t) => (t === "g" ? ["mine", "read", "unread"] : ["mine", "read"]),
    });
    expect(screen.getByRole("img", { name: "3 people: Ben Arnold, Giulia Rossi and you" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "2 people: Anna Odermatt and you" })).toBeTruthy();
    /* You stand where your newest letter falls among the others. */
    expect(screen.getByRole("img", { name: "3 people: Reto Frei, you and Lea Brunner" })).toBeTruthy();
    /* The lead and a count of everybody after it: "+2" for three people. */
    expect(
      screen.getByRole("img", { name: "3 people: Ben Arnold, Giulia Rossi and you" }).textContent,
    ).toContain("+2");
  });

  it("counts unread received mail separately from a sent reply", () => {
    const read = msg({ id: "read", threadId: "t", date: at(8), unread: false });
    const sent = msg({ id: "sent", threadId: "t", date: at(9), folder: "Sent", unread: true });
    const unread = msg({ id: "unread", threadId: "t", date: at(10) });

    ohbox({
      newForYou: [unread],
      selectedId: unread.id,
      initialSquare: sent.id,
      conversationOf: () => [read, sent, unread],
    });

    expect(screen.getByRole("group", { name: "3 messages, oldest first: 1 unread" })).toBeTruthy();
  });

  it("a letter alone on its row wears one circle, its sender's, and names no people", () => {
    ohbox({ newForYou: [msg({ id: "a", from: "Ada Lund", subject: "Kiln" })] });
    const row = screen.getByRole("option", { name: "Ada Lund: Kiln" });
    expect(within(row).getByText("A")).toBeTruthy();
    expect(within(row).queryByRole("img"), "a lone letter is named as a conversation's people").toBeNull();
  });

  it("one voice is named whole, with its address", () => {
    ohbox({ newForYou: [msg({ id: "a", from: "Ada Lund", subject: "Kiln" })] });
    const row = screen.getByRole("option", { name: "Ada Lund: Kiln" });
    expect(row.textContent).toContain("Ada Lund");
    expect(row.textContent).toContain("ada.lund@ex.example");
  });

  it("offers Done on every unread row, and Done reads it", () => {
    const world = ohbox({
      newForYou: [
        msg({ id: "a", subject: "One", date: at(10) }),
        msg({ id: "b", subject: "Two", date: at(9) }),
      ],
      previouslySeen: [msg({ id: "r", subject: "Read", unread: false, date: at(6) })],
    });
    /* A row's verbs stand beside its option, in its listbox: its Done is the one after it, before the next row. */
    const done = (name: RegExp) => {
      const option = screen.getByRole("option", { name });
      const box = option.closest<HTMLElement>("[role=listbox]")!;
      const after = (el: Element) =>
        (option.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
      const next = within(box).queryAllByRole("option").find(after);
      const before = (el: Element) =>
        !next || (el.compareDocumentPosition(next) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
      return (
        within(box)
          .queryAllByRole("button", { name: "Done" })
          .find((b) => after(b) && before(b)) ?? null
      );
    };
    expect(done(/One/)).not.toBeNull();
    expect(done(/Two/)).not.toBeNull();
    expect(done(/Read/)).toBeNull();
    fireEvent.click(done(/Two/)!);
    expect(world.said.marked).toEqual([{ ids: ["b"], unread: false }]);
  });

  it("names the file a row carries after its state", () => {
    ohbox({ newForYou: [msg({ id: "a", subject: "Plans", file: true })] });
    expect(screen.getByRole("option", { name: "a: Plans" }).getAttribute("aria-description")).toBe(
      "Unread · Has an attachment",
    );
  });

  it("a first name is the first word; a name with no space or written last-name first stays whole", () => {
    expect(firstNameOf("Ada Lund")).toBe("Ada");
    expect(firstNameOf("Cher")).toBe("Cher");
    expect(firstNameOf("Lund, Ada")).toBe("Lund, Ada");
    expect(firstNameOf("  Bo   Ek ")).toBe("Bo");
  });
});
