/** @vitest-environment jsdom */
/**
 * THE LETTER'S TWO EDITORS, through what the screen hands them and reads back: the rich one reports a plain note
 * with no markup and a marked one with it, says nothing at mount, locks without losing a word, hands Mod+Enter and
 * an untaken Escape to the screen, asks a link's address and refuses a scheme a mail client cannot open, and reports
 * the links it draws. The plain one offers no marks at all.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { Editor as TiptapEditor } from "@tiptap/react";
import { Composer, letterText } from "@ohmail/ui/mail";
import type { RichValue } from "@ohmail/app-logic/writing/rich-text";
import { TextProvider } from "../../src/text/index.js";
import type { EditorHandle, WriteEditor } from "../../src/write/ports.js";
import { richEditor } from "../../src/write/editor/index.js";
import { EXTENSIONS } from "../../src/write/editor/schema.js";
import { LETTER_TEXT, LetterNames } from "../../src/write/editor/letter-names.js";
import { plainEditor } from "../../src/write/plain/index.js";
import { useMarks } from "../../src/write/text/Marks.js";
import writeEn from "../../messages/write.en.json" with { type: "json" };

const W = writeEn.write;

beforeAll(() => {
  const empty = () => Object.assign([], { item: () => null }) as unknown as DOMRectList;
  for (const proto of [Range.prototype, Element.prototype] as {
    getClientRects?: unknown;
    getBoundingClientRect?: unknown;
  }[]) {
    if (typeof proto.getClientRects !== "function") proto.getClientRects = empty;
    if (typeof proto.getBoundingClientRect !== "function")
      proto.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0);
  }
  Element.prototype.animate ??= () => ({ cancel() {} }) as unknown as Animation;
});
afterEach(cleanup);

interface Mounted {
  readonly said: RichValue[];
  readonly keys: string[];
  readonly rendered: (readonly string[])[];
  handle(): EditorHandle;
  lock(editable: boolean): void;
  /** A value handed in from outside, as a draft lands. */
  land(value: RichValue): void;
}

function mount(
  Editor: WriteEditor,
  initial: RichValue = { text: "", html: "" },
  quotedHistory?: import("../../src/write/ports.js").EditorProps["quotedHistory"],
): Mounted {
  const said: RichValue[] = [];
  const keys: string[] = [];
  let handle: EditorHandle | null = null;
  let lock: (editable: boolean) => void = () => undefined;
  let land: (value: RichValue) => void = () => undefined;
  function Screen() {
    const [value, setValue] = useState(initial);
    land = setValue;
    const [editable, setEditable] = useState(true);
    const [held, setHeld] = useState<EditorHandle | null>(null);
    lock = setEditable;
    handle = held;
    const marks = useMarks(held, editable);
    return (
      <>
        <Composer
          label="New message"
          head={null}
          marks={marks.strip}
          foot={{ label: W.foot, format: marks.format }}
        >
          <Editor
            quotedHistory={quotedHistory}
            value={value}
            onChange={(next) => {
              said.push(next);
              setValue(next);
            }}
            label={W.text}
            placeholder={W.placeholder}
            editable={editable}
            focusAtMount={false}
            onSendKey={() => keys.push("send")}
            onLeaveKey={() => keys.push("leave")}
            onHandle={setHeld}
          />
        </Composer>
        {marks.card}
      </>
    );
  }
  render(
    <TextProvider locale="en" messages={{ write: W } as never} timeZone="Europe/Zurich">
      <Screen />
    </TextProvider>,
  );
  return {
    said,
    keys,
    rendered: RENDERED,
    handle: () => {
      if (handle === null) throw new Error("the editor handed no handle");
      return handle;
    },
    lock: (editable) => act(() => lock(editable)),
    land: (value) => act(() => land(value)),
  };
}

const RENDERED: (readonly string[])[] = [];
const rich = richEditor({
  href: (raw) => {
    try {
      const url = new URL(raw);
      return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
    } catch {
      return null;
    }
  },
  useRendered: (hrefs) => {
    if (RENDERED.at(-1) !== hrefs) RENDERED.push(hrefs);
  },
});

const surface = (): HTMLElement => screen.getByRole("textbox", { name: W.text });
const mark = (name: string): HTMLButtonElement => screen.getByRole("button", { name }) as HTMLButtonElement;
const type = (m: Mounted, text: string): void =>
  act(() => {
    m.handle().insert({ text, html: "" }, "atCaret");
  });

describe("the rich editor", () => {
  it("opens quoted history without changing the draft, keeps edits when reopened, and restores with undo", async () => {
    const history = {
      load: async () => ["Earlier message"],
      show: "Show quoted history",
      hide: "Hide quoted history",
      restore: "Restore original",
      unavailable: "Quoted history unavailable",
    };
    const draft = { text: "My reply", html: "" };
    const m = mount(rich, draft, history);
    fireEvent.click(mark(history.show));
    const original = await screen.findByText("Earlier message");
    expect(surface().contains(original)).toBe(true);
    expect(m.said).toEqual([]);
    const editor = (surface() as HTMLElement & { editor: TiptapEditor }).editor;
    const start = editor.view.posAtDOM(original, 0);
    act(() => {
      editor.commands.setTextSelection({ from: start, to: start + "Earlier message".length });
    });
    type(m, "Edited message");
    const edited = m.said.at(-1)!;
    expect(edited.html).toContain("Edited message");
    expect(edited.text).toContain("Edited message");

    cleanup();
    const reopened = mount(rich, edited, history);
    fireEvent.click(mark(history.show));
    expect(surface().contains(await screen.findByText("Edited message"))).toBe(true);
    await act(async () => {
      fireEvent.click(mark(history.restore));
    });
    expect(reopened.said.at(-1)).toEqual(draft);
    fireEvent.keyDown(surface(), { key: "z", ctrlKey: true });
    expect(reopened.said.at(-1)).toEqual(edited);
  });

  it("keeps folded history out of copy and cut and treats pasted history as an ordinary quote", () => {
    const history = {
      load: async () => ["Original"],
      show: "Show history",
      hide: "Hide history",
      restore: "Restore original",
      unavailable: "Unavailable",
    };
    const html =
      '<p>Visible note</p><blockquote data-quoted-history="edited"><p>Folded edit</p></blockquote>';
    const mounted = mount(rich, { text: "Visible note\nFolded edit", html }, history);
    const editor = (surface() as HTMLElement & { editor: TiptapEditor }).editor;
    for (const action of ["copy", "cut"]) {
      const data = new Map<string, string>();
      act(() => {
        editor.commands.selectAll();
      });
      fireEvent(
        surface(),
        Object.assign(new Event(action, { bubbles: true, cancelable: true }), {
          clipboardData: {
            clearData: () => data.clear(),
            setData: (kind: string, value: string) => data.set(kind, value),
          },
        }),
      );
      expect(data.get("text/plain")).toBe("Visible note");
      expect(data.get("text/html")).not.toContain("Folded edit");
    }
    expect(mounted.said.at(-1)?.html).toContain("Folded edit");
    cleanup();
    const destination = mount(rich, { text: "", html: "" }, history);
    fireEvent(
      surface(),
      Object.assign(new Event("paste", { bubbles: true, cancelable: true }), {
        clipboardData: {
          types: ["text/html"],
          getData: (kind: string) => (kind === "text/html" ? html : ""),
        },
      }),
    );
    expect(destination.said.at(-1)?.html).toContain("Folded edit");
    expect(destination.said.at(-1)?.html).not.toContain("data-quoted-history");
  });

  it("places the history controls between the body and signature", async () => {
    const history = {
      load: async () => ["Original"],
      show: "Show history",
      hide: "Hide history",
      restore: "Restore original",
      unavailable: "Unavailable",
    };
    mount(rich, { text: "Note", html: "" }, history);
    fireEvent.click(mark(history.show));
    const restore = await screen.findByRole("button", { name: history.restore });
    const body = surface().parentElement!.parentElement!;
    expect(body.nextElementSibling?.contains(restore)).toBe(true);
  });

  it("reports a plain note with no markup, and a marked one with it", () => {
    const m = mount(rich);
    type(m, "hello");
    expect(m.said.at(-1)).toEqual({ text: "hello", html: "" });
    act(() => {
      fireEvent.click(mark(W.marks.bold));
    });
    expect(mark(W.marks.bold).getAttribute("aria-pressed")).toBe("true");
    type(m, "loud");
    expect(m.said.at(-1)?.html).toContain("<strong>loud</strong>");
  });

  it("underlines: the strip offers it and the press puts it in the markup it reports", () => {
    const m = mount(rich);
    type(m, "plain ");
    act(() => {
      fireEvent.click(mark(W.marks.underline));
    });
    expect(mark(W.marks.underline).getAttribute("aria-pressed")).toBe("true");
    type(m, "lined");
    expect(m.said.at(-1)?.html).toContain("<u>lined</u>");
    expect(m.said.at(-1)?.text).toContain("plain lined");
  });

  it("says nothing at mount: a restored letter is not taken for a change", () => {
    const m = mount(rich, { text: "kept words", html: "" });
    expect(surface().textContent).toContain("kept words");
    m.lock(false);
    m.lock(true);
    expect(m.said).toEqual([]);
  });

  it("locked while a send is in flight: the words stay, the marks rest, the text takes no input", () => {
    const m = mount(rich, { text: "on its way", html: "" });
    m.lock(false);
    expect(surface().getAttribute("contenteditable")).toBe("false");
    expect(mark(W.marks.bold).disabled).toBe(true);
    expect(surface().textContent).toContain("on its way");
    m.lock(true);
    expect(surface().getAttribute("contenteditable")).toBe("true");
  });

  it("hands Mod+Enter and an Escape it did not take to the screen", () => {
    const m = mount(rich, { text: "go", html: "" });
    act(() => {
      fireEvent.keyDown(surface(), { key: "Enter", ctrlKey: true });
      fireEvent.keyDown(surface(), { key: "Escape" });
    });
    expect(m.keys).toEqual(["send", "leave"]);
  });

  it("asks a link's address, refuses a scheme a mail client cannot open, and links what is typed next", () => {
    const m = mount(rich);
    act(() => {
      fireEvent.click(mark(W.marks.link));
    });
    const field = screen.getByRole("textbox", { name: W.link.field });
    act(() => {
      fireEvent.change(field, { target: { value: "javascript:alert(1)" } });
      fireEvent.click(screen.getByRole("button", { name: W.link.apply }));
    });
    expect(screen.getByText(W.link.refused)).toBeTruthy();
    act(() => {
      fireEvent.change(screen.getByRole("textbox", { name: W.link.field }), {
        target: { value: "example.org" },
      });
      fireEvent.click(screen.getByRole("button", { name: W.link.apply }));
    });
    expect(screen.queryByRole("textbox", { name: W.link.field })).toBeNull();
    type(m, "the site");
    expect(m.said.at(-1)?.html).toContain('href="https://example.org"');
    expect(m.rendered.at(-1)).toEqual(["https://example.org/"]);
  });

  it("Mod+K in the text asks the link's address as Link does, and takes the key from the app", () => {
    mount(rich);
    let key: KeyboardEvent | null = null;
    const look = (e: Event): void => {
      key = e as KeyboardEvent;
    };
    window.addEventListener("keydown", look);
    act(() => {
      fireEvent.keyDown(surface(), { key: "k", ctrlKey: true });
    });
    window.removeEventListener("keydown", look);
    expect(screen.getByRole("textbox", { name: W.link.field })).toBeTruthy();
    expect(mark(W.marks.link).getAttribute("aria-expanded")).toBe("true");
    expect(key!.defaultPrevented).toBe(true);
  });

  it("refuses a web address that carries a name and a password before its host", () => {
    const m = mount(rich);
    act(() => {
      fireEvent.click(mark(W.marks.link));
    });
    act(() => {
      fireEvent.change(screen.getByRole("textbox", { name: W.link.field }), {
        target: { value: "https://user:secret@evil.example/" },
      });
      fireEvent.click(screen.getByRole("button", { name: W.link.apply }));
    });
    expect(screen.getByText(W.link.refused)).toBeTruthy();
    type(m, "linked");
    expect(m.said.at(-1)?.html ?? "").not.toContain("href=");
  });

  it("a drafted body's script link reaches the text as words: no such link is drawn, kept or reported", () => {
    const m = mount(rich);
    m.land({ text: "Open here", html: '<p>Open <a href="javascript:alert(1)">here</a></p>' });
    expect(surface().textContent).toContain("Open here");
    expect(surface().querySelector("a")).toBeNull();
    type(m, " now");
    const last = m.said.at(-1)!;
    expect(last.text).toContain("Open here");
    expect(last.html).not.toMatch(/javascript:/i);
    expect(m.rendered.flat().filter((href) => /javascript:/i.test(href))).toEqual([]);
  });

  it("hides and shows its marks behind Aa", () => {
    mount(rich);
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: W.marks.show }));
    });
    expect(screen.queryByRole("toolbar", { name: W.marks.bar })).toBeNull();
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: W.marks.show }));
    });
    expect(screen.getByRole("toolbar", { name: W.marks.bar })).toBeTruthy();
  });
});

describe("the plain editor", () => {
  it("offers no marks and no Aa, and reports words alone", () => {
    const m = mount(plainEditor);
    expect(screen.queryByRole("toolbar", { name: W.marks.bar })).toBeNull();
    expect(screen.queryByRole("button", { name: W.marks.show })).toBeNull();
    act(() => {
      fireEvent.change(surface(), { target: { value: "*not bold*" } });
    });
    expect(m.said.at(-1)).toEqual({ text: "*not bold*", html: "" });
  });
});

/** A letter with every block and inline mark the kit's sheet names. */
const NAMED_LETTER =
  "<p>Hello all<br><br>Third quarter.</p><ul><li><p>Entries numbered.</p></li><li><p>Bank agrees.</p></li></ul>" +
  "<ol><li><p>L303</p></li></ol><blockquote><p>Quoted line.</p></blockquote>" +
  '<pre><code>code line</code></pre><p>Then <code>inline</code> and <a href="https://lichtgrat.example">a link</a>.</p>';

describe("the letter's names", () => {
  it("are worn by what the editor draws and never by the markup a letter is sent as", () => {
    const plain = new TiptapEditor({ extensions: EXTENSIONS, content: NAMED_LETTER });
    const named = new TiptapEditor({
      extensions: [...EXTENSIONS, LetterNames],
      editorProps: { attributes: { class: LETTER_TEXT } },
      content: NAMED_LETTER,
    });
    const sent = named.getHTML();
    expect(sent).toBe(plain.getHTML());
    expect(sent).not.toContain("oh-lettertext");
    const view = named.view.dom as HTMLElement;
    expect(view.classList.contains(letterText.text)).toBe(true);
    for (const name of [
      letterText.paragraph,
      letterText.bullets,
      letterText.numbers,
      letterText.item,
      letterText.quote,
      letterText.codeBlock,
    ])
      expect(view.querySelector(`.${name}`), name).not.toBeNull();
    /* The marks' names on their own elements, so the sheet draws one link and one ground of code. */
    expect(view.querySelector(`code.${letterText.code}`)?.textContent).toBe("inline");
    expect(view.querySelector(`a.${letterText.link}`)?.getAttribute("href")).toBe(
      "https://lichtgrat.example",
    );
    plain.destroy();
    named.destroy();
  });

  it("the rich editor wears the box's name, and a letter typed in it reports none of them", () => {
    const m = mount(rich);
    expect(surface().classList.contains(letterText.text)).toBe(true);
    act(() => {
      m.handle().insert({ text: "", html: NAMED_LETTER }, "replace");
    });
    expect(m.said.at(-1)?.html).not.toContain("oh-lettertext");
    expect(surface().querySelector(`a.${letterText.link}`)).not.toBeNull();
  });
});
