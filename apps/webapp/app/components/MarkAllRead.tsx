"use client";

import { useTranslations } from "next-intl";
import "./mark-all-read.css";

/**
 * A subtle "mark all read" affordance for a mail list header. It renders NOTHING when the view shows nothing to
 * clear: a control pressable against an already-cleared list lies about what it does, so the component returns null
 * and the guard (`test/mark-all-read.test.tsx`) asserts that null rather than a disabled button.
 */

/**
 * Two counts feed it, because the reading streams make two statements a press can clear: `unreadCount` is the
 * mailbox's own read state (`m.unread` ← IMAP `\Seen`), the same field the rows render, so the button and the rows
 * cannot disagree; `freshCount` is the waterline's "new since last visit", which can stand above zero unread (mail
 * read in another IMAP client moves `\Seen`, never this client's local line) — without it a stream saying "2 new" had
 * no control to clear it, measured on a live account. Lists without a line (Ohbox, History) pass no `freshCount` and
 * keep their pure unread contract.
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
