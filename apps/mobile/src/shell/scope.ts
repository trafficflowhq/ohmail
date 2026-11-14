/**
 * THE SHELL'S SCOPE: the storage partition, the copy's owner and the keeper's file, for one account
 * on one server. The phone's page has one origin for every server, so the account id alone would
 * let a second server answering the same id open the first one's mail and replay its queue; the
 * scope names both halves (`mirrorOwnerKey`). A digest, not the key itself: an origin holds `.` and
 * `:`, which the stored key families use as separators, and the storage owner takes only an
 * id-shaped value. Minted natively; the page never derives one.
 */

/** `p` and the first 32 hex digits of SHA-256 over `ownerKey`. */
export async function scopeOf(ownerKey: string, sha256Hex: (text: string) => Promise<string>): Promise<string> {
  const hex = (await sha256Hex(ownerKey)).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error("scopeOf: the digest is not SHA-256 hex");
  return `p${hex.slice(0, 32)}`;
}

/** The shape every scope has: what the native keeper and the page's storage owner both accept. */
export const SCOPE_SHAPE = /^p[0-9a-f]{32}$/;
