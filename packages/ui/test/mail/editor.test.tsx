/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Attach,
  AttachRoom,
  Composer,
  DraftControl,
  DraftTabs,
  Files,
  FileTile,
  Recipients,
  SendStatus,
  type ComposerProps,
  type Landing,
  type RecipientLine,
  type RecipientsProps,
} from "../../src/mail/index.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const person = (name: string, address: string) => ({ id: address, name, address, remove: `Remove ${name}` });
const BEN = person("Ben Arnold", "ben@lichtgrat.example");
const RAHEL = person("Rahel Beck", "rahel@lichtgrat.example");
const GIULIA = person("Giulia Ferrari", "giulia@terracotta-milano.example");
const LINES: RecipientLine[] = [
  { id: "to", label: "To", people: [BEN, RAHEL], typed: "" },
  { id: "cc", label: "Cc", people: [GIULIA], typed: "" },
  { id: "bcc", label: "Bcc", people: [], typed: "" },
];

describe("Recipients", () => {
  it("names each line's place to type, and hands on what is typed and what is entered", () => {
    const [onType, onCommit] = [vi.fn(), vi.fn()];
    render(
      <Recipients
        lines={[{ ...LINES[0]!, typed: "tim@gassenblatt.example" }, LINES[1]!]}
        onType={onType}
        onCommit={onCommit}
      />,
    );
    const to = screen.getByRole("textbox", { name: "To" });
    fireEvent.change(to, { target: { value: "tim@gassenblatt.example " } });
    expect(onType).toHaveBeenCalledWith("to", "tim@gassenblatt.example ");
    fireEvent.keyDown(to, { key: "Enter" });
    expect(onCommit).toHaveBeenCalledWith("to", "tim@gassenblatt.example");
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Cc" }), { key: "Enter" });
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it("takes the last person off with Backspace in an empty line, and walks to them with the arrow", () => {
    const onRemove = vi.fn();
    render(<Recipients lines={LINES} onRemove={onRemove} />);
    const to = screen.getByRole("textbox", { name: "To" });
    fireEvent.keyDown(to, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /^Rahel Beck/ }));
    fireEvent.keyDown(document.activeElement!, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /^B?\s*Ben Arnold/ }));
    fireEvent.keyDown(to, { key: "Backspace" });
    expect(onRemove).toHaveBeenCalledWith(RAHEL.id);
  });

  it("opens a person's menu on a press and takes them off by their own button, the keys going to the line", () => {
    const [onPerson, onRemove] = [vi.fn(), vi.fn()];
    render(<Recipients lines={LINES} onPerson={onPerson} onRemove={onRemove} />);
    const ben = screen.getByRole("button", { name: /^B?\s*Ben Arnold/ });
    fireEvent.click(ben);
    expect(onPerson).toHaveBeenCalledWith(BEN.id, ben);
    fireEvent.click(screen.getByRole("button", { name: "Remove Ben Arnold" }));
    expect(onRemove).toHaveBeenCalledWith(BEN.id);
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "To" }));
  });

  /** A list the test moves people in, as an app would. */
  function Moving({ seen }: { seen: (person: string, to: Landing) => void }) {
    const [lines, setLines] = useState(LINES);
    const onMove: RecipientsProps["onMove"] = (id, to) => {
      seen(id, to);
      const who = lines.flatMap((l) => l.people).find((p) => p.id === id)!;
      setLines(
        lines.map((l) => {
          const people = l.people.filter((p) => p.id !== id);
          return l.id === to.line
            ? { ...l, people: [...people.slice(0, to.index), who, ...people.slice(to.index)] }
            : { ...l, people };
        }),
      );
    };
    return <Recipients lines={lines} onMove={onMove} />;
  }
  const namesIn = (line: string) =>
    within(screen.getByRole("group", { name: line }))
      .getAllByRole("button", { name: /@/ })
      .map((b) => b.textContent);

  it("moves a person along its line and between the lines with Alt and the arrows, and keeps the keys on them", () => {
    const seen = vi.fn();
    render(<Moving seen={seen} />);
    const ben = () => screen.getByRole("button", { name: /^B?\s*Ben Arnold/ });
    ben().focus();
    fireEvent.keyDown(ben(), { key: "ArrowLeft", altKey: true });
    expect(seen).not.toHaveBeenCalled();
    fireEvent.keyDown(ben(), { key: "ArrowRight", altKey: true });
    expect(seen).toHaveBeenLastCalledWith(BEN.id, { line: "to", index: 1 });
    expect(namesIn("To").join(" | ")).toMatch(/Rahel Beck.*\|.*Ben Arnold/);
    expect(document.activeElement).toBe(ben());
    fireEvent.keyDown(ben(), { key: "ArrowDown", altKey: true });
    expect(seen).toHaveBeenLastCalledWith(BEN.id, { line: "cc", index: 1 });
    expect(namesIn("Cc").join(" | ")).toMatch(/Giulia Ferrari.*\|.*Ben Arnold/);
    expect(document.activeElement).toBe(ben());
  });

  it("lifts a person with the pointer and lands them where they are let go; Esc puts them back", () => {
    /* The lines one under the other, 32 high; a person 100 wide, one after the other. */
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      const lineOf = (el: Element | null) => el?.closest("[data-line-id]")?.getAttribute("data-line-id");
      const row = ["to", "cc", "bcc"].indexOf(lineOf(this) ?? "") * 40;
      const peers = [...(this.closest("[data-line-id]")?.querySelectorAll("[data-person]") ?? [])];
      const who = this.matches("[data-person]") ? this : this.querySelector(":scope > [data-person]");
      const at = who ? peers.indexOf(who) : -1;
      const [left, width] = at >= 0 ? [60 + at * 104, 100] : [0, 700];
      return {
        left,
        top: row,
        right: left + width,
        bottom: row + 32,
        width,
        height: 32,
        x: left,
        y: row,
      } as DOMRect;
    });
    const point = (el: Element, type: string, x: number, y: number) => {
      const event = new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX: x,
        clientY: y,
        button: 0,
      });
      Object.defineProperty(event, "pointerId", { value: 1 });
      fireEvent(el, event);
    };
    const [seen, onLift] = [vi.fn(), vi.fn()];
    render(<Recipients lines={LINES} onMove={seen} onLift={onLift} />);
    const ben = screen.getByRole("button", { name: /^B?\s*Ben Arnold/ });
    point(ben, "pointerdown", 70, 10);
    point(ben, "pointermove", 72, 11);
    expect(onLift).not.toHaveBeenCalled();
    point(ben, "pointermove", 400, 50);
    expect(onLift).toHaveBeenCalledTimes(1);
    point(ben, "pointerup", 400, 50);
    expect(seen).toHaveBeenCalledWith(BEN.id, { line: "cc", index: 1 });

    point(ben, "pointerdown", 70, 10);
    point(ben, "pointermove", 20, 50);
    fireEvent.keyDown(ben, { key: "Escape" });
    point(ben, "pointerup", 20, 50);
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it("keeps a refused person on the line, marked, and never drops them", () => {
    const refused = { id: "x", name: "petra@makersfest", refused: true, remove: "Remove petra@makersfest" };
    render(
      <Recipients
        lines={[{ ...LINES[0]!, people: [BEN, refused] }]}
        refusal="Not an address: petra@makersfest"
      />,
    );
    const said = screen.getByRole("button", { name: /^petra@makersfest$/ }).getAttribute("aria-describedby");
    expect(document.getElementById(said!)?.textContent).toBe("Not an address: petra@makersfest");
    expect(screen.getByRole("button", { name: /^petra@makersfest$/ }).getAttribute("aria-invalid")).toBe(
      "true",
    );
    expect(screen.getByRole("button", { name: /^B?\s*Ben Arnold/ }).hasAttribute("aria-invalid")).toBe(false);
  });

  it("folds a reply's recipients into names, with the way to change them and to more lines", () => {
    const [onChange, onMore] = [vi.fn(), vi.fn()];
    const { rerender } = render(
      <Recipients
        reply
        lines={LINES}
        folded={{
          label: "To",
          names: "Giulia Ferrari",
          change: { label: "Change recipients", onPress: onChange },
        }}
      />,
    );
    expect(screen.getByText("Giulia Ferrari")).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: "To" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Change recipients" }));
    expect(onChange).toHaveBeenCalledTimes(1);
    rerender(<Recipients lines={LINES.slice(0, 1)} more={{ label: "Cc Bcc", onPress: onMore }} />);
    fireEvent.click(screen.getByRole("button", { name: "Cc Bcc" }));
    expect(onMore).toHaveBeenCalledTimes(1);
  });

  it("types the subject, and holds everything while the letter sends", () => {
    const onSubject = vi.fn();
    const subject = { label: "Subject", placeholder: "Subject", value: "Glaze order", onChange: onSubject };
    const { rerender } = render(<Recipients lines={LINES} subject={subject} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Subject" }), {
      target: { value: "Glaze order #2291" },
    });
    expect(onSubject).toHaveBeenCalledWith("Glaze order #2291");
    rerender(<Recipients lines={LINES} subject={subject} locked />);
    expect((screen.getByRole("button", { name: /^B?\s*Ben Arnold/ }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(screen.queryByRole("button", { name: "Remove Ben Arnold" })).toBeNull();
    expect((screen.getByRole("textbox", { name: "To" }) as HTMLInputElement).readOnly).toBe(true);
  });
});

describe("Composer", () => {
  const frame = (more: Partial<ComposerProps> = {}): ComposerProps => ({
    label: "New message",
    head: <p>head</p>,
    children: "Buongiorno Giulia",
    foot: { label: "Add to the message" },
    ...more,
  });

  it("is a named sheet with the text handed in, and its marks say whether they hold", () => {
    const [onBold, onLink] = [vi.fn(), vi.fn()];
    render(
      <Composer
        {...frame({
          marks: {
            label: "Formatting",
            groups: [
              [
                {
                  id: "bold",
                  label: "Bold",
                  title: "Bold · ⌘B",
                  glyph: { letter: "B", as: "bold" },
                  pressed: true,
                  onPress: onBold,
                },
              ],
              [{ id: "link", label: "Link", icon: "link", disabled: true, onPress: onLink }],
            ],
          },
        })}
      />,
    );
    const sheet = screen.getByRole("region", { name: "New message" });
    expect(within(sheet).getByText("Buongiorno Giulia")).toBeTruthy();
    const marks = within(sheet).getByRole("toolbar", { name: "Formatting" });
    const bold = within(marks).getByRole("button", { name: "Bold" });
    expect(bold.getAttribute("title")).toBe("Bold · ⌘B");
    expect(within(marks).getByRole("button", { name: "Link" }).getAttribute("title")).toBe("Link");
    expect(bold.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(bold);
    fireEvent.click(within(marks).getByRole("button", { name: "Link" }));
    expect([onBold.mock.calls.length, onLink.mock.calls.length]).toEqual([1, 0]);
  });

  it("carries the foot's controls, the signature with its way off, and says when a draft is being written", () => {
    const [onFormat, onEmoji, onOff, onSigned] = [vi.fn(), vi.fn(), vi.fn(), vi.fn()];
    render(
      <Composer
        {...frame({
          drafting: true,
          signature: {
            label: "Signature",
            text: "Mila Brunner\nLichtgrat · Winterthur",
            onChange: onSigned,
            remove: { label: "Remove signature", onPress: onOff },
          },
          foot: {
            label: "Add to the message",
            format: { label: "Hide formatting", word: "Aa", pressed: true, onPress: onFormat },
            emoji: { label: "Emoji", onPress: onEmoji },
          },
        })}
      />,
    );
    const foot = screen.getByRole("toolbar", { name: "Add to the message" });
    const format = within(foot).getByRole("button", { name: "Hide formatting" });
    expect(format.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(format);
    const emoji = within(foot).getByRole("button", { name: "Emoji" });
    fireEvent.click(emoji);
    expect(onFormat).toHaveBeenCalledTimes(1);
    expect(onEmoji).toHaveBeenCalledWith(emoji);
    const signed = screen.getByRole("textbox", { name: "Signature" });
    expect(signed.textContent).toBe("Mila Brunner\nLichtgrat · Winterthur");
    signed.textContent = "Mila";
    fireEvent.blur(signed);
    expect(onSigned).toHaveBeenCalledWith("Mila");
    fireEvent.click(screen.getByRole("button", { name: "Remove signature" }));
    expect(onOff).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("region", { name: "New message" }).getAttribute("aria-busy")).toBe("true");
  });

  it("keeps a draft's files in its box: a way off each, a picture's small look, and a heading over what was forwarded", () => {
    const [onOff, onLook] = [vi.fn(), vi.fn()];
    render(
      <Composer
        {...frame({
          forwarded: {
            heading: "Forwarded with it",
            files: (
              <Files>
                <FileTile
                  kind="PDF"
                  name="glaze-recipes.pdf"
                  size="240 KB"
                  off={{ label: "Remove glaze-recipes.pdf" }}
                />
              </Files>
            ),
          },
          files: (
            <Files>
              <FileTile
                kind="JPG"
                name="grat-01.jpg"
                size="713 KB"
                look={<img alt="" src="data:," />}
                main={{ label: "Preview grat-01.jpg", onPress: onLook }}
                off={{ label: "Remove grat-01.jpg", onPress: onOff }}
              />
            </Files>
          ),
        })}
      />,
    );
    const sheet = screen.getByRole("region", { name: "New message" });
    const heading = within(sheet).getByRole("heading", { name: "Forwarded with it" });
    const [first, second] = within(sheet).getAllByText(/\.(pdf|jpg)$/);
    expect(first!.textContent).toBe("glaze-recipes.pdf");
    expect(heading.compareDocumentPosition(first!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(second!.textContent).toBe("grat-01.jpg");
    /* What cannot be looked at is no button: its one press is the way off. */
    expect(within(sheet).queryByRole("button", { name: /Preview glaze/ })).toBeNull();
    const look = within(sheet).getByRole("button", { name: "Preview grat-01.jpg" });
    expect(look.querySelector("img")).toBeTruthy();
    expect(look.textContent).not.toContain("JPG");
    fireEvent.click(look);
    fireEvent.click(within(sheet).getByRole("button", { name: "Remove grat-01.jpg" }));
    expect([onLook.mock.calls.length, onOff.mock.calls.length]).toEqual([1, 1]);
  });

  it("hands on the files let go over the letter, and nothing else that is dragged over it", () => {
    const onFiles = vi.fn();
    render(<Composer {...frame({ onFiles })} />);
    const sheet = screen.getByRole("region", { name: "New message" });
    const file = new File(["a"], "grat-01.jpg", { type: "image/jpeg" });
    fireEvent.drop(sheet, { dataTransfer: { types: ["text/plain"], files: [] } });
    expect(onFiles).not.toHaveBeenCalled();
    fireEvent.dragEnter(sheet, { dataTransfer: { types: ["Files"], files: [file] } });
    fireEvent.drop(sheet, { dataTransfer: { types: ["Files"], files: [file] } });
    expect(onFiles).toHaveBeenCalledWith([file]);
  });
});

describe("DraftControl", () => {
  it("says what a press does, with its price beside it, and runs", () => {
    const onPress = vi.fn();
    render(
      <DraftControl
        label="Draft reply"
        title="Draft reply · 15 credits"
        cost="15 credits"
        onPress={onPress}
      />,
    );
    const control = screen.getByRole("button", { name: "Draft reply" });
    expect(control.getAttribute("title")).toBe("Draft reply · 15 credits");
    expect(screen.getByText("15 credits")).toBeTruthy();
    fireEvent.click(control);
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it("keeps its whole name where fewer words are drawn", () => {
    render(
      <DraftControl label="Draft from your text" short="Draft from text" title="Draft from your text" />,
    );
    expect(screen.getByRole("button", { name: "Draft from your text" })).toBeTruthy();
  });

  it("stands quiet with nothing to draft from, without a price, and still takes the press", () => {
    const onPress = vi.fn();
    render(
      <DraftControl
        idle
        label="Draft from your text"
        title="Draft from your text · a few words first"
        cost="15 credits"
        onPress={onPress}
      />,
    );
    const control = screen.getByRole("button", { name: "Draft from your text" }) as HTMLButtonElement;
    expect(control.getAttribute("aria-disabled")).toBe("true");
    expect(control.disabled).toBe(false);
    expect(screen.queryByText("15 credits")).toBeNull();
    fireEvent.click(control);
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it("rests while it drafts", () => {
    const onPress = vi.fn();
    render(<DraftControl busy label="Drafting" title="Drafting" onPress={onPress} />);
    const control = screen.getByRole("button", { name: "Drafting" }) as HTMLButtonElement;
    expect(control.getAttribute("aria-busy")).toBe("true");
    fireEvent.click(control);
    expect(onPress).not.toHaveBeenCalled();
  });
});

describe("DraftTabs", () => {
  it("switches between the two texts and says which one is pressed", () => {
    const onChange = vi.fn();
    render(
      <DraftTabs
        label="The text"
        options={[
          { value: "mine", label: "Your text" },
          { value: "draft", label: "Draft" },
        ]}
        value="draft"
        onChange={onChange}
      />,
    );
    const tabs = screen.getByRole("group", { name: "The text" });
    expect(within(tabs).getByRole("button", { name: "Draft" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(within(tabs).getByRole("button", { name: "Your text" }));
    expect(onChange).toHaveBeenCalledWith("mine");
  });
});

describe("Attach", () => {
  it("is one button that says the limit; a press opens the system's own dialog, and every file chosen there is handed on", () => {
    let picker: HTMLInputElement | undefined;
    vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(function (this: HTMLInputElement) {
      picker = this;
    });
    const onFiles = vi.fn();
    render(<Attach label="Attach · 25 MB a message" onFiles={onFiles} />);
    expect(screen.getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual([
      "Attach · 25 MB a message",
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Attach · 25 MB a message" }));
    expect(picker?.type).toBe("file");
    const files = [new File(["a"], "grat-01.jpg"), new File(["b"], "grat-02.jpg")];
    fireEvent.change(picker!, { target: { files } });
    expect(onFiles).toHaveBeenCalledWith(files);
  });

  it("says under the sheet how much of the room is used", () => {
    render(<AttachRoom weight="7.3 → 2.1 MB" used="2.1 of 19.1 MB" />);
    expect(screen.getByText("2.1 of 19.1 MB")).toBeTruthy();
    expect(screen.getByText("7.3 → 2.1 MB")).toBeTruthy();
  });
});

describe("SendStatus", () => {
  it("leads with the heavy words, then the reason, as a status", () => {
    render(
      <SendStatus place="foot" verdict="Not sent.">
        Sending did not work, but your draft is kept, so try again.
      </SendStatus>,
    );
    expect(screen.getByRole("status").textContent).toBe(
      "Not sent. Sending did not work, but your draft is kept, so try again.",
    );
  });

  it("offers the two answers where ohmail cannot know, and a short line its one way on", () => {
    const [again, was, way] = [vi.fn(), vi.fn(), vi.fn()];
    const { rerender } = render(
      <SendStatus
        place="top"
        verdict="We're not sure this was sent."
        acts={[
          { label: "Send again", onPress: again },
          { label: "It was sent", onPress: was },
        ]}
      >
        The connection broke while it was on its way.
      </SendStatus>,
    );
    /* One second button; the other answer is a word that acts. */
    expect(
      ["Send again", "It was sent"].map((name) =>
        screen.getByRole("button", { name }).getAttribute("data-kind"),
      ),
    ).toEqual(["two", "quiet"]);
    fireEvent.click(screen.getByRole("button", { name: "Send again" }));
    fireEvent.click(screen.getByRole("button", { name: "It was sent" }));
    expect([again.mock.calls.length, was.mock.calls.length]).toEqual([1, 1]);
    rerender(
      <SendStatus place="end" acts={[{ label: "Settings", onPress: way }]}>
        Drafting is switched off.
      </SendStatus>,
    );
    expect(screen.getByRole("status").textContent).toContain("Drafting is switched off.");
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(way).toHaveBeenCalledTimes(1);
  });
});
