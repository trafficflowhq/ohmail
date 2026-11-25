import { useLayoutEffect, useRef, type ReactNode, type RefObject } from "react";
import type { CalendarEventRecord } from "@ohmail/app-logic/calendar";
import { Button } from "@ohmail/ui/base";
import { EventBridge, type EventCardRow, type EventCardProps } from "@ohmail/ui/calendar";
import { useEventPlacement } from "./use-event-placement.js";
import type { Text } from "../text/index.js";
import { EventInvitees } from "./EventInvitees.js";
import { movePending } from "./editable-event.js";
import type { CalendarEventFace } from "./faces.js";
import { repeatLine } from "./EventActionQuestion.js";

function peopleRows(
  record: CalendarEventRecord,
  confirmed: CalendarEventRecord | undefined,
  own: readonly string[] | null,
  t: Text,
): EventCardRow[] {
  const rows: EventCardRow[] = [];
  const { organizer } = record;
  const invitees = record.invitees.filter(
    ({ address }) => address.toLowerCase() !== organizer?.address.toLowerCase(),
  );
  if (
    organizer &&
    !record.ownOrganizer &&
    own &&
    !own.some((address) => address.toLowerCase() === organizer.address.toLowerCase())
  ) {
    rows.push({ label: t("edit.from"), text: organizer.name || organizer.address });
  }
  if (!invitees.length) return rows;
  rows.push({
    label: t("edit.invitees"),
    children: <EventInvitees key={record.id} guests={invitees} organizer={organizer} confirmed={confirmed} />,
  });
  return rows;
}

export function eventDetails(
  record: CalendarEventRecord,
  confirmed: CalendarEventRecord | undefined,
  own: readonly string[] | null,
  t: Text,
  locale: string,
): EventCardRow[] {
  const rows = peopleRows(record, confirmed, own, t);
  const { repeat, start, alarms } = record;
  if (movePending(record)) rows.push({ label: t("actions.moveTo"), text: t("actions.moving") });
  if (repeat?.rules.length === 1 && !repeat.added.length) {
    rows.push({
      label: t("edit.repeatLabel"),
      text: repeatLine(repeat.rules[0], start.value, t, locale, start.zone),
    });
  }
  if (alarms.length) {
    const alert = new Intl.ListFormat(locale).format(
      alarms.map(({ minutesBefore }) => t("edit.alertMinutes", { minutes: minutesBefore })),
    );
    rows.push({ label: t("edit.alert"), text: alert });
  }
  return rows;
}

export function eventTimeRestriction(
  event: CalendarEventFace,
  invited: boolean,
  t: Text,
): EventCardRow | undefined {
  if (invited) return { label: t("edit.time"), children: t("edit.organizerTime") };
  if (event.repeats && event.state !== "off") {
    return {
      label: t("edit.action"),
      children: t(event.viewOnly ? "edit.repeatReadOnly" : "edit.repeatUnavailable"),
    };
  }
}

export function renderCardFoot(edit: EventCardProps["edit"] | null, panel: ReactNode, blocked: boolean) {
  return edit || panel ? (
    <>
      {edit && (
        <Button kind="two" icon="write" disabled={blocked} onPress={edit.onPress}>
          {edit.label}
        </Button>
      )}
      {panel}
    </>
  ) : null;
}

export function eventTags(event: CalendarEventFace, t: Text) {
  return [
    ...(event.waits ? [{ text: t("toAnswer"), hot: true }] : []),
    ...(event.said && event.state !== "off"
      ? [{ text: t(event.said.apart ? "saidOne" : "said", { answer: event.said.answer }) }]
      : []),
    ...(event.state === "off" ? [{ text: t("edit.cancelled"), hot: true }] : []),
    ...(event.state === "maybe" && !event.said ? [{ text: t("edit.maybe") }] : []),
    ...(event.conflict ? [{ text: t("edit.changedElsewhere"), hot: true }] : []),
  ];
}

export function useOpenEventPlacement(
  event: CalendarEventFace,
  phone: boolean,
  invited: boolean,
  revision: number | string | undefined,
  end: () => void,
) {
  const card = useRef<HTMLDivElement>(null);
  const seat = useEventPlacement(card, !phone, revision);
  const bridge = seat?.bridge && (
    <EventBridge {...seat.bridge} tone={invited && revision === undefined ? null : event.tone} />
  );
  const focus = useCardFocus(card, event.id, revision === undefined);
  return {
    card,
    seat,
    bridge,
    finish: () => {
      end();
      focus();
    },
  };
}

function useCardFocus(card: RefObject<HTMLDivElement | null>, id: string, reading: boolean) {
  const readAgain = useRef(false);
  useLayoutEffect(() => {
    if (reading && readAgain.current) {
      readAgain.current = false;
      card.current?.querySelector("button")?.focus();
    }
  }, [card, reading]);
  useLayoutEffect(() => {
    const opener = card.current?.ownerDocument.activeElement;
    card.current?.querySelector("button")?.focus();
    return () => {
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, [card, id]);
  return () => {
    readAgain.current = true;
  };
}
