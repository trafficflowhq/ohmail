/**
 * The read slot’s `u` key, and the Restore shortcut listed in the shared registry.
 */
import { useEffect, useRef } from "react";
import { chordMatches, isTypingTarget, useOptionalKeyBindings } from "@ohmail/app-logic/keys";
import { isModalOpen } from "@ohmail/app-logic/session/modal-gate";
import { useFrame } from "../frame/commands.js";
import { NONE } from "../host/index.js";
import { useText } from "../text/index.js";

export interface TrashKeys {
  readonly read: () => void;
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
      if (!chordMatches("u", e)) return;
      e.preventDefault();
      now.read();
    };
    win.addEventListener("keydown", onKey);
    return () => win.removeEventListener("keydown", onKey);
  }, [on, root]);
}

/** Restore is listed wherever mail stands, and runs only for the open deleted letter. */
export function useRestoreBinding(listed: boolean, label: string, restore?: () => void): void {
  useOptionalKeyBindings(
    listed
      ? [
          {
            chord: "shift+Backspace",
            group: "message",
            label,
            disabled: restore === undefined,
            when: (event) => {
              if (event.repeat) return false;
              const target = event.target;
              const doc =
                event.view?.document ??
                (target instanceof Document ? target : target instanceof Node ? target.ownerDocument : null);
              return doc !== null && !isModalOpen(doc);
            },
            run: () => restore?.(),
          },
        ]
      : [],
  );
}

export function RestingRestore(): null {
  const { route, host, product } = useFrame();
  const t = useText("trash");
  useRestoreBinding(
    product === "mail" && route.place !== "trash" && host.features.places.trash !== NONE,
    t("restoreKey"),
  );
  return null;
}
