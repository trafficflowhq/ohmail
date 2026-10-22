/**
 * A MEETING INVITATION'S EVENT, ONCE, AT THE TOP OF THE MESSAGE — the web's `IcsEventCard` on the
 * phone: what, when, where, who, and the METHOD said plainly. One card per distinct event (the
 * state layer's `events`, deduplicated by UID and RECURRENCE-ID). Text only: no link, no press;
 * the calendar files stay tiles under the message. The words are the web's `icsEvent` keys, the
 * dates core's formatters, in the reader's language and the phone's own zone. A sender's text
 * arrives cut by core (title and place 1,000, a name 200, an unknown zone's label 64), and each
 * line it fills is clamped, so the text layout above the body stops early.
 */
import { View, type StyleProp, type ViewStyle } from "react-native";
import { Copy } from "../copy";
import { activeLocale } from "../i18n/locale";
import { useTheme } from "../theme";
import {
  formatIcsWhen, icsDateGlyph, icsKicker, icsPeople, icsRecurrence, icsWeekdayName, readerZone,
  type IcsTime, type WorldEvent,
} from "../state/live";
import { Txt } from "./base";
import { ErrorBoundary } from "./error-boundary";

type Event = WorldEvent["event"];

const KICKER = {
  request: () => Copy.icsRequest,
  counter: () => Copy.icsCounter,
  cancelled: () => Copy.icsCancelled,
  accepted: () => Copy.icsAccepted,
  declined: () => Copy.icsDeclined,
  tentative: () => Copy.icsTentative,
  reply: () => Copy.icsReply,
  event: () => Copy.icsEvent,
} as const;

function recurrenceLine(ev: Event, locale: string): string | null {
  const said = icsRecurrence(ev.recurrence);
  if (!said) return null;
  const days = "days" in said ? said.days.map((d) => icsWeekdayName(d, locale)).join(", ") : "";
  switch (said.key) {
    case "daily": return Copy.icsDaily;
    case "weekly": return Copy.icsWeekly;
    case "monthly": return Copy.icsMonthly;
    case "yearly": return Copy.icsYearly;
    case "everyNDays": return Copy.icsEveryNDays(said.n);
    case "everyNWeeks": return Copy.icsEveryNWeeks(said.n);
    case "everyNMonths": return Copy.icsEveryNMonths(said.n);
    case "everyNYears": return Copy.icsEveryNYears(said.n);
    case "weeklyOn": return Copy.icsWeeklyOn(days);
    case "everyNWeeksOn": return Copy.icsEveryNWeeksOn(said.n, days);
  }
}

function peopleLine(ev: Event): string | null {
  const { who, invited } = icsPeople(ev);
  const count = invited !== null ? Copy.icsInvited(invited) : null;
  if (who && count) return `${who} · ${count}`;
  return who ?? count;
}

function EventCard({ event }: { event: Event }) {
  const t = useTheme();
  const opts = { locale: activeLocale(), zone: readerZone() };
  const when = (start: IcsTime, end: IcsTime | null) => formatIcsWhen(start, end, { ...opts, allDay: Copy.icsAllDay });
  const k = icsKicker(event);
  const glyph = icsDateGlyph(event.start, opts);
  const previously = event.oldStart ? when(event.oldStart, event.oldEnd) : null;
  const repeat = recurrenceLine(event, opts.locale);
  const people = peopleLine(event);
  const quiet = event.cancelled;
  return (
    <View
      testID="event-card"
      style={[
        { flexDirection: "row", gap: 13, padding: 13, borderRadius: t.radius.rowDense, backgroundColor: t.c.panel },
        t.lift("l0"),
      ]}
    >
      <View style={{ width: 44, borderRadius: t.radius.item, overflow: "hidden", backgroundColor: t.c.tint, alignSelf: "flex-start" }}>
        <Txt
          variant="tagchip"
          style={{ textAlign: "center", paddingVertical: 3, textTransform: "uppercase", color: quiet ? t.c.ink3 : t.c.accentInk, backgroundColor: quiet ? t.c.tint2 : t.c.accentSoft }}
        >
          {glyph.month}
        </Txt>
        <Txt variant="pileTitle" tone={quiet ? "ink3" : "ink"} tabular style={{ textAlign: "center", paddingVertical: 2 }}>
          {glyph.day}
        </Txt>
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
        <Txt variant="caption" tone={k.tone === "cancel" ? "accent" : "ink3"} testID="event-card-kicker">
          {KICKER[k.key]()}
        </Txt>
        {event.summary ? <Txt variant="button" testID="event-card-summary" numberOfLines={3}>{event.summary}</Txt> : null}
        <Txt variant="note" tone="ink2" testID="event-card-when" numberOfLines={2}>{when(event.start, event.end)}</Txt>
        {previously ? (
          <Txt variant="note" tone="ink3">
            {Copy.icsPreviously} <Txt variant="note" tone="ink3" style={{ textDecorationLine: "line-through" }}>{previously}</Txt>
          </Txt>
        ) : null}
        {repeat ? <Txt variant="note" tone="ink3">{repeat}</Txt> : null}
        {event.location ? <Txt variant="note" tone="ink3" testID="event-card-location" numberOfLines={2}>{event.location}</Txt> : null}
        {people ? <Txt variant="note" tone="ink3" testID="event-card-people" numberOfLines={1}>{people}</Txt> : null}
      </View>
    </View>
  );
}

/**
 * Every event the message carries, once each, above the mail; nothing until the texts land. Each
 * card stands in its own boundary: a calendar part that throws drops its card, never the reader.
 */
export function EventCards({ events, style }: { events: readonly WorldEvent[] | undefined; style?: StyleProp<ViewStyle> }) {
  if (!events || events.length === 0) return null;
  return (
    <View style={[{ gap: 8, marginBottom: 14 }, style]}>
      {events.map((e) => (
        <ErrorBoundary key={e.partId} surface="reader" renderFallback={() => null}>
          <EventCard event={e.event} />
        </ErrorBoundary>
      ))}
    </View>
  );
}
