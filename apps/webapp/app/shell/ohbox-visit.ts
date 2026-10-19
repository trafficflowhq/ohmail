"use client";

/**
 * WHEN A PERSON LEAVES THE OHBOX, its visit mark moves (`OhmailEngine.markOhboxVisit`), and the
 * where-line counts from there next time. A visit is the Ohbox open with the tab visible; it ends on
 * a switch to another pile, the tab going hidden, or the page unloading. Opening a message, in the
 * split pane or the reader sheet, keeps the Ohbox open and is not a leave. A visit nobody saw writes
 * nothing, and neither does the demo (`open` is false there). The mark is device-local and never on
 * the wire.
 */
import { useEffect, useRef } from "react";
import { documentHidden } from "./document-hidden";

export interface VisitMarker {
  markOhboxVisit(): Promise<boolean>;
}

export function useOhboxVisitMark(engine: VisitMarker | null | undefined, open: boolean): void {
  /** Was the Ohbox visible at some point since the last leave? Only then is a leave written. */
  const seen = useRef(false);
  const engineRef = useRef(engine);
  const wasOpen = useRef(false);

  useEffect(() => {
    if (engineRef.current !== engine) seen.current = open && !documentHidden();
    engineRef.current = engine;
  }, [engine, open]);

  useEffect(() => {
    const leave = (): void => {
      if (!seen.current) return;
      seen.current = false;
      void engineRef.current?.markOhboxVisit().catch(() => { /* the next leave tries again */ });
    };
    // A switch away from the Ohbox. Not on unmount: a sign-out takes the mirror with it.
    if (wasOpen.current && !open) leave();
    wasOpen.current = open;
    if (!open) return;
    if (!documentHidden()) seen.current = true;
    const onVisibility = (): void => {
      if (documentHidden()) leave();
      else seen.current = true;
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", leave);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", leave);
    };
  }, [open]);
}
