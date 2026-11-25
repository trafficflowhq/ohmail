import { useState } from "react";
import type { CalendarEventRecord, CalendarRecord } from "@ohmail/app-logic/calendar";
import { Button, Icon } from "@ohmail/ui/base";
import type { EventCardRow } from "@ohmail/ui/calendar";
import { NONE, type HostContract } from "../host/index.js";
import { useLocale, useText, type Text } from "../text/index.js";
import { useCalendarOwnAddresses } from "./own-addresses.js";
import { eventDetails } from "./event-card-details.js";
import type { CalendarEventFace } from "./faces.js";
import type { useEventLetters } from "./use-event-letters.js";

export function useEventCardRows(
  event: CalendarEventFace,
  host: HostContract,
  t: Text,
  letters: ReturnType<typeof useEventLetters>["links"],
): EventCardRow[] {
  const locale = useLocale();
  const own = useCalendarOwnAddresses();
  const rows = rowsOf(event, host, t, locale, own);
  if (letters.length) {
    rows.push({
      label: t("letters", { count: letters.length }),
      children: <EventLetterHistory key={event.id} links={letters} />,
    });
  }
  return rows;
}

function EventLetterHistory({ links }: { links: ReturnType<typeof useEventLetters>["links"] }) {
  const t = useText("calendar");
  const [expanded, setExpanded] = useState(false);
  const remaining = links.length - 2;
  return (
    <div className="cal-event-letter-history">
      {links.slice(0, 2).map((letter) => (
        <Button key={letter.id} kind="quiet" size="s" onPress={letter.open}>
          {letter.subject || t("actions.openLetter")}
        </Button>
      ))}
      {remaining > 0 && (
        <Button kind="quiet" size="s" expanded={expanded} onPress={() => setExpanded(!expanded)}>
          {t(expanded ? "lettersLess" : "lettersMore", { count: remaining })}
        </Button>
      )}
      {expanded &&
        links.slice(2).map((letter) => (
          <Button key={letter.id} kind="quiet" size="s" onPress={letter.open}>
            {letter.subject || t("actions.openLetter")}
          </Button>
        ))}
    </div>
  );
}

function rowsOf(
  event: CalendarEventFace,
  host: HostContract,
  t: Text,
  locale: string,
  own: readonly string[] | null,
): EventCardRow[] {
  const port = host.wires.calendar;
  const stored = port === NONE ? undefined : port.events().find(({ record }) => record.id === event.recordId);
  const calendar =
    stored &&
    host.engine.store
      .entries<CalendarRecord | null>("calendar")
      .find(({ entity }) => entity?.id === stored.record.calendarId)?.entity;
  const rows: EventCardRow[] = [];
  if (calendar) {
    rows.push({
      label: t("create.calendar"),
      tone: event.tone,
      text: calendar.name,
      children: event.viewOnly ? <Icon name="lock" size={16} className="oh-ecard-lock" /> : null,
    });
  }
  if (calendar?.access === "busy" || !stored) return rows;
  const confirmed = host.engine.store.get<CalendarEventRecord>("calendar_event", stored.record.id);
  rows.push(...eventDetails(stored.record, confirmed, own, t, locale));
  return rows;
}
