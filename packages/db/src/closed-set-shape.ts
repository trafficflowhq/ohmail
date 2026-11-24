/**
 * THE SHAPE A GROWING LIST KEEPS AT REST (mail 0202): one lower-case word of at most 48 characters,
 * a letter first, then letters, digits, `_` and `:`. No blank, no capital, no `@`.
 *
 * Three columns of `mailboxes` hold a word from a list that grows with the product (why a mailbox
 * is disabled, why its sync is blocked, which kind of install organizes it). Their members are
 * enforced at the write door on every store (`closed-sets.ts`); a server also holds each value to
 * this shape, so a new member alters no table and no value a mail server chose can stand there.
 * A leaf with no import: the schema and the registry both read it.
 */
export const GROWING_LIST_SHAPE = "^[a-z][a-z0-9_:]{0,47}$";

/** The CHECK body mail 0202 gives `column`, as the entry spells it. */
export function shapeCheck(column: string): string {
  return `"${column}" IS NULL OR "${column}" ~ '${GROWING_LIST_SHAPE}'`;
}

/** Does `value` have the shape? What a server's CHECK answers, for a test or a door to ask first. */
export function hasGrowingListShape(value: string): boolean {
  return new RegExp(GROWING_LIST_SHAPE).test(value);
}
