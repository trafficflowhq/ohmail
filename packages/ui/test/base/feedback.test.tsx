/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createRef, useState, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Button,
  CameraSquare,
  Counters,
  Dialog,
  Empty,
  Mark,
  Notice,
  NoticeSlot,
  Opening,
  RowsShape,
  Page,
  RefusalLine,
  Report,
  Sentence,
  slotOrder,
  StepDots,
  WaitRow,
  type SlotNotice,
} from "../../src/base/index.js";

import { heard } from "../heard.js";

afterEach(cleanup);

describe("a region that is said when it appears", () => {
  const nothing = () => {};
  const regions: [string, ReactElement, string, boolean][] = [
    [
      "a report",
      <Report undo={{ label: "Undo", onPress: nothing }}>Moved to News</Report>,
      "Moved to News",
      true,
    ],
    [
      "a report that says why",
      <Report kind="why" why="The server did not answer." act={{ label: "Mailboxes", onPress: nothing }}>
        Not moved
      </Report>,
      "Not moved The server did not answer.",
      true,
    ],
    [
      "a notice",
      <Notice
        place="rail"
        title="The mailbox is full"
        line="Sent copies wait."
        acts={[{ label: "Mailboxes", onPress: nothing }]}
      />,
      "The mailbox is full Sent copies wait.",
      true,
    ],
    [
      "what a press inside a dialog came to",
      <Dialog
        open
        onClose={nothing}
        title="Rename the tag"
        cancel={{ label: "Cancel" }}
        said={{ line: "Saved on this device." }}
      />,
      "Saved on this device.",
      false,
    ],
    [
      "the opening's line",
      <Opening
        kind="phone"
        status={{ label: "Updating the mail store", count: "3 of 12", note: "This can take a minute." }}
      />,
      "Updating the mail store 3 of 12 This can take a minute.",
      true,
    ],
  ];

  it.each(regions)(
    "%s: its words are drawn at once and kept from a screen reader until the region stands, then given; its controls are there throughout",
    async (_name, region, words, server) => {
      const controls = () => screen.queryAllByRole("button").length;
      render(region);
      const status = screen.getByRole("status");
      const there = controls();
      expect(heard(status)).toBe("");
      /* Drawn all the same: every word of it is on the page. */
      expect(words.split(" ").every((word) => status.textContent?.includes(word))).toBe(true);
      await waitFor(() => expect(heard(status)).toBe(words));
      expect(controls()).toBe(there);
      if (!server) return;
      /* Drawn by a server the words are the reader's from the start: nothing would give them back without script. */
      const page = document.createElement("div");
      page.innerHTML = renderToStaticMarkup(region);
      expect(heard(page.querySelector('[role="status"]')!)).toBe(words);
    },
  );

  it("other words while a report stands are a change of the region itself: nothing is held back", async () => {
    const { rerender } = render(<Report>Moved to News</Report>);
    const status = screen.getByRole("status");
    await waitFor(() => expect(heard(status)).toBe("Moved to News"));
    rerender(<Report>Moved to Receipts</Report>);
    expect(heard(status)).toBe("Moved to Receipts");
  });
});

describe("Notice", () => {
  it("is a status with its title, its line and up to two answers", () => {
    const go = vi.fn();
    const later = vi.fn();
    render(
      <Notice
        place="rail"
        title="The mailbox is full"
        hot
        line="Sent copies wait."
        acts={[
          { label: "Mailboxes", onPress: go },
          { label: "Not now", onPress: later },
        ]}
      />,
    );
    const notice = screen.getByRole("status");
    expect(notice.textContent).toContain("The mailbox is full Sent copies wait.");
    fireEvent.click(within(notice).getByRole("button", { name: "Mailboxes" }));
    fireEvent.click(within(notice).getByRole("button", { name: "Not now" }));
    expect([go.mock.calls.length, later.mock.calls.length]).toEqual([1, 1]);
  });

  it("stands calm, with no button, where nothing can be done", () => {
    render(<Notice place="bar" title="New mail is late" line="Not checked since 09:14." />);
    expect(within(screen.getByRole("status")).queryAllByRole("button")).toEqual([]);
  });

  it("a pressed answer that is under way stays where it is: off to a second press, said busy, the keys still on it", () => {
    const pressed: string[] = [];
    function Held() {
      const [releasing, setReleasing] = useState(false);
      return (
        <Notice
          place="rail"
          title="3 letters are held"
          hot
          acts={[
            {
              label: "Release",
              busy: releasing,
              onPress: () => {
                pressed.push("release");
                setReleasing(true);
              },
            },
            { label: "Not now", disabled: releasing, onPress: () => pressed.push("later") },
          ]}
        />
      );
    }
    render(<Held />);
    const release = screen.getByRole("button", { name: "Release" });
    expect([release.getAttribute("aria-busy"), release.getAttribute("aria-disabled")]).toEqual([null, null]);
    release.focus();
    fireEvent.click(release);
    /* The same button stands, and the keys never left it: a button the browser itself turns off can drop them. */
    expect(screen.getByRole("button", { name: "Release" })).toBe(release);
    expect(document.activeElement).toBe(release);
    expect((release as HTMLButtonElement).disabled).toBe(false);
    expect([release.getAttribute("aria-busy"), release.getAttribute("aria-disabled")]).toEqual([
      "true",
      "true",
    ]);
    fireEvent.click(release);
    expect(pressed).toEqual(["release"]);
    /* The other answer is off while the first is under way. */
    const later = screen.getByRole("button", { name: "Not now" }) as HTMLButtonElement;
    expect(later.disabled).toBe(true);
    fireEvent.click(later);
    expect(pressed).toEqual(["release"]);
  });
});

const NOTICES: SlotNotice[] = [
  { id: "trial", rank: 72, title: "Trial ends Wed" },
  { id: "storage", rank: 62, title: "Storage 92% full", hot: true },
  { id: "offline", rank: 10, title: "Offline since 09:24" },
];
function Slot({ notices = NOTICES }: { notices?: SlotNotice[] }) {
  const [front, setFront] = useState<string>();
  const [open, setOpen] = useState(false);
  return (
    <NoticeSlot
      place="rail"
      notices={notices}
      front={front}
      onFront={setFront}
      open={open}
      onOpen={setOpen}
      more={{ label: `${notices.length - 1} more`, name: `${notices.length - 1} more notices` }}
    />
  );
}

describe("NoticeSlot", () => {
  it("orders by rank, then as they came, with the one brought to the front first", () => {
    expect(slotOrder(NOTICES).map((n) => n.id)).toEqual(["offline", "storage", "trial"]);
    expect(slotOrder(NOTICES, "trial").map((n) => n.id)).toEqual(["trial", "offline", "storage"]);
    expect(slotOrder(NOTICES, "gone").map((n) => n.id)).toEqual(["offline", "storage", "trial"]);
  });

  it("shows the first in full and the others behind one line", () => {
    render(<Slot />);
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.getByRole("status").textContent).toContain("Offline since 09:24");
    const line = screen.getByRole("button", { name: "2 more notices" });
    expect(line.getAttribute("aria-expanded")).toBe("false");
    expect(line.textContent).toBe("2 more");
  });

  it("the line lists the others, and a press on one brings it to the front", () => {
    render(<Slot />);
    fireEvent.click(screen.getByRole("button", { name: "2 more notices" }));
    expect(screen.getAllByRole("menuitem").map((i) => i.textContent)).toEqual([
      "Storage 92% full",
      "Trial ends Wed",
    ]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Trial ends Wed" }));
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.getByRole("status").textContent).toContain("Trial ends Wed");
  });

  it("a notice already said stays the region it was when a second one joins it behind the line, or leaves: it is not said again", async () => {
    const [behind, , first] = NOTICES as [SlotNotice, SlotNotice, SlotNotice];
    const { rerender } = render(<Slot notices={[first]} />);
    const status = screen.getByRole("status");
    await waitFor(() => expect(heard(status)).toBe("Offline since 09:24"));
    const frames = () => new Promise((done) => setTimeout(done, 80));
    rerender(<Slot notices={[first, behind]} />);
    expect(screen.getByRole("status")).toBe(status);
    expect(heard(status)).toBe("Offline since 09:24");
    await frames();
    expect(heard(status)).toBe("Offline since 09:24");
    rerender(<Slot notices={[first]} />);
    expect(screen.getByRole("status")).toBe(status);
    expect(heard(status)).toBe("Offline since 09:24");
    await frames();
    expect(heard(status)).toBe("Offline since 09:24");
  });

  it("one notice stands alone, and none draws nothing", () => {
    const { rerender, container } = render(<Slot notices={NOTICES.slice(0, 1)} />);
    expect(screen.queryByRole("button")).toBeNull();
    rerender(<Slot notices={[]} />);
    expect(container.textContent).toBe("");
  });
});

describe("Report", () => {
  it("lets the full stop land as the report arrives, unless motion is reduced", () => {
    const style = document.createElement("style");
    style.textContent =
      ".oh-report, .oh-dot { --d-in: 220ms; --e-drop: linear; --x-drop: translateY(-1em); --x-drop-land: translateY(0); }";
    document.head.append(style);
    const original = Element.prototype.animate;
    const animated: Element[] = [];
    Element.prototype.animate = function () {
      animated.push(this);
      return { cancel() {}, addEventListener() {} } as unknown as Animation;
    };
    try {
      const first = render(<Report>Moved</Report>);
      const dot = first.getByRole("status").querySelector("i")!;
      expect(animated).toContain(dot);
      first.unmount();
      animated.length = 0;
      document.documentElement.dataset.rm = "1";
      const second = render(<Report>Moved</Report>);
      expect(animated).not.toContain(second.getByRole("status").querySelector("i"));
    } finally {
      delete document.documentElement.dataset.rm;
      Element.prototype.animate = original;
      style.remove();
    }
  });

  it("is a status with the one way back", () => {
    const undo = vi.fn();
    render(<Report undo={{ label: "Undo", keyHint: "z", onPress: undo }}>Parked</Report>);
    expect(screen.getByRole("status").textContent).toBe("ParkedUndoz");
    fireEvent.click(screen.getByRole("button", { name: /Undo/ }));
    expect(undo).toHaveBeenCalledTimes(1);
  });

  it("has no button where there is no way back", () => {
    render(<Report>Sent</Report>);
    expect(within(screen.getByRole("status")).queryAllByRole("button")).toEqual([]);
  });

  it("with a sentence it says why, and offers the one place to go, never Undo", () => {
    const go = vi.fn();
    render(
      <Report
        kind="why"
        why="This ohmail does not organize this mailbox."
        act={{ label: "Mailboxes", onPress: go }}
      >
        Nothing changed
      </Report>,
    );
    expect(screen.getByRole("status").textContent).toContain(
      "Nothing changed This ohmail does not organize this mailbox.",
    );
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["Mailboxes"]);
  });

  it("says once that it is gone when it leaves", () => {
    const onGone = vi.fn();
    Element.prototype.animate ??= () => ({ cancel() {} }) as unknown as Animation;
    const { rerender } = render(<Report onGone={onGone}>Parked</Report>);
    expect(onGone).not.toHaveBeenCalled();
    rerender(
      <Report leaving onGone={onGone}>
        Parked
      </Report>,
    );
    expect(onGone).toHaveBeenCalledTimes(1);
  });

  it("takes a press on its way back while it fades, and says that it is gone only when the fade's time has run", () => {
    /* A fade with a length where no sheet is loaded: its time, and an animation that ends by the case's clock. */
    const fade = document.createElement("style");
    fade.textContent = ".oh-report{--d-hush:700ms}";
    document.head.append(fade);
    const browsers = Element.prototype.animate;
    Element.prototype.animate = function (_frames, timing) {
      let end: ReturnType<typeof setTimeout> | undefined;
      return {
        cancel: () => clearTimeout(end),
        addEventListener: (_event: string, done: () => void) => {
          end = setTimeout(done, (timing as KeyframeAnimationOptions).duration as number);
        },
      } as unknown as Animation;
    };
    vi.useFakeTimers();
    try {
      const [undo, onGone] = [vi.fn(), vi.fn()];
      const way = { label: "Undo", onPress: undo };
      const { rerender } = render(<Report undo={way}>Moved</Report>);
      rerender(
        <Report leaving onGone={onGone} undo={way}>
          Moved
        </Report>,
      );
      vi.advanceTimersByTime(100);
      expect(onGone).not.toHaveBeenCalled();
      const back = screen.getByRole("button", { name: "Undo" });
      expect(back.closest("[data-leaving]")).toBe(screen.getByRole("status"));
      fireEvent.click(back);
      expect(undo).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(600);
      expect(onGone).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
      Element.prototype.animate = browsers;
      fade.remove();
    }
  });
});

describe("Empty, WaitRow, RefusalLine", () => {
  it("an empty place says so once, with at most one button", () => {
    const write = vi.fn();
    render(<Empty label="No drafts" act={{ label: "Write", icon: "write", onPress: write }} />);
    expect(screen.getByText("drafts")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Write" }));
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("an empty place's way on can be an address: a link to it, named once by its word", () => {
    render(<Empty label="No mail yet" act={{ label: "Connect", icon: "plus", href: "/join" }} />);
    const way = screen.getByRole("link", { name: "Connect" });
    expect(way.tagName).toBe("A");
    expect(way.getAttribute("href")).toBe("/join");
    expect(way.hasAttribute("aria-label")).toBe(false);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("an empty place's way on with a press is a button, as before, and never both", () => {
    const write = vi.fn();
    render(<Empty label="No drafts" act={{ label: "Write", onPress: write }} />);
    const way = screen.getByRole("button", { name: "Write" });
    expect([way.tagName, way.hasAttribute("href")]).toEqual(["BUTTON", false]);
    expect(screen.queryByRole("link")).toBeNull();
    // @ts-expect-error a way on either runs or goes somewhere, never both
    render(<Empty label="No mail" act={{ label: "Connect", href: "/join", onPress: write }} />);
    // @ts-expect-error a way on does one of the two
    render(<Empty label="No mail" act={{ label: "Connect" }} />);
  });

  it("the mark is named as the product's name with its full stop", () => {
    render(<Empty mark="oh" label="6 decided" />);
    expect(screen.getByLabelText("oh.")).toBeTruthy();
  });

  it("an empty place draws the kit's one mark: the same node a page's mark is, hot while something waits", () => {
    const { container } = render(<Empty mark="oh" hot label="6 waiting" />);
    const inPlace = screen.getByLabelText("oh.");
    const dot = inPlace.querySelector("i");
    const drawn = [inPlace.tagName, inPlace.className, dot?.className, dot?.getAttribute("data-kind")];
    cleanup();
    render(<Mark hot>oh</Mark>);
    const alone = screen.getByLabelText("oh.");
    const stop = alone.querySelector("i");
    expect(drawn).toEqual([alone.tagName, alone.className, stop?.className, stop?.getAttribute("data-kind")]);
    expect(container.isConnected).toBe(false);
  });

  it("an empty place's one answer carries the key that runs it beside its word, where the place hands one", () => {
    const go = vi.fn();
    render(
      <Empty
        mark="oh"
        label="6 decided"
        act={{ label: "Ohbox", kind: "ink", keyHint: "g o", onPress: go }}
      />,
    );
    const way = screen.getByRole("button");
    expect(screen.getByRole("button", { name: "Ohbox" })).toBe(way);
    expect(within(way).getByText("g o").tagName).toBe("KBD");
    expect(way.textContent).toBe("Ohboxg o");
    fireEvent.click(way);
    expect(go).toHaveBeenCalledTimes(1);
    /* A way on that goes to an address carries its key the same way. */
    cleanup();
    render(<Empty label="No mail yet" act={{ label: "Connect", keyHint: "c", href: "/join" }} />);
    expect(screen.getByRole("link").textContent).toBe("Connectc");
    expect(screen.getByRole("link", { name: "Connect" })).toBeTruthy();
  });

  it("a waiting row is a list item with what, about which letter, why and its own answers", () => {
    const again = vi.fn();
    render(
      <div role="list">
        <WaitRow
          what="Filing a message"
          about="Hostwerk · Domain renewal"
          why="The folder is not there."
          refused
          acts={[
            { label: "Try again", onPress: again },
            { label: "Discard", onPress: () => {} },
          ]}
        />
      </div>,
    );
    const row = screen.getByRole("listitem");
    expect(row.textContent).toContain("Filing a messageHostwerk · Domain renewalThe folder is not there.");
    fireEvent.click(within(row).getByRole("button", { name: "Try again" }));
    expect(again).toHaveBeenCalledTimes(1);
  });

  it("a refusal that answers a press is said at once and can be handed the keys; one that reports stays a status", () => {
    const at: { current: HTMLParagraphElement | null } = { current: null };
    render(
      <>
        <RefusalLine alert ref={at}>
          The mail server refused this password.
        </RefusalLine>
        <RefusalLine>No AI credits left.</RefusalLine>
      </>,
    );
    const answered = screen.getByRole("alert");
    expect(answered.textContent).toBe("The mail server refused this password.");
    expect(at.current).toBe(answered);
    /* The form puts the keys on it at the press: it can hold them, and Tab never stops on it by itself. */
    answered.focus();
    expect(document.activeElement).toBe(answered);
    expect(answered.tabIndex).toBe(-1);
    const reported = screen.getByRole("status");
    expect(reported.textContent).toBe("No AI credits left.");
    expect(reported.hasAttribute("tabindex")).toBe(false);
  });

  it("a refusal line is a status with the one way on", () => {
    const plans = vi.fn();
    render(<RefusalLine way={{ label: "Plans", onPress: plans }}>No AI credits left.</RefusalLine>);
    expect(screen.getByRole("status").textContent).toBe("No AI credits left.Plans");
    fireEvent.click(screen.getByRole("button", { name: "Plans" }));
    expect(plans).toHaveBeenCalledTimes(1);
  });
});

describe("Page and Opening", () => {
  it("a page is the main part: its sentence, a refusal said at once, the line and the buttons", () => {
    render(
      <Page
        refusal={["This link has expired."]}
        line="It is the password you chose."
        note="Nothing is sent."
        acts={<Button size="l">Sign in</Button>}
      >
        <Sentence size="xl" level={1}>
          Confirm my email address
        </Sentence>
      </Page>,
    );
    const page = screen.getByRole("main");
    expect(within(page).getByRole("heading", { level: 1, name: "Confirm my email address" })).toBeTruthy();
    expect(within(page).getByRole("alert").textContent).toBe("This link has expired.");
    expect(page.textContent).toContain("It is the password you chose.Nothing is sent.");
    expect(within(page).getByRole("button", { name: "Sign in" })).toBeTruthy();
  });

  it("draws a note that stands without a heavy line over it: what explains is never left out unsaid", () => {
    render(
      <Page note="Nothing is sent." acts={<Button size="l">Go on</Button>}>
        <Sentence size="xl" level={1}>
          Confirm my email address
        </Sentence>
      </Page>,
    );
    const page = screen.getByRole("main");
    expect(within(page).getByText("Nothing is sent.")).toBeTruthy();
    /* It stands between the sentence and the buttons, where the line it would explain stands. */
    const [said, note, act] = [
      within(page).getByRole("heading"),
      within(page).getByText("Nothing is sent."),
      within(page).getByRole("button", { name: "Go on" }),
    ];
    expect(said.compareDocumentPosition(note) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(note.compareDocumentPosition(act) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("a page of two columns whose sentence column is taller than its body says it folded; one that fits says nothing", () => {
    /* jsdom lays nothing out: the body's two columns and its heights are what a browser would answer. */
    let tall = true;
    const watched = new Set<() => void>();
    const heights = vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function (
      this: HTMLElement,
    ) {
      return this.classList.contains("oh-page-body") && tall ? 900 : 600;
    });
    const room = vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
    const style = window.getComputedStyle;
    const columns = vi.spyOn(window, "getComputedStyle").mockImplementation((el, at) => {
      const seen = style(el, at);
      if (!(el as HTMLElement).classList?.contains("oh-page-body")) return seen;
      return new Proxy(seen, {
        get: (on, key) => (key === "gridTemplateColumns" ? "344px 520px" : Reflect.get(on, key)),
      });
    });
    vi.stubGlobal(
      "ResizeObserver",
      class {
        private readonly tell: () => void;
        constructor(told: () => void) {
          this.tell = () => told();
          watched.add(this.tell);
        }
        observe() {}
        disconnect() {
          watched.delete(this.tell);
        }
      },
    );
    try {
      const page = (columns: 1 | 2) => (
        <Page columns={columns} material={<p>Plans</p>} acts={<Button size="l">Subscribe</Button>}>
          <Sentence size="xl" level={1}>
            Your trial has ended
          </Sentence>
        </Page>
      );
      const { rerender, container } = render(page(2));
      const main = screen.getByRole("main");
      expect(main.hasAttribute("data-folded")).toBe(true);
      tall = false;
      for (const told of watched) told();
      expect(main.hasAttribute("data-folded")).toBe(false);
      expect(container.innerHTML).not.toContain("data-folded");
      tall = true;
      rerender(page(1));
      for (const told of watched) told();
      expect(screen.getByRole("main").hasAttribute("data-folded")).toBe(false);
    } finally {
      heights.mockRestore();
      room.mockRestore();
      columns.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it("the opening shapes say nothing until the wait has lasted, then one status line", () => {
    const { rerender } = render(<Opening kind="window" />);
    expect(screen.queryByRole("status")).toBeNull();
    rerender(<Opening kind="phone" status={{ label: "Updating the mail store", count: "3 of 12" }} />);
    expect(screen.getByRole("status").textContent).toBe("Updating the mail store3 of 12");
  });
});

describe("Counters", () => {
  it("is a list of figures, each a numeral said with its words, which end in the dot: hot until it settles", () => {
    const { container } = render(
      <Counters
        size="xl"
        rows={[
          { id: "screened", figure: "1,204", words: "screened", end: "hot" },
          { id: "history", figure: "380", words: "in History", end: "ink" },
        ]}
      />,
    );
    const figures = [...container.querySelectorAll("dt")].map((dt) => dt.textContent);
    const words = [...container.querySelectorAll("dd")].map((dd) => dd.textContent);
    expect(figures).toEqual(["1,204", "380"]);
    expect(words).toEqual(["screened", "in History"]);
    /* A figure can be found by the id it was handed. The id is an anchor: a count rises by the figure handed next. */
    expect(container.querySelector("#screened")?.textContent).toBe("1,204");
    /* Each line ends in its own dot, and the last word never parts from it. */
    const dots = [...container.querySelectorAll("dd [aria-hidden='true']")];
    expect(dots).toHaveLength(2);
    expect(dots.map((dot) => dot.getAttribute("data-kind"))).toEqual(["hot", "ink"]);
  });

  it("counts up by the figure it is handed next, in the numeral that stood there", () => {
    const row = { id: "screened", words: "screened", end: "hot" as const };
    const { container, rerender } = render(<Counters rows={[{ ...row, figure: "1,204" }]} />);
    const numeral = container.querySelector("#screened");
    rerender(<Counters rows={[{ ...row, figure: "1,205" }]} />);
    expect(container.querySelector("#screened")).toBe(numeral);
    expect(numeral?.textContent).toBe("1,205");
  });

  it("holds nothing where there is nothing to count", () => {
    const { container } = render(<Counters rows={[]} />);
    expect(container.querySelector("dl")).toBeNull();
  });
});

describe("CameraSquare", () => {
  it("is a picture named by its label, and hands its own box to whoever stands the camera in it", () => {
    const box = createRef<HTMLDivElement>();
    render(<CameraSquare state="live" label="Camera" boxRef={box} />);
    const square = screen.getByRole("img", { name: "Camera" });
    expect(box.current).toBe(square);
    /* Its corners and its dot are drawn and never said; it holds no word and nothing the keys could reach. */
    expect(square.textContent).toBe("");
    expect([...square.children].every((mark) => mark.getAttribute("aria-hidden") === "true")).toBe(true);
    expect(square.querySelector("button, a, input, [tabindex]")).toBeNull();
    expect(square.hasAttribute("tabindex")).toBe(false);
  });

  it("draws four corners in either state, and the hot dot only while the camera looks", () => {
    const { rerender } = render(<CameraSquare state="live" label="Camera" />);
    const marks = () => [...screen.getByRole("img").children].map((mark) => mark.getAttribute("data-kind"));
    expect(marks()).toEqual([null, null, null, null, "hot"]);
    rerender(<CameraSquare state="off" label="Camera off" />);
    expect(screen.getByRole("img", { name: "Camera off" })).toBeTruthy();
    expect(marks()).toEqual([null, null, null, null]);
  });

  it("keeps its box when its state changes: the camera's place does not move under it", () => {
    const box = createRef<HTMLDivElement>();
    const { rerender } = render(<CameraSquare state="off" label="Camera off" boxRef={box} />);
    const was = box.current;
    rerender(<CameraSquare state="live" label="Camera" boxRef={box} />);
    expect(box.current).toBe(was);
  });
});

describe("StepDots", () => {
  it("is one mark that says how far a walk is, a dot a phase; the numeral beside it is drawn and not said twice", () => {
    render(<StepDots label="Step 2 of 5, Mailbox, 2 of 3" steps={5} at={1} sub="2/3" />);
    const mark = screen.getByRole("img", { name: "Step 2 of 5, Mailbox, 2 of 3" });
    expect(mark.children).toHaveLength(5);
    const numeral = screen.getByText("2/3");
    expect(numeral.closest("[aria-hidden='true']")).not.toBeNull();
    expect(mark.contains(numeral)).toBe(false);
  });

  it("draws no numeral where the phase is one screen", () => {
    const { container } = render(<StepDots label="Step 1 of 3, Account" steps={3} at={0} />);
    expect(container.textContent).toBe("");
    expect(screen.getByRole("img", { name: "Step 1 of 3, Account" }).children).toHaveLength(3);
  });
});

describe("RowsShape", () => {
  it("stands as many rows as asked, holds no word and is nothing to a screen reader", () => {
    const { container, rerender } = render(<RowsShape rows={3} />);
    const shape = container.firstElementChild!;
    expect(shape.getAttribute("aria-hidden")).toBe("true");
    expect(shape.children).toHaveLength(3);
    expect(shape.textContent).toBe("");
    rerender(<RowsShape rows={14} />);
    expect(container.firstElementChild!.children).toHaveLength(14);
    rerender(<RowsShape />);
    expect(container.firstElementChild!.children).toHaveLength(9);
  });
});
