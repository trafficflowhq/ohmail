import { act } from "react";
import type { Editor } from "@tiptap/react";

export interface EditorDocument {
  editor: () => Editor;
  html: () => string;
}

/** Load a document and put the caret at `pos` (the end when omitted). */
export function load(ed: EditorDocument, html: string, pos?: number): void {
  act(() => {
    ed.editor().commands.setContent(html);
    ed.editor().commands.focus(pos ?? "end");
  });
}

/** The position after (or before) the first text run containing `text`. */
export function posOf(ed: EditorDocument, text: string, side: "start" | "end" = "end"): number {
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
export function typeText(ed: EditorDocument, text: string): void {
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
export function key(ed: EditorDocument, name: string, init: KeyboardEventInit = {}): void {
  const codes: Record<string, number> = { Enter: 13, ArrowRight: 39, ArrowLeft: 37, Backspace: 8 };
  act(() => {
    ed.editor().view.dom.dispatchEvent(
      new KeyboardEvent("keydown", { key: name, code: name, keyCode: codes[name] ?? 0, bubbles: true, cancelable: true, ...init }),
    );
  });
}

export const MARKS: Record<string, [string, string]> = {
  bold: ["<strong>", "</strong>"],
  italic: ["<em>", "</em>"],
  strike: ["<s>", "</s>"],
  code: ["<code>", "</code>"],
};
