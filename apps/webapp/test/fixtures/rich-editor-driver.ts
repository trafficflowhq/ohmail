/**
 * DRIVING THE RICH EDITOR FROM A SHELL TEST.
 *
 * ── WHY THE OLD `type()` CANNOT SIMPLY BE RE-POINTED ─────────────────────────────────────
 *
 * Every suite that touched the reply or compose editor typed the same way: take the native
 * `HTMLTextAreaElement.prototype.value` setter, call it, dispatch `input`, and let React's
 * synthetic event system notice. That is exactly right for a textarea and it is worth nothing
 * against a `contenteditable`. ProseMirror does not read the DOM to find out what the document
 * says — the document is its own data structure and the DOM is a rendering of it — so the same
 * trick would mutate the rendering, produce no transaction, emit no change, and leave the
 * shell holding an empty value while the screen showed text. The test would then assert
 * against the screen and pass.
 *
 * That failure mode is the reason this file exists rather than a per-suite helper: a test that
 * *looks* like it typed and did not is indistinguishable from one that did, and there were
 * four copies of the old helper to get wrong independently.
 *
 * ── HOW IT REACHES THE EDITOR ────────────────────────────────────────────────────────────
 *
 * TipTap puts the `Editor` on its own DOM node (`view.dom.editor`), which is how the toolbar,
 * the extensions and the React bindings all find each other. Going through it means the text
 * arrives as a real ProseMirror transaction — through the schema, the input rules and the
 * serializers — so what the shell receives is what a person typing would have produced,
 * including the `html` half. Synthesising `keydown`/`input`/`beforeinput` would not: jsdom has
 * no editing host and no composition, and ProseMirror's own DOM observer has nothing to read.
 *
 * ProseMirror also wants layout it cannot have in jsdom, and the stub for that is NOT here: it
 * is `test/setup/prosemirror-geometry.ts`, registered globally, because the editor is mounted by
 * the whole shell now and the suites that trip over it are the ones that are not about editors
 * at all. See that file for how the gap was measured.
 *
 * KEYSTROKES ARE DELIBERATELY NOT WRAPPED HERE. The suites that test ⌘↵ dispatch a real
 * `keydown` from the surface themselves, because what they are asking — does the chord reach the
 * shell's document listener from inside an editor that owns focus — is a question about event
 * propagation, and a helper that answered it at a higher level would answer nothing. It reaches
 * it: ProseMirror binds `Enter` and `Shift-Enter` and has no `Mod-Enter`, so the event is not
 * consumed. That is now proven by `inline-reply.test.ts` rather than assumed.
 */
import type { Editor } from "@tiptap/react";
import { escapeAsParagraphs } from "@ohmail/app-logic/writing/rich-text";

/** The editable surface of a mounted `RichEditor`. */
export type RichSurface = HTMLElement;

/**
 * The `Editor` behind a surface.
 *
 * It THROWS rather than returning undefined when the handle is missing. A helper that silently
 * did nothing here would turn "the editor never mounted" into a green test with an empty
 * document, which is the precise shape of failure this file is written to prevent.
 */
export function editorOf(surface: RichSurface): Editor {
  const editor = (surface as unknown as { editor?: Editor }).editor;
  if (!editor) {
    throw new Error(
      "no TipTap editor on this element — pass the `.rte-surface`, not the `.rte` wrapper",
    );
  }
  return editor;
}

/**
 * Replace the editor's document with `text`, as plain paragraphs.
 *
 * Escaped through the same helper the editor loads a value with, so a test that types `<b>x`
 * asserts about the literal characters rather than accidentally about formatting — the same
 * rule the production path follows, for the same reason.
 */
export function typeInto(surface: RichSurface, text: string): void {
  const editor = editorOf(surface);
  if (text === "") editor.commands.clearContent(true);
  else editor.commands.setContent(escapeAsParagraphs(text));
}

