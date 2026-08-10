"use client";

import { useTranslations } from "next-intl";

/**
 * A SUBTLE "mark all read" affordance for a mail list header.
 *
 * ── THE ABSENCE AT unreadCount === 0 IS THE GUARD ──────────────────────────────────────────
 *
 * It renders NOTHING when there is nothing unread. A control that can be pressed against an
 * already-read list is a control that lies about what it does — and it would dispatch an empty
 * `mark_seen`, a wire round trip for no change. So the component returns null, and the guard
 * (`mark-all-read.test.tsx`) asserts that null rather than a disabled button.
 */
export function MarkAllRead({
  unreadCount,
  onMarkAllRead,
}: {
  unreadCount: number;
  onMarkAllRead: () => void;
}): React.ReactElement | null {
  const t = useTranslations("markAll");
  if (unreadCount <= 0) return null;
  return (
    <button
      type="button"
      className="mark-all-read"
      onClick={onMarkAllRead}
      aria-label={t("aria", { count: unreadCount })}
    >
      {t("label")}
    </button>
  );
}
