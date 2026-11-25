import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Button, Dot, Menu, MenuItem, Slot } from "@ohmail/ui/base";
import { CalendarSquare, InvitationCard, type EventCardRow } from "@ohmail/ui/calendar";
import { pressAndHear, type CalendarEventRecord, type CalendarPort } from "@ohmail/app-logic/calendar";
import type {
  CalendarTime,
  EngineMessage,
  InvitationAnswer,
  InvitationAnswerBody,
  InvitationAnswerResult,
} from "@ohmail/wire";
import { useCalendarInvitation, useFrame, useReport } from "../frame/commands.js";
import { NONE } from "../host/index.js";
import { useText } from "../text/index.js";
import { commitAction } from "../calendar/commit-event-action.js";
import { useInvitationAnswer } from "../invitations/EventAnswers.js";
import { AnswerChoices } from "../invitations/AnswerChoices.js";
import { sameTime, useLetterView, type LetterView } from "./invitation-letter-view.js";

export interface InvitationLetterProps {
  message: EngineMessage;
  invitation: NonNullable<EngineMessage["invitation"]>;
  title: string;
  when: string | null;
  place: string | null;
  from: string | null;
  start: CalendarTime | null;
  end: CalendarTime | null;
  repeat: string | null;
  copyable: boolean;
  chosenCalendarId?: string;
  reply: (body: InvitationAnswerBody, key: string) => Promise<InvitationAnswerResult>;
}
function personalFields(props: InvitationLetterProps) {
  if (!props.start || !props.end || !props.copyable) return null;
  return {
    title: props.title,
    start: props.start,
    end: props.end,
    place: props.place,
    notes: null,
    callLink: null,
    private: false,
    busy: true,
    repeat: props.repeat,
    invitees: [],
    alarms: [],
  };
}

export function InvitationLetterCard(props: InvitationLetterProps) {
  const { host } = useFrame();
  const port = host.wires.calendar;
  return port === NONE ? (
    <LetterCard {...props} port={NONE} />
  ) : (
    <CalendarLetterCard {...props} port={port} />
  );
}

function CalendarLetterCard(props: InvitationLetterProps & { port: CalendarPort }) {
  const providerAnswer = useInvitationAnswer(props.port);
  return <LetterCard {...props} providerAnswer={providerAnswer} />;
}

type LetterCardProps = InvitationLetterProps & {
  port: CalendarPort | typeof NONE;
  providerAnswer?: ReturnType<typeof useInvitationAnswer>;
};

function useLetterActions(props: LetterCardProps, view: LetterView) {
  const { invitation, message, port } = props;
  const { record, target, face, placed, text, locale } = view;
  const { commands } = useFrame();
  const pending = useCalendarInvitation();
  const report = useReport();
  const eventText = useText("event");
  const [confirmed, setConfirmed] = useState<InvitationAnswer | null>(null);
  const [gone, setGone] = useState(false);
  const request = useRef(false);
  const live = useRef(false);
  useLayoutEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  useLayoutEffect(() => setConfirmed(null), [invitation.answeredAt]);
  const save = async () => {
    if (port === NONE || (!target && !record)) return;
    const saved = await fileInvitation(port, props, target?.id, record).catch(() => false);
    if (!saved && live.current) report(text("calendarRefused"));
  };
  const send = async (value: InvitationAnswer) => {
    if (view.cancelled || request.current) return;
    request.current = true;
    try {
      const provider =
        view.current && !view.personal && record && props.providerAnswer?.invitation(record.id);
      if (provider) {
        await props.providerAnswer!.answer(record.id, value);
        return;
      }
      const result = await props.reply(
        { answer: value, basis: confirmed ?? invitation.answer },
        crypto.randomUUID(),
      );
      if (!live.current) return;
      if (result.status !== "sent" && result.status !== "already") {
        report(text("answerPending"));
        return;
      }
      setConfirmed(value);
      if (value !== "declined" && (!record || view.personal)) await save();
    } catch {
      if (live.current) report(text("answerRefused"));
    } finally {
      request.current = false;
    }
  };
  const open =
    face && !view.hidden
      ? () => {
          if (placed) {
            commands.go({
              place: "day",
              sub: face.ref.day,
              open: placed.id,
              words: { invitation: placed.id },
            });
          } else {
            pending.current = { ...face, invitation: { ...props, chosenCalendarId: target?.id } };
            commands.go({ place: "day", sub: face.ref.day, open: face.id, words: { invitation: face.id } });
          }
        }
      : undefined;
  const removeRecord = view.hidden ? undefined : view.cancelled ? record : view.declinedCopy;
  const remove =
    removeRecord && !gone && port !== NONE
      ? async () => {
          try {
            await commitAction(
              port,
              {
                kind: "calendar_event_delete",
                eventId: removeRecord.id,
                base: removeRecord.updatedAt,
                localOnly: true,
                scope: removeRecord.recurrenceId
                  ? { kind: "occurrence", at: removeRecord.recurrenceId }
                  : { kind: "record" },
                ...(invitation.method === "CANCEL" && { cancelledBy: message.id }),
              },
              [],
              locale,
              eventText,
              report,
              () => live.current,
              () => setGone(true),
            );
          } catch {
            if (live.current) report(eventText("refusal.unknown"));
          }
        }
      : undefined;

  const add = async () => {
    if (request.current) return;
    request.current = true;
    try {
      await save();
    } finally {
      request.current = false;
    }
  };
  return { send, open, remove, add, gone, answer: confirmed ?? view.answer };
}

function LetterCard(props: LetterCardProps) {
  const { invitation, from, port } = props;
  const view = useLetterView(props);
  const { current, record, calendar, target, cancelled, conflicts, previous, mailAnswer, text } = view;
  // A letter that carries no event of its own (an Outlook Web App link) shows its calendar event's title and place.
  const eventOnly = props.when === null && current && record ? record : null;
  const title = eventOnly?.title || props.title;
  const place = props.place ?? eventOnly?.place ?? null;
  const { send, open, remove, add, gone, answer } = useLetterActions(props, view);
  const calendarText = useText("calendar");
  return (
    <InvitationCard
      kind={text(cancelled ? "cancelled" : invitation.sequence > 0 || previous ? "changed" : "invitation")}
      title={title}
      when={view.when ?? ""}
      was={previous ?? undefined}
      lines={[...(place ? [place] : []), ...(from ? [text("from", { organizer: from })] : [])]}
      around={conflicts}
      answers={
        remove ? (
          <Button kind="two" size="s" onPress={() => void remove()}>
            {calendarText(cancelled ? "actions.removeFromCalendar" : "actions.removeDeclined")}
          </Button>
        ) : !cancelled && mailAnswer ? (
          <>
            <AnswerChoices on="sheet" answer={answer ?? "none"} onAnswer={(value) => void send(value)} />
            {!record && target && props.copyable && (answer === "accepted" || answer === "tentative") && (
              <Button kind="quiet" size="s" onPress={() => void add()}>
                {text("add")}
              </Button>
            )}
          </>
        ) : undefined
      }
      goes={
        !gone && current && calendar ? (
          <>
            {text("on", { title, calendar: calendar.name })}
            <Dot kind="ink" />
          </>
        ) : !cancelled && !record && target && answer !== "declined" ? (
          <>
            {text.rich("goes", {
              title: title.split(",")[0]!,
              calendar: () => <InvitationCalendarSlot view={view} />,
            })}
            <Dot kind="hot" />
          </>
        ) : (
          text("notOn")
        )
      }
      show={port !== NONE && open ? { label: text("show"), onPress: open } : undefined}
    />
  );
}

function InvitationCalendarSlot({ view }: { view: LetterView }) {
  const [anchor, show] = useState<HTMLElement | null>(null);
  const t = useText("calendar");
  const { target, calendars, choose, sources } = view;
  if (!target) return null;
  return (
    <>
      <Slot expanded={!!anchor} onPress={(event) => show(event.currentTarget)}>
        {target.name}
      </Slot>
      {anchor && (
        <Menu open anchor={anchor} label={t("create.calendar")} onClose={() => show(null)}>
          {calendars.map((calendar) => (
            <MenuItem
              key={calendar.id}
              checked={calendar.id === target.id}
              leading={<CalendarSquare tone={sources.tones.get(calendar.id) ?? "neutral"} />}
              onPress={() => {
                choose(calendar.id);
                show(null);
              }}
            >
              {calendar.name}
            </MenuItem>
          ))}
        </Menu>
      )}
    </>
  );
}

export interface PendingInvitationDetails {
  rows: EventCardRow[];
  answers: ReactNode;
}

export function PendingInvitationControls({
  invitation,
  render,
}: {
  invitation: InvitationLetterProps;
  render: (details: PendingInvitationDetails) => ReactNode;
}) {
  const { host, commands } = useFrame();
  const t = useText("calendar");
  const text = useText("readerInvitation");
  const props = { ...invitation, port: host.wires.calendar };
  const view = useLetterView(props);
  const { send, answer } = useLetterActions(props, view);
  const rows: EventCardRow[] = [];
  if (view.target)
    rows.push({ label: text("destination"), children: <InvitationCalendarSlot view={view} /> });
  if (invitation.from) rows.push({ label: t("edit.from"), text: invitation.from });
  rows.push({
    label: t("actions.openLetter"),
    children: (
      <Button
        kind="quiet"
        size="s"
        onPress={() => commands.go({ place: "ohbox", open: invitation.message.id })}
      >
        {invitation.message.subject}
      </Button>
    ),
  });
  return render({
    rows,
    answers:
      view.mailAnswer && !view.cancelled ? (
        <AnswerChoices on="sheet" answer={answer ?? "none"} onAnswer={(value) => void send(value)} />
      ) : null,
  });
}

async function fileInvitation(
  port: CalendarPort,
  props: InvitationLetterProps,
  calendarId: string | undefined,
  record?: CalendarEventRecord,
) {
  const fields = personalFields(props);
  const id = props.invitation.calendarEventId;
  if (!fields || !id) return false;
  if (
    record &&
    sameTime(record.start, fields.start) &&
    record.end &&
    sameTime(record.end, fields.end) &&
    record.title === fields.title &&
    record.place === fields.place
  )
    return true;
  const result = record
    ? await pressAndHear(port, {
        kind: "calendar_event_update",
        eventId: record.id,
        base: record.updatedAt,
        scope: { kind: "record" },
        change: { start: fields.start, end: fields.end, place: fields.place, title: fields.title },
      })
    : calendarId
      ? await pressAndHear(port, {
          kind: "calendar_event_create",
          eventId: id,
          calendarId,
          event: fields,
          invitationMessageId: props.message.id,
        })
      : null;
  return result?.verdict?.kind === "taken";
}
