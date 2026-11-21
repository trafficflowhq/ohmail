/**
 * SEARCH: a field, and the events it finds among what this device holds, by day, upcoming first. A slip
 * in a word is forgiven and said as what it was read as; the span searched is said. A press on a hit
 * takes the calendar to its day with the event open. The field sends nothing by itself: there is no form.
 */
import { useMemo, useState, type KeyboardEvent } from "react";
import { Button, Empty, Icon, RefusalLine, Tag } from "@ohmail/ui/base";
import { GroupHeading } from "@ohmail/ui/mail";
import { AgendaRow } from "@ohmail/ui/calendar";
import {
  clockTime,
  dayDate,
  dayShort,
  searchEvents,
  yearOf,
  type DayId,
  type RangeActs,
  type RangeInput,
  type SearchHit,
  type ViewEvent,
} from "@ohmail/app-logic/calendar";
import { useLocale, useText } from "../text/index.js";
import "./calsearch.css";

export interface SearchViewProps {
  readonly input: RangeInput;
  readonly acts: RangeActs;
  /** What is typed: the route's words. */
  readonly query: string;
  readonly onQuery: (q: string) => void;
  /** The span this device holds, said under the results; null while it is not known. */
  readonly held: { readonly from: DayId; readonly to: DayId } | null;
}

const keyOf = (e: ViewEvent): string => e.id;
const textOf = (e: ViewEvent) => [e.title, e.second, ...e.people, e.notes];

/** What the words find among the events the view is handed, placed by the zone rules it is handed. */
function useFound(query: string, input: RangeInput) {
  return useMemo(
    () =>
      searchEvents({
        query,
        items: input.events,
        keyOf,
        textOf,
        today: input.today,
        zone: input.zone,
        zones: input.zones,
      }),
    [query, input.events, input.today, input.zone, input.zones],
  );
}

export function SearchView({ input, acts, query, onQuery, held }: SearchViewProps) {
  const t = useText("calsearch");
  const locale = useLocale();
  const found = useFound(query, input);
  /* The row the keys stand on: a place in the list, never the list. */
  const [cursor, setCursor] = useState(0);
  const at = Math.min(cursor, Math.max(0, found.hits.length - 1));
  const thisYear = yearOf(input.today);
  const keys = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setCursor(Math.max(0, Math.min(found.hits.length - 1, at + (e.key === "ArrowDown" ? 1 : -1))));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const hit = found.hits[at];
      if (hit) acts.reveal(hit.item);
    }
  };
  const days: { day: DayId; hits: SearchHit<ViewEvent>[] }[] = [];
  for (const h of found.hits) {
    const last = days.at(-1);
    if (last && last.day === h.day) last.hits.push(h);
    else days.push({ day: h.day, hits: [h] });
  }
  let n = -1;
  return (
    <div className="cal-sr" data-device={input.device}>
      <div className="cal-sr-top">
        <label className="cal-sr-field">
          <Icon name="search" size={20} />
          <input
            type="search"
            className="oh-text cal-sr-input"
            value={query}
            placeholder={t("placeholder")}
            aria-label={t("field")}
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            enterKeyHint="search"
            onChange={(e) => {
              setCursor(0);
              onQuery(e.target.value);
            }}
            onKeyDown={keys}
          />
          {found.readAs ? (
            <span className="cal-sr-read" aria-label={t("readAs", { words: found.readAs })}>
              <Tag>{found.readAs}</Tag>
            </span>
          ) : null}
          {found.any ? (
            <span className="oh-text cal-sr-count">{t("count", { count: found.hits.length })}</span>
          ) : null}
          {query ? (
            <Button
              kind="quiet"
              size="s"
              icon="x"
              label={t("clear")}
              onPress={() => {
                setCursor(0);
                onQuery("");
              }}
            />
          ) : null}
        </label>
      </div>
      <div className="cal-sr-list" data-scroll="calsearch">
        {days.map((d) => (
          <section key={d.day} className="cal-sr-day">
            <GroupHeading hot={d.day === input.today}>{dayShort(d.day, locale, thisYear)}</GroupHeading>
            <div role="list">
              {d.hits.map((h) => {
                n++;
                const e = h.item;
                return (
                  <div key={h.key} className="cal-sr-hit">
                    <AgendaRow
                      tinted
                      cursor={n === at}
                      mark={{ kind: "calendar", tone: e.tone }}
                      title={e.title}
                      time={
                        h.startMinute === null
                          ? t("allDay")
                          : h.endMinute === null || h.endMinute === h.startMinute
                            ? clockTime(h.startMinute, locale)
                            : t("span", {
                                from: clockTime(h.startMinute, locale),
                                to: clockTime(h.endMinute, locale),
                              })
                      }
                      second={[e.second, ...e.people].filter(Boolean).join(" · ") || undefined}
                      off={e.state === "off"}
                      quiet={e.state === "maybe"}
                      waits={e.waits}
                      onOpen={() => acts.reveal(e)}
                    />
                  </div>
                );
              })}
            </div>
          </section>
        ))}
        {found.any && !found.hits.length && found.unplaced === 0 ? <Empty label={t("nothing")} /> : null}
        {found.unplaced > 0 ? <RefusalLine>{t("unplaced", { count: found.unplaced })}</RefusalLine> : null}
        {found.any && held ? (
          <p className="oh-text cal-sr-held">
            {t("held", {
              from: dayDate(held.from, locale, thisYear),
              to: dayDate(held.to, locale, thisYear),
            })}
          </p>
        ) : null}
      </div>
    </div>
  );
}
