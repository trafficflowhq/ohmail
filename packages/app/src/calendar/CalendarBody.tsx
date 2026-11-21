/**
 * THE CALENDAR'S BODY: the one mounted body of all six views. It reads the port the host hands in and the records the
 * engine holds on every version, derives the occurrences of the span the view on screen shows, and hands the view
 * their faces. It keeps no list: what is drawn is worked out again from the mirror whenever the mirror moves.
 *
 * A host whose port is `none` gets one line that says the calendar cannot be read here; nothing is guessed.
 */
import { useRef, useState } from "react";
import { useKeyBindings } from "@ohmail/app-logic/keys";
import { Notice, RefusalLine } from "@ohmail/ui/base";
import {
  addDays,
  isoOfDay,
  readerZones,
  type CalendarPort,
  type HeldEdge,
  type PlainDate,
  type RangeActs,
  type RangeInput,
} from "@ohmail/app-logic/calendar";
import { fragmentOf } from "../frame/route.js";
import { useEventBrowse } from "./use-event-browse.js";
import { useGridKeys } from "./use-grid-keys.js";
import { CurrentView } from "./CalendarCurrentView.js";
import { CalendarFrameHead } from "./CalendarFrameHead.js";
import { CalendarPanels } from "./CalendarPanels.js";
import { useFrame } from "../frame/commands.js";
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
import { DRAFT_EVENT } from "./event-draft.js";
import type { CalendarViewProps } from "./view.js";
import { NewEvent, type DraftPreview } from "./NewEvent.js";
import { OpenEvent } from "./OpenEvent.js";
import { EventActionQuestion } from "./EventActionQuestion.js";
import { useEventActions } from "./use-event-actions.js";
import { useEventDrag } from "./use-event-drag.js";
import { useTodayPulse, type TodayVisit } from "./use-today-pulse.js";
import "./placement.css";

export function CalendarBody(pane: PaneProps) {
  const { host } = useFrame();
  const t = useText("calendar");
  const port = host.wires.calendar;
  const sources = useSources(port);
  const empty = useCalendarFirstStep();
  const disabled = useSharedCalendarSettings()?.said?.enabledAt === null;
  const firstStep = empty || disabled;
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
  /* The Agenda beside a view lists its own days, never only the view's. */
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
  const body = useRef<HTMLElement>(null);
  const view = useRef<HTMLDivElement>(null);
  useTodayPulse(
    body,
    view,
    anchor === today && todayVisit?.place === place ? todayVisit : null,
    monthRun?.scrollRef,
  );
  const { actions, suppressClick, setPreview, rangePreview, go, closePanel, edge, input, acts, timeProps } =
    useCalendarCanvas(props, commands);
  const opened =
    route.open === null || route.words.panel === "new"
      ? undefined
      : (found.events.find((event) => event.id === route.open) ??
        beside?.events.find((event) => event.id === route.open));

  return (
    <section ref={body} className="cal-body" aria-label={t("landmark")}>
      {opened && plan.device === "phone" && (
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
      {port.hasOwedWrites?.() && <Notice place="bar" title={t("waiting.device")} />}
      <div className="cal-body-views">
        <div ref={view} className="cal-body-view" onClickCapture={suppressClick}>
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
          {opened && (
            <OpenEvent key={opened.id} event={opened} zones={zones} today={today} actions={actions} />
          )}
          <EventActionQuestion actions={actions} />
        </div>
        <CalendarPanels
          where={where}
          route={route}
          plan={plan}
          keysHere={keysHere}
          input={beside ? { ...input, events: beside.events } : input}
          acts={acts}
          edge={beside ? { ...beside.edge, load: port.load } : edge}
          onClose={closePanel}
          onAgendaRow={openAgendaRow}
        />
      </div>
    </section>
  );
}

function useCalendarCanvas(
  { route, port, zones, where, found, zone, settings, plan, panelOn, cursor, create }: CalendarSurfaceProps,
  commands: FrameCommands,
) {
  const actions = useEventActions(port, zones);
  const startSlot = useSlotDraft(
    route.open === null && route.words.panel !== "new" ? create : null,
    fragmentOf(route),
  );
  const { drag, preview: dragged, suppressClick, rangePreview } = useEventDrag(actions, fragmentOf(route));
  const [preview, setPreview] = useState<DraftPreview | null>(null);
  const { place, anchor, anchorDay, today, now, nowMs } = where;
  const go = (to: Partial<Route> & { place: CalendarPlaceId }) =>
    commands.go({ words: route.words.panel ? { panel: route.words.panel } : {}, ...to });
  const closePanel = () => commands.go({ place, sub: route.sub, open: route.open, words: {} });
  const edge: HeldEdge = { ...found.edge, load: port.load };
  const events = route.words.panel === "new" && preview ? [...found.events, preview.face] : found.events;
  const open: FrameCommands["event"] = (ref) => {
    if (ref?.event !== DRAFT_EVENT) commands.event(ref);
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
  const onDrag: CalendarViewProps["onDrag"] =
    !actions.busy && !actions.question
      ? (id, press, segment) => {
          if (route.words.panel === "new") {
            if (id === DRAFT_EVENT && preview?.face.start.kind === "date") {
              drag(preview.face, press, preview.moveRange);
            }
            return;
          }
          const face = found.events.find((event) => event.id === id);
          if (face && (route.open === null || route.open === face.id)) drag(face, press, undefined, segment);
        }
      : undefined;
  const timeProps: CalendarViewProps = {
    anchor: anchorDay,
    events,
    capped: found.capped,
    edge,
    openId: route.open,
    clock: { zone, zones, nowMs },
    settings,
    plan,
    panel: panelOn,
    cursor,
    stepDay:
      plan.device === "phone" && route.words.panel !== "new"
        ? (direction: -1 | 1) => go({ place, sub: addDays(anchor, direction) })
        : undefined,
    onOpen: open,
    onSlot: startSlot,
    onResizeTime:
      onDrag && route.words.panel !== "new"
        ? (id, edge, minutes, anchor) => {
            const face = found.events.find((event) => event.id === id);
            if (face) actions.start(face, { kind: "resize-time", edge, minutes }, anchor);
          }
        : undefined,
    ...(onDrag ? { onDrag } : {}),
    ...(dragged ? { dragPreview: dragged } : {}),
    onDay: (day: PlainDate) => go({ place: "day", sub: isoOfDay(day) }),
  };
  return { actions, suppressClick, setPreview, rangePreview, go, closePanel, edge, input, acts, timeProps };
}
