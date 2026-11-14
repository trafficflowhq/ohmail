/**
 * THE COLUMN'S KEYS while it has the keyboard, declared in the key map's registry: `j` and `k` step the list that
 * opened the letter, `u` presses the read slot, `r` answers. The registry binds a chord once and the key sheet lists
 * it; where no registry stands, none is bound. Its own rules hold them: never in a field, never with a modifier.
 */
import { useOptionalKeyBindings, type KeyBinding } from "@ohmail/app-logic/keys";
import type { ListVisit } from "@ohmail/app-logic/reading";
import { useText } from "../text/index.js";
import type { Verbs } from "./actions/use-verbs.js";

/** The list's two steps, where the list that opened the letter handed its visit. */
function stepKeys(visit: ListVisit | null): KeyBinding[] {
  if (visit === null) return [];
  const { up, down } = visit.step;
  return [
    { chord: "j", group: "navigate", label: down.label, disabled: down.disabled, run: () => down.run() },
    { chord: "k", group: "navigate", label: up.label, disabled: up.disabled, run: () => up.run() },
  ];
}

export function useReaderKeys(on: boolean, now: { verbs: Verbs; visit: ListVisit | null }): void {
  const t = useText("reader");
  const { verbs, visit } = now;
  const keys: KeyBinding[] = on
    ? [
        ...stepKeys(visit),
        { chord: "u", group: "message", label: t(`verb.${verbs.readSlot}`), run: () => verbs.act("unread") },
        { chord: "r", group: "message", label: t("key.reply"), run: () => verbs.act("reply") },
      ]
    : [];
  useOptionalKeyBindings(keys, "view");
}
