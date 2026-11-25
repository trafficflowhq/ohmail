import type { EditorView } from "@tiptap/pm/view";
import {
  scrollIntoViewProgrammatically,
  scrollProgrammatically,
} from "@ohmail/app-logic/session/programmatic-scroll";

export function writingCaretRect(editable: HTMLElement, selection: Selection): DOMRect | undefined {
  const { focusNode, focusOffset } = selection;
  if (!focusNode || !editable.contains(focusNode)) return;
  const range = editable.ownerDocument.createRange();
  range.setStart(focusNode, focusOffset);
  range.collapse(true);
  const caret = range.getBoundingClientRect();
  if (caret.height) return caret;
  // The trailing break carries the empty line when the browser gives a collapsed range no box.
  const line = focusNode.childNodes[focusOffset];
  if (line instanceof HTMLBRElement) return line.getBoundingClientRect();
  // WebKit also places the caret just after a text child, a boundary with no rect of its own.
  let previous = focusNode.childNodes[focusOffset - 1];
  while (previous?.lastChild) previous = previous.lastChild;
  if (previous instanceof Text && previous.length) {
    range.setStart(previous, previous.length - 1);
    range.setEnd(previous, previous.length);
    return range.getBoundingClientRect();
  }
}

/** Rects are viewport pixels; scrollTop is in the scrollport's own (possibly zoomed) CSS pixels. */
export function revealWritingRect(
  port: HTMLElement,
  rect: Pick<DOMRect, "top" | "bottom">,
  margin = 0,
): void {
  const bounds = port.getBoundingClientRect();
  if (!bounds.height || rect.bottom - rect.top > bounds.height) return;
  const scale = bounds.height / parseFloat(getComputedStyle(port).height);
  const top = (rect.top - bounds.top) / scale - margin;
  const bottom = (rect.bottom - bounds.bottom) / scale + margin;
  const delta = top < 0 ? Math.floor(top) : Math.max(0, Math.ceil(bottom));
  if (delta) scrollProgrammatically(port, port.scrollTop + delta);
}

export function revealWritingSelection(view: EditorView): boolean {
  const port = view.dom.closest<HTMLElement>(".oh-composer-scroll");
  if (!view.editable || !port || !port.offsetHeight) return false;
  const selection = view.dom.ownerDocument.getSelection();
  let caret = view.coordsAtPos(view.state.selection.head);
  if (
    selection?.focusNode &&
    view.dom.contains(selection.focusNode) &&
    view.posAtDOM(selection.focusNode, selection.focusOffset) === view.state.selection.head
  ) {
    caret = writingCaretRect(view.dom, selection) ?? caret;
  }
  // A pixel inside either edge leaves room for fractional font metrics and rounded scroll offsets.
  revealWritingRect(port, caret, 1);
  const box = port.parentElement;
  if (box?.closest("[data-reading-scroll]") && !box.closest("[data-writing-keyboard]")) {
    scrollIntoViewProgrammatically(box, { block: "nearest", inline: "nearest" });
  }
  return true;
}
