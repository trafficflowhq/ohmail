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

/** Is a holder recorded at all: a kind, or a name that is not blank. */
function holderNamed(f: HolderLeaseFacts | null | undefined): boolean {
  const by = f?.by;
  return Boolean(by && (by.kind || (by.name && by.name.trim() !== "")));
}

/** Is somebody still organizing the mailbox: a named holder whose lease has not lapsed. */
export function holderIsLive(f: HolderLeaseFacts | null | undefined): boolean {
  return holderNamed(f) && f?.state !== "stopped";
}

/**
 * Did a named holder stop: recorded, and not live. Nobody named is "nobody", never a stop — the
 * sentence for a stop names the machine that stopped, and there is none to name.
 */
export function holderStopped(f: HolderLeaseFacts | null | undefined): boolean {
  return holderNamed(f) && !holderIsLive(f);
}

/**
 * Has the door read the lease for this row. `false` only on a reader row the door says it has not
 * looked at, where a NULL state is "not looked", not "nobody"; absent is a door that cannot say.
 */
export function holderAnswered(
  m: { organizerRole?: "organizer" | "reader" | null; organizerChecked?: boolean } | null | undefined,
): boolean {
  return m?.organizerRole !== "reader" || m.organizerChecked !== false;
}

/** One mailbox that refused: the reason its refusal carries. */
export function requestRefusalReason(f: HolderLeaseFacts | null | undefined): RequestRefusalReason {
  return holderIsLive(f) ? "organizer_outdated" : "no_organizer";
}

/** Several that refused, as one account-wide answer: outdated if any holder is live. */
export function rosterRefusalReason(rows: readonly (HolderLeaseFacts | null | undefined)[]): RequestRefusalReason {
  return rows.some(holderIsLive) ? "organizer_outdated" : "no_organizer";
}
