import { useState, type MouseEvent } from "react";
import { RepeatMenu } from "./RepeatMenu.js";
import { repeatLine } from "./EventActionQuestion.js";
import { DatePicker } from "./DatePicker.js";
import { EventForm, type CalendarTone, type EventFormProps, type EventFormRow } from "@ohmail/ui/calendar";
import { addDays, clockOf, dayShort, readQuickEntry, type CalendarRecord } from "@ohmail/app-logic/calendar";
import { useLocale, useText, type Text } from "../text/index.js";
import { ShowAsMenu } from "./ShowAsMenu.js";
import { DraftCalendarMenu } from "./DraftCalendarMenu.js";
import { ZoneMenu } from "./ZoneMenu.js";
import { useEditorRows, type EditorRows } from "./use-editor-rows.js";
import { zoneForCity, zoneName } from "./zone-names.js";
import { useDraftPlace } from "./DraftPlace.js";
import { endDayOf, type EventDraft } from "./event-draft.js";

interface Props {
  readonly draft: EventDraft;
  readonly repeatShapes?: readonly string[];
  readonly today: string;
  readonly calendar: CalendarRecord | undefined;
  readonly tone: CalendarTone;
  readonly choices: readonly CalendarRecord[];
  readonly choose?: (id: string) => void;
  readonly edit?: EditorRows;
  readonly proposedGuest?: { name: string; take: () => void };
  readonly fixedTime?: string;
  readonly timeZone?: string;
  readonly placeSource?: string;
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
  timeZone?: string,
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
      ...(!draft.allDay && timeZone
        ? [
            {
              kind: "slot" as const,
              label: t("create.timeZone"),
              value: zoneName(timeZone),
              expanded: menu?.kind === "zone",
              onPress: (event: MouseEvent<HTMLButtonElement>) =>
                open({ kind: "zone", anchor: event.currentTarget }),
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

function notesRow(draft: EventDraft, change: Props["change"], t: Text): EventFormRow[] {
  return draft.notes === null
    ? []
    : [
        {
          id: "notes",
          icon: "note",
          items: [
            {
              kind: "notes",
              value: draft.notes,
              label: t("create.notes"),
              onChange: (notes) => change({ notes }),
            },
          ],
        },
      ];
}

function inviteeRows(rows: EventFormRow[], guest: Props["proposedGuest"], t: Text): EventFormRow[] {
  if (!guest) return rows;
  const slot = { kind: "take" as const, label: guest.name, value: guest.name, onPress: guest.take };
  return rows.length
    ? rows.map((row) => ({ ...row, items: [...row.items, slot] }))
    : [{ id: "invitees", icon: "people", items: [{ kind: "word", text: t("edit.invite") }, slot] }];
}

type MenuAnchor = { kind: "date" | "end" | "calendar" | "busy" | "zone" | "repeat"; anchor: HTMLElement };

function repeatRow(
  draft: EventDraft,
  t: Text,
  locale: string,
  expanded: boolean,
  openRepeat: (e: MouseEvent<HTMLButtonElement>) => void,
  timeZone?: string,
): EventFormRow | undefined {
  if (draft.repeat) {
    return {
      id: "repeat",
      icon: "repeat",
      items: [
        {
          kind: "slot",
          label: t("edit.repeatLabel"),
          value: repeatLine(draft.repeat, draft.day.replaceAll("-", ""), t, locale, draft.zone ?? timeZone),
          expanded,
          onPress: openRepeat,
        },
      ],
    };
  }
}

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
  edit,
  proposedGuest,
  repeatShapes,
  placeSource,
}: Props) {
  const t = useText("calendar");
  const locale = useLocale();
  const [menu, setMenu] = useState<MenuAnchor | null>(null);
  const details = useEditorRows(draft, change, edit);
  const place = useDraftPlace(
    draft.place,
    (next) => change({ place: next }),
    placeSource,
    draft.zone ?? calendar?.timeZone,
  );
  const rows: EventFormRow[] = [
    fixedTime
      ? { id: "when", icon: "clock", items: [{ kind: "word", text: fixedTime }] }
      : whenRow({ draft, today, change }, t, locale, menu, setMenu, timeZone),
  ];
  const openRepeat = (event: MouseEvent<HTMLButtonElement>) =>
    setMenu({ kind: "repeat", anchor: event.currentTarget });
  const repeat = repeatRow(draft, t, locale, menu?.kind === "repeat", openRepeat, timeZone);
  if (repeat) rows.push(repeat);
  rows.push(...inviteeRows(details.beforePlace, proposedGuest, t), ...place.rows, ...details.afterPlace);
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
        : {
            kind: "slot",
            state: "done",
            disabled: true,
            label: t("create.calendar"),
            value: calendar?.name ?? "",
          },
      {
        kind: "slot",
        label: t("create.showAs"),
        value: t(draft.busy ? "create.busy" : "create.free"),
        expanded: menu?.kind === "busy",
        onPress: (event) => setMenu({ kind: "busy", anchor: event.currentTarget }),
      },
      {
        kind: "toggle",
        label: t("create.private"),
        icon: edit && !choose ? "lock" : undefined,
        on: draft.private,
        onChange: (value) => change({ private: value }),
      },
    ],
  });
  rows.push(...notesRow(draft, change, t));
  return (
    <>
      <EventForm
        rows={rows}
        adds={[
          ...details.adds,
          ...(!draft.repeat
            ? [{ id: "repeat", word: t("edit.repeatLabel"), icon: "repeat" as const, onPress: openRepeat }]
            : []),
          ...(draft.place === null
            ? [
                {
                  id: "place",
                  word: t("create.place"),
                  icon: "pin" as const,
                  onPress: () => {
                    change({ place: "" });
                    place.open?.();
                  },
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
      {place.overlay}
      {details.menu}
      {menu && (
        <DraftMenus
          {...{ draft, today, calendar, choices, choose, change, menu, setMenu, timeZone, repeatShapes }}
        />
      )}
    </>
  );
}

function DraftMenus({
  draft,
  today,
  calendar,
  choices,
  choose,
  change,
  menu,
  setMenu,
  timeZone,
  repeatShapes,
}: Pick<
  Props,
  "repeatShapes" | "draft" | "today" | "calendar" | "choices" | "choose" | "change" | "timeZone"
> & {
  menu: MenuAnchor;
  setMenu: (menu: null) => void;
}) {
  const t = useText("calendar");
  const locale = useLocale();
  return (
    <>
      {(menu?.kind === "date" || menu?.kind === "end") && (
        <DatePicker
          locale={locale}
          today={today}
          value={menu.kind === "end" ? endDayOf(draft) : draft.day}
          anchor={menu.anchor}
          labels={{
            dialog: t(menu.kind === "end" ? "create.endDate" : "create.date"),
            prevMonth: t("mini.before"),
            nextMonth: t("mini.after"),
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
      {menu.kind === "repeat" && (
        <RepeatMenu
          {...{ draft, repeatShapes }}
          anchor={menu.anchor}
          choose={(repeat) => change({ repeat })}
          close={() => setMenu(null)}
        />
      )}
      {menu?.kind === "busy" && (
        <ShowAsMenu
          anchor={menu.anchor}
          busy={draft.busy}
          choose={(busy) => change({ busy })}
          close={() => setMenu(null)}
        />
      )}
      {menu?.kind === "zone" && timeZone && (
        <ZoneMenu
          anchor={menu.anchor}
          zone={timeZone}
          close={() => setMenu(null)}
          pick={(zone) => change({ zone })}
        />
      )}
      {choose && menu?.kind === "calendar" && (
        <DraftCalendarMenu
          anchor={menu.anchor}
          choices={choices}
          current={calendar?.id}
          choose={(id) => {
            choose(id);
            setMenu(null);
          }}
          close={() => setMenu(null)}
        />
      )}
    </>
  );
}

export type NewEventDraft = EventDraft & { readonly typed?: true };
const DAY_MINUTES = 24 * 60;

export function readDraftEntry(written: NewEventDraft, today: string) {
  const read = written.typed && readQuickEntry(written.title, { today, zoneOf: zoneForCity });
  if (!read) return null;
  const day = read.day ?? written.day;
  const end = read.to ?? 0;
  const endDay = read.endDay ?? day;
  const draft: NewEventDraft = {
    ...written,
    title: read.title,
    day,
    ...(read.from === undefined
      ? read.day && { endDay: read.endDay ?? null }
      : {
          from: clockOf(read.from),
          to: clockOf(end % DAY_MINUTES),
          endDay: end >= DAY_MINUTES ? addDays(endDay, Math.floor(end / DAY_MINUTES)) : (read.endDay ?? null),
        }),
    allDay: read.allDay ?? written.allDay,
    place: read.place ?? written.place,
    zone: read.zone ?? written.zone,
    alarms: read.alert === undefined ? written.alarms : [read.alert],
  };
  return { draft, marks: read.marks, guest: read.guest };
}
