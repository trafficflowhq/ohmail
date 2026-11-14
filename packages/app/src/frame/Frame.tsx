/**
 * THE FRAME: the rail, the columns or the wide pane, the stage, the one notice slot, the one report slot and
 * the connection states, laid out by one plan from the window. It imports no feature: the places it draws are
 * the host's registrations. It asks for no setting: everything comes from the host contract. Everything under
 * it is mounted again when the host's scope changes.
 *
 * Under the scope the order is: the root, the room, what the host stands above every pane (`features.above`), then
 * everything the root holds. Nothing above the columns is mounted or unmounted by a place change; only another scope
 * mounts it again, and under a scope the frame refuses none of it mounts.
 */
import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentType,
  type ReactNode,
} from "react";
import { EngineContext } from "@ohmail/app-logic/engine";
import { SYNC_SETTLED } from "@ohmail/app-logic/session/sync-scheduler";
import { NONE, type LinkedDraft, type None, type ReaderEntry } from "../host/index.js";
import { FrameContext, NO_CONNECTION, type ConnectionFeed, type FrameInner } from "./commands.js";
import {
  PLACE_IDS,
  type CalendarEntry,
  type ColumnsProps,
  type EventRef,
  type FrameApi,
  type FrameCommands,
  type FrameHost,
  type FramePlaces,
  type LayoutPlan,
  type PaneProps,
  type PlaceEntry,
  type RailModel,
  type Route,
  type RouteTarget,
} from "./contract.js";
import { createFeed, useSignal } from "./feeds.js";
import { FrameParts } from "./FrameParts.js";
import { FrameRoot } from "./FrameRoot.js";
import { layoutPlan } from "./layout-plan.js";
import { createNoticeStore } from "./notice-store.js";
import { RoomGate } from "./room.js";
import { useReportSlot } from "./report-slot.js";
import { attributesOf } from "./root-attributes.js";
import { CALENDAR_HOME, MAIL_HOME, eventRefString, isCalendarPlace, productOf } from "./product.js";
import { fragmentOf, routeOf } from "./route.js";
import { Scoped } from "./scope.js";
import "./placement.css";
import "./seam.generated.css";

const sameReason = (a: ConnectionFeed["reason"], b: ConnectionFeed["reason"]) =>
  a === b || (!!a && !!b && a.title === b.title && a.line === b.line && a.href === b.href);
const sameFeed = (a: ConnectionFeed, b: ConnectionFeed) =>
  a.mail === b.mail &&
  a.online === b.online &&
  a.setupHref === b.setupHref &&
  a.follow === b.follow &&
  sameReason(a.reason, b.reason);

/** The route the address names now: the shell's address door is the one copy. */
function useRoute(host: FrameHost): Route {
  const address = host.device.address;
  const fragment = useSyncExternalStore(address.subscribe, address.read, address.read);
  return useMemo(() => routeOf(fragment), [fragment]);
}

/** The calendar's entry where this host offers the switch between the two products, else null. */
function calendarOf(host: FrameHost): CalendarEntry | null {
  const entry = host.features.calendar;
  return host.capabilities.products === "both" && entry !== NONE ? entry : null;
}

const HOME: Route = { place: MAIL_HOME, sub: null, open: null, stage: null, words: {} };

function useCommands(host: FrameHost, route: Route, draft: { current: LinkedDraft | null }) {
  const [railOpen, setRailOpen] = useState(false);
  const [held, setHeld] = useState(false);
  const now = useRef(route);
  now.current = route;
  /* The place the calendar's side was last in: an event opened from mail goes there. Kept for the frame's life only. */
  const lastCalendar = useRef<Route | null>(null);
  if (isCalendarPlace(route.place) && route.stage === null) lastCalendar.current = route;
  const go = useCallback(
    (to: RouteTarget) => {
      const next: Route = { sub: null, open: null, stage: null, words: {}, ...to };
      host.device.address.write(fragmentOf(next), "push");
      setRailOpen(false);
    },
    [host],
  );
  /* One object while the host stands: a feature that keeps a command in an effect's list is not run again for it. */
  const commands: FrameCommands = useMemo(
    () => ({
      go,
      open: (letter: string | null) =>
        host.device.address.write(fragmentOf({ ...now.current, open: letter }), "push"),
      write: (letter?: LinkedDraft) => {
        draft.current = letter ?? null;
        go({ place: "write" });
      },
      rail: setRailOpen,
      hold: setHeld,
      event: (ref: EventRef | null) => {
        if (calendarOf(host) === null) return;
        const here = now.current;
        if (ref === null) {
          if (isCalendarPlace(here.place))
            host.device.address.write(fragmentOf({ ...here, open: null }), "push");
          return;
        }
        const open = eventRefString(ref);
        if (isCalendarPlace(here.place)) {
          host.device.address.write(fragmentOf({ ...here, open }), "push");
          return;
        }
        const there = lastCalendar.current ?? { ...HOME, place: CALENDAR_HOME };
        go({ place: there.place, sub: ref.day, open, words: there.words });
      },
    }),
    [go, host, draft],
  );
  return { commands, railOpen, setRailOpen, held };
}

/** The body a host's places keep, with the pane that draws it: the first entry whose wide arm says `kept`. */
interface KeptBody {
  readonly body: string;
  readonly Wide: ComponentType<PaneProps>;
}
function keptOf(places: FramePlaces): KeptBody | null {
  for (const id of PLACE_IDS) {
    const entry = places[id];
    if (entry !== NONE && entry.panes.kind === "wide" && entry.panes.kept === true)
      return { body: entry.body, Wide: entry.panes.Wide };
  }
  return null;
}

/** The reading column stands over the list while a letter is open, or always where the place holds it. */
function holdsItsReading(entry: PlaceEntry | null): boolean {
  return entry !== null && entry.panes.kind === "columns" && entry.panes.holds === "always";
}

/**
 * A place's panes, or the shared body they name: one mounted instance per body. The kept body's pane is answered
 * whether it is on screen or not, always under the same key, so that the columns draw it at one position; while it is
 * on screen no pane of the place is answered (the place is of that body, or a part of the shell asked for it).
 */
function panesOf(
  entry: PlaceEntry | null,
  pane: PaneProps,
  reading: boolean,
  reader: ReaderEntry | None,
  kept: KeptBody | null,
  keptShown: boolean,
): Pick<ColumnsProps, "list" | "reading" | "wide" | "kept" | "above"> {
  /* A place of the kept body draws it with its own pane: every place of one body shares the one mounted instance. */
  const Kept =
    kept === null
      ? null
      : entry !== null && entry.body === kept.body && entry.panes.kind === "wide"
        ? entry.panes.Wide
        : kept.Wide;
  const keptPane =
    kept === null || Kept === null
      ? null
      : { pane: <Kept key={kept.body} {...pane} keysHere={keptShown} />, shown: keptShown };
  if (!entry || keptShown) return { list: null, reading: null, wide: null, kept: keptPane, above: null };
  const panes = entry.panes;
  if (panes.kind === "wide")
    return {
      list: null,
      reading: null,
      wide: <panes.Wide key={entry.body} {...pane} keysHere />,
      kept: keptPane,
      above: null,
    };
  const Reading = panes.Reading;
  /* A place that holds its reading column gives it the keys whatever is open. */
  const holds = panes.holds === "always";
  const readingKeys = holds || pane.route.open !== null;
  return {
    list: <panes.List key={entry.body} {...pane} keysHere={!holds && pane.route.open === null} />,
    /* A place that names the reader gets the shell's reading column; with none handed, the column stays empty. */
    reading: !reading ? null : Reading !== "reader" ? (
      <Reading {...pane} keysHere={readingKeys} />
    ) : reader === NONE ? null : (
      <reader.Reading {...pane} keysHere={readingKeys} />
    ),
    wide: null,
    kept: keptPane,
    above: panes.Above ? { Above: panes.Above, body: entry.body } : null,
  };
}

/**
 * The room's press seam runs only where the reader is drawn, or a place's own column asks for it and a reader is
 * handed: never beside the old shell's own.
 */
function drawsTheReader(entry: PlaceEntry | null, reader: ReaderEntry | None): boolean {
  return (
    reader !== NONE &&
    entry !== null &&
    entry.panes.kind === "columns" &&
    (entry.panes.Reading === "reader" || entry.panes.room === true)
  );
}

function FrameBody({ host }: { host: FrameHost }) {
  const facts = useSignal(host.device.window);
  const look = useSignal(host.device.appearance);
  const plan: LayoutPlan = useMemo(() => layoutPlan(facts), [facts]);
  const attributes = useMemo(() => attributesOf(plan, look, facts), [plan, look, facts]);
  const addressed = useRoute(host);
  const calendar = calendarOf(host);
  /* A calendar address where the switch is absent folds back to mail's home: the bar is replaced, and mail's home is
     drawn meanwhile, never a blank frame. */
  const folded =
    calendar === null && (isCalendarPlace(addressed.place) || addressed.stage?.id === "calSetup");
  const route = folded ? HOME : addressed;
  useEffect(() => {
    if (folded) host.device.address.write(fragmentOf(HOME), "replace");
  }, [folded, host]);
  const slot = useReportSlot();
  const [inner] = useState(() => ({
    notices: createNoticeStore(),
    rail: createFeed<RailModel | null>(null),
    connection: createFeed<ConnectionFeed>(NO_CONNECTION, sameFeed),
    draft: { current: null as LinkedDraft | null },
    bars: createFeed<readonly string[]>([]),
    keeps: createFeed<readonly string[]>([]),
  }));
  const { commands, railOpen, setRailOpen, held } = useCommands(host, route, inner.draft);
  const api: FrameApi = useMemo(
    () => ({ host, route, plan, commands, report: slot.report, product: productOf(route.place) }),
    [host, route, plan, commands, slot.report],
  );
  const context: FrameInner = useMemo(
    () => ({ ...inner, api, railOpen: [railOpen, setRailOpen] as const }),
    [inner, api, railOpen, setRailOpen],
  );
  const places = host.features.places;

  const place = isCalendarPlace(route.place) ? (calendar?.places[route.place] ?? NONE) : places[route.place];
  const entry = place === NONE ? null : place;
  const stageEntry = !route.stage
    ? NONE
    : route.stage.id === "calSetup"
      ? (calendar?.stage ?? NONE)
      : host.features.stages[route.stage.id];
  const staged = stageEntry !== NONE;
  const pane: PaneProps = { route, plan, keysHere: !staged };
  /* The body the places keep is on screen where the place is of that body, or while a part of the shell says so. */
  const keptBody = useMemo(() => keptOf(places), [places]);
  const keptOver = useSignal(inner.keeps).length > 0;
  const keptShown = keptBody !== null && (keptOver || entry?.body === keptBody.body);
  const readingShown = plan.columns === 2 || route.open !== null || holdsItsReading(entry);
  const panes = panesOf(entry, pane, readingShown, host.features.reader, keptBody, keptShown);
  /* Never while the kept body is on screen: no reading column is drawn then. */
  const room = !keptShown && drawsTheReader(entry, host.features.reader);
  const parts = (
    <FrameParts
      host={host}
      inner={inner}
      plan={plan}
      route={route}
      commands={commands}
      slot={slot}
      panes={panes}
      pane={pane}
      stage={stageEntry}
      railOpen={railOpen}
      held={held}
      holds={holdsItsReading(entry)}
    />
  );
  const Above = host.features.above;

  return (
    <FrameContext.Provider value={context}>
      <FrameRoot attributes={attributes} held={held || staged}>
        <RoomGate on={room} own={Above === NONE}>
          {Above === NONE ? parts : <Above>{parts}</Above>}
        </RoomGate>
      </FrameRoot>
    </FrameContext.Provider>
  );
}

/**
 * The engine a place reads: the shell's provider where one stands above (it carries the sync loop's state), else
 * the host's own engine, settled, as over the fake host.
 */
function HostEngine({ host, children }: { host: FrameHost; children: ReactNode }) {
  const above = useContext(EngineContext);
  const own = useMemo(
    () => ({ engine: host.engine, demo: false, serverDemo: false, sync: SYNC_SETTLED }),
    [host.engine],
  );
  return above ? children : <EngineContext.Provider value={own}>{children}</EngineContext.Provider>;
}

/** The frame, mounted again whenever the host's scope changes. */
export function Frame({ host }: { host: FrameHost }) {
  return (
    <HostEngine host={host}>
      <Scoped scope={host.session.scope}>
        <FrameBody host={host} />
      </Scoped>
    </HostEngine>
  );
}
