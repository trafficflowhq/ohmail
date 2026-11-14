/** @vitest-environment jsdom */
/**
 * WHAT A FIELD OFFERS WHILE A PERSON TYPES: the list, where it stands, and the field's own behaviour. The list is
 * told its rows and its words; the behaviour is told how to ask. Neither knows what is being suggested.
 */
import { act, cleanup, createEvent, fireEvent, render, screen, within } from "@testing-library/react";
import { useState, type KeyboardEvent } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  Icon,
  markTyped,
  placeSuggestions,
  SuggestionCredit,
  SuggestionList,
  suggestionStore,
  useSuggestions,
  type SuggestionGroup,
  type SuggestionRow,
  type SuggestionVia,
} from "../../src/base/index.js";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const row = (id: string, primary: string, secondary?: string): SuggestionRow => ({ id, primary, secondary });
const OWN = [
  row("own-fest", "Makersfest, Hall 2, Zürich"),
  row("own-airport", "Zürich Airport", "Flughafenstrasse, 8058 Kloten"),
];
const FOUND = [
  row("hb", "Zürich HB", "Bahnhofplatz, 8001 Zurich"),
  row("street", "Zürcherstrasse", "8400 Winterthur"),
];
const GROUPS: SuggestionGroup[] = [{ head: "Your places", rows: OWN }, { rows: FOUND }];
const marked = (el: Element) => [...el.querySelectorAll("b")].map((b) => b.textContent);

describe("the typed part of a line", () => {
  const typed = (text: string, query: string) =>
    markTyped(text, query)
      .filter((part) => part.typed)
      .map((part) => part.text);

  it("is every stretch where a word begins with a typed word, whatever its case", () => {
    expect(typed("Swiss Science Center Technorama", "tec")).toEqual(["Tec"]);
    expect(typed("Technoramastrasse 1, 8404 Winterthur", "TEC")).toEqual(["Tec"]);
    expect(typed("ben@lichtgrat.example", "be li")).toEqual(["be", "li"]);
    expect(typed("Winterthur", "inter")).toEqual([]);
  });

  it("does not count accents, and reads a sharp s as two", () => {
    expect(typed("Zürich", "zur")).toEqual(["Zür"]);
    expect(typed("Zurich", "zür")).toEqual(["Zur"]);
    expect(typed("Hafenstraße 2", "hafenstrass")).toEqual(["Hafenstraß"]);
    expect(typed("Zürich", "zu")).toEqual(["Zü"]);
  });

  it("gives the line back whole, in its own order, with nothing typed or nothing found", () => {
    expect(markTyped("Tecknau", "")).toEqual([{ text: "Tecknau", typed: false }]);
    expect(markTyped("Zürich HB", "tec")).toEqual([{ text: "Zürich HB", typed: false }]);
    expect(
      markTyped("Kino Seeblick", "see")
        .map((part) => part.text)
        .join(""),
    ).toBe("Kino Seeblick");
  });
});

describe("SuggestionList", () => {
  it("is a listbox by its name, its groups named by their heads, each row an option under the list's id", () => {
    render(<SuggestionList id="pl" label="Place suggestions" groups={GROUPS} query="zür" active={2} />);
    const list = screen.getByRole("listbox", { name: "Place suggestions" });
    expect(list.id).toBe("pl");
    const own = within(list).getByRole("group", { name: "Your places" });
    expect(within(own).getAllByRole("option")).toHaveLength(2);
    expect(within(own).getByText("Your places").getAttribute("aria-hidden")).toBe("true");
    const options = within(list).getAllByRole("option");
    expect(options.map((o) => o.id)).toEqual(["pl-0", "pl-1", "pl-2", "pl-3"]);
    expect(options.map((o) => o.getAttribute("aria-selected"))).toEqual(["false", "false", "true", "false"]);
    expect(options[2]!.textContent).toContain("Zürich HB");
    expect(options[2]!.textContent).toContain("Bahnhofplatz, 8001 Zurich");
  });

  it("marks the typed part of both lines of a row, and no row is on while none is named", () => {
    render(<SuggestionList id="pl" label="Places" groups={[{ rows: FOUND }]} query="zur" active={null} />);
    const [hb, street] = screen.getAllByRole("option");
    expect(marked(hb!)).toEqual(["Zür", "Zur"]);
    expect(marked(street!)).toEqual(["Zür"]);
    expect(screen.queryByRole("option", { selected: true })).toBeNull();
  });

  it("draws a row's mark, its tag at the end, and its whole words as its title", () => {
    const rows = [
      {
        ...row("tim", "Tim Berger", "tim@gassenblatt.example"),
        mark: <Icon name="history" size={20} />,
        tag: "wrote to you",
        title: "Tim Berger, tim@gassenblatt.example",
      },
    ];
    render(<SuggestionList id="who" label="People" groups={[{ rows }]} query="" active={0} />);
    const option = screen.getByRole("option", { selected: true });
    expect(option.querySelector("svg")).not.toBeNull();
    expect(within(option).getByText("wrote to you")).toBeTruthy();
    expect(option.getAttribute("title")).toBe("Tim Berger, tim@gassenblatt.example");
  });

  it("draws each line of a row as text of its own direction: a line in another script reorders nothing beside it", () => {
    const rows = [row("cafe", "مقهى الوردة", "Bahnhofstrasse 1, 8001 Zürich")];
    render(<SuggestionList id="pl" label="Places" groups={[{ rows }]} query="" active={null} />);
    const lines = [...screen.getByRole("option").querySelectorAll("[dir]")];
    expect(lines.map((line) => [line.getAttribute("dir"), line.textContent])).toEqual([
      ["auto", "مقهى الوردة"],
      ["auto", "Bahnhofstrasse 1, 8001 Zürich"],
    ]);
  });

  it("is not there with nothing to offer: no empty box, no foot, no sign of loading", () => {
    const { container } = render(
      <SuggestionList
        id="pl"
        label="Places"
        groups={[{ head: "Your places", rows: [] }]}
        query="x"
        active={null}
        busy
        foot="credit"
      />,
    );
    expect(container.innerHTML).toBe("");
  });

  it("says that answers are on their way on the list itself, and keeps a foot outside the list", () => {
    render(
      <SuggestionList
        id="pl"
        label="Places"
        groups={GROUPS}
        query="zür"
        active={null}
        busy
        foot={<span>credit line</span>}
      />,
    );
    const list = screen.getByRole("listbox");
    expect(list.getAttribute("aria-busy")).toBe("true");
    const foot = screen.getByText("credit line");
    expect(list.contains(foot)).toBe(false);
    cleanup();
    render(<SuggestionList id="pl" label="Places" groups={GROUPS} query="zür" active={null} />);
    expect(screen.getByRole("listbox").hasAttribute("aria-busy")).toBe(false);
  });

  it("puts the keys on the row a pointer moves over, never under a finger, and takes a row on a press", () => {
    const [onActive, onTake] = [vi.fn(), vi.fn()];
    render(
      <SuggestionList
        id="pl"
        label="Places"
        groups={GROUPS}
        query="zür"
        active={0}
        onActive={onActive}
        onTake={onTake}
      />,
    );
    const options = screen.getAllByRole("option");
    /* The test window's pointer events carry no kind of their own: it is said on the event. */
    const over = (el: Element, pointerType: "mouse" | "touch") => {
      const move = createEvent.pointerMove(el);
      Object.defineProperty(move, "pointerType", { value: pointerType });
      fireEvent(el, move);
    };
    over(options[3]!, "mouse");
    expect(onActive).toHaveBeenLastCalledWith(3);
    over(options[0]!, "mouse");
    expect(onActive).toHaveBeenCalledTimes(1);
    over(options[1]!, "touch");
    expect(onActive).toHaveBeenCalledTimes(1);
    fireEvent.click(options[3]!);
    expect(onTake).toHaveBeenCalledWith(FOUND[1], "press");
  });

  it("never takes the caret out of its field: a press on it moves no focus", () => {
    render(
      <SuggestionList
        id="pl"
        label="Places"
        groups={GROUPS}
        query="zür"
        active={null}
        foot={<SuggestionCredit>credit</SuggestionCredit>}
      />,
    );
    const down = createEvent.mouseDown(screen.getAllByRole("option")[1]!);
    fireEvent(screen.getAllByRole("option")[1]!, down);
    expect(down.defaultPrevented).toBe(true);
    const onFoot = createEvent.mouseDown(screen.getByRole("button", { name: "credit" }));
    fireEvent(screen.getByRole("button", { name: "credit" }), onFoot);
    expect(onFoot.defaultPrevented).toBe(true);
  });
});

describe("SuggestionCredit", () => {
  it("is a link by its words where it has an address, a button where it runs something, and never a stop of Tab", () => {
    const onPress = vi.fn();
    render(
      <>
        <SuggestionCredit href="https://maps.example/copyright" title="Opens maps.example">
          © Map contributors
        </SuggestionCredit>
        <SuggestionCredit onPress={onPress}>Sources</SuggestionCredit>
      </>,
    );
    const link = screen.getByRole("link", { name: "© Map contributors" });
    expect(link.getAttribute("href")).toBe("https://maps.example/copyright");
    expect(link.getAttribute("title")).toBe("Opens maps.example");
    expect(link.tabIndex).toBe(-1);
    const button = screen.getByRole("button", { name: "Sources" });
    expect(button.tabIndex).toBe(-1);
    fireEvent.click(button);
    expect(onPress).toHaveBeenCalledTimes(1);
  });
});

describe("where a list stands at its field", () => {
  const room = { left: 0, top: 0, right: 800, bottom: 600 };
  const field = { left: 100, top: 300, right: 400, bottom: 332 };

  it("stands under its field, from the field's edge, with the room under it as its height at most", () => {
    const at = placeSuggestions(field, { width: 300, height: 200 }, room);
    expect(at).toEqual({ left: 100, top: 338, maxHeight: 254, up: false });
  });

  it("stands over its field where the room under is short and there is more above", () => {
    const at = placeSuggestions(field, { width: 300, height: 200 }, { ...room, bottom: 400 });
    expect(at.up).toBe(true);
    expect(at.top + 200).toBe(294);
    expect(at.maxHeight).toBe(286);
  });

  it("is cut to the room it has and scrolls, a taller list over a field ending at the room's top edge", () => {
    const at = placeSuggestions(field, { width: 300, height: 900 }, { ...room, bottom: 420 });
    expect(at).toMatchObject({ up: true, top: 8, maxHeight: 286 });
    const low = placeSuggestions(
      { ...field, top: 40, bottom: 72 },
      { width: 300, height: 900 },
      { ...room, bottom: 120 },
    );
    expect(low.maxHeight).toBe(96);
  });

  it("never leaves the element it is held inside, on either side", () => {
    const inside = { left: 200, top: 0, right: 700, bottom: 600 };
    expect(
      placeSuggestions({ ...field, left: 600, right: 690 }, { width: 300, height: 100 }, inside).left,
    ).toBe(392);
    expect(
      placeSuggestions({ ...field, left: 150, right: 450 }, { width: 300, height: 100 }, inside).left,
    ).toBe(208);
  });
});

/** A field that suggests, as a screen wires it: the device's own answers at once, a source that takes time. */
function Place(props: {
  own?: (text: string) => readonly SuggestionGroup[];
  ask?: (text: string, signal: AbortSignal) => Promise<readonly SuggestionGroup[]>;
  free?: boolean;
  start?: string;
  onTake?: (row: SuggestionRow, via: SuggestionVia) => void;
  onFormKey?: (event: KeyboardEvent) => void;
}) {
  const [text, setText] = useState(props.start ?? "");
  const suggestions = useSuggestions({
    id: "pl",
    text,
    onText: setText,
    own: props.own,
    ask: props.ask,
    free: props.free ?? true,
    onTake: (taken, via) => {
      props.onTake?.(taken, via);
      setText(taken.primary);
    },
  });
  return (
    <div onKeyDown={props.onFormKey}>
      <input aria-label="Place" {...suggestions.field} />
      <button type="button" onClick={() => setText("Kino Cameo")}>
        fill
      </button>
      <button type="button" onClick={suggestions.open}>
        open
      </button>
      <SuggestionList
        {...suggestions.list}
        label="Place suggestions"
        foot={suggestions.answered ? "credit" : undefined}
      />
    </div>
  );
}

const fold = (s: string) => s.toLowerCase();
const own = (text: string): SuggestionGroup[] => [
  { head: "Your places", rows: OWN.filter((r) => fold(r.primary).includes(fold(text.trim()))) },
];
const field = () => screen.getByLabelText("Place") as HTMLInputElement;
const type = (value: string) => fireEvent.change(field(), { target: { value } });
const key = (name: string, more: Record<string, unknown> = {}) => {
  const event = createEvent.keyDown(field(), { key: name, ...more });
  fireEvent(field(), event);
  return event;
};
/** A row as an option says it: its first line, then its second. */
const said = (r: SuggestionRow) => `${r.primary}${r.secondary ?? ""}`;
const options = () => screen.queryAllByRole("option").map((o) => o.textContent);
const on = () => screen.queryByRole("option", { selected: true })?.textContent ?? null;
const wait = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

describe("useSuggestions", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("makes the field a combobox that names its list and says the row the keys are on", () => {
    render(<Place own={own} />);
    expect(field().getAttribute("role")).toBe("combobox");
    expect(field().getAttribute("aria-autocomplete")).toBe("list");
    expect(field().getAttribute("aria-expanded")).toBe("false");
    expect(field().hasAttribute("aria-activedescendant")).toBe(false);
    type("z");
    expect(field().getAttribute("aria-expanded")).toBe("true");
    expect(field().getAttribute("aria-controls")).toBe(
      screen.getByRole("listbox", { name: "Place suggestions" }).id,
    );
    key("ArrowDown");
    expect(field().getAttribute("aria-activedescendant")).toBe(
      screen.getByRole("option", { selected: true }).id,
    );
  });

  it("offers the device's own from the first character, at once and without asking", () => {
    const ask = vi.fn(async () => [{ rows: FOUND }]);
    render(<Place own={own} ask={ask} />);
    type("z");
    expect(options()).toEqual(OWN.map(said));
    type("air");
    expect(options()).toEqual([said(OWN[1]!)]);
    expect(ask).not.toHaveBeenCalled();
  });

  it("asks only from three characters, and only after the typing has paused", async () => {
    const ask = vi.fn(async (_text: string) => [{ rows: FOUND }]);
    render(<Place ask={ask} />);
    type("zü");
    await wait(1000);
    expect(ask).not.toHaveBeenCalled();
    type("  zü ");
    await wait(1000);
    expect(ask).not.toHaveBeenCalled();
    type("zür");
    await wait(199);
    expect(ask).not.toHaveBeenCalled();
    await wait(1);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask.mock.calls[0]![0]).toBe("zür");
    await wait(0);
    expect(options()).toEqual(FOUND.map(said));
    expect(screen.getByText("credit")).toBeTruthy();
  });

  it("has one question out at a time: the older one is given up and its late answer is never shown", async () => {
    const asked: { text: string; signal: AbortSignal; answer: (rows: SuggestionRow[]) => void }[] = [];
    const ask = (text: string, signal: AbortSignal) =>
      new Promise<SuggestionGroup[]>((resolve) =>
        asked.push({ text, signal, answer: (rows) => resolve([{ rows }]) }),
      );
    render(<Place ask={ask} />);
    type("zür");
    await wait(200);
    type("züri");
    expect(asked[0]!.signal.aborted).toBe(true);
    await wait(200);
    expect(asked.map((a) => a.text)).toEqual(["zür", "züri"]);
    await act(async () => asked[0]!.answer([row("late", "Zürcher Late")]));
    expect(options()).toEqual([]);
    await act(async () => asked[1]!.answer([FOUND[0]!]));
    expect(options()).toEqual([said(FOUND[0]!)]);
  });

  it("keeps the last answers until new ones arrive, the typed part following the typing, and says after a while that it waits", async () => {
    let answer: (groups: SuggestionGroup[]) => void = () => {};
    const ask = vi.fn<(text: string) => Promise<SuggestionGroup[]>>(async () => [{ rows: FOUND }]);
    render(<Place ask={ask} />);
    type("zür");
    await wait(200);
    expect(options()).toEqual(FOUND.map(said));
    ask.mockImplementation(() => new Promise((resolve) => (answer = resolve)));
    type("züri");
    await wait(200);
    expect(options()).toEqual(FOUND.map(said));
    expect(marked(screen.getAllByRole("option")[0]!)).toEqual(["Züri", "Zuri"]);
    await wait(399);
    expect(screen.getByRole("listbox").hasAttribute("aria-busy")).toBe(false);
    await wait(1);
    expect(screen.getByRole("listbox").getAttribute("aria-busy")).toBe("true");
    await act(async () => answer([{ rows: [FOUND[0]!] }]));
    expect(options()).toEqual([said(FOUND[0]!)]);
    expect(screen.getByRole("listbox").hasAttribute("aria-busy")).toBe(false);
  });

  it("drops an answer that is too slow: the old answers go, the device's own stay, and nothing is said", async () => {
    const signals: AbortSignal[] = [];
    const ask = vi.fn<(text: string, signal: AbortSignal) => Promise<SuggestionGroup[]>>(async () => [
      { rows: FOUND },
    ]);
    render(<Place own={own} ask={ask} />);
    type("zür");
    await wait(200);
    expect(options()).toHaveLength(4);
    ask.mockImplementation((_text, signal) => {
      signals.push(signal);
      return new Promise(() => {});
    });
    type("züri");
    await wait(200 + 1999);
    expect(options()).toHaveLength(4);
    await wait(1);
    expect(options()).toEqual(OWN.map(said));
    expect(signals[0]!.aborted).toBe(true);
    expect(screen.getByRole("listbox").hasAttribute("aria-busy")).toBe(false);
    expect(screen.queryByText("credit")).toBeNull();
    await wait(10_000);
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it("treats a source that fails as one that has nothing: the plain field, no word", async () => {
    render(<Place ask={() => Promise.reject(new Error("down"))} />);
    type("zür");
    await wait(200);
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(field().value).toBe("zür");
  });

  it("does not ask again for a text it has an answer for, while the answer is kept", async () => {
    const ask = vi.fn(async (text: string) => [{ rows: [row(text, `Answer for ${text}`)] }]);
    render(<Place ask={ask} />);
    type("zür");
    await wait(200);
    type("züri");
    await wait(200);
    type("zür");
    expect(options()).toEqual(["Answer for zür"]);
    await wait(1000);
    expect(ask).toHaveBeenCalledTimes(2);
    await wait(300_000);
    type("züri");
    await wait(200);
    expect(ask).toHaveBeenCalledTimes(3);
  });

  it("forgets a kept answer when its time is over", () => {
    const store = suggestionStore(1000);
    store.set("zür", [{ rows: FOUND }]);
    expect(store.get("zür")).toEqual([{ rows: FOUND }]);
    vi.advanceTimersByTime(1001);
    expect(store.get("zür")).toBeUndefined();
  });

  it("walks the rows with the arrows, the typed text a stop of its own between the last row and the first", () => {
    render(<Place own={own} />);
    type("z");
    expect(on()).toBeNull();
    expect(key("ArrowDown").defaultPrevented).toBe(true);
    expect(on()).toBe(said(OWN[0]!));
    key("ArrowDown");
    expect(on()).toBe(said(OWN[1]!));
    key("ArrowDown");
    expect(on()).toBeNull();
    key("ArrowUp");
    expect(on()).toBe(said(OWN[1]!));
    key("ArrowUp");
    key("ArrowUp");
    expect(on()).toBeNull();
    expect(field().value).toBe("z");
  });

  it("keeps the typed words on Enter with no row chosen: the list closes and the key is the form's own", () => {
    const [onTake, onFormKey] = [vi.fn(), vi.fn()];
    render(<Place own={own} onTake={onTake} onFormKey={onFormKey} />);
    type("zür");
    expect(options()).toHaveLength(2);
    const enter = key("Enter");
    expect(enter.defaultPrevented).toBe(false);
    expect(onFormKey).toHaveBeenCalledTimes(1);
    expect(onTake).not.toHaveBeenCalled();
    expect(field().value).toBe("zür");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("takes the row the keys are on with Enter, and the form does not hear that key", () => {
    const [onTake, onFormKey] = [vi.fn(), vi.fn()];
    render(<Place own={own} onTake={onTake} onFormKey={onFormKey} />);
    type("zür");
    key("ArrowDown");
    key("ArrowDown");
    onFormKey.mockClear();
    const enter = key("Enter");
    expect(enter.defaultPrevented).toBe(true);
    expect(onFormKey).not.toHaveBeenCalled();
    expect(onTake).toHaveBeenCalledWith(OWN[1], "enter");
    expect(field().value).toBe("Zürich Airport");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("takes the row with Tab and lets the caret go on; with no row Tab only goes on", () => {
    const onTake = vi.fn();
    render(<Place own={own} onTake={onTake} />);
    type("zür");
    expect(key("Tab").defaultPrevented).toBe(false);
    expect(onTake).not.toHaveBeenCalled();
    expect(field().value).toBe("zür");
    type("zü");
    key("ArrowDown");
    expect(key("Tab").defaultPrevented).toBe(false);
    expect(onTake).toHaveBeenCalledWith(OWN[0], "tab");
  });

  it("closes on Esc with the text, the caret and the form as they were, and opens again on the arrow", () => {
    const onFormKey = vi.fn();
    render(<Place own={own} onFormKey={onFormKey} />);
    type("zür");
    const escape = key("Escape");
    expect(escape.defaultPrevented).toBe(true);
    expect(onFormKey).not.toHaveBeenCalled();
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(field().value).toBe("zür");
    expect(key("Escape").defaultPrevented).toBe(false);
    expect(onFormKey).toHaveBeenCalledTimes(1);
    key("ArrowDown");
    expect(options()).toHaveLength(2);
    expect(on()).toBeNull();
  });

  it("closes when the caret goes elsewhere", () => {
    render(<Place own={own} />);
    type("zür");
    fireEvent.blur(field());
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("offers nothing for a field that was filled, only for one that is typed in; and stays shut after a row was taken", () => {
    render(<Place own={() => [{ rows: [row("k", "Kino Cameo")] }]} start="Kino" />);
    expect(screen.queryByRole("listbox")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "fill" }));
    expect(field().value).toBe("Kino Cameo");
    expect(screen.queryByRole("listbox")).toBeNull();
    type("Kino");
    expect(options()).toEqual(["Kino Cameo"]);
    fireEvent.click(screen.getByRole("option"));
    expect(field().value).toBe("Kino Cameo");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("opens the device's own on an empty field when asked to: by the arrow, or by the screen", () => {
    render(<Place own={own} />);
    expect(screen.queryByRole("listbox")).toBeNull();
    key("ArrowDown");
    expect(options()).toEqual(OWN.map(said));
    key("Escape");
    fireEvent.click(screen.getByRole("button", { name: "open" }));
    expect(options()).toHaveLength(2);
  });

  it("puts the keys on the first row by itself where the typed text is no answer of its own", () => {
    const onTake = vi.fn();
    render(<Place own={own} free={false} onTake={onTake} />);
    type("zür");
    expect(on()).toBe(said(OWN[0]!));
    key("ArrowUp");
    expect(on()).toBe(said(OWN[1]!));
    key("ArrowDown");
    expect(on()).toBe(said(OWN[0]!));
    key("Enter");
    expect(onTake).toHaveBeenCalledWith(OWN[0], "enter");
  });

  it("leaves a key alone that is not the list's: a chord with Enter, a key while a word is being composed", () => {
    const onTake = vi.fn();
    render(<Place own={own} free={false} onTake={onTake} />);
    type("zür");
    expect(key("Enter", { ctrlKey: true }).defaultPrevented).toBe(false);
    expect(key("Enter", { isComposing: true }).defaultPrevented).toBe(false);
    expect(onTake).not.toHaveBeenCalled();
  });

  it("keeps no rejection: a text whose question failed is asked again when it is typed again", async () => {
    const ask = vi.fn<(text: string) => Promise<SuggestionGroup[]>>(() => Promise.reject("busy"));
    render(<Place ask={ask} />);
    type("zür");
    await wait(200);
    type("zü");
    type("zür");
    await wait(200);
    expect(ask.mock.calls.map(([text]) => text)).toEqual(["zür", "zür"]);
  });
});

/**
 * THE ROW A PERSON SAW. A newer answer can land between the arrow that put the keys on a row and the Enter that
 * takes it. What is taken is the row that stood under the keys, never a row of the newer answer that happens to
 * stand in its place, and never the typed fragment handed to the form.
 */
describe("the keys on a row of the older answer, the newer answer lands without it", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  const OLDER = [row("hb", "Zürich HB"), row("air", "Zürich Airport")];
  const NEWER = [row("zoo", "Zürich Zoo"), row("see", "Zürichsee")];
  /** A source that is answered by hand: each question waits for its own answer. */
  const byHand = () => {
    const answers: ((rows: SuggestionRow[]) => void)[] = [];
    return {
      ask: () => new Promise<SuggestionGroup[]>((resolve) => answers.push((rows) => resolve([{ rows }]))),
      answer: (question: number, rows: SuggestionRow[]) => act(async () => answers[question]!(rows)),
    };
  };
  /** The older answer on screen, a longer text asked, the keys on "Zürich Airport", then the newer answer. */
  const raced = async (free: boolean, newer: SuggestionRow[] = NEWER) => {
    const source = byHand();
    const [onTake, onFormKey] = [vi.fn(), vi.fn()];
    render(<Place ask={source.ask} free={free} onTake={onTake} onFormKey={onFormKey} />);
    type("zür");
    await wait(200);
    await source.answer(0, OLDER);
    type("züri");
    await wait(200);
    /* Where the text is an answer of its own the first arrow goes to the first row; where it is none, that row is on already. */
    if (free) key("ArrowDown");
    key("ArrowDown");
    expect(on()).toBe("Zürich Airport");
    await source.answer(1, newer);
    onFormKey.mockClear();
    return { onTake, onFormKey };
  };

  it.each([
    ["an answer of its own (a place)", true],
    ["no answer of its own (a recipient)", false],
  ])(
    "Enter takes that row and the form does not hear the key, where the typed text is %s",
    async (_, free) => {
      const { onTake, onFormKey } = await raced(free);
      expect(options()).toEqual(["Zürich Zoo", "Zürichsee"]);
      /* No row of the newer answer is on by itself in its place: the person never put the keys there. */
      expect(on()).toBeNull();
      const enter = key("Enter");
      expect(onTake.mock.calls).toEqual([[OLDER[1], "enter"]]);
      expect(enter.defaultPrevented).toBe(true);
      expect(onFormKey).not.toHaveBeenCalled();
      expect(field().value).toBe("Zürich Airport");
      expect(screen.queryByRole("listbox")).toBeNull();
    },
  );

  it.each([true, false])(
    "Tab takes that row too, and goes on (the text an answer of its own: %s)",
    async (free) => {
      const { onTake } = await raced(free);
      expect(key("Tab").defaultPrevented).toBe(false);
      expect(onTake.mock.calls).toEqual([[OLDER[1], "tab"]]);
    },
  );

  it.each([true, false])(
    "takes it where the newer answer has nothing at all (the text an answer of its own: %s)",
    async (free) => {
      const { onTake, onFormKey } = await raced(free, []);
      expect(screen.queryByRole("listbox")).toBeNull();
      expect(key("Enter").defaultPrevented).toBe(true);
      expect(onTake.mock.calls).toEqual([[OLDER[1], "enter"]]);
      expect(onFormKey).not.toHaveBeenCalled();
    },
  );

  it("an arrow after it walks the rows that stand, and Enter takes the one the keys are on then", async () => {
    const { onTake } = await raced(false);
    key("ArrowDown");
    expect(on()).toBe("Zürich Zoo");
    key("Enter");
    expect(onTake.mock.calls).toEqual([[NEWER[0], "enter"]]);
  });

  it("a letter typed after it forgets that row: Enter is the form's own again, with the typed words", async () => {
    const { onTake, onFormKey } = await raced(true);
    type("zürich");
    onFormKey.mockClear();
    expect(key("Enter").defaultPrevented).toBe(false);
    expect(onTake).not.toHaveBeenCalled();
    expect(onFormKey).toHaveBeenCalledTimes(1);
    expect(field().value).toBe("zürich");
  });
});
