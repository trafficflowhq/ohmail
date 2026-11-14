/** @vitest-environment jsdom */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";
import type { Editor } from "@tiptap/react";
import { RichEditor } from "../app/shell/RichEditor";
import { EDITOR_RULES, autolinkHref, nextMarks } from "../app/shell/rich-editor-marks";
import { EMPTY_RICH, type RichValue } from "@ohmail/app-logic/writing/rich-text";

/* @reads: apps/webapp/test/editor-feel/rules.pw.ts apps/webapp/test/rich-editor-marks.test.tsx
   Read by paths built at runtime from __dirname — the rig's rule list and this file's own cases —
   so no landing pass selects this file when the rig moves; the shape `reads-list.mjs` exists for. */

/**
 * THE MARK-BOUNDARY RULES AT THE MECHANISM. `EDITOR_RULES` (rich-editor-marks.ts) is the claim;
 * every row's id is in a test name here AND in the real-keyboard rig (`editor-feel/rules.pw.ts`),
 * and the census at the bottom refuses a row missing from either. Typing here goes through the
 * seam ProseMirror hands a typed character to (`handleTextInput`, the path the browser's own
 * insertion reaches), and keys through a real `keydown` on the surface, so the keymaps decide.
 */

beforeAll(() => {
  const emptyList = () => Object.assign([], { item: () => null }) as unknown as DOMRectList;
  const zeroRect = () => new DOMRect(0, 0, 0, 0);
  for (const proto of [Range.prototype, Element.prototype] as Array<{ getClientRects?: unknown; getBoundingClientRect?: unknown }>) {
    if (typeof proto.getClientRects !== "function") proto.getClientRects = emptyList;
    if (typeof proto.getBoundingClientRect !== "function") proto.getBoundingClientRect = zeroRect;
  }
});

let host: HTMLElement | null = null;
let root: Root | null = null;

interface Mounted {
  editor: () => Editor;
  button: (label: string) => HTMLButtonElement;
  html: () => string;
  readonly value: RichValue;
}

function mount(initial: RichValue = EMPTY_RICH): Mounted {
  host = document.createElement("div");
  document.body.appendChild(host);
  let current = initial;
  let instance: Editor | null = null;
  function Harness() {
    const [v, setV] = React.useState<RichValue>(initial);
    current = v;
    return (
      <NextIntlClientProvider locale="en" messages={messages as never}>
        <RichEditor value={v} onChange={(n) => setV(n)} ariaLabel="Reply" editorRef={(e) => { if (e) instance = e; }} />
      </NextIntlClientProvider>
    );
  }
  root = createRoot(host);
  act(() => { root!.render(<Harness />); });
  return {
    editor: () => { if (!instance) throw new Error("no editor"); return instance; },
    button: (label) => host!.querySelector<HTMLButtonElement>(`.rte-b[aria-label="${label}"]`)!,
    html: () => instance!.getHTML(),
    get value() { return current; },
  };
}

afterEach(() => {
  act(() => { root?.unmount(); });
  root = null;
  host?.remove();
  host = null;
});

/** Load a document and put the caret at `pos` (the end when omitted). */
function load(ed: Mounted, html: string, pos?: number): void {
  act(() => {
    ed.editor().commands.setContent(html);
    ed.editor().commands.focus(pos ?? "end");
  });
}

/** The position after (or before) the first text run containing `text`. */
function posOf(ed: Mounted, text: string, side: "start" | "end" = "end"): number {
  let found = -1;
  ed.editor().state.doc.descendants((node, pos) => {
    if (found >= 0) return false;
    if (node.isText && node.text!.includes(text)) {
      found = pos + node.text!.indexOf(text) + (side === "end" ? text.length : 0);
      return false;
    }
    return true;
  });
  if (found < 0) throw new Error(`no ${JSON.stringify(text)} in ${ed.html()}`);
  return found;
}

/**
 * A typed character, through the seam the browser's insertion reaches: ProseMirror reads the DOM
 * change and offers it to `handleTextInput` first; unhandled, it inserts with its own marks.
 */
function typeText(ed: Mounted, text: string): void {
  act(() => {
    const view = ed.editor().view;
    for (const ch of text) {
      const { from, to } = view.state.selection;
      // prosemirror-view hands the plugin a fifth argument, the default transaction, exactly as here.
      const deflt = () => view.state.tr.insertText(ch, from, to);
      const handled = view.someProp("handleTextInput", (f) => f(view, from, to, ch, deflt));
      if (!handled) view.dispatch(deflt());
    }
  });
}

/** A real keydown on the surface — the keymaps answer, as they do for a keyboard. */
function key(ed: Mounted, name: string, init: KeyboardEventInit = {}): void {
  const codes: Record<string, number> = { Enter: 13, ArrowRight: 39, ArrowLeft: 37, Backspace: 8 };
  act(() => {
    ed.editor().view.dom.dispatchEvent(
      new KeyboardEvent("keydown", { key: name, code: name, keyCode: codes[name] ?? 0, bubbles: true, cancelable: true, ...init }),
    );
  });
}

function backspace(ed: Mounted): void {
  act(() => {
    const view = ed.editor().view;
    const { from } = view.state.selection;
    view.dispatch(view.state.tr.delete(from - 1, from));
  });
}

const marksBefore = (ed: Mounted): string[] =>
  (ed.editor().state.selection.$from.nodeBefore?.marks ?? []).map((m) => m.type.name).sort();

const A = '<a target="_blank" rel="noopener noreferrer nofollow" href="https://x.example/p">';
const MARKS: Record<string, [string, string]> = {
  bold: ["<strong>", "</strong>"],
  italic: ["<em>", "</em>"],
  strike: ["<s>", "</s>"],
  code: ["<code>", "</code>"],
};

describe("links end where you stop typing them", () => {
  it("[link-end-letter] a letter typed at the end of a link extends it", () => {
    const ed = mount();
    load(ed, `<p>ab ${A}cd</a> ef</p>`, 0);
    act(() => { ed.editor().commands.focus(posOf(ed, "cd")); });
    typeText(ed, "x.");
    expect(ed.html()).toBe(`<p>ab ${A}cdx.</a> ef</p>`);
  });

  it("[link-end-space] a space at the end of a link is plain and the text after it stays plain", () => {
    const ed = mount();
    load(ed, `<p>ab ${A}cd</a></p>`);
    typeText(ed, "x and more");
    expect(ed.html()).toBe(`<p>ab ${A}cdx</a> and more</p>`);
  });

  it("[link-end-space] a line break at the end of a link starts the next line plain", () => {
    const ed = mount();
    load(ed, `<p>ab ${A}cd</a></p>`);
    key(ed, "Enter");
    typeText(ed, "z");
    expect(ed.html()).toBe(`<p>ab ${A}cd</a><br>z</p>`);
  });

  it("[link-start] typing before a link never joins it, mid-line or at the line's first position", () => {
    const ed = mount();
    load(ed, `<p>ab ${A}cd</a> ef</p>`, 0);
    act(() => { ed.editor().commands.focus(posOf(ed, "cd", "start")); });
    typeText(ed, "x");
    expect(ed.html()).toBe(`<p>ab x${A}cd</a> ef</p>`);
    load(ed, `<p>${A}cd</a> ef</p>`, 1);
    typeText(ed, "x");
    expect(ed.html()).toBe(`<p>x${A}cd</a> ef</p>`);
  });

  it("[link-reenter] Backspace back to the link's last character re-enters it", () => {
    const ed = mount();
    load(ed, `<p>ab ${A}cd</a></p>`);
    typeText(ed, " ");
    expect(ed.html()).toBe(`<p>ab ${A}cd</a> </p>`);
    backspace(ed);
    typeText(ed, "y");
    expect(ed.html()).toBe(`<p>ab ${A}cdy</a></p>`);
  });

  it("[link-self-href] a link whose address is its text keeps the two equal as it is typed onto", () => {
    const ed = mount();
    const self = '<a target="_blank" rel="noopener noreferrer nofollow" href="https://x.example/p">https://x.example/p</a>';
    load(ed, `<p>see ${self}</p>`);
    typeText(ed, "q");
    expect(ed.html()).toBe('<p>see <a target="_blank" rel="noopener noreferrer nofollow" href="https://x.example/pq">https://x.example/pq</a></p>');
    // A link whose text is NOT its address keeps the address it was given.
    load(ed, `<p>ab ${A}cd</a></p>`);
    typeText(ed, "q");
    expect(ed.html()).toBe(`<p>ab ${A}cdq</a></p>`);
  });

  it("[autolink-punct] an address before a full stop, comma or bracket is linked without the punctuation", () => {
    const ed = mount();
    load(ed, "<p></p>", 1);
    typeText(ed, "see https://example.com. ");
    expect(ed.html()).toBe('<p>see <a target="_blank" rel="noopener noreferrer nofollow" href="https://example.com">https://example.com</a>. </p>');
    load(ed, "<p></p>", 1);
    typeText(ed, "at www.example.com, ");
    expect(ed.html()).toBe('<p>at <a target="_blank" rel="noopener noreferrer nofollow" href="http://www.example.com">www.example.com</a>, </p>');
    // Controls: a word that is not an address, and an address inside code, stay as typed.
    load(ed, "<p></p>", 1);
    typeText(ed, "hello. ");
    expect(ed.html()).toBe("<p>hello. </p>");
    load(ed, "<p><code>run https://example.com.</code></p>");
    typeText(ed, " ");
    expect(ed.html()).toBe("<p><code>run https://example.com.</code> </p>");
  });

  it("[autolink-punct] the address grammar is Tiptap's own: http(s), mailto, www., an address — nothing else", () => {
    expect(autolinkHref("https://example.com")).toBe("https://example.com");
    expect(autolinkHref("www.example.com")).toBe("http://www.example.com");
    expect(autolinkHref("someone@example.com")).toBe("mailto:someone@example.com");
    expect(autolinkHref("ftp://example.com")).toBeNull();
    expect(autolinkHref("javascript:alert(1)")).toBeNull();
    expect(autolinkHref("hello")).toBeNull();
    expect(autolinkHref("https://localhost")).toBeNull();
  });
});

describe("formats stay while you type, and end where Slack ends them", () => {
  for (const [mark, [o, c]] of Object.entries(MARKS)) {
    it(`[mark-end-sticky] ${mark} continues at its end`, () => {
      const ed = mount();
      load(ed, `<p>ab ${o}cd${c} ef</p>`, 0);
      act(() => { ed.editor().commands.focus(posOf(ed, "cd")); });
      typeText(ed, "x");
      expect(ed.html()).toBe(`<p>ab ${o}cdx${c} ef</p>`);
    });

    it(`[mark-start] typing before ${mark} text mid-line stays plain`, () => {
      const ed = mount();
      load(ed, `<p>ab ${o}cd${c} ef</p>`, 0);
      act(() => { ed.editor().commands.focus(posOf(ed, "cd", "start")); });
      typeText(ed, "x");
      expect(ed.html()).toBe(`<p>ab x${o}cd${c} ef</p>`);
    });
  }

  it("[code-end-space] a space at the end of inline code leaves the code; a space inside stays code", () => {
    const ed = mount();
    load(ed, "<p>ab <code>cd</code></p>");
    typeText(ed, " y");
    expect(ed.html()).toBe("<p>ab <code>cd</code> y</p>");
    load(ed, "<p>ab <code>cd</code> ef</p>", 0);
    act(() => { ed.editor().commands.focus(posOf(ed, "cd", "start") + 1); });
    typeText(ed, " ");
    expect(ed.html()).toBe("<p>ab <code>c d</code> ef</p>");
  });

  it("[code-end-space] a space at the end of bold stays bold — only code and links end on a space", () => {
    const ed = mount();
    load(ed, "<p>ab <strong>cd</strong></p>");
    typeText(ed, " y");
    expect(ed.html()).toBe("<p>ab <strong>cd y</strong></p>");
  });

  it("[enter-keeps] a line break keeps bold, italic and strikethrough and ends code and links", () => {
    const ed = mount();
    for (const [mark, [o, c]] of Object.entries(MARKS)) {
      load(ed, `<p>ab ${o}cd${c}</p>`);
      key(ed, "Enter");
      typeText(ed, "z");
      const kept = mark !== "code";
      expect(ed.html()).toBe(`<p>ab ${o}cd${c}<br>${kept ? `${o}z${c}` : "z"}</p>`);
    }
  });

  it("[enter-keeps] the same rule inside a list item: bold carries to the next item, code does not", () => {
    const ed = mount();
    // `TrailingNode` (StarterKit's, shipped before this change) keeps an empty paragraph after a
    // list at the document's end, so the caret is placed at the item's text, never at "end".
    load(ed, "<ul><li><p><strong>cd</strong></p></li></ul>", 0);
    act(() => { ed.editor().commands.focus(posOf(ed, "cd")); });
    key(ed, "Enter");
    typeText(ed, "z");
    expect(ed.html()).toBe("<ul><li><p><strong>cd</strong></p></li><li><p><strong>z</strong></p></li></ul><p></p>");
    load(ed, "<ul><li><p><code>cd</code></p></li></ul>", 0);
    act(() => { ed.editor().commands.focus(posOf(ed, "cd")); });
    key(ed, "Enter");
    typeText(ed, "z");
    expect(ed.html()).toBe("<ul><li><p><code>cd</code></p></li><li><p>z</p></li></ul><p></p>");
  });

  it("[toggle-sticky] a toggle with nothing selected carries into what you type until toggled off or the caret moves", () => {
    const ed = mount();
    load(ed, "<p></p>", 1);
    act(() => { ed.button("Bold").click(); });
    typeText(ed, "ab");
    expect(ed.html()).toBe("<p><strong>ab</strong></p>");
    act(() => { ed.button("Bold").click(); });
    typeText(ed, "c");
    expect(ed.html()).toBe("<p><strong>ab</strong>c</p>");
    // Toggled on, then the caret moves away before anything is typed: the toggle is gone.
    load(ed, "<p>ab</p>", 3);
    act(() => { ed.button("Italic").click(); });
    expect(ed.editor().state.storedMarks?.map((m) => m.type.name)).toEqual(["italic"]);
    act(() => { ed.editor().commands.setTextSelection(1); });
    typeText(ed, "x");
    expect(ed.html()).toBe("<p>xab</p>");
  });

  it("[list-empty-enter] Enter on an empty item in the middle of a list takes it out of the list", () => {
    const ed = mount();
    load(ed, "<ul><li><p>one</p></li><li><p></p></li><li><p>three</p></li></ul>", 0);
    act(() => { ed.editor().commands.focus(posOf(ed, "one") + 4); });
    expect(ed.editor().isActive("listItem")).toBe(true);
    key(ed, "Enter");
    expect(ed.html()).toBe("<ul><li><p>one</p></li></ul><p></p><ul><li><p>three</p></li></ul><p></p>");
    expect(ed.editor().isActive("listItem")).toBe(false);
  });
});

describe("the toolbar says what the next letter carries", () => {
  it("[toolbar-next] bold, italic, strike and code light up exactly when the next letter would carry them", () => {
    const ed = mount();
    for (const [mark, [o, c]] of Object.entries(MARKS)) {
      const label = { bold: "Bold", italic: "Italic", strike: "Strikethrough", code: "Code" }[mark]!;
      load(ed, `<p>ab ${o}cd${c} ef</p>`, 0);
      act(() => { ed.editor().commands.focus(posOf(ed, "cd")); });
      expect(ed.button(label).getAttribute("aria-pressed")).toBe("true");
      act(() => { ed.editor().commands.focus(posOf(ed, "cd", "start")); });
      expect(ed.button(label).getAttribute("aria-pressed")).toBe("false");
    }
    // The pressed states are the SAME function the text-input seam decides by.
    load(ed, "<p>ab <strong>cd</strong></p>");
    expect(nextMarks(ed.editor().state).map((m) => m.type.name)).toEqual(["bold"]);
    expect(nextMarks(ed.editor().state, " ").map((m) => m.type.name)).toEqual(["bold"]);
    load(ed, "<p>ab <code>cd</code></p>");
    expect(nextMarks(ed.editor().state, " ")).toEqual([]);
  });

  it("[link-not-toggle] the link button claims no pressed state, only its dialog's open state", () => {
    const ed = mount();
    load(ed, `<p>ab ${A}cd</a></p>`, 0);
    act(() => { ed.editor().commands.focus(posOf(ed, "cd", "start") + 1); });
    const link = ed.button("Link");
    expect(link.hasAttribute("aria-pressed")).toBe(false);
    expect(link.getAttribute("aria-haspopup")).toBe("dialog");
    expect(link.getAttribute("aria-expanded")).toBe("false");
    act(() => { link.click(); });
    expect(link.getAttribute("aria-expanded")).toBe("true");
    // Opened at the END of the link, the dialog still edits THIS link.
    act(() => { link.click(); });
    act(() => { ed.editor().commands.focus(posOf(ed, "cd")); });
    act(() => { link.click(); });
    expect(host!.querySelector<HTMLInputElement>(".rte-linkpop-url")!.value).toBe("https://x.example/p");
    for (const label of ["Bold", "Italic", "Strikethrough", "Code"]) {
      expect(ed.button(label).hasAttribute("aria-pressed")).toBe(true);
    }
  });

  it("[one-caret] an arrow key at the end of code or a link writes nothing", () => {
    const ed = mount();
    for (const doc of ["<p>ab <code>cd</code></p>", `<p>ab ${A}cd</a></p>`]) {
      load(ed, doc);
      key(ed, "ArrowRight");
      key(ed, "ArrowLeft");
      key(ed, "ArrowRight");
      expect(ed.html()).toBe(doc);
    }
  });
});

describe("what leaves the editor is pinned", () => {
  it("serialises every construct the toolbar offers to the same markup as before this change", () => {
    const ed = mount();
    const doc =
      "<p>a <strong>b</strong> <em>c</em> <s>d</s> <code>e</code> " +
      '<a target="_blank" rel="noopener noreferrer nofollow" href="https://x.example/">f</a><br>g</p>' +
      "<ul><li><p>h</p></li></ul><ol><li><p>i</p></li></ol><blockquote><p>j</p></blockquote><pre><code>k</code></pre>";
    load(ed, doc);
    // The trailing `<p></p>` is StarterKit's `TrailingNode`, shipped before this change: a
    // document ending in a code block always carries one. Pinned as measured on the base.
    expect(ed.html()).toBe(`${doc}<p></p>`);
    expect(ed.value.html).toBe(`${doc}<p></p>`);
  });
});

describe("every rule row has its tests", () => {
  it("names each EDITOR_RULES id in this suite and in the real-keyboard rig", () => {
    const here = readFileSync(resolve(__dirname, "rich-editor-marks.test.tsx"), "utf8");
    const rig = readFileSync(resolve(__dirname, "editor-feel/rules.pw.ts"), "utf8");
    const missing: string[] = [];
    for (const [id] of EDITOR_RULES) {
      if (!here.includes(`[${id}]`)) missing.push(`${id} (jsdom)`);
      if (!rig.includes(`[${id}]`)) missing.push(`${id} (rig)`);
    }
    expect(missing).toEqual([]);
    expect(EDITOR_RULES.length).toBeGreaterThanOrEqual(15);
    // The table stays a table: one short sentence per row, no essays.
    for (const [, rule] of EDITOR_RULES) expect(rule.length).toBeLessThan(200);
  });
});
