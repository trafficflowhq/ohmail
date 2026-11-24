import { useRef, useState } from "react";
import { useKeyBindings } from "@ohmail/app-logic/keys";
import { RefusalLine } from "@ohmail/ui/base";
import {
  addDays,
  clockOf,
  isoOfDay,
  readerZones,
  type CalendarPort,
  type HeldEdge,
  type PlainDate,
  type RangeActs,
  type RangeInput,
} from "@ohmail/app-logic/calendar";
import { newEventsCalendarOf } from "@ohmail/app-logic/calendar/setup";
import { EventChip } from "@ohmail/ui/calendar";
import { useInvitationAnswer } from "../invitations/EventAnswers.js";
import { fragmentOf } from "../frame/route.js";
import { useEventBrowse } from "./use-event-browse.js";
import { useGridKeys } from "./use-grid-keys.js";
import { CurrentView } from "./CalendarCurrentView.js";
import { CalendarFrameHead } from "./CalendarFrameHead.js";
import { useCompactInvitation } from "./compact-invitation.js";
import { CalendarPanels } from "./CalendarPanels.js";
import { useCalendarInvitation, useFrame } from "../frame/commands.js";
import type { CalendarPlaceId, FrameCommands, PaneProps, Route } from "../frame/contract.js";
import { NONE } from "../host/index.js";
import { useText, useTimeZone } from "../text/index.js";
import { useMonthViewport } from "../month/MonthRunScope.js";
import type { MonthRun } from "../month/use-month-run.js";
import { useFaces, useSettings, useSources, useWhere, type Where } from "./where.js";
import { useSharedCalendarSettings } from "../calsettings/settings-read.js";
import { CalendarFirstStep, useCalendarFirstStep } from "./CalendarFirstStep.js";
import { useNewEvent, useNewEventKey } from "./use-new-event.js";
import { useSlotDraft } from "./use-slot-draft.js";
import { DRAFT_EVENT, draftCalendars } from "./event-draft.js";
import type { CalendarViewProps } from "./view.js";
import { NewEvent, type DraftPreview } from "./NewEvent.js";
import type { CalendarEventFace } from "./faces.js";
import { OpenEvent } from "./OpenEvent.js";
import { EventActionQuestion } from "./EventActionQuestion.js";
import { useEventActions } from "./use-event-actions.js";
import { PROPOSAL_DRAFT, ProposalQuestion } from "./use-event-proposals.js";
import { useEventLetters } from "./use-event-letters.js";
import { useEventDrag } from "./use-event-drag.js";
import {
  calendarDragHandler,
  calendarResizeHandler,
  canvasClickHandler,
  openFace,
} from "./canvas-gestures.js";
import { useTodayPulse, type TodayVisit } from "./use-today-pulse.js";
import { WeekMenus } from "./use-event-card-actions.js";
import { useCalendarConnectionNotice } from "./connection-notice.js";
import "./placement.css";
export function CalendarBody(pane: PaneProps) {
  const { host } = useFrame();
  const t = useText("calendar");
  const port = host.wires.calendar;
  const sources = useSources(port);
  const empty = useCalendarFirstStep();
  const disabled = useSharedCalendarSettings()?.said?.enabledAt === null;
  const firstStep = empty || disabled;
  useCalendarConnectionNotice(sources, !firstStep);
  const create = useNewEvent();
  useNewEventKey(
    create,
    !firstStep && pane.keysHere && pane.route.open === null && pane.route.words.panel !== "new",
  );
  if (port === NONE) return <RefusalLine>{t("unreadable")}</RefusalLine>;
  if (firstStep) return <CalendarFirstStep />;
  return <CalendarOn port={port} sources={sources} create={create} {...pane} />;
}
function CalendarOn({
  port,
  route,
  plan,
  keysHere,
  sources,
  create,
}: PaneProps & {
  readonly port: CalendarPort;
  readonly sources: ReturnType<typeof useSources>;
  readonly create: ReturnType<typeof useNewEvent>;
}) {
  const { commands } = useFrame();
  const t = useText("calendar");
  const zone = useTimeZone();
  const zones = readerZones();
  const settings = useSettings(port);
  const where = useWhere(port, route, settings, zone, zones);
  const [todayVisit, setTodayVisit] = useState<TodayVisit | null>(null);
  const panelOn = route.words.panel === "agenda" && plan.device !== "phone";
  const monthRun = useMonthViewport();
  const found = useFaces(port, sources, monthRun ?? where?.span ?? null, where?.today ?? null, zone, zones);
  const beside = useFaces(
    port,
    sources,
    panelOn && where?.place !== "agenda" ? (where?.agenda ?? null) : null,
    where?.today ?? null,
    zone,
    zones,
  );
  const openAgendaRow = useEventBrowse({
    where,
    route,
    keysHere,
    zone,
    zones,
    events: (panelOn ? beside : found)?.events ?? [],
    panelOn,
  });
  const cursor = useGridKeys({
    create,
    where,
    events: found?.events ?? [],
    route,
    keysHere,
    zone,
    zones,
    open: commands.event,
  });
  if (where === null || found === null) return <RefusalLine>{t("noZone")}</RefusalLine>;

  return (
    <CalendarSurface
      route={route}
      plan={plan}
      port={port}
      zone={zone}
      zones={zones}
      settings={settings}
      where={where}
      sources={sources}
      found={found}
      beside={beside}
      panelOn={panelOn}
      keysHere={keysHere}
      monthRun={monthRun}
      todayVisit={todayVisit}
      onToday={(top) => {
        setTodayVisit((visit) => ({ id: (visit?.id ?? 0) + 1, place: where.place, top }));
      }}
      cursor={cursor}
      create={create}
      openAgendaRow={openAgendaRow}
    />
  );
}

interface CalendarSurfaceProps extends Pick<PaneProps, "route" | "plan" | "keysHere"> {
  port: CalendarPort;
  zone: string;
  zones: ReturnType<typeof readerZones>;
  settings: ReturnType<typeof useSettings>;
  where: Where;
  sources: ReturnType<typeof useSources>;
  found: NonNullable<ReturnType<typeof useFaces>>;
  beside: ReturnType<typeof useFaces>;
  panelOn: boolean;
  monthRun: MonthRun | null;
  todayVisit: TodayVisit | null;
  onToday: (top: number | undefined) => void;
  cursor: number | null;
  create: ReturnType<typeof useNewEvent>;
  openAgendaRow: (id: string, day: string) => void;
}

function CalendarSurface(props: CalendarSurfaceProps) {
  const {
    route,
    plan,
    keysHere,
    port,
    zones,
    settings,
    where,
    sources,
    found,
    beside,
    panelOn,
    monthRun,
    todayVisit,
    onToday,
    openAgendaRow,
  } = props;
  const { commands } = useFrame();
  const t = useText("calendar");
  const { anchor, today, now, place } = where;
  const editNext = useRef<string | null>(null);
  const reply = useInvitationAnswer(port);
  const body = useRef<HTMLElement>(null);
  const view = useRef<HTMLDivElement>(null);
  const pulse = anchor === today && todayVisit?.place === place ? todayVisit : null;
  useTodayPulse(body, view, pulse, monthRun?.scrollRef);
  const invitation = useCalendarInvitation().current;
  const selected = openFace(route, found.events, beside?.events, invitation);
  const insideSheet =
    plan.device === "phone" && route.words.panel === "invitations" && selected !== invitation;
  const opened = insideSheet ? undefined : selected;
  const { actions, canvasClick, setPreview, rangePreview, go, closePanel, edge, input, acts, timeProps } =
    useCalendarCanvas(props, commands, selected);
  const compact = useCompactInvitation(
    insideSheet ? selected : undefined,
    found.events,
    zones,
    port,
    actions,
  );
  return (
    <section ref={body} className="cal-body" aria-label={t("landmark")}>
      {opened && !actions.proposal.draft && plan.device === "phone" && (
        <div className="cal-event-backdrop" aria-hidden onClick={() => commands.event(null)} />
      )}
      <CalendarFrameHead
        where={where}
        route={route}
        plan={plan}
        panelOn={panelOn}
        go={go}
        commands={commands}
        keysHere={keysHere}
        settings={settings}
        port={port}
        monthRun={monthRun}
        onToday={onToday}
      />
      <div className="cal-body-views">
        <div ref={view} className="cal-body-view" onClickCapture={canvasClick}>
          <WeekMenus
            {...{ actions, reply, zones, editNext }}
            events={found.events}
            create={props.create}
            onDay={(day) => go({ place: "day", sub: day })}
          >
            <CurrentView
              key={monthRun ? undefined : todayVisit?.id}
              where={where}
              monthRun={monthRun}
              route={route}
              keysHere={keysHere}
              timeProps={timeProps}
              input={input}
              acts={acts}
              edge={edge}
            />
          </WeekMenus>
          {rangePreview}
          {route.words.panel === "new" && (
            <NewEvent
              port={port}
              onPreview={setPreview}
              now={now}
              calendars={sources.calendars}
              tones={sources.tones}
              connections={sources.connections}
              preferred={settings.newEventsCalendarId}
            />
          )}
          {opened && !actions.proposal.draft && (
            <OpenEvent
              key={opened.id}
              {...{ event: opened, events: found.events, zones, today, actions, editNext, reply }}
            />
          )}
          <EventActionQuestion actions={actions} />
          <ProposalQuestion proposal={actions.proposal} today={today} zones={zones} />
        </div>
        {insideSheet && actions.proposal.draft ? null : (
          <CalendarPanels
            where={where}
            route={route}
            plan={plan}
            keysHere={keysHere}
            input={beside ? { ...input, events: beside.events } : input}
            acts={acts}
            edge={beside ? { ...beside.edge, load: port.load, provider: edge.provider } : edge}
            onClose={closePanel}
            onAgendaRow={openAgendaRow}
            compact={compact}
          />
        )}
      </div>
    </section>
  );
}
function useCalendarCanvas(
  props: CalendarSurfaceProps,
  commands: FrameCommands,
  opened: CalendarEventFace | undefined,
) {
  const { host } = useFrame();
  const { route, port, zones, where, found, zone } = props;
  const { settings, plan, panelOn, cursor, create, sources } = props;
  const { current: invitation } = useCalendarInvitation();
  const actions = useEventActions(port, zones);
  const { startSlot, preview: slot } = useSlotDraft(
    !actions.proposal.draft && route.open === null && route.words.panel !== "new" ? create : null,
    fragmentOf(route),
  );
  const { drag, preview: dragged, suppressClick, rangePreview } = useEventDrag(actions, fragmentOf(route));
  const canvasClick = canvasClickHandler(
    !actions.proposal.draft && route.open !== null,
    () => commands.event(null),
    suppressClick,
  );
  const [preview, setPreview] = useState<DraftPreview | null>(null);
  const { place, anchor, anchorDay, today, now, nowMs } = where;
  const go = (to: Partial<Route> & { place: CalendarPlaceId }) =>
    commands.go({ words: route.words.panel ? { panel: route.words.panel } : {}, ...to });
  const closePanel = () => commands.go({ place, sub: route.sub, open: route.open, words: {} });
  const shown = sources.calendars.filter((calendar) => calendar.shown);
  const edge: HeldEdge = {
    ...found.edge,
    load: port.load,
    provider:
      shown.length > 0 &&
      shown.every((calendar) => sources.connections.get(calendar.connectionId)?.provider === "microsoft")
        ? "microsoft"
        : undefined,
  };
  const extra =
    actions.proposal.preview(opened, useEventLetters(opened).letters) ??
    (route.words.panel === "new" ? preview?.face : null);
  const events = extra || invitation ? [...found.events, ...(extra ? [extra] : [])] : found.events;
  if (invitation?.id === route.words.invitation && invitation) events.push(invitation);
  const open: FrameCommands["event"] = (ref) => {
    if (ref && [DRAFT_EVENT, PROPOSAL_DRAFT].includes(ref.event)) return;
    commands.event(ref);
  };
  const input: RangeInput = {
    events,
    anchor,
    today,
    nowMinute: now.minutes,
    zone,
    zones,
    weekStart: settings.weekStart,
    weekNumbers: settings.weekNumbers,
    open: route.open,
    device: plan.device,
  };
  const acts: RangeActs = {
    event: (e) => open(e === null ? null : e.ref),
    pick: (day) => go({ place, sub: day }),
    view: (view, day) => go({ place: view, sub: day }),
    reveal: (e) => go({ place: "week", sub: e.ref.day, open: e.id }),
  };
  const onDrag = calendarDragHandler(actions, drag, route.words.panel === "new", preview, found.events);
  const target =
    slot &&
    newEventsCalendarOf(
      settings.newEventsCalendarId ?? null,
      draftCalendars(sources.calendars, sources.connections),
    );
  const dragPreview = slot
    ? {
        day: slot.day,
        chip: (
          <EventChip
            size="block"
            state="draft"
            drag="copy"
            title={`${clockOf(slot.from)}–${clockOf(slot.to % (24 * 60))}`}
            tone={target ? (sources.tones.get(target.id) ?? "neutral") : null}
            place={{ top: slot.from * slot.scale, height: (slot.to - slot.from) * slot.scale }}
          />
        ),
      }
    : dragged;
  const timeProps: CalendarViewProps = {
    anchor: anchorDay,
    events,
    capped: found.capped,
    edge,
    openId: route.open,
    revealOpen:
      route.open !== null &&
      (route.open === route.words.invitation ||
        (plan.device === "phone" && route.words.panel === "invitations")),
    clock: { zone, zones, nowMs },
    settings,
    plan,
    fixedHourHeight: host.device.build.surface === "phone" && plan.device === "phone",
    panel: panelOn,
    cursor,
    stepDay:
      plan.device === "phone" && route.words.panel !== "new"
        ? (direction: -1 | 1) => go({ place, sub: addDays(anchor, direction) })
        : undefined,
    onOpen: open,
    onSlot: startSlot,
    onResizeTime:
      onDrag && route.words.panel !== "new" ? calendarResizeHandler(actions, found.events) : undefined,
    onDrag,
    dragPreview: dragPreview ?? undefined,
    onDay: (day: PlainDate) => go({ place: "day", sub: isoOfDay(day) }),
  };
  return { actions, canvasClick, setPreview, rangePreview, go, closePanel, edge, input, acts, timeProps };
}
