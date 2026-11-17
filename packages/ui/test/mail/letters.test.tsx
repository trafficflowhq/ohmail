/** @vitest-environment jsdom */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { heard } from "../heard.js";
import {
  BlockedImages,
  DesignedLetter,
  FileNotArrived,
  LetterColumns,
  LetterHistory,
  LetterQuote,
  LetterViews,
  MessageHead,
  SendStatus,
  TextNotKept,
} from "../../src/mail/index.js";

afterEach(cleanup);

describe("a region of a letter that is said when it appears", () => {
  const nothing = () => {};
  const regions: [string, ReactElement, string][] = [
    [
      "why a letter was not sent",
      <SendStatus place="foot" verdict="Not sent." acts={[{ label: "Try again", onPress: nothing }]}>
        The server refused the letter.
      </SendStatus>,
      "Not sent. The server refused the letter.",
    ],
    [
      "the short line over a control",
      <SendStatus place="end">The draft was refused.</SendStatus>,
      "The draft was refused.",
    ],
    [
      "a text that is not kept here",
      <TextNotKept
        kind="kept"
        label="Not on this device"
        line="The text is on your mail server."
        act={{ label: "Load it", onPress: nothing }}
        fine="Kept for 30 days."
      />,
      "Not on this device The text is on your mail server. Kept for 30 days.",
    ],
    [
      "where a loaded text came from",
      <TextNotKept
        kind="loaded"
        line="Loaded from your mail server."
        more={{ label: "Keep it", onPress: nothing }}
      />,
      "Loaded from your mail server.",
    ],
    [
      "a fine line that says what is happening",
      <TextNotKept kind="fine" line="Loading the text…" live />,
      "Loading the text…",
    ],
  ];

  it.each(regions)(
    "%s: its words are drawn at once and kept from a screen reader until the region stands, then given; its controls are there throughout",
    async (_name, region, words) => {
      const controls = () => screen.queryAllByRole("button").length;
      render(region);
      const status = screen.getByRole("status");
      const there = controls();
      expect(heard(status)).toBe("");
      /* Drawn all the same: every word of it is on the page. */
      expect(words.split(" ").every((word) => status.textContent?.includes(word))).toBe(true);
      await waitFor(() => expect(heard(status)).toBe(words));
      expect(controls()).toBe(there);
      /* Drawn by a server the words are the reader's from the start. */
      const page = document.createElement("div");
      page.innerHTML = renderToStaticMarkup(region);
      expect(heard(page.querySelector('[role="status"]')!)).toBe(words);
    },
  );

  it("a fine line that only stands under what is shown is no region and keeps nothing back", () => {
    render(<TextNotKept kind="fine" line="Kept for 30 days." />);
    expect(screen.getByText("Kept for 30 days.").closest('[aria-hidden="true"]')).toBeNull();
  });

  it("a text not kept that takes the loading line's place, and the line that it was loaded, are each a region that appears: held, then said", async () => {
    const { rerender } = render(<TextNotKept kind="fine" line="Loading the text…" live />);
    await waitFor(() => expect(heard(screen.getByRole("status"))).toBe("Loading the text…"));
    rerender(
      <TextNotKept
        kind="kept"
        label="Not on this device"
        line="The text is on your mail server."
        act={{ label: "Load it", onPress: nothing }}
      />,
    );
    expect(heard(screen.getByRole("status"))).toBe("");
    await waitFor(() =>
      expect(heard(screen.getByRole("status"))).toBe("Not on this device The text is on your mail server."),
    );
    rerender(<TextNotKept kind="loaded" line="Loaded from your mail server." />);
    expect(heard(screen.getByRole("status"))).toBe("");
    await waitFor(() => expect(heard(screen.getByRole("status"))).toBe("Loaded from your mail server."));
  });
});

describe("DesignedLetter", () => {
  const letter = { title: "Message content", document: "<!doctype html><p>Programme</p>" };

  it("draws the letter in a frame that runs nothing, whatever it is handed", () => {
    render(<DesignedLetter {...letter} />);
    const frame = screen.getByTitle("Message content") as HTMLIFrameElement;
    expect(frame.getAttribute("srcdoc")).toBe(letter.document);
    const may = (frame.getAttribute("sandbox") ?? "none").split(" ");
    for (const never of ["allow-scripts", "allow-forms", "allow-top-navigation", "allow-modals"])
      expect(may).not.toContain(never);
    expect(frame.getAttribute("sandbox")).not.toBeNull();
    expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
  });

  it("is as tall as the app read its document to be, and hands the frame over once it has loaded", () => {
    const onLoad = vi.fn();
    render(<DesignedLetter {...letter} height={1893} onLoad={onLoad} />);
    const frame = screen.getByTitle("Message content") as HTMLIFrameElement;
    expect(frame.style.height).toBe("1893px");
    fireEvent.load(frame);
    expect(onLoad).toHaveBeenCalledWith(frame);
  });

  it("lays a press area over each link the app answers for, named by the link's words", () => {
    const onPress = vi.fn();
    render(
      <DesignedLetter
        {...letter}
        links={[{ label: "Read the issue", left: 40, top: 300, width: 120, height: 18, onPress }]}
      />,
    );
    const link = screen.getByRole("button", { name: "Read the issue" });
    expect([link.style.left, link.style.top, link.style.width, link.style.height]).toEqual([
      "40px",
      "300px",
      "120px",
      "18px",
    ]);
    fireEvent.click(link);
    expect(onPress).toHaveBeenCalledWith(link);
  });
});

describe("LetterViews", () => {
  it("offers each way to see the letter as a button of one named group", () => {
    const onImages = vi.fn();
    render(
      <LetterViews
        label="View"
        views={[
          { id: "images", label: "Show images", icon: "image", onPress: onImages },
          { id: "flip", label: "Show as text", touchOnly: true },
        ]}
      />,
    );
    const group = screen.getByRole("group", { name: "View" });
    fireEvent.click(within(group).getByRole("button", { name: "Show images" }));
    expect(onImages).toHaveBeenCalledTimes(1);
    expect(within(group).getByRole("button", { name: "Show as text" })).toBeTruthy();
  });

  it("is not drawn where there is no other way to see the letter", () => {
    const { container } = render(<LetterViews label="View" views={[]} />);
    expect(container.firstChild).toBeNull();
  });
});

describe("BlockedImages", () => {
  const chip = { caption: "Tracker blocked", sentence: "A tracking picture was kept out of this letter." };

  it("is one chip that says what was kept out, and asks to be opened on a press", () => {
    const onOpen = vi.fn();
    render(<BlockedImages {...chip} open={false} onOpen={onOpen} onClose={() => {}} />);
    const button = screen.getByRole("button", { name: "Tracker blocked" });
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText(chip.sentence)).toBeNull();
    fireEvent.click(button);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("says the one sentence while open; Esc closes it and the keys go back to the chip", () => {
    const onClose = vi.fn();
    const { rerender } = render(<BlockedImages {...chip} open onOpen={() => {}} onClose={onClose} />);
    const card = screen.getByRole("dialog", { name: "Tracker blocked" });
    expect(within(card).getByRole("note").textContent).toBe(chip.sentence);
    expect(screen.getByRole("button", { name: "Tracker blocked" }).getAttribute("aria-expanded")).toBe(
      "true",
    );
    fireEvent.keyDown(card, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    rerender(<BlockedImages {...chip} open={false} onOpen={() => {}} onClose={onClose} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Tracker blocked" }));
  });
});

describe("MessageHead", () => {
  it("prints each mark as a note under the recipients, the time beside it", () => {
    render(
      <MessageHead
        sender={{ name: "Petra Wyss", address: "petra@makersfest.example" }}
        stamp={{ when: "Wed 21 Oct 11:02", full: true, title: "Short times" }}
        to={[{ word: "to", people: [{ name: "you" }] }]}
        marks={[
          { text: "Answered by the away responder", when: "Wed 21 Oct 11:02" },
          { text: "Forwarded to Ben Arnold" },
        ]}
      />,
    );
    const marks = screen.getAllByRole("note").map((mark) => mark.textContent);
    expect(marks).toEqual(["Answered by the away responder · Wed 21 Oct 11:02", "Forwarded to Ben Arnold"]);
  });

  it("a mark that tells of something that went wrong leads with what it is, heavy, under the warning sign; a quiet mark has neither", () => {
    render(
      <MessageHead
        sender={{ name: "Lena Kaufmann", address: "lena@studio.example", printed: "You" }}
        stamp={{ when: "09:12", full: false, title: "Full dates" }}
        to={[{ word: "to", people: [{ name: "Giulia Rossi" }] }]}
        marks={[
          { lead: "No copy in Sent.", text: "The message went out; nothing to send again." },
          { text: "Forwarded to Ben Arnold" },
        ]}
      />,
    );
    const [warns, quiet] = screen.getAllByRole("note");
    expect(warns!.textContent).toBe("No copy in Sent. The message went out; nothing to send again.");
    expect(within(warns!).getByText("No copy in Sent.").tagName).toBe("B");
    /* The sign is a picture beside the words: drawn, and said by nobody. */
    expect(warns!.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    expect([quiet!.querySelector("svg"), quiet!.querySelector("b")]).toEqual([null, null]);
  });
});

describe("TextNotKept", () => {
  it("says where the text is before it offers to load it", () => {
    const [onLoad, onStorage] = [vi.fn(), vi.fn()];
    render(
      <TextNotKept
        kind="kept"
        label="Text on your mail server"
        line="Your storage is full, so Cloud does not keep this letter's text."
        act={{ label: "Load it now", onPress: onLoad }}
        more={{ label: "Storage", onPress: onStorage }}
        fine="It loads for this view only and is not stored."
      />,
    );
    const block = screen.getByRole("status");
    expect(block.textContent).toContain("Text on your mail server");
    expect(within(block).getByText("It loads for this view only and is not stored.")).toBeTruthy();
    fireEvent.click(within(block).getByRole("button", { name: "Load it now" }));
    fireEvent.click(within(block).getByRole("button", { name: "Storage" }));
    expect([onLoad.mock.calls.length, onStorage.mock.calls.length]).toEqual([1, 1]);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("rests the act while it loads, and says a refusal as an alert", () => {
    const onLoad = vi.fn();
    render(
      <TextNotKept
        kind="kept"
        label="Text on your mail server"
        warn="Your mail server no longer holds this letter where ohmail last saw it."
        act={{ label: "Loading from your mail server…", busy: true, onPress: onLoad }}
      />,
    );
    const act = screen.getByRole("button", { name: "Loading from your mail server…" }) as HTMLButtonElement;
    /* Off to a press and said so, by the kit's one rule for a press under way: the browser's own switch stays on, so the keys stay. */
    expect([act.getAttribute("aria-disabled"), act.getAttribute("aria-busy"), act.disabled]).toEqual([
      "true",
      "true",
      false,
    ]);
    expect(screen.getByRole("status").getAttribute("aria-busy")).toBe("true");
    fireEvent.click(act);
    expect(onLoad).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toBe(
      "Your mail server no longer holds this letter where ohmail last saw it.",
    );
  });

  it("serves a letter that did not load with the same shape: the refusal and its one way on", () => {
    const onPress = vi.fn();
    render(
      <TextNotKept
        kind="refused"
        warn="The full message didn't load, so this is its preview."
        way={{ label: "Try again", onPress }}
      />,
    );
    expect(screen.getByRole("alert").textContent).toBe(
      "The full message didn't load, so this is its preview.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it("says where a loaded text came from, and reports what is happening only while it happens", () => {
    const { rerender } = render(
      <TextNotKept
        kind="loaded"
        line="Loaded from your mail server for this view."
        more={{ label: "Storage" }}
      />,
    );
    expect(screen.getByRole("status").textContent).toContain("Loaded from your mail server for this view.");
    expect(screen.getByRole("button", { name: "Storage" })).toBeTruthy();
    rerender(<TextNotKept kind="fine" line="Loading this message from your mail server…" live />);
    expect(screen.getByRole("status").textContent).toBe("Loading this message from your mail server…");
    rerender(<TextNotKept kind="fine" line="You are reading this message's plain text." />);
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByText("You are reading this message's plain text.")).toBeTruthy();
  });
});

describe("FileNotArrived", () => {
  const file = { kind: "PDF", name: "evening-plan.pdf" };

  it("keeps the tile while the file is fetched, and reports the state as it changes", () => {
    render(<FileNotArrived {...file} state="fetching" line="Fetching from your mailbox…" />);
    const tile = screen.getByRole("button", { name: /evening-plan\.pdf/ });
    expect(tile.getAttribute("aria-busy")).toBe("true");
    expect(screen.getByRole("status").textContent).toBe("Fetching from your mailbox…");
  });

  it("carries the way on as a button on the tile, named with the file, and offers no other press", () => {
    const onPress = vi.fn();
    render(
      <FileNotArrived
        {...file}
        state="failed"
        line="Your mail server did not answer."
        way={{ label: "Try again", full: "Try again: evening-plan.pdf", onPress }}
      />,
    );
    expect(screen.getByRole("status").textContent).toBe("Your mail server did not answer.");
    const buttons = screen.getAllByRole("button");
    expect(buttons.map((b) => b.getAttribute("aria-label"))).toEqual(["Try again: evening-plan.pdf"]);
    fireEvent.click(buttons[0]!);
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it("carries no button where nothing helps", () => {
    render(
      <FileNotArrived kind="MOV" name="kiln-room.mov" state="large" line="212 MB, too large to fetch" />,
    );
    expect(screen.getByText("212 MB, too large to fetch")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("says in one sentence that the list itself did not load, and rests its way on while it looks again", () => {
    const onPress = vi.fn();
    const { rerender } = render(
      <FileNotArrived
        state="list"
        line="This message's files could not be loaded."
        way={{ label: "Try again", onPress }}
      />,
    );
    expect(screen.getByRole("alert").textContent).toBe("This message's files could not be loaded.");
    const way = screen.getByRole("button", { name: "Try again" });
    way.focus();
    fireEvent.click(way);
    expect(onPress).toHaveBeenCalledTimes(1);
    rerender(
      <FileNotArrived
        state="list"
        line="This message's files could not be loaded."
        way={{ label: "Looking again…", busy: true, onPress }}
      />,
    );
    const again = screen.getByRole("button", { name: "Looking again…" }) as HTMLButtonElement;
    /* The pressed way stays where it is with the keys on it, off to a second press. */
    expect(again).toBe(way);
    expect(document.activeElement).toBe(again);
    expect([again.getAttribute("aria-disabled"), again.disabled]).toEqual(["true", false]);
    fireEvent.click(again);
    expect(onPress).toHaveBeenCalledTimes(1);
  });
});

describe("LetterHistory", () => {
  const quoted = (
    <LetterQuote attribution="On Fri 6 Nov 2026 at 18:31, Mila Brunner wrote:">
      {"Hi Flurina\n\nFor January I can offer Saturday the 16th."}
      <LetterQuote attribution="On Thu 5 Nov 2026 at 09:10, Flurina Caduff wrote:">
        Do you have dates for January yet?
      </LetterQuote>
    </LetterQuote>
  );

  it("folds the quoted part behind its handle, and shows it while open", () => {
    const onPress = vi.fn();
    const { rerender } = render(
      <LetterHistory label="Show history" open={false} onPress={onPress}>
        {quoted}
      </LetterHistory>,
    );
    const handle = screen.getByRole("button", { name: "Show history" });
    expect(handle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("On Fri 6 Nov 2026 at 18:31, Mila Brunner wrote:")).toBeNull();
    fireEvent.click(handle);
    expect(onPress).toHaveBeenCalledTimes(1);
    rerender(
      <LetterHistory label="Hide history" open onPress={onPress}>
        {quoted}
      </LetterHistory>,
    );
    expect(screen.getByRole("button", { name: "Hide history" }).getAttribute("aria-expanded")).toBe("true");
    const outer = screen.getByText("On Fri 6 Nov 2026 at 18:31, Mila Brunner wrote:").nextElementSibling;
    expect(outer?.tagName).toBe("BLOCKQUOTE");
    expect(within(outer as HTMLElement).getByText("Do you have dates for January yet?").tagName).toBe(
      "BLOCKQUOTE",
    );
  });

  it("keeps a quote's own line breaks: under the kit's sheet its text stands line for line", () => {
    /* jsdom reads no `@layer`: the sheet's one layer is unwrapped, its rules loaded as written. */
    const css = readFileSync(
      resolve(process.cwd(), "packages/ui/src/mail/Reading/letter-history.css"),
      "utf8",
    )
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .trim();
    const sheet = document.createElement("style");
    sheet.textContent = /^@layer\s+[\w-]+\s*\{([\s\S]*)\}$/.exec(css)?.[1] ?? css;
    document.head.appendChild(sheet);
    try {
      expect((sheet.sheet as CSSStyleSheet).cssRules.length, "jsdom dropped the kit's sheet").toBeGreaterThan(
        5,
      );
      render(
        <LetterQuote attribution="On Fri 6 Nov 2026 at 18:31, Mila Brunner wrote:">
          {"Mila Brunner\nLichtgrat"}
        </LetterQuote>,
      );
      const quote = screen.getByText("Mila Brunner Lichtgrat");
      expect(quote.tagName).toBe("BLOCKQUOTE");
      expect(quote.textContent).toBe("Mila Brunner\nLichtgrat");
      expect(getComputedStyle(quote).whiteSpace).toBe("pre-line");
    } finally {
      sheet.remove();
    }
  });

  it("brings the next page of a long letter with the same handle, which then folds nothing", () => {
    const onPress = vi.fn();
    render(<LetterHistory label="Show more (33% shown)" onPress={onPress} />);
    const handle = screen.getByRole("button", { name: "Show more (33% shown)" });
    expect(handle.hasAttribute("aria-expanded")).toBe(false);
    fireEvent.click(handle);
    expect(onPress).toHaveBeenCalledTimes(1);
  });
});

describe("LetterColumns", () => {
  it("keeps the lines as written, and can be scrolled with the keys once it has a name", () => {
    const lines = "time      segment   setpoint\n16:00:00  1         21 °C";
    const { rerender } = render(<LetterColumns>{lines}</LetterColumns>);
    const block = screen.getByText(/16:00:00/);
    expect(block.textContent).toBe(lines);
    expect(block.hasAttribute("tabindex")).toBe(false);
    rerender(<LetterColumns label="Firing log">{lines}</LetterColumns>);
    expect(screen.getByRole("region", { name: "Firing log" }).getAttribute("tabindex")).toBe("0");
  });
});
