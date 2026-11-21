import { useState, type MouseEvent } from "react";
import { DatePicker } from "./DatePicker.js";
import { Menu, MenuItem } from "@ohmail/ui/base";
import { EventForm, type CalendarTone, type EventFormProps, type EventFormRow } from "@ohmail/ui/calendar";
import { addDays, dayShort, type CalendarRecord } from "@ohmail/app-logic/calendar";
import { useLocale, useText, type Text } from "../text/index.js";
import { endDayOf, type EventDraft } from "./event-draft.js";

interface Props {
  readonly draft: EventDraft;
  readonly today: string;
  readonly calendar: CalendarRecord | undefined;
  readonly tone: CalendarTone;
  readonly choices: readonly CalendarRecord[];
  readonly choose?: (id: string) => void;
  readonly fixedTime?: string;
  readonly timeZone?: string;
  readonly change: (edit: Partial<EventDraft>) => void;
  readonly submit?: EventFormProps["submit"];
  readonly cancel?: EventFormProps["cancel"];
}

function whenRow(
  { draft, today, change }: Pick<Props, "draft" | "today" | "change">,
  t: Text,
  locale: string,
  menu: MenuAnchor | null,
  open: (menu: MenuAnchor) => void,
): EventFormRow {
  const endDay = endDayOf(draft);
  const nextDay = !draft.allDay && endDay === addDays(draft.day, 1);
  const end = {
    kind: "slot" as const,
    label: t("create.endDate"),
    value: dayShort(endDay, locale, today.slice(0, 4)),
    expanded: menu?.kind === "end",
    hidden: false,
    onPress: (event: MouseEvent<HTMLButtonElement>) => open({ kind: "end", anchor: event.currentTarget }),
  };
  return {
    id: "when",
    icon: "clock",
    items: [
      {
        kind: "slot",
        label: t("create.date"),
        value: dayShort(draft.day, locale, today.slice(0, 4)),
        expanded: menu?.kind === "date",
        onPress: (event) => open({ kind: "date", anchor: event.currentTarget }),
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
            { ...end, hidden: endDay === draft.day || nextDay },
            {
              kind: "time" as const,
              label: t("create.to"),
              value: draft.to,
              onChange: (to: string) => change({ to }),
              cue: nextDay
                ? { word: t("create.nextDay"), expanded: end.expanded, onPress: end.onPress }
                : undefined,
            },
          ]
        : [{ kind: "word" as const, text: t("create.toWord") }, end]),
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

type MenuAnchor = { kind: "date" | "end" | "calendar"; anchor: HTMLElement };

export function DraftFields({
  draft,
  today,
  calendar,
  tone,
  choices,
  choose,
  change,
  submit,
  cancel,
  fixedTime,
  timeZone,
}: Props) {
  const t = useText("calendar");
  const locale = useLocale();
  const [menu, setMenu] = useState<MenuAnchor | null>(null);
  const rows: EventFormRow[] = [
    fixedTime
      ? { id: "when", icon: "clock", items: [{ kind: "word", text: fixedTime }] }
      : whenRow({ draft, today, change }, t, locale, menu, setMenu),
  ];
  if (timeZone && !fixedTime && !draft.allDay) {
    const when = rows[0]!;
    rows[0] = { ...when, items: [...when.items, { kind: "word", text: timeZone }] };
  }
  rows.push(...optionalRow("place", draft, change, t));
  rows.push({
    id: "calendar",
    mark: tone,
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
        submit={submit}
        cancel={cancel}
      />
      {menu && menu.kind !== "calendar" && (
        <DatePicker
          locale={locale}
          today={today}
          value={menu.kind === "end" ? endDayOf(draft) : draft.day}
          anchor={menu.anchor}
          labels={{
            dialog: t(menu.kind === "end" ? "create.endDate" : "create.date"),
            prevMonth: t("before"),
            nextMonth: t("after"),
            today: t("today"),
          }}
          onPick={(day) => {
            if (menu.kind === "end") {
              change({ endDay: day < draft.day ? draft.day : day });
            } else {
              change({ day, endDay: draft.endDay && draft.endDay >= day ? draft.endDay : null });
            }
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
