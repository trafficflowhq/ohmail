/** @vitest-environment jsdom */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { act } from "react";
import { within } from "@testing-library/react";
import { linkCard, mountWriteEditor, WRITE_WORDS, type MountedEditor } from "./_write-1-editor.js";
import type { Editor } from "@tiptap/react";
import { EDITOR_RULES, autolinkHref, nextMarks } from "@ohmail/app/write/editor/marks";
import { EMPTY_RICH, type RichValue } from "@ohmail/app-logic/writing/rich-text";
import { key, load, MARKS, posOf, typeText } from "./fixtures/rich-editor-boundaries-driver";

/* @reads: apps/webapp/test/editor-feel/rules.pw.ts apps/webapp/test/rich-editor-marks.test.tsx apps/webapp/test/frame/write-mark-boundaries.test.tsx
   Read by paths built at runtime from __dirname — the rig and the two files that hold the jsdom cases —
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

let mounted: MountedEditor | null = null;

interface Mounted {
  editor: () => Editor;
  button: (label: string) => HTMLButtonElement;
  html: () => string;
  readonly value: RichValue;
}

function mount(initial: RichValue = EMPTY_RICH): Mounted {
  const view = mountWriteEditor(initial);
  mounted = view;
  return {
    editor: view.editor,
    button: view.button,
    html: () => view.editor().getHTML(),
    get value() { return view.value; },
  };
}

afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

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
      const label = { bold: "Bold", italic: "Italic", strike: "Strikethrough", code: "Inline code" }[mark]!;
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
    expect(within(linkCard()!).getByRole<HTMLInputElement>("textbox", { name: WRITE_WORDS.link.field }).value).toBe("https://x.example/p");
    for (const label of ["Bold", "Italic", "Strikethrough", "Inline code"]) {
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
    const here = ["rich-editor-marks.test.tsx", "frame/write-mark-boundaries.test.tsx"]
      .map((file) => readFileSync(resolve(__dirname, file), "utf8"));
    const rig = readFileSync(resolve(__dirname, "editor-feel/rules.pw.ts"), "utf8");
    const missing: string[] = [];
    for (const [id] of EDITOR_RULES) {
      if (!here.some((source) => source.includes(`[${id}]`))) missing.push(`${id} (jsdom)`);
      if (!rig.includes(`[${id}]`)) missing.push(`${id} (rig)`);
    }
    expect(missing).toEqual([]);
    expect(EDITOR_RULES.length).toBeGreaterThanOrEqual(15);
    // The table stays a table: one short sentence per row, no essays.
    for (const [, rule] of EDITOR_RULES) expect(rule.length).toBeLessThan(200);
  });
});
