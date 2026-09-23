/**
 * WHICH MAILBOX A FIRST RUN IS ABOUT, and how much of THAT mailbox this device holds.
 *
 * Expressions at the shell's first-run mount, where none of them could be driven: one decides a
 * SCREEN (a re-run whose row is gone used to fall through to the seed connect form, which
 * reconfigures the install), the others decide numbers and a sender that were the install's while
 * the screen printing them named one mailbox. Structurally typed — no DTO import — so the shell's
 * row type can grow without touching this.
 */

/** The unresolvable arm, named: a run that names a mailbox this install does not hold. */
export type FirstRunSubjectState =
  /** The route named a row and the facts hold it — or named none and there is a first row to fall back on. */
  | "mailbox"
  /**
   * The route named a mailbox and `GET /mailboxes` does not hold it. NOT a state to connect out of: the
   * re-run's connect form posts `seed`, which reconfigures the whole install, so this is the one answer that
   * must reach a refusal rather than a form.
   */
  | "vanished"
  /**
   * An ADD run with no row yet — the create has not answered, or has and the facts have not caught up. The
   * form is right here and its mode is `add`, which writes a row beside the ones already running.
   */
  | "pending"
  /** `GET /mailboxes` has not answered, or the install holds nothing. Nothing is known; nothing is claimed. */
  | "none";

export interface FirstRunSubject<T> {
  /** The row this run is about, or `null` — see {@link FirstRunSubjectState} for which null this is. */
  mailbox: T | null;
  state: FirstRunSubjectState;
}

/**
 * THE ROW A RUN IS ABOUT. The route names it (`#/first-run…?mailbox=<id>`) and the first row stands in only
 * when it names none — `rows[0]` alone showed the FIRST mailbox's state on a run about the second.
 *
 * An id the rows do not hold is answered two ways, and the split is the whole point: on an ADD run it is
 * `pending`, because that run's hash carries the id from the moment the create answers while the facts lag a
 * round trip behind it; on every other run it is `vanished`, because the row left (removed from another
 * surface, a failing read, or this flow's own "forget this mailbox") and there is nothing to re-run.
 */
export function firstRunSubject<T extends { id: string }>(
  rows: readonly T[] | null,
  routeMailboxId: string | null,
  add: boolean,
): FirstRunSubject<T> {
  if (rows === null) return { mailbox: null, state: "none" };
  if (routeMailboxId !== null) {
    const named = rows.find((m) => m.id === routeMailboxId) ?? null;
    if (named !== null) return { mailbox: named, state: "mailbox" };
    return { mailbox: null, state: add ? "pending" : "vanished" };
  }
  if (add) return { mailbox: null, state: "pending" };
  const first = rows[0] ?? null;
  return { mailbox: first, state: first === null ? "none" : "mailbox" };
}

/** What a message has to carry to be counted against a mailbox. Absent ⇒ it is nobody's. */
interface HasMailbox { mailboxId?: string }

/**
 * HOW MUCH OF ONE MAILBOX THIS DEVICE HOLDS — the two numbers the pull screen prints and the summary reports.
 *
 * Both were the install's: `screened` was the mirror's whole row count minus the whole History list, so a
 * second mailbox's setup printed the first one's work as its own, usually reading "already finished" seconds
 * after the create. Same two projections over the same reader, filtered to the row the run is about.
 *
 * `mailboxId` null answers zeroes rather than the install's totals: a run with no mailbox has no mail of its
 * own, and the install's numbers are exactly the claim this function exists to stop.
 */
export function firstRunCounts(
  mirrored: readonly HasMailbox[],
  history: readonly HasMailbox[],
  mailboxId: string | null,
  /** The store's own History total (`engine.timeline()`), given only where it is this mailbox's. */
  storeTotal: number | null = null,
): { screened: number; history: number } {
  if (mailboxId === null) return { screened: 0, history: 0 };
  const mine = (m: HasMailbox) => m.mailboxId === mailboxId;
  const held = mirrored.reduce((n, m) => (mine(m) ? n + 1 : n), 0);
  const listed = history.reduce((n, m) => (mine(m) ? n + 1 : n), 0);
  // Clamped: both are projections over one reader and a race between the two reads must not print a negative.
  return { screened: Math.max(0, held - listed), history: storeTotal ?? listed };
}


/**
 * THE SCREENER ROWS THAT BELONG TO ONE MAILBOX — the guided decision's candidates. The row's own
 * DTO carries no mailbox, so the answer comes from the mirror: the representative message, then any
 * held one, whichever it can speak for first.
 *
 * `many` — the install holds more than one mailbox — is what makes this safe: on a single-mailbox
 * install every sender is that mailbox's, the list is returned untouched, and no lookup can drop a
 * row somebody is waiting to decide. Where it applies, a row the mirror cannot place is left out
 * rather than guessed at.
 */
export function screenerForMailbox<R extends { id: string; held: readonly { id: string }[] }>(
  rows: readonly R[],
  mailboxOf: (messageId: string) => string | undefined,
  mailboxId: string | null,
  many: boolean,
): R[] {
  if (!many) return [...rows];
  if (mailboxId === null) return [];
  return rows.filter((row) => {
    for (const id of [row.id, ...row.held.map((m) => m.id)]) {
      const mb = mailboxOf(id);
      if (mb !== undefined) return mb === mailboxId;
    }
    return false;
  });
}

/**
 * WHO ORGANIZES THIS ACCOUNT'S MAIL, when anybody does — the one state the connect form can read about a
 * mailbox that does not exist yet. A mailbox connected here becomes a consent-less READER and stays one while
 * somebody else holds the lease, and the only place that said so was Settings → Mailboxes.
 *
 * The first row that NAMES a holder, on {@link deriveOnboardingStep} row 3's rule: `kind || name`, never the
 * object, so a server that starts sending `{null,null,null}` names nobody. `null` is "nothing here says".
 */
export function accountOrganizer<T extends { organizedBy?: { kind: string | null; name: string | null } | null }>(
  rows: readonly T[] | null,
): { kind: string | null; name: string | null } | null {
  if (rows === null) return null;
  for (const row of rows) {
    const by = row.organizedBy;
    if (by && (by.kind || by.name)) return { kind: by.kind, name: by.name };
  }
  return null;
}
