"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useTranslations } from "next-intl";
import {
  account, accessFeedFor, apiConfigured, onAccessFeed, putAwayCatchUp,
  type AccessFeed, type AccountAccess, type AccountLifecycle,
} from "../../api-client";
import { SELF_HOST_BUILD } from "../../hello";
import { dayStamp } from "../../shell/format";
import { durableSessionSet } from "../../shell/durable";
import { readOwner } from "../../shell/owner-cookie";
import { storageOwner } from "../../shell/storage-owner";
import { RETURN_DEBOUNCE_MS, useAccessSchedule } from "../../shell/wall-lift";
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

/** A return this long after the last read asks again while nothing is drawn; while one is, the debounce. */
export const QUIET_RETURN_MS = 15 * 60_000;

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

/** What the feed earns for this viewer: a notice, or `null`. Put-away keys are the dismissal's. */
function noticeFromFeed(entry: AccessFeed | null, hidden: ReadonlySet<string>, now: number): Notice | null {
  if (entry === null || !entry.answer.metered) return null;
  const next = noticeOf(entry.answer.lifecycle, entry.caughtUp ?? undefined, now);
  if (next === null) return null;
  const key = dismissKey(next, storageOwner());
  return hidden.has(key) || dismissed(key) ? null : next;
}

/** The schedule's read: `true` once the answer earns no deadline, which ends a hand-off poll. */
async function readForStrip(): Promise<boolean> {
  const a: AccountAccess = await account.access({ fresh: true });
  return !a.metered || noticeOf(a.lifecycle, undefined, Date.now()) === null;
}

/**
 * IT FOLLOWS THE ACCOUNT, not its own mount: it draws from the access feed (`api-client.ts`),
 * so any answer this tab receives moves it, and it asks once on every return to the tab (the
 * wall's schedule, no lift and no clock), polling after a hand-off. Bound: a tab that keeps focus
 * throughout a payment made on another device reads only on its next return.
 */
export function LifecycleBanner() {
  const t = useTranslations("accountLifecycle");
  const active = !SELF_HOST_BUILD && apiConfigured();
  const entry = useSyncExternalStore(onAccessFeed, () => accessFeedFor(readOwner()), () => null);
  // Put away in THIS mount, so "Later" holds where the session store refuses the write.
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  const drawn = useRef(false);
  useEffect(() => () => { alive.current = false; }, []);

  const notice = noticeFromFeed(entry, hidden, Date.now());
  useEffect(() => { drawn.current = notice !== null; });

  const { armPoll } = useAccessSchedule({
    read: active ? readForStrip : undefined,
    minute: null,
    owner: readOwner(),
    returnFloor: () => (drawn.current ? RETURN_DEBOUNCE_MS : QUIET_RETURN_MS),
    lastAsked: () => accessFeedFor(readOwner())?.at ?? 0,
  });

  useEffect(() => {
    if (!active) return;
    // The first paint joins the answer the shell's mount already asked for, or asks it.
    void account.access().catch(() => { /* no verdict, no sentence */ });
  }, [active]);

  const putAway = useCallback(() => {
    if (notice === null) return;
    const key = dismissKey(notice, storageOwner());
    remember(key);
    if (notice.kind === "caughtUp") putAwayCatchUp(readOwner());
    setHidden((was) => new Set([...was, key]));
  }, [notice]);

  const toManage = useCallback(async () => {
    setBusy(true);
    try {
      const link = await account.manageLink();
      const url = link?.url;
      if (typeof url === "string" && url.length > 0) {
        armPoll();
        leaveForManagePage(url);
        return;
      }
    } catch { /* the strip stays; the Subscription pane is the other way to the same page */ }
    if (alive.current) setBusy(false);
  }, [armPoll]);

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
    </div>
  );
}
