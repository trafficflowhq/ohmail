"use client";

import { useTranslations } from "next-intl";
import "./mark-all-read.css";

/**
 * A SUBTLE "mark all read" affordance for a mail list header.
 *
 * ── THE ABSENCE AT NOTHING-TO-CLEAR IS THE GUARD ───────────────────────────────────────────
 *
 * It renders NOTHING when the view shows nothing to clear. A control that can be pressed
 * against an already-cleared list is a control that lies about what it does — so the component
 * returns null, and the guard (`mark-all-read.test.tsx`) asserts that null rather than a
 * disabled button.
 *
 * TWO COUNTS FEED IT, because the reading streams make two different statements a press can
 * clear. `unreadCount` is the mailbox's own read state (`m.unread` ← IMAP `\Seen`) — the same
 * field the rows render — so the button and the rows cannot disagree: button gone ⇒ every row
 * quiet. `freshCount` is the waterline's "new since last visit", which can stand ABOVE zero
 * unread (mail read in another IMAP client moves `\Seen`, never this client's local line);
 * without it, a stream saying "2 new" had no control to clear it — the press was measured
 * doing exactly that on a live account. Lists without a line (Ohbox, History) pass no
 * `freshCount` and keep their pure unread contract.
 */
export function MarkAllRead({
  unreadCount,
  freshCount = 0,
  onMarkAllRead,
}: {
  unreadCount: number;
  /** The fresh side of the view's waterline, for the streams. Absent ⇒ unread alone decides. */
  freshCount?: number;
  onMarkAllRead: () => void;
}): React.ReactElement | null {
  const t = useTranslations("markAll");
  if (unreadCount <= 0 && freshCount <= 0) return null;
  return (
    <button
      type="button"
      className="mark-all-read"
      onClick={onMarkAllRead}
      aria-label={
        unreadCount > 0 ? t("aria", { count: unreadCount }) : t("ariaFresh", { count: freshCount })
      }
    >
      {t("label")}
    </button>
  );
}
