import { useRef, useState } from "react";
import { pressAndHear, type CalendarEventRecord, type CalendarPort } from "@ohmail/app-logic/calendar";
import type { PanelVerb } from "@ohmail/ui/mail";
import { useCalendarMirror, useSetupPort } from "../calsetup/index.js";
import { useFrame, useReport } from "../frame/commands.js";
import { NONE } from "../host/index.js";
import { useCalendarOwnAddresses } from "./own-addresses.js";
import { isEmailAddress } from "@ohmail/app-logic/writing/compose";
import { useText, useTimeZone } from "../text/index.js";
import { useDuplicateDraft } from "./draft-undo.js";
import { draftForDuplicate } from "./edit-draft.js";
import type { editableEvent } from "./editable-event.js";
import { draftCalendars } from "./event-draft.js";
import { useEventRemoval } from "./use-event-removal.js";
import type { CalendarEventFace } from "./faces.js";

export function useReadCardActions(
  port: CalendarPort | typeof NONE,
  event: CalendarEventFace,
  current: ReturnType<typeof editableEvent>,
  enabled: boolean,
) {
  const t = useText("calendar");
  const settings = useText("calsettings");
  const report = useReport();
  const setup = useSetupPort();
  const mirror = useCalendarMirror();
  const zone = useTimeZone();
  const duplicateDraft = useDuplicateDraft(port);
  const retry = useRetry(port, event);
  const record =
    port === NONE ? undefined : port.events().find((item) => item.record.id === event.recordId)?.record;
  const calendar = mirror?.calendars.find((item) => item.id === record?.calendarId);
  const visible = enabled && calendar?.shown && calendar.access !== "busy" ? record : undefined;
  const mail = useCalendarEventMail(visible, event);
  const removal = useEventRemoval(port, event, visible);
  const canCopy =
    enabled &&
    (event.viewOnly || record?.myAnswer != null) &&
    calendar?.shown &&
    calendar.access !== "busy" &&
    record &&
    !record.heldBack &&
    !record.cut &&
    !record.private &&
    event.state !== "off" &&
    mirror &&
    draftCalendars(mirror.calendars, new Map(mirror.connections.map((item) => [item.id, item]))).length > 0;
  const duplicate = current
    ? () =>
        duplicateDraft(
          draftForDuplicate(current.exception ?? current.record, event, zone),
          current.calendar.id,
        )
    : canCopy
      ? () => duplicateDraft({ ...draftForDuplicate(record, event, zone), invitees: [] }, null)
      : undefined;
  const setCalendar = setup === NONE ? NONE : setup.setCalendar;
  const hide: PanelVerb | undefined =
    enabled && event.viewOnly && calendar?.shown && setCalendar !== NONE
      ? {
          id: "hideCalendar",
          label: t("actions.hideCalendar"),
          icon: "x",
          onPress: () =>
            void setCalendar(calendar.id, { shown: false }).catch(() => report(settings("notSaved"))),
        }
      : undefined;
  return { duplicate, hide, mail, ...removal, retry: enabled ? retry : undefined };
}

export function useCalendarEventMail(
  record: CalendarEventRecord | undefined,
  event: CalendarEventFace | undefined,
): PanelVerb | undefined {
  const { commands, host } = useFrame();
  const own = useCalendarOwnAddresses();
  const t = useText("calendar");
  const refusal = useText("viewError");
  const report = useReport();
  const pairing = useRef(false);
  const entry = host.features.calendar;
  const outside = entry === NONE ? undefined : entry.writeGuests;
  if (
    (host.capabilities.products !== "both" && !outside) ||
    !event ||
    !own ||
    !record ||
    record.cut ||
    record.heldBack ||
    event.state === "off"
  )
    return undefined;
  const catalogued = event.viewOnly
    ? record.organizer && [record.organizer]
    : outside && record.organizer
      ? [record.organizer, ...record.invitees]
      : record.invitees;
  const addresses = new Set(own.map((address) => address.trim().toLowerCase()));
  const to = (catalogued ?? []).flatMap(({ address }) => {
    const key = address.trim().toLowerCase();
    if (addresses.has(key) || !isEmailAddress(address)) return [];
    addresses.add(key);
    return [address];
  });
  if (!to.length) return undefined;
  return {
    id: "writeGuests",
    label: t(event.viewOnly ? "actions.emailOrganizer" : "actions.writeGuests"),
    icon: "mail",
    rank: 4,
    onPress: () => {
      if (!outside) return commands.write({ to, cc: [], bcc: [], subject: record.title, body: "" });
      if (pairing.current) return;
      pairing.current = true;
      void outside(to, record.title.replace(/[\r\n]+/g, " ").slice(0, 998))
        .catch(() => report(refusal("tryAgain")))
        .finally(() => {
          pairing.current = false;
        });
    },
  };
}

function useRetry(port: CalendarPort | typeof NONE, event: CalendarEventFace): PanelVerb | undefined {
  const t = useText("invitations");
  const e = useText("event");
  const report = useReport();
  const sending = useRef(false);
  const [busy, setBusy] = useState(false);
  const writeId = event.retryWriteId;
  if (
    port === NONE ||
    !writeId ||
    port
      .events()
      .some(
        ({ record }) =>
          record.id === event.recordId &&
          record.writes.some(
            ({ id, act }) => id === writeId && act?.kind === "calendar_event_move" && act.copyThenRemove,
          ),
      )
  )
    return undefined;
  return {
    id: "retry",
    label: t("sendAgain"),
    kind: "ink",
    icon: "pull",
    rank: 0,
    busy,
    disabled: busy,
    onPress: async () => {
      if (
        sending.current ||
        !port
          .events()
          .some(
            (item) =>
              item.record.id === event.recordId &&
              item.refusedWriteId === writeId &&
              item.refusal !== null &&
              item.refusal !== "version_stale" &&
              item.refusal !== "earlier_refused",
          )
      )
        return;
      sending.current = true;
      setBusy(true);
      try {
        const heard = await pressAndHear(port, { kind: "calendar_write_retry", writeId });
        if (heard.say) report(e(heard.say));
      } catch {
        report(e("refusal.unknown"));
      } finally {
        sending.current = false;
        setBusy(false);
      }
    },
  };
}
