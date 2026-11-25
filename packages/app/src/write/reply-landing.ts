import { useContext, useEffect, type RefObject } from "react";
import { FrameContext } from "../frame/commands.js";
import { useWritingViewport } from "./keyboard-viewport.js";
import {
  scrollIntoViewProgrammatically,
  scrollProgrammatically,
} from "@ohmail/app-logic/session/programmatic-scroll";

/**
 * THE REPLY COMES TO THE PERSON when it opens: the conversation above it can be taller than the column, and the text's
 * focus does not scroll (`scrollIntoView: false`), so a reply opened under a long letter would stand below the fold.
 * Its sheet (the composer's own, handed by its ref) is brought into view by its bottom edge, where its last line and
 * the foot are. While the conversation or editor is still settling, keep that landing until the person takes over.
 */
export function useReplyViewport(sheet: RefObject<HTMLElement | null>): void {
  useWritingViewport(sheet, useContext(FrameContext)?.api.plan.pointer === "coarse");
  useEffect(() => {
    const editor = sheet.current;
    if (!editor) return;
    const port = editor.closest<HTMLElement>("[data-reading-scroll]");
    const run = editor.closest(".oh-sheet-run");
    if (!port?.closest("[data-writing-keyboard]")) scrollIntoViewProgrammatically(editor, { block: "end" });
    if (!port || !run || typeof ResizeObserver !== "function") return;

    let settling = Boolean(port.closest("[data-read-column]"));
    const watch = new ResizeObserver(() => {
      if (port.closest("[data-writing-keyboard]")) return;
      if (settling) scrollProgrammatically(port, port.scrollHeight - port.clientHeight);
      else if (editor.contains(editor.ownerDocument.activeElement)) {
        // The reply grows upwards while typing. Once capped, only its text scrolls.
        scrollIntoViewProgrammatically(editor.querySelector(".oh-composer-editor") ?? editor, {
          block: "nearest",
        });
      }
    });
    watch.observe(editor);
    if (settling) {
      watch.observe(run);
      watch.observe(port);
    }
    const input = ["wheel", "touchstart", "pointerdown", "keydown"] as const;
    const release = (): void => {
      settling = false;
      watch.unobserve(run);
      watch.unobserve(port);
      for (const event of input) port.removeEventListener(event, release, true);
    };
    for (const event of input) port.addEventListener(event, release, { passive: true, capture: true });
    return () => {
      release();
      watch.disconnect();
    };
  }, [sheet]);
}
