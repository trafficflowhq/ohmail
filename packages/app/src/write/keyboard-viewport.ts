import { useLayoutEffect, useState, type RefObject } from "react";
import { readingScroller } from "@ohmail/ui/mail";

const KEYBOARD_MIN = 100;
const SHORT_ROOM = 200;

/** Keep Write inside the visible glass while the system keyboard consumes part of it. */
export function useWritingViewport(ref: RefObject<HTMLElement | null>, touch: boolean): boolean {
  const [compact, setCompact] = useState(false);
  useLayoutEffect(() => {
    const sheet = ref.current?.closest<HTMLElement>('.oh-sheet[data-kind="reading"]');
    const doc = sheet?.ownerDocument;
    const win = doc?.defaultView;
    const viewport = win?.visualViewport;
    if (!touch || !sheet || !doc || !win || !viewport) return;
    const scroll = readingScroller(sheet);
    let width = win.innerWidth;
    let height = win.innerHeight;
    let keyboard = false;
    let frame = 0;
    const clear = () => {
      setCompact(false);
      sheet.removeAttribute("data-writing-keyboard");
      sheet.removeAttribute("data-writing-compact");
      sheet.style.removeProperty("--write-room");
      sheet.style.removeProperty("--write-top");
    };
    const revealCaret = (): void => {
      const active = doc.activeElement;
      if (!active || !scroll?.contains(active)) return;
      let caret = active.getBoundingClientRect();
      const selected = win.getSelection();
      if (
        active instanceof HTMLElement &&
        active.isContentEditable &&
        selected?.rangeCount &&
        active.contains(selected.focusNode)
      ) {
        const at = doc.createRange();
        at.setStart(selected.focusNode!, selected.focusOffset);
        at.collapse(true);
        const rect = at.getBoundingClientRect();
        if (rect.height) caret = rect;
      }
      const visible = scroll.getBoundingClientRect();
      const editor = active.closest(".oh-composer-editor")?.getBoundingClientRect();
      if (editor && editor.height <= visible.height) caret = editor;
      if (caret.bottom > visible.bottom && caret.height <= visible.height) {
        scroll.scrollTop += Math.ceil(caret.bottom - visible.bottom);
      } else if (caret.top < visible.top) {
        scroll.scrollTop -= Math.ceil(visible.top - caret.top);
      }
    };
    const update = () => {
      frame = 0;
      if (viewport.scale !== 1) {
        keyboard = false;
        clear();
        return;
      }
      if (width !== win.innerWidth) {
        width = win.innerWidth;
        height = win.innerHeight;
      }
      height = Math.max(height, win.innerHeight);
      const focus = doc.activeElement;
      const editing = focus?.matches("input, textarea, [contenteditable=true]") && sheet.contains(focus);
      keyboard = height - viewport.height > KEYBOARD_MIN && (Boolean(editing) || keyboard);
      if (!keyboard) {
        clear();
        return;
      }
      const offset = parseFloat(sheet.style.getPropertyValue("--write-top")) || 0;
      const top = sheet.getBoundingClientRect().top - offset;
      const rise = Math.max(0, viewport.offsetTop - top);
      const room = Math.max(0, viewport.offsetTop + viewport.height - top - rise);
      sheet.style.setProperty("--write-top", `${rise}px`);
      sheet.style.setProperty("--write-room", `${room}px`);
      sheet.setAttribute("data-writing-keyboard", "");
      sheet.toggleAttribute("data-writing-compact", room < SHORT_ROOM);
      setCompact(room < SHORT_ROOM);
      revealCaret();
    };
    const schedule = () => {
      if (!frame) frame = win.requestAnimationFrame(update);
    };
    update();
    viewport.addEventListener("resize", schedule, { passive: true });
    viewport.addEventListener("scroll", schedule, { passive: true });
    win.addEventListener("resize", schedule, { passive: true });
    doc.addEventListener("focusin", schedule);
    doc.addEventListener("selectionchange", schedule);
    sheet.addEventListener("input", schedule);
    return () => {
      if (frame) win.cancelAnimationFrame(frame);
      viewport.removeEventListener("resize", schedule);
      viewport.removeEventListener("scroll", schedule);
      win.removeEventListener("resize", schedule);
      doc.removeEventListener("focusin", schedule);
      doc.removeEventListener("selectionchange", schedule);
      sheet.removeEventListener("input", schedule);
      clear();
    };
  }, [ref, touch]);
  return compact;
}
