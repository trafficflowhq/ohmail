/**
 * SEARCH'S KEYS: Escape in two steps, the two arrows and Enter. The box holds focus from the moment the list mounts,
 * so every one of them carries `inInput`; and every one is inert where the rail owns the keys (`useZoneIs("list")`),
 * which the `?` sheet reads as the same statement. `j`/`k` are deliberately NOT bound here — they follow PILE order,
 * never search-hit order; after ↵ opens a hit the pile's own `j`/`k` take over where the message lives.
 */
import type { RefObject } from "react";
import { useKeyBindings, type KeyBinding } from "../keys/keymap.js";
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
  stepTo(i: number): void;
  /** Open what stands at the cursor. */
  openAt(i: number): void;
}

export function useSearchKeys(k: SearchKeysInput): void {
  const { t } = k;
  const inList = useZoneIs("list");
  const keys: KeyBinding[] = [
    /**
     * ESCAPE, IN TWO HONEST STEPS — the app's own sentence is "esc — Close what is open".
     * What is open here is first the QUESTION (a non-empty box: one press clears it, focus
     * stays, the caret is ready for the next thought) and then the VIEW (a second press —
     * or the first on an empty box — hands the screen back to wherever `/` was pressed).
     * The shell's `overlay`-scope Escape outranks this while anything is open on top, so a
     * reader sheet over Search still closes before the query is touched.
     */
    {
      chord: "Escape",
      group: "navigate",
      label: t("keyClose"),
      inInput: true,
      disabled: (k.text === "" && k.onExit === "none") || !inList,
      run: () => {
        if (k.text !== "") {
          k.onQuery("");
          /* And the caret goes back in the box, which clearing alone does not do: the person who got here with ↓
             has focus on a HIT ROW, and clearing the query removes every row — focus falls to `<body>`, where the
             next letter is dispatched as a BINDING (measured: after Escape on a non-empty result, `c` opened Compose
             instead of asking). Not on the LEAVE arm: a caret in a field nobody can see. */
          k.boxRef.current?.focus();
        } else if (k.onExit !== "none") k.onExit();
      },
    },
    {
      chord: "ArrowDown",
      group: "navigate",
      label: t("keyNext"),
      inInput: true,
      disabled: k.count === 0 || !inList,
      run: () => k.stepTo(Math.min(k.cursor + 1, k.count - 1)),
    },
    {
      chord: "ArrowUp",
      group: "navigate",
      label: t("keyPrev"),
      inInput: true,
      disabled: k.count === 0 || !inList,
      run: () => k.stepTo(Math.max(k.cursor - 1, 0)),
    },
    {
      chord: "Enter",
      group: "message",
      label: t("keyOpen"),
      inInput: true,
      /**
       * `disabled` when there is nothing to open — a statement to the `?` sheet, not a guard. The box fires its own
       * submit on Enter (how Enter re-asks the archive), and both run when a hit is open, harmlessly: the list
       * unmounts on navigation and the pass's cleanup cancels its debounce.
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
