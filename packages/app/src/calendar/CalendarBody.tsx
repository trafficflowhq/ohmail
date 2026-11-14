/**
 * THE CALENDAR'S BODY: the one mounted body of all six views. It reads the port the host hands in and the records the
 * engine holds on every version, derives the occurrences of the span the view on screen shows, and hands the view
 * their faces. It keeps no list: what is drawn is worked out again from the mirror whenever the mirror moves.
 *
 * A host whose port is `none` gets one line that says the calendar cannot be read here; nothing is guessed.
 */
import { useState } from "react";
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
import { CalendarFrameHead } from "./CalendarFrameHead.js";
import { useFrame } from "../frame/commands.js";
import type { CalendarPlaceId, FrameCommands, PaneProps, Route } from "../frame/contract.js";
import { NONE } from "../host/index.js";
import { useText, useTimeZone } from "../text/index.js";
import { dayView } from "../day/index.js";
import { weekView } from "../week/index.js";
import { MonthView } from "../month/index.js";
import { useMonthViewport } from "../month/MonthRunScope.js";
import type { MonthRun } from "../month/use-month-run.js";
import { YearView } from "../year/index.js";
import { AgendaView } from "../agenda/index.js";
import { SearchView } from "../calsearch/index.js";
import { useFaces, useSettings, useSources, useWhere, type Where } from "./where.js";
import { useNewEvent } from "./use-new-event.js";
import { DRAFT_EVENT } from "./event-draft.js";
import type { CalendarEventFace } from "./faces.js";
import type { CalendarViewProps } from "./view.js";
import { NewEvent } from "./NewEvent.js";
import { OpenEvent } from "./OpenEvent.js";
import { EventActionQuestion } from "./EventActionQuestion.js";
import { useEventActions } from "./use-event-actions.js";
import { useEventDrag } from "./use-event-drag.js";
import "./placement.css";

export function CalendarBody(pane: PaneProps) {
  const { host } = useFrame();
  const t = useText("calendar");
  const port = host.wires.calendar;
  const create = useNewEvent();
  useKeyBindings(
    create && port !== NONE && pane.keysHere && pane.route.open === null && pane.route.words.panel !== "new"
      ? [{ chord: "c", group: "navigate", label: t("create.title"), run: create }]
      : [],
    "global",
  );
  if (port === NONE) return <RefusalLine>{t("unreadable")}</RefusalLine>;
  return <CalendarOn port={port} {...pane} />;
}

function CalendarOn({ port, route, plan, keysHere }: PaneProps & { readonly port: CalendarPort }) {
  const { commands } = useFrame();
  const t = useText("calendar");
  const zone = useTimeZone();
  const zones = readerZones();
  const settings = useSettings(port);
  const where = useWhere(port, route, settings, zone, zones);
  const [todayVisit, setTodayVisit] = useState(0);
  const panelOn = route.words.panel === "agenda" && plan.device !== "phone";
  const monthRun = useMonthViewport();
  const sources = useSources(port);
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
      onToday={() => {
        if (!monthRun) setTodayVisit((visit) => visit + 1);
      }}
      cursor={cursor}
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
  todayVisit: number;
  onToday: () => void;
  cursor: number | null;
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
  const { anchor, today, now } = where;
  const { actions, suppressClick, setPreview, go, closePanel, edge, input, acts, timeProps } =
    useCalendarCanvas(props, commands);
  const opened =
    route.open === null
      ? undefined
      : (found.events.find((event) => event.id === route.open) ??
        beside?.events.find((event) => event.id === route.open));

  return (
    <section className="cal-body" aria-label={t("landmark")}>
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
        <div className="cal-body-view" onClickCapture={suppressClick}>
          <CurrentView
            key={todayVisit}
            where={where}
            monthRun={monthRun}
            route={route}
            keysHere={keysHere}
            timeProps={timeProps}
            input={input}
            acts={acts}
            edge={edge}
          />
          {route.words.panel === "new" && (
            <NewEvent
              port={port}
              onPreview={setPreview}
              anchor={anchor}
              today={today}
              minute={now.minutes}
              calendars={sources.calendars}
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
  { route, port, zones, where, found, zone, settings, plan, panelOn, cursor }: CalendarSurfaceProps,
  commands: FrameCommands,
) {
  const actions = useEventActions(port, zones);
  const { drag, preview: dragged, suppressClick } = useEventDrag(actions, fragmentOf(route));
  const [preview, setPreview] = useState<CalendarEventFace | null>(null);
  const { place, anchor, anchorDay, today, now, nowMs } = where;
  const go = (to: Partial<Route> & { place: CalendarPlaceId }) =>
    commands.go({ words: route.words.panel ? { panel: route.words.panel } : {}, ...to });
  const closePanel = () => commands.go({ place, sub: route.sub, open: route.open, words: {} });
  const edge: HeldEdge = { ...found.edge, load: port.load };
  const events = route.words.panel === "new" && preview ? [...found.events, preview] : found.events;
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
    route.open === null && route.words.panel !== "new"
      ? (id, press) => {
          const face = found.events.find((event) => event.id === id);
          if (face) drag(face, press);
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
    ...(onDrag ? { onDrag } : {}),
    ...(dragged ? { dragPreview: dragged } : {}),
    onDay: (day: PlainDate) => go({ place: "day", sub: isoOfDay(day) }),
  };
  return { actions, suppressClick, setPreview, go, closePanel, edge, input, acts, timeProps };
}

function CalendarPanels({
  where,
  route,
  plan,
  keysHere,
  input,
  acts,
  edge,
  onClose,
  onAgendaRow,
}: PaneProps & {
  where: Where;
  input: RangeInput;
  acts: RangeActs;
  edge: HeldEdge;
  onClose: () => void;
  onAgendaRow: (id: string, day: string) => void;
}) {
  const entry = useFrame().host.features.calendar;
  const Invitations = entry === NONE ? NONE : entry.panels.invitations;
  if (route.words.panel === "invitations" && Invitations !== NONE) {
    return <Invitations route={route} plan={plan} keysHere={false} onClose={onClose} />;
  }
  if (route.words.panel !== "agenda" || plan.device === "phone" || where.place === "agenda") return null;
  return (
    <div className="cal-body-panel">
      <AgendaView
        input={input}
        acts={acts}
        edge={edge}
        from={where.agenda.first}
        days={where.agenda.days}
        onMore={where.agenda.more}
        onClose={onClose}
        onRow={onAgendaRow}
        keysHere={keysHere && route.open === null}
      />
    </div>
  );
}

function CurrentView({
  where,
  monthRun,
  route,
  keysHere,
  timeProps,
  input,
  acts,
  edge,
}: {
  readonly where: Where;
  readonly monthRun: MonthRun | null;
  readonly route: Route;
  readonly keysHere: boolean;
  readonly timeProps: CalendarViewProps;
  readonly input: RangeInput;
  readonly acts: RangeActs;
  readonly edge: HeldEdge;
}) {
  const { place, agenda, span } = where;
  const { commands } = useFrame();
  const t = useText("calendar");
  return place === "week" ? (
    <weekView.View {...timeProps} />
  ) : place === "day" ? (
    <dayView.View {...timeProps} />
  ) : place === "month" ? (
    <MonthView
      input={input}
      acts={acts}
      edge={edge}
      run={monthRun}
      {...(timeProps.onDrag ? { onDrag: timeProps.onDrag } : {})}
    />
  ) : place === "year" ? (
    <YearView input={input} acts={acts} edge={edge} />
  ) : place === "agenda" ? (
    <AgendaView
      input={input}
      acts={acts}
      edge={edge}
      days={agenda.days}
      onMore={agenda.more}
      keysHere={keysHere && route.open === null}
    />
  ) : place === "calsearch" ? (
    <SearchView
      input={input}
      acts={acts}
      query={route.words.q ?? ""}
      onQuery={(q) => commands.go({ place: "calsearch", words: q === "" ? {} : { q } })}
      held={{ from: span.first, to: span.last }}
    />
  ) : (
    <RefusalLine>{t("notHere")}</RefusalLine>
  );
}
