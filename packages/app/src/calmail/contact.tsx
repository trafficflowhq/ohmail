import type { EngineMessage } from "@ohmail/wire";
import { comingUpOf } from "@ohmail/app-logic/calendar/beside";
import { addDays } from "@ohmail/app-logic/calendar";
import { MenuItem } from "@ohmail/ui/base";
import { TodayList, type TodayListRow } from "@ohmail/ui/calendar";
import { useSharedCalendarSettings } from "../calsettings/settings-read.js";
import { useNewEvent } from "../calendar/use-new-event.js";
import { useFrame } from "../frame/commands.js";
import { useOwnAddresses } from "../frame/room.js";
import { useFound } from "../frommail/index.js";
import { NONE } from "../host/index.js";
import { whenOf } from "../invitations/index.js";
import type { ContactOf } from "../reader/contact/Contact.js";
import { useLocale, useText } from "../text/index.js";
import { COMING_DAYS, COMING_ROWS, useRowOf } from "./parts.js";
import { useOccurrencesAhead } from "./use-occurrences.js";

type Props = { person: ContactOf; onClose: () => void };
const keyOf = (address: string) => address.trim().toLowerCase();

function useCalendarFor(person: ContactOf) {
  const { host } = useFrame();
  const settings = useSharedCalendarSettings();
  const ownAddresses = useOwnAddresses();
  return (
    host.wires.calendar !== NONE &&
    settings?.said?.enabledAt !== null &&
    !ownAddresses.some((own) => keyOf(own) === keyOf(person.address))
  );
}

export function ContactEvents(props: Props) {
  const on = useCalendarFor(props.person);
  return on ? <ContactEventsOn {...props} /> : null;
}

function ContactEventsOn({ person, onClose }: Props) {
  const { host, commands } = useFrame();
  const t = useText("calmail");
  const f = useText("frommail");
  const locale = useLocale();
  const around = useOccurrencesAhead(COMING_DAYS);
  const found = useFound(host.wires.calendar);
  const rowOf = useRowOf();
  if (!around) return null;
  const address = keyOf(person.address);
  const read = host.engine.verbRead();
  const seed = person.messageId ? read.get<EngineMessage>("message", person.messageId) : undefined;
  const today = around.now.day;
  const last = addDays(today, COMING_DAYS);
  const calendarRows = comingUpOf(around.shown, address, Infinity, around.now);
  const rows: { day: string; minute: number; face: TodayListRow }[] = calendarRows.map((row) => ({
    day: row.day,
    minute: row.startMinute ?? -1,
    face: {
      ...rowOf(row, true),
      onPress: () => {
        onClose();
        commands.event(row.ref);
      },
    },
  }));
  if (seed && seed.accountId === host.session.mirrorAccount) {
    for (const row of found?.rows ?? []) {
      if (row.alreadyOn !== null || row.day > last) continue;
      const source = read.get<EngineMessage>("message", row.messageId);
      if (
        !source ||
        source.accountId !== seed.accountId ||
        source.mailboxId !== seed.mailboxId ||
        row.mailboxId !== seed.mailboxId ||
        keyOf(source.from.address) !== address
      )
        continue;
      rows.push({
        day: row.day,
        minute: row.when.startMinute ?? -1,
        face: {
          id: `mail:${row.id}`,
          title: row.title,
          time: whenOf(row.when, row.day, today, locale, f),
          mark: { kind: "found" },
          tag: { text: t("fromMail") },
          onPress: () => {
            onClose();
            commands.go({ place: "frommail", open: row.id });
          },
        },
      });
    }
  }
  if (rows.length === 0) return null;
  rows.sort((a, b) => a.day.localeCompare(b.day) || a.minute - b.minute);
  return (
    <TodayList
      kind="coming"
      label={t("coming", { name: person.name })}
      heading={{ title: t("comingHeading") }}
      rows={rows.slice(0, COMING_ROWS).map(({ face }) => face)}
      more={rows.length > COMING_ROWS ? t("more", { count: rows.length - COMING_ROWS }) : undefined}
      actions={
        <MenuItem
          icon="calendar"
          onPress={() => {
            onClose();
            commands.go({ place: "calsearch" });
          }}
        >
          {t("allEvents")}
        </MenuItem>
      }
    />
  );
}

export function ContactNewEvent({ person, onClose }: Props) {
  const on = useCalendarFor(person);
  const create = useNewEvent({ guests: [{ address: person.address, name: person.displayName ?? null }] });
  const t = useText("calmail");
  if (!on || !create || !person.address.includes("@")) return null;
  return (
    <MenuItem
      icon="calendar"
      onPress={() => {
        onClose();
        create();
      }}
    >
      {t("newEvent")}
    </MenuItem>
  );
}
