/**
 * THE COLUMN'S KEYS while it has the keyboard: `j` and `k` step the list that opened the letter, `u` presses the read
 * slot, `r` answers. Never in a field, never with a modifier. Bound by the reader until the key map's own door
 * carries the column's bindings.
 */
import { useEffect, useRef } from "react";
import type { ListVisit } from "@ohmail/app-logic/reading";
import type { Verbs } from "./actions/use-verbs.js";

/** A field, or text a person edits (read off the attribute too, where an engine does not report it). */
const editable = (t: EventTarget | null): boolean =>
  t instanceof HTMLElement &&
  (t.isContentEditable ||
    t.closest('[contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]') !==
      null ||
    t.tagName === "INPUT" ||
    t.tagName === "TEXTAREA" ||
    t.tagName === "SELECT");

export function useReaderKeys(
  on: boolean,
  root: Element | null,
  now: { verbs: Verbs; visit: ListVisit | null },
): void {
  const latest = useRef(now);
  latest.current = now;
  useEffect(() => {
    const win = root?.ownerDocument.defaultView;
    if (!on || !win) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || editable(e.target)) return;
      const { verbs, visit } = latest.current;
      const run = (): (() => void) | null => {
        switch (e.key) {
          case "j":
            return visit && !visit.step.down.disabled ? visit.step.down.run : null;
          case "k":
            return visit && !visit.step.up.disabled ? visit.step.up.run : null;
          case "u":
            return () => verbs.act("unread");
          case "r":
            return () => verbs.act("reply");
          default:
            return null;
        }
      };
      const go = run();
      if (go === null) return;
      e.preventDefault();
      go();
    };
    win.addEventListener("keydown", onKey);
    return () => win.removeEventListener("keydown", onKey);
  }, [on, root]);
}
