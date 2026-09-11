/**
 * A refusal as a value, not as a sentence. A formatted string in React state is read once and
 * kept: switch the app to German with a refusal on screen and the heading turns over while the
 * sentence stays in the language it was produced in (`test/locale.test.ts` measured it). The
 * same argument as `StoreFault`, one layer up: a failure that crosses a `setState` carries a
 * key for the reason one that crosses a `throw` carries a code — format at render, never at
 * production. A key and arguments rather than a closed union: `RefusalKey` is derived from
 * `Deck`, so a typo does not compile and a removed key breaks every producer. Arity is
 * deliberately unchecked; `test/refusal.test.ts` renders every refusal and refuses unfilled holes.
 */
import { Copy, type Deck } from "./copy";
import { isStoreFault } from "./state/servers";

/** Every deck member a refusal can name: a plain sentence, or one that takes arguments. */
export type RefusalKey = {
  [K in keyof Deck]: Deck[K] extends string ? K
    : Deck[K] extends (...args: never[]) => string ? K : never;
}[keyof Deck];

/**
 * What a sentence interpolates: a value quoted verbatim — an address, an account, a platform
 * diagnostic — or ANOTHER REFUSAL.
 *
 * The nested case is not a nicety. A refusal that explains itself by naming an inner refusal was
 * being built as `refuse("outer", sayRefusal(inner))`, which renders the inner half AT PRODUCTION
 * TIME and freezes it. The outer sentence then followed a language switch and the clause inside it
 * did not — the very defect this module exists for, one level down, and invisible to a guard that
 * only looked for `Copy.` in the producers.
 */
export type RefusalArg = string | number | boolean | Refusal;

/**
 * What a layer hands upward when it refuses. `args` are the values the sentence interpolates —
 * never words of our own, and never words of our own that have already been formatted.
 */
export interface Refusal {
  say: RefusalKey;
  args?: readonly RefusalArg[];
}

/** Build one. A function only so the call sites read as sentences rather than object literals. */
export const refuse = (
  say: RefusalKey, ...args: readonly RefusalArg[]
): Refusal => (args.length === 0 ? { say } : { say, args });

/**
 * Is this argument another refusal? Structural, because a refusal is plain data: it is built by
 * {@link refuse} in this process and never crosses JSON, so there is nothing to brand it with.
 */
const isRefusal = (a: RefusalArg): a is Refusal =>
  typeof a === "object" && a !== null && typeof (a as Refusal).say === "string";

/**
 * Turn a refusal into words, IN THE LANGUAGE THAT IS ACTIVE NOW. Every render site calls this;
 * nothing stores what it returns.
 */
export function sayRefusal(r: Refusal): string {
  const member = (Copy as unknown as Record<string, unknown>)[r.say];
  if (typeof member === "function") {
    /* A nested refusal is rendered HERE, in the same read, so both halves of the sentence are in
       the language that is active now. */
    const filled = (r.args ?? []).map((a) => (isRefusal(a) ? sayRefusal(a) : a));
    return (member as (...a: unknown[]) => string)(...filled);
  }
  return member as string;
}

/**
 * WORDS FOR A REFUSAL ARGUMENT — a nested refusal rendered NOW, anything else exactly as it is.
 *
 * What a render site calls when it holds one of these directly rather than inside a sentence: the
 * standing sync failure on the Servers screen, the stalled-wait line under a skeleton. Both used
 * to hold a `string` produced at the moment the round failed.
 */
export const sayArg = (a: RefusalArg): string => (isRefusal(a) ? sayRefusal(a) : String(a));

/**
 * The detail inside a translated refusal — our own failures worded, everything else quoted.
 * `String(err)` is right for a platform exception and wrong for a failure this app authored:
 * an English sentence inside a German one. A {@link StoreFault} carries a code, so it becomes
 * language — but as a nested refusal, not a sentence: formatting at the catch put frozen
 * English inside six refusals that were otherwise live. Anything not ours stays the platform's
 * own words exactly, because a paraphrase is worse for whoever has to search for the text. It
 * lives here rather than in `copy.ts` because what it returns is a refusal argument.
 */
export function faultDetail(err: unknown): RefusalArg {
  return isStoreFault(err) ? refuse("storeFault", err.code) : String(err);
}
