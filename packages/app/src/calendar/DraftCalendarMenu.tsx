import { hueOf, type CalendarRecord } from "@ohmail/app-logic/calendar";
import { wayOfConnection } from "@ohmail/app-logic/calendar/setup";
import { Menu, MenuItem } from "@ohmail/ui/base";
import { CalendarSquare, type CalendarTone, type EventFormRow } from "@ohmail/ui/calendar";
import { useCalendarMirror } from "../calsetup/index.js";
import { useText, type Text } from "../text/index.js";
import type { EventDraft } from "./event-draft.js";

export function DraftCalendarMenu({
  anchor,
  choices,
  current,
  choose,
  close,
}: {
  anchor: HTMLElement;
  choices: readonly CalendarRecord[];
  current: string | undefined;
  choose: (id: string) => void;
  close: () => void;
}) {
  const t = useText("calendar");
  const settings = useText("calsettings");
  const mirror = useCalendarMirror();
  return (
    <Menu open up anchor={anchor} label={t("create.calendar")} onClose={close}>
      {choices.map((choice) => {
        const connection = mirror?.connections.find(({ id }) => id === choice.connectionId);
        return (
          <MenuItem
            key={choice.id}
            leading={<CalendarSquare tone={mirror?.tones.get(choice.id) ?? hueOf(choice.color)} />}
            checked={choice.id === current}
            note={connection && settings(`way.${wayOfConnection(connection)}`)}
            onPress={() => choose(choice.id)}
          >
            {choice.name}
          </MenuItem>
        );
      })}
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
