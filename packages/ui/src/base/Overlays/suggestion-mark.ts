/** Which part of a suggestion's line a person typed: where a word of the line begins with a typed word. */

/** What two spellings share: case, accents, and a sharp s read as two. */
const fold = (text: string): string =>
  text.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").replace(/ß/g, "ss");

/** What stands between two words of a line or of what was typed. */
const BETWEEN = String.raw`\s,;.\-/()|@·–`;
const WORD = new RegExp(`[^${BETWEEN}]+`, "gu");
const MARK = /^\p{M}/u;

/** How many of `word`'s own characters spell `count` folded ones: an accent rides with its letter. */
function reach(word: string, count: number): number {
  let end = 1;
  while (end < word.length && fold(word.slice(0, end)).length < count) end++;
  while (end < word.length && MARK.test(word.slice(end))) end++;
  return end;
}

export interface TypedPart {
  text: string;
  /** This stretch is what the person typed: it is drawn bold. */
  typed: boolean;
}

/**
 * `text` in the stretches a person typed and the ones between, in the line's own order. A stretch is typed
 * where a word of the line begins with one of the typed words; case and accents do not count.
 */
export function markTyped(text: string, typed: string): readonly TypedPart[] {
  const words = fold(typed).match(WORD) ?? [];
  const parts: TypedPart[] = [];
  let from = 0;
  for (const found of words.length ? text.matchAll(WORD) : []) {
    const word = found[0];
    const folded = fold(word);
    const longest = Math.max(0, ...words.filter((w) => folded.startsWith(w)).map((w) => w.length));
    if (!longest) continue;
    const end = found.index + reach(word, longest);
    if (found.index > from) parts.push({ text: text.slice(from, found.index), typed: false });
    parts.push({ text: text.slice(found.index, end), typed: true });
    from = end;
  }
  if (from < text.length || !parts.length) parts.push({ text: text.slice(from), typed: false });
  return parts;
}
