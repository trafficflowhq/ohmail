import type { CalendarRecord } from "@ohmail/app-logic/calendar";
import { useFrame, useReport } from "../frame/commands.js";
import { NONE } from "../host/index.js";
import { useText } from "../text/index.js";
import type { CalendarEventFace } from "./faces.js";

export function verifiedCallLink(value: string | null | undefined): string | null {
  if (!value || !/^https:\/\/[^/]/.test(value) || /[\s\p{Cc}\\]/u.test(value)) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

export function useEventCall(event: CalendarEventFace) {
  const { host } = useFrame();
  const report = useReport();
  const t = useText("calendar");
  const port = host.wires.calendar;
  if (port === NONE) return null;
  const record = port.events().find(({ record }) => record.id === event.recordId)?.record;
  if (!record || record.heldBack || record.status === "cancelled") return null;
  const readable = host.engine.store
    .entries<CalendarRecord>("calendar")
    .some(({ entity }) => entity?.id === record.calendarId && entity.shown && entity.access !== "busy");
  const href = readable ? verifiedCallLink(record.callLink) : null;
  if (!href) return null;
  const reader = host.features.reader;
  const clipboard = reader === NONE ? undefined : reader.copy;
  return {
    label: t("call.label"),
    join: { label: t("call.join"), href },
    address: href.slice("https://".length),
    copy: clipboard
      ? {
          label: t("call.copy"),
          onPress: () => {
            void clipboard(href).then(
              (copied) => {
                if (copied) report(t("call.copied"));
              },
              () => undefined,
            );
          },
        }
      : undefined,
  };
}
