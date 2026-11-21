import { useEffect, type RefObject } from "react";
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
export function useLandInView(sheet: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const editor = sheet.current;
    if (!editor) return;
    const port = editor.closest<HTMLElement>("[data-reading-scroll]");
    const run = editor.closest(".oh-sheet-run");
    scrollIntoViewProgrammatically(editor, { block: "end" });
    if (!port || !run || !port.closest("[data-read-column]") || typeof ResizeObserver !== "function") return;

    const land = (): void => scrollProgrammatically(port, port.scrollHeight - port.clientHeight);
    const watch = new ResizeObserver(land);
    watch.observe(run);
    watch.observe(port);
    watch.observe(editor);
    const input = ["wheel", "touchstart", "pointerdown", "keydown"] as const;
    const release = (): void => {
      watch.disconnect();
      for (const event of input) port.removeEventListener(event, release, true);
    };
    for (const event of input) port.addEventListener(event, release, { passive: true, capture: true });
    return release;
  }, [sheet]);
}
