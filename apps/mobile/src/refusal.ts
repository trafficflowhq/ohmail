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

/** Every deck member a refusal can name: a plain sentence, or one that takes arguments. */
export type RefusalKey = {
  [K in keyof Deck]: Deck[K] extends string ? K
    : Deck[K] extends (...args: never[]) => string ? K : never;
}[keyof Deck];

/**
 * What a layer hands upward when it refuses. `args` are the values the sentence interpolates —
 * an address, an account, a platform diagnostic — never words of our own.
 */
export interface Refusal {
  say: RefusalKey;
  args?: readonly (string | number | boolean)[];
}

/** Build one. A function only so the call sites read as sentences rather than object literals. */
export const refuse = (
  say: RefusalKey, ...args: readonly (string | number | boolean)[]
): Refusal => (args.length === 0 ? { say } : { say, args });

/**
 * Turn a refusal into words, IN THE LANGUAGE THAT IS ACTIVE NOW. Every render site calls this;
 * nothing stores what it returns.
 */
export function sayRefusal(r: Refusal): string {
  const member = (Copy as unknown as Record<string, unknown>)[r.say];
  if (typeof member === "function") {
    return (member as (...a: unknown[]) => string)(...(r.args ?? []));
  }
  return member as string;
}
