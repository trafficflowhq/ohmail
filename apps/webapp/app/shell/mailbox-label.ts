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
 * The memo key: sorted `[id, label, address]` triples as JSON, `ownAddressKey`'s shape and for its
 * reason — a poll that moved a field the label does not depend on must not rebuild the map. The
 * address rides along because the short form reads it. JSON, never a join character: it escapes
 * its own delimiters, so no two distinct lists produce one string.
 */
export function mailboxLabelKey(facts: readonly MailboxLabelFact[] | null): string {
  if (facts === null) return "null";
  return JSON.stringify(
    facts.map((m) => [m.id, m.displayName?.trim() || m.address, m.address] as const).sort(),
  );
}

/**
 * ONE mailbox is no question, so the answer is silence. `null` facts — the demo, a surface with no
 * `GET /mailboxes` probe — is the same silence: the honest degradation `ownAddresses: []` already
 * takes, rather than a guess. Above one, the mailbox's own label and the bare address where it has
 * none, which is the fallback the "me" chip already keeps.
 *
 * `"label"` is the mailbox's own label and nothing else, `null` where it has none: never the
 * address, for a sentence that names a mailbox beside one of its folders.
 *
 * `"short"` is the phone chip's form: the label where the mailbox has one, else the half of the
 * address that tells this account's mailboxes apart — the local part, the domain when two share a
 * local part, the address only when both halves collide.
 */
export function mailboxLabelResolver(
  facts: readonly MailboxLabelFact[] | null,
): (mailboxId: string, form?: "short" | "label") => string | null {
  if (facts === null || facts.length <= 1) return () => null;
  const byId = new Map(facts.map((m) => [m.id, m.displayName?.trim() || m.address] as const));
  const halves = (a: string): [string, string] => {
    const at = a.lastIndexOf("@");
    return at < 0 ? [a, ""] : [a.slice(0, at), a.slice(at + 1)];
  };
  const seen = (i: 0 | 1, v: string): number =>
    facts.filter((m) => halves(m.address)[i].toLowerCase() === v.toLowerCase()).length;
  const shortById = new Map(facts.map((m) => {
    const named = m.displayName?.trim();
    if (named) return [m.id, named] as const;
    const [local, domain] = halves(m.address);
    if (local && seen(0, local) === 1) return [m.id, local] as const;
    if (domain && seen(1, domain) === 1) return [m.id, domain] as const;
    return [m.id, m.address] as const;
  }));
  const labelById = new Map(facts.map((m) => [m.id, m.displayName?.trim() || null] as const));
  return (mailboxId: string, form?: "short" | "label") =>
    (form === "label" ? labelById : form === "short" ? shortById : byId).get(mailboxId) ?? null;
}
