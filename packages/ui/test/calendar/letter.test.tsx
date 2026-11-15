/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { AnswerSwitch, FoundEventRow, InvitationCard, TodayList } from "@ohmail/ui/calendar";

afterEach(cleanup);

const THREE = [
  { value: "yes", label: "Yes" },
  { value: "maybe", label: "Maybe" },
  { value: "no", label: "No" },
] as const;

describe("the invitation card in a letter", () => {
  it("says its kind, its title as a heading, the time and what stands around it", () => {
    render(
      <InvitationCard
        kind="New time proposed"
        title="Glaze evening, planning call"
        when="Thu 12 Nov, 15:00–15:30"
        was="10:00–10:30"
        lines={["Phone", "Yours · Nadja Lehner proposes"]}
        around={[
          { tone: 243, text: "10:00–10:30 Dentist", tag: "overlaps" },
          { text: "15:00–15:30", tag: "free" },
        ]}
      />,
    );
    expect(screen.getByRole("heading", { name: "Glaze evening, planning call" })).toBeTruthy();
    expect(screen.queryByText("New time proposed")).not.toBeNull();
    expect(screen.getByText("10:00–10:30").tagName).toBe("S");
    expect(screen.queryByText("Yours · Nadja Lehner proposes")).not.toBeNull();
    expect(screen.queryByText("overlaps")).not.toBeNull();
    expect(screen.queryByText("free")).not.toBeNull();
  });

  it("is answered where it is read: one group named for the answer, each part saying whether it is the given one", () => {
    const onChange = vi.fn();
    render(
      <InvitationCard
        kind="Invitation"
        title="Tech check, main hall"
        when="Fri 20 Nov, 16:00–16:15"
        answers={
          <AnswerSwitch label="Answer" on="sheet" answers={{ options: THREE, value: "yes", onChange }} />
        }
      />,
    );
    const answer = screen.getByRole("group", { name: "Answer" });
    expect(
      within(answer)
        .getAllByRole("button")
        .map((b) => b.getAttribute("aria-pressed")),
    ).toEqual(["true", "false", "false"]);
    fireEvent.click(within(answer).getByRole("button", { name: "No" }));
    expect(onChange).toHaveBeenCalledWith("no");
  });

  it("draws the answers closer while they are wider than the card, and wide where they fit", () => {
    /* The card's line is 219 px wide (the unfolded phone's letter); the wide track needs 247. */
    const wide = vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(function (
      this: HTMLElement,
    ) {
      const step = { wide: 247, tight: 231, tighter: 215 }[this.dataset.fit ?? "wide"] ?? 0;
      return this.getAttribute("role") === "group" || this.dataset.fit ? step : 0;
    });
    const room = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(219);
    try {
      const proposed = [
        { value: "accept", label: "Accept 15:00" },
        { value: "keep", label: "Keep 10:00" },
      ];
      const { container, rerender } = render(
        <AnswerSwitch label="Answer" on="sheet" answers={{ options: proposed, value: null }} />,
      );
      const track = () => container.querySelector<HTMLElement>("[data-fit]")!;
      expect(track().dataset.fit).toBe("tighter");
      room.mockReturnValue(400);
      rerender(
        <AnswerSwitch label="Answer" on="sheet" fit="wide" answers={{ options: proposed, value: null }} />,
      );
      expect(track().dataset.fit).toBe("wide");
    } finally {
      wide.mockRestore();
      room.mockRestore();
    }
  });

  it("carries where it goes and the way to the calendar only when it is handed them", () => {
    const show = vi.fn();
    const { rerender } = render(
      <InvitationCard
        kind="Invitation"
        title="Tech check"
        when="16:00"
        goes={<>Tech check goes to Mila</>}
        show={{ label: "Show in calendar", onPress: show }}
      />,
    );
    expect(screen.queryByText("Tech check goes to Mila")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show in calendar" }));
    expect(show).toHaveBeenCalledTimes(1);
    rerender(<InvitationCard kind="Invitation" title="Tech check" when="16:00" />);
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("an event found in a letter", () => {
  it("is offered once: Add and the dismiss, and nothing is added without a press", () => {
    const add = vi.fn(),
      dismiss = vi.fn();
    render(
      <FoundEventRow
        when="Sat 21 Nov, 11:00"
        title="Wabi-sabi for web people"
        second="Makersfest, main hall"
        tag="a guess"
        add={{ label: "Add", onPress: add }}
        dismiss={{ label: "Dismiss", onPress: dismiss }}
      />,
    );
    expect(screen.queryByText("a guess")).not.toBeNull();
    expect(add).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect([add, dismiss].map((f) => f.mock.calls.length)).toEqual([1, 1]);
  });

  it("added, it leads to the calendar and offers nothing else", () => {
    const show = vi.fn();
    render(
      <FoundEventRow
        when="Mon 9 Nov, 15:00"
        title="Menu cards to Gartenlokal Rosa"
        second="On your calendar"
        on={{ tone: 243, show: { label: "Show in calendar", onPress: show } }}
      />,
    );
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["Show in calendar"]);
    fireEvent.click(screen.getByRole("button", { name: "Show in calendar" }));
    expect(show).toHaveBeenCalledTimes(1);
  });
});

describe("the calendar's rows in mail", () => {
  it("Today is a headed list of the rest of the day; a press opens the event's day, and what does not fit is counted", () => {
    const open = vi.fn();
    render(
      <TodayList
        kind="today"
        label="Today"
        heading={{ title: "Today", date: "Tue 10 Nov" }}
        rows={[
          {
            id: "a",
            mark: { kind: "calendar", tone: 243 },
            time: "now",
            title: "Invoices, new template",
            now: true,
            onPress: open,
          },
          { id: "b", mark: { kind: "calendar", tone: 288 }, time: "14:00", title: "Catalogue weekly" },
        ]}
        more="+2"
      />,
    );
    expect(screen.getByRole("heading", { name: /Today/ })).toBeTruthy();
    const rows = screen.getAllByRole("button");
    expect(rows.map((r) => r.textContent)).toEqual(["nowInvoices, new template", "14:00Catalogue weekly"]);
    fireEvent.click(rows[0]!);
    expect(open).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("+2")).not.toBeNull();
  });

  it("Coming up names its list and tags what waits", () => {
    render(
      <TodayList
        kind="coming"
        label="Coming up"
        rows={[
          {
            id: "a",
            mark: { kind: "outlined" },
            time: "Fri 20 Nov, 16:00",
            title: "Tech check, main hall",
            tag: { text: "to answer", hot: true },
          },
          {
            id: "b",
            mark: { kind: "found" },
            time: "Sat 21 Nov, 11:00",
            title: "Wabi-sabi for web people",
            tag: { text: "from mail" },
          },
        ]}
      />,
    );
    const list = screen.getByRole("group", { name: "Coming up" });
    expect(within(list).getAllByRole("button")).toHaveLength(2);
    expect(within(list).queryByText("to answer")).not.toBeNull();
  });
});
