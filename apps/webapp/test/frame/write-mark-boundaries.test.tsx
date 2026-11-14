/** @vitest-environment jsdom */
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetStorageOwnerForTest, setStorageOwner } from "@ohmail/app-logic/storage/storage-owner";
import { message, mountShell, stubDom, unmountAll, waitFor } from "../_draft-shell.js";
import { key as shellKey, letterText, stubAnimate } from "../_writing-shell.js";
import { editorOf } from "../fixtures/rich-editor-driver";
import { key, load, MARKS, posOf, typeText, type EditorDocument } from "../fixtures/rich-editor-boundaries-driver";

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  setStorageOwner("acc-write-marks");
  stubDom();
  stubAnimate();
});

afterEach(async () => {
  await unmountAll();
  resetStorageOwnerForTest();
});

async function mountWriteEditor(): Promise<EditorDocument> {
  const shell = await mountShell("#/ohbox", [message("m1")]);
  await shellKey("c");
  await waitFor(() => letterText(shell.el) !== null, "the mounted Write editor");
  const editor = editorOf(letterText(shell.el)!);
  return { editor: () => editor, html: () => editor.getHTML() };
}

describe("formats stay while you type, and end where Slack ends them", () => {
  it("[code-end-space] a space at the end of inline code leaves the code; a space inside stays code", async () => {
    const ed = await mountWriteEditor();
    load(ed, "<p>ab <code>cd</code></p>");
    typeText(ed, " y");
    expect(ed.html()).toBe("<p>ab <code>cd</code> y</p>");
    load(ed, "<p>ab <code>cd</code> ef</p>", 0);
    act(() => { ed.editor().commands.focus(posOf(ed, "cd", "start") + 1); });
    typeText(ed, " ");
    expect(ed.html()).toBe("<p>ab <code>c d</code> ef</p>");
  });

  it("[code-end-space] a space at the end of bold stays bold — only code and links end on a space", async () => {
    const ed = await mountWriteEditor();
    load(ed, "<p>ab <strong>cd</strong></p>");
    typeText(ed, " y");
    expect(ed.html()).toBe("<p>ab <strong>cd y</strong></p>");
  });

  it("[enter-keeps] a line break keeps bold, italic and strikethrough and ends code and links", async () => {
    const ed = await mountWriteEditor();
    for (const [mark, [o, c]] of Object.entries(MARKS)) {
      load(ed, `<p>ab ${o}cd${c}</p>`);
      key(ed, "Enter");
      typeText(ed, "z");
      const kept = mark !== "code";
      expect(ed.html()).toBe(`<p>ab ${o}cd${c}<br>${kept ? `${o}z${c}` : "z"}</p>`);
    }
  });

  it("[enter-keeps] the same rule inside a list item: bold carries to the next item, code does not", async () => {
    const ed = await mountWriteEditor();
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
});
