import {
  decideNotices,
  mayPost,
  mayRing,
  NOTICE_KIND_FACTS,
  type Notice,
  type NoticeAhead,
  type NoticeKind,
  type NoticeSample,
} from "@ohmail/client-engine";
import type { NoticeReads } from "./notice-reads.js";

function sameNoticeLabel(left: NoticeAhead["label"], right: NoticeAhead["label"]): boolean {
  return left.as === right.as && (left.as !== "title" || (right.as === "title" && left.text === right.text));
}

/** The worker registration is ready. May it still submit the notice the caller originally prepared? */
export function mayDeliver({
  notice,
  scope,
  before,
  alert,
  reads,
  carries,
  calendarCurrent,
}: {
  notice: Notice;
  scope: string;
  before: NoticeSample | null;
  alert: NoticeAhead | undefined;
  reads: NoticeReads;
  carries: readonly NoticeKind[];
  calendarCurrent: boolean;
}): boolean {
  const choices = reads.choices();
  const permission = reads.permission();
  if (!mayPost(notice, choices, permission, carries)) return false;
  if (NOTICE_KIND_FACTS[notice.kind].product !== "calendar") return true;
  const calendar = reads.calendar;
  if (!calendarCurrent || calendar === "none" || calendar.liveScope() !== scope) return false;
  const now = Date.now();
  if (alert !== undefined) {
    const held = calendar.ahead(scope, now);
    const standing = held?.alerts.find((item) => item.id === alert.id);
    return (
      standing !== undefined &&
      mayRing(alert, { held, live: scope, nowMs: now }) &&
      sameNoticeLabel(standing.label, alert.label) &&
      (alert.label.as !== "title" || choices.showTitles)
    );
  }
  if (before === null) return false;
  const fresh = calendar.changes(null, now);
  if (fresh === null) return false;
  // Both closed notices come from the same makers. A changed label, clock, count
  // or eligibility means the earlier notice is no longer the one the gate permits.
  const current = decideNotices(
    before,
    { ...before, calendar: fresh.sample },
    choices,
    permission,
    [notice.kind],
    fresh.look,
  );
  return current.some((candidate) => JSON.stringify(candidate) === JSON.stringify(notice));
}
