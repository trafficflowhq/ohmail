/**
 * SEARCH: a field, and the events it finds among what this device holds, by day, upcoming first. A slip
 * in a word is forgiven and said as what it was read as; the span searched is said. A press on a hit
 * takes the calendar to its day with the event open. The field sends nothing by itself: there is no form.
 */
import { useMemo, useState, type KeyboardEvent } from "react";
import { Button, Empty, Icon, KeyHint, RefusalLine, Tag } from "@ohmail/ui/base";
import { GroupHeading } from "@ohmail/ui/mail";
import { AgendaRow } from "@ohmail/ui/calendar";
import {
  clockTime,
  dayDate,
  dayShort,
  readDateQuery,
  weekdayDateQuery,
  yearOf,
  type DayId,
  type RangeActs,
  type RangeInput,
  type SearchHit,
  type ViewEvent,
} from "@ohmail/app-logic/calendar";
import { findCalendarEvents } from "./find.js";
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

function useFound(query: string, { events, today, zone, zones }: RangeInput) {
  return useMemo(() => {
    const weekday = weekdayDateQuery(query, today);
    const date = weekday ?? readDateQuery(query, today);
    return {
      date,
      ...findCalendarEvents(query, events, today, zone, zones, date ?? undefined, weekday !== null),
    };
  }, [query, events, today, zone, zones]);
}

export function SearchView({ input, acts, query, onQuery, held }: SearchViewProps) {
  const t = useText("calsearch");
  const locale = useLocale();
  const found = useFound(query, input);
  /* The row the keys stand on: a place in the list, never the list. */
  const [cursor, setCursor] = useState(0);
  const firstHit = found.date ? 1 : 0;
  const lastRow = Math.max(0, found.hits.length + firstHit - 1);
  const at = Math.min(cursor, lastRow);
  const openDate = (day: DayId) => acts.view("day", day);
  const thisYear = yearOf(input.today);
  const keys = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setCursor(Math.max(0, Math.min(lastRow, at + (e.key === "ArrowDown" ? 1 : -1))));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (found.date && at === 0) return openDate(found.date);
      const hit = found.hits[at - firstHit];
      if (hit) acts.reveal(hit.item);
    }
  };
  const days: { day: DayId; hits: SearchHit<ViewEvent>[] }[] = [];
  for (const h of found.hits) {
    const last = days.at(-1);
    if (last && last.day === h.day) last.hits.push(h);
    else days.push({ day: h.day, hits: [h] });
  }
  let n = firstHit - 1;
  const date = found.date;
  return (
    <div className="oh-cal-sheet cal-sr" data-device={input.device} data-date-query={date ? "" : undefined}>
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
        {date ? (
          <DateHit title={dayShort(date, locale, thisYear)} cursor={at === 0} open={() => openDate(date)} />
        ) : null}
        {days.map((d) => (
          <section key={d.day} className="cal-sr-day">
            {date === d.day ? null : (
              <GroupHeading hot={d.day === input.today}>{dayShort(d.day, locale, thisYear)}</GroupHeading>
            )}
            <div role="list">
              {d.hits.map((h) => {
                n++;
                return (
                  <div key={h.key} className="cal-sr-hit">
                    <EventHit
                      hit={h}
                      cursor={n === at}
                      reveal={acts.reveal}
                      phone={input.device === "phone"}
                    />
                  </div>
                );
              })}
            </div>
          </section>
        ))}
        {found.any && !date && !found.hits.length && found.unplaced === 0 ? (
          <Empty label={t("nothing")} />
        ) : null}
        {found.unplaced > 0 ? <RefusalLine>{t("unplaced", { count: found.unplaced })}</RefusalLine> : null}
        {found.any && held ? (
          <p className={input.device === "phone" ? "oh-vh" : "oh-text cal-sr-held"}>
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

function DateHit({ title, cursor, open }: { title: string; cursor: boolean; open: () => void }) {
  const calendar = useText("calendar");
  return (
    <div className="cal-sr-day">
      <AgendaRow
        mark={{ kind: "mail", icon: "calendar" }}
        title={title}
        time=""
        second={calendar("goToDate")}
        tag={
          <KeyHint shown unsaid>
            ↵
          </KeyHint>
        }
        cursor={cursor}
        onOpen={open}
      />
    </div>
  );
}

function EventHit({
  hit,
  cursor,
  reveal,
  phone,
}: {
  hit: SearchHit<ViewEvent>;
  cursor: boolean;
  reveal: RangeActs["reveal"];
  phone: boolean;
}) {
  const t = useText("calsearch");
  const locale = useLocale();
  const { item, startMinute, endMinute } = hit;
  const time =
    startMinute === null
      ? t("allDay")
      : endMinute === null || endMinute === startMinute
        ? clockTime(startMinute, locale)
        : t("span", { from: clockTime(startMinute, locale), to: clockTime(endMinute, locale) });
  return (
    <AgendaRow
      tinted
      cursor={cursor}
      mark={{ kind: "calendar", tone: item.tone }}
      title={item.title}
      time={phone ? "" : time}
      second={[phone ? time : "", item.second, ...item.people].filter(Boolean).join(" · ") || undefined}
      off={item.state === "off"}
      quiet={item.state === "maybe"}
      waits={item.waits}
      onOpen={() => reveal(item)}
    />
  );
}
