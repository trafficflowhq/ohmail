/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReadSquares, Row, Rows, type RowProps } from "../../src/mail/index.js";

afterEach(cleanup);

const petra = { name: "Petra Wyss", address: "petra@makersfest.example" };
const base: RowProps = {
  who: "Petra Wyss",
  address: petra.address,
  people: [petra],
  subject: "Your talk is on the programme",
  preview: "It made the final programme.",
  when: "08:47",
};
const row = () => screen.getByRole("button", { name: /Petra Wyss/ });

describe("Row", () => {
  it("is a button the keys can reach, and a press, Enter or Space opens it", () => {
    const onOpen = vi.fn();
    render(<Row {...base} onOpen={onOpen} />);
    expect(row().getAttribute("tabindex")).toBe("0");
    fireEvent.click(row());
    fireEvent.keyDown(row(), { key: "Enter" });
    fireEvent.keyDown(row(), { key: " " });
    expect(onOpen).toHaveBeenCalledTimes(3);
  });

  it("leaves every other key to the app", () => {
    const onOpen = vi.fn();
    render(<Row {...base} onOpen={onOpen} />);
    for (const key of ["j", "k", "x", "ArrowDown", "Escape"]) fireEvent.keyDown(row(), { key });
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("opens the contact from the address, and not the letter", () => {
    const onOpen = vi.fn();
    const onContact = vi.fn();
    render(<Row {...base} onOpen={onOpen} onContact={onContact} />);
    fireEvent.click(screen.getByText(petra.address));
    expect(onContact).toHaveBeenCalledTimes(1);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("runs its quick verb without opening", () => {
    const onOpen = vi.fn();
    const onPress = vi.fn();
    render(<Row {...base} unread onOpen={onOpen} quick={{ label: "Done", icon: "check", onPress }} />);
    fireEvent.click(within(row()).getByRole("button", { name: "Done" }));
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("runs a button of its own without opening, also from the keys", () => {
    const onOpen = vi.fn();
    const onPress = vi.fn();
    render(<Row {...base} onOpen={onOpen} own={{ label: "Discard", onPress }} />);
    const own = within(row()).getByRole("button", { name: "Discard" });
    fireEvent.click(own);
    fireEvent.keyDown(own, { key: "Enter" });
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("says that it is picked, and nothing while it is not", () => {
    const { rerender } = render(<Row {...base} />);
    expect(row().hasAttribute("aria-selected")).toBe(false);
    rerender(<Row {...base} picked />);
    expect(row().getAttribute("aria-selected")).toBe("true");
  });

  it("hands a right click to the app as its menu, where the pointer is", () => {
    const onMenu = vi.fn();
    render(<Row {...base} onMenu={onMenu} />);
    const shown = fireEvent.contextMenu(row(), { clientX: 40, clientY: 12 });
    expect(shown).toBe(false);
    expect(onMenu).toHaveBeenCalledWith({ x: 40, y: 12 });
  });

  it("names the people of a conversation and the file it carries", () => {
    render(
      <Row
        {...base}
        people={[
          petra,
          { name: "Ben Arnold", address: "ben@kiln.example" },
          { name: "Mila Brunner", address: "mila@lichtgrat.example" },
        ]}
        peopleMore="+2"
        peopleLabel="3 people: Petra Wyss, Ben Arnold and you"
        file="Has an attachment"
      />,
    );
    expect(screen.getByRole("img", { name: "3 people: Petra Wyss, Ben Arnold and you" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "Has an attachment" })).toBeTruthy();
  });

  it("draws a row that is no person with its sign, and an amount in place of the time", () => {
    render(<Row who="No recipient yet" people={[]} sign="write" subject="Re: December" amount="CHF 48.00" />);
    const draft = screen.getByRole("button", { name: /No recipient yet/ });
    expect(within(draft).getByText("CHF 48.00")).toBeTruthy();
    expect(draft.querySelector("time")).toBeNull();
  });

  it("as an entry is a button named by its section, opened by a press and by Enter, its value set off from the detail", () => {
    const onOpen = vi.fn();
    render(
      <Row
        entry
        who="Notifications"
        people={[]}
        sign="bell"
        subject="On"
        preview="Ohbox · Screener"
        onOpen={onOpen}
      />,
    );
    const entry = screen.getByRole("button", { name: /^Notifications/ });
    expect(entry.textContent).toContain("On · Ohbox · Screener");
    fireEvent.click(entry);
    fireEvent.keyDown(entry, { key: "Enter" });
    expect(onOpen).toHaveBeenCalledTimes(2);
  });
});

describe("Row, in a listbox", () => {
  const listing = { name: "Petra Wyss: Your talk is on the programme", spoken: "unread", selected: false };

  it("is an option named as the letter, its state said as its description, also through a node it points at", () => {
    render(<Row {...base} unread listing={listing} />);
    const option = screen.getByRole("option", { name: "Petra Wyss: Your talk is on the programme" });
    expect(option.getAttribute("aria-description")).toBe("unread");
    const said = document.getElementById(option.getAttribute("aria-describedby") ?? "");
    expect(said?.getAttribute("aria-label")).toBe("unread");
    expect(option.getAttribute("aria-selected")).toBe("false");
  });

  it("says its selection, and its place in the group", () => {
    render(<Row {...base} listing={{ ...listing, selected: true, place: { at: 2, of: 7 } }} />);
    const option = screen.getByRole("option", { name: listing.name });
    expect(option.getAttribute("aria-selected")).toBe("true");
    expect(option.getAttribute("aria-posinset")).toBe("2");
    expect(option.getAttribute("aria-setsize")).toBe("7");
  });

  it("is the list's one tab stop only when it says so, and every row is one when nothing says", () => {
    const { rerender } = render(<Row {...base} listing={{ ...listing, stop: false }} />);
    expect(screen.getByRole("option", { name: listing.name }).getAttribute("tabindex")).toBe("-1");
    rerender(<Row {...base} listing={{ ...listing, stop: true }} />);
    expect(screen.getByRole("option", { name: listing.name }).getAttribute("tabindex")).toBe("0");
    rerender(<Row {...base} listing={listing} />);
    expect(screen.getByRole("option", { name: listing.name }).getAttribute("tabindex")).toBe("0");
  });

  it("names nothing it was not given", () => {
    render(<Row {...base} listing={{ name: listing.name, selected: false }} />);
    const option = screen.getByRole("option", { name: listing.name });
    expect(option.hasAttribute("aria-description")).toBe(false);
    expect(option.hasAttribute("aria-describedby")).toBe(false);
    expect(option.hasAttribute("aria-posinset")).toBe(false);
  });

  it("says no state it has no words for, and names no letters it does not fold", () => {
    render(<Row {...base} listing={{ ...listing, spoken: "" }} mark={{ id: "m1", ids: [] }} />);
    const option = screen.getByRole("option", { name: listing.name });
    expect(option.hasAttribute("aria-description")).toBe(false);
    expect(option.hasAttribute("aria-describedby")).toBe(false);
    expect(option.hasAttribute("data-ids")).toBe(false);
  });

  it("carries the marks a list finds and measures it by", () => {
    render(
      <Row {...base} listing={listing} mark={{ id: "m1", ids: ["m1", "m2"], index: 4, unseen: true }} />,
    );
    const option = screen.getByRole("option", { name: listing.name });
    expect(option.dataset.id).toBe("m1");
    expect(option.dataset.ids).toBe("m1 m2");
    expect(option.dataset.index).toBe("4");
    expect(option.dataset.unseen).toBe("1");
  });

  it("is the one node a list measures, whatever it holds: its squares carry no index of the list's", () => {
    const { container } = render(
      <Row
        {...base}
        listing={listing}
        mark={{ id: "m1", index: 4 }}
        squares={<ReadSquares squares={["seen", "unseen", "own"]} axis="row" label="3 messages, 1 unread" />}
      />,
    );
    const marked = [...container.querySelectorAll("[data-index]")];
    expect(marked).toHaveLength(1);
    expect(marked[0]).toBe(screen.getByRole("option", { name: listing.name }));
  });

  it("is measured by its slot where it can be swiped", () => {
    const { container } = render(
      <Row
        {...base}
        listing={listing}
        mark={{ id: "m1", index: 3 }}
        swipe={{
          right: { label: "Done", icon: "check" },
          left: { label: "Later", icon: "later" },
          onSwipe: () => {},
        }}
      />,
    );
    const option = screen.getByRole("option", { name: listing.name });
    expect(option.dataset.index).toBeUndefined();
    expect(option.dataset.id).toBe("m1");
    expect(container.querySelectorAll('[data-index="3"]')).toHaveLength(1);
  });

  it("without a listing is the button it always was", () => {
    render(<Row {...base} />);
    expect(row().getAttribute("role")).toBe("button");
    expect(row().hasAttribute("data-id")).toBe(false);
  });
});

describe("Row, under a finger", () => {
  if (typeof globalThis.PointerEvent !== "function") {
    class PointerEventHere extends MouseEvent {
      readonly pointerId: number;
      readonly pointerType: string;
      constructor(type: string, init: PointerEventInit = {}) {
        super(type, init);
        this.pointerId = init.pointerId ?? 0;
        this.pointerType = init.pointerType ?? "mouse";
      }
    }
    globalThis.PointerEvent = PointerEventHere as unknown as typeof PointerEvent;
  }
  const swipe = (onSwipe: () => void) => ({
    right: { label: "Done", icon: "check" as const },
    left: { label: "Later", icon: "later" as const },
    onSwipe,
  });
  const drag = (from: [number, number], to: [number, number], pointerType = "touch") => {
    fireEvent.pointerDown(row(), { pointerId: 1, pointerType, clientX: from[0], clientY: from[1] });
    fireEvent.pointerMove(row(), { pointerId: 1, pointerType, clientX: to[0], clientY: to[1] });
  };
  const letGo = (at: [number, number]) =>
    fireEvent.pointerUp(row(), { pointerId: 1, pointerType: "touch", clientX: at[0], clientY: at[1] });

  it("shows the verb it lands on while it is pulled, armed once it has gone far enough", () => {
    const { container } = render(<Row {...base} swipe={swipe(() => {})} />);
    drag([100, 40], [140, 42]);
    expect(within(container).getByText("Done")).toBeTruthy();
    expect(container.querySelector("[data-armed]")).toBeNull();
    fireEvent.pointerMove(row(), { pointerId: 1, pointerType: "touch", clientX: 190, clientY: 42 });
    expect(container.querySelector("[data-armed]")).not.toBeNull();
  });

  it("runs the verb of the side it was pulled to, only when it went far enough", () => {
    const onSwipe = vi.fn();
    render(<Row {...base} swipe={swipe(onSwipe)} />);
    drag([100, 40], [150, 40]);
    letGo([150, 40]);
    expect(onSwipe).not.toHaveBeenCalled();
    drag([100, 40], [190, 44]);
    letGo([190, 44]);
    drag([200, 40], [100, 38]);
    letGo([100, 38]);
    expect(onSwipe.mock.calls.map((c) => c[0])).toEqual(["right", "left"]);
  });

  it("leaves a finger that scrolls, and a pointer, alone", () => {
    const onSwipe = vi.fn();
    const { container } = render(<Row {...base} swipe={swipe(onSwipe)} />);
    drag([100, 40], [104, 160]);
    letGo([190, 160]);
    drag([100, 40], [200, 40], "mouse");
    fireEvent.pointerUp(row(), { pointerId: 1, pointerType: "mouse", clientX: 200, clientY: 40 });
    expect(onSwipe).not.toHaveBeenCalled();
    expect(container.querySelector(".oh-row-back")).toBeNull();
  });
});

describe("Rows", () => {
  it("is the list its rows stand in", () => {
    render(
      <Rows>
        <Row {...base} />
      </Rows>,
    );
    expect(within(screen.getByRole("list")).getByRole("button", { name: /Petra Wyss/ })).toBeTruthy();
  });

  it("as a named group is a listbox, many-selectable when it says so", () => {
    render(
      <Rows label="New" many>
        <Row {...base} listing={{ name: "Petra Wyss: Your talk is on the programme", selected: false }} />
      </Rows>,
    );
    const box = screen.getByRole("listbox", { name: "New" });
    expect(box.getAttribute("aria-multiselectable")).toBe("true");
    expect(within(box).getByRole("option", { name: /Petra Wyss/ })).toBeTruthy();
  });

  it("unnamed, is a plain list that picks nothing, even when told many", () => {
    render(
      <Rows many>
        <Row {...base} />
      </Rows>,
    );
    expect(screen.getByRole("list").hasAttribute("aria-multiselectable")).toBe(false);
  });
});
