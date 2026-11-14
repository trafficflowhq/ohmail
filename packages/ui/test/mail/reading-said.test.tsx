/** @vitest-environment jsdom */
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ActionPanel, MessageHead, ReadingHead } from "../../src/mail/index.js";

/**
 * WHAT THE READING PARTS SAY BEYOND WHAT THEY DRAW (the older tests' stops, first batch: point 65). Each line here is
 * something a screen reader, a pointer's hint or the keys meet, never a look: the words drawn stay as they were.
 */

afterEach(cleanup);

describe("ActionPanel: a verb whose name says more than its word", () => {
  it("is named by its whole sentence and hinted by it, while the word it draws stays its label", () => {
    render(
      <ActionPanel
        label="Actions"
        items={[
          {
            id: "read",
            label: "Mark read",
            name: "Mark 2 unread messages as read",
            widest: "Mark unread",
            icon: "read",
            keyHint: "u",
            apart: true,
          },
        ]}
      />,
    );
    const bar = screen.getByRole("toolbar", { name: "Actions" });
    const read = within(bar).getByRole("button", { name: "Mark 2 unread messages as read" });
    expect(read.getAttribute("title")).toBe("Mark 2 unread messages as read · u");
    expect(read.textContent, "the word drawn").toContain("Mark read");
    expect(read.textContent, "the sentence is said, not drawn").not.toContain("2 unread");
  });

  it("without a name, its word is its name, as before", () => {
    render(<ActionPanel label="Actions" items={[{ id: "read", label: "Mark read", apart: true }]} />);
    expect(screen.getByRole("button", { name: "Mark read" }).getAttribute("title")).toBe("Mark read");
  });
});

describe("ActionPanel: a verb that rests and still takes a press", () => {
  it("is said to be off and still hands its press on, so that the press can say why it did nothing", () => {
    const pressed: string[] = [];
    render(
      <ActionPanel
        label="Actions"
        items={[
          { id: "send", label: "Send", kind: "ink", resting: true, onPress: () => void pressed.push("send") },
        ]}
      />,
    );
    const send = screen.getByRole("button", { name: "Send" });
    expect({
      disabled: (send as HTMLButtonElement).disabled,
      said: send.getAttribute("aria-disabled"),
    }).toEqual({
      disabled: false,
      said: "true",
    });
    send.click();
    expect(pressed).toEqual(["send"]);
  });

  it("off is off: a verb both resting and disabled takes no press", () => {
    const pressed: string[] = [];
    render(
      <ActionPanel
        label="Actions"
        items={[
          {
            id: "send",
            label: "Send",
            resting: true,
            disabled: true,
            onPress: () => void pressed.push("send"),
          },
        ]}
      />,
    );
    const send = screen.getByRole("button", { name: "Send" });
    expect(send.getAttribute("aria-disabled")).toBeNull();
    send.click();
    expect(pressed).toEqual([]);
  });
});

describe("MessageHead: what the head says beyond what it draws", () => {
  const stamp = { when: "Wed 5 Aug 14:32", full: false, title: "Show the full date" };

  it("puts the machine date behind the printed stamp", () => {
    render(
      <MessageHead
        sender={{ name: "Anna Roth", address: "anna@kiln.example" }}
        stamp={{ ...stamp, at: "2026-08-05T14:32:00.000Z" }}
      />,
    );
    const when = screen.getByText("Wed 5 Aug 14:32");
    expect(when.tagName).toBe("TIME");
    expect(when.getAttribute("datetime")).toBe("2026-08-05T14:32:00.000Z");
  });

  it("prints a sender with no name once: the address is not said again beside itself", () => {
    const { container } = render(
      <MessageHead
        sender={{ name: "verify@atlas.invalid", address: "verify@atlas.invalid" }}
        stamp={stamp}
      />,
    );
    const said = container.textContent ?? "";
    expect(said.split("verify@atlas.invalid").length - 1).toBe(1);
  });

  it("a named sender keeps the address beside the name", () => {
    const { container } = render(
      <MessageHead sender={{ name: "Anna Roth", address: "anna@kiln.example" }} stamp={stamp} />,
    );
    expect(container.textContent).toContain("Anna Roth");
    expect(container.textContent).toContain("anna@kiln.example");
  });

  it("every name says it opens a card, and whether that card is open", () => {
    render(
      <MessageHead
        sender={{ name: "Anna Roth", address: "anna@kiln.example", expanded: false }}
        stamp={stamp}
        to={[
          {
            word: "to",
            people: [{ name: "Ben", expanded: true }, { name: "Cleo" }],
          },
        ]}
      />,
    );
    const said = (name: string) => {
      const b = screen.getByRole("button", { name });
      return [b.getAttribute("aria-haspopup"), b.getAttribute("aria-expanded")];
    };
    expect(said("Ben")).toEqual(["dialog", "true"]);
    expect(said("Cleo")).toEqual(["dialog", "false"]);
    expect(screen.getByRole("button", { name: /Anna Roth/ }).getAttribute("aria-expanded")).toBe("false");
  });
});

describe("MessageHead: a letter with no date", () => {
  it("draws no stamp at all: no nameless control that toggles nothing", () => {
    render(
      <MessageHead
        sender={{ name: "Anna Roth", address: "anna@kiln.example" }}
        stamp={{ when: "", full: false, title: "Show the full date" }}
      />,
    );
    expect(screen.getAllByRole("button").map((b) => b.getAttribute("aria-label") ?? b.textContent)).toEqual([
      "Anna Roth anna@kiln.example",
    ]);
    expect(screen.queryByTitle("Show the full date")).toBeNull();
  });

  it("a dated letter keeps its stamp, which turns short times into full dates", () => {
    render(
      <MessageHead
        sender={{ name: "Anna Roth", address: "anna@kiln.example" }}
        stamp={{ when: "09:12", full: false, title: "Show the full date" }}
      />,
    );
    expect(screen.getByRole("button", { name: "09:12" }).getAttribute("aria-pressed")).toBe("false");
  });
});

describe("ReadingHead: the open letter is a part of the place it stands in", () => {
  it("its subject is a level-2 heading, under the place's one level-1", () => {
    render(<ReadingHead subject="Glaze order #2291" names="Giulia Ferrari" people={[]} />);
    expect(screen.getByRole("heading", { level: 2, name: "Glaze order #2291" })).toBeTruthy();
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
  });
});
