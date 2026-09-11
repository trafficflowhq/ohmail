import type { EntityReader } from "./store.js";

/* ── ADDRESS IDENTITY, AND THE ACCOUNT'S OWN ADDRESSES — A LEAF, ON PURPOSE ────────────────
 *
 * The consent partition and the Screener's grouping both ask "is this the reader writing?" and
 * must answer it identically: a second list spelled beside the first is the defect this module
 * makes unrepresentable (the own guard reached INBOX mail and not a message physically in
 * `ohmail/Screener`). It imports nothing local, so neither consumer's import of it can close a
 * cycle — which is why the fold lives here beside the predicate rather than in `selectors.ts`,
 * where it was and from where it is still re-exported under the name every importer uses. */

/** What the own-address question needs from a caller. `ConsentOptions` satisfies it. */
export interface OwnAddressOptions {
  /** The account's own mailbox addresses. Absent ⇒ whatever `mailbox` rows the mirror holds. */
  ownAddresses?: Iterable<string>;
}

/**
 * The grouping key for a Screener sender — the address, case-folded.
 *
 * Shared with `mutationEffects`' `screener_decide` branch so the set of messages a
 * decision moves is exactly the set the row said it was holding, and with the server,
 * which lower-cases the same way (`screener-service.ts:118`, `:147`).
 */
export function senderKey(address: string): string {
  return address.trim().toLowerCase();
}

/**
 * THE ACCOUNT'S OWN ADDRESSES, FOLDED — one predicate, two consumers.
 *
 * `consentPartition` reads it so the user is never weighed as one of their own correspondents,
 * and `screenerSegments` reads THE SAME function so they never hold a waiting row.
 *
 * Explicit addresses win; absent, the mirror's `mailbox` rows are the fallback — see
 * `ConsentOptions.ownAddresses` for why a caller that knows the addresses should pass them.
 */
export function ownAddressKeys(
  reader: EntityReader, opts: OwnAddressOptions = {},
): ReadonlySet<string> {
  const explicit = opts.ownAddresses;
  const source = explicit ?? reader.list<{ address?: unknown }>("mailbox")
    .map((m) => (typeof m.address === "string" ? m.address : ""));
  const out = new Set<string>();
  for (const a of source) {
    const key = senderKey(String(a));
    if (key) out.add(key);
  }
  return out;
}
