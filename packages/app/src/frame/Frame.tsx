/**
 * THE FRAME: the rail, the columns or the wide pane, the stage, the one notice slot, the one report slot and
 * the connection states, laid out by one plan from the window. It imports no feature: the places it draws are
 * the host's registrations. It asks for no setting: everything comes from the host contract. Everything under
 * it is mounted again when the host's scope changes.
 */
import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentProps,
  type ReactNode,
} from "react";
import { Overlay } from "@ohmail/ui/base";
import { EngineContext } from "@ohmail/app-logic/engine";
import { SYNC_SETTLED } from "@ohmail/app-logic/session/sync-scheduler";
import { NONE, type LinkedDraft } from "../host/index.js";
import { Columns } from "./Columns.js";
import { FrameContext, NO_CONNECTION, type ConnectionFeed, type FrameInner } from "./commands.js";
import { useConnectionNotice } from "./connection.js";
import type {
  FrameApi,
  FrameCommands,
  FrameHost,
  LayoutPlan,
  PaneProps,
  PlaceEntry,
  RailModel,
  Route,
  RouteTarget,
} from "./contract.js";
import { createFeed, useSignal, type Feed } from "./feeds.js";
import { FeatureNotices } from "./FeatureNotices.js";
import { FrameRoot } from "./FrameRoot.js";
import { layoutPlan } from "./layout-plan.js";
import { createNoticeStore, type NoticeStore } from "./notice-store.js";
import { NoticeHost } from "./NoticeHost.js";
import { DockRail, SideRail } from "./RailHost.js";
import { ReportHost } from "./ReportHost.js";
import { useReportSlot } from "./report-slot.js";
import { attributesOf } from "./root-attributes.js";
import { fragmentOf, routeOf } from "./route.js";
import { Scoped } from "./scope.js";
import { Stage } from "./Stage.js";
import { useText } from "../text/index.js";
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
const NO_SIGNAL = { read: () => null, subscribe: () => () => undefined };

/** The route the address names now: the shell's address door is the one copy. */
function useRoute(host: FrameHost): Route {
  const address = host.device.address;
  const fragment = useSyncExternalStore(address.subscribe, address.read, address.read);
  return useMemo(() => routeOf(fragment), [fragment]);
}

function useCommands(host: FrameHost, route: Route, draft: { current: LinkedDraft | null }) {
  const [railOpen, setRailOpen] = useState(false);
  const [held, setHeld] = useState(false);
  const now = useRef(route);
  now.current = route;
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
    }),
    [go, host, draft],
  );
  return { commands, railOpen, setRailOpen, held };
}

/** The connection, read off the host and today's views, said in the one slot. */
function ConnectionHost({
  host,
  feed,
  notices,
  commands,
}: {
  host: FrameHost;
  feed: Feed<ConnectionFeed>;
  notices: NoticeStore;
  commands: FrameCommands;
}) {
  const fed = useSignal(feed);
  const quiet = useSignal(host.signals.hostConnection === NONE ? NO_SIGNAL : host.signals.hostConnection);
  const setup = fed.setupHref;
  const notice = useConnectionNotice(
    {
      mail: fed.mail,
      online: fed.online,
      session: host.session.state,
      host: quiet,
      copyAsOf: fed.copyAsOf ?? null,
    },
    {
      recover: host.session.recover,
      mailboxes: () => commands.go({ place: "settings", sub: "mailboxes" }),
      help: () => commands.go({ place: "settings", sub: "help" }),
      follow: fed.follow,
      ...(setup !== null ? { connect: () => fed.follow(setup) } : {}),
    },
    fed.reason ?? null,
  );
  useEffect(() => notices.post("connection", notice ? [notice] : []));
  return null;
}

/** A place's panes, or the shared body they name: one mounted instance per body. */
function panesOf(
  entry: PlaceEntry | null,
  pane: PaneProps,
  reading: boolean,
): { list: ReactNode; reading: ReactNode; wide: ReactNode | null } {
  if (!entry) return { list: null, reading: null, wide: null };
  const panes = entry.panes;
  if (panes.kind === "wide")
    return { list: null, reading: null, wide: <panes.Wide key={entry.body} {...pane} keysHere /> };
  const Reading = panes.Reading;
  return {
    list: <panes.List key={entry.body} {...pane} keysHere={pane.route.open === null} />,
    /* The reader's column mounts here once the reader's door lands (task `reader`). */
    reading:
      reading && Reading !== "reader" ? <Reading {...pane} keysHere={pane.route.open !== null} /> : null,
    wide: null,
  };
}

/**
 * The dock at a phone's foot, by the design's rule: it stands over the list or a wide pane, and never while a letter
 * stands open over them (the frame does not draw it then) or a list's selection bar stands where it stood.
 */
function FootDock({
  bars,
  ...rails
}: Omit<ComponentProps<typeof DockRail>, "upright"> & { bars: Feed<readonly string[]> }) {
  const standing = useSignal(bars);
  return standing.length === 0 ? (
    <div className="fr-dockbox">
      <DockRail {...rails} upright={false} />
    </div>
  ) : null;
}

function FrameBody({ host }: { host: FrameHost }) {
  const t = useText("frame");
  const facts = useSignal(host.device.window);
  const look = useSignal(host.device.appearance);
  const plan: LayoutPlan = useMemo(() => layoutPlan(facts), [facts]);
  const attributes = useMemo(() => attributesOf(plan, look, facts), [plan, look, facts]);
  const route = useRoute(host);
  const slot = useReportSlot();
  const [inner] = useState(() => ({
    notices: createNoticeStore(),
    rail: createFeed<RailModel | null>(null),
    connection: createFeed<ConnectionFeed>(NO_CONNECTION, sameFeed),
    draft: { current: null as LinkedDraft | null },
    bars: createFeed<readonly string[]>([]),
  }));
  const { commands, railOpen, setRailOpen, held } = useCommands(host, route, inner.draft);
  const api: FrameApi = useMemo(
    () => ({ host, route, plan, commands, report: slot.report }),
    [host, route, plan, commands, slot.report],
  );
  const context: FrameInner = useMemo(
    () => ({ ...inner, api, railOpen: [railOpen, setRailOpen] as const }),
    [inner, api, railOpen, setRailOpen],
  );
  const places = host.features.places;

  const place = places[route.place];
  const entry = place === NONE ? null : place;
  const stageEntry = route.stage ? host.features.stages[route.stage.id] : NONE;
  const staged = stageEntry !== NONE;
  const pane: PaneProps = { route, plan, keysHere: !staged };
  const { list, reading, wide } = panesOf(entry, pane, plan.columns === 2 || route.open !== null);
  /* The rail reads its feed itself: a new feed (a fold opened in it) draws the rail again, never the panes. */
  const rails = { feed: inner.rail, places, route, commands };
  /* On a phone's width a letter stands open over the list or the wide pane: no dock stands at the foot then. */
  const letterUp = plan.rail === "dock" && route.open !== null;
  /* Where no rail stands at the side, More opens the whole rail over the app: a modal sheet. */
  const sheet = railOpen && plan.rail !== "words";
  const slotNotice = <NoticeHost store={inner.notices} place={plan.rail === "words" ? "rail" : "bar"} />;
  const sideRail =
    plan.rail === "words" ? (
      <SideRail {...rails} notice={<div className="fr-railnotice">{slotNotice}</div>} />
    ) : plan.rail === "icons" ? (
      <DockRail {...rails} upright />
    ) : null;
  /* Where no rail's foot stands, the one notice stands over the list: inside its column beside an upright dock, over
     the whole window on a phone's width. */
  const inColumn = (onSheet: boolean) =>
    plan.rail === "icons" ? (
      <div key="bar" className="fr-noticebar" data-on-sheet={onSheet ? "" : undefined}>
        {slotNotice}
      </div>
    ) : null;

  return (
    <FrameContext.Provider value={context}>
      <FrameRoot attributes={attributes} held={held || staged}>
        <ConnectionHost host={host} feed={inner.connection} notices={inner.notices} commands={commands} />
        <FeatureNotices features={host.features} notices={inner.notices} />
        <div
          className="fr-frame"
          data-rail={plan.rail}
          data-size={plan.size}
          data-letter={letterUp ? "" : undefined}
          inert={held || staged || sheet || undefined}
        >
          {plan.rail === "dock" ? <div className="fr-noticebar">{slotNotice}</div> : null}
          <Columns
            plan={plan}
            rail={sideRail}
            list={[inColumn(plan.device !== "phone"), list]}
            listKeys={!staged && route.open === null}
            reading={reading}
            wide={wide !== null ? [inColumn(false), wide] : null}
            labels={{
              list: t("landmark.list"),
              reading: t("landmark.reading"),
              railWidth: t("columns.railWidth"),
              listWidth: t("columns.listWidth"),
            }}
          />
          {plan.rail === "dock" && !letterUp ? <FootDock bars={inner.bars} {...rails} /> : null}
          <div className="fr-report">
            <ReportHost slot={slot} />
          </div>
        </div>
        {/* The kit's overlay: the keys go in and stay, Escape or a press beside it closes it, and they go back to More. */}
        <Overlay
          open={sheet}
          onClose={() => commands.rail(false)}
          label={t("dock.more")}
          className="fr-railsheet"
        >
          <SideRail {...rails} notice={null} />
        </Overlay>
        <Stage open={staged} label={t("landmark.stage")}>
          {stageEntry !== NONE ? <stageEntry.Body {...pane} keysHere /> : null}
        </Stage>
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
