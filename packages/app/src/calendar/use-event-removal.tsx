import { useLayoutEffect, useRef, useState } from "react";
import type { CalendarEventRecord, CalendarPort } from "@ohmail/app-logic/calendar";
import type { PanelVerb } from "@ohmail/ui/mail";
import { useFrame, useReport } from "../frame/commands.js";
import { NONE } from "../host/index.js";
import { useLocale, useText } from "../text/index.js";
import { CalendarRecordScope } from "./EventActionQuestion.js";
import { commitAction } from "./commit-event-action.js";
import type { CalendarEventFace } from "./faces.js";

export function useEventRemoval(
  port: CalendarPort | typeof NONE,
  event: CalendarEventFace,
  record: CalendarEventRecord | undefined,
) {
  const t = useText("calendar");
  const e = useText("event");
  const report = useReport();
  const locale = useLocale();
  const { commands, host } = useFrame();
  const lifetime = useRef<symbol | null>(null);
  const pending = useRef(false);
  const [question, setQuestion] = useState<{ anchor: HTMLElement; base: string; seriesBase: string } | null>(
    null,
  );
  useLayoutEffect(() => {
    lifetime.current = Symbol();
    setQuestion(null);
    pending.current = false;
    return () => {
      lifetime.current = null;
    };
  }, [host.engine, port, event.id]);
  if (
    port === NONE ||
    !record ||
    record.heldBack ||
    (record.status !== "cancelled" && record.myAnswer !== "declined")
  )
    return {};
  const series =
    event.ref.occurrence === null
      ? undefined
      : port.events().find(({ record }) => record.id === event.ref.event)?.record;
  const availableSeries =
    series && (series.status === "cancelled" || series.myAnswer === "declined") ? series : undefined;
  const label = t(record.status === "cancelled" ? "actions.removeCancelled" : "actions.removeFromCalendar");
  const send = async (target: CalendarEventRecord, base: string, at: string | null) => {
    const id = lifetime.current;
    if (pending.current || id === null) return;
    if (
      target.updatedAt !== base ||
      !port
        .events()
        .some(
          ({ record }) =>
            record.id === target.id &&
            record.updatedAt === base &&
            (record.status === "cancelled" || record.myAnswer === "declined"),
        )
    ) {
      report(e("refusal.changed"));
      return;
    }
    pending.current = true;
    try {
      await commitAction(
        port,
        {
          kind: "calendar_event_delete",
          localOnly: true,
          eventId: target.id,
          base,
          scope: at === null ? { kind: "record" } : { kind: "occurrence", at },
        },
        [],
        locale,
        e,
        report,
        () => id === lifetime.current,
        () => commands.event(null),
      );
    } catch {
      if (id === lifetime.current) report(e("refusal.unknown"));
    } finally {
      if (id === lifetime.current) pending.current = false;
    }
  };
  const removal: PanelVerb = {
    id: "remove",
    icon: "trash",
    label,
    rank: 0,
    onPress: (anchor) => {
      if (availableSeries)
        setQuestion({ anchor, base: record.updatedAt, seriesBase: availableSeries.updatedAt });
      else void send(record, record.updatedAt, record.recurrenceId || null);
    },
  };
  const removalQuestion = question && availableSeries && (
    <CalendarRecordScope
      anchor={question.anchor}
      question={t("actions.removeScope", { title: event.title })}
      occurrence
      onClose={() => setQuestion(null)}
      onChoose={(scope) => {
        setQuestion(null);
        if (record.updatedAt !== question.base) {
          report(e("refusal.changed"));
          return;
        }
        if (scope === "record") void send(availableSeries, question.seriesBase, null);
        else void send(record, question.base, event.ref.occurrence);
      }}
    />
  );
  return { removal, removalQuestion };
}
