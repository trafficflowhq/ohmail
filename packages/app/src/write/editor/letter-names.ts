/**
 * THE LETTER'S NAMES, stamped on what the editor draws and never on what it reports: the kit's one sheet for a letter
 * being written reads them. The blocks wear theirs by a node decoration, the code and link marks by a mark view of
 * their own element; the schema renders none, so `getHTML()` (what a letter is sent as) is byte-equal without them.
 */
import { Extension } from "@tiptap/react";
import { Plugin } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { letterText } from "@ohmail/ui/mail";

const BLOCK: Readonly<Record<string, string>> = {
  paragraph: letterText.paragraph,
  bulletList: letterText.bullets,
  orderedList: letterText.numbers,
  listItem: letterText.item,
  blockquote: letterText.quote,
  codeBlock: letterText.codeBlock,
};

function blocksOf(doc: ProseMirrorNode): DecorationSet {
  const out: Decoration[] = [];
  doc.descendants((node, pos) => {
    const name = BLOCK[node.type.name];
    if (name !== undefined) out.push(Decoration.node(pos, pos + node.nodeSize, { class: name }));
  });
  return DecorationSet.create(doc, out);
}

/** The box the text stands in: the editor's root wears it (its `editorProps.attributes`). */
export const LETTER_TEXT = letterText.text;

export const LetterNames = Extension.create({
  name: "letterNames",
  addProseMirrorPlugins() {
    /* Drawn again only for a new document: a caret move keeps the set. */
    let drawn: { doc: ProseMirrorNode; set: DecorationSet } | null = null;
    return [
      new Plugin({
        props: {
          decorations: (state) => {
            if (drawn?.doc !== state.doc) drawn = { doc: state.doc, set: blocksOf(state.doc) };
            return drawn.set;
          },
          markViews: {
            code: (_mark, view) => {
              const dom = view.dom.ownerDocument.createElement("code");
              dom.className = letterText.code;
              return { dom };
            },
            link: (mark, view) => {
              const dom = view.dom.ownerDocument.createElement("a");
              dom.className = letterText.link;
              const href: unknown = mark.attrs.href;
              if (typeof href === "string") dom.setAttribute("href", href);
              return { dom };
            },
          },
        },
      }),
    ];
  },
});
