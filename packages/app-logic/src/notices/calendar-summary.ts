import {
  mayDrawKind,
  SUMMARY_AT_START,
  summaryNotice,
  type CalendarSummaryDetails,
  type Notice,
  type NoticeTaken,
} from "@ohmail/client-engine";
import { postCalendarSummaryOnce } from "./browser-channels.js";
import type { HostNoticeEmitter, NoticeReads } from "./notice-reads.js";

export class CalendarSummary {
  nextAtMs: number | null = null;
  private lastSummaryDay: string | null = null;

  constructor(
    private readonly emitter: HostNoticeEmitter,
    private readonly reads: NoticeReads,
  ) {}

  reset(): void {
    this.nextAtMs = null;
    this.lastSummaryDay = null;
  }

  settle(
    scope: string,
    nowMs: number,
    remains: () => boolean,
    post: (notice: Notice, guard: () => boolean, details: CalendarSummaryDetails) => NoticeTaken | void,
  ): void {
    this.nextAtMs = null;
    const calendar = this.reads.calendar;
    const choices = this.reads.choices();
    if (
      calendar === "none" ||
      !calendar.summary ||
      calendar.liveScope() !== scope ||
      !mayDrawKind("cal_summary", choices, this.reads.permission(), this.emitter.carries)
    )
      return;
    const time = choices.summaryAt ?? SUMMARY_AT_START;
    const reference = nowMs - 120_000;
    try {
      const due = calendar.summary(scope, reference, time);
      if (due === null) return;
      const { summary, zone } = due;
      if (summary.atMs > nowMs) {
        this.nextAtMs = summary.atMs;
        return;
      }
      this.nextAtMs = calendar.summary(scope, nowMs, time)?.summary.atMs ?? null;
      if (!summary.agenda) return;
      const day = new Intl.DateTimeFormat("sv-SE", { timeZone: zone }).format(summary.atMs);
      if (this.lastSummaryDay === day) return;
      this.lastSummaryDay = day;
      const current = () => {
        const held = this.reads.calendar;
        const next = this.reads.choices();
        return (
          remains() &&
          held !== "none" &&
          held.liveScope() === scope &&
          (next.summaryAt ?? SUMMARY_AT_START) === time &&
          mayDrawKind("cal_summary", next, this.reads.permission(), this.emitter.carries) &&
          JSON.stringify(held.summary?.(scope, reference, time)) === JSON.stringify(due)
        );
      };
      const notice = summaryNotice(summary);
      const agenda = summary.agenda;
      void postCalendarSummaryOnce(
        scope,
        day,
        current,
        () => (current() ? post(notice, current, { agenda, zone }) : false),
        this.emitter.lockSummary,
      ).catch(() => {});
    } catch {
      // A closed or unreadable calendar has no agenda to announce.
    }
  }
}
