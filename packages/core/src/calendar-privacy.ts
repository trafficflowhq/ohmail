import type { CalendarEventAct, CalendarEventRecord } from "@ohmail/wire";

/** A standalone calendar write has no link back to a letter. */
export function withoutCalendarMailLink(act: CalendarEventAct): CalendarEventAct {
  if ("invitationMessageId" in act) {
    const { invitationMessageId: _mail, ...calendar } = act;
    return calendar;
  }
  if ("cancelledBy" in act) {
    const { cancelledBy: _mail, ...calendar } = act;
    return calendar;
  }
  return act;
}

export function withoutCalendarMailLinks(event: CalendarEventRecord): CalendarEventRecord {
  return { ...event, writes: event.writes.map((mark) => ({
    ...mark, act: mark.act === null ? null : withoutCalendarMailLink(mark.act),
  })) };
}
