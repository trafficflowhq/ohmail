/**
 * HOW TWO MAILBOX ROWS ARE DECIDED TO BE ONE ADDRESS — for every surface, not one.
 *
 * ── WHY THIS FILE EXISTS AT ALL ─────────────────────────────────────────────────────────────
 *
 * It was `MailboxSection.tsx`'s private helper, and it stayed private for as long as one surface
 * needed it. Then a second one did — `mail-state.ts`'s stand-down arm has to know whether a
 * stood-down row's address has come BACK, or it reports a tombstone's organizer conflict over the
 * live mailbox that replaced it — and the two surfaces are on ONE SCREEN. A rail that folds one
 * way and a pane that folds another puts two contradictory sentences about a single mailbox in
 * front of the same person, which is the exact defect the stand-down arm was written to end.
 *
 * So the rule is one function with two callers rather than two functions that agree today. The
 * shell is where it lives because the import direction is product → shell and never back.
 *
 * ── THE RULE, AND IT IS THE INDEX'S ─────────────────────────────────────────────────────────
 *
 * `lower()` ONLY, AND NOT `trim()`. The key is exactly `mailboxes_active_address_uq`'s
 * (`packages/db/src/schema-mail.ts`), deliberately: that index is `unique (account_id,
 * lower(address)) where status <> 'disabled'`, so two rows differing only in case CANNOT both be
 * active, and treating them as one address is safe.
 *
 * `canonicalAddress` (`mailbox-service.ts`) trims on the way IN, so a stored address has no
 * surrounding space and the trim would be a no-op — but if one ever did exist it would be a row
 * Postgres considers DISTINCT and is willing to keep ACTIVE, and folding it here would hide a real
 * mailbox. **A grouping may be narrower than the constraint; it may never be wider.** That
 * sentence is the whole of why this is not `trim().toLowerCase()`, and it is the rule a reviewer
 * should check any change to this file against.
 *
 * `lower()` inherits the index's own documented caveat — collation-dependent, not RFC
 * canonicalization; `mailbox-service.ts:93-104` sets out at length that `lower(address)` is one
 * account's connect form rather than physical mailbox identity, and that the ORGANIZER LEASE is
 * where that identity actually lives. Inheriting the caveat is the point: these surfaces and that
 * index answer the same question and must answer it the same way. A surface that invented a
 * third, "more correct" answer would disagree with the database and with the other surface, and
 * would be wrong in a new way rather than right.
 */

/** The grouping key: `lower(address)`, exactly `mailboxes_active_address_uq`'s. Never trim. */
export function addressKey(address: string): string {
  return address.toLowerCase();
}
