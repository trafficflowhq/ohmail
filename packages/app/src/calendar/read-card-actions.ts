import { useRef, useState } from "react";
import { pressAndHear, type CalendarPort } from "@ohmail/app-logic/calendar";
import type { PanelVerb } from "@ohmail/ui/mail";
import { useCalendarMirror, useSetupPort } from "../calsetup/index.js";
import { useReport } from "../frame/commands.js";
import { NONE } from "../host/index.js";
import { useText, useTimeZone } from "../text/index.js";
import { useDuplicateDraft } from "./draft-undo.js";
import { draftForDuplicate } from "./edit-draft.js";
import type { editableEvent } from "./editable-event.js";
import { draftCalendars } from "./event-draft.js";
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
  const canCopy =
    enabled &&
    event.viewOnly &&
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
  return { duplicate, hide, retry: enabled ? retry : undefined };
}

function useRetry(port: CalendarPort | typeof NONE, event: CalendarEventFace): PanelVerb | undefined {
  const t = useText("invitations");
  const e = useText("event");
  const report = useReport();
  const sending = useRef(false);
  const [busy, setBusy] = useState(false);
  const writeId = event.retryWriteId;
  if (port === NONE || !writeId) return undefined;
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
