/** Search's cursor and preview keys share the frame's key registry and overlay priority. */
import type { RefObject } from "react";
import { isTypingTarget, useKeyBindings, type KeyBinding } from "../keys/keymap.js";
import { useZoneIs } from "../keys/zone-nav.js";
import type { Translator } from "../text/translator.js";

export interface SearchKeysInput {
  readonly t: Translator;
  readonly searchBy: "people" | "words";
  readonly text: string;
  readonly onQuery: (q: string) => void;
  readonly onExit: (() => void) | "none";
  readonly boxRef: RefObject<HTMLInputElement | null>;
  readonly count: number;
  readonly cursor: number;
  readonly previewOpen: boolean;
  readonly walkPreview: boolean;
  readonly closePreview?: () => void;
  step(direction: -1 | 1): void;
  /** Open what stands at the cursor. */
  openAt(i: number): void;
}

export function useSearchKeys(k: SearchKeysInput): void {
  const { t } = k;
  const inList = useZoneIs("list");
  const inReader = useZoneIs("reader");
  const beside = k.previewOpen && k.walkPreview;
  const canWalk = k.count > 0 && inList;
  const canWalkLetters = k.count > 0 && ((beside && inReader) || (inList && (!k.previewOpen || beside)));
  const walk = (chord: string, direction: -1 | 1, arrow: boolean): KeyBinding => ({
    chord,
    group: "navigate",
    label: t(direction === 1 ? "keyNext" : "keyPrev"),
    inInput: arrow,
    disabled: !(arrow ? canWalk : canWalkLetters),
    when: (event) => !isTypingTarget(event.target) || (arrow && event.target === k.boxRef.current),
    run: () => k.step(direction),
  });
  const keys: KeyBinding[] = [
    {
      chord: "Escape",
      group: "navigate",
      label: t(beside ? "keyClosePreview" : "keyClose"),
      inInput: true,
      disabled: beside
        ? !(inList || inReader)
        : k.previewOpen || !inList || (k.text === "" && k.onExit === "none"),
      run: () => {
        if (beside) k.closePreview?.();
        else if (k.text !== "") {
          k.onQuery("");
          k.boxRef.current?.focus();
        } else if (k.onExit !== "none") k.onExit();
      },
    },
    walk("ArrowDown", 1, true),
    walk("ArrowUp", -1, true),
    walk("j", 1, false),
    walk("k", -1, false),
    {
      chord: "Enter",
      group: "message",
      label: t("keyOpen"),
      inInput: true,
      /**
       * The box also submits the query to the store on Enter. Open the hit at the current cursor.
       */
      disabled: k.cursor < 0 || !inList,
      // The cursor's hit, never the first: the cursor is the whole point of the two bindings above.
      run: () => k.openAt(k.cursor),
    },
  ];
  if (k.searchBy === "people") {
    for (const [chord, key] of [
      ["from:", "keyPerson"],
      ["to:", "keyPerson"],
      ["in:", "keyFilter"],
      ["has:", "keyFilter"],
      ["is:", "keyFilter"],
      ["Backspace", "keyLetGo"],
    ]) {
      keys.push({ chord, group: "navigate", label: t(key), helpOnly: true, run: () => {} });
    }
  }
  useKeyBindings(keys);
}
