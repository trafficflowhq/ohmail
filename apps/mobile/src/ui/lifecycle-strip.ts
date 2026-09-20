/**
 * THE STRIP ABOVE THE LIST, while the account is still open and something is running out — and the
 * one after it reopens. Never a sheet and never a modal: the app keeps working in every state this
 * draws, so taking the screen would be a lie about what has happened.
 *
 * The browser's `LifecycleBanner.tsx` decisions, as pure functions — this workspace has no React
 * Native renderer, so everything a case must hold lives here and `LifecycleStrip.tsx` renders it.
 */

import type { AccountLifecycle } from "../net/access-lock";
import type { PhoneMailbox } from "../net/mailboxes";

/** How close to the end of a trial the strip appears. The day-12 reminder mail is the other half. */
export const TRIAL_NOTICE_DAYS = 2;

/** What the strip says, or `null` for the states that have nothing to say. */
export type Notice =
  | { kind: "grace" | "pastDue" | "trialEnding"; deadline: string }
  | { kind: "caughtUp"; since: string; count: number };

/**
 * Decide the notice from the server's own facts and one clock reading.
 *
 * `now` is a parameter and not `Date.now()` because the only comparison here — is the trial inside
 * its last two days — must be drivable; the DATE it renders is always the server's.
 */
export function noticeOf(
  lifecycle: AccountLifecycle | undefined,
  caughtUp: { since: string; count: number } | undefined,
  now: number,
): Notice | null {
  // The catch-up outranks the rest: an account that has just reopened is not also in a grace.
  if (caughtUp && caughtUp.count >= 0) return { kind: "caughtUp", ...caughtUp };
  if (lifecycle === undefined) return null;
  if (lifecycle.state === "grace" && lifecycle.graceUntil) {
    return { kind: "grace", deadline: lifecycle.graceUntil };
  }
  if (lifecycle.state === "past_due" && lifecycle.graceUntil) {
    return { kind: "pastDue", deadline: lifecycle.graceUntil };
  }
  if (lifecycle.state === "trialing" && lifecycle.trialEndsAt) {
    const ends = new Date(lifecycle.trialEndsAt).getTime();
    if (Number.isNaN(ends)) return null;
    // Inside the window AND not already past: a trial whose end has gone by is a `grace`, and the
    // server says so — this client never promotes a state by arithmetic.
    const left = ends - now;
    if (left > 0 && left <= TRIAL_NOTICE_DAYS * 24 * 60 * 60 * 1000) {
      return { kind: "trialEnding", deadline: lifecycle.trialEndsAt };
    }
  }
  return null;
}

/** The dismissal's key: the state AND the date it is about, so a new deadline is a new notice. */
export function dismissKey(notice: Notice, owner: string | null): string {
  const about = notice.kind === "caughtUp" ? notice.since : notice.deadline;
  return `${owner ?? "local"}.${notice.kind}.${about}`;
}

/**
 * PER RUN OF THE APP, and re-shown at the next launch — the browser's `sessionStorage` rule, in
 * the shape this platform has. A deadline somebody put away this morning is worth saying again
 * tomorrow, and there is no store here that dies with a "session" the way a browser tab's does:
 * module state does, exactly. Writing it to the keystore would make the dismissal OUTLIVE a
 * launch, which is the opposite of the promise.
 */
const putAway = new Set<string>();

export function dismissed(key: string): boolean {
  return putAway.has(key);
}

export function remember(key: string): void {
  putAway.add(key);
}

/** Tests only: forget every dismissal, so one case cannot see another's. */
export function resetDismissalsForTests(): void {
  putAway.clear();
}

/**
 * The mailboxes ohmail handed back while the account was closed, and has not been asked to retake.
 *
 * Role READER with a consent on record: somebody agreed to let ohmail organize this mailbox and
 * ohmail is not the organizer now. A mailbox that never consented was never stood down, and a
 * server older than the consent column names none — so an absent consent is NOT a stood-down
 * mailbox, the direction that never invites somebody to re-start something they never started.
 */
export function stoodDown(items: readonly PhoneMailbox[]): PhoneMailbox[] {
  return items.filter((m) => m.organizerRole === "reader" && m.organizeConsentedAt != null);
}
