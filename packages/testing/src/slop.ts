/**
 * THE OWNER'S BANNED VOCABULARY, AS ONE REGEX — shared, so a second sweep is not a second rule.
 *
 * It lived inline in the landing page's copy test while that page was the only surface swept. It
 * is not any more: the desktop window's own namespaces are swept too, and two copies of a banned
 * word list is exactly how one of them comes to permit a word the other refuses.
 *
 * It sits in this package rather than beside either sweep because one of those sweeps ships in
 * the public tree and the other does not — a published test importing an unpublished helper is a
 * tree that cannot compile where a reader gets it, which is what the publish refuses. This
 * package publishes whole, so both sides can hold the same rule.
 *
 * Word-boundary anchored on both ends so "simplicity" does not trip on "simply"'s stem, and the
 * usual German renderings are included because the product ships in two languages and a rule that
 * only holds in English holds for half the product.
 */
export const SLOP =
  /\b(seamless(?:ly)?|effortless(?:ly)?|powerful|simply|nahtlos(?:e[snmr]?)?|mühelos(?:e[snmr]?)?)\b/i;
