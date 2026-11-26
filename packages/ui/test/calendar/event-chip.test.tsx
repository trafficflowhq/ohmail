/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { blockLayout, CalendarSquare, EventChip } from "@ohmail/ui/calendar";

afterEach(cleanup);

const place = { top: 0, height: 58 };

describe("the event chip", () => {
  it("is a button named by its title, and a press reaches the app", () => {
    const onPress = vi.fn();
    render(
      <EventChip
        size="block"
        tone={243}
        title="Lunch with Anna"
        second="Gartenlokal Rosa"
        place={place}
        onPress={onPress}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Lunch with Anna/ }));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it("says that it opens a card, and whether the card stands open", () => {
    const { rerender } = render(<EventChip size="line" tone={243} title="Poster review" time="14:30" />);
    const chip = screen.getByRole("button", { name: /Poster review/ });
    expect(chip.getAttribute("aria-haspopup")).toBe("dialog");
    expect(chip.getAttribute("aria-expanded")).toBe("false");
    rerender(<EventChip size="line" tone={243} title="Poster review" time="14:30" open />);
    expect(chip.getAttribute("aria-expanded")).toBe("true");
  });

  it("takes its name from the app where the drawing alone says the state", () => {
    render(
      <EventChip
        size="pill"
        tone={null}
        title="Tech check"
        state="to-answer"
        waits
        label="Tech check, to answer"
      />,
    );
    expect(screen.getByRole("button", { name: "Tech check, to answer" })).toBeTruthy();
  });

  it("draws a block's second line only where the block has room for it", () => {
    const { rerender } = render(
      <EventChip size="block" tone={243} title="Studio Monday" second="Winterthur" place={place} />,
    );
    expect(screen.queryByText("Winterthur")).not.toBeNull();
    rerender(
      <EventChip
        size="block"
        tone={243}
        title="Studio Monday"
        second="Winterthur"
        place={{ top: 0, height: 30 }}
      />,
    );
    expect(screen.queryByText("Winterthur")).toBeNull();
  });

  it("refits a title at the same width when an RSVP changes its font weight", () => {
    const fakeCanvas = {
      font: "",
      measureText: vi.fn(function (this: { font: string }, value: string) {
        return { width: value.startsWith("Exhibition") ? (this.font.startsWith("400") ? 57 : 58) : 10 };
      }),
    };
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    const context = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(fakeCanvas as never);
    const computed = vi.spyOn(window, "getComputedStyle").mockImplementation(
      (element) =>
        ({
          width: "57.5px",
          fontWeight: element.closest('[data-state="maybe"]') ? "400" : "500",
          fontSize: "13px",
          fontFamily: "sans-serif",
          letterSpacing: "normal",
        }) as CSSStyleDeclaration,
    );
    const props = { size: "block", tone: null, title: "Exhibition", place } as const;
    try {
      const { container, rerender } = render(<EventChip {...props} state="maybe" />);
      const drawn = () => container.querySelector(".oh-ev-tt")?.textContent;
      expect(drawn()).toBe("Exhibition");
      rerender(<EventChip {...props} state="plain" />);
      expect(drawn()).toBe("Exhibitio…");
      rerender(<EventChip {...props} state="maybe" />);
      expect(drawn()).toBe("Exhibition");
    } finally {
      computed.mockRestore();
      context.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it("puts what the store says in the second line's place", () => {
    render(
      <EventChip
        size="block"
        tone={243}
        title="Pack the stand"
        second="Hall 2"
        status={{ text: "Not saved", failed: true }}
        place={place}
      />,
    );
    expect(screen.queryByText("Not saved")).not.toBeNull();
    expect(screen.queryByText("Hall 2")).toBeNull();
  });

  it("strikes the value a change replaced before the new one", () => {
    render(
      <EventChip size="block" tone={243} title="Catalogue shoot" was="11:00" second="10:30" place={place} />,
    );
    expect(screen.getByText("11:00").tagName).toBe("S");
  });

  it("gives a run across days no time", () => {
    const { rerender } = render(<EventChip size="line" tone={150} title="Makersfest" time="09:00" />);
    expect(screen.queryByText("09:00")).not.toBeNull();
    rerender(<EventChip size="line" tone={150} title="Makersfest" time="09:00" run />);
    expect(screen.queryByText("09:00")).toBeNull();
  });

  it("keeps the copy that follows a drag out of the keys and out of what is read", () => {
    render(
      <>
        <EventChip size="block" tone={243} title="Dentist" place={place} drag="lifted" />
        <EventChip
          size="block"
          tone={243}
          title="Dentist"
          second="Thu 12 Nov, 10:15"
          place={{ top: 18, height: 40 }}
          drag="copy"
        />
      </>,
    );
    expect(screen.getAllByRole("button", { name: /Dentist/ })).toHaveLength(1);
    const copy = screen
      .getAllByRole("button", { hidden: true })
      .find((b) => b.getAttribute("aria-hidden") === "true");
    expect(copy?.tabIndex).toBe(-1);
  });
});

describe("where a block stands", () => {
  it("is never drawn under the shortest height and leaves 2 px to the next", () => {
    expect(blockLayout({ top: 0, height: 10 }, { hasSecond: false }).height).toBe(20);
    expect(blockLayout({ top: 0, height: 60 }, { hasSecond: false }).height).toBe(58);
  });

  it("sets titles at the small size side by side, and at the full size when one laps over the other", () => {
    expect(blockLayout({ top: 0, height: 60, column: 1, columns: 2 }, { hasSecond: false }).small).toBe(true);
    expect(
      blockLayout({ top: 0, height: 60, column: 1, columns: 2, lap: true }, { hasSecond: false }).small,
    ).toBe(false);
  });

  it("gives a second line only from two lines of room", () => {
    expect(blockLayout({ top: 0, height: 60 }, { hasSecond: true }).second).toBe(true);
    expect(blockLayout({ top: 0, height: 30 }, { hasSecond: true }).second).toBe(false);
    expect(blockLayout({ top: 0, height: 30 }, { hasSecond: true }).one).toBe(true);
  });
});

describe("the calendar's square", () => {
  it("is decoration: it is never read and never a control", () => {
    const { container } = render(<CalendarSquare tone={243} />);
    expect(container.firstElementChild?.getAttribute("aria-hidden")).toBe("true");
    expect(screen.queryByRole("button")).toBeNull();
  });
});
