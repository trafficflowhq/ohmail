/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AgendaRow } from "@ohmail/ui/calendar";

afterEach(cleanup);

describe("the agenda row", () => {
  it("is a button that opens its event, and says whether the event stands open", () => {
    const onOpen = vi.fn();
    const { rerender } = render(
      <AgendaRow
        mark={{ kind: "calendar", tone: 243 }}
        title="Lunch with Anna"
        time="12:15–13:15"
        second="Gartenlokal Rosa"
        onOpen={onOpen}
      />,
    );
    const row = screen.getByRole("button", { name: /Lunch with Anna/ });
    expect(row.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(row);
    expect(onOpen).toHaveBeenCalledTimes(1);
    rerender(
      <AgendaRow
        mark={{ kind: "calendar", tone: 243 }}
        title="Lunch with Anna"
        time="12:15–13:15"
        second="Gartenlokal Rosa"
        open
        onOpen={onOpen}
      />,
    );
    expect(row.getAttribute("aria-expanded")).toBe("true");
  });

  it("reads its time as a time and its place under the title", () => {
    render(
      <AgendaRow
        mark={{ kind: "calendar", tone: 243 }}
        title="Invoices, new template"
        time="until 10:00"
        second="Studio"
        now
      />,
    );
    expect(screen.getByText("until 10:00").tagName).toBe("TIME");
    expect(screen.queryByText("Studio")).not.toBeNull();
  });

  it("opens by Enter and by Space where it carries controls of its own, and those keep their own press", () => {
    const onOpen = vi.fn(),
      add = vi.fn();
    render(
      <AgendaRow
        mark={{ kind: "found" }}
        title="Winternacht"
        time="19:30"
        second="From mail"
        onOpen={onOpen}
        tail={
          <button type="button" onClick={add}>
            Add
          </button>
        }
      />,
    );
    const row = screen.getByRole("button", { name: /Winternacht/ });
    fireEvent.keyDown(row, { key: "Enter" });
    fireEvent.keyDown(row, { key: " " });
    expect(onOpen).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(add).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledTimes(2);
  });

  it("takes its name from the app where the drawing alone says the state", () => {
    render(
      <AgendaRow
        mark={{ kind: "outlined" }}
        title="Tech check, main hall"
        time="16:00–17:00"
        waits
        label="Tech check, main hall, to answer"
      />,
    );
    expect(screen.getByRole("button", { name: "Tech check, main hall, to answer" })).toBeTruthy();
  });

  it("is no button while it is what the typing line makes", () => {
    render(
      <AgendaRow
        mark={{ kind: "draft", tone: 243 }}
        title="Lunch with Ben"
        time="13:00–14:00"
        second="Mila"
        draft
      />,
    );
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByText("Lunch with Ben")).not.toBeNull();
  });
});
