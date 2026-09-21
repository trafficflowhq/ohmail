"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { account, apiConfigured, mailboxes as mailboxApi, type AccountLifecycle, type MailboxDTO } from "../../api-client";
import { dayStamp } from "../../shell/format";
import { durableSessionSet } from "../../shell/durable";
import { storageOwner } from "../../shell/storage-owner";
import { leaveForManagePage } from "./SubscriptionSection";

/**
 * THE STRIP ABOVE THE APP, while the account is still open and something is running out — and the
 * one after it reopens. Never a modal: the app keeps working in every state this draws, so taking
 * the screen would be a lie about what has happened. `UpdateNotice`'s slot and `UpdateNotice`'s
 * shape, for its reason — a fact about the ACCOUNT rather than about a pile, rendered once by the
 * shell, absent from the DOM whenever there is nothing to say.
 *
 * Cloud-only by construction: the shared shell takes it as a node, so the desktop window and the
 * demo cannot grow one (`CloudShell` withholds it), and the copy never reaches either bundle.
 */

/** How close to the end of a trial the strip appears. The day-12 reminder mail is the other half. */
export const TRIAL_NOTICE_DAYS = 2;

/** What the strip says, or `null` for the states that have nothing to say. */
export type Notice =
  | { kind: "grace" | "pastDue" | "trialEnding"; deadline: string }
  | { kind: "caughtUp"; since: string; count: number };

/**
 * Decide the notice from the server's own facts and the server's own clock reading.
 *
 * `now` is a parameter and not `Date.now()` because the only comparison here — is the trial
 * inside its last two days — must be drivable; the DATE it renders is always the server's.
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
  return `ohmail.lifecycle.${owner ?? "local"}.${notice.kind}.${about}`;
}

/**
 * Per SESSION, not for ever: a deadline a person put away this morning is worth saying again
 * tomorrow. `sessionStorage` throws in a private window and answers empty with site data blocked,
 * so every read and write is wrapped and an unreadable store means "not dismissed" — showing a
 * strip twice is a smaller failure than never showing it at all.
 */
function dismissed(key: string): boolean {
  try {
    return globalThis.sessionStorage?.getItem(key) === "1";
  } catch {
    return false;
  }
}

function remember(key: string): void {
  /* Through the session door, like every other per-viewer convenience: the door owns the refusal
     a private window or a full quota gives, and a store that will not keep this is not a reason
     to keep the strip up. */
  durableSessionSet(key, "1", "lifecycle.banner");
}

/** The mailboxes ohmail handed back while the account was closed, and has not been asked to retake. */
export function stoodDown(items: readonly MailboxDTO[]): MailboxDTO[] {
  // Role READER with a consent on record: somebody agreed to let ohmail organize this mailbox and
  // ohmail is not the organizer now. A mailbox that never consented was never stood down.
  return items.filter((m) => m.organizerRole === "reader" && m.organizeConsentedAt != null);
}

export function LifecycleBanner() {
  const t = useTranslations("accountLifecycle");
  const [notice, setNotice] = useState<Notice | null>(null);
  const [gone, setGone] = useState(false);
  const [handedBack, setHandedBack] = useState<MailboxDTO[]>([]);
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  useEffect(() => {
    if (!apiConfigured()) return;
    let live = true;
    // The SHARED read: `useManageOffer` already asks this at the shell's mount, so this joins
    // that answer rather than issuing a second one. A failure says nothing and draws nothing.
    void account.access().then((a) => {
      if (!live || !a.metered) return;
      const next = noticeOf(a.lifecycle, a.caughtUp, Date.now());
      if (next === null || dismissed(dismissKey(next, storageOwner()))) return;
      setNotice(next);
      if (next.kind !== "caughtUp") return;
      // Only the catch-up names mailboxes, so only it pays for the list.
      void mailboxApi.list().then((r) => { if (live) setHandedBack(stoodDown(r.items)); })
        .catch(() => { /* the count is still worth saying */ });
    }).catch(() => { /* no verdict, no sentence */ });
    return () => { live = false; };
  }, []);

  const putAway = useCallback(() => {
    if (notice) remember(dismissKey(notice, storageOwner()));
    setGone(true);
  }, [notice]);

  const toManage = useCallback(async () => {
    setBusy(true);
    try {
      const link = await account.manageLink();
      const url = link?.url;
      if (typeof url === "string" && url.length > 0) { leaveForManagePage(url); return; }
    } catch { /* the strip stays; the Subscription pane is the other way to the same page */ }
    if (alive.current) setBusy(false);
  }, []);

  if (notice === null || gone) return null;

  if (notice.kind === "caughtUp") {
    return (
      <div className="acct-note" role="status">
        <p className="acct-note-line">
          {t("caughtUp", { count: notice.count, date: dayStamp(notice.since) })}
        </p>
        {handedBack.length > 0
          ? (
            <>
              {/* NO AUTO RE-CLAIM, EVER (DUAL-MODE §4): ohmail released the lease when the account
                  closed and does not take it back on its own. The press that resumes organizing is
                  the one in Settings → Mailboxes, reached by the route rather than rebuilt here —
                  it carries the second-factor ceremony the route demands. */}
              <p className="acct-note-line">{t("handedBack")}</p>
              <ul className="acct-note-list">
                {handedBack.map((m) => (
                  <li key={m.id}>
                    <span className="acct-note-mbx">{m.address}</span>
                    <a className="acct-note-go" href="#/settings/mailboxes">{t("startOrganizing")}</a>
                  </li>
                ))}
              </ul>
            </>
          )
          : null}
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
    </div>
  );
}
