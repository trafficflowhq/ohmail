/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import {
  ActionPanel,
  BlankColumn,
  Files,
  FileTile,
  Message,
  MessageHead,
  ReadingHead,
  type MessageHeadProps,
  type PanelVerb,
} from "../../src/mail/index.js";

afterEach(cleanup);

const verbs: PanelVerb[] = [
  { id: "reply", label: "Reply", kind: "ink", icon: "reply", rank: 0, wordOrder: 3 },
  { id: "forward", label: "Forward", icon: "forward", rank: 0, wordOrder: 2 },
  { id: "later", label: "Later", icon: "later", rank: 2, segment: "defer" },
  { id: "park", label: "Park", icon: "parked", rank: 3, segment: "defer" },
  { id: "tag", label: "Tag", icon: "tags", rank: 5 },
  { id: "read", label: "Mark read", widest: "Mark unread", icon: "read", rank: 0, wordOrder: 1, apart: true },
];

describe("ActionPanel", () => {
  it("is a named toolbar of buttons; a toggle says whether it holds, and a verb that is off does not run", () => {
    const [onReply, onPark] = [vi.fn(), vi.fn()];
    render(
      <ActionPanel
        label="Actions"
        items={[
          { id: "reply", label: "Reply", kind: "ink", icon: "reply", keyHint: "r", onPress: onReply },
          { id: "later", label: "Later", icon: "later", pressed: true },
          { id: "park", label: "Park", icon: "parked", disabled: true, onPress: onPark },
          { note: "2 of 5" },
        ]}
      />,
    );
    const bar = screen.getByRole("toolbar", { name: "Actions" });
    const reply = within(bar).getByRole("button", { name: "Reply" });
    expect(reply.getAttribute("title")).toBe("Reply · r");
    fireEvent.click(reply);
    fireEvent.click(within(bar).getByRole("button", { name: "Park" }));
    expect(onReply).toHaveBeenCalledTimes(1);
    expect(onPark).not.toHaveBeenCalled();
    expect(within(bar).getByRole("button", { name: "Later" }).getAttribute("aria-pressed")).toBe("true");
    expect(within(bar).getByText("2 of 5")).toBeTruthy();
  });

  it("draws More only while something stands behind it", () => {
    const { rerender } = render(
      <ActionPanel label="Actions" items={verbs.slice(0, 2)} more={{ label: "More", behind: false }} />,
    );
    expect(screen.queryByRole("button", { name: "More" })).toBeNull();
    rerender(
      <ActionPanel label="Actions" items={verbs.slice(0, 2)} more={{ label: "More", behind: true }} />,
    );
    expect(screen.getByRole("button", { name: "More" }).getAttribute("aria-haspopup")).toBe("menu");
  });

  describe("short of room", () => {
    /* No layout here: a verb with its word is 80 px wide, one without 40, More 40; the room is what a case says. */
    let wide: MockInstance, room: MockInstance;
    const fits = (px: number) => room.mockReturnValue(px);
    beforeEach(() => {
      wide = vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(function (
        this: HTMLElement,
      ) {
        let sum = 0;
        for (const el of this.querySelectorAll<HTMLElement>("button"))
          if (!el.hidden) sum += el.dataset.short === undefined && !("more" in el.dataset) ? 80 : 40;
        return sum;
      });
      room = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(2000);
    });
    afterEach(() => {
      wide.mockRestore();
      room.mockRestore();
    });
    const shown = () =>
      screen
        .getAllByRole("button")
        .map((b) => `${b.getAttribute("aria-label")}${b.dataset.short === undefined ? "" : "*"}`);

    it("keeps every verb while there is room, and then draws no More with nothing behind it", () => {
      const onFold = vi.fn();
      render(
        <ActionPanel label="Actions" items={verbs} more={{ label: "More", behind: false }} onFold={onFold} />,
      );
      expect(shown()).toEqual(["Reply", "Forward", "Later", "Park", "Tag", "Mark read"]);
      expect(onFold).not.toHaveBeenCalled();
    });

    it("folds by rank, the highest first, and says which verbs went behind More", () => {
      fits(400);
      const onFold = vi.fn();
      render(
        <ActionPanel label="Actions" items={verbs} more={{ label: "More", behind: false }} onFold={onFold} />,
      );
      expect(shown()).toEqual(["Reply", "Forward", "Later", "Mark read", "More"]);
      expect(onFold).toHaveBeenLastCalledWith(["tag", "park"]);
    });

    it("then lets the floor give up its words in its own order, and never More", () => {
      fits(220);
      render(<ActionPanel label="Actions" items={verbs} more={{ label: "More", behind: false }} />);
      expect(shown()).toEqual(["Reply", "Forward*", "Mark read*", "More"]);
      fits(160);
      cleanup();
      render(<ActionPanel label="Actions" items={verbs} more={{ label: "More", behind: false }} />);
      expect(shown()).toEqual(["Reply*", "Forward*", "Mark read*", "More"]);
    });

    it("lets a note go before the floor loses a word, unless the note is to stay", () => {
      const items = [{ note: "2 of 5" }, ...verbs.slice(0, 2)];
      wide.mockImplementation(function (this: HTMLElement) {
        let sum = 0;
        for (const el of this.querySelectorAll<HTMLElement>("button, [data-note]"))
          if (!el.hidden) sum += el.dataset.short === undefined ? 80 : 40;
        return sum;
      });
      fits(170);
      const { rerender } = render(<ActionPanel label="Actions" items={items} />);
      expect(screen.getByText("2 of 5").hidden).toBe(true);
      expect(shown()).toEqual(["Reply", "Forward"]);
      fits(210);
      rerender(
        <ActionPanel label="Actions" items={[{ note: "2 of 5", keep: true }, ...verbs.slice(0, 2)]} />,
      );
      expect(screen.getByText("2 of 5").hidden).toBe(false);
      expect(shown()).toEqual(["Reply", "Forward*"]);
    });
  });
});

const head: MessageHeadProps = {
  sender: { name: "Ben Arnold", address: "ben@lichtgrat.example" },
  menu: { label: "Message" },
  stamp: { when: "Mon 17:30", full: false, title: "Full dates" },
  to: [{ word: "to", people: [{ name: "you" }, { name: "Giulia Ferrari" }] }],
  details: {
    label: "details",
    open: false,
    lines: [{ term: "Sent", value: "Monday 9 November 2026, 17:30" }],
  },
};

describe("MessageHead", () => {
  it("makes the sender one button that opens the contact card, at itself", () => {
    const onPress = vi.fn();
    render(<MessageHead {...head} sender={{ ...head.sender, onPress }} />);
    const sender = screen.getByRole("button", { name: /Ben Arnold ben@lichtgrat\.example/ });
    expect(sender.getAttribute("aria-haspopup")).toBe("dialog");
    fireEvent.click(sender);
    expect(onPress).toHaveBeenCalledWith(sender);
  });

  it("prints your own name as the app hands it, and keeps the circle the person's", () => {
    render(
      <MessageHead
        {...head}
        sender={{ name: "Mila Brunner", address: "mila@lichtgrat.example", printed: "You" }}
      />,
    );
    expect(screen.getByRole("button", { name: /You mila@lichtgrat\.example/ })).toBeTruthy();
  });

  it("makes every recipient a way to the contact card", () => {
    const onPress = vi.fn();
    render(
      <MessageHead
        {...head}
        to={[{ word: "to", people: [{ name: "you" }, { name: "Giulia Ferrari", onPress }] }]}
      />,
    );
    const giulia = screen.getByRole("button", { name: "Giulia Ferrari" });
    fireEvent.click(giulia);
    expect(onPress).toHaveBeenCalledWith(giulia);
  });

  it("says whether the details stand, and shows their lines only then", () => {
    const onToggle = vi.fn();
    const { rerender } = render(<MessageHead {...head} details={{ ...head.details!, onToggle }} />);
    const details = screen.getByRole("button", { name: "details" });
    expect(details.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Sent")).toBeNull();
    fireEvent.click(details);
    expect(onToggle).toHaveBeenCalledTimes(1);
    rerender(<MessageHead {...head} details={{ ...head.details!, open: true }} />);
    expect(screen.getByRole("button", { name: "details" }).getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Monday 9 November 2026, 17:30")).toBeTruthy();
  });

  it("makes the time a toggle between short times and full dates", () => {
    const onPress = vi.fn();
    const { rerender } = render(<MessageHead {...head} stamp={{ ...head.stamp, onPress }} />);
    const stamp = screen.getByRole("button", { name: "Mon 17:30" });
    expect(stamp.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(stamp);
    expect(onPress).toHaveBeenCalledTimes(1);
    rerender(
      <MessageHead {...head} stamp={{ when: "9 Nov 2026, 17:30", full: true, title: "Short times" }} />,
    );
    expect(screen.getByRole("button", { name: "9 Nov 2026, 17:30" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
  });

  it("names the message's menu and says that it opens one", () => {
    const onPress = vi.fn();
    render(<MessageHead {...head} menu={{ label: "Message", expanded: true, onPress }} />);
    const menu = screen.getByRole("button", { name: "Message" });
    expect(menu.getAttribute("aria-haspopup")).toBe("menu");
    expect(menu.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(menu);
    expect(onPress).toHaveBeenCalledWith(menu);
  });
});

describe("Message", () => {
  it("is an article with its head, its own subject as a heading, its text and its files", () => {
    render(
      <Message head={<MessageHead {...head} />} subject="Re: Glaze order #2291" files={<p>files</p>}>
        One thing for the courier.
      </Message>,
    );
    const article = screen.getByRole("article");
    expect(within(article).getByRole("heading", { level: 2, name: "Re: Glaze order #2291" })).toBeTruthy();
    expect(within(article).getByText("One thing for the courier.")).toBeTruthy();
    expect(within(article).getByText("files")).toBeTruthy();
  });
});

describe("FileTile", () => {
  const file = { kind: "JPG", name: "grat-01.jpg", size: "2.4 MB" };

  it("looks at the file from the tile and saves it from the arrow", () => {
    const onPress = vi.fn();
    const onSave = vi.fn();
    render(
      <FileTile
        {...file}
        main={{ label: "Preview grat-01.jpg", onPress }}
        save={{ label: "Download grat-01.jpg", onPress: onSave }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Preview grat-01.jpg" }));
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(onSave).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Download grat-01.jpg" }));
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it("as a set counts its files and offers them all at once", () => {
    const onPress = vi.fn();
    render(
      <Files summary="3 attachments · 7.3 MB" all={{ label: "Download all", onPress }}>
        <FileTile {...file} main={{ label: "Preview grat-01.jpg" }} />
      </Files>,
    );
    expect(screen.getByText("3 attachments · 7.3 MB")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Download all" }));
    expect(onPress).toHaveBeenCalledTimes(1);
  });
});

describe("ReadingHead", () => {
  it("is the conversation's heading, with who is in it", () => {
    render(
      <ReadingHead
        subject="Glaze order #2291"
        names="Giulia Ferrari, Ben Arnold"
        people={[{ name: "Giulia Ferrari", address: "giulia@terracotta-milano.example" }]}
        mailbox="Studio"
      />,
    );
    expect(screen.getByRole("heading", { level: 1, name: "Glaze order #2291" })).toBeTruthy();
    expect(screen.getByText("Giulia Ferrari, Ben Arnold")).toBeTruthy();
    expect(screen.getByText("Studio")).toBeTruthy();
  });

  it("stands without a heading where every message carries its own subject", () => {
    render(<ReadingHead names="Giulia Ferrari" people={[]} />);
    expect(screen.queryByRole("heading")).toBeNull();
  });
});

describe("BlankColumn", () => {
  it("says what the place holds", () => {
    render(<BlankColumn hot>5 unread</BlankColumn>);
    expect(screen.getByText((_, el) => el?.tagName === "P" && el.textContent === "5 unread")).toBeTruthy();
  });
});
