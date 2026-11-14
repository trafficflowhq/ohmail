/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Avatar,
  avatarHue,
  Blank,
  Button,
  Count,
  EndDot,
  Faces,
  Field,
  HintLine,
  InfoMark,
  JumpBack,
  KeyHint,
  RadioLines,
  Seg,
  Sentence,
  Slot,
  Switch,
  Tag,
} from "../../src/base/index.js";

afterEach(cleanup);

describe("Button", () => {
  it("is a button named by its word, and runs on a press", () => {
    const onPress = vi.fn();
    render(<Button onPress={onPress}>Reply</Button>);
    fireEvent.click(screen.getByRole("button", { name: "Reply" }));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it("shows an icon alone only with its name", () => {
    render(<Button kind="quiet" icon="x" label="Close" />);
    const close = screen.getByRole("button", { name: "Close" });
    expect(close.getAttribute("title")).toBe("Close");
    // @ts-expect-error an icon without a word needs a label
    render(<Button kind="quiet" icon="more" />);
  });

  it("says whether a toggle is held, and nothing where it is no toggle", () => {
    render(
      <>
        <Button pressed>Later</Button>
        <Button pressed={false}>Park</Button>
        <Button>Reply</Button>
      </>,
    );
    expect(screen.getByRole("button", { name: "Later" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Park" }).getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByRole("button", { name: "Reply" }).hasAttribute("aria-pressed")).toBe(false);
  });

  it("does not run while it is off", () => {
    const onPress = vi.fn();
    render(
      <Button disabled onPress={onPress}>
        Sending
      </Button>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Sending" }));
    expect(onPress).not.toHaveBeenCalled();
  });

  it("says what it opens and whether that stands open", () => {
    render(
      <>
        <Button opens="menu" expanded>
          More
        </Button>
        <Button opens="dialog">Delete</Button>
      </>,
    );
    const more = screen.getByRole("button", { name: "More" });
    expect([more.getAttribute("aria-haspopup"), more.getAttribute("aria-expanded")]).toEqual([
      "menu",
      "true",
    ]);
    expect(screen.getByRole("button", { name: "Delete" }).getAttribute("aria-expanded")).toBe("false");
  });

  it("carries its key beside its word", () => {
    render(<Button keyHint="r">Reply</Button>);
    expect(screen.getByRole("button").textContent).toBe("Replyr");
  });
});

describe("KeyHint", () => {
  it("prints the key it is handed", () => {
    const { container } = render(<KeyHint>Ctrl K</KeyHint>);
    expect(container.textContent).toBe("Ctrl K");
  });
});

describe("EndDot", () => {
  it("keeps the last word and the dot on one line, and the dot out of what is read aloud", () => {
    const { container } = render(
      <p>
        <EndDot kind="hot">5 unread</EndDot>
      </p>,
    );
    expect(container.textContent).toBe("5 unread");
    const dot = container.querySelector("[aria-hidden='true']");
    expect(dot?.parentElement?.textContent).toBe("unread");
  });
});

describe("Slot", () => {
  it("is a button that opens a menu, named by its word or by its label", () => {
    const onPress = vi.fn();
    render(
      <>
        <Slot onPress={onPress}>year</Slot>
        <Slot label="Window" expanded>
          90 days
        </Slot>
      </>,
    );
    const year = screen.getByRole("button", { name: "year" });
    expect([year.getAttribute("aria-haspopup"), year.getAttribute("aria-expanded")]).toEqual([
      "menu",
      "false",
    ]);
    fireEvent.click(year);
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Window" }).getAttribute("aria-expanded")).toBe("true");
  });
});

describe("Sentence and Blank", () => {
  it("is a paragraph, or a heading where it titles what it stands in", () => {
    render(
      <>
        <Sentence>Move to Trash</Sentence>
        <Sentence level={2}>Add an account</Sentence>
      </>,
    );
    expect(screen.getByRole("heading", { level: 2, name: "Add an account" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Move to Trash" })).toBeNull();
  });

  it("a blank says what it wants, hands on what is typed, and goes on with Enter and back with Esc", () => {
    const [onChange, onEnter, onEscape] = [vi.fn(), vi.fn(), vi.fn()];
    render(
      <Blank
        label="email address"
        placeholder="email address"
        value=""
        onChange={onChange}
        onEnter={onEnter}
        onEscape={onEscape}
      />,
    );
    const blank = screen.getByRole("textbox", { name: "email address" });
    fireEvent.change(blank, { target: { value: "mila@lichtgrat.example" } });
    expect(onChange).toHaveBeenCalledWith("mila@lichtgrat.example");
    fireEvent.keyDown(blank, { key: "Enter" });
    fireEvent.keyDown(blank, { key: "Escape" });
    expect([onEnter.mock.calls.length, onEscape.mock.calls.length]).toEqual([1, 1]);
  });

  it("a refused blank says so", () => {
    render(<Blank label="email address" placeholder="email address" value="x" refused onChange={() => {}} />);
    expect(screen.getByRole("textbox").getAttribute("aria-invalid")).toBe("true");
  });
});

describe("Field", () => {
  it("binds its label to the field and hands on what is typed", () => {
    const onChange = vi.fn();
    render(<Field label="Name" value="" onChange={onChange} />);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Mila" } });
    expect(onChange).toHaveBeenCalledWith("Mila");
  });

  it("says its refusal with the field, in place of the hint", () => {
    render(
      <Field
        label="App password"
        value="wrong"
        hint="16 letters"
        refusal="Use an app password."
        onChange={() => {}}
      />,
    );
    const field = screen.getByRole("textbox", { name: "App password" });
    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(document.getElementById(field.getAttribute("aria-describedby")!)?.textContent).toBe(
      "Use an app password.",
    );
    expect(screen.queryByText("16 letters")).toBeNull();
  });

  it("takes several lines", () => {
    render(<Field label="Signature" value={"Mila\nStudio"} lines={3} onChange={() => {}} />);
    expect((screen.getByLabelText("Signature") as HTMLTextAreaElement).rows).toBe(3);
  });
});

describe("Switch", () => {
  it("is a switch that says its state and turns at a press", () => {
    const onChange = vi.fn();
    render(<Switch label="Key hints" on={false} onChange={onChange} labelled />);
    const sw = screen.getByRole("switch", { name: "Key hints" });
    expect(sw.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(sw);
    expect(onChange).toHaveBeenCalledWith(true);
  });
});

describe("Seg", () => {
  const options = [
    { value: "waiting", label: "Waiting", count: 6 },
    { value: "spam", label: "Spam", count: 0 },
  ] as const;
  it("is a named group whose segments say which one is taken", () => {
    const onChange = vi.fn();
    render(<Seg label="Sections" options={options} value="waiting" onChange={onChange} />);
    const group = screen.getByRole("group", { name: "Sections" });
    const [waiting, spam] = [...group.querySelectorAll("button")];
    expect([waiting!.getAttribute("aria-pressed"), spam!.getAttribute("aria-pressed")]).toEqual([
      "true",
      "false",
    ]);
    fireEvent.click(spam!);
    expect(onChange).toHaveBeenCalledWith("spam");
  });

  it("shows a count, and nothing for zero", () => {
    render(<Seg label="Sections" options={options} value="waiting" />);
    expect(screen.getByRole("button", { name: /^Waiting\s*6$/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Spam" })).toBeTruthy();
  });
});

describe("RadioLines", () => {
  const options = [
    { value: "sender", label: "This address", note: "2 messages" },
    { value: "domain", label: "Everyone at erdton.example", note: "9 messages" },
  ] as const;
  it("is a radio group: one line is taken, and a press takes another", () => {
    const onChange = vi.fn();
    render(<RadioLines label="Whose mail" options={options} value="sender" onChange={onChange} />);
    const lines = screen.getAllByRole("radio");
    expect(screen.getByRole("radiogroup", { name: "Whose mail" })).toBeTruthy();
    expect(lines.map((l) => l.getAttribute("aria-checked"))).toEqual(["true", "false"]);
    fireEvent.click(lines[1]!);
    expect(onChange).toHaveBeenCalledWith("domain");
  });

  it("the arrows move the choice and wrap, Home and End take the ends, and only the taken line is a tab stop", () => {
    const onChange = vi.fn();
    render(<RadioLines label="Whose mail" options={options} value="sender" onChange={onChange} />);
    const [first, second] = screen.getAllByRole("radio");
    expect([first!.tabIndex, second!.tabIndex]).toEqual([0, -1]);
    fireEvent.keyDown(first!, { key: "ArrowDown" });
    expect(onChange).toHaveBeenLastCalledWith("domain");
    expect(document.activeElement).toBe(second);
    fireEvent.keyDown(first!, { key: "ArrowUp" });
    expect(onChange).toHaveBeenLastCalledWith("domain");
    fireEvent.keyDown(first!, { key: "End" });
    expect(onChange).toHaveBeenLastCalledWith("domain");
    fireEvent.keyDown(first!, { key: "Home" });
    expect(onChange).toHaveBeenLastCalledWith("sender");
  });
});

describe("Count", () => {
  it("prints the number, and nothing for zero or for no number", () => {
    const { container } = render(
      <>
        <Count>5</Count>
        <Count>{0}</Count>
        <Count>0</Count>
        <Count>{undefined}</Count>
      </>,
    );
    expect(container.textContent).toBe("5");
  });
});

describe("Avatar", () => {
  it("draws the name's first letter and says nothing: the name stands beside it", () => {
    const { container } = render(<Avatar name="giulia ferrari" address="giulia@terracotta-milano.example" />);
    expect(container.textContent).toBe("G");
    expect(container.firstElementChild?.getAttribute("aria-hidden")).toBe("true");
  });

  it("one person wears one hue, however the address is written", () => {
    expect(avatarHue("Giulia@Terracotta-Milano.example ")).toBe(
      avatarHue("giulia@terracotta-milano.example"),
    );
    expect(
      new Set(
        ["hallo@roestsonntag.example", "anna@gartenlokal-rosa.example", "petra@makersfest.example"].map(
          avatarHue,
        ),
      ).size,
    ).toBe(3);
  });

  it("a few faces show how many more there are, and no faces show nothing", () => {
    const people = [
      { name: "Anna", address: "anna@gartenlokal-rosa.example" },
      { name: "Petra", address: "petra@makersfest.example" },
    ];
    expect(render(<Faces people={people} more="+2" />).container.textContent).toBe("AP+2");
    expect(render(<Faces people={[]} more="+2" />).container.textContent).toBe("");
  });
});

describe("Tag", () => {
  it("a tag of the person's own carries its whole name where it is cut", () => {
    render(<Tag hue={150}>Pottery Project</Tag>);
    expect(screen.getByTitle("Pottery Project").textContent).toBe("Pottery Project");
  });
});

describe("InfoMark", () => {
  it("is a named button that says it opens a card", () => {
    const onPress = vi.fn();
    render(<InfoMark label="About storage" onPress={onPress} />);
    const mark = screen.getByRole("button", { name: "About storage" });
    expect([mark.getAttribute("aria-haspopup"), mark.getAttribute("aria-expanded")]).toEqual([
      "dialog",
      "false",
    ]);
    fireEvent.click(mark);
    expect(onPress).toHaveBeenCalledTimes(1);
  });
});

describe("JumpBack", () => {
  it("is out of reach of the keys and of a screen reader until it stands", () => {
    const { rerender } = render(<JumpBack label="Back to top" to="top" shown={false} />);
    expect(screen.queryByRole("button", { name: "Back to top" })).toBeNull();
    rerender(<JumpBack label="Back to top" to="top" shown />);
    expect(screen.getByRole("button", { name: "Back to top" }).tabIndex).toBe(0);
  });
});

describe("HintLine", () => {
  it("prints each key with what it does, for the eye only", () => {
    const { container } = render(
      <HintLine
        hints={[
          { key: "↓", label: "Next message" },
          { key: "?", label: "Keys" },
        ]}
      />,
    );
    expect(container.textContent).toBe("↓Next message?Keys");
    expect(container.firstElementChild?.getAttribute("aria-hidden")).toBe("true");
  });
});
