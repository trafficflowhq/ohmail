import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Button, Dot, Menu, MenuItem, RefusalLine, Slot } from "@ohmail/ui/base";
import { CalendarSquare, InvitationCard, type EventCardRow } from "@ohmail/ui/calendar";
import type { CalendarPort } from "@ohmail/app-logic/calendar";
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
import { useLetterView, withLetterAnswer, type LetterView } from "./invitation-letter-view.js";
import type { CalendarEventFace } from "../calendar/faces.js";
import { useInvitationFiling } from "./use-invitation-filing.js";

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
export function InvitationLetterCard(props: InvitationLetterProps) {
  const { host } = useFrame();
  return <LetterCard {...props} port={host.wires.calendar} />;
}

type LetterCardProps = InvitationLetterProps & { port: CalendarPort | typeof NONE };

function unavailableCalendar(port: LetterCardProps["port"], ready: boolean, canFile: boolean) {
  if (port === NONE) return "calendarDisabled";
  if (!ready) return "calendarRequired";
  return canFile ? null : "detailsUnavailable";
}

function useLetterActions(props: LetterCardProps, view: LetterView) {
  const { invitation, port } = props;
  const { alreadyOnCalendar, record, target, face, placed, text } = view;
  const { commands } = useFrame();
  const pending = useCalendarInvitation();
  const provider = useInvitationAnswer(port);
  const [confirmed, setConfirmed] = useState<InvitationAnswer | null>(null);
  const [replyNotice, setReplyNotice] = useState<string | null>(null);
  const request = useRef(false);
  const live = useRef(false);
  useLayoutEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  useLayoutEffect(() => setConfirmed(null), [invitation.answeredAt]);

  const providerCopy = record && !view.personal && view.current ? provider.invitation(record.id) : null;
  const answer = confirmed ?? (providerCopy ? view.answer : (view.copy?.mailAnswer ?? invitation.answer));
  const { canFile, maySave, failed, waiting, save } = useInvitationFiling(props, answer, port, view, live);
  const mayAdd = !providerCopy && answer !== null && !waiting && maySave;
  const connect =
    !target && !alreadyOnCalendar && !providerCopy && port !== NONE
      ? () => commands.go({ place: "calsettings", sub: "calaccounts" })
      : undefined;
  const ready = !connect;

  const send = async (value: InvitationAnswer) => {
    if (view.cancelled || !ready || waiting || request.current) return;
    request.current = true;
    setReplyNotice(null);
    try {
      if (providerCopy) {
        await provider.answer(providerCopy.id, value);
        return;
      }
      const result = await props.reply(
        { answer: value, basis: confirmed ?? invitation.answer },
        crypto.randomUUID(),
      );
      if (result.status !== "sent" && result.status !== "already") {
        if (live.current)
          setReplyNotice(text(result.status === "unverified" ? "answerUnverified" : "answerPending"));
        return;
      }
      if (live.current) setConfirmed(value);
      if (canFile) await save(value);
    } catch {
      if (live.current) setReplyNotice(text("answerUnverified"));
    } finally {
      request.current = false;
    }
  };
  const unavailableKey = providerCopy || alreadyOnCalendar ? null : unavailableCalendar(port, ready, canFile);
  const unavailable = unavailableKey && text(unavailableKey);
  const existingCopy = !!view.copy && !view.copy.uid.startsWith("pending:");
  const couldNotFile =
    ready && !providerCopy && !canFile && answer !== null && (!existingCopy || confirmed !== null);
  const reason = failed ?? (couldNotFile ? unavailable : null);
  const notice =
    replyNotice ??
    (reason ? text(existingCopy ? "calendarUpdateRefused" : "calendarRefused", { reason }) : null);
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
            pending.current = {
              ...withLetterAnswer(face, answer),
              invitation: { ...props, chosenCalendarId: target?.id },
            };
            commands.go({ place: "day", sub: face.ref.day, open: face.id, words: { invitation: face.id } });
          }
        }
      : undefined;
  const { remove, gone } = useLetterRemoval(props, view, live);

  const add = async () => {
    if (!mayAdd || answer === null || request.current) return;
    request.current = true;
    try {
      await save(answer, true);
    } finally {
      request.current = false;
    }
  };
  return {
    send,
    mayAnswerThroughProvider: !!providerCopy,
    open,
    remove,
    add,
    gone,
    answer,
    ready,
    canFile,
    mayAdd,
    connect,
    notice,
    waiting,
    unavailable: !connect && reason && !replyNotice ? null : unavailable,
    addLabel: text(existingCopy ? "retryUpdate" : "add"),
  };
}

function useLetterRemoval(props: LetterCardProps, view: LetterView, live: { current: boolean }) {
  const { invitation, message, port } = props;
  const { record, locale } = view;
  const report = useReport();
  const eventText = useText("event");
  const [gone, setGone] = useState(false);
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

  return { remove, gone };
}

function LetterCard(props: LetterCardProps) {
  const { invitation, from, port } = props;
  const view = useLetterView(props);
  const { current, record, calendar, target, cancelled, conflicts, previous, text } = view;
  // A letter that carries no event of its own (an Outlook Web App link) shows its calendar event's title and place.
  const eventOnly = props.when === null && current && record ? record : null;
  const title = eventOnly?.title || props.title;
  const place = props.place ?? eventOnly?.place ?? null;
  const actions = useLetterActions(props, view);
  const { open, remove, gone, answer, waiting } = actions;
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
        <>
          {(!remove || !actions.mayAnswerThroughProvider) && <LetterAnswers view={view} actions={actions} />}
          {remove && (
            <Button kind="two" size="s" onPress={() => void remove()}>
              {calendarText(cancelled ? "actions.removeFromCalendar" : "actions.removeDeclined")}
            </Button>
          )}
        </>
      }
      goes={
        waiting ? (
          text("calendarPending")
        ) : !gone && current && calendar && !view.copy?.uid.startsWith("pending:") ? (
          <>
            {text("on", { title, calendar: calendar.name })}
            <Dot kind="ink" />
          </>
        ) : !cancelled && !record && actions.canFile && target && answer !== "declined" ? (
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

function LetterAnswers({
  view,
  actions,
}: {
  view: LetterView;
  actions: ReturnType<typeof useLetterActions>;
}) {
  if (view.cancelled || !view.mailAnswer) return null;
  const { text } = view;
  const { send, add, addLabel, answer, ready, mayAdd, connect, unavailable, notice, waiting } = actions;
  return (
    <>
      {unavailable && (
        <RefusalLine start way={connect && { label: text("connect"), onPress: connect }}>
          {unavailable}
        </RefusalLine>
      )}
      {notice && (
        <RefusalLine start alert>
          {notice}
        </RefusalLine>
      )}
      {(ready || answer !== null) && (
        <AnswerChoices
          on="sheet"
          answer={answer ?? "none"}
          readOnly={!ready || waiting}
          onAnswer={(value) => void send(value)}
        />
      )}
      {mayAdd && (
        <Button kind="quiet" size="s" onPress={() => void add()}>
          {addLabel}
        </Button>
      )}
    </>
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
  event: CalendarEventFace | null;
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
  const actions = useLetterActions(props, view);
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
    event: view.placed || (view.face && withLetterAnswer(view.face, actions.answer)),
    rows,
    answers: <LetterAnswers view={view} actions={actions} />,
  });
}
