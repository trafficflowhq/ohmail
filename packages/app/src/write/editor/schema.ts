import { Extension } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { EditorView } from "@tiptap/pm/view";
import { AutolinkPunctuation, CodeMark, LinkMark, MarkBoundaries } from "./marks.js";

/**
 * The editor's schema: the marks and nodes it offers and refuses, and the two keyboard rules every
 * editor over it keeps. One list for every editor of a letter, so the old reply box and the new
 * screen write the same markup.
 */

/**
 * Enter is a single line break, not a new paragraph. StarterKit binds Enter to "split the
 * paragraph", so a note typed line by line left as one `<p>` per line — and a `<p>` renders with
 * margins in every mail client, so the single-spaced note arrived double-spaced, with no html-side
 * fix (the inline `margin:0` is exactly what the outbound allow-list strips). So Enter inserts a
 * hard break — one `<br>`; a blank line is two (`<br><br>`), and `outbound-html.ts` mirrors this
 * into the text/plain half. It defers inside lists and quotes, where Enter already has a job: the
 * handler returns `false` there and the default keymap runs; the high priority is so this can
 * decline rather than never be reached.
 */
export const EnterAsHardBreak = Extension.create({
  name: "enterAsHardBreak",
  priority: 1000,
  addKeyboardShortcuts() {
    return {
      Enter: () => {
        // Defer wherever Enter already means something: a list item (next item), a block quote
        // (its exit behaviour) and the code block, where Enter is a newline in the source and
        // three of them in a row is how you leave. `false` falls through to the default keymap
        // so `splitListItem`, `CodeBlock`'s own `exitOnTripleEnter` and the rest all run.
        if (
          this.editor.isActive("listItem") ||
          this.editor.isActive("blockquote") ||
          this.editor.isActive("codeBlock")
        ) {
          return false;
        }
        return this.editor.commands.setHardBreak();
      },
    };
  },
});

/**
 * ESCAPE IS THE EDITOR'S ONLY WHEN ONE OF ITS BINDINGS TAKES IT. ProseMirror prevents every
 * Escape, and the keymap leaves a prevented key alone, so the bindings that close the reply and
 * Compose never heard one pressed in the body. The editor's own bindings are asked as ProseMirror
 * asks them and one that takes the key prevents it; otherwise ProseMirror's blanket capture is
 * skipped and the key reaches the shell. An Escape ending a composition stays ProseMirror's.
 */
export function escapeUnlessTaken(view: EditorView, e: KeyboardEvent): boolean {
  if (e.key !== "Escape" || e.isComposing || view.composing) return false;
  if (view.someProp("handleKeyDown", (f) => f(view, e))) e.preventDefault();
  return true;
}

/** The marks and nodes this editor offers, and the ones it explicitly refuses. */
export const EXTENSIONS = [
  EnterAsHardBreak,
  StarterKit.configure({
    // Offered.
    bold: {},
    italic: {},
    strike: {},
    // Inline code is `CodeMark` below — the kit's copy would carry over a line break and let
    // ArrowRight type a space; the mark-boundary rules live in `marks.ts`.
    code: false,
    bulletList: {},
    orderedList: {},
    listItem: {},
    blockquote: {},
    // The block half of the Code control. Admitted in the same commit that put `pre` into
    // `outbound-html.ts`'s allowlist and taught `htmlToPlainText` to render one — see the
    // header. Its options are the shipped defaults: `exitOnTripleEnter` is how you leave a
    // block from the keyboard, and `EnterAsHardBreak` defers to it.
    codeBlock: {},
    // REFUSED, each because the sanitizer drops it on the way out and a control that
    // silently does nothing is worse than an absent one.
    heading: false,
    horizontalRule: false,
    // `Link` is configured separately below; StarterKit's copy would win otherwise.
    link: false,
    // Underline is kept: the outgoing filter keeps `u` (`outbound-html.ts`).
  }),
  CodeMark,
  LinkMark.configure({
    openOnClick: false,
    // The editor writes markup that a MAIL client renders, so a link may only be a thing a
    // mail client can open. This mirrors the scheme allow-list the server's sanitiser applies;
    // the server is the enforcement and this is the courtesy of not offering what it will refuse.
    protocols: ["http", "https", "mailto"],
    autolink: true,
    HTMLAttributes: {},
  }),
  // Where a typed character lands relative to a mark's edges (`EDITOR_RULES`), and the
  // trailing-punctuation autolink Tiptap's own refuses.
  MarkBoundaries,
  AutolinkPunctuation,
];

/**
 * The http(s) links a document draws: each link mark's href in `URL.href` form, distinct, in
 * document order. A link mark is a live `<a href>` in the app's document, so on the desktop a
 * click on it reaches the shell's opener, which opens only a reported link (`rendered-links.ts`).
 * `linkHref` is the body's reading of an href, handed by the caller.
 */
export function linksIn(doc: ProseMirrorNode, linkHref: (raw: string) => string | null): string[] {
  const seen = new Set<string>();
  doc.descendants((node) => {
    for (const mark of node.marks) {
      if (mark.type.name !== "link") continue;
      const href = linkHref(String(mark.attrs.href ?? ""));
      if (href !== null) seen.add(href);
    }
  });
  return [...seen];
}
