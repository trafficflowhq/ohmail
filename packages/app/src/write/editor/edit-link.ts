import type { Editor } from "@tiptap/react";
import { TextSelection } from "@tiptap/pm/state";
import type { EditorLink } from "../ports.js";
import { linkAtCaret, linkRangeAtCaret, normalizeHref } from "./marks.js";

/**
 * Remember the link and its range while the address field has focus: Apply and Remove act on the
 * link the dialog shows. A new link at a caret supplies its own label.
 */
export function openEditorLink(editor: Editor): EditorLink {
  const { doc, selection, storedMarks } = editor.state;
  const current = linkAtCaret(editor.state);
  const range = current ? linkRangeAtCaret(editor.state, current) : null;
  let editedDoc = doc;
  let restoreSelection = selection;
  return {
    href: current?.attrs.href ?? null,
    set(raw) {
      const href = raw === null ? "" : normalizeHref(raw);
      if (href === null || editor.isDestroyed || editor.state.doc !== doc) return "refused";
      const chain = editor.chain().command(({ tr }) => {
        tr.setSelection(
          range ? TextSelection.create(tr.doc, range.from, range.to) : selection,
        ).setStoredMarks(storedMarks);
        return true;
      });
      const insert = href !== "" && selection.empty && !current;
      if (href === "") chain.unsetLink();
      else chain.setLink({ href });
      if (insert) chain.insertContent({ type: "text", text: href });
      const changed = chain.run();
      editedDoc = editor.state.doc;
      if (insert) restoreSelection = editor.state.selection;
      return changed ? "ok" : "refused";
    },
    restore() {
      if (editor.isDestroyed) return;
      if (editor.state.doc === editedDoc && !restoreSelection.eq(editor.state.selection)) {
        const tr = editor.state.tr;
        editor.view.dispatch(tr.setSelection(restoreSelection.getBookmark().resolve(tr.doc)));
      }
      editor.view.focus();
    },
  };
}
