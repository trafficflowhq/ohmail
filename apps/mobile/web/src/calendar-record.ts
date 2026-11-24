/**
 * THE CALENDAR'S RECORD, FROM THE PAGE'S SIDE: the one way the page hands native the coming days, for the phone's
 * alerts and the calendar app's widget. Whatever builds the record (the days, the month, the alerts this device
 * rings) hands it here; it is read closed by the contract's own reader and only that copy crosses, as the act
 * `calendar.snapshot`. Native reads it closed again and keeps it for this page's pairing alone.
 *
 * It answers what native did, as a closed word; a record that does not read, or a refusal on the way, is `refused`.
 * It never throws.
 */
import { calendarSnapshotOf, readerZones } from "@ohmail/app-logic/calendar/alerts";
import type { CalendarEventRecord, CalendarRecord } from "@ohmail/wire";
import { nowIn, occurrencesIn } from "@ohmail/app-logic/calendar";
import { startMsOf } from "@ohmail/app-logic/calendar/alerts";
import { isWidgetGeneration, readWidgetTarget } from "../../src/calendar/opened";
import type { CalendarKept } from "../../src/shell/bridge-kinds";
import type { Bridge } from "./bridge";
import { readCalendarSnapshot, type CalendarNoticeChoices, type CalendarSnapshot, type MirrorStore } from "./engine-package";

export type CalendarHanded = CalendarKept | "refused";

export function calendarRecordSender(
  bridge: Pick<Bridge, "request">,
): (record: CalendarSnapshot, publication?: string) => Promise<CalendarHanded> {
  return async (record, publication) => {
    const copy = readCalendarSnapshot(record);
    if (copy === null) return "refused";
    try {
      const answer = await bridge.request("act", { act: "calendar.snapshot", snapshot: copy, ...(publication ? { publication } : {}) });
      return answer.calendar ?? "refused";
    } catch {
      return "refused";
    }
  };
}

export function calendarRecordClearer(bridge: Pick<Bridge, "request">) {
  return async (publication: string): Promise<CalendarHanded> => {
    try {
      return (await bridge.request("act", { act: "calendar.clear", publication })).calendar ?? "refused";
    } catch {
      return "refused";
    }
  };
}

type CalendarRows = Pick<MirrorStore, "entries">;
const calendarEvents = (store: CalendarRows | null) =>
  store?.entries<CalendarEventRecord | null>("calendar_event").flatMap(({ entity }) =>
    entity === null ? [] : [{ record: entity, waiting: null, refusal: null, refusedWriteId: null }],
  ) ?? [];
const calendarRows = (store: CalendarRows | null) =>
  store?.entries<CalendarRecord | null>("calendar").flatMap(({ entity }) => entity ?? []) ?? [];

export function widgetEventFragment(store: CalendarRows, zone: string, raw: unknown): string | null {
  const target = readWidgetTarget(raw);
  if (target === null) return null;
  const zones = readerZones();
  const day = nowIn(target.startMs, zone, zones)?.day;
  if (!day) return null;
  const { shown } = occurrencesIn({
    events: calendarEvents(store), calendars: calendarRows(store), zone, zones, query: { from: day, to: day },
  });
  const hit = shown.find((item) => item.record.id === target.event && item.calendar.access !== "busy" &&
    !item.record.private && item.record.status !== "cancelled" && item.record.myAnswer !== "declined" &&
    startMsOf(item.occurrence.start, zone, zones) === target.startMs);
  if (!hit) return null;
  const event = hit.key === null ? hit.record.id : (hit.series?.id ?? hit.record.id) + "@" + hit.key;
  return `#/cal/day/${hit.day}/e/${encodeURIComponent(event)}`;
}

/** Only a current native generation and a successful fresh drain can open a calendar occurrence. */
export async function followWidget(
  generation: string,
  resolve: (generation: string) => Promise<unknown>,
  refresh: () => Promise<void>,
  store: CalendarRows,
  zone: string,
  navigate: (fragment: string) => void,
) {
  if (!isWidgetGeneration(generation)) return;
  try {
    if (readWidgetTarget(await resolve(generation)) === null) return;
    await refresh();
    const fragment = widgetEventFragment(store, zone, await resolve(generation));
    if (fragment !== null) navigate(fragment);
  } catch {
    // A failed or refused refresh leaves the route untouched.
  }
}

/** Build from the account-scoped phone mirror. An unavailable account publishes empty days. */
export function snapshotFromMirror(
  store: Pick<MirrorStore, "entries"> | null,
  scope: string,
  zone: string,
  choices: CalendarNoticeChoices,
  nowMs = Date.now(),
): CalendarSnapshot | null {
  try {
    const events = calendarEvents(store);
    const calendars = calendarRows(store);
    const ownAddresses = store?.entries<{ address?: string } | null>("mailbox").flatMap(({ entity }) =>
      typeof entity?.address === "string" ? [entity.address] : [],
    ) ?? [];
    return calendarSnapshotOf({
      scope, zone, nowMs, events, calendars, ownAddresses, zones: readerZones(),
      acts: [], alertsOn: choices.cal_alert, showTitles: false,
      widgetTitles: false, summaryOn: false, summaryAt: choices.summaryAt,
    });
  } catch {
    return null;
  }
}

/** Clear before replacement. A later clear invalidates any earlier write in flight. */
export function calendarPublisher(
  send: ReturnType<typeof calendarRecordSender>,
  clear: ReturnType<typeof calendarRecordClearer>,
) {
  let installed: string | undefined;
  let requested: string | undefined;
  let revision = 0;
  return async (record: CalendarSnapshot | null) => {
    const key = JSON.stringify(record === null ? null : { ...record, writtenAt: 0 });
    if (key === requested || (requested === undefined && key === installed)) return;
    const current = ++revision;
    const publication = crypto.randomUUID();
    requested = key;
    installed = undefined;
    try {
      const cleared = await clear(publication);
      if (current !== revision || cleared !== "kept") return;
      const answer = record === null ? "kept" : await send(record, publication);
      if (current === revision && answer === "kept") installed = key;
    } finally {
      if (current === revision) requested = undefined;
    }
  };
}
