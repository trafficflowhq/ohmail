/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { EventCard } from "@ohmail/ui/calendar";

/* jsdom has no pointer events: one that carries where the finger is, as a browser's does. */
if (typeof globalThis.PointerEvent !== "function") {
  globalThis.PointerEvent = class extends MouseEvent {} as unknown as typeof PointerEvent;
}

afterEach(cleanup);

const close = { label: "Close" };

describe("the event card", () => {
  it("is a dialog named with the event's title, with the title as its heading", () => {
    render(<EventCard title="Poster review" tone={153} when="Tue 10 Nov, 14:30–15:30" close={close} />);
    const card = screen.getByRole("dialog", { name: "Poster review" });
    expect(card.contains(screen.getByRole("heading", { name: "Poster review" }))).toBe(true);
    expect(card.getAttribute("aria-modal")).toBeNull();
  });

  it("closes by its close and by Esc from anywhere inside it", () => {
    const onPress = vi.fn();
    render(
      <EventCard
        title="Poster review"
        tone={153}
        when="14:30–15:30"
        close={{ label: "Close", onPress }}
        edit={{ label: "Edit" }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.keyDown(screen.getByRole("button", { name: "Edit" }), { key: "Escape" });
    expect(onPress).toHaveBeenCalledTimes(2);
  });

  it("offers Edit on an event of your own, and says why where there is nothing to edit", () => {
    const onPress = vi.fn();
    const { rerender } = render(
      <EventCard
        title="Lunch with Anna"
        tone={243}
        when="12:15–13:15"
        close={close}
        edit={{ label: "Edit", onPress }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(onPress).toHaveBeenCalledTimes(1);
    rerender(
      <EventCard
        title="Layout review"
        tone={288}
        when="10:00–11:00"
        close={close}
        why={{ text: "View only", locked: true }}
      />,
    );
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(screen.queryByText("View only")).not.toBeNull();
  });

  it("reads the time, the place and what it holds as a list of named rows", () => {
    render(
      <EventCard
        title="Catalogue shoot, day 1"
        tone={288}
        when="11:30–18:00"
        was="11:00"
        where={[{ text: "10:30–17:00 Porto" }, { text: "Vidralva, Porto", maps: { label: "Open in Maps" } }]}
        tags={[{ text: "was 11:00", hot: true }]}
        rows={[
          { label: "Calendar", tone: 288, text: "Vidralva" },
          { label: "Invitees", text: "3 people", note: "2 yes · 1 no answer" },
        ]}
        notes="Bring the grey backdrop."
        close={close}
      />,
    );
    expect(screen.getByText("11:00").tagName).toBe("S");
    expect(screen.getByRole("button", { name: "Open in Maps" })).toBeTruthy();
    expect(screen.getAllByRole("term").map((t) => t.textContent)).toEqual(["Calendar", "Invitees"]);
    expect(screen.getAllByRole("definition").map((d) => d.textContent)).toEqual([
      "Vidralva",
      "3 people2 yes · 1 no answer",
    ]);
    expect(screen.queryByText("Bring the grey backdrop.")).not.toBeNull();
    expect(screen.queryByText("was 11:00")).not.toBeNull();
  });

  it("carries the answers on the event itself", () => {
    render(
      <EventCard
        title="Tech check"
        tone={null}
        when="16:00–16:15"
        close={close}
        answers={<button type="button">Yes</button>}
      />,
    );
    expect(
      screen
        .getByRole("dialog", { name: "Tech check" })
        .contains(screen.getByRole("button", { name: "Yes" })),
    ).toBe(true);
  });
  it("a row's link, a call's Join and its copy control are buttons with their names", () => {
    const from = vi.fn(),
      join = vi.fn(),
      copy = vi.fn();
    render(
      <EventCard
        title="Catalogue weekly"
        tone={288}
        when="14:00–14:45"
        close={close}
        rows={[
          { label: "From", link: { label: "Inês Carvalho", onPress: from } },
          {
            label: "Call",
            call: {
              join: { label: "Join", onPress: join },
              address: "meet.vidralva.example/weekly",
              copy: { label: "Copy the address", onPress: copy },
            },
          },
          { label: "File", file: { name: "Shot-list-v4.pdf", size: "184 KB" } },
          { label: "Words", words: ["Saturday 14 November", "departs 08:02"] },
        ]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Inês Carvalho" }));
    fireEvent.click(screen.getByRole("button", { name: "Join" }));
    fireEvent.click(screen.getByRole("button", { name: "Copy the address" }));
    expect([from, join, copy].map((f) => f.mock.calls.length)).toEqual([1, 1, 1]);
    expect(screen.queryByText("meet.vidralva.example/weekly")).not.toBeNull();
    expect(screen.queryByText("184 KB")).not.toBeNull();
    expect(screen.getByText("departs 08:02").tagName).toBe("MARK");
  });

  it("as a sheet from the foot it closes when pulled down far enough, and stays when let go before", () => {
    const onPress = vi.fn();
    render(
      <EventCard
        frame="sheet"
        title="Poster review"
        tone={153}
        when="14:30–15:30"
        close={{ label: "Close", onPress }}
      />,
    );
    const sheet = screen.getByRole("dialog", { name: "Poster review" });
    fireEvent.pointerDown(sheet, { clientY: 300 });
    fireEvent.pointerMove(sheet, { clientY: 340 });
    fireEvent.pointerUp(sheet, { clientY: 340 });
    expect(onPress).not.toHaveBeenCalled();
    fireEvent.pointerDown(sheet, { clientY: 300 });
    fireEvent.pointerMove(sheet, { clientY: 390 });
    fireEvent.pointerUp(sheet, { clientY: 390 });
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it("as a sheet it leaves Edit to the verbs at its foot and still says why there is none", () => {
    const { rerender } = render(
      <EventCard
        frame="sheet"
        title="Lunch with Anna"
        tone={243}
        when="12:15–13:15"
        close={close}
        edit={{ label: "Edit" }}
        foot={<button type="button">Edit</button>}
      />,
    );
    expect(screen.getAllByRole("button", { name: "Edit" })).toHaveLength(1);
    rerender(
      <EventCard
        frame="sheet"
        title="Layout review"
        tone={288}
        when="10:00–11:00"
        close={close}
        why={{ text: "View only", locked: true }}
      />,
    );
    expect(screen.queryByText("View only")).not.toBeNull();
  });

  it("a card beside its event is not pulled", () => {
    const onPress = vi.fn();
    render(
      <EventCard title="Poster review" tone={153} when="14:30–15:30" close={{ label: "Close", onPress }} />,
    );
    const card = screen.getByRole("dialog", { name: "Poster review" });
    fireEvent.pointerDown(card, { clientY: 300 });
    fireEvent.pointerMove(card, { clientY: 420 });
    fireEvent.pointerUp(card, { clientY: 420 });
    expect(onPress).not.toHaveBeenCalled();
  });

  it("stands where the app put it, as wide as the app left it, and grows from the point it is given", () => {
    render(
      <EventCard
        title="Poster review"
        tone={153}
        when="14:30–15:30"
        close={close}
        side="l"
        style={{ left: 8, top: 159, width: 255.5 }}
        origin={{ x: 256, y: 201 }}
      />,
    );
    const card = screen.getByRole("dialog", { name: "Poster review" });
    expect(card.style.left).toBe("8px");
    expect(card.style.width).toBe("255.5px");
    expect(card.style.transformOrigin).toBe("256px 201px");
  });
});
