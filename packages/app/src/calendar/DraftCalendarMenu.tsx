import { Fragment } from "react";
import { hueOf, type CalendarRecord } from "@ohmail/app-logic/calendar";
import { accountsOf } from "@ohmail/app-logic/calendar/setup";
import { Menu, MenuItem, MenuNote, MenuRule } from "@ohmail/ui/base";
import { CalendarSquare, type CalendarTone, type EventFormRow } from "@ohmail/ui/calendar";
import { useCalendarMirror } from "../calsetup/index.js";
import { useText, type Text } from "../text/index.js";
import type { EventDraft } from "./event-draft.js";
import type { EventMoveOptions } from "./editable-event.js";

export interface CalendarChooser {
  choices: readonly CalendarRecord[];
  choose?: (id: string, anchor: HTMLElement) => void;
  label?: string;
  note?: string;
}

export type EventCalendarMove = EventMoveOptions & {
  blocked: boolean;
  start: NonNullable<CalendarChooser["choose"]>;
};

export function moveChooser(move: EventCalendarMove, dirty: boolean, t: Text): CalendarChooser {
  return {
    choices: move.destinations,
    choose: move.destinations.length && !dirty ? move.start : undefined,
    label: t("actions.moveTo"),
    note:
      dirty && move.destinations.length
        ? t("actions.moveRestriction.saveFirst")
        : move.moveRestriction
          ? t(`actions.moveRestriction.${move.moveRestriction}`)
          : undefined,
  };
}

export function DraftCalendarMenu({
  anchor,
  choices,
  label,
  note,
  current,
  choose,
  close,
}: {
  anchor: HTMLElement;
  choices: readonly CalendarRecord[];
  label?: string;
  note?: string;
  current: string | undefined;
  choose: (id: string) => void;
  close: () => void;
}) {
  const t = useText("calendar");
  const settings = useText("calsettings");
  const mirror = useCalendarMirror();
  const accounts = accountsOf(mirror?.connections ?? [], choices).filter(({ calendars }) => calendars.length);
  return (
    <Menu open up anchor={anchor} label={label ?? t("create.calendar")} onClose={close}>
      {note && <MenuNote>{note}</MenuNote>}
      {accounts.map(({ connection, way, calendars }, index) => (
        <Fragment key={connection.id}>
          {index > 0 && <MenuRule />}
          {calendars.map((choice) => (
            <MenuItem
              key={choice.id}
              leading={<CalendarSquare tone={mirror?.tones.get(choice.id) ?? hueOf(choice.color)} />}
              checked={choice.id === current}
              note={settings(`way.${way}`)}
              onPress={() => choose(choice.id)}
            >
              {choice.name}
            </MenuItem>
          ))}
        </Fragment>
      ))}
    </Menu>
  );
}

export function calendarRow(
  {
    calendar,
    tone,
    draft,
    change,
    ordinaryOnly,
    edit,
    choose,
    showAs,
    active,
  }: {
    calendar: CalendarRecord | undefined;
    tone: CalendarTone;
    draft: EventDraft;
    change: (value: Partial<EventDraft>) => void;
    ordinaryOnly?: boolean;
    edit: boolean;
    choose?: (anchor: HTMLElement) => void;
    showAs: (anchor: HTMLElement) => void;
    active?: string;
  },
  t: Text,
): EventFormRow {
  const calendarItem: EventFormRow["items"][number] = choose
    ? {
        kind: "slot",
        label: t("create.calendar"),
        value: calendar?.name ?? t("create.choose"),
        expanded: active === "calendar",
        onPress: (event) => choose(event.currentTarget),
      }
    : {
        kind: "slot",
        state: "done",
        disabled: true,
        label: t("create.calendar"),
        value: calendar?.name ?? "",
      };
  const items: EventFormRow["items"][number][] = [calendarItem];
  if (!ordinaryOnly)
    items.push(
      {
        kind: "slot",
        label: t("create.showAs"),
        value: t(draft.busy ? "create.busy" : "create.free"),
        expanded: active === "busy",
        onPress: (event) => showAs(event.currentTarget),
      },
      {
        kind: "toggle",
        label: t("create.private"),
        icon: edit && !choose ? "lock" : undefined,
        on: draft.private,
        onChange: (value) => change({ private: value }),
      },
    );
  return { id: "calendar", mark: tone, items };
}
