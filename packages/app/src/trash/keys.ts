/**
 * TRASH'S KEYS while its column has the keyboard: `u` presses the read slot and ⇧⌫ Restore, the two keys its panel
 * names, for the deleted letter that stands open. Never in a field, never with Ctrl, Cmd or Alt, never while a dialog
 * or a menu stands over the column; a held ⇧⌫ is one press, as the released Trash had it.
 */
import { useEffect, useRef } from "react";
import { chordMatches, isTypingTarget } from "@ohmail/app-logic/keys";
import { isModalOpen } from "@ohmail/app-logic/session/modal-gate";

export interface TrashKeys {
  readonly read: () => void;
  readonly restore: () => void;
}

export function useTrashKeys(on: boolean, root: Element | null, keys: TrashKeys | null): void {
  const latest = useRef(keys);
  latest.current = keys;
  useEffect(() => {
    const win = root?.ownerDocument.defaultView;
    if (!on || !win) return;
    const onKey = (e: KeyboardEvent): void => {
      const now = latest.current;
      if (now === null || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
      if (isTypingTarget(e.target) || isModalOpen(win.document)) return;
      const go = chordMatches("u", e)
        ? now.read
        : chordMatches("shift+Backspace", e) && !e.repeat
          ? now.restore
          : null;
      if (go === null) return;
      e.preventDefault();
      go();
    };
    win.addEventListener("keydown", onKey);
    return () => win.removeEventListener("keydown", onKey);
  }, [on, root]);
}
