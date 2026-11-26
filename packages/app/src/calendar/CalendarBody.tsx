import { useRef, useState } from "react";
import { RefusalLine } from "@ohmail/ui/base";
import { ListLine } from "@ohmail/ui/mail";
import { readerZones, type CalendarPort } from "@ohmail/app-logic/calendar";
import { useInvitationAnswer } from "../invitations/EventAnswers.js";
import { useAgendaPanel } from "./use-agenda-panel.js";
import { useEventBrowse } from "./use-event-browse.js";
import { useGridKeys } from "./use-grid-keys.js";
import { CurrentView } from "./CalendarCurrentView.js";
import { CalendarFrameHead } from "./CalendarFrameHead.js";
import { useCompactInvitation } from "./compact-invitation.js";
import { CalendarPanels } from "./CalendarPanels.js";
import { useCalendarInvitation, useFrame } from "../frame/commands.js";
import type { PaneProps } from "../frame/contract.js";
import { NONE } from "../host/index.js";
import { useText, useTimeZone } from "../text/index.js";
import { useMonthViewport } from "../month/MonthRunScope.js";
import type { MonthRun } from "../month/use-month-run.js";
import { useFaces, useSettings, useSources, useWhere, type Where } from "./where.js";
import { useSharedCalendarSettings } from "../calsettings/settings-read.js";
import {
  CalendarFirstStep,
  CalendarLanding,
  useCalendarFirstStep,
  useCalendarLoading,
} from "./CalendarFirstStep.js";
import { useNewEvent, useNewEventKey } from "./use-new-event.js";
import { NewEvent } from "./NewEvent.js";
import { OpenEvent } from "./OpenEvent.js";
import { EventActionQuestion } from "./EventActionQuestion.js";
import { RecoveredProposals } from "./RecoveredProposals.js";
import { ProposalQuestion } from "./use-event-proposals.js";
import { openFace } from "./canvas-gestures.js";
import { useCalendarCanvas } from "./use-calendar-canvas.js";
import { useTodayPulse, type TodayVisit } from "./use-today-pulse.js";
import { CalendarMenus } from "./CalendarMenus.js";
import { useCalendarConnectionNotice } from "./connection-notice.js";
import "./placement.css";
export function CalendarBody(pane: PaneProps) {
  const { host } = useFrame();
  const t = useText("calendar");
  const port = host.wires.calendar;
  const sources = useSources(port);
  const empty = useCalendarFirstStep();
  const loading = useCalendarLoading();
  const disabled = useSharedCalendarSettings()?.said?.enabledAt === null;
  const firstStep = empty || disabled;
  useCalendarConnectionNotice(sources, !firstStep && !loading);
  const create = useNewEvent();
  useNewEventKey(
    create,
    !firstStep && !loading && pane.keysHere && pane.route.open === null && pane.route.words.panel !== "new",
  );
  if (port === NONE)
    return (
      <CalendarLanding plan={pane.plan}>
        <RefusalLine>{t("unreadable")}</RefusalLine>
      </CalendarLanding>
    );
  if (firstStep)
    return (
      <CalendarFirstStep
        plan={pane.plan}
        recovery={port.recoveredProposals && <RecoveredProposals port={port} />}
      />
    );
  if (loading)
    return (
      <CalendarLanding plan={pane.plan}>
        <ListLine busy>{t("loading")}</ListLine>
      </CalendarLanding>
    );
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
  const agendaPanel = useAgendaPanel(route, plan);
  const panelOn = agendaPanel.visible;
  const where = useWhere(port, route, settings, zone, zones, panelOn);
  const [todayVisit, setTodayVisit] = useState<TodayVisit | null>(null);
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
  if (where === null || found === null)
    return (
      <CalendarLanding plan={plan}>
        <RefusalLine>{t("noZone")}</RefusalLine>
      </CalendarLanding>
    );

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
      agendaPanel={agendaPanel}
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

export interface CalendarSurfaceProps extends Pick<PaneProps, "route" | "plan" | "keysHere"> {
  port: CalendarPort;
  zone: string;
  zones: ReturnType<typeof readerZones>;
  settings: ReturnType<typeof useSettings>;
  where: Where;
  sources: ReturnType<typeof useSources>;
  found: NonNullable<ReturnType<typeof useFaces>>;
  beside: ReturnType<typeof useFaces>;
  agendaPanel: ReturnType<typeof useAgendaPanel>;
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
    agendaPanel,
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
  const canvas = useCalendarCanvas(props, commands, selected);
  const { actions, input, edge, go } = canvas;
  const compact = useCompactInvitation(
    insideSheet ? selected : undefined,
    found.events,
    zones,
    port,
    actions,
  );
  return (
    <section ref={body} tabIndex={-1} className="cal-body" aria-label={t("landmark")}>
      {opened && !actions.proposal.draft && plan.device === "phone" && (
        <div className="cal-event-backdrop" aria-hidden onClick={() => commands.event(null)} />
      )}
      <CalendarFrameHead
        {...{ where, route, plan, agendaPanel, go, commands, keysHere, settings, port, monthRun, onToday }}
      />
      {port.recoveredProposals && <RecoveredProposals port={port} />}
      <CalendarMenus
        {...{ actions, reply, zones, editNext }}
        dragging={canvas.dragging}
        events={found.events}
        beside={beside?.events ?? []}
        onAgendaRow={openAgendaRow}
        fallback={body}
        create={props.create}
        onDay={(day) => go({ place: "day", sub: day })}
      >
        <div className="cal-body-views">
          <div ref={view} className="cal-body-view" onClickCapture={canvas.canvasClick}>
            <CurrentView
              key={monthRun ? undefined : todayVisit?.id}
              where={where}
              monthRun={monthRun}
              route={route}
              keysHere={keysHere}
              timeProps={canvas.timeProps}
              input={input}
              acts={canvas.acts}
              edge={edge}
            />
            {canvas.rangePreview}
            {route.words.panel === "new" && (
              <NewEvent
                port={port}
                onPreview={canvas.setPreview}
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
              acts={canvas.acts}
              edge={beside ? { ...beside.edge, load: port.load, provider: edge.provider } : edge}
              agendaPanel={agendaPanel}
              onClose={canvas.closePanel}
              onAgendaRow={openAgendaRow}
              compact={compact}
            />
          )}
        </div>
      </CalendarMenus>
    </section>
  );
}
