import { useLayoutEffect, useRef, useState } from "react";
import type {
  CalendarConnectionRecord,
  CalendarEventRecord,
  CalendarPort,
  CalendarRecord,
} from "@ohmail/app-logic/calendar";
import { QuestionBeforeAct } from "@ohmail/ui/calendar";
import type { InvitationActions } from "../invitations/EventAnswers.js";
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
  reply?: InvitationActions,
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
  const raw = (id: string) => host.engine.store.get<CalendarEventRecord>("calendar_event", id);
  const active = useInvitationRemoval(port, event, record, reply);
  if (active.removal) return active;
  if (port === NONE || !record || record.heldBack) return {};
  const confirmed = raw(record.id);
  const occurrence = event.ref.occurrence;
  const series = occurrence === null ? undefined : raw(event.ref.event);
  const related = !!series && series.calendarId === confirmed?.calendarId && series.uid === confirmed.uid;
  if (record.status !== "cancelled" && confirmed?.myAnswer !== "declined") return {};
  const availableSeries =
    related && (series.status === "cancelled" || series.myAnswer === "declined") ? series : undefined;
  const label = t(record.status === "cancelled" ? "actions.removeCancelled" : "actions.removeDeclined");
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
            (record.status === "cancelled" || raw(record.id)?.myAnswer === "declined"),
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

type RemovalChoice = {
  anchor: HTMLElement;
  base: string;
  seriesBase?: string;
  attendee: string;
  calendarId: string;
  choose?: "hide" | "decline";
};

function useInvitationRemoval(
  port: CalendarPort | typeof NONE,
  event: CalendarEventFace,
  record: CalendarEventRecord | undefined,
  reply?: InvitationActions,
) {
  const { commands, host, route: frameRoute } = useFrame();
  const t = useText("calendar");
  const e = useText("event");
  const report = useReport();
  const locale = useLocale();
  const [choice, setChoice] = useState<RemovalChoice | null>(null);
  useLayoutEffect(() => setChoice(null), [host.engine, port, event.id, frameRoute.place, frameRoute.sub]);
  if (port === NONE || !record || record.heldBack) return {};
  const raw = (id: string) => host.engine.store.get<CalendarEventRecord>("calendar_event", id);
  const confirmed = raw(record.id);
  const occurrence = event.ref.occurrence;
  const whole = occurrence === null ? undefined : hideSeries(host, confirmed, raw(event.ref.event));
  const active =
    canHideCopy(host, record.calendarId, confirmed) &&
    confirmed.status !== "cancelled" &&
    confirmed.myAnswer !== "declined" &&
    !port.events().find((item) => item.record.id === record.id)?.waiting &&
    (!confirmed.recurrenceId || (whole && occurrence === confirmed.recurrenceId));
  if (!active) return {};
  const label = t("actions.removeFromCalendar");
  const canDeclineThis = !confirmed.recurrenceId && !!reply?.invitation(confirmed.id);
  const canDeclineAll = !!whole && whole.myAnswer !== "declined" && !!reply?.invitation(whole.id);
  const choose = (value: "hide" | "decline", scope: "record" | "occurrence") => {
    if (!choice) return;
    setChoice(null);
    const selected = raw(confirmed.id);
    const master = whole && raw(whole.id);
    if (
      selected?.updatedAt !== choice.base ||
      selected.hideAttendee !== choice.attendee ||
      selected.calendarId !== choice.calendarId ||
      (whole && (master?.updatedAt !== choice.seriesBase || master?.hideAttendee !== choice.attendee))
    ) {
      report(e("refusal.changed"));
      return;
    }
    if (value === "decline") {
      const target = scope === "record" && occurrence !== null ? master : selected;
      if (target && (scope === "record" && occurrence !== null ? canDeclineAll : canDeclineThis))
        void reply?.answer(target.id, "declined", {
          base: target.updatedAt,
          copy: { calendarId: choice.calendarId, attendee: choice.attendee },
          occurrence: scope === "occurrence" ? occurrence : null,
        });
      return;
    }
    const target = occurrence !== null && scope === "record" ? master : selected;
    if (
      !target ||
      (scope === "occurrence" && occurrence === null) ||
      (scope === "record" && target.myAnswer === "declined")
    )
      return;
    const base =
      target.recurrenceId && choice.seriesBase ? `${choice.base}/${choice.seriesBase}` : target.updatedAt;
    const route = host.device.address.read();
    void commitAction(
      port,
      {
        kind: "calendar_event_delete",
        localOnly: true,
        hide: true,
        copy: { calendarId: choice.calendarId, attendee: choice.attendee },
        eventId: target.id,
        base,
        scope: scope === "record" ? { kind: "record" } : { kind: "occurrence", at: occurrence! },
      },
      [],
      locale,
      e,
      report,
      () => host.device.address.read() === route,
      () => {
        if (event.id === frameRoute.open) commands.event(null);
      },
    ).catch(() => {
      if (host.device.address.read() === route) report(e("refusal.unknown"));
    });
  };
  const pick = (value: "hide" | "decline") => {
    if (!choice) return;
    if (occurrence === null) choose(value, "record");
    else setChoice({ ...choice, choose: value });
  };
  const removal: PanelVerb = {
    id: "remove",
    icon: "trash",
    label,
    rank: 0,
    onPress: (anchor) =>
      setChoice({
        anchor,
        base: confirmed.updatedAt,
        seriesBase: whole?.updatedAt,
        calendarId: confirmed.calendarId,
        attendee: confirmed.hideAttendee,
      }),
  };
  const removalQuestion = choice && (
    <InvitationRemovalQuestion
      choice={choice}
      label={label}
      allowHideAll={!!whole && whole.myAnswer !== "declined"}
      {...{ canDeclineThis, canDeclineAll, choose, pick }}
      close={() => setChoice(null)}
    />
  );
  return { removal, removalQuestion };
}

function InvitationRemovalQuestion({
  choice,
  label,
  allowHideAll,
  canDeclineThis,
  canDeclineAll,
  choose,
  pick,
  close,
}: {
  choice: RemovalChoice;
  label: string;
  allowHideAll: boolean;
  canDeclineThis: boolean;
  canDeclineAll: boolean;
  choose: (value: "hide" | "decline", scope: "record" | "occurrence") => void;
  pick: (value: "hide" | "decline") => void;
  close: () => void;
}) {
  const t = useText("calendar");
  return choice.choose ? (
    <CalendarRecordScope
      anchor={choice.anchor}
      question={t(choice.choose === "hide" ? "actions.hideInOhcal" : "actions.declineNotify")}
      occurrence={choice.choose === "hide" || canDeclineThis}
      record={choice.choose === "hide" ? allowHideAll : canDeclineAll}
      onClose={close}
      onChoose={(scope) => choose(choice.choose!, scope)}
    />
  ) : (
    <QuestionBeforeAct
      open
      anchor={choice.anchor}
      question={label}
      cancel={t("edit.cancel")}
      onClose={close}
      scopes={[
        {
          id: "hide",
          label: t("actions.hideInOhcal"),
          description: t("actions.hideEffect"),
          onPress: () => pick("hide"),
        },
        ...(canDeclineThis || canDeclineAll
          ? [
              {
                id: "decline",
                label: t("actions.declineNotify"),
                description: t("actions.declineEffect"),
                onPress: () => pick("decline"),
              },
            ]
          : []),
      ]}
    />
  );
}

function hideSeries(
  host: ReturnType<typeof useFrame>["host"],
  copy: CalendarEventRecord | undefined,
  series: CalendarEventRecord | undefined,
) {
  if (
    copy &&
    canHideCopy(host, copy.calendarId, series) &&
    series.uid === copy.uid &&
    series.status !== "cancelled" &&
    series.hideAttendee === copy.hideAttendee &&
    series.organizer?.address === copy.organizer?.address
  )
    return series;
}

function canHideCopy(
  host: ReturnType<typeof useFrame>["host"],
  calendarId: string,
  copy: CalendarEventRecord | undefined,
): copy is CalendarEventRecord & { hideAttendee: string } {
  const calendar = host.engine.store.get<CalendarRecord>("calendar", calendarId);
  const connection =
    calendar && host.engine.store.get<CalendarConnectionRecord>("calendar_connection", calendar.connectionId);
  return (
    !!copy?.hideAttendee &&
    !copy.cut &&
    !copy.heldBack &&
    !copy.thisAndFuture &&
    copy.calendarId === calendar?.id &&
    calendar.access === "owner" &&
    calendar.shown &&
    !!connection &&
    (connection.status === "active" || connection.status === "failing")
  );
}
