/**
 * WHO, THEN WHAT, where the host's server takes them: From and To, each opening the people to pick from (once a
 * person is set, the switch Both / From / To in their place), then Unread and the days beside the answer's own
 * filters. Each is a new question, asked at once; a press again takes one off.
 */
import { useRef, useState } from "react";
import type { AddressBookEntry } from "@ohmail/client-engine";
import {
  peopleFor,
  shortCivilDateStamp,
  type SearchDates,
  type SearchListModel,
  type SearchPerson,
} from "@ohmail/app-logic/search";
import { Button, Field, Menu, MenuItem, MenuRule, Seg } from "@ohmail/ui/base";
import { NONE } from "../host/index.js";
import { useLocale, useText } from "../text/index.js";
import type { SearchBeside } from "./beside.js";

/** The windows a date filter offers, by the days they reach back from today. */
export const DATE_WINDOWS = [
  ["week", 7],
  ["month", 31],
  ["year", 366],
] as const;
export type DateWindow = (typeof DATE_WINDOWS)[number][0];

/** Each window's name in the catalogue. */
const DATE_WORDS: Readonly<Record<DateWindow, string>> = {
  week: "dateWeek",
  month: "dateMonth",
  year: "dateYear",
};

const iso = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** A window as the days it spans, ending today in this window's zone. */
export function datesOf(window: DateWindow, today: Date): SearchDates {
  const days = DATE_WINDOWS.find(([w]) => w === window)![1];
  const from = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (days - 1));
  return { from: iso(from), to: iso(today) };
}

/** Which window a set of days is, where it is one. */
function windowOf(date: SearchDates | null, today: Date): DateWindow | null {
  if (date === null) return null;
  for (const [w] of DATE_WINDOWS) {
    const d = datesOf(w, today);
    if (d.from === date.from && d.to === date.to) return w;
  }
  return null;
}

/** At most this many people stand in a From or To menu. */
const MENU_PEOPLE = 6;

/** Who: From and To, each opening the people to pick from; once a person is set, their side as a switch. */
export function SearchPersonRow({ model, beside }: { model: SearchListModel; beside: SearchBeside }) {
  const t = useText("search");
  const person = model.person;
  if (person !== null)
    return (
      <Seg
        label={t("direction")}
        options={[
          { value: "any", label: t("both") },
          { value: "from", label: t("facetFrom") },
          { value: "to", label: t("to") },
        ]}
        value={person.dir}
        onChange={(dir) => model.setPerson({ ...person, dir })}
      />
    );
  if (beside.people === NONE) return null;
  const people = beside.people;
  const take = (p: AddressBookEntry, dir: SearchPerson["dir"]) =>
    model.setPerson({ address: p.address, name: p.name === "" ? null : p.name, dir });
  return (
    <div className="sr-filters" data-filter-row="" role="group" aria-label={t("person")}>
      <PeopleMenu word={t("facetFrom")} people={people} pick={(p) => take(p, "from")} />
      <PeopleMenu word={t("to")} people={people} pick={(p) => take(p, "to")} />
    </div>
  );
}

/** What: unread, and the days (a window ending today); each a press, and a press again takes it off. */
export function SearchRefine({ model, today }: { model: SearchListModel; today: Date }) {
  const t = useText("search");
  const locale = useLocale();
  const window = windowOf(model.date, today);
  const from = model.date?.from ? shortCivilDateStamp(model.date.from, locale) : null;
  const to = model.date?.to ? shortCivilDateStamp(model.date.to, locale) : null;
  const span =
    from && to
      ? t("dateRange", { from, to })
      : from
        ? t("dateSince", { from })
        : to
          ? t("dateUntil", { to })
          : t("dateWord");
  return (
    <>
      <Button kind="two" size="s" pressed={model.unread} onPress={() => model.setUnread(!model.unread)}>
        {t("facetUnread")}
      </Button>
      <DateMenu
        set={model.date}
        word={window !== null ? t(DATE_WORDS[window]) : span}
        pick={model.setDate}
        today={today}
      />
    </>
  );
}

function PeopleMenu({
  word,
  people,
  pick,
}: {
  word: string;
  people: () => readonly AddressBookEntry[];
  pick: (p: AddressBookEntry) => void;
}) {
  const t = useText("search");
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  const [query, setQuery] = useState("");
  const field = useRef<HTMLInputElement>(null);
  const listed = open ? peopleFor(query, people()).slice(0, query.trim() ? undefined : MENU_PEOPLE) : [];
  const close = () => {
    setOpen(false);
    setQuery("");
  };
  return (
    <>
      <Button
        ref={opener}
        kind="two"
        size="s"
        mark="down"
        opens="menu"
        expanded={open}
        onPress={() => (open ? close() : setOpen(true))}
      >
        {word}
      </Button>
      <Menu open={open} onClose={close} anchor={opener} label={word} title={word} initialFocus={field}>
        <Field
          ref={field}
          bare
          label={t("nameOrAddress")}
          placeholder={t("nameOrAddress")}
          value={query}
          onChange={setQuery}
        />
        {listed.length === 0 ? (
          <MenuItem disabled>{t("nobody")}</MenuItem>
        ) : (
          listed.map((p) => (
            <MenuItem
              key={p.address}
              note={p.name === "" ? undefined : p.address}
              onPress={() => {
                close();
                pick(p);
              }}
            >
              {p.name === "" ? p.address : p.name}
            </MenuItem>
          ))
        )}
      </Menu>
    </>
  );
}

function DateMenu({
  set,
  word,
  pick,
  today,
}: {
  set: SearchDates | null;
  word: string;
  pick: SearchListModel["setDate"];
  today: Date;
}) {
  const t = useText("search");
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const close = () => {
    setOpen(false);
    setFrom("");
    setTo("");
  };
  const apply = () => {
    if (!from && !to) return;
    pick(from && to && from > to ? { from: to, to: from } : { from: from || null, to: to || null });
    close();
  };
  if (set !== null)
    return (
      <Button kind="two" size="s" mark="x" pressed onPress={() => pick(null)}>
        {word}
      </Button>
    );
  return (
    <>
      <Button
        ref={opener}
        kind="two"
        size="s"
        mark="down"
        opens="menu"
        expanded={open}
        onPress={() => (open ? close() : setOpen(true))}
      >
        {word}
      </Button>
      <Menu open={open} onClose={close} anchor={opener} label={word} title={t("dateWord")} kind="card">
        {DATE_WINDOWS.map(([w]) => (
          <MenuItem
            key={w}
            onPress={() => {
              close();
              pick(datesOf(w, today));
            }}
          >
            {t(DATE_WORDS[w])}
          </MenuItem>
        ))}
        <MenuRule />
        <Field type="date" label={t("since")} value={from} onChange={setFrom} onEnter={apply} />
        <Field type="date" label={t("until")} value={to} onChange={setTo} onEnter={apply} />
        <MenuItem disabled={!from && !to} onPress={apply} keyHint="Enter">
          {t("apply")}
        </MenuItem>
      </Menu>
    </>
  );
}
