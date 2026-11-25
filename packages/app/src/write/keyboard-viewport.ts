import { useContext, useLayoutEffect, useState, type RefObject } from "react";
import { uiZoom } from "@ohmail/ui";
import { readingScroller } from "@ohmail/ui/mail";
import { FrameContext } from "../frame/commands.js";
import { NONE } from "../host/contract.js";
import { revealWritingRect, writingCaretRect } from "./editor/scroll-selection.js";

const KEYBOARD_MIN = 100;
const SHORT_ROOM = 200;

/** Keep Write inside the visible glass while the system keyboard consumes part of it. */
export function useWritingViewport(ref: RefObject<HTMLElement | null>, touch: boolean): boolean {
  const [compact, setCompact] = useState(false);
  const native = useContext(FrameContext)?.api.host.signals.keyboard ?? NONE;
  useLayoutEffect(() => {
    const sheet = ref.current?.closest<HTMLElement>('.oh-sheet[data-kind="reading"]');
    const doc = sheet?.ownerDocument;
    const win = doc?.defaultView;
    if (!touch || !sheet || !doc || !win) return;
    const viewport = win.visualViewport;
    const scroll = readingScroller(sheet);
    const composer = scroll?.querySelector<HTMLElement>(".oh-composer");
    const text = composer?.querySelector<HTMLElement>(".oh-composer-scroll");
    let width = win.innerWidth;
    let height = win.innerHeight;
    let keyboard = false;
    let nativeResizedLayout = false;
    let rise = 0;
    let room = 0;
    let frame = 0;
    const clear = () => {
      if (room === 0 && !sheet.hasAttribute("data-writing-keyboard")) return;
      rise = room = 0;
      setCompact(false);
      sheet.removeAttribute("data-writing-keyboard");
      sheet.removeAttribute("data-writing-compact");
      sheet.style.removeProperty("--write-room");
      sheet.style.removeProperty("--write-top");
      sheet.style.removeProperty("--write-text-room");
    };
    const update = () => {
      frame = 0;
      const nativeHeight = native === NONE ? 0 : native.read().height;
      if (nativeHeight === 0) nativeResizedLayout = false;
      if (viewport && viewport.scale !== 1) {
        keyboard = false;
        clear();
        return;
      }
      const layoutWidth = win.innerWidth;
      const layoutHeight = win.innerHeight;
      const visualHeight = viewport?.height ?? layoutHeight;
      const visibleTop = viewport?.offsetTop ?? 0;
      // Compare the settled layout with the old baseline before a width change replaces it.
      if (nativeHeight > 0 && height - layoutHeight > KEYBOARD_MIN) nativeResizedLayout = true;
      if (width !== layoutWidth) {
        width = layoutWidth;
        height = layoutHeight;
      }
      height = Math.max(height, layoutHeight);
      const focus = doc.activeElement;
      const editing = focus?.matches("input, textarea, [contenteditable=true]") && sheet.contains(focus);
      const shrunk = height - visualHeight > KEYBOARD_MIN;
      keyboard = (shrunk || nativeHeight > 0) && (Boolean(editing) || keyboard);
      if (!keyboard) {
        clear();
        return;
      }
      // Use the measured height once the browser has accounted for the keyboard.
      const visibleHeight =
        shrunk || nativeResizedLayout ? visualHeight : Math.min(visualHeight, height - nativeHeight);
      const zoom = uiZoom(doc);
      const top = sheet.getBoundingClientRect().top - rise * zoom;
      const nextRise = Math.max(0, (visibleTop - top) / zoom);
      const nextRoom = Math.max(0, (visibleTop + visibleHeight - top) / zoom - nextRise);
      if (rise !== nextRise || room !== nextRoom || !sheet.hasAttribute("data-writing-keyboard")) {
        rise = nextRise;
        room = nextRoom;
        sheet.style.setProperty("--write-top", `${rise}px`);
        sheet.style.setProperty("--write-room", `${room}px`);
        sheet.setAttribute("data-writing-keyboard", "");
        sheet.toggleAttribute("data-writing-compact", room < SHORT_ROOM);
        setCompact(room < SHORT_ROOM);
      }
      if (scroll && composer && text) {
        // The envelope and tools take their natural height. The text takes the space left, down to one line.
        const chrome = composer.getBoundingClientRect().height - text.getBoundingClientRect().height;
        const space = Math.max(0, (scroll.getBoundingClientRect().height - chrome) / zoom - 1);
        const value = `${space}px`;
        if (sheet.style.getPropertyValue("--write-text-room") !== value) {
          sheet.style.setProperty("--write-text-room", value);
        }
      }
      if (scroll) revealCaret(scroll);
    };
    const schedule = () => {
      if (!frame) frame = win.requestAnimationFrame(update);
    };
    const unsubscribe = native === NONE ? undefined : native.subscribe(schedule);
    const size =
      composer && typeof ResizeObserver === "function"
        ? new ResizeObserver(() => {
            if (keyboard) schedule();
          })
        : null;
    if (composer) size?.observe(composer);
    if (text) size?.observe(text);
    update();
    viewport?.addEventListener("resize", schedule, { passive: true });
    viewport?.addEventListener("scroll", schedule, { passive: true });
    win.addEventListener("resize", schedule, { passive: true });
    doc.addEventListener("focusin", schedule);
    doc.addEventListener("selectionchange", schedule);
    sheet.addEventListener("input", schedule);
    return () => {
      if (frame) win.cancelAnimationFrame(frame);
      unsubscribe?.();
      size?.disconnect();
      viewport?.removeEventListener("resize", schedule);
      viewport?.removeEventListener("scroll", schedule);
      win.removeEventListener("resize", schedule);
      doc.removeEventListener("focusin", schedule);
      doc.removeEventListener("selectionchange", schedule);
      sheet.removeEventListener("input", schedule);
      clear();
    };
  }, [ref, touch, native]);
  return compact;
}

function revealCaret(scroll: HTMLElement): void {
  const doc = scroll.ownerDocument;
  const active = doc.activeElement;
  if (!(active instanceof HTMLElement) || !scroll.contains(active)) return;
  const visible = scroll.getBoundingClientRect();
  const editor = active.closest<HTMLElement>(".oh-composer-editor");
  const composer = active.closest<HTMLElement>(".oh-composer")?.getBoundingClientRect();
  const editorBox = editor?.getBoundingClientRect();
  const textPort = active.closest<HTMLElement>(".oh-composer-scroll");
  const selection = textPort && active.isContentEditable ? doc.getSelection() : null;
  const caret = selection && writingCaretRect(active, selection);
  if (textPort && caret) revealWritingRect(textPort, caret, 1);
  // Keep the envelope in view when it fits. In short windows, prioritize the active field.
  const target =
    composer && composer.height <= visible.height
      ? composer
      : editorBox && editorBox.height <= visible.height
        ? editorBox
        : (selection && writingCaretRect(active, selection)) || active.getBoundingClientRect();
  revealWritingRect(scroll, target);
}
