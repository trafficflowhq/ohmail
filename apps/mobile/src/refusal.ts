/**
 * A REFUSAL AS A VALUE, NOT AS A SENTENCE.
 *
 * ── THE DEFECT THIS EXISTS FOR ────────────────────────────────────────────────────────────────
 *
 * `net/connection.tsx` used to put a FORMATTED string into React state —
 * `setState({ k: "refused", reason: Copy.notPairedHere })` — and `app/servers.tsx` rendered it.
 * The deck's getters make every READ live, but they cannot help a value that was read once and
 * kept: switch the app to German with a refusal on screen and the heading turns over while the
 * sentence underneath stays in the language it was produced in. `test/locale.test.ts` measured
 * exactly that and recorded it as a boundary; this is the boundary being moved.
 *
 * The same argument as `StoreFault`, one layer up. There, a failure that crosses a `throw` carries
 * a code because the sentence would be frozen in the language of the moment it was raised. Here, a
 * failure that crosses a `setState` carries a key for the same reason. Format at RENDER, never at
 * production.
 *
 * ── WHY A KEY AND ARGUMENTS RATHER THAN A CLOSED UNION ────────────────────────────────────────
 *
 * A hand-written union of every refusal shape would need a member per sentence and would be a
 * second place to keep in step with the deck. The key IS the deck's key: `RefusalKey` is derived
 * from `Deck`, so a typo does not compile and a key removed from the deck breaks every producer
 * that names it. What the type does NOT check is arity — `args` is a plain list — and that is the
 * deliberate trade: the alternative is a mapped conditional type per arity that reads worse than
 * the thing it protects. `test/refusal.test.ts` closes it at runtime instead, by rendering every
 * refusal the app can produce and asserting none of them comes back with an unfilled hole.
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
 * THE DETAIL INSIDE A TRANSLATED REFUSAL — our own failures worded, everything else quoted.
 *
 * The places that render a caught error used `String(err)`, which is right for a platform
 * exception and wrong for a failure this app authored: an English sentence ends up inside a German
 * one. A {@link StoreFault} carries a code, so it becomes language — but as a nested REFUSAL, not
 * as a sentence. It used to return `Copy.storeFault(err.code)`, formatted at the moment the error
 * was caught, which put frozen English inside six refusals that were otherwise live. Anything that
 * is not ours stays the platform's own words exactly as they are, because a paraphrase would be
 * worse for whoever has to search for the text.
 *
 * It lives here rather than in `copy.ts` because what it returns is a refusal argument.
 */
export function faultDetail(err: unknown): RefusalArg {
  return isStoreFault(err) ? refuse("storeFault", err.code) : String(err);
}
