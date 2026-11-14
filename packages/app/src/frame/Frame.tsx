/**
 * THE FRAME: the rail, the columns or the wide pane, the stage, the one notice slot, the one report slot and
 * the connection states, laid out by one plan from the window. It imports no feature: the places it draws are
 * the host's registrations. It asks for no setting: everything comes from the host contract. Everything under
 * it is mounted again when the host's scope changes.
 *
 * Under the scope the order is: the key registry, the root, the room (with its own press seam where the host hands
 * a ground or a reader), what the host stands above every pane (`features.above`), then everything the root holds.
 * Nothing above the columns is mounted or unmounted by a place change; only another scope mounts it again, and
 * under a scope the frame refuses none of it mounts.
 */
import {
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { EngineContext } from "@ohmail/app-logic/engine";
import { FocusFollows, KeymapContext, useKeymapStore, ZoneCursor } from "@ohmail/app-logic/keys";
import { SYNC_SETTLED } from "@ohmail/app-logic/session/sync-scheduler";
import { goCompose } from "@ohmail/app-logic/writing/compose-door";
import { beginSwitch, placeSwitchKey } from "@ohmail/app-logic/session/ui-vitals";
import { NONE, type LinkedDraft } from "../host/index.js";
import {
  FrameContext,
  NO_CONNECTION,
  type ConnectionFeed,
  type EnteredTarget,
  type FrameInner,
} from "./commands.js";
import {
  type CalendarEntry,
  type EventRef,
  type FrameApi,
  type FrameCommands,
  type FrameHost,
  type GoHow,
  type LayoutPlan,
  type OverId,
  type PaneProps,
  type RailFootModel,
  type RailModel,
  type Route,
  type RouteTarget,
} from "./contract.js";
import { createFeed, useSignal, type Feed } from "./feeds.js";
import { FrameParts } from "./FrameParts.js";
import { FrameRoot } from "./FrameRoot.js";
import { layoutPlan } from "./layout-plan.js";
import { holdsItsReading, panesOf } from "./panes-of.js";
import { createNoticeStore } from "./notice-store.js";
import { createOfferStore } from "./offers.js";
import type { Dragging } from "./rail-drag.js";
import { RoomGate } from "./room.js";
import type { RoomSeam } from "./room-store.js";
import { useReportSlot } from "./report-slot.js";
import { attributesOf } from "./root-attributes.js";
import { CALENDAR_HOME, MAIL_HOME, eventRefString, isCalendarPlace, productOf } from "./product.js";
import { fragmentOf, routeOf } from "./route.js";
import { Scoped } from "./scope.js";
import { owedFeed, useStageEntry } from "./stage-entry.js";
import "../keys/touch-keys.css";
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

/** A place under its own word: what a kept letter is remembered by (a letter open under one tag is not another's). */
const spot = (at: Pick<Route, "place" | "sub">): string => `${at.place}/${at.sub ?? ""}`;

/** The calendar's entry where this host offers the switch between the two products, else null. */
function calendarOf(host: FrameHost): CalendarEntry | null {
  const entry = host.features.calendar;
  return host.capabilities.products === "both" && entry !== NONE ? entry : null;
}

const HOME: Route = { place: MAIL_HOME, sub: null, open: null, stage: null, words: {} };

function useCommands(
  host: FrameHost,
  route: Route,
  plan: LayoutPlan,
  draft: { current: LinkedDraft | null },
  entered: Feed<EnteredTarget | null>,
) {
  const [railOpen, setRailOpen] = useState(false);
  const [held, setHeld] = useState(false);
  const [over, setOver] = useState<OverId | null>(null);
  const now = useRef(route);
  now.current = route;
  const columns = useRef(plan.columns);
  columns.current = plan.columns;
  const places = host.features.places;
  const keeps = useCallback(
    (at: Route): boolean => {
      /* A letter is kept by a mail place alone: the calendar's side opens an event, which the address carries. */
      if (isCalendarPlace(at.place)) return false;
      const place = places[at.place];
      return place !== NONE && place.panes.kind === "columns" && place.panes.keepsOpen === true;
    },
    [places],
  );
  /* THE LETTERS THE PLACES KEEP (`keepsOpen`), for the frame's life: never stored, and gone with the scope. The
     address is the one copy of what is open, so while it stands at such a place the memory follows it: the letter it
     names, or none once that letter is closed, whichever way it was closed. */
  const kept = useRef(new Map<string, string>());
  if (keeps(route)) {
    if (route.open === null) kept.current.delete(spot(route));
    else kept.current.set(spot(route), route.open);
  }
  /* The place the calendar's side was last in: an event opened from mail goes there. Kept for the frame's life only. */
  const lastCalendar = useRef<Route | null>(null);
  const lastMail = useRef<Route>(HOME);
  if (route.stage === null) {
    if (isCalendarPlace(route.place)) lastCalendar.current = route;
    else lastMail.current = route;
  }
  const go = useCallback(
    function go(to: RouteTarget, how?: GoHow) {
      const next: Route = { sub: null, open: null, stage: null, words: {}, ...to };
      /* A way back that names no letter opens the one the place kept, where a column stands for it. */
      const again =
        to.open === undefined && next.stage === null && columns.current === 2 && keeps(next)
          ? kept.current.get(spot(next))
          : undefined;
      const fragment = fragmentOf(again === undefined ? next : { ...next, open: again });
      if (host.device.address.heldBefore(fragment, () => go(to, how))) return;
      /* A move to another place, or another part of one, is a switch: timed until its seat is on screen. */
      if (next.place !== now.current.place || next.sub !== now.current.sub) beginSwitch(placeSwitchKey(next));
      entered.set(how?.entered === true && next.open !== null ? { fragment, letter: next.open } : null);
      host.device.address.write(fragment, how?.replace === true ? "replace" : "push");
      setRailOpen(false);
      setOver(null);
    },
    [host, keeps, entered],
  );
  /* One object while the host stands: a feature that keeps a command in an effect's list is not run again for it. */
  const commands: FrameCommands = useMemo(
    () => ({
      go,
      open: (letter: string | null, how?: "replace") => {
        entered.set(null);
        host.device.address.write(
          fragmentOf({ ...now.current, open: letter }),
          how ?? "push",
          letter === null ? "closed" : undefined,
        );
      },
      /* A new letter passes the composer's door (a letter whose send is still on its way gives way by its own rule);
         a letter handed in is taken by the composer's mount. */
      write: function write(letter?: LinkedDraft) {
        if (host.device.address.heldBefore(fragmentOf({ ...HOME, place: "write" }), () => write(letter))) return;
        draft.current = letter ?? null;
        if (letter === undefined) goCompose(() => go({ place: "write" }));
        else go({ place: "write" });
      },
      rail: setRailOpen,
      hold: setHeld,
      over: setOver,
      switchProduct: (to) => {
        if (calendarOf(host) === null || productOf(now.current.place) === to) return;
        go(to === "mail" ? lastMail.current : (lastCalendar.current ?? { ...HOME, place: CALENDAR_HOME }));
      },
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
    [go, host, draft, entered],
  );
  return { commands, railOpen, setRailOpen, held, over };
}

function FrameBody({ host }: { host: FrameHost }) {
  const facts = useSignal(host.device.window);
  const look = useSignal(host.device.appearance);
  const plan: LayoutPlan = useMemo(() => layoutPlan(facts), [facts]);
  const address = host.device.address;
  const fragment = useSyncExternalStore(address.subscribe, address.read, address.read);
  const addressed = useMemo(() => routeOf(fragment), [fragment]);
  const calendar = calendarOf(host);
  /* A calendar address where the switch is absent folds back to mail's home: the bar is replaced, and mail's home is
     drawn meanwhile, never a blank frame. */
  const folded =
    calendar === null && (isCalendarPlace(addressed.place) || addressed.stage?.id === "calSetup");
  const route = folded ? HOME : addressed;
  const product = productOf(route.place);
  const attributes = useMemo(() => attributesOf(plan, look, facts, product), [plan, look, facts, product]);
  const slot = useReportSlot();
  const [inner] = useState(() => ({
    notices: createNoticeStore(),
    rail: createFeed<RailModel | null>(null),
    foot: createFeed<RailFootModel | null>(null),
    connection: createFeed<ConnectionFeed>(NO_CONNECTION, sameFeed),
    draft: { current: null as LinkedDraft | null },
    entered: createFeed<EnteredTarget | null>(null),
    bars: createFeed<readonly string[]>([]),
    owed: owedFeed(),
    offers: createOfferStore(),
    drag: createFeed<Dragging | null>(null),
  }));
  /* A history or external address change can leave a chosen hit before its local row arrives. */
  useLayoutEffect(
    () =>
      address.subscribe(() => {
        const target = inner.entered.read();
        if (target && target.fragment !== address.read()) inner.entered.set(null);
      }),
    [address, inner],
  );
  const { commands, railOpen, setRailOpen, held, over } = useCommands(
    host,
    route,
    plan,
    inner.draft,
    inner.entered,
  );
  const api: FrameApi = useMemo(
    () => ({ host, route, plan, commands, report: slot.report, over, product }),
    [host, route, plan, commands, slot.report, over, product],
  );
  const context: FrameInner = useMemo(
    () => ({ ...inner, api, railOpen: [railOpen, setRailOpen] as const }),
    [inner, api, railOpen, setRailOpen],
  );
  const places = host.features.places;
  const place = isCalendarPlace(route.place) ? (calendar?.places[route.place] ?? NONE) : places[route.place];
  const entry = place === NONE ? null : place;
  /* AN ADDRESS THAT NAMES A PLACE THIS HOST DOES NOT HAND (a stored link, a notice's link) is replaced by the
     Ohbox's: nothing of that place exists here, no page stands in for it, and Back does not lead there again. On a
     host that hands no Ohbox either the address stays and nothing is drawn. */
  const lost = place === NONE && places.ohbox !== NONE;
  /* Correct the fragment in place, with one write even if its place is unavailable. A bare page may stay bare. */
  useLayoutEffect(() => {
    if (fragment === "" || fragment === "#") return;
    const canonical = fragmentOf(lost ? HOME : route);
    if (canonical !== fragment && address.read() === fragment) address.write(canonical, "replace");
  }, [address, fragment, lost, route]);
  const stageEntry = useStageEntry(host, route, calendar, inner.owed);
  const staged = stageEntry !== NONE;
  const pane: PaneProps = { route, plan, keysHere: !staged };
  const readingShown = plan.columns === 2 || route.open !== null || holdsItsReading(entry);
  const panes = panesOf(entry, pane, readingShown, host.features.reader);
  const Above = host.features.above;
  /* Whose press seam it is, the host's record says, statically: a host that hands a ground above the panes or a reader
     gets the room's own, mounted once for the frame's life and on wherever the frame stands. A host that hands neither
     has nothing that can press, and no seam. */
  const whose: RoomSeam = Above !== NONE || host.features.reader !== NONE ? "own" : "none";
  const room = whose === "own";
  const root = useRef<HTMLDivElement>(null);
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
      over={over}
    />
  );

  return (
    <FrameContext.Provider value={context}>
      <FrameRoot drawn={root} attributes={attributes} held={held || staged}>
        <RoomGate on={room} whose={whose}>
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

/** The key registry with what goes with it: the zone the keys are in, said on the document, and the focus rule. */
function OwnKeys({ children }: { children: ReactNode }) {
  return (
    <KeymapContext.Provider value={useKeymapStore()}>
      <ZoneCursor />
      <FocusFollows />
      {children}
    </KeymapContext.Provider>
  );
}

/**
 * THE KEYS OF A FRAME: one table of bindings and one listener, mounted under the scope, so that a place declares its
 * keys and needs nothing of a shell, and no binding of one account answers under the next. Where a registry stands
 * above the frame (a shell that binds keys beside the frame too), the frame joins that one and mounts none: two
 * tables would answer one press twice.
 */
function Keys({ children }: { children: ReactNode }) {
  return useContext(KeymapContext) ? children : <OwnKeys>{children}</OwnKeys>;
}

/** The frame, mounted again whenever the host's scope changes. */
export function Frame({ host }: { host: FrameHost }) {
  return (
    <HostEngine host={host}>
      <Scoped scope={host.session.scope}>
        <Keys>
          <FrameBody host={host} />
        </Keys>
      </Scoped>
    </HostEngine>
  );
}
