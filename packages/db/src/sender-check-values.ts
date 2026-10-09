/**
 * `messages.sender_check` (mail 0148): `none` = checked and nothing found, `impersonation` = the
 * sender's name claims a brand the address does not own; NULL is "never checked". The ONE
 * definition — the CHECK on both stores, the writers and the closed-set census read it.
 */
export const SENDER_CHECKS = ["none", "impersonation"] as const;
export type SenderCheckValue = (typeof SENDER_CHECKS)[number];

export function isSenderCheck(v: unknown): v is SenderCheckValue {
  return typeof v === "string" && (SENDER_CHECKS as readonly string[]).includes(v);
}

/**
 * `messages.sender_check_by` (mail 0149): which writer gave the fact. `ingest` = when the message
 * was stored, `backfill` = later, for a row stored before the fact existed. NULL is a build older
 * than the column. The ONE definition — the CHECK on both stores, the writers and the census read it.
 */
export const SENDER_CHECK_BY = ["ingest", "backfill"] as const;
export type SenderCheckBy = (typeof SENDER_CHECK_BY)[number];

export function isSenderCheckBy(v: unknown): v is SenderCheckBy {
  return typeof v === "string" && (SENDER_CHECK_BY as readonly string[]).includes(v);
}
