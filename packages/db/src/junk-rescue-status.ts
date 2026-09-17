/**
 * The junk rescue's two states, defined HERE and nowhere else — the constant the CHECK on both
 * stores spells out and the write door narrows to. "Not junk" is a COMMAND the organizer executes
 * (`junk_rescues`, FOLDERS-SPEC.md §16.2): a row is PENDING until the move lands, and the pass
 * deletes it when it does. REFUSED is the only other thing a person can be told — the server would
 * not take the move after the backoff ladder ran out — and the row is kept so the window can say
 * so and offer the press again. There is no "done": a landed rescue leaves no row.
 */
export const JUNK_RESCUE_STATUSES = ["pending", "refused"] as const;
export type JunkRescueStatus = (typeof JUNK_RESCUE_STATUSES)[number];

/** The write-door narrowing; anything else — including null — is not a member. */
export function isJunkRescueStatus(v: unknown): v is JunkRescueStatus {
  return typeof v === "string" && (JUNK_RESCUE_STATUSES as readonly string[]).includes(v);
}
