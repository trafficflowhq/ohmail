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
import { useFrameStores } from "./frame-stores.js";
import {
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { calendarRefusalSentence, type CalendarPort } from "@ohmail/app-logic/calendar";
import { EngineContext } from "@ohmail/app-logic/engine";
import { FocusFollows, KeymapContext, useKeymapStore, ZoneCursor } from "@ohmail/app-logic/keys";
import { SYNC_SETTLED } from "@ohmail/app-logic/session/sync-scheduler";
import { goCompose } from "@ohmail/app-logic/writing/compose-door";
import { beginSwitch, placeSwitchKey } from "@ohmail/app-logic/session/ui-vitals";
import { NONE } from "../host/contract.js";
import type { LinkedDraft } from "../host/signals.js";
import { useText } from "../text/index.js";
import { FrameContext, type EnteredTarget, type FrameInner } from "./commands.js";
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
  type Route,
  type RouteTarget,
} from "./contract.js";
import { useSignal, type Feed } from "./feeds.js";
import { FrameParts } from "./FrameParts.js";
import { FrameRoot } from "./FrameRoot.js";
import { layoutPlan } from "./layout-plan.js";
import { holdsItsReading, panesOf } from "./panes-of.js";
import { RoomGate } from "./room.js";
import type { RoomSeam } from "./room-store.js";
import type { ReportSlotApi } from "./report-slot.js";
import { useFrameReportSlot } from "./WindowReports.js";
import { attributesOf } from "./root-attributes.js";
import { CALENDAR_HOME, MAIL_HOME, eventRefString, isCalendarPlace, productOf } from "./product.js";
import { useRouteMemory } from "./route-memory.js";
import { fragmentOf, hasLetterTail, routeOf } from "./route.js";
import { Scoped } from "./scope.js";
import { useStageEntry } from "./stage-entry.js";
import "./touch-keys.css";
import "./placement.css";
import "./seam.generated.css";

/** A place under its own word: what a kept letter is remembered by (a letter open under one tag is not another's). */
const spot = (at: Pick<Route, "place" | "sub">): string => `${at.place}/${at.sub ?? ""}`;

/** The calendar's entry where this host offers the switch between the two products, else null. */
function calendarOf(host: FrameHost): CalendarEntry | null {
  const entry = host.features.calendar;
  return host.capabilities.products === "both" && entry !== NONE ? entry : null;
}

function noticePlaceAt(host: FrameHost, fragment: string) {
  const notice = host.features.calendar === NONE ? undefined : host.features.calendar.notice;
  return notice?.fragment === fragment ? notice.place : null;
}

const HOME: Route = { place: MAIL_HOME, sub: null, open: null, stage: null, words: {} };

const calendarHome = (plan: LayoutPlan): Route => ({
  ...HOME,
  place: plan.device === "phone" ? "agenda" : CALENDAR_HOME,
});

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
  const [readerOpen, setReaderOpen] = useState(0);
  const now = useRef(route);
  now.current = route;
  const layout = useRef(plan);
  layout.current = plan;
  const places = host.features.places;
  const keeps = useCallback(
    (at: Route): boolean => {
      if (isCalendarPlace(at.place)) return false;
      const place = places[at.place];
      return place !== NONE && place.panes.kind === "columns" && place.panes.keepsOpen === true;
    },
    [places],
  );
  /* The address keeps each mail place's last open letter for the life of this frame. */
  const kept = useRef(new Map<string, Pick<Route, "open" | "wholeThread">>());
  if (keeps(route)) {
    if (route.open === null) kept.current.delete(spot(route));
    else kept.current.set(spot(route), { open: route.open, wholeThread: route.wholeThread });
  }
  const memory = useRouteMemory(route, HOME);
  const go = useCallback(
    function go(to: RouteTarget, how?: GoHow) {
      const next: Route = { sub: null, open: null, stage: null, words: {}, ...to };
      /* A way back that names no letter opens the one the place kept, where a column stands for it. */
      const again =
        to.open === undefined && next.stage === null && layout.current.columns === 2 && keeps(next)
          ? kept.current.get(spot(next))
          : undefined;
      const fragment = fragmentOf(again === undefined ? next : { ...next, ...again });
      if (host.device.address.heldBefore(fragment, () => go(to, how))) return;
      if (next.place !== now.current.place || next.sub !== now.current.sub) beginSwitch(placeSwitchKey(next));
      entered.set(how?.entered === true && next.open !== null ? { fragment, letter: next.open } : null);
      if (how?.entered && next.open !== null && fragment === host.device.address.read()) {
        setReaderOpen((count) => count + 1);
      }
      host.device.address.write(
        fragment,
        how?.replace || how?.history === "dismiss-dialog" ? "replace" : "push",
        how?.history,
      );
      setRailOpen(false);
      setOver(null);
    },
    [host, keeps, entered],
  );
  /* One object while the host stands: a feature that keeps a command in an effect's list is not run again for it. */
  const commands: FrameCommands = useMemo(
    () => ({
      go,
      open: (letter: string | null, how?: "replace", wholeThread?: true) => {
        entered.set(null);
        const fragment = fragmentOf({ ...now.current, open: letter, wholeThread });
        if (letter !== null && how === undefined && fragment === host.device.address.read()) {
          setReaderOpen((count) => count + 1);
        }
        host.device.address.write(fragment, how ?? "push", letter === null ? "closed" : undefined);
      },
      closeAddress: () => go(memory.current.addressFrom, { replace: true }),
      closeSearch: () => go(memory.current.searchFrom),
      /* A draft waits for the current composer to give way. */
      write: function write(letter?: LinkedDraft) {
        if (host.device.address.heldBefore(fragmentOf({ ...HOME, place: "write" }), () => write(letter)))
          return;
        draft.current = letter ?? null;
        if (letter === undefined) goCompose(() => go({ place: "write" }));
        else go({ place: "write" });
      },
      rail: setRailOpen,
      hold: setHeld,
      over: setOver,
      switchProduct: (to, setupHome) => {
        if (calendarOf(host) === null) return;
        const here = now.current.place;
        const { calendarView, lastCalendar, lastMail } = memory.current;
        const home = setupHome === undefined ? null : { place: setupHome };
        if (productOf(here) === to) {
          if (here === "calsettings" || here === "frommail" || here === "calsearch") {
            go(home ?? calendarView ?? calendarHome(layout.current));
          }
          return;
        }
        go(to === "mail" ? lastMail : (home ?? lastCalendar ?? calendarHome(layout.current)));
      },
      closeCalendarSettings: () => go(memory.current.beforeCalendarSettings ?? calendarHome(layout.current)),
      event: (ref: EventRef | null) => {
        if (calendarOf(host) === null) {
          if (ref === null && noticePlaceAt(host, host.device.address.read())) go(HOME);
          return;
        }
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
        const there = memory.current.lastCalendar ?? calendarHome(layout.current);
        go({ place: there.place, sub: ref.day, open, words: there.words });
      },
    }),
    [go, host, draft, entered, memory],
  );
  return { commands, railOpen, setRailOpen, held, over, readerOpen };
}

/** Keep the report with the pressing tab when it leaves the Calendar view. */
function CalendarWriteReports({
  port,
  slot,
}: {
  port: CalendarPort;
  slot: Pick<ReportSlotApi, "reportCalendar" | "retireCalendar">;
}) {
  const text = useText("event");
  const words = useRef(text);
  words.current = text;
  const { reportCalendar, retireCalendar } = slot;
  useEffect(() => {
    const scope = Symbol();
    const retire = () => retireCalendar(scope);
    const stop = port.subscribeLateRefusals?.(
      (word) => reportCalendar(scope, words.current(calendarRefusalSentence(word))),
      retire,
    );
    return () => {
      stop?.();
      retire();
    };
  }, [port, reportCalendar, retireCalendar]);
  return null;
}

function FrameBody({ host }: { host: FrameHost }) {
  const facts = useSignal(host.device.window);
  const look = useSignal(host.device.appearance);
  const address = host.device.address;
  const fragment = useSyncExternalStore(address.subscribe, address.read, address.read);
  const addressed = useMemo(() => routeOf(fragment), [fragment]);
  const calendar = calendarOf(host);
  const noticePlace = noticePlaceAt(host, fragment);
  /* A calendar address where the switch is absent folds back to mail's home: the bar is replaced, and mail's home is
     drawn meanwhile, never a blank frame. */
  const folded =
    calendar === null &&
    noticePlace === null &&
    (isCalendarPlace(addressed.place) || addressed.stage?.id === "calSetup");
  const route = folded ? HOME : addressed;
  const placeHere = spot(route);
  const [startupPlace, setStartupPlace] = useState<string | null>(() =>
    route.open === null ? placeHere : null,
  );
  const initialPlace = startupPlace === placeHere;
  if (startupPlace !== null && !initialPlace) setStartupPlace(null);
  const product = productOf(route.place);
  const layout = product === "mail" ? look.layout : undefined;
  const plan: LayoutPlan = useMemo(() => layoutPlan(facts, layout), [facts, layout]);
  const stoodProduct = useRef(product);
  const previousProduct = stoodProduct.current;
  useLayoutEffect(() => {
    stoodProduct.current = product;
  }, [product]);
  const attributes = useMemo(() => attributesOf(plan, look, facts, product), [plan, look, facts, product]);
  const slot = useFrameReportSlot();
  const calendarPort = host.wires.calendar;
  const inner = useFrameStores(address);
  const { commands, railOpen, setRailOpen, held, over, readerOpen } = useCommands(
    host,
    route,
    plan,
    inner.draft,
    inner.entered,
  );
  const api: FrameApi = useMemo(
    () => ({ host, route, plan, commands, report: slot.report, over, product, previousProduct }),
    [host, route, plan, commands, slot.report, over, product, previousProduct],
  );
  const context: FrameInner = useMemo(
    () => ({ ...inner, api, initialPlace, readerOpen, railOpen: [railOpen, setRailOpen] as const }),
    [inner, api, initialPlace, readerOpen, railOpen, setRailOpen],
  );
  const places = host.features.places;
  const place = isCalendarPlace(route.place)
    ? (noticePlace ?? calendar?.places[route.place] ?? NONE)
    : places[route.place];
  const entry = place === NONE ? null : place;
  /* AN ADDRESS THAT NAMES A PLACE THIS HOST DOES NOT HAND (a stored link, a notice's link) is replaced by the
     Ohbox's: nothing of that place exists here, no page stands in for it, and Back does not lead there again. On a
     host that hands no Ohbox either the address stays and nothing is drawn. */
  const lost = place === NONE && places.ohbox !== NONE;
  /* Correct the fragment in place, with one write even if its place is unavailable. A bare page may stay bare. */
  useLayoutEffect(() => {
    if (fragment === "" || fragment === "#") return;
    const canonical = fragmentOf(lost ? HOME : route);
    // Wide-only Settings has no letter over a list. Keep its incoming address when only the letter tail differs.
    if (route.place === "settings" && entry?.panes.kind === "wide" && hasLetterTail(fragment, canonical))
      return;
    if (canonical !== fragment && address.read() === fragment) address.write(canonical, "replace");
  }, [address, entry, fragment, lost, route]);
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
  const CalendarAbove = calendar?.Above;
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
      {calendarPort !== NONE && calendarPort?.subscribeLateRefusals && (
        <CalendarWriteReports port={calendarPort} slot={slot} />
      )}
      <FrameRoot drawn={root} attributes={attributes} held={held || staged}>
        <RoomGate on={room} whose={whose}>
          {Above === NONE ? (
            CalendarAbove ? (
              <CalendarAbove>{parts}</CalendarAbove>
            ) : (
              parts
            )
          ) : (
            <Above>{CalendarAbove ? <CalendarAbove>{parts}</CalendarAbove> : parts}</Above>
          )}
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
