/**
 * WHY A READER'S PRESS HAS NOWHERE TO GO — one decider, asked by the server's refusal and by the
 * client's pane, so the two cannot name one state differently. A holder is LIVE while it is named
 * and its lease has not lapsed: `stopped` is the lease's own verdict (nothing renewed within the
 * claim's window), persisted as `organizer_state`; `null` is "not looked yet" and reads live, as
 * every banner does. Only a live holder is `organizer_outdated` — its build cannot take this from
 * a reader. None named, or one that stopped, is `no_organizer`: telling a person to update ohmail
 * on a machine that stopped organizing sends them to the wrong machine. Import-free on purpose.
 */
export type RequestRefusalReason = "organizer_outdated" | "no_organizer";

/** The two lease facts a mailbox row carries about its holder, in either tier's spelling. */
export interface HolderLeaseFacts {
  by?: { kind?: string | null; name?: string | null } | null;
  state?: string | null;
}

function isLive(f: HolderLeaseFacts | null | undefined): boolean {
  const by = f?.by;
  const named = Boolean(by && (by.kind || (by.name && by.name.trim() !== "")));
  return named && f?.state !== "stopped";
}

/** One mailbox that refused: the reason its refusal carries. */
export function requestRefusalReason(f: HolderLeaseFacts | null | undefined): RequestRefusalReason {
  return isLive(f) ? "organizer_outdated" : "no_organizer";
}

/** Several that refused, as one account-wide answer: outdated if any holder is live. */
export function rosterRefusalReason(rows: readonly (HolderLeaseFacts | null | undefined)[]): RequestRefusalReason {
  return rows.some(isLive) ? "organizer_outdated" : "no_organizer";
}
