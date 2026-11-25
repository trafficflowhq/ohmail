import type { EditorView } from "@tiptap/pm/view";
import {
  scrollIntoViewProgrammatically,
  scrollProgrammatically,
} from "@ohmail/app-logic/session/programmatic-scroll";

/** Selection coordinates are viewport pixels. scrollTop is in the editor's own (possibly zoomed) CSS pixels. */
export function revealWritingSelection(view: EditorView): boolean {
  const port = view.dom.closest<HTMLElement>(".oh-composer-scroll");
  if (!view.editable || !port || !port.offsetHeight) return false;
  const bounds = port.getBoundingClientRect();
  const selection = view.dom.ownerDocument.getSelection();
  let caret = view.coordsAtPos(view.state.selection.head);
  if (
    selection?.focusNode &&
    view.dom.contains(selection.focusNode) &&
    view.posAtDOM(selection.focusNode, selection.focusOffset) === view.state.selection.head
  ) {
    const range = view.dom.ownerDocument.createRange();
    range.setStart(selection.focusNode, selection.focusOffset);
    range.collapse(true);
    const rect = range.getBoundingClientRect();
    if (rect.height) caret = rect;
  }
  const scale = bounds.height / parseFloat(getComputedStyle(port).height);
  // A pixel inside either edge leaves room for fractional font metrics and rounded scroll offsets.
  const top = (caret.top - bounds.top) / scale - 1;
  const bottom = (caret.bottom - bounds.bottom) / scale + 1;
  const delta = top < 0 ? Math.floor(top) : Math.max(0, Math.ceil(bottom));
  if (delta) scrollProgrammatically(port, port.scrollTop + delta);
  const box = port.parentElement;
  if (box && box.closest("[data-reading-scroll]"))
    scrollIntoViewProgrammatically(box, { block: "nearest", inline: "nearest" });
  return true;
}
