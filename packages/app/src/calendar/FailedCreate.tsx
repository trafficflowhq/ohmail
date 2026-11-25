import { calendarRefusalSentence, pressAndHear, type CalendarPort } from "@ohmail/app-logic/calendar";
import { Button, RefusalLine } from "@ohmail/ui/base";
import { useFrame, useReport } from "../frame/commands.js";
import { NONE } from "../host/index.js";
import { useText, useTimeZone } from "../text/index.js";
import { useOpenNewDraft } from "./draft-undo.js";
import { draftOfRecord } from "./edit-draft.js";
import type { CalendarEventFace } from "./faces.js";

export function FailedCreate({
  port,
  event,
}: {
  port: CalendarPort | typeof NONE;
  event: CalendarEventFace;
}) {
  const zone = useTimeZone();
  const t = useText("calendar");
  const e = useText("event");
  const open = useOpenNewDraft(port);
  const { commands } = useFrame();
  const report = useReport();
  if (port === NONE || event.viewOnly || !event.failedCreate) return null;
  const record = port.events().find(({ record }) => record.id === event.recordId)?.record;
  if (!record) return null;
  const writeId = record.writes.find(
    ({ state, act }) => state === "refused" && act?.kind === "calendar_event_create",
  )?.id;
  const reason = e(calendarRefusalSentence(event.failedCreate));
  const reopen = () => {
    if (!writeId) port.forgetUnsentCreate?.(record.id);
    open(draftOfRecord(record, zone).draft, record.calendarId, {
      reason,
      calendar: record.calendarId,
      inviteesRefused: event.failedCreate === "invitees_unsupported",
      writeId,
    });
  };
  const discard = async () => {
    if (writeId) {
      try {
        const result = await pressAndHear(port, { kind: "calendar_write_dismiss", writeId });
        if (result.verdict?.kind === "refused" && result.say) {
          report(e(result.say));
          return;
        }
      } catch {
        report(e("refusal.unknown"));
        return;
      }
    } else {
      port.forgetUnsentCreate?.(record.id);
    }
    commands.event(null);
  };
  return (
    <>
      <RefusalLine start way={{ label: t("draft.reopen"), onPress: reopen }}>
        {reason}
      </RefusalLine>
      <Button kind="quiet" size="s" onPress={discard}>
        {t("edit.discard")}
      </Button>
    </>
  );
}
