/**
 * `messages.sender_check` (mail 0147): `none` = checked and nothing found, `impersonation` = the
 * sender's name claims a brand the address does not own; NULL is "never checked". The ONE
 * definition — the CHECK on both stores, the writers and the closed-set census read it.
 */
export const SENDER_CHECKS = ["none", "impersonation"] as const;
export type SenderCheckValue = (typeof SENDER_CHECKS)[number];

export function isSenderCheck(v: unknown): v is SenderCheckValue {
  return typeof v === "string" && (SENDER_CHECKS as readonly string[]).includes(v);
}
