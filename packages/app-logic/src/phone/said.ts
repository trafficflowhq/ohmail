import type { Translator } from "../text/translator.js";

/**
 * A REFUSAL THE PHONE'S NATIVE SIDE SAID: the key of its sentence and the values it fills, a value being plain text
 * or another refusal. It crosses the bridge as data and is worded on the page, at render, in the language the page
 * reads now. Nested at most three deep.
 */
export interface SaidRefusal {
  readonly code: string;
  readonly args: readonly (string | SaidRefusal)[];
}

/** The reader of the namespace `phoneRefusal`: a key and its values in, the sentence out; and whether it holds a key. */
export type SaidText = Translator & { has(key: string): boolean };

/** The sentence for a code this catalogue does not hold. */
const UNKNOWN = "unknown";
const DEPTH = 3;
/** A code is one plain key of the namespace, never a path into it or a name every object carries. */
const PLAIN = /^[a-z][A-Za-z0-9]*$/;

function known(t: SaidText, code: string): boolean {
  return PLAIN.test(code) && !(code in Object.prototype) && code !== UNKNOWN && t.has(code);
}

function say(t: SaidText, said: SaidRefusal, depth: number): string {
  if (depth > DEPTH || !known(t, said.code)) return t(UNKNOWN);
  if (said.args.length === 0) return t(said.code);
  const values: Record<string, string> = {};
  said.args.forEach((arg, i) => {
    values[String(i)] = typeof arg === "string" ? arg : say(t, arg, depth + 1);
  });
  return t(said.code, values);
}

/** The refusal in words, a refusal inside it worded in the same read; an unknown code says `unknown`. */
export function sayRefusal(t: SaidText, said: SaidRefusal): string {
  return say(t, said, 1);
}
