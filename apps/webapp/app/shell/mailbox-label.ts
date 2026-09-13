/**
 * WHICH OF THE ACCOUNT'S MAILBOXES A MESSAGE WAS DELIVERED TO, as a word.
 *
 * The source is the message's `mailboxId` and never its To/Cc: the header answer is absent on a
 * Bcc, names the list on list mail, and misses a plus or catch-all address the account cannot
 * recognise as its own. The `> 1` gate lives INSIDE the resolver so no consumer re-derives "does
 * this account have more than one address" — the divergence `FoldersRailGroup.mailboxCount`
 * exists to prevent — and so the gate can be asked without mounting a shell.
 */

/** What the resolver reads of a mailbox — `MailboxFacts`' three relevant fields, structurally. */
export interface MailboxLabelFact {
  id: string;
  address: string;
  displayName?: string | null;
}

/**
 * The memo key: sorted `[id, label]` pairs as JSON, `ownAddressKey`'s shape and for its reason —
 * a poll that moved a field the label does not depend on must not rebuild the map. JSON, never a
 * join character: it escapes its own delimiters, so no two distinct lists produce one string.
 */
export function mailboxLabelKey(facts: readonly MailboxLabelFact[] | null): string {
  if (facts === null) return "null";
  return JSON.stringify(
    facts.map((m) => [m.id, m.displayName?.trim() || m.address] as const).sort(),
  );
}

/**
 * ONE mailbox is no question, so the answer is silence. `null` facts — the demo, a surface with no
 * `GET /mailboxes` probe — is the same silence: the honest degradation `ownAddresses: []` already
 * takes, rather than a guess. Above one, the mailbox's own label and the bare address where it has
 * none, which is the fallback the "me" chip already keeps.
 */
export function mailboxLabelResolver(
  facts: readonly MailboxLabelFact[] | null,
): (mailboxId: string) => string | null {
  if (facts === null || facts.length <= 1) return () => null;
  const byId = new Map(facts.map((m) => [m.id, m.displayName?.trim() || m.address] as const));
  return (mailboxId: string) => byId.get(mailboxId) ?? null;
}
