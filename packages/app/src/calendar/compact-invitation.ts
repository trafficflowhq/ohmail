import type { CalendarPort, ZoneSource } from "@ohmail/app-logic/calendar";
import type { CalendarPanelProps } from "../frame/contract.js";
import { useFrame } from "../frame/commands.js";
import { useText, useTimeZone } from "../text/index.js";
import { eventMoveOptions, writableEvent } from "./editable-event.js";
import type { CalendarEventFace } from "./faces.js";
import { useCalendarOwnAddresses } from "./own-addresses.js";
import { overlapTags } from "./overlap-tags.js";
import { useCalendarEventMail } from "./read-card-actions.js";
import type { EventActions } from "./use-event-actions.js";

export function useCompactInvitation(
  event: CalendarEventFace | undefined,
  faces: readonly CalendarEventFace[],
  zones: ZoneSource,
  port: CalendarPort,
  actions: EventActions,
): CalendarPanelProps["compact"] {
  const { host } = useFrame();
  const t = useText("calendar");
  const zone = useTimeZone();
  const own = useCalendarOwnAddresses();
  const record = event && port.events().find((entry) => entry.record.id === event.recordId)?.record;
  const write = useCalendarEventMail(record, event);
  if (!event || !record) return undefined;
  const destinations = eventMoveOptions(host, writableEvent(host, port, event.ref.event, own)).destinations;
  return {
    tags: overlapTags(event, faces, zone, zones, t),
    write,
    propose: actions.proposal.baseOf(event)
      ? { label: t("proposal.action"), onPress: () => actions.proposal.open(event) }
      : undefined,
    move: destinations.length
      ? {
          destinations,
          label: t("actions.moveTo"),
          pick: (target, anchor) => actions.start(event, { kind: "calendar", target }, anchor),
        }
      : undefined,
  };
}
