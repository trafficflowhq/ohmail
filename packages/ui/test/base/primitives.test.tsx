/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState, type ReactNode, type Ref } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Avatar,
  avatarHue,
  Blank,
  Button,
  ChoiceTiles,
  Count,
  EndDot,
  Faces,
  Field,
  FieldPair,
  FieldStack,
  FindField,
  HintLine,
  InfoMark,
  JumpBack,
  KeyHint,
  Mark,
  RadioLines,
  Seg,
  Sentence,
  Slot,
  SuggestionList,
  Switch,
  Tag,
  useSuggestions,
} from "../../src/base/index.js";

afterEach(cleanup);

/** What a form may hand a password field of either kind. */
interface SecretProps {
  value?: string;
  onChange?: (typed: string) => void;
  ref?: Ref<HTMLInputElement>;
  autoComplete?: string;
  name?: string;
}

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

  /**
   * A browser sends a form by Enter in its one field when the form has no submit button left, and turns Enter into a
   * click on the submit button while there is one. A busy button stays the form's submit button and cancels that
   * click, as a button that is off does. `forms-in-a-browser.test.tsx` presses the real key in a real browser.
   */
  it("a busy submit button keeps a form with one field from being sent by Enter", () => {
    const sent = vi.fn();
    function Code({ busy }: { busy: boolean }) {
      const [code, setCode] = useState("");
      return (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            sent();
          }}
        >
          <Field label="Code" value={code} onChange={setCode} />
          <Button type="submit" busy={busy}>
            Verify
          </Button>
        </form>
      );
    }
    const verify = () => screen.getByRole("button", { name: "Verify" }) as HTMLButtonElement;
    const busy = render(<Code busy />);
    /* Still the form's submit button, so the browser's Enter goes to it and not past it. */
    expect([verify().type, verify().form?.contains(screen.getByLabelText("Code"))]).toEqual(["submit", true]);
    /* The click the browser makes of that Enter sends nothing. */
    fireEvent.click(verify());
    expect(sent).not.toHaveBeenCalled();
    busy.unmount();
    render(<Code busy={false} />);
    fireEvent.click(verify());
    expect(sent).toHaveBeenCalledTimes(1);
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

  it("given an address it is a link there, named once, and takes no press", () => {
    render(
      <>
        <Button kind="two" href="/join">
          Connect
        </Button>
        <Button kind="quiet" icon="back" label="Back" href="/" />
      </>,
    );
    const go = screen.getByRole("link", { name: "Connect" });
    expect([
      go.tagName,
      go.getAttribute("href"),
      go.hasAttribute("type"),
      go.hasAttribute("aria-label"),
    ]).toEqual(["A", "/join", false, false]);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByRole("link", { name: "Back" }).getAttribute("href")).toBe("/");
    render(
      // @ts-expect-error a link goes somewhere; it does not also run
      <Button href="/join" onPress={() => {}}>
        Connect
      </Button>,
    );
    render(
      // @ts-expect-error a link is no toggle, holds no menu and is never off
      <Button href="/join" disabled>
        Connect
      </Button>,
    );
  });

  it("a way to another site opens beside the app, tells that site nothing of where it came from, and draws the sign of a way that leaves by itself", () => {
    render(
      <>
        <Button kind="quiet" href="https://help.mailprovider.example/app-passwords" outside>
          App passwords
        </Button>
        <Button kind="quiet" href="/settings/mailboxes">
          Mailboxes
        </Button>
      </>,
    );
    const out = screen.getByRole("link", { name: "App passwords" }) as HTMLAnchorElement;
    expect([out.target, out.rel.split(" ").sort()]).toEqual(["_blank", ["noopener", "noreferrer"]]);
    const here = screen.getByRole("link", { name: "Mailboxes" }) as HTMLAnchorElement;
    expect([here.target, here.hasAttribute("rel")]).toEqual(["", false]);
    /* The sign is drawn after the word and never said; a way inside the app has none. No caller hands it. */
    const signs = (link: HTMLElement) =>
      [...link.querySelectorAll("svg")].map((s) => s.getAttribute("aria-hidden"));
    expect([signs(out), signs(here)]).toEqual([["true"], []]);
    expect(out.lastElementChild?.tagName.toLowerCase()).toBe("svg");
  });

  it("carries its key beside its word", () => {
    render(<Button keyHint="r">Reply</Button>);
    expect(screen.getByRole("button").textContent).toBe("Replyr");
  });

  it("is named by its words alone: the key beside them is drawn and never said", () => {
    render(
      <Button keyHint="↵" keyShown>
        Sign in
      </Button>,
    );
    expect(
      screen.getByRole("button", { name: "Sign in" }).querySelector("kbd")?.getAttribute("aria-hidden"),
    ).toBe("true");
    cleanup();
    render(
      <Button keyHint="c" keyShown href="/join">
        Connect
      </Button>,
    );
    expect(screen.getByRole("link", { name: "Connect" })).toBeTruthy();
  });
});

describe("Button, with a mark after its word", () => {
  it("keeps its name and its state: the mark is drawn, never said", () => {
    const onPress = vi.fn();
    const { rerender } = render(
      <Button kind="two" size="s" mark="down" opens="menu" onPress={onPress}>
        Place
      </Button>,
    );
    const filter = screen.getByRole("button", { name: "Place" });
    expect(filter.getAttribute("aria-haspopup")).toBe("menu");
    expect(filter.querySelectorAll("svg")).toHaveLength(1);
    expect(filter.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    fireEvent.click(filter);
    expect(onPress).toHaveBeenCalledTimes(1);
    rerender(
      <Button kind="two" size="s" mark="x" pressed onPress={onPress}>
        News
      </Button>,
    );
    expect(screen.getByRole("button", { name: "News" }).getAttribute("aria-pressed")).toBe("true");
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

describe("Mark", () => {
  it("is the product's letters with their full stop, said as its name; the stop is drawn and says nothing", () => {
    const { container } = render(<Mark>oh</Mark>);
    const mark = screen.getByLabelText("oh.");
    expect(mark.textContent).toBe("oh");
    expect(container.querySelectorAll("button")).toHaveLength(0);
    expect(mark.querySelector("i")?.getAttribute("aria-hidden")).toBe("true");
    expect(mark.querySelector("[data-ringing]")).toBeNull();
  });

  it("its stop is a doorbell where it is handed one: named, and a press rings it once and tells, each press anew", () => {
    const onRing = vi.fn();
    render(
      <Mark hot bell={{ label: "Ring the doorbell", onRing }}>
        oh
      </Mark>,
    );
    const bell = screen.getByRole("button", { name: "Ring the doorbell" });
    expect(screen.getByLabelText("oh.").contains(bell)).toBe(true);
    expect([bell.getAttribute("data-kind"), bell.hasAttribute("data-ringing")]).toEqual(["hot", false]);
    bell.focus();
    fireEvent.click(bell);
    expect(bell.hasAttribute("data-ringing")).toBe(true);
    /* A second press is a ring of its own: the one that was playing is let go first, then it rings again. */
    const seen = new MutationObserver(() => {});
    seen.observe(bell, { attributes: true, attributeFilter: ["data-ringing"], attributeOldValue: true });
    fireEvent.click(bell);
    expect(seen.takeRecords().map((change) => change.oldValue)).toEqual(["", null]);
    seen.disconnect();
    expect(bell.hasAttribute("data-ringing")).toBe(true);
    /* The bell itself stays, and the keys on it. */
    expect([bell.isConnected, document.activeElement === bell]).toEqual([true, true]);
    expect(onRing).toHaveBeenCalledTimes(2);
  });

  it("rings once without a press where it is told to: with a bell or without one", () => {
    const { rerender, container } = render(<Mark hot>oh</Mark>);
    expect(container.querySelector("[data-ringing]")).toBeNull();
    rerender(
      <Mark hot ringing>
        oh
      </Mark>,
    );
    expect(container.querySelectorAll("[data-ringing]")).toHaveLength(1);
    rerender(
      <Mark hot ringing bell={{ label: "Ring the doorbell" }}>
        oh
      </Mark>,
    );
    expect(screen.getByRole("button", { name: "Ring the doorbell" }).hasAttribute("data-ringing")).toBe(true);
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

describe("Slot, off", () => {
  it("says it is unavailable and takes no press", () => {
    const onPress = vi.fn();
    render(
      <Slot disabled onPress={onPress}>
        News
      </Slot>,
    );
    const slot = screen.getByRole("button", { name: "News" }) as HTMLButtonElement;
    expect(slot.disabled).toBe(true);
    fireEvent.click(slot);
    expect(onPress).not.toHaveBeenCalled();
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

  it.each([
    ["its closing full stop is the dot, never both", "Connect your mailbox.", "Connect your mailbox", 1],
    ["ending on a word it gets the dot", "Welcome", "Welcome", 1],
    [
      "ending on another mark it is said as it stands, with no dot",
      "Still reading your mail…",
      "Still reading your mail…",
      0,
    ],
    ["a question keeps its mark and gets no dot", "Whose mail is this?", "Whose mail is this?", 0],
  ])("a sentence handed whole, as a catalogue writes it: %s", (_, written, read, dots) => {
    render(
      <Sentence size="xl" level={1} end="hot">
        {written}
      </Sentence>,
    );
    const heading = screen.getByRole("heading", { level: 1 });
    expect(heading.textContent).toBe(read);
    expect(heading.querySelectorAll("[aria-hidden='true']")).toHaveLength(dots);
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

  it("a blank can be filled by the browser, sent by a name and open a phone's keyboard for its kind", () => {
    render(
      <>
        <Blank
          label="email address"
          placeholder="email address"
          value=""
          name="email"
          autoComplete="username"
          inputMode="email"
          onChange={() => {}}
        />
        <Blank label="code" placeholder="code" value="" onChange={() => {}} />
      </>,
    );
    const filled = screen.getByRole("textbox", { name: "email address" }) as HTMLInputElement;
    expect([filled.name, filled.autocomplete, filled.inputMode]).toEqual(["email", "username", "email"]);
    const plain = screen.getByRole("textbox", { name: "code" }) as HTMLInputElement;
    expect([plain.name, plain.getAttribute("autocomplete"), plain.hasAttribute("inputmode")]).toEqual([
      "",
      "off",
      false,
    ]);
  });
});

describe("Field", () => {
  it("binds its label to the field and hands on what is typed", () => {
    const onChange = vi.fn();
    render(<Field label="Name" value="" onChange={onChange} />);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Mila" } });
    expect(onChange).toHaveBeenCalledWith("Mila");
  });

  it("says when it is left and when Enter is pressed in it, apart from what is typed, and cancels neither", () => {
    const [onChange, onLeave, onEnter, sent] = [vi.fn(), vi.fn(), vi.fn(), vi.fn()];
    render(
      <form onKeyDown={(event) => event.key === "Enter" && sent(event.defaultPrevented)}>
        <Field
          label="Email address"
          type="email"
          value="mila@"
          onChange={onChange}
          onLeave={onLeave}
          onEnter={onEnter}
        />
      </form>,
    );
    const box = screen.getByLabelText("Email address");
    box.focus();
    fireEvent.keyDown(box, { key: "a" });
    expect(onEnter).not.toHaveBeenCalled();
    /* Enter that ends an input method's composition takes the word it composed: it is not the field's Enter. */
    fireEvent.keyDown(box, { key: "Enter", isComposing: true });
    expect(onEnter).not.toHaveBeenCalled();
    fireEvent.keyDown(box, { key: "Enter" });
    expect(onEnter).toHaveBeenCalledTimes(1);
    /* The key goes on to the form around the field, as it was pressed. */
    expect(sent).toHaveBeenLastCalledWith(false);
    expect(onLeave).not.toHaveBeenCalled();
    fireEvent.blur(box);
    expect(onLeave).toHaveBeenCalledTimes(1);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("takes no Enter that commits an input method's word where the browser says only the input method's key code", () => {
    const onEnter = vi.fn();
    render(<Field label="Email address" type="email" value="mila@" onChange={() => {}} onEnter={onEnter} />);
    const box = screen.getByLabelText("Email address");
    /* Safari: the Enter that commits the composition says it is not composing, and carries the key code 229. */
    fireEvent.keyDown(box, { key: "Enter", keyCode: 229 });
    expect(onEnter).not.toHaveBeenCalled();
    fireEvent.keyDown(box, { key: "Enter", keyCode: 13 });
    expect(onEnter).toHaveBeenCalledTimes(1);
  });

  it("a field of several lines says when it is left, and Enter in it is a new line and nothing else", () => {
    const [onLeave, onEnter] = [vi.fn(), vi.fn()];
    render(<Field label="Note" lines={3} value="" onChange={() => {}} onLeave={onLeave} onEnter={onEnter} />);
    const box = screen.getByLabelText("Note");
    fireEvent.keyDown(box, { key: "Enter" });
    fireEvent.blur(box);
    expect([onEnter.mock.calls.length, onLeave.mock.calls.length]).toEqual([0, 1]);
  });

  it("says a refusal that appears while the keys are in the field: it lands in a polite live region that stood there", () => {
    const { rerender, container } = render(<Field label="Code" value="12" onChange={() => {}} />);
    const live = container.querySelector("[aria-live='polite']");
    expect(live).not.toBeNull();
    const box = screen.getByLabelText("Code");
    box.focus();
    rerender(<Field label="Code" value="12" onChange={() => {}} refusal="That code is not right." />);
    expect(container.querySelector("[aria-live='polite']")).toBe(live);
    expect(live?.textContent).toContain("That code is not right.");
    expect(document.activeElement).toBe(box);
  });

  it("off, takes no keys and says it is unavailable, in one line and in several", () => {
    const onChange = vi.fn();
    render(
      <>
        <Field label="Name" value="Mila" onChange={onChange} disabled />
        <Field label="Message" value="Back on Monday." lines={3} onChange={onChange} disabled />
      </>,
    );
    expect((screen.getByLabelText("Name") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText("Message") as HTMLTextAreaElement).disabled).toBe(true);
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

  it("opens a phone's number pad for a code, holds its length, and says what else describes it", () => {
    render(
      <>
        <p id="from-app">From your authenticator app.</p>
        <Field
          label="Code"
          value=""
          hint="Six digits"
          inputMode="numeric"
          maxLength={6}
          aria-describedby="from-app"
          onChange={() => {}}
        />
        <Field label="Name" value="" hint="As you sign" onChange={() => {}} />
      </>,
    );
    const said = (el: HTMLElement) =>
      el
        .getAttribute("aria-describedby")!
        .split(" ")
        .map((id) => document.getElementById(id)?.textContent);
    const code = screen.getByRole("textbox", { name: "Code" }) as HTMLInputElement;
    expect([code.inputMode, code.maxLength]).toEqual(["numeric", 6]);
    expect(said(code)).toEqual(["Six digits", "From your authenticator app."]);
    const name = screen.getByRole("textbox", { name: "Name" }) as HTMLInputElement;
    expect([name.hasAttribute("inputmode"), name.hasAttribute("maxlength")]).toEqual([false, false]);
    expect(said(name)).toEqual(["As you sign"]);
  });

  it("takes several lines", () => {
    render(<Field label="Signature" value={"Mila\nStudio"} lines={3} onChange={() => {}} />);
    expect((screen.getByLabelText("Signature") as HTMLTextAreaElement).rows).toBe(3);
  });
});

/**
 * A PASSWORD IS IN NO MARKUP. An input that is handed its value by React has it written into the element's `value`
 * attribute on every key, where a snapshot of the page, a report tool or any script that reads `outerHTML` finds it.
 * The kit never hands React a password, whatever a form hands the kit: what is typed stands in the field's own box
 * and in nothing the page's markup holds.
 *
 * PLANT (the controlled field): in `Field.tsx` or `Blank.tsx`, hand `value` to the `<input>` for a password as for
 * any other kind. The cases "is in no markup while it is typed, nor after the press" and "drawn on a server" are red.
 *
 * PLANT (the rule read from one draw alone): in `secret.ts`, hand back `secret ? undefined : value` and keep the
 * property in step only while `secret`. The two cases that show a password as text and hide it again are red.
 *
 * What was typed is looked for and never printed: each reading is a yes or a no.
 */
describe.each<[string, (p: SecretProps) => ReactNode]>([
  ["Field", (p) => <Field label="Password" type="password" {...p} />],
  ["Blank", (p) => <Blank label="Password" placeholder="type it" type="password" {...p} />],
])("a password in a %s", (kind, secret) => {
  const TYPED = "zq-typed-in-the-case-7c1f";
  const inMarkup = () => document.documentElement.outerHTML.includes(TYPED);
  const box = () => screen.getByLabelText("Password") as HTMLInputElement;
  const type = (value: string) => fireEvent.change(box(), { target: { value } });

  /** A form that keeps what is typed, as a form that validates on every key does, and empties it at its press. */
  function Keeping({ taken, start = "" }: { taken?: (typed: string) => void; start?: string }) {
    const [held, setHeld] = useState(start);
    return (
      <form>
        {secret({ value: held, onChange: setHeld })}
        <Button
          onPress={() => {
            taken?.(held);
            setHeld("");
          }}
        >
          Sign in
        </Button>
      </form>
    );
  }

  it("is in no markup while it is typed, nor after the press, in a form that keeps what is typed", () => {
    const taken = vi.fn();
    render(<Keeping taken={taken} />);
    expect(inMarkup()).toBe(false);
    type(TYPED);
    /* The field holds it, and the form was handed it: only the markup has none of it. */
    expect(box().value === TYPED).toBe(true);
    expect(box().hasAttribute("value")).toBe(false);
    expect(inMarkup()).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(taken.mock.calls.length === 1 && taken.mock.calls[0]![0] === TYPED).toBe(true);
    expect(inMarkup()).toBe(false);
    /* The form emptied what it holds: the field's own box follows it. */
    expect(box().value).toBe("");
  });

  it("is the field's alone in a form that hands no value: taken and emptied through the field itself", () => {
    const at: { current: HTMLInputElement | null } = { current: null };
    const filled = vi.fn();
    render(secret({ ref: at, onChange: (typed) => filled(typed !== "") }));
    expect(at.current).toBe(box());
    type(TYPED);
    expect(filled.mock.calls).toEqual([[true]]);
    expect(at.current!.value === TYPED).toBe(true);
    expect(inMarkup()).toBe(false);
    at.current!.value = "";
    expect(box().value).toBe("");
    expect(inMarkup()).toBe(false);
  });

  it("takes keys with nothing handed to it at all: it is read only for nobody", () => {
    render(secret({}));
    expect(box().readOnly).toBe(false);
    type(TYPED);
    expect(box().value === TYPED).toBe(true);
    expect(inMarkup()).toBe(false);
  });

  it("drawn again over what a form still holds, it shows that and still writes none of it", () => {
    const first = render(<Keeping start={TYPED} />);
    expect(box().value === TYPED).toBe(true);
    expect(inMarkup()).toBe(false);
    first.unmount();
    render(<Keeping start={TYPED} />);
    expect(box().value === TYPED).toBe(true);
    expect(box().hasAttribute("value")).toBe(false);
    expect(inMarkup()).toBe(false);
  });

  /** A form that keeps what is typed and has a control that shows the password as text and hides it again. */
  function Showing({ start }: { start: boolean }) {
    const [held, setHeld] = useState("");
    const [shown, setShown] = useState(start);
    return (
      <form>
        {kind === "Blank" ? (
          <Blank
            label="Password"
            placeholder="type it"
            type={shown ? "text" : "password"}
            value={held}
            onChange={setHeld}
          />
        ) : shown ? (
          <Field label="Password" type="text" value={held} onChange={setHeld} />
        ) : (
          <Field label="Password" type="password" value={held} onChange={setHeld} />
        )}
        <Button onPress={() => setShown(!shown)}>Show</Button>
      </form>
    );
  }
  const show = () => fireEvent.click(screen.getByRole("button", { name: "Show" }));
  const read = () => ({
    markup: inMarkup(),
    attribute: box().hasAttribute("value"),
    holds: box().value === TYPED,
    type: box().type,
  });

  it("shown as text and hidden again, it is in no markup in any phase, and the box shows it throughout", () => {
    render(<Showing start={false} />);
    type(TYPED);
    const hidden = read();
    show();
    const shown = read();
    show();
    const again = read();
    expect({ hidden, shown, again }).toEqual({
      hidden: { markup: false, attribute: false, holds: true, type: "password" },
      shown: { markup: false, attribute: false, holds: true, type: "text" },
      again: { markup: false, attribute: false, holds: true, type: "password" },
    });
  });

  it("drawn as text first and then hidden, what the draw as text wrote into the markup is cleared", () => {
    render(<Showing start />);
    type(TYPED);
    show();
    expect(read()).toEqual({ markup: false, attribute: false, holds: true, type: "password" });
    /* Shown again, it stays out of the markup: the rule holds for the element's life. */
    show();
    expect(read()).toEqual({ markup: false, attribute: false, holds: true, type: "text" });
  });

  it("drawn on a server with a value in hand, its markup holds none", () => {
    expect(renderToStaticMarkup(secret({ value: TYPED, onChange: () => {} })).includes(TYPED)).toBe(false);
  });

  it("is filled by the browser as the form says, off unless said, and is sent by no name unless handed one", () => {
    const plain = render(secret({}));
    expect([box().getAttribute("autocomplete"), box().hasAttribute("name"), box().type]).toEqual([
      "off",
      false,
      "password",
    ]);
    plain.unmount();
    render(secret({ autoComplete: "current-password", name: "password" }));
    expect([box().getAttribute("autocomplete"), box().name]).toEqual(["current-password", "password"]);
  });
});

describe("FieldStack", () => {
  it("holds a form's fields in their order and adds nothing a screen reader hears: each field keeps its own label", () => {
    render(
      <FieldStack>
        <FieldPair>
          <Field label="IMAP host" value="imap.lichtgrat.example" onChange={() => {}} />
          <Field label="Port" value="993" inputMode="numeric" onChange={() => {}} />
        </FieldPair>
        <Field label="Username" value="" onChange={() => {}} />
        <Switch label="Implicit TLS" on labelled />
      </FieldStack>,
    );
    expect(
      screen.getAllByRole("textbox").map((box) => (box as HTMLInputElement).labels?.[0]?.textContent),
    ).toEqual(["IMAP host", "Port", "Username"]);
    expect(screen.getByRole("switch", { name: "Implicit TLS" })).toBeTruthy();
    expect(screen.queryByRole("group")).toBeNull();
  });
});

describe("ChoiceTiles", () => {
  const options = [
    { value: "gmail", label: "Gmail" },
    { value: "icloud", label: "iCloud", dim: true },
    { value: "other", label: "Other (IMAP)" },
  ] as const;

  it("is a named group of presses: the taken one says so, the one Enter takes prints its key, a press takes any", () => {
    const onChange = vi.fn();
    render(
      <ChoiceTiles
        label="Mail providers"
        options={options}
        value="gmail"
        enter={{ value: "gmail", keyHint: "↵" }}
        onChange={onChange}
      />,
    );
    const group = screen.getByRole("group", { name: "Mail providers" });
    const tiles = within(group).getAllByRole("button");
    expect(tiles.map((tile) => tile.getAttribute("aria-pressed"))).toEqual(["true", "false", "false"]);
    /* The key is printed on the tile as on every button: where a face shows it, it is read with the tile's word. */
    expect(within(group).getByRole("button", { name: /^Gmail/ })).toBe(tiles[0]);
    expect(tiles.map((tile) => tile.querySelector("kbd")?.textContent ?? null)).toEqual(["↵", null, null]);
    /* One that does not fit what was typed steps back, and can still be pressed. */
    fireEvent.click(within(group).getByRole("button", { name: "iCloud" }));
    expect(onChange.mock.calls).toEqual([["icloud"]]);
  });

  /* `forms-in-a-browser.test.tsx` walks the same with the real Tab key in a real browser. */
  it("is one stop of Tab, on the taken tile or else the first; the arrows, Home and End move the keys and take none", () => {
    const onChange = vi.fn();
    const drawn = render(
      <ChoiceTiles label="Mail providers" options={options} value="icloud" onChange={onChange} />,
    );
    const tiles = () => screen.getAllByRole("button");
    /** Which tiles Tab stops on, by their words. */
    const stops = () =>
      tiles()
        .filter((tile) => tile.tabIndex === 0)
        .map((tile) => tile.querySelector("span")?.textContent);
    const keysOn = () => document.activeElement?.querySelector("span")?.textContent ?? null;
    const press = (key: string) => fireEvent.keyDown(document.activeElement!, { key });
    /* Tab enters on the taken tile, not on the first. */
    expect(stops()).toEqual(["iCloud"]);
    tiles()[1]!.focus();
    press("ArrowRight");
    expect(keysOn()).toBe("Other (IMAP)");
    press("ArrowRight");
    expect(keysOn()).toBe("Gmail");
    press("End");
    expect(keysOn()).toBe("Other (IMAP)");
    press("Home");
    expect(keysOn()).toBe("Gmail");
    press("ArrowLeft");
    expect(keysOn()).toBe("Other (IMAP)");
    expect(onChange).not.toHaveBeenCalled();
    /* The one stop is where the keys are, so Tab leaves the group from there. */
    expect(stops()).toEqual(["Other (IMAP)"]);
    /* The keys gone, the stop is the taken tile again. */
    fireEvent.blur(document.activeElement!, { relatedTarget: document.body });
    expect(stops()).toEqual(["iCloud"]);
    drawn.unmount();
    render(<ChoiceTiles label="Mail providers" options={options} value={null} />);
    expect(stops()).toEqual(["Gmail"]);
  });

  it("with none taken, none says it is", () => {
    render(<ChoiceTiles label="Mail providers" options={options} value={null} />);
    expect(screen.getAllByRole("button").map((tile) => tile.getAttribute("aria-pressed"))).toEqual([
      "false",
      "false",
      "false",
    ]);
  });
});

describe("FindField", () => {
  it("offers while it is typed in where it is handed a list's field: a combobox by its name, the caret kept", () => {
    function Find() {
      const [text, setText] = useState("");
      const offers = useSuggestions({
        id: "find-list",
        text,
        onText: setText,
        own: (typed) => [{ rows: typed ? [{ id: "seen", primary: "Seen", secondary: "Winterthur" }] : [] }],
        free: true,
        onTake: (row) => setText(row.primary),
      });
      return (
        <>
          <FindField label="Place" value={text} sign="place" suggests={offers.field} />
          <SuggestionList {...offers.list} label="Place suggestions" placement="inline" />
        </>
      );
    }
    render(<Find />);
    const field = screen.getByRole("combobox", { name: "Place" }) as HTMLInputElement;
    expect(field.readOnly).toBe(false);
    fireEvent.change(field, { target: { value: "se" } });
    expect(field.value).toBe("se");
    expect(field.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(screen.getByRole("option"));
    expect(field.value).toBe("Seen");
    expect(field.getAttribute("aria-expanded")).toBe("false");
  });

  it("is a textbox named by its label, in no form, and hands what is typed and the keys to the app", () => {
    const [onChange, onKeyDown] = [vi.fn(), vi.fn()];
    render(
      <FindField
        label="Search"
        placeholder="Search mail"
        value=""
        onChange={onChange}
        onKeyDown={onKeyDown}
      />,
    );
    const box = screen.getByRole("textbox", { name: "Search" }) as HTMLInputElement;
    expect(box.form).toBeNull();
    expect(box.getAttribute("name")).toBeNull();
    expect(box.placeholder).toBe("Search mail");
    fireEvent.change(box, { target: { value: "glaze" } });
    expect(onChange).toHaveBeenCalledWith("glaze");
    fireEvent.keyDown(box, { key: "Enter" });
    expect(onKeyDown).toHaveBeenCalledTimes(1);
  });

  it("stands what the words are narrowed to before them, as one control that takes it off", () => {
    const onRemove = vi.fn();
    render(
      <FindField
        label="Search"
        value=""
        chip={{
          label: "Petra Wyss",
          person: { name: "Petra Wyss", address: "petra@makersfest.example" },
          remove: "Remove Petra Wyss",
          onRemove,
        }}
      />,
    );
    const chip = screen.getByRole("button", { name: "Remove Petra Wyss" });
    expect(chip.textContent).toContain("Petra Wyss");
    const box = screen.getByRole("textbox", { name: "Search" });
    expect(chip.compareDocumentPosition(box) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(chip);
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  it("offers the way to empty it only while there are words, and says what the search took", () => {
    const onPress = vi.fn();
    const { rerender } = render(
      <FindField label="Search" value="" took="0.12 s" clear={{ label: "Clear", onPress }} />,
    );
    expect(screen.queryByRole("button", { name: "Clear" })).toBeNull();
    expect(screen.getByText("0.12 s")).toBeTruthy();
    rerender(<FindField label="Search" value="glaze" took="0.12 s" clear={{ label: "Clear", onPress }} />);
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it("takes a press on its box as a press on the words: the keys go to the field", () => {
    const { container } = render(<FindField label="Search" value="" onChange={() => {}} />);
    fireEvent.click(container.firstElementChild!);
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Search" }));
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
