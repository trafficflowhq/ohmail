import { Extension } from "@tiptap/react";
import { Fragment, Slice, type Node } from "@tiptap/pm/model";
import { Plugin, Selection, TextSelection, type EditorState } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { historyIn } from "./quoted-history.js";

function authoredSelection(state: EditorState): Selection | null {
  const history = historyIn(state.doc);
  if (!history || state.selection.to < history.pos) return null;
  const end = Selection.findFrom(state.doc.resolve(history.pos), -1, true)?.head;
  if (end === undefined) return null;
  const { anchor, head } = state.selection;
  return TextSelection.between(
    state.doc.resolve(Math.min(anchor, end)),
    state.doc.resolve(Math.min(head, end)),
  );
}

function startsInHistory(state: EditorState): boolean {
  const history = historyIn(state.doc);
  if (!history) return false;
  return state.selection.from >= history.pos && state.selection.from < history.pos + history.node.nodeSize;
}

function transferable(slice: Slice, folded: boolean): Slice {
  function convert(content: Fragment): Fragment {
    const nodes: Node[] = [];
    content.forEach((node) => {
      if (node.type.name === "quotedHistory") {
        if (!folded) {
          const children = convert(node.content);
          const ordinary = node.type.schema.nodes.blockquote!.createAndFill(null, children);
          if (ordinary) nodes.push(ordinary);
        }
      } else {
        nodes.push(node.isLeaf ? node : node.copy(convert(node.content)));
      }
    });
    return Fragment.from(nodes);
  }
  const content = convert(slice.content);
  if (!content.size) return Slice.empty;
  const bounds = Slice.maxOpen(content);
  return new Slice(
    content,
    Math.min(slice.openStart, bounds.openStart),
    Math.min(slice.openEnd, bounds.openEnd),
  );
}

export const HistorySelection = Extension.create<{ visible: () => boolean }>({
  name: "historySelection",
  addOptions: () => ({ visible: () => false }),
  addProseMirrorPlugins() {
    const folded = () => !this.options.visible();
    return [
      new Plugin({
        appendTransaction: (_transactions, _before, state) => {
          if (!folded()) return null;
          if (historyIn(state.doc)?.pos === 0) {
            const tr = state.tr.insert(0, state.schema.nodes.paragraph!.create());
            return tr.setSelection(TextSelection.create(tr.doc, 1)).setMeta("addToHistory", false);
          }
          const selection = authoredSelection(state);
          return selection && !selection.eq(state.selection) ? state.tr.setSelection(selection) : null;
        },
        props: {
          decorations: (state) => {
            const history = folded() ? historyIn(state.doc) : undefined;
            return history
              ? DecorationSet.create(state.doc, [
                  Decoration.node(history.pos, history.pos + history.node.nodeSize, {
                    contenteditable: "false",
                  }),
                ])
              : null;
          },
          transformCopied: (slice, view) => {
            if (folded() && startsInHistory(view.state)) return Slice.empty;
            return transferable(slice, folded());
          },
          transformPasted: (slice) => transferable(slice, false),
          handleDOMEvents: {
            cut: (view, event) => {
              if (!folded()) return false;
              const selection = authoredSelection(view.state);
              if (selection) view.dispatch(view.state.tr.setSelection(selection));
              if (!startsInHistory(view.state)) return false;
              event.preventDefault();
              return true;
            },
          },
        },
      }),
    ];
  },
});
