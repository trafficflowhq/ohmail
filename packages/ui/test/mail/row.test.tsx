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

  it("in a stream an unread row carries no dot on its circle: its newness is its place and its weight", () => {
    const dots = () => row().querySelectorAll("[data-kind='hot']").length;
    const { rerender } = render(<Row {...base} unread />);
    expect(dots()).toBe(1);
    rerender(<Row {...base} unread stream />);
    expect(dots()).toBe(0);
    /* It stays the unread row to everything else that reads it. */
    expect(row().hasAttribute("data-unread")).toBe(true);
    rerender(<Row {...base} stream />);
    expect([dots(), row().hasAttribute("data-unread")]).toEqual([0, false]);
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

  it("turns the list's times to their other form from a press on its time, and does not open", () => {
    const [onOpen, onWhen] = [vi.fn(), vi.fn()];
    render(<Row {...base} whenTitle="Monday 9 November 2026, 08:47" onOpen={onOpen} onWhen={onWhen} />);
    const when = within(row()).getByText("08:47");
    expect(when.getAttribute("title")).toBe("Monday 9 November 2026, 08:47");
    fireEvent.click(when);
    expect([onWhen.mock.calls.length, onOpen.mock.calls.length]).toEqual([1, 0]);
    fireEvent.click(within(row()).getByText("Your talk is on the programme"));
    expect([onWhen.mock.calls.length, onOpen.mock.calls.length]).toEqual([1, 1]);
  });

  it("opens from its time where nothing turns the times", () => {
    const onOpen = vi.fn();
    render(<Row {...base} onOpen={onOpen} />);
    fireEvent.click(within(row()).getByText("08:47"));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("runs its quick verb without opening", () => {
    const onOpen = vi.fn();
    const onPress = vi.fn();
    render(<Row {...base} unread onOpen={onOpen} quick={{ label: "Done", icon: "check", onPress }} />);
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("runs a button of its own without opening, also from the keys", () => {
    const onOpen = vi.fn();
    const onPress = vi.fn();
    render(<Row {...base} onOpen={onOpen} own={{ label: "Discard", onPress }} />);
    const own = screen.getByRole("button", { name: "Discard" });
    fireEvent.click(own);
    fireEvent.keyDown(own, { key: "Enter" });
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("stands its verbs beside the option, not inside it, and the keys reach the option and each verb once", () => {
    const [onOpen, done, discard] = [vi.fn(), vi.fn(), vi.fn()];
    render(
      <Rows label="Ohbox">
        <Row
          {...base}
          onOpen={onOpen}
          listing={{ name: "Petra Wyss: Your talk is on the programme", selected: false }}
          quick={{ label: "Done", icon: "check", onPress: done }}
          own={{ label: "Discard", onPress: discard }}
        />
      </Rows>,
    );
    const option = screen.getByRole("option");
    expect(option.querySelectorAll("button, a, input, [tabindex]")).toHaveLength(0);
    const list = screen.getByRole("listbox");
    const stops = [...list.querySelectorAll<HTMLElement>("button, [tabindex]")].filter(
      (el) => el.tabIndex >= 0,
    );
    expect(stops.map((el) => el.getAttribute("role") ?? el.textContent)).toEqual([
      "option",
      "Done",
      "Discard",
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect([done.mock.calls.length, discard.mock.calls.length, onOpen.mock.calls.length]).toEqual([1, 1, 0]);
  });

  it("as a button too, holds no button of its verbs", () => {
    render(<Row {...base} quick={{ label: "Done", icon: "check" }} own={{ label: "Discard" }} />);
    expect(row().querySelectorAll("button")).toHaveLength(0);
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual([
      row().textContent,
      "Done",
      "Discard",
    ]);
  });

  it("hands a right click on a verb beside it to the app as the row's menu, once", () => {
    const onMenu = vi.fn();
    render(
      <Row {...base} onMenu={onMenu} quick={{ label: "Done", icon: "check" }} own={{ label: "Discard" }} />,
    );
    for (const at of [
      screen.getByRole("button", { name: "Done" }),
      screen.getByRole("button", { name: "Discard" }),
      row(),
    ])
      expect(fireEvent.contextMenu(at, { clientX: 40, clientY: 12 })).toBe(false);
    expect(onMenu).toHaveBeenCalledTimes(3);
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
    expect(onMenu).toHaveBeenCalledWith({ x: 40, y: 12 }, expect.any(HTMLElement));
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

  it("as an entry is named by its section alone, its value and detail said as its description", () => {
    render(
      <Row
        entry
        who="Mailboxes"
        people={[]}
        sign="mail"
        when="2"
        subject="1 full"
        preview="lichtgrat.example"
        unread
      />,
    );
    const entry = screen.getByRole("button", { name: "Mailboxes" });
    const said = (entry.getAttribute("aria-describedby") ?? "")
      .split(" ")
      .map((id) => document.getElementById(id)?.textContent ?? "")
      .join(" ");
    expect(said.replace(/\s+/g, " ").trim()).toBe("1 full · lichtgrat.example");
    expect(entry.hasAttribute("aria-current")).toBe(false);
  });

  it("as an entry says it is the current page while it is open, and only then", () => {
    const { rerender } = render(
      <Row entry who="General" people={[]} sign="settings" subject="oh · Light" open />,
    );
    expect(screen.getByRole("button", { name: "General", current: "page" })).toBeTruthy();
    rerender(<Row entry who="General" people={[]} sign="settings" subject="oh · Light" />);
    expect(screen.getByRole("button", { name: "General" }).hasAttribute("aria-current")).toBe(false);
  });

  it("as a letter's row says no page and keeps the name its words give it", () => {
    render(<Row {...base} open />);
    expect(row().hasAttribute("aria-current")).toBe(false);
    expect(row().hasAttribute("aria-label")).toBe(false);
  });
});

describe("Row, a sender that waits", () => {
  it("says what there is to say about the sender as labels, in the order given, before the time", () => {
    render(<Row {...base} labels={["Needs you", "2 held"]} />);
    const text = row().textContent ?? "";
    expect(text).toContain("Needs you");
    expect(text.indexOf("Needs you")).toBeLessThan(text.indexOf("2 held"));
    expect(text.indexOf("2 held")).toBeLessThan(text.indexOf("08:47"));
  });

  it("marks a sender that is not who the name says with a named sign and its word, in the address's place", () => {
    render(<Row {...base} flag={{ label: "Lookalike", word: "Not Cinderlock" }} />);
    expect(within(row()).getByRole("img", { name: "Lookalike" })).toBeTruthy();
    expect(within(row()).getByText("Not Cinderlock")).toBeTruthy();
    expect(within(row()).queryByText(petra.address)).toBeNull();
  });

  it("offers the suggested place beside the row: one press accepts it, another control chooses, neither opens the row", () => {
    const [onOpen, onAccept, onChoose] = [vi.fn(), vi.fn(), vi.fn()];
    render(
      <Rows label="Screener">
        <Row
          {...base}
          listing={{ name: "Petra Wyss: Your talk is on the programme", selected: false }}
          onOpen={onOpen}
          place={{
            word: "News",
            accept: { label: "News and unsubscribe", onPress: onAccept },
            choose: { label: "Choose a place", onPress: onChoose },
          }}
        />
      </Rows>,
    );
    const option = screen.getByRole("option", { name: "Petra Wyss: Your talk is on the programme" });
    expect(within(option).queryByRole("button")).toBeNull();
    const accept = screen.getByRole("button", { name: "News and unsubscribe" });
    const choose = screen.getByRole("button", { name: "Choose a place" });
    expect(accept.textContent).toBe("News");
    fireEvent.click(accept);
    expect(onAccept).toHaveBeenCalledTimes(1);
    expect(choose.getAttribute("aria-haspopup")).toBe("menu");
    expect(choose.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(choose);
    expect(onChoose).toHaveBeenCalledTimes(1);
    expect(onChoose.mock.calls[0]?.[0]).toBe(choose);
    fireEvent.keyDown(accept, { key: "Enter" });
    expect(onOpen).not.toHaveBeenCalled();
    /* The keys reach the option, then each control once, in that order. */
    const stops = [...document.querySelectorAll<HTMLElement>("[tabindex='0'], button")];
    expect(stops).toEqual([option, accept, choose]);
  });

  it("the control that chooses another place holds its name as words, unseen, beside its arrow", () => {
    render(
      <Row
        {...base}
        place={{
          word: "News",
          accept: { label: "News and unsubscribe" },
          choose: { label: "Choose a place" },
        }}
      />,
    );
    const choose = screen.getByRole("button", { name: "Choose a place" });
    const words = within(choose).getByText("Choose a place");
    expect(words.className).toContain("oh-vh");
    /* The room the row keeps for it holds no second copy of the words. */
    expect(screen.getAllByText("Choose a place")).toHaveLength(1);
  });

  it("where nobody has a suggestion, the word itself chooses a place, and says its menu is open", () => {
    const onChoose = vi.fn();
    const { rerender } = render(
      <Row {...base} place={{ word: "Choose", choose: { label: "Choose a place", onPress: onChoose } }} />,
    );
    const choose = screen.getByRole("button", { name: "Choose a place" });
    expect(choose.textContent).toBe("Choose");
    fireEvent.click(choose);
    expect(onChoose).toHaveBeenCalledWith(choose);
    rerender(
      <Row
        {...base}
        place={{ word: "Choose", choose: { label: "Choose a place", expanded: true, onPress: onChoose } }}
      />,
    );
    expect(screen.getByRole("button", { name: "Choose a place" }).getAttribute("aria-expanded")).toBe("true");
  });

  it("with neither press, the place is a plain label and no control", () => {
    render(<Row {...base} place={{ word: "News" }} />);
    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(screen.getAllByText("News").length).toBeGreaterThan(0);
  });

  it("hands a right click on the place to the app as the row's menu, once", () => {
    const onMenu = vi.fn();
    render(<Row {...base} onMenu={onMenu} place={{ word: "News", accept: { label: "News" } }} />);
    fireEvent.contextMenu(screen.getByRole("button", { name: "News" }), { clientX: 40, clientY: 12 });
    expect(onMenu).toHaveBeenCalledTimes(1);
  });

  it("draws no label, sign or word it was not given", () => {
    render(<Row {...base} labels={[]} />);
    expect(within(row()).queryByRole("img")).toBeNull();
    expect(within(row()).getByText(petra.address)).toBeTruthy();
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

  /** A list of three letters, its one stop on the one named. */
  const three = (stop: string) => (
    <>
      <input aria-label="Find" />
      <div tabIndex={-1} aria-label="The list's own box" role="group">
        <Rows label="Letters">
          {["Ada", "Ben", "Cleo"].map((who) => (
            <Row
              key={who}
              {...base}
              who={who}
              listing={{ name: who, selected: who === stop, stop: who === stop }}
            />
          ))}
        </Rows>
      </div>
    </>
  );
  const keysOn = () => document.activeElement?.getAttribute("aria-label") ?? "the page";

  it("takes the keys along when the list's stop moves to it while they stand on another row of its list, or on a box around the list", () => {
    const { rerender } = render(three("Ada"));
    screen.getByRole("option", { name: "Ada" }).focus();
    rerender(three("Ben"));
    expect(keysOn()).toBe("Ben");
    screen.getByRole("group", { name: "The list's own box" }).focus();
    rerender(three("Cleo"));
    expect(keysOn()).toBe("Cleo");
  });

  it("takes them along from a row of another group too: a list set in groups has one stop", () => {
    const groups = (stop: string) => (
      <>
        {[
          ["New", "Ada"],
          ["Earlier", "Dora"],
        ].map(([group, who]) => (
          <Rows key={group} label={group!}>
            <Row {...base} who={who!} listing={{ name: who!, selected: who === stop, stop: who === stop }} />
          </Rows>
        ))}
      </>
    );
    const { rerender } = render(groups("Ada"));
    screen.getByRole("option", { name: "Ada" }).focus();
    rerender(groups("Dora"));
    expect(keysOn()).toBe("Dora");
  });

  it("takes no keys that stand elsewhere: in a field beside the list, or nowhere", () => {
    const { rerender } = render(three("Ada"));
    rerender(three("Ben"));
    expect(keysOn()).toBe("the page");
    screen.getByRole("textbox", { name: "Find" }).focus();
    rerender(three("Cleo"));
    expect(keysOn()).toBe("Find");
  });

  it("takes no keys from an option of another list that is no row: a command of the palette keeps them", () => {
    const beside = (stop: string) => (
      <>
        {three(stop)}
        <div role="listbox" aria-label="Commands">
          <button
            type="button"
            role="option"
            aria-selected={false}
            tabIndex={-1}
            aria-label="Open Settings"
          />
        </div>
      </>
    );
    const { rerender } = render(beside("Ada"));
    screen.getByRole("option", { name: "Open Settings" }).focus();
    rerender(beside("Ben"));
    expect(keysOn()).toBe("Open Settings");
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
          pulled: 0,
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
  const sides = {
    right: { label: "Done", icon: "check" as const },
    left: { label: "Later", icon: "later" as const },
  };
  const at = () => row().style.transform;

  it("shows the verb of the side it is pulled to, armed once the finger has gone far enough", () => {
    const { container, rerender } = render(<Row {...base} swipe={{ ...sides, pulled: 40 }} />);
    expect(within(container).getByText("Done")).toBeTruthy();
    expect(container.querySelector("[data-armed]")).toBeNull();
    rerender(<Row {...base} swipe={{ ...sides, pulled: 76 }} />);
    expect(container.querySelector("[data-armed]")).not.toBeNull();
    rerender(<Row {...base} swipe={{ ...sides, pulled: -90 }} />);
    expect(within(container).getByText("Later")).toBeTruthy();
    expect(container.querySelector("[data-armed]")).not.toBeNull();
  });

  it("travels with the finger to where the verb fires and with resistance past it, eased once", () => {
    const { rerender } = render(<Row {...base} swipe={{ ...sides, pulled: 60 }} />);
    expect(at()).toBe("translateX(60px)");
    /* The reference: a finger at 96 draws the row at 80; at 112, 83.2; it never travels past 112. */
    rerender(<Row {...base} swipe={{ ...sides, pulled: 96 }} />);
    expect(at()).toBe("translateX(80px)");
    rerender(<Row {...base} swipe={{ ...sides, pulled: -112 }} />);
    expect(at()).toBe("translateX(-83.2px)");
    rerender(<Row {...base} swipe={{ ...sides, pulled: 2000 }} />);
    expect(at()).toBe("translateX(112px)");
  });

  it("at rest, and pulled to a side that has no verb, it stands where it lies with nothing behind it", () => {
    const { container, rerender } = render(<Row {...base} swipe={{ ...sides, pulled: 0 }} />);
    expect(at()).toBe("");
    expect(container.querySelector(".oh-row-back")).toBeNull();
    rerender(<Row {...base} swipe={{ right: sides.right, pulled: -90 }} />);
    expect(at()).toBe("");
    expect(container.querySelector(".oh-row-back")).toBeNull();
  });

  it("listens for no finger itself: the list's own layer says how far it is pulled", () => {
    const { container } = render(<Row {...base} swipe={{ ...sides, pulled: 0 }} />);
    /* A row that took the finger for itself would hold the pointer, and the layer's own listener would lose it. */
    const held = vi.fn();
    row().setPointerCapture = held;
    fireEvent.pointerDown(row(), { pointerId: 1, pointerType: "touch", clientX: 100, clientY: 40 });
    fireEvent.pointerMove(row(), { pointerId: 1, pointerType: "touch", clientX: 200, clientY: 42 });
    expect(held).not.toHaveBeenCalled();
    expect(at()).toBe("");
    expect(container.querySelector(".oh-row-back")).toBeNull();
    fireEvent.pointerUp(row(), { pointerId: 1, pointerType: "touch", clientX: 200, clientY: 42 });
    expect(at()).toBe("");
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
