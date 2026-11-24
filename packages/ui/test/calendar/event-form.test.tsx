/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRef, useState } from "react";
import { SuggestionList, useSuggestions } from "@ohmail/ui/base";
import { EventForm, QuickAdd, type EventFormRow } from "@ohmail/ui/calendar";

afterEach(cleanup);

const when = (over: Partial<Record<"day" | "starts" | "allDay", () => void>> = {}): EventFormRow => ({
  id: "when",
  icon: "clock",
  items: [
    { kind: "slot", value: "Wed 11 Nov", label: "Day", onPress: over.day },
    { kind: "time", value: "13:00", label: "Starts", onChange: over.starts },
    { kind: "word", text: "to" },
    { kind: "time", value: "14:00", label: "Ends" },
    { kind: "switch", label: "All day", on: false, onChange: over.allDay },
  ],
});

describe("the event form", () => {
  it("lets its line of text offer while it is typed in: the field is the list's combobox, and its element is handed out", () => {
    const at = createRef<HTMLInputElement>();
    function Form() {
      const [place, setPlace] = useState("");
      const offers = useSuggestions({
        id: "place-list",
        text: place,
        onText: setPlace,
        own: (text) => [{ rows: text ? [{ id: "cameo", primary: "Kino Cameo" }] : [] }],
        free: true,
        onTake: (row) => setPlace(row.primary),
      });
      const row: EventFormRow = {
        id: "place",
        icon: "place",
        items: [
          {
            kind: "text",
            value: place,
            label: "Place",
            placeholder: "A place",
            suggests: offers.field,
            ref: at,
          },
        ],
      };
      return (
        <>
          <EventForm rows={[row]} />
          <SuggestionList {...offers.list} label="Place suggestions" anchor={at} />
        </>
      );
    }
    render(<Form />);
    const place = screen.getByRole("combobox", { name: "Place" }) as HTMLInputElement;
    expect(at.current).toBe(place);
    expect(place.placeholder).toBe("A place");
    fireEvent.change(place, { target: { value: "kin" } });
    expect(place.value).toBe("kin");
    expect(place.getAttribute("aria-controls")).toBe(
      screen.getByRole("listbox", { name: "Place suggestions" }).id,
    );
    fireEvent.keyDown(place, { key: "ArrowDown" });
    fireEvent.keyDown(place, { key: "Enter" });
    expect(place.value).toBe("Kino Cameo");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("draws a row's controls by their names, in the order given", () => {
    render(<EventForm rows={[when()]} />);
    expect(screen.getByRole("button", { name: "Day" }).textContent).toBe("Wed 11 Nov");
    expect((screen.getByRole("textbox", { name: "Starts" }) as HTMLInputElement).value).toBe("13:00");
    expect((screen.getByRole("textbox", { name: "Ends" }) as HTMLInputElement).value).toBe("14:00");
    expect(screen.getByRole("switch", { name: "All day" }).getAttribute("aria-checked")).toBe("false");
  });

  it("hands each change to the app at once: there is nothing to save", () => {
    const day = vi.fn(),
      starts = vi.fn(),
      allDay = vi.fn();
    render(<EventForm rows={[when({ day, starts, allDay })]} />);
    fireEvent.click(screen.getByRole("button", { name: "Day" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Starts" }), { target: { value: "13:30" } });
    fireEvent.click(screen.getByRole("switch", { name: "All day" }));
    expect(day).toHaveBeenCalledTimes(1);
    expect(starts).toHaveBeenCalledWith("13:30");
    expect(allDay).toHaveBeenCalledWith(true);
    expect(screen.queryByRole("button", { name: /save/i })).toBeNull();
  });

  it("an invitee is named, says what is noted of them, and is taken away by a control of its own", () => {
    const open = vi.fn(),
      gone = vi.fn();
    render(
      <EventForm
        rows={[
          {
            id: "invitees",
            icon: "people",
            items: [
              { kind: "word", text: "Invite" },
              {
                kind: "person",
                name: "Anna Odermatt",
                address: "anna@lichtgrat.example",
                note: "optional",
                label: "Anna Odermatt, optional",
                onPress: open,
                remove: { label: "Remove Anna Odermatt", onPress: gone },
              },
              { kind: "slot", value: "Add", label: "Add invitees", state: "none" },
            ],
          },
        ]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Anna Odermatt, optional" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove Anna Odermatt" }));
    expect(open).toHaveBeenCalledTimes(1);
    expect(gone).toHaveBeenCalledTimes(1);
  });

  it("a proposal is taken by pressing it: it opens no menu", () => {
    const take = vi.fn();
    render(
      <EventForm
        rows={[
          {
            id: "invitees",
            icon: "people",
            items: [{ kind: "take", value: "Ben Arnold", label: "Invite Ben Arnold", onPress: take }],
          },
        ]}
      />,
    );
    const proposal = screen.getByRole("button", { name: "Invite Ben Arnold" });
    expect(proposal.textContent).toBe("Ben Arnold");
    expect(proposal.hasAttribute("aria-haspopup")).toBe(false);
    fireEvent.click(proposal);
    expect(take).toHaveBeenCalledTimes(1);
  });

  it("a word that is on or off is a switch, and says which", () => {
    const flip = vi.fn();
    const row = (on: boolean): EventFormRow => ({
      id: "cal",
      mark: 243,
      items: [{ kind: "toggle", label: "Private", icon: "lock", on, onChange: flip }],
    });
    const { rerender } = render(<EventForm rows={[row(false)]} />);
    fireEvent.click(screen.getByRole("switch", { name: "Private" }));
    expect(flip).toHaveBeenCalledWith(true);
    rerender(<EventForm rows={[row(true)]} />);
    expect(screen.getByRole("switch", { name: "Private" }).getAttribute("aria-checked")).toBe("true");
  });

  it("what is still empty waits as a word, the rest behind one control, and Add ends the line", () => {
    const repeat = vi.fn(),
      more = vi.fn(),
      add = vi.fn();
    render(
      <EventForm
        rows={[]}
        adds={[
          { id: "repeat", word: "Repeat", icon: "repeat", onPress: repeat },
          { id: "call", word: "Call", label: "Video call", icon: "video" },
        ]}
        more={{ label: "More fields", onPress: more }}
        submit={{ label: "Add", keyHint: "↵", onPress: add }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Repeat" }));
    fireEvent.click(screen.getByRole("button", { name: "More fields" }));
    fireEvent.click(screen.getByRole("button", { name: /^Add/ }));
    expect(screen.getByRole("button", { name: "Video call" }).textContent).toBe("Call");
    expect([repeat, more, add].map((f) => f.mock.calls.length)).toEqual([1, 1, 1]);
  });

  it("notes are several lines, a file is named with its size, a link leads out", () => {
    const notes = vi.fn(),
      maps = vi.fn(),
      gone = vi.fn();
    render(
      <EventForm
        rows={[
          {
            id: "place",
            icon: "place",
            items: [
              { kind: "text", value: "Kino Seeblick", label: "Place", placeholder: "A place" },
              { kind: "link", text: "Open in Maps", onPress: maps },
            ],
          },
          {
            id: "call",
            icon: "video",
            items: [
              { kind: "note", text: "meet.example/kuk" },
              { kind: "remove", label: "Remove the call", onPress: gone },
            ],
          },
          { id: "files", icon: "clip", items: [{ kind: "file", name: "Poster-A2.pdf", size: "2.1 MB" }] },
          {
            id: "notes",
            icon: "note",
            items: [{ kind: "notes", value: "Bring the samples.", label: "Notes", onChange: notes }],
          },
        ]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Open in Maps" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove the call" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Notes" }), {
      target: { value: "Bring the samples.\nAnd tape." },
    });
    expect(screen.getByRole("textbox", { name: "Notes" }).tagName).toBe("TEXTAREA");
    expect(screen.queryByText("Poster-A2.pdf")).not.toBeNull();
    expect(screen.queryByText("2.1 MB")).not.toBeNull();
    expect([maps, gone].map((f) => f.mock.calls.length)).toEqual([1, 1]);
    expect(notes).toHaveBeenCalledWith("Bring the samples.\nAnd tape.");
  });
});

describe("quick add", () => {
  const line = {
    value: "lunch with Ben tomorrow 1pm",
    label: "New event",
    placeholder: "Lunch with Ben tomorrow 1pm",
  };
  const draw = (over: { onAdd?: () => void; onClose?: () => void; onChange?: (v: string) => void } = {}) =>
    render(
      <QuickAdd
        label="New event"
        tone={243}
        line={{
          ...line,
          found: [
            [15, 23],
            [24, 27],
          ],
          onChange: over.onChange,
        }}
        close={{ label: "Close", onPress: over.onClose }}
        onAdd={over.onAdd}
      >
        <EventForm
          rows={[
            when(),
            { id: "notes", icon: "note", items: [{ kind: "notes", value: "", label: "Notes" }] },
          ]}
          submit={{ label: "Add", onPress: over.onAdd }}
        />
      </QuickAdd>,
    );

  it("is a dialog with one typed line that carries its name", () => {
    draw();
    const panel = screen.getByRole("dialog", { name: "New event" });
    const typed = screen.getByRole("textbox", { name: "New event" }) as HTMLInputElement;
    expect(panel.contains(typed)).toBe(true);
    expect(typed.value).toBe("lunch with Ben tomorrow 1pm");
  });

  it("hands the typed words on, and keeps the marks out of a screen reader's way", () => {
    const onChange = vi.fn();
    draw({ onChange });
    fireEvent.change(screen.getByRole("textbox", { name: "New event" }), {
      target: { value: "lunch with Ben friday" },
    });
    expect(onChange).toHaveBeenCalledWith("lunch with Ben friday");
    expect(screen.getByText("tomorrow").closest("[aria-hidden='true']")).not.toBeNull();
  });

  it("Enter adds from the line and from a field; in the notes it is a new line, on a control it is the control's", () => {
    const onAdd = vi.fn();
    draw({ onAdd });
    fireEvent.keyDown(screen.getByRole("textbox", { name: "New event" }), { key: "Enter" });
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Starts" }), { key: "Enter" });
    expect(onAdd).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Notes" }), { key: "Enter" });
    fireEvent.keyDown(screen.getByRole("button", { name: "Day" }), { key: "Enter" });
    fireEvent.keyDown(screen.getByRole("textbox", { name: "New event" }), { key: "Enter", shiftKey: true });
    expect(onAdd).toHaveBeenCalledTimes(2);
  });

  it("Esc and the close leave it", () => {
    const onClose = vi.fn();
    draw({ onClose });
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Starts" }), { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
