/**
 * WHAT IS TYPED AS AN OPERATOR: `from:`, `to:`, `in:`, `has:` and `is:`, each a word whose first colon follows its
 * name. Read token by token on whitespace and the first colon, in one pass and with no pattern. A token the field
 * still has the caret in (no space after it) is the one being typed: `from:be` offers the people it names, and only
 * a finished one becomes its filter.
 */

export const OPERATOR_KEYS = ["from", "to", "in", "has", "is"] as const;
export type OperatorKey = (typeof OPERATOR_KEYS)[number];

export interface TypedOperator {
  readonly key: OperatorKey;
  /** What stands after the colon, as typed. */
  readonly value: string;
  /** Where the token starts and ends in the text. */
  readonly at: number;
  readonly end: number;
}

export interface TypedText {
  /** The words that are no operator, joined by one space. */
  readonly words: string;
  /** Every operator a space has finished, with a value. */
  readonly done: readonly TypedOperator[];
  /** The operator at the end the caret is still in, or null. */
  readonly open: TypedOperator | null;
}

const isSpace = (c: string): boolean => c === " " || c === "\t" || c === "\n" || c === "\r" || c === " ";

function operatorOf(token: string, at: number): TypedOperator | null {
  const colon = token.indexOf(":");
  if (colon <= 0) return null;
  const name = token.slice(0, colon).toLowerCase();
  const key = (OPERATOR_KEYS as readonly string[]).includes(name) ? (name as OperatorKey) : null;
  return key === null ? null : { key, value: token.slice(colon + 1), at, end: at + token.length };
}

export function parseOperators(text: string): TypedText {
  const words: string[] = [];
  const done: TypedOperator[] = [];
  let open: TypedOperator | null = null;
  let i = 0;
  while (i < text.length) {
    while (i < text.length && isSpace(text[i]!)) i++;
    if (i >= text.length) break;
    const at = i;
    while (i < text.length && !isSpace(text[i]!)) i++;
    const token = text.slice(at, i);
    const op = operatorOf(token, at);
    if (op === null) words.push(token);
    else if (i >= text.length) open = op;
    else if (op.value !== "") done.push(op);
    else words.push(token);
  }
  return { words: words.join(" "), done, open };
}

/**
 * THE OPERATOR A SPACE HAS JUST FINISHED: the token right before the one space that ends the text, where it is an
 * operator with a value; else null. Reads that token alone, back from the end.
 */
export function justFinished(text: string): TypedOperator | null {
  const end = text.length - 1;
  if (end < 1 || !isSpace(text[end]!) || isSpace(text[end - 1]!)) return null;
  let at = end;
  while (at > 0 && !isSpace(text[at - 1]!)) at--;
  const op = operatorOf(text.slice(at, end), at);
  return op !== null && op.value !== "" ? op : null;
}

/** The text with one operator's token taken out, the spaces around it closed up. */
export function withoutOperator(text: string, op: Pick<TypedOperator, "at" | "end">): string {
  const before = text.slice(0, op.at).trimEnd();
  const after = text.slice(op.end).trimStart();
  /* What follows stays as it was; at the end, a space after the words left, so the next word starts anew. */
  if (after !== "") return before === "" ? after : `${before} ${after}`;
  return before === "" ? "" : `${before} `;
}
