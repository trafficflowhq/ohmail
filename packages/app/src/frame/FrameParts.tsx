/**
 * WHAT THE FRAME'S ROOT HOLDS, laid out: the connection's and the features' notices, the frame's box (the columns, the
 * dock, the report), the whole rail as a sheet, and the stage. The frame's body (`Frame.tsx`) decides what is on
 * screen and hands it down; what a shell stands above every pane wraps all of this.
 */
import { useEffect, type ComponentProps } from "react";
import { Overlay } from "@ohmail/ui/base";
import { NONE, type None } from "../host/index.js";
import { Columns } from "./Columns.js";
import type { ConnectionFeed, FrameInner } from "./commands.js";
import { useConnectionNotice } from "./connection.js";
import type {
  ColumnsProps,
  FrameCommands,
  FrameHost,
  LayoutPlan,
  PaneProps,
  Route,
  StageEntry,
} from "./contract.js";
import { useSignal, type Feed } from "./feeds.js";
import { FeatureNotices } from "./FeatureNotices.js";
import type { NoticeStore } from "./notice-store.js";
import { NoticeHost } from "./NoticeHost.js";
import { DockRail, SideRail } from "./RailHost.js";
import { ReportHost } from "./ReportHost.js";
import type { useReportSlot } from "./report-slot.js";
import { Stage } from "./Stage.js";
import { useText } from "../text/index.js";

const NO_SIGNAL = { read: () => null, subscribe: () => () => undefined };

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

/** What the frame's root holds, as the frame's body hands it down. */
interface FramePartsProps {
  readonly host: FrameHost;
  readonly inner: Omit<FrameInner, "api" | "railOpen">;
  readonly plan: LayoutPlan;
  readonly route: Route;
  readonly commands: FrameCommands;
  readonly slot: ReturnType<typeof useReportSlot>;
  readonly panes: Pick<ColumnsProps, "list" | "reading" | "wide" | "kept" | "above">;
  /** What a stage's body is drawn with, and the stage the address names, or `none`. */
  readonly pane: PaneProps;
  readonly stage: StageEntry | None;
  /** More was pressed: where no rail stands at the side, the whole rail stands over the app. */
  readonly railOpen: boolean;
  /** A body of the shell's stands over the app and holds the frame inert. */
  readonly held: boolean;
  /** The place on screen holds its reading column whatever is open (its panes say `holds: "always"`). */
  readonly holds: boolean;
}

/**
 * EVERYTHING THE ROOT HOLDS: the connection's and the features' notices, the frame's box (the columns, the dock, the
 * report), the whole rail as a sheet, and the stage. What a shell stands above every pane wraps all of it, and draws
 * no box of its own.
 */
export function FrameParts({
  host,
  inner,
  plan,
  route,
  commands,
  slot,
  panes,
  pane,
  stage,
  railOpen,
  held,
  holds,
}: FramePartsProps) {
  const t = useText("frame");
  const { list, reading, wide, kept, above } = panes;
  const staged = stage !== NONE;
  /* The rail reads its feed itself: a new feed (a fold opened in it) draws the rail again, never the panes. */
  const rails = { feed: inner.rail, places: host.features.places, route, commands };
  /* On a phone's width a letter stands open over the list or the wide pane: no dock stands at the foot then. */
  const letterUp = plan.rail === "dock" && (route.open !== null || holds);
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
    <>
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
          listKeys={!staged && route.open === null && !holds}
          reading={reading}
          wide={wide !== null ? [inColumn(false), wide] : null}
          /* The frame's notice bar inside a wide pane stands only in the pane on screen. */
          kept={
            kept !== null
              ? { pane: [kept.shown ? inColumn(false) : null, kept.pane], shown: kept.shown }
              : null
          }
          above={above}
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
        {stage !== NONE ? <stage.Body {...pane} keysHere /> : null}
      </Stage>
    </>
  );
}
