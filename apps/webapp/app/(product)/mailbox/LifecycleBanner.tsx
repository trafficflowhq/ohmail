"use client";

import { useTranslations } from "next-intl";
import type { AccountLifecycle } from "../../api-client";
import { dayStamp } from "../../shell/format";
import { useLifecycleNotice } from "./lifecycle-notice";

/**
 * THE STRIP ABOVE THE APP, while the account is still open and something is running out — and the
 * one after it reopens. Never a modal: the app keeps working in every state this draws, so taking
 * the screen would be a lie about what has happened. The durability strip's slot and shape, for
 * its reason — a fact about the ACCOUNT rather than about a pile, rendered once by the
 * shell, absent from the DOM whenever there is nothing to say.
 *
 * Cloud-only by construction: the shared shell takes it as a node, so the desktop window and the
 * demo cannot grow one (`CloudShell` withholds it), and the copy never reaches either bundle.
 */

/** A return this long after the last read asks again while nothing is drawn; while one is, the debounce. */
export { QUIET_RETURN_MS } from "@ohmail/app-logic/doors/wall-lift";
/** How close to the end of a trial the strip appears. The day-12 reminder mail is the other half. */
export const TRIAL_NOTICE_DAYS = 2;

/** What the strip says, or `null` for the states that have nothing to say. */
export type Notice =
  | { kind: "grace" | "pastDue" | "trialEnding"; deadline: string }
  | { kind: "caughtUp"; since: string };

/**
 * Decide the notice from the server's own facts and the server's own clock reading.
 *
 * `now` is a parameter and not `Date.now()` because the only comparison here — is the trial
 * inside its last two days — must be drivable; the DATE it renders is always the server's.
 */
export function noticeOf(
  lifecycle: AccountLifecycle | undefined,
  caughtUp: { since: string } | undefined,
  now: number,
): Notice | null {
  // The catch-up outranks the rest: an account that has just reopened is not also in a grace.
  // No count: the service says only when the closure began (mail 0135); an older one's number is dropped.
  if (caughtUp && typeof caughtUp.since === "string") return { kind: "caughtUp", since: caughtUp.since };
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
  return `ohmail.lifecycle.${owner ?? "local"}.${notice.kind}.${about}`;
}

/** The strip, drawn from the account's state (`lifecycle-notice.ts`). */
export function LifecycleBanner() {
  const t = useTranslations("accountLifecycle");
  const tLock = useTranslations("accessLock");
  const { notice, busy, mintRefusal, putAway, toManage } = useLifecycleNotice();

  if (notice === null) return null;

  if (notice.kind === "caughtUp") {
    // No mailbox list: a mailbox the closure paused resumes on its own (mail 0135), and one the
    // person stopped, or another install took, says so in Settings → Mailboxes.
    return (
      <div className="acct-note" role="status">
        <p className="acct-note-line">
          {t("caughtUp", { date: dayStamp(notice.since) })}
        </p>
        <button type="button" className="acct-later" onClick={putAway}>{t("dismiss")}</button>
      </div>
    );
  }

  const date = dayStamp(notice.deadline);
  return (
    <div className="acct-bar" role="status">
      <span>
        {notice.kind === "grace"
          ? t("graceEnds", { date })
          : notice.kind === "pastDue"
            ? t("paymentFailed", { date })
            : t("trialEnds", { date })}
      </span>
      <button type="button" className="acct-do" disabled={busy} onClick={() => { void toManage(); }}>
        {notice.kind === "pastDue" ? t("fixPayment") : t("subscribe")}
      </button>
      {/* The way out is always there. A strip a person cannot put away is a strip that has to be
          right about how often it appears; this one is right about that AND can be put away. */}
      <button type="button" className="acct-later" onClick={putAway}>{t("later")}</button>
      {mintRefusal !== null ? (
        <span role="alert">{tLock(mintRefusal === "unverified" ? "mintUnverified" : "mintFailed")}</span>
      ) : null}
    </div>
  );
}
