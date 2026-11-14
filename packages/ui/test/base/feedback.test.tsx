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
  Page,
  RefusalLine,
  Report,
  Sentence,
  slotOrder,
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

  it("the opening shapes say nothing until the wait has lasted, then one status line", () => {
    const { rerender } = render(<Opening kind="window" />);
    expect(screen.queryByRole("status")).toBeNull();
    rerender(<Opening kind="phone" status={{ label: "Updating the mail store", count: "3 of 12" }} />);
    expect(screen.getByRole("status").textContent).toBe("Updating the mail store3 of 12");
  });
});
