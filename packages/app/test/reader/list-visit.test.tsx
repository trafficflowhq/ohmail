/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ListMeeting, ListVisit } from "@ohmail/app-logic/reading";
import { freshRecord, letter, mountReader } from "./support/mail.js";

/**
 * WHERE A LIST AND THE READING COLUMN MEET: one object the list's model built. With a visit of the open letter, every
 * verb of the panel and the column's keys take the list's own path and the engine hears nothing from the reader;
 * without one, the reader's own runners go through the press seam. With nothing open, the column says what the list
 * says, its own word where no list stands, nothing where the list says nothing.
 */

function visitOf(openId: string, readSet: string[] = []): ListVisit {
  return {
    openId,
    unread: false,
    readSet,
    act: vi.fn(),
    wiring: { look: "tint", record: freshRecord(), onRead: vi.fn(), onEnter: vi.fn(), onMarkUnread: vi.fn() },
    step: {
      up: { disabled: false, run: vi.fn(), label: "Previous" },
      down: { disabled: false, run: vi.fn(), label: "Next" },
    },
  };
}
const panel = () => screen.getByRole("toolbar", { name: "Actions" });

beforeEach(() => {
  localStorage.clear();
  Element.prototype.animate ??= () => ({ cancel() {} }) as unknown as Animation;
});
afterEach(cleanup);

describe("with the list's visit of the open letter", () => {
  it("a panel verb is the list's: the engine hears nothing from the reader", () => {
    const visit = visitOf("m1");
    const { mail } = mountReader({ letters: [letter("m1")], open: "m1", meeting: { visit, blank: null } });
    fireEvent.click(within(panel()).getByRole("button", { name: "Later" }));
    fireEvent.click(within(panel()).getByRole("button", { name: "Park" }));
    expect(visit.act).toHaveBeenNthCalledWith(1, "later");
    expect(visit.act).toHaveBeenNthCalledWith(2, "aside");
    expect(mail.mutations).toEqual([]);
  });

  it("the read slot follows the list's read set, and its press is the list's", () => {
    const withSet = visitOf("m1", ["m1", "m0"]);
    mountReader({
      letters: [letter("m1", { unread: false })],
      open: "m1",
      meeting: { visit: withSet, blank: null },
    });
    fireEvent.click(within(panel()).getByRole("button", { name: "Mark read" }));
    expect(withSet.act).toHaveBeenCalledWith("unread");
    cleanup();
    mountReader({
      letters: [letter("m1", { unread: true })],
      open: "m1",
      meeting: { visit: visitOf("m1", []), blank: null },
    });
    expect(within(panel()).getByRole("button", { name: "Mark unread" })).toBeTruthy();
  });

  it("j and k step the list", () => {
    const visit = visitOf("m1");
    mountReader({ letters: [letter("m1")], open: "m1", meeting: { visit, blank: null } });
    fireEvent.keyDown(window, { key: "j" });
    fireEvent.keyDown(window, { key: "k" });
    expect(visit.step.down.run).toHaveBeenCalledTimes(1);
    expect(visit.step.up.run).toHaveBeenCalledTimes(1);
  });

  it("Move, behind More, offers every place but the letter's own and moves on the list's path", () => {
    const visit = visitOf("m1");
    const { mail } = mountReader({ letters: [letter("m1")], open: "m1", meeting: { visit, blank: null } });
    fireEvent.click(within(panel()).getByRole("button", { name: "More" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Move" }));
    const menu = screen.getByRole("menu", { name: "Move" });
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((i) => i.textContent),
    ).toEqual(["News", "Receipts", "Screened", "Spam"]);
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Receipts" }));
    expect(visit.act).toHaveBeenCalledWith("move:receipts");
    expect(mail.mutations).toEqual([]);
    expect(screen.queryByRole("menu", { name: "Move" })).toBeNull();
  });

  it("a visit of another letter is never used", () => {
    const other = visitOf("m9");
    const { mail } = mountReader({
      letters: [letter("m1")],
      open: "m1",
      meeting: { visit: other, blank: null },
    });
    fireEvent.click(within(panel()).getByRole("button", { name: "Later" }));
    expect(other.act).not.toHaveBeenCalled();
    expect(mail.mutations).toEqual([{ kind: "triage_set", messageId: "m1", state: "reply_later" }]);
  });
});

describe("with no list's visit", () => {
  it("a panel verb goes through the press seam and says its sentence", async () => {
    const { mail } = mountReader({ letters: [letter("m1")], open: "m1" });
    await act(async () => {
      fireEvent.click(within(panel()).getByRole("button", { name: "Park" }));
    });
    expect(mail.mutations).toEqual([{ kind: "triage_set", messageId: "m1", state: "set_aside" }]);
    expect(await screen.findByText("Parked")).toBeTruthy();
  });

  it("Move is not offered: moving to a place writes a sender's routing, which is the list's to run", () => {
    mountReader({ letters: [letter("m1")], open: "m1" });
    fireEvent.click(within(panel()).getByRole("button", { name: "More" }));
    expect(screen.queryByRole("menuitem", { name: "Move" })).toBeNull();
    expect(screen.getByRole("menuitem", { name: "Delete" })).toBeTruthy();
  });

  it("Reply hands a draft to the place that writes, and sends nothing", () => {
    const { mail, address } = mountReader({ letters: [letter("m1")], open: "m1" });
    fireEvent.click(within(panel()).getByRole("button", { name: "Reply" }));
    expect(mail.mutations).toEqual([]);
    expect(address.writes.at(-1)?.next).toMatch(/^#\/compose|^#\/write|^#\/new/);
  });
});

describe("with nothing open", () => {
  const blank = (meeting: ListMeeting | null | undefined) => {
    mountReader({ letters: [], open: null, ...(meeting === undefined ? {} : { meeting }) });
    return screen.getByRole("region", { name: "Reading" });
  };

  it("no list above: the column's own word", () => {
    expect(blank(undefined).textContent).toBe("Nothing open");
  });

  it("the list's word", () => {
    const column = blank({ visit: null, blank: { label: "5 unread", hot: true } });
    expect(column.textContent).toBe("5 unread");
  });

  it("nothing where the list says nothing", () => {
    expect(blank({ visit: null, blank: null }).textContent).toBe("");
  });
});
