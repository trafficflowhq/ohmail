/** @vitest-environment jsdom */
/**
 * AN ADDRESS TYPED INTO A LETTER BECOMES A LINK ONCE A SPACE FOLLOWS IT, over the editor Write draws (its
 * own extensions, `src/write/editor/schema.ts`). Each word is typed one character at a time through the
 * editor's own text input, as a keyboard hands it, so the autolink runs on the transaction a space makes.
 * It holds what the older real-keyboard probe over today's editor only printed.
 */
import { afterEach, describe, expect, it } from "vitest";
import { Editor } from "@tiptap/react";
import { EXTENSIONS } from "../../src/write/editor/schema.js";

let editor: Editor | null = null;
afterEach(() => {
  editor?.destroy();
  editor = null;
});

function typed(text: string): string {
  editor = new Editor({ extensions: EXTENSIONS, content: "<p></p>" });
  editor.commands.focus("end");
  for (const ch of text) {
    const { from, to } = editor.state.selection;
    const view = editor.view;
    const handled = view.someProp("handleTextInput", (f) =>
      f(view, from, to, ch, () => view.state.tr.insertText(ch, from, to)),
    );
    if (!handled) view.dispatch(view.state.tr.insertText(ch, from, to));
  }
  return editor.getHTML();
}

describe("an address typed into a letter", () => {
  it("is linked once a space follows it, and the words around it are not", () => {
    const html = typed("see https://example.com now");
    expect(html).toContain('href="https://example.com">https://example.com</a> now');
    expect(html).toMatch(/^<p>see <a /);
  });

  it("is linked without the full stop a sentence puts after it", () => {
    const html = typed("see https://example.com. now");
    expect(html).toContain('href="https://example.com">https://example.com</a>. now');
  });

  it("a www. address is linked to the web", () => {
    expect(typed("see www.example.com now")).toContain('href="http://www.example.com"');
  });

  it("a word that is no address stays words", () => {
    expect(typed("see hello now")).toBe("<p>see hello now</p>");
  });
});
