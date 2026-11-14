/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Button,
  Empty,
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

afterEach(cleanup);

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

  it("one notice stands alone, and none draws nothing", () => {
    const { rerender, container } = render(<Slot notices={NOTICES.slice(0, 1)} />);
    expect(screen.queryByRole("button")).toBeNull();
    rerender(<Slot notices={[]} />);
    expect(container.textContent).toBe("");
  });
});

describe("Report", () => {
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
