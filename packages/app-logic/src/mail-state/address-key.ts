/**
 * How two mailbox rows are decided to be one address — for every surface, not one. It was
 * `MailboxSection.tsx`'s private helper until `mail-state.ts`'s stand-down arm needed the same rule
 * (has a stood-down row's address come BACK?), and the two surfaces are on one screen: a rail that
 * folds one way and a pane that folds another puts two contradictory sentences about a single
 * mailbox in front of the same person. One function, two callers; it lives in the shell because the
 * import direction is product → shell and never back.
 */

/**
 * The rule is the INDEX's: `lower()` only, and NOT `trim()`. The key is exactly `mailboxes_active_address_uq`
 * (`unique (account_id, lower(address)) where status <> 'disabled'`), so two rows differing only in case cannot both
 * be active — folding them is safe. A stored address has no surrounding space (`canonicalAddress` trims on the way
 * in), but if one ever did it would be a row Postgres keeps ACTIVE and DISTINCT, and folding it here would hide a
 * real mailbox: a grouping may be NARROWER than the constraint, never wider — the rule to check any change against.
 */

/**
 * `lower()` inherits the index's own caveat (collation-dependent, not RFC canonicalization; the organizer lease is
 * where physical identity lives), and inheriting it is the point: a surface that invented a third, "more correct"
 * answer would disagree with the database and the other surface.
 */

/** The grouping key: `lower(address)`, exactly `mailboxes_active_address_uq`'s. Never trim. */
export function addressKey(address: string): string {
  return address.toLowerCase();
}
