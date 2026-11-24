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
  ReadingLine,
  type MessageHeadProps,
  type PanelVerb,
} from "../../src/mail/index.js";
import { Dot, SentencePart, Slot, Tag } from "../../src/base/index.js";

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

  it("hands a verb's press, and More's, the button that was pressed, where its menu stands", () => {
    const [onTag, onMore] = [vi.fn(), vi.fn()];
    render(
      <ActionPanel
        label="Actions"
        items={[{ id: "tag", label: "Tag", icon: "tags", onPress: onTag }]}
        more={{ label: "More", behind: true, onPress: onMore }}
      />,
    );
    const tag = screen.getByRole("button", { name: "Tag" });
    const more = screen.getByRole("button", { name: "More" });
    fireEvent.click(tag);
    fireEvent.click(more);
    expect(onTag).toHaveBeenCalledWith(tag);
    expect(onMore).toHaveBeenCalledWith(more);
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

    it("lets a note that is to stay take a second line only once nothing else can give, and takes it back when there is room", () => {
      /* A note that stays is 200 px on one line and 110 on two. */
      const note = "This mailbox is organized by nothing";
      const items = [{ note, keep: true }, ...verbs.slice(0, 2)];
      wide.mockImplementation(function (this: HTMLElement) {
        let sum = 0;
        for (const el of this.querySelectorAll<HTMLElement>("button, [data-note]")) {
          if (el.hidden) continue;
          if ("note" in el.dataset) sum += el.dataset.fold === undefined ? 200 : 110;
          else sum += el.dataset.short === undefined ? 80 : 40;
        }
        return sum;
      });
      /* Room for the note on one line once both verbs stand as their signs: it keeps its line. */
      fits(280);
      const { rerender } = render(<ActionPanel label="Actions" items={items} />);
      expect(shown()).toEqual(["Reply*", "Forward*"]);
      expect(screen.getByText(note).dataset.fold).toBeUndefined();
      /* Less than that: the verbs have given all they can, and the note folds. It is never taken away. */
      fits(200);
      rerender(<ActionPanel label="Actions" items={[...items]} />);
      expect(shown()).toEqual(["Reply*", "Forward*"]);
      expect([screen.getByText(note).hidden, screen.getByText(note).dataset.fold]).toEqual([false, ""]);
      /* With room again it stands on one line, and the verbs have their words. */
      fits(2000);
      rerender(<ActionPanel label="Actions" items={[...items]} />);
      expect(shown()).toEqual(["Reply", "Forward"]);
      expect(screen.getByText(note).dataset.fold).toBeUndefined();
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

  it("marks its sender line, where the read rule looks for it", () => {
    const { container } = render(<MessageHead {...head} />);
    expect(container.querySelector("[data-sender-line]")).toBe(
      screen.getByRole("button", { name: /Ben Arnold ben@lichtgrat\.example/ }),
    );
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

describe("Message, in a stream", () => {
  const letter = { head: <p>head</p>, files: <p>the files</p>, after: <p>an invitation</p> };

  it("is cut until it is opened: what follows its text waits, and its control says whether it stands open", () => {
    const onPress = vi.fn();
    const { rerender } = render(
      <Message {...letter} clip={{ open: false, word: "Expand", onPress }}>
        The first lines of a long letter.
      </Message>,
    );
    const article = screen.getByRole("article");
    expect(within(article).getByText("The first lines of a long letter.")).toBeTruthy();
    expect(within(article).queryByText("the files")).toBeNull();
    expect(within(article).queryByText("an invitation")).toBeNull();
    const open = within(article).getByRole("button", { name: "Expand" });
    expect(open.getAttribute("aria-expanded")).toBe("false");
    /* The control names the box it opens and shuts: the cut text. */
    const cut = article.ownerDocument.getElementById(open.getAttribute("aria-controls") ?? "none");
    expect(cut?.textContent).toBe("The first lines of a long letter.");
    fireEvent.click(open);
    expect(onPress).toHaveBeenCalledTimes(1);
    rerender(
      <Message {...letter} clip={{ open: true, word: "Collapse", onPress }}>
        The first lines of a long letter.
      </Message>,
    );
    expect(within(article).getByText("the files")).toBeTruthy();
    expect(within(article).getByText("an invitation")).toBeTruthy();
    expect(within(article).getByRole("button", { name: "Collapse" }).getAttribute("aria-expanded")).toBe(
      "true",
    );
  });

  it("offers the way to the whole letter where a press leaves for it, as a way on with no open state", () => {
    const onPress = vi.fn();
    render(
      <Message {...letter} clip={{ open: false, word: "Read in full", goes: true, onPress }}>
        The first lines.
      </Message>,
    );
    const way = screen.getByRole("button", { name: "Read in full" });
    expect(way.getAttribute("aria-expanded")).toBeNull();
    fireEvent.click(way);
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it("offers nothing to open where the cut text fits and nothing waits under it; a file that waits keeps the control", () => {
    /* What a browser would measure of the cut box: the text is no taller than its box. */
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(120);
    const tall = vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(120);
    const { rerender } = render(
      <Message head={<p>head</p>} clip={{ open: false, word: "Expand" }}>
        Short.
      </Message>,
    );
    expect(screen.queryByRole("button", { name: "Expand" })).toBeNull();
    expect(screen.getByText("Short.")).toBeTruthy();
    rerender(
      <Message {...letter} clip={{ open: false, word: "Expand" }}>
        Short.
      </Message>,
    );
    expect(screen.getByRole("button", { name: "Expand" })).toBeTruthy();
    /* A text taller than its box is cut, and says so with its control. */
    tall.mockReturnValue(900);
    cleanup();
    render(
      <Message head={<p>head</p>} clip={{ open: false, word: "Expand" }}>
        Long.
      </Message>,
    );
    expect(screen.getByRole("button", { name: "Expand" })).toBeTruthy();
    vi.restoreAllMocks();
  });

  it("is whole, with nothing waiting and no control, where it is not in a stream", () => {
    render(<Message {...letter}>The first lines.</Message>);
    expect(screen.getByText("the files")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
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
    expect(screen.getByRole("heading", { level: 2, name: "Glaze order #2291" })).toBeTruthy();
    expect(screen.getByText("Giulia Ferrari, Ben Arnold")).toBeTruthy();
    expect(screen.getByText("Studio")).toBeTruthy();
  });

  it("stands without a heading where every message carries its own subject", () => {
    render(<ReadingHead names="Giulia Ferrari" people={[]} />);
    expect(screen.queryByRole("heading")).toBeNull();
  });
});

describe("ReadingHead, a sentence that is the control", () => {
  const head = (onCard = vi.fn(), onPlace = vi.fn()) => (
    <ReadingHead
      sentence={
        <>
          <SentencePart>Lena Kaufmann</SentencePart>{" "}
          <SentencePart>
            goes to <Slot onPress={onPlace}>Ohbox</Slot>
            <Dot kind="hot" />
          </SentencePart>
        </>
      }
      lines={
        <>
          <ReadingLine
            sign="ok"
            person={{ label: "lena@atelier-eichspan.example", onPress: onCard }}
            word={{ text: "Confirmed" }}
          >
            <Tag>Unsubscribe offered</Tag>
          </ReadingLine>
          <ReadingLine sign="spark" figure={{ text: "92%", title: "Confidence" }} why>
            A personal note from a real address
          </ReadingLine>
        </>
      }
    />
  );

  it("stands the sentence in the subject's place, as a line and no heading, with its slot a control of the head", () => {
    const onPlace = vi.fn();
    render(head(vi.fn(), onPlace));
    const banner = screen.getByRole("banner");
    expect(within(banner).queryByRole("heading")).toBeNull();
    expect(banner.firstElementChild?.tagName).toBe("P");
    expect(banner.firstElementChild?.textContent).toBe("Lena Kaufmann goes to Ohbox");
    fireEvent.click(within(banner).getByRole("button", { name: "Ohbox" }));
    expect(onPlace).toHaveBeenCalledTimes(1);
  });

  it("says who it is under the sentence: the address a way to the card, with what the check found said in words", () => {
    const onCard = vi.fn();
    render(head(onCard));
    const address = screen.getByRole("button", { name: "lena@atelier-eichspan.example" });
    expect(address.getAttribute("aria-haspopup")).toBe("dialog");
    fireEvent.click(address);
    expect(onCard).toHaveBeenCalledTimes(1);
    expect(onCard.mock.calls[0]![0]).toBe(address);
    /* Good news is said and not drawn; the sign carries it for the eye, and the pointer's hint names it. */
    const word = screen.getByText("Confirmed");
    expect(word.className).toContain("oh-vh");
    expect(address.parentElement?.getAttribute("title")).toBe("Confirmed");
    expect(screen.getByText("Unsubscribe offered")).toBeTruthy();
  });

  it("draws the check's word where it warns, and the advice with how sure it is before its reason", () => {
    render(
      <ReadingHead
        sentence="Cinderlock Security"
        lines={
          <>
            <ReadingLine
              sign="warn"
              person={{ label: "alerts@cinder1ock.example" }}
              word={{ text: "Not Cinderlock", warns: true }}
            />
            <ReadingLine sign="spark" figure={{ text: "92%", title: "Confidence" }} why>
              A personal note from a real address
            </ReadingLine>
          </>
        }
      />,
    );
    expect(screen.getByText("Not Cinderlock").className).not.toContain("oh-vh");
    /* An address that opens nothing is words: no control, and nothing said to open. */
    expect(screen.queryByRole("button", { name: "alerts@cinder1ock.example" })).toBeNull();
    const plain = screen.getByText("alerts@cinder1ock.example");
    expect(plain.hasAttribute("aria-haspopup")).toBe(false);
    expect(plain.parentElement?.getAttribute("title")).toBe("Not Cinderlock");
    const sure = screen.getByText("92%");
    expect(sure.getAttribute("title")).toBe("Confidence");
    expect(sure.parentElement?.textContent).toBe("92%A personal note from a real address");
  });

  it("keeps the conversation's head as it was: a subject is the heading, and who is in it stands under it", () => {
    render(<ReadingHead subject="Glaze order #2291" names="Giulia Ferrari" people={[]} />);
    expect(screen.getByRole("heading", { level: 2, name: "Glaze order #2291" })).toBeTruthy();
    expect(screen.getByText("Giulia Ferrari")).toBeTruthy();
  });
});

describe("MessageHead, a held letter", () => {
  it("says to whom it was written in the recipients' line: the word, then each name a way to the card", () => {
    const onYou = vi.fn();
    render(
      <MessageHead
        sender={{ name: "Lena Kaufmann", address: "lena@atelier-eichspan.example" }}
        stamp={{ when: "08:40", full: false, title: "Show the full date" }}
        to={[{ word: "to", people: [{ name: "you", onPress: onYou }] }]}
      />,
    );
    const you = screen.getByRole("button", { name: "you" });
    expect(you.parentElement?.textContent).toBe("to you");
    fireEvent.click(you);
    expect(onYou).toHaveBeenCalledTimes(1);
  });
});

describe("ActionPanel, a decision", () => {
  it("stands the answers that let mail in apart from those that keep it out, and says of More that its menu is shut", () => {
    const { rerender } = render(
      <ActionPanel
        label="Actions"
        items={[
          { id: "ohbox", label: "Ohbox", kind: "ink", icon: "ohbox", rank: 0, segment: "in" },
          { id: "news", label: "News", icon: "news", rank: 3, segment: "in" },
          { note: "+ unsubscribe" },
          { id: "screened", label: "Screen out", icon: "screenout", rank: 0, segment: "out" },
          { id: "spam", label: "Spam", icon: "spam", rank: 5, segment: "out" },
        ]}
        more={{ label: "More", behind: true }}
      />,
    );
    const bar = screen.getByRole("toolbar", { name: "Actions" });
    const apart = [...bar.querySelectorAll("button")].filter((b) => b.hasAttribute("data-apart"));
    expect(apart.map((b) => b.getAttribute("aria-label"))).toEqual(["Screen out", "More"]);
    expect(within(bar).getByText("+ unsubscribe")).toBeTruthy();
    /* A control that opens a menu says whether it stands open: shut where nothing is handed, as every such control. */
    expect(screen.getByRole("button", { name: "More" }).getAttribute("aria-expanded")).toBe("false");
    rerender(
      <ActionPanel label="Actions" items={[]} more={{ label: "More", behind: true, expanded: true }} />,
    );
    expect(screen.getByRole("button", { name: "More" }).getAttribute("aria-expanded")).toBe("true");
  });
});

describe("BlankColumn", () => {
  it("says what the place holds", () => {
    render(<BlankColumn hot>5 unread</BlankColumn>);
    expect(screen.getByText((_, el) => el?.tagName === "P" && el.textContent === "5 unread")).toBeTruthy();
  });
});
