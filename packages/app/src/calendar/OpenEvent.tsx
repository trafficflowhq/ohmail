import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import {
  type CalendarEventRecord,
  type CalendarPort,
  type CalendarRecord,
  type ZoneSource,
} from "@ohmail/app-logic/calendar";
import { Button, Icon } from "@ohmail/ui/base";
import {
  AnswerSwitch,
  EventCard,
  type AnswerSwitchProps,
  type EventCardRow,
  type EventCardProps,
} from "@ohmail/ui/calendar";
import type { PanelVerb } from "@ohmail/ui/mail";
import { EventAnswers, type InvitationActions } from "../invitations/EventAnswers.js";
import { NONE, type HostContract } from "../host/index.js";
import { useFrame } from "../frame/commands.js";
import { useLocale, useText, useTimeZone, type Text } from "../text/index.js";
import { useCalendarOwnAddresses } from "./own-addresses.js";
import { useDraftRestore } from "./draft-undo.js";
import type { EventDraft } from "./event-draft.js";
import { EditEvent } from "./EditEvent.js";
import {
  eventDetails,
  eventTags,
  eventTimeRestriction,
  renderCardFoot,
  useOpenEventPlacement,
} from "./event-card-details.js";
import { editableEvent, eventOwned, eventMoveOptions, removableEvent } from "./editable-event.js";
import { useEventCall } from "./event-call.js";
import type { CalendarEventFace } from "./faces.js";
import type { EventActions } from "./use-event-actions.js";
import { useMaps } from "./use-place-suggestions.js";
import { useEventCardActions } from "./use-event-card-actions.js";
import { useEventLetters } from "./use-event-letters.js";
import { useReadCardActions } from "./read-card-actions.js";
import { overlapTags } from "./overlap-tags.js";
import { proposalDetails } from "./proposal-card.js";
import { calendarInterval } from "./event-words.js";
import { PendingInvitationControls, type PendingInvitationDetails } from "../reader/InvitationLetterCard.js";
function useEventCardRows(
  event: CalendarEventFace,
  host: HostContract,
  t: Text,
  letters: ReturnType<typeof useEventLetters>["links"],
): EventCardRow[] {
  const locale = useLocale();
  const own = useCalendarOwnAddresses();
  const rows = rowsOf(event, host, t, locale, own);
  if (letters.length) {
    rows.push({
      label: t("letters", { count: letters.length }),
      children: letters.map((letter) => (
        <Button key={letter.id} kind="quiet" size="s" onPress={letter.open}>
          {letter.subject || t("actions.openLetter")}
        </Button>
      )),
    });
  }
  return rows;
}

function rowsOf(
  event: CalendarEventFace,
  host: HostContract,
  t: Text,
  locale: string,
  own: readonly string[] | null,
): EventCardRow[] {
  const port = host.wires.calendar;
  const stored = port === NONE ? undefined : port.events().find(({ record }) => record.id === event.recordId);
  const calendar =
    stored &&
    host.engine.store
      .entries<CalendarRecord | null>("calendar")
      .find(({ entity }) => entity?.id === stored.record.calendarId)?.entity;
  const rows: EventCardRow[] = [];
  if (calendar) {
    rows.push({
      label: t("create.calendar"),
      tone: event.tone,
      text: calendar.name,
      children: event.viewOnly ? <Icon name="lock" size={16} className="oh-ecard-lock" /> : null,
    });
  }
  if (calendar?.access === "busy" || !stored) return rows;
  rows.push(...eventDetails(stored.record, own, t, locale));
  return rows;
}
interface OpenEventProps {
  readonly event: CalendarEventFace;
  readonly events?: readonly CalendarEventFace[];
  readonly zones: ZoneSource;
  readonly today: string;
  readonly actions: EventActions;
  readonly editNext?: RefObject<string | null>;
  readonly reply?: InvitationActions;
}

export function OpenEvent(props: OpenEventProps) {
  const invitation = props.event.invitation;
  return invitation ? (
    <PendingInvitationControls
      invitation={invitation}
      render={(pending) => <OpenEventCard {...props} pending={pending} />}
    />
  ) : (
    <OpenEventCard {...props} />
  );
}
function OpenEventCard({
  event,
  events,
  zones,
  today,
  actions,
  editNext,
  reply,
  pending,
}: OpenEventProps & { pending?: PendingInvitationDetails }) {
  const { plan, commands, host } = useFrame();
  const port = host.wires.calendar;
  const t = useText("calendar");
  const { known, allowed, current } = useStoredEdit(event);
  const { removal, removalQuestion, ...readActions } = useReadCardActions(
    port,
    event,
    current,
    events !== undefined,
  );
  const invited = !!pending || invitationOf(port, event, known);
  const call = useEventCall(event);
  const { letters, links } = useEventLetters(event);
  const rows = useEventCardRows(event, host, t, links);
  const proposal = proposalDetails(actions, event, letters, today, current !== null, t);
  if (proposal.row) rows.push(proposal.row);
  if (call) rows.push({ label: call.label, call });
  if (pending) rows.push(...pending.rows);
  const restriction = !current && !pending && eventTimeRestriction(event, invited, t);
  if (restriction) rows.push(restriction);
  const maps = useMaps(event.second ?? null);
  const { editing, begin, end, beforeRestore } = useEventEditor(event, port, allowed, editNext);
  const locale = useLocale();
  const zone = useTimeZone();
  const { card, seat, bridge, finish } = useOpenEventPlacement(
    event,
    plan.device === "phone",
    invited,
    editing?.revision,
    end,
  );
  const when = calendarInterval(event, zone, zones, today, locale, t);
  const edit = current ? { label: t("edit.action"), onPress: begin } : null;
  const { blocked, onKeyDown, panel, toolbar, menu, items } = useEventCardActions({
    event,
    actions,
    edit,
    remove: event.state === "off" ? undefined : removal,
    invited,
    ...readActions,
    join: call?.join,
    removable: port !== NONE ? removableEvent(host, port, event, known, zones) : null,
    ...eventMoveOptions(host, current),
  });
  if (editing && editing.port === port && editing.engine === host.engine && current) {
    return (
      <>
        <EditEvent
          card={card}
          placement={seat?.card}
          scopeAnchor={seat?.anchor}
          key={editing.revision}
          beforeRestore={beforeRestore}
          port={editing.port}
          actionItems={items}
          provider={current.connection?.provider}
          original={editing.record}
          exception={editing.exception}
          allowed={allowed}
          calendar={current.calendar}
          face={event}
          when={when}
          today={today}
          recovered={editing.draft}
          finish={finish}
        />
        {bridge}
        {menu}
      </>
    );
  }
  return (
    <>
      <EventCard
        ref={card}
        {...seat?.card}
        frame={plan.device === "phone" ? "sheet" : "card"}
        neutralHead={invited && plan.device !== "phone"}
        onKeyDown={onKeyDown}
        keyShortcuts={
          edit && event.start.kind === "date" && event.end.kind === "date"
            ? "Alt+Shift+ArrowLeft Alt+Shift+ArrowRight Control+Alt+Shift+ArrowLeft Control+Alt+Shift+ArrowRight"
            : undefined
        }
        answers={
          pending?.answers ??
          proposal.answers ??
          renderEventAnswers(port, event, t, removal, reply, proposal.propose)
        }
        {...(edit && !blocked ? { edit } : {})}
        foot={renderCardFoot(edit, panel, blocked)}
        {...readCardDetails(event, { when, rows, maps, invited, canEdit: current !== null }, t)}
        tags={[...proposal.tags, ...eventTags(event, t), ...overlapTags(event, events ?? [], zone, zones, t)]}
        close={{ label: t("closeEvent"), onPress: () => commands.event(null) }}
      />
      {plan.device !== "phone" && toolbar && (
        <div className="cal-event-panel" data-call={call ? "" : undefined} onKeyDown={onKeyDown}>
          {toolbar}
        </div>
      )}
      {bridge}
      {menu}
      {removalQuestion}
    </>
  );
}

function useStoredEdit(event: CalendarEventFace) {
  const { host } = useFrame();
  const port = host.wires.calendar;
  const known = useCalendarOwnAddresses();
  const allowed = useCallback(
    () => (port === NONE || event.viewOnly ? null : editableEvent(host, port, event, known)),
    [port, event, host, known],
  );
  return { known, allowed, current: allowed() };
}

function renderEventAnswers(
  port: CalendarPort | typeof NONE,
  event: CalendarEventFace,
  t: Text,
  removal: PanelVerb | undefined,
  reply?: InvitationActions,
  propose?: AnswerSwitchProps["propose"],
) {
  if (removal && event.state === "off") {
    return (
      <AnswerSwitch
        label={t("actions.panel")}
        on="sheet"
        acts={[
          {
            id: removal.id,
            label: removal.label,
            primary: true,
            onPress: (e) => removal.onPress?.(e.currentTarget),
          },
        ]}
      />
    );
  }
  return port !== NONE && !event.viewOnly && reply ? (
    <EventAnswers key={event.id} reply={reply} event={event} propose={propose} />
  ) : null;
}

function readCardDetails(
  event: CalendarEventFace,
  {
    when,
    rows,
    maps,
    invited,
    canEdit,
  }: {
    when: string;
    rows: EventCardRow[];
    maps: ReturnType<typeof useMaps>;
    invited: boolean;
    canEdit: boolean;
  },
  t: Text,
): Pick<EventCardProps, "title" | "when" | "tone" | "why" | "rows" | "status" | "where" | "notes"> {
  return {
    title: event.title,
    when,
    tone: event.tone,
    rows,
    why: event.viewOnly
      ? { text: t("edit.readOnlyCalendar"), locked: true }
      : invited && !canEdit
        ? { text: t("edit.invited") }
        : undefined,
    where: event.second ? [{ text: event.second, maps }] : undefined,
    notes: event.notes ?? undefined,
    status: event.conflict ? undefined : (event.status ?? undefined),
  };
}

function invitationOf(
  port: CalendarPort | typeof NONE,
  event: CalendarEventFace,
  own: readonly string[] | null,
) {
  if (port === NONE || event.state === "off") return false;
  const record = port.events().find(({ record }) => record.id === event.recordId)?.record;
  return !!record?.organizer && record.myAnswer !== null && !eventOwned(record, own);
}

function useEventEditor(
  event: CalendarEventFace,
  port: CalendarPort | typeof NONE,
  allowed: () => ReturnType<typeof editableEvent>,
  editNext: RefObject<string | null> | undefined,
) {
  const { host } = useFrame();
  const available = allowed() !== null;
  const beforeRestore = useRef<(() => void) | null>(null);
  const revision = useRef(0);
  const [editing, setEditing] = useState<{
    port: CalendarPort;
    engine: typeof host.engine;
    record: CalendarEventRecord;
    exception: CalendarEventRecord | null;
    draft?: EventDraft;
    revision: number;
  } | null>(null);
  useEffect(() => {
    setEditing((was) => (was && available && was.port === port && was.engine === host.engine ? was : null));
  }, [available, port, host.engine]);
  useDraftRestore("edit", port, ({ draft, original }) => {
    const current = allowed();
    if (port !== NONE && original.id === event.recordId && current) {
      beforeRestore.current?.();
      setEditing({
        port,
        engine: host.engine,
        record: current.exception ? current.record : original,
        exception: current.exception ? original : null,
        draft,
        revision: ++revision.current,
      });
    }
  });
  const begin = useCallback(() => {
    const present = allowed();
    if (port !== NONE && present)
      setEditing({
        port,
        engine: host.engine,
        record: present.record,
        exception: present.exception,
        revision: ++revision.current,
      });
  }, [allowed, port, host.engine]);
  useLayoutEffect(() => {
    if (editNext?.current !== event.id) return;
    editNext.current = null;
    begin();
  }, [editNext, event.id, begin]);
  return { editing, begin, end: () => setEditing(null), beforeRestore };
}
