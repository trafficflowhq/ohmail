/**
 * THE KEYS A ROW PRINTS, from the keyboard registry alone: a chord's keys only while a binding with that chord is
 * declared; none for a chord nobody holds. A hint is never typed by hand.
 */
import { chordKeys, type BoundKey } from "@ohmail/app-logic/keys";

export function keysOf(
  chord: string | undefined,
  bindings: readonly BoundKey[],
  mod: string,
): readonly string[] | undefined {
  if (chord === undefined || !bindings.some((binding) => binding.chord === chord)) return undefined;
  return chordKeys(chord, mod);
}
