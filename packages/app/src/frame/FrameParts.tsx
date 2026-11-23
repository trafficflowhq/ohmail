/**
 * WHAT THE FRAME'S ROOT HOLDS, laid out: the connection's and the features' notices, the frame's box (the columns, the
 * dock, the report), the whole rail as a sheet, and the stage. The frame's body (`Frame.tsx`) decides what is on
 * screen and hands it down; what a shell stands above every pane wraps all of this.
 */
import { useSwitchEnded } from "@ohmail/app-logic/session/ui-vitals";
import {
  useCallback,
  useContext,
  useEffect,
  useRef,
  type ComponentProps,
  type ReactNode,
  type RefObject,
} from "react";
import { Overlay } from "@ohmail/ui/base";
import { NONE, type None } from "../host/contract.js";
import { ProductKeys, ProductSwitch } from "./ProductSwitch.js";
import { PlaceChords } from "./chords.js";
import { Columns } from "./Columns.js";
import type { FrameInner } from "./commands.js";
import { ConnectionHost } from "./ConnectionHost.js";
import {
  OVER_IDS,
  type CalendarEntry,
  type CalendarRailProps,
  type ColumnsProps,
  type FrameCommands,
  type FrameHost,
  type FrameOvers,
  type LayoutPlan,
  type OverId,
  type PaneProps,
  type Route,
  type StageEntry,
} from "./contract.js";
import { useSignal, type Feed } from "./feeds.js";
import {
  FeatureNotices,
  StageNoticeInReview,
  StageNoticeOffer,
  STAGE_NOTICE_FEED,
} from "./FeatureNotices.js";
import { LetterBesideClose, LetterOverKeys } from "./letter-over.js";
import { calendarOf, isCalendarPlace } from "./product.js";
import { useRailGesture } from "./rail-gesture.js";
import { RAIL_SHEET, RailKeys } from "./rail-keys.js";
import type { NoticeStore } from "./notice-store.js";
import { NoticeHost } from "./NoticeHost.js";
import { NoticeMore } from "./NoticeMore.js";
import { DockRail, SideRail, type RailHostProps } from "./RailHost.js";
import { ReportHost } from "./ReportHost.js";
import type { useReportSlot } from "./report-slot.js";
import { useProductArrival } from "./product-arrival.js";
import { Stage } from "./Stage.js";
import { useText } from "../text/index.js";

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

/** The active product supplies its navigation in the form chosen by the frame. */
function Navigation({
  form,
  calendar,
  bars,
  phoneMore,
  ...rail
}: RailHostProps & {
  readonly form: CalendarRailProps["form"];
  readonly calendar: CalendarEntry | null;
  readonly bars: Feed<readonly string[]>;
  readonly phoneMore?: boolean;
}) {
  const apart = useSignal(rail.foot);
  const fed = useSignal(rail.feed);
  const standing = useSignal(bars);
  const switcher =
    calendar === null || form === "dock" ? undefined : (
      <ProductSwitch
        kind={phoneMore && rail.plan.device === "phone" ? "entry" : form === "words" ? "pair" : "round"}
        onRail={form === "icons"}
      />
    );
  if (calendar && isCalendarPlace(rail.route.place)) {
    const body = (
      <calendar.Rail
        form={form}
        route={rail.route}
        commands={rail.commands}
        plan={rail.plan}
        notice={rail.notice}
        accountFoot={fed?.account ? fed : apart}
        switcher={switcher}
      />
    );
    return form === "dock" ? standing.length ? null : <div className="fr-dockbox">{body}</div> : body;
  }
  if (form === "words") return <SideRail {...rail} switcher={switcher} phoneMore={phoneMore} />;
  if (form === "icons") return <DockRail {...rail} switcher={switcher} upright />;
  return <FootDock {...rail} bars={bars} />;
}

/** Every over handed stands mounted, open while the frame names it: one at a time, and going closes it. */
function Overs({
  overs,
  over,
  close,
}: {
  overs: FrameOvers;
  over: OverId | null;
  close: (to: null) => void;
}) {
  const onClose = useCallback(() => close(null), [close]);
  return (
    <>
      {OVER_IDS.map((id) => {
        const entry = overs[id];
        if (entry === NONE) return null;
        if (entry.id !== id) throw new Error(`an over handed as "${id}" names itself "${entry.id}"`);
        return <entry.Body key={id} open={over === id} onClose={onClose} />;
      })}
    </>
  );
}

function RailDrawer({
  frame,
  open,
  enabled,
  toggle,
  label,
  children,
}: {
  frame: RefObject<HTMLDivElement | null>;
  open: boolean;
  enabled: boolean;
  toggle: (open: boolean) => void;
  label: string;
  children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const preview = useRailGesture(frame, panel, enabled, open, toggle);
  return (
    <Overlay
      open={open}
      preview={preview}
      panelRef={panel}
      onClose={() => toggle(false)}
      label={label}
      place="start"
      className={preview ? `${RAIL_SHEET} fr-rail-preview` : RAIL_SHEET}
    >
      {children}
    </Overlay>
  );
}

/** What the frame's root holds, as the frame's body hands it down. */
function SwitchAtCommit({ route }: { route: Route }) {
  useSwitchEnded(route, true);
  return null;
}

/** Beside an upright dock, the notice stands inside the list, or over the window on a phone. */
function columnNotice(rail: LayoutPlan["rail"], notice: ReactNode, onSheet: boolean) {
  return rail === "icons" ? (
    <div key="bar" className="fr-noticebar" data-on-sheet={onSheet ? "" : undefined}>
      {notice}
    </div>
  ) : null;
}

interface FramePartsProps {
  readonly host: FrameHost;
  readonly inner: Omit<FrameInner, "api" | "railOpen">;
  readonly plan: LayoutPlan;
  readonly route: Route;
  readonly commands: FrameCommands;
  readonly slot: ReturnType<typeof useReportSlot>;
  readonly panes: Pick<ColumnsProps, "list" | "reading" | "wide" | "above">;
  /** What a stage's body is drawn with, and the stage the address names, or `none`. */
  readonly pane: PaneProps;
  readonly stage: StageEntry | None;
  /** More was pressed: where no rail stands at the side, the whole rail stands over the app. */
  readonly railOpen: boolean;
  /** A body of the shell's stands over the app and holds the frame inert. */
  readonly held: boolean;
  /** The place on screen holds its reading column whatever is open (its panes say `holds: "always"`). */
  readonly holds: boolean;
  /** The over the frame names open now (the palette, the key sheet), or none. */
  readonly over: OverId | null;
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
  over,
}: FramePartsProps) {
  const t = useText("frame");
  const { list, reading, wide, above } = panes;
  const staged = stage !== NONE;
  /* The rail reads its feed itself: a new feed (a fold opened in it) draws the rail again, never the panes. */
  const docks = { feed: inner.rail, places: host.features.places, route, commands };
  const rails = { ...docks, foot: inner.foot };
  /* On a phone's width a letter stands open over the list or the wide pane: no dock stands at the foot then. */
  const letterUp = plan.columns === 1 && (route.open !== null || holds);
  const sheet = railOpen && plan.rail !== "words";
  const active = !staged && !held && over === null;
  /* A letter stands over its list: one column, a reading column drawn, a letter named. Its Escape is the frame's. */
  const letterOpen = route.open !== null && reading !== null && !staged && !held && !sheet;
  const letterOver = plan.columns === 1 && letterOpen;
  /* Beside the list (two columns, a mail place's letter) Escape from the list closes it, in place: Back then leaves. */
  const letterBeside = plan.columns === 2 && letterOpen && !isCalendarPlace(route.place);
  const seedReview = stage !== NONE && stage.id === "firstRun" && route.stage === null;
  const slotNotice = staged ? null : (
    <NoticeHost store={inner.notices} place={plan.rail === "words" ? "rail" : "bar"} />
  );
  const calendar = calendarOf(host);
  const inCalendar = isCalendarPlace(route.place) && calendar !== null;
  const drawerGesture = active && plan.rail !== "words";
  const frame = useRef<HTMLDivElement>(null);
  useProductArrival(frame, plan.device, inCalendar ? "cal" : "mail", staged);
  const navigation = (form: CalendarRailProps["form"], notice: ReactNode, phoneMore = false) => (
    <Navigation
      {...rails}
      plan={plan}
      form={form}
      notice={notice}
      calendar={calendar}
      bars={inner.bars}
      phoneMore={phoneMore}
    />
  );
  return (
    <>
      {!staged && (inCalendar || route.place === "settings") ? <SwitchAtCommit route={route} /> : null}
      <ConnectionHost host={host} feed={inner.connection} notices={inner.notices} commands={commands} />
      <FeatureNotices features={host.features} notices={inner.notices} />
      <NoticeMore store={inner.notices} />
      {calendar && active && host.capabilities.products === "both" ? <ProductKeys /> : null}
      {!inCalendar ? <PlaceChords places={host.features.places} go={commands.go} /> : null}
      {letterOver ? <LetterOverKeys close={() => commands.open(null)} push={plan.ribbon === "push"} /> : null}
      {letterBeside ? <LetterBesideClose close={() => commands.open(null, "replace")} /> : null}
      <RailKeys side={plan.rail === "words"} up={railOpen} put={commands.rail} />
      <div
        ref={frame}
        className="fr-frame"
        data-rail={plan.rail}
        data-size={plan.size}
        data-drawer-edge={drawerGesture ? "" : undefined}
        data-letter={letterUp ? "" : undefined}
        inert={held || staged || sheet || undefined}
      >
        {plan.rail === "dock" ? <div className="fr-noticebar">{slotNotice}</div> : null}
        <Columns
          plan={plan}
          rail={
            plan.rail === "dock"
              ? null
              : navigation(plan.rail, <div className="fr-railnotice">{slotNotice}</div>)
          }
          list={[
            columnNotice(plan.rail, slotNotice, plan.device !== "phone"),
            <StageNoticeInReview.Provider key="list" value={seedReview}>
              {list}
            </StageNoticeInReview.Provider>,
          ]}
          listKeys={!staged && route.open === null && !holds}
          reading={reading}
          readingBackdrop={plan.device === "phone" && route.place === "frommail"}
          wide={wide !== null ? [columnNotice(plan.rail, slotNotice, false), wide] : null}
          above={above}
          labels={{
            list: t("landmark.list"),
            reading: t("landmark.reading"),
            railWidth: t("columns.railWidth"),
            listWidth: t("columns.listWidth"),
          }}
        />
        {plan.rail === "dock" && !letterUp ? navigation("dock", null) : null}
        {staged ? null : renderReport(slot, "fr-report")}
      </div>
      <RailDrawer
        frame={frame}
        open={sheet}
        enabled={drawerGesture}
        toggle={commands.rail}
        label={t("dock.more")}
      >
        {navigation("words", null, true)}
      </RailDrawer>
      {renderStage(stage, pane, seedReview, inner.notices, slot, t("landmark.stage"))}
      <Overs overs={host.features.overs} over={over} close={commands.over} />
    </>
  );
}

function SeedReviewNotice({ store }: { store: NoticeStore }) {
  const offer = useContext(StageNoticeOffer);
  return (
    <div className="fr-noticebar">
      {offer ?? <NoticeHost store={store} place="bar" feed={STAGE_NOTICE_FEED} />}
    </div>
  );
}

function renderReport(slot: FramePartsProps["slot"], className: string, hideKeyedUndo = false) {
  return (
    <div className={className}>
      <ReportHost slot={slot} hideKeyedUndo={hideKeyedUndo} />
    </div>
  );
}

function renderStage(
  stage: FramePartsProps["stage"],
  pane: FramePartsProps["pane"],
  seedReview: boolean,
  notices: NoticeStore,
  slot: FramePartsProps["slot"],
  label: string,
) {
  return (
    <Stage open={stage !== NONE} label={label}>
      {seedReview ? <SeedReviewNotice store={notices} /> : null}
      {stage !== NONE ? <stage.Body {...pane} keysHere /> : null}
      {stage !== NONE ? renderReport(slot, "fr-stage-report", true) : null}
    </Stage>
  );
}
