/**
 * THE CALENDAR'S BODY: the one mounted body of all six views. It reads the port the host hands in and the records the
 * engine holds on every version, derives the occurrences of the span the view on screen shows, and hands the view
 * their faces. It keeps no list: what is drawn is worked out again from the mirror whenever the mirror moves.
 *
 * A host whose port is `none` gets one line that says the calendar cannot be read here; nothing is guessed.
 */
import { useState } from "react";
import { useKeyBindings } from "@ohmail/app-logic/keys";
import { RefusalLine } from "@ohmail/ui/base";
import { CalendarHead, ViewSwitch } from "@ohmail/ui/calendar";
import {
  addDays,
  isoOfDay,
  monthName,
  monthOfDay,
  readerZones,
  yearOf,
  type CalendarPort,
  type HeldEdge,
  type PlainDate,
  type RangeActs,
  type RangeInput,
} from "@ohmail/app-logic/calendar";
import { ProductSwitch } from "../frame/ProductSwitch.js";
import { useFrame } from "../frame/commands.js";
import type { CalendarPlaceId, FrameCommands, LayoutPlan, PaneProps, Route } from "../frame/contract.js";
import { NONE } from "../host/index.js";
import { useLocale, useText, useTimeZone } from "../text/index.js";
import { dayView } from "../day/index.js";
import { weekView } from "../week/index.js";
import { MonthView } from "../month/index.js";
import { YearView } from "../year/index.js";
import { AgendaView } from "../agenda/index.js";
import { SearchView } from "../calsearch/index.js";
import { VIEWS, isView, useFaces, useSettings, useSources, useWhere, type Where } from "./where.js";
import { useNewEvent } from "./use-new-event.js";
import { DRAFT_EVENT } from "./event-draft.js";
import type { CalendarEventFace } from "./faces.js";
import type { CalendarViewProps } from "./view.js";
import { NewEvent } from "./NewEvent.js";
import { OpenEvent } from "./OpenEvent.js";
import "./placement.css";

export function CalendarBody(pane: PaneProps) {
  const { host, commands } = useFrame();
  const t = useText("calendar");
  const port = host.wires.calendar;
  const create = useNewEvent();
  useKeyBindings(
    port !== NONE && pane.keysHere && pane.route.open === null && pane.route.words.panel !== "new"
      ? [
          ...(create
            ? [{ chord: "c", group: "navigate" as const, label: t("create.title"), run: create }]
            : []),
          {
            chord: "/",
            group: "navigate",
            label: t("search"),
            run: () => commands.go({ place: "calsearch" }),
          },
        ]
      : [],
    "global",
  );
  if (port === NONE) return <RefusalLine>{t("unreadable")}</RefusalLine>;
  return <CalendarOn port={port} {...pane} />;
}

/** The anchor a step before or after shows: a day, a week, a month or a year. */
function shifted(place: CalendarPlaceId, anchor: string, n: number): string {
  if (place === "month") return `${monthOfDay(addDays(`${monthOfDay(anchor)}-15`, n * 30))}-01`;
  if (place === "year") return `${Number(yearOf(anchor)) + n}${anchor.slice(4)}`;
  return addDays(anchor, n * (place === "day" ? 1 : 7));
}

interface HeadProps {
  readonly where: Where;
  readonly route: Route;
  readonly plan: LayoutPlan;
  readonly panelOn: boolean;
  readonly go: (to: Partial<Route> & { place: CalendarPlaceId }) => void;
  readonly commands: FrameCommands;
}

/** The head over every view: the span's name, before and after, today, the views, Search and the Agenda's panel. */
function BodyHead({ where, route, plan, panelOn, go, commands }: HeadProps) {
  const t = useText("calendar");
  const locale = useLocale();
  const { place, anchor, today, span } = where;
  const stepped = place === "day" || place === "week" || place === "month" || place === "year";
  const title =
    place === "calsearch"
      ? t("search")
      : place === "year"
        ? yearOf(anchor)
        : monthName(monthOfDay(anchor), locale, yearOf(today));
  return (
    <CalendarHead
      switcher={plan.rail === "dock" ? <ProductSwitch kind="round" /> : undefined}
      title={title}
      hot={span.first <= today && today <= span.last}
      {...(stepped
        ? {
            before: { label: t("before"), onPress: () => go({ place, sub: shifted(place, anchor, -1) }) },
            after: { label: t("after"), onPress: () => go({ place, sub: shifted(place, anchor, 1) }) },
          }
        : {})}
      today={{ label: t("today"), onPress: () => go({ place, sub: null }) }}
      away={anchor !== today}
      views={
        <ViewSwitch
          label={t("views")}
          views={VIEWS.map((v) => ({ value: v, label: t(`view.${v}`) }))}
          value={isView(place) ? place : null}
          compact={plan.device === "phone"}
          onChange={(v) => go({ place: v, sub: route.sub })}
        />
      }
      search={{ label: t("search"), onPress: () => commands.go({ place: "calsearch" }) }}
      {...(plan.device === "phone"
        ? {}
        : {
            agenda: {
              label: t("agenda"),
              on: panelOn,
              onPress: () =>
                commands.go({
                  place,
                  sub: route.sub,
                  open: route.open,
                  words: panelOn ? {} : { panel: "agenda" },
                }),
            },
          })}
    />
  );
}

function CalendarOn({ port, route, plan }: PaneProps & { readonly port: CalendarPort }) {
  const { host, commands } = useFrame();
  const t = useText("calendar");
  const zone = useTimeZone();
  const zones = readerZones();
  const settings = useSettings(port);
  const where = useWhere(port, route, settings, zone, zones);
  const [preview, setPreview] = useState<CalendarEventFace | null>(null);
  const panelOn = route.words.panel === "agenda" && plan.device !== "phone";
  const sources = useSources(port);
  const found = useFaces(port, sources, where?.span ?? null, where?.today ?? null, zone, zones);
  /* The Agenda beside a view lists its own days, never only the view's. */
  const beside = useFaces(
    port,
    sources,
    panelOn && where?.place !== "agenda" ? (where?.agenda ?? null) : null,
    where?.today ?? null,
    zone,
    zones,
  );
  if (where === null || found === null) return <RefusalLine>{t("noZone")}</RefusalLine>;

  const { place, anchor, anchorDay, today, now, nowMs, agenda } = where;
  const go = (to: Partial<Route> & { place: CalendarPlaceId }) =>
    commands.go({ words: route.words.panel ? { panel: route.words.panel } : {}, ...to });
  /* The invitations' panel is registered by its own feature; the body only stands it beside the view. */
  const entry = host.features.calendar;
  const Invitations = entry === NONE ? NONE : entry.panels.invitations;
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
  const timeProps = {
    anchor: anchorDay,
    events,
    capped: found.capped,
    edge,
    openId: route.open,
    clock: { zone, zones, nowMs },
    settings,
    plan,
    panel: panelOn,
    onOpen: open,
    onDay: (day: PlainDate) => go({ place: "day", sub: isoOfDay(day) }),
  };
  const opened =
    route.open === null
      ? undefined
      : (found.events.find((event) => event.id === route.open) ??
        beside?.events.find((event) => event.id === route.open));

  return (
    <section className="cal-body" aria-label={t("landmark")}>
      <BodyHead where={where} route={route} plan={plan} panelOn={panelOn} go={go} commands={commands} />
      <div className="cal-body-views">
        <div className="cal-body-view">
          <CurrentView
            where={where}
            route={route}
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
          {opened ? <OpenEvent key={opened.id} event={opened} zones={zones} today={today} /> : null}
        </div>
        {route.words.panel === "invitations" && Invitations !== NONE ? (
          <Invitations route={route} plan={plan} keysHere={false} onClose={closePanel} />
        ) : null}
        {panelOn && place !== "agenda" ? (
          <aside className="cal-body-panel" aria-label={t("agenda")}>
            <AgendaView
              input={beside === null ? input : { ...input, events: beside.events }}
              acts={acts}
              edge={beside === null ? edge : { ...beside.edge, load: port.load }}
              from={agenda.first}
              days={agenda.days}
              onMore={agenda.more}
            />
          </aside>
        ) : null}
      </div>
    </section>
  );
}

function CurrentView({
  where,
  route,
  timeProps,
  input,
  acts,
  edge,
}: {
  readonly where: Where;
  readonly route: Route;
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
    <MonthView input={input} acts={acts} edge={edge} />
  ) : place === "year" ? (
    <YearView input={input} acts={acts} edge={edge} />
  ) : place === "agenda" ? (
    <AgendaView input={input} acts={acts} edge={edge} days={agenda.days} onMore={agenda.more} />
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
