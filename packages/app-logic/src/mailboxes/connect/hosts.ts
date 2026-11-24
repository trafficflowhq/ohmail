/** A rule about the two host fields, moved here from the Mailboxes pane as it stood. */

/**
 * "Fix both fields in one press" — should applying a canonical-host suggestion to the failing
 * transport's field also correct the OTHER one? Yes exactly when both current values are the
 * same name one label deeper (mail.example.com / smtp.example.com): the vanity pair that points
 * at one provider server. Comparing the values MINUS their first label, rather than a public-
 * suffix heuristic, is what keeps `mail.foo.co.uk` from dragging `smtp.bar.co.uk` along.
 */
export function sameVanityParent(a: string, b: string): boolean {
  const parent = (h: string): string => h.trim().toLowerCase().split(".").slice(1).join(".");
  const pa = parent(a);
  return pa.length > 0 && pa.includes(".") && pa === parent(b);
}
