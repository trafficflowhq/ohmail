import { useState } from "react";
import { DatePicker } from "./DatePicker.js";
import { Menu, MenuItem } from "@ohmail/ui/base";
import { EventForm, type EventFormRow } from "@ohmail/ui/calendar";
import { dayLong, hueOf, type CalendarRecord } from "@ohmail/app-logic/calendar";
import { useLocale, useText, type Text } from "../text/index.js";
import type { EventDraft } from "./event-draft.js";

interface Props {
  readonly draft: EventDraft;
  readonly today: string;
  readonly calendar: CalendarRecord | undefined;
  readonly choices: readonly CalendarRecord[];
  readonly choose?: (id: string) => void;
  readonly fixedTime?: string;
  readonly timeZone?: string;
  readonly change: (edit: Partial<EventDraft>) => void;
  readonly ready?: boolean;
  readonly add?: () => void;
}

function whenRow(
  { draft, today, change }: Pick<Props, "draft" | "today" | "change">,
  t: Text,
  locale: string,
  expanded: boolean,
  open: (anchor: HTMLElement) => void,
): EventFormRow {
  return {
    id: "when",
    icon: "clock",
    items: [
      {
        kind: "slot",
        label: t("create.date"),
        value: dayLong(draft.day, locale, today.slice(0, 4)),
        expanded: expanded,
        onPress: (event) => open(event.currentTarget),
      },
      ...(!draft.allDay
        ? [
            {
              kind: "time" as const,
              label: t("create.from"),
              value: draft.from,
              onChange: (from: string) => change({ from }),
            },
            { kind: "word" as const, text: t("create.toWord") },
            {
              kind: "time" as const,
              label: t("create.to"),
              value: draft.to,
              onChange: (to: string) => change({ to }),
            },
          ]
        : []),
      {
        kind: "switch",
        label: t("create.allDay"),
        on: draft.allDay,
        onChange: (allDay) => change({ allDay }),
      },
    ],
  };
}

function optionalRow(
  id: "place" | "notes",
  draft: EventDraft,
  change: Props["change"],
  t: Text,
): EventFormRow[] {
  const value = draft[id];
  if (value === null) return [];
  return [
    {
      id,
      icon: id === "place" ? "pin" : "note",
      items: [
        {
          kind: id === "place" ? "text" : "notes",
          value,
          label: t(`create.${id}`),
          onChange: (next: string) => change({ [id]: next }),
        },
      ],
    },
  ];
}

export function DraftFields({
  draft,
  today,
  calendar,
  choices,
  choose,
  change,
  ready,
  add,
  fixedTime,
  timeZone,
}: Props) {
  const t = useText("calendar");
  const locale = useLocale();
  const [menu, setMenu] = useState<{ kind: "date" | "calendar"; anchor: HTMLElement } | null>(null);
  const rows: EventFormRow[] = [
    fixedTime
      ? { id: "when", icon: "clock", items: [{ kind: "word", text: fixedTime }] }
      : whenRow({ draft, today, change }, t, locale, menu?.kind === "date", (anchor) =>
          setMenu({ kind: "date", anchor }),
        ),
  ];
  if (timeZone && !fixedTime && !draft.allDay) {
    const when = rows[0]!;
    rows[0] = { ...when, items: [...when.items, { kind: "word", text: timeZone }] };
  }
  rows.push(...optionalRow("place", draft, change, t));
  rows.push({
    id: "calendar",
    mark: hueOf(calendar?.color ?? null),
    items: [
      choose
        ? {
            kind: "slot",
            label: t("create.calendar"),
            value: calendar?.name ?? t("create.choose"),
            expanded: menu?.kind === "calendar",
            onPress: (event) => setMenu({ kind: "calendar", anchor: event.currentTarget }),
          }
        : { kind: "word", text: calendar?.name ?? t("create.calendar") },
      { kind: "toggle", label: t("create.busy"), on: draft.busy, onChange: (busy) => change({ busy }) },
      {
        kind: "toggle",
        label: t("create.private"),
        on: draft.private,
        onChange: (value) => change({ private: value }),
      },
    ],
  });
  rows.push(...optionalRow("notes", draft, change, t));
  return (
    <>
      <EventForm
        rows={rows}
        adds={[
          ...(draft.place === null
            ? [
                {
                  id: "place",
                  word: t("create.place"),
                  icon: "pin" as const,
                  onPress: () => change({ place: "" }),
                },
              ]
            : []),
          ...(draft.notes === null
            ? [
                {
                  id: "notes",
                  word: t("create.notes"),
                  icon: "note" as const,
                  onPress: () => change({ notes: "" }),
                },
              ]
            : []),
        ]}
        {...(add ? { submit: { label: t("create.add"), keyHint: "↵", disabled: !ready, onPress: add } } : {})}
      />
      {menu?.kind === "date" && (
        <DatePicker
          locale={locale}
          today={today}
          value={draft.day}
          anchor={menu.anchor}
          labels={{
            dialog: t("create.date"),
            prevMonth: t("before"),
            nextMonth: t("after"),
            today: t("today"),
          }}
          onPick={(day) => {
            change({ day });
            setMenu(null);
          }}
          onClose={() => setMenu(null)}
        />
      )}
      {choose && menu?.kind === "calendar" && (
        <Menu open anchor={menu.anchor} label={t("create.calendar")} onClose={() => setMenu(null)}>
          {choices.map((c) => (
            <MenuItem
              key={c.id}
              checked={c.id === calendar?.id}
              onPress={() => {
                choose(c.id);
                setMenu(null);
              }}
            >
              {c.name}
            </MenuItem>
          ))}
        </Menu>
      )}
    </>
  );
}
