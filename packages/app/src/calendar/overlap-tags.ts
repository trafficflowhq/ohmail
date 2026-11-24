import { boundariesOf, type ZoneSource } from "@ohmail/app-logic/calendar";
import type { Text } from "../text/index.js";
import type { CalendarEventFace } from "./faces.js";

export function overlapTags(
  event: CalendarEventFace,
  faces: readonly CalendarEventFace[],
  zone: string,
  zones: ZoneSource,
  t: Text,
) {
  const at = boundariesOf(event, zone, zones);
  if (!at || event.state === "off") return [];
  const allDay = event.start.kind === "date";
  return faces.flatMap((other) => {
    if (other.id === event.id || other.state === "off" || (other.start.kind === "date") !== allDay) return [];
    const span = boundariesOf(other, zone, zones);
    return span && at.first < span.last && span.first < at.last
      ? [{ text: t("edit.overlaps", { title: other.title }), tone: other.tone }]
      : [];
  });
}
