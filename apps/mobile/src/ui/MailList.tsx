/**
 * The one virtualized mail list. A `SectionList` under the window in `mail-list-plan.ts`, so a
 * screen mounts the rows on screen and a few viewports around them — never the mailbox, which
 * is what ran the Android heap out at a fold relayout. The panel the rows rest on is ONE view
 * (its lift is a layered shadow no per-cell paint could join), injected as the scroll content's
 * first child and stretched from the head's foot to the footer's; `minIndexForVisible` skips
 * it. Insets are `useListInsets`', the pull gesture `pullRefreshControl`'s — the two rules
 * `Scroller` reads. A cell measures itself in scroll-content coordinates for the sweeps.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
  type Ref,
} from "react";
import {
  Platform,
  ScrollView,
  SectionList,
  View,
  type CellRendererProps,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type ScrollViewProps,
  type SectionListData,
  type SectionListRenderItemInfo,
} from "react-native";
import { useTheme } from "../theme";
import { Section, Txt, panelSurface, pullRefreshControl, useListInsets, type PullRefresh } from "./base";
import {
  FIRST_GROUP_TOP,
  LIST_WINDOW,
  PANEL_FOOT,
  PlaceKeeper,
  TOP_HOLD,
  isSection,
  planSections,
  sectionItemLayout,
  type ListGroup,
  type PlannedSection,
  type RowLayout,
} from "./mail-list-plan";

export type { ListGroup } from "./mail-list-plan";

/** A row's frame inside the scroll content — what a read-line sweep compares against. */
export interface RowFrame {
  y: number;
  height: number;
}

/** A list that keeps the reader's place by its row (`PlaceKeeper`), told when its screen goes behind and comes back. */
export interface ListPlace {
  leave(): void;
  back(): void;
}

export interface MailListProps<T> {
  groups: readonly ListGroup<T>[];
  rowKey: (row: T) => string;
  renderRow: (row: T) => ReactElement | null;
  /** Above the rows, scrolling with them — the view head, the doorbell, a segmented control. */
  head?: ReactNode;
  /** Canvas between the head and the panel (History's rows panel stood 8 below its head). */
  gapAbove?: number;
  /** What stands where the rows would when there are none — the skeleton or the empty state. */
  empty?: ReactNode;
  /** After the last row, ON the panel — a tail line, a show-older row. */
  foot?: ReactNode;
  /** After the panel, on the canvas. */
  tail?: ReactNode;
  /** The l1 panel behind rows, empty state and foot. Off where the rows are their own cards. */
  surface?: boolean;
  /** The rows' inset from the panel's edge — the screens' old `paddingHorizontal: 6` wrapper. */
  rowInset?: number;
  refresh?: PullRefresh;
  onScroll?: (e: NativeSyntheticEvent<NativeScrollEvent>) => void;
  /** The person's own gesture: the finger down and up, and the glide a fling starts. */
  onScrollBeginDrag?: (e: NativeSyntheticEvent<NativeScrollEvent>) => void;
  onScrollEndDrag?: (e: NativeSyntheticEvent<NativeScrollEvent>) => void;
  onMomentumScrollBegin?: (e: NativeSyntheticEvent<NativeScrollEvent>) => void;
  onMomentumScrollEnd?: (e: NativeSyntheticEvent<NativeScrollEvent>) => void;
  scrollEventThrottle?: number;
  /** A row's frame in scroll-content coordinates, as its cell lays out — the sweeps' geometry. */
  onRowFrame?: (row: T, frame: RowFrame) => void;
  /** A row's cell left the list (the window moved on): its last frame is no longer kept current. */
  onRowGone?: (row: T) => void;
  /** Filled with a scroll to a content offset — History's year strip jumps with it. */
  scrollTo?: { current: ((y: number) => void) | null };
  /**
   * The heights the rows are drawn at, for a list of one untitled group that keeps them: the
   * list then knows every row's place before it has laid out, so a scroll reaches any of them.
   */
  rowLayout?: RowLayout;
  /**
   * A list that answers a question (Search): each new value opens it at its top, and no row is held in
   * place while the answer replaces itself. The hold anchored a row of the first paint, and the count
   * line and the newest matches stood above the view.
   */
  topFor?: string;
  /**
   * Keep the reader's place by its row (Android, where the native hold alone lost it): filled with
   * the keeper the screen tells when it goes behind another and comes back.
   */
  place?: { current: ListPlace | null };
}

type ScrollEv = NativeSyntheticEvent<NativeScrollEvent>;
const viewOf = (e: ScrollEv) => ({ y: e.nativeEvent.contentOffset.y, height: e.nativeEvent.layoutMeasurement.height });

interface CellRules {
  rowInset: number;
  onRowFrame: ((row: unknown, frame: RowFrame) => void) | null;
  onRowGone: ((row: unknown) => void) | null;
}

const CellRulesContext = createContext<CellRules>({ rowInset: 0, onRowFrame: null, onRowGone: null });

/**
 * Every cell, rows and section headers alike. Module-scope on purpose: a new component identity
 * per render would remount every mounted row. The list's own measurement runs first (that is
 * how it sizes its window); a row's frame is then reported as the cell's, which sits directly
 * in the scroll content, so `y` is already in the coordinates the read-line sweeps compare.
 */
function Cell({ children, onLayout, style, item, onFocusCapture }: CellRendererProps<unknown>) {
  const { rowInset, onRowFrame, onRowGone } = useContext(CellRulesContext);
  const row = !isSection(item);
  const live = useRef({ onRowFrame, onRowGone, item, frame: null as RowFrame | null });
  live.current = { ...live.current, onRowFrame, onRowGone, item };
  useEffect(() => {
    if (!row) return;
    const at = live.current;
    if (at.frame !== null) at.onRowFrame?.(at.item, at.frame);
    return () => live.current.onRowGone?.(live.current.item);
  }, [row]);
  const measure = (e: LayoutChangeEvent) => {
    onLayout?.(e);
    if (row && onRowFrame !== null) {
      const frame = { y: e.nativeEvent.layout.y, height: e.nativeEvent.layout.height };
      live.current.frame = frame;
      onRowFrame(item, frame);
    }
  };
  return (
    <View
      {...(onFocusCapture ? { onFocusCapture } : {})}
      style={[style, row && rowInset > 0 ? { paddingHorizontal: rowInset } : null]}
      onLayout={measure}
    >
      {children}
    </View>
  );
}

/** A glide begun is taken as over once the list has sent no scroll report for this long. */
export const GLIDE_STILL_MS = 300;

type GlideProps = Pick<ScrollViewProps, "onScroll" | "onScrollBeginDrag" | "onScrollEndDrag" | "onMomentumScrollBegin" | "onMomentumScrollEnd">;

/**
 * EVERY GLIDE ENDS. Android never ends a glide that its next touch cancels (fast flings toward the top
 * with the list already there, the touch then taken by the pull to refresh), and React Native's
 * ScrollView takes every press inside it as stopping a glide that began and has not ended: the rows
 * stayed dead until the list was scrolled again. A glide with no scroll report for `GLIDE_STILL_MS`
 * is ended here, through the ScrollView's own end handler, a finger on the list or not: a touch the
 * pull to refresh takes sends a begin drag and never its end drag. A finger moving the list keeps
 * the reports coming; one held still meets an end that leaves the move its own until the lift
 * (`PlaceKeeper.land`).
 */
function useGlideEnds(ref: Ref<ScrollView> | undefined, own: GlideProps) {
  const at = useRef(own);
  at.current = own;
  const view = useRef<ScrollView | null>(null);
  const g = useRef({ open: false, last: null as NativeScrollEvent | null, timer: undefined as ReturnType<typeof setTimeout> | undefined });
  useEffect(() => () => clearTimeout(g.current.timer), []);
  return useMemo(() => {
    const s = g.current;
    const wait = (e: ScrollEv) => {
      s.last = e.nativeEvent;
      clearTimeout(s.timer);
      s.timer = s.open ? setTimeout(end, GLIDE_STILL_MS) : undefined;
    };
    const onMomentumScrollEnd = (e: ScrollEv) => {
      s.open = false;
      clearTimeout(s.timer);
      at.current.onMomentumScrollEnd?.(e);
    };
    const end = () => {
      if (!s.open || s.last === null) return;
      const e = { nativeEvent: { ...s.last, velocity: { x: 0, y: 0 } } } as ScrollEv;
      // Not public: the ScrollView's press check reads when its own handler last saw an end.
      const sv = view.current?.getScrollResponder?.() as { _handleMomentumScrollEnd?: (e: ScrollEv) => void } | undefined;
      if (typeof sv?._handleMomentumScrollEnd === "function") sv._handleMomentumScrollEnd(e);
      else onMomentumScrollEnd(e);
    };
    return {
      glideRef: (v: ScrollView | null) => {
        view.current = v;
        if (typeof ref === "function") ref(v);
        else if (ref) (ref as { current: ScrollView | null }).current = v;
      },
      onScroll: (e: ScrollEv) => { if (s.open) wait(e); at.current.onScroll?.(e); },
      onScrollBeginDrag: (e: ScrollEv) => { if (s.open) wait(e); at.current.onScrollBeginDrag?.(e); },
      onScrollEndDrag: (e: ScrollEv) => { if (s.open) wait(e); at.current.onScrollEndDrag?.(e); },
      onMomentumScrollBegin: (e: ScrollEv) => { s.open = true; wait(e); at.current.onMomentumScrollBegin?.(e); },
      onMomentumScrollEnd,
    };
  }, [ref]);
}

/**
 * The scroll view with the panel surface as its content's FIRST child — behind every cell. The
 * native hold starts at the first cell after the head (`anchorFrom` children in), whatever index
 * the list keys its own window by.
 */
function SurfacedScroll({
  ref,
  surface,
  children,
  maintainVisibleContentPosition: hold,
  ...rest
}: ScrollViewProps & { ref?: Ref<ScrollView>; surface: ReactNode }) {
  const anchorFrom = (surface !== null ? 1 : 0) + 1;
  const { glideRef, ...ends } = useGlideEnds(ref, rest);
  return (
    <ScrollView
      ref={glideRef}
      {...rest}
      {...ends}
      maintainVisibleContentPosition={hold ? { ...hold, minIndexForVisible: anchorFrom } : hold}
    >
      {surface}
      {children}
    </ScrollView>
  );
}

export function MailList<T>({
  groups,
  rowKey,
  renderRow,
  head,
  gapAbove = 0,
  empty,
  foot,
  tail,
  surface = true,
  rowInset = 0,
  refresh,
  onScroll,
  onScrollBeginDrag,
  onScrollEndDrag,
  onMomentumScrollBegin,
  onMomentumScrollEnd,
  scrollEventThrottle,
  onRowFrame,
  onRowGone,
  scrollTo,
  rowLayout,
  topFor,
  place,
}: MailListProps<T>) {
  const t = useTheme();
  const listRef = useRef<SectionList<T, PlannedSection<T>>>(null);
  const toY = (y: number) => listRef.current?.getScrollResponder()?.scrollTo({ y, animated: false });
  if (scrollTo) scrollTo.current = toY;
  const keeper = useRef<PlaceKeeper | null>(null);
  if (place && Platform.OS === "android") {
    keeper.current ??= new PlaceKeeper((y) => toY(y));
    place.current = keeper.current;
  }
  useLayoutEffect(() => keeper.current?.committed());
  const keyOf = useRef(rowKey);
  keyOf.current = rowKey;
  const own = useRef({ onScroll, onScrollBeginDrag, onScrollEndDrag, onMomentumScrollBegin, onMomentumScrollEnd });
  own.current = { onScroll, onScrollBeginDrag, onScrollEndDrag, onMomentumScrollBegin, onMomentumScrollEnd };
  const keeping = keeper.current !== null;
  const gestures = useMemo(() => {
    const k = keeper.current;
    if (k === null) return null;
    return {
      onScroll: (e: ScrollEv) => { k.scroll(viewOf(e)); own.current.onScroll?.(e); },
      onScrollBeginDrag: (e: ScrollEv) => { k.drag(); own.current.onScrollBeginDrag?.(e); },
      onScrollEndDrag: (e: ScrollEv) => { k.lift(viewOf(e)); own.current.onScrollEndDrag?.(e); },
      onMomentumScrollBegin: (e: ScrollEv) => { k.glide(); own.current.onMomentumScrollBegin?.(e); },
      onMomentumScrollEnd: (e: ScrollEv) => { k.land(viewOf(e)); own.current.onMomentumScrollEnd?.(e); },
    };
  }, [keeping]);
  const insets = useListInsets();
  const sections = useMemo(() => planSections(groups), [groups]);
  useEffect(() => {
    if (topFor !== undefined) listRef.current?.getScrollResponder()?.scrollTo({ y: 0, animated: false });
  }, [topFor]);

  const [headH, setHeadH] = useState<number | null>(null);
  const [tailH, setTailH] = useState(0);
  const onHead = useCallback((e: LayoutChangeEvent) => setHeadH(e.nativeEvent.layout.height), []);
  const onTail = useCallback((e: LayoutChangeEvent) => setTailH(e.nativeEvent.layout.height), []);
  useEffect(() => {
    if (tail === undefined || tail === null) setTailH(0);
  }, [tail]);
  /* The rows' own heights, placed under the head (the cells start where it ends). */
  const itemLayout = useMemo(
    () => (rowLayout ? sectionItemLayout(sections, rowLayout, headH ?? 0) : undefined),
    [sections, rowLayout, headH],
  );

  const rules = useMemo<CellRules>(() => {
    const k = keeper.current;
    return {
      rowInset,
      onRowFrame: onRowFrame || k ? (row, frame) => {
        k?.frame(keyOf.current(row as T), frame.y, frame.height);
        onRowFrame?.(row as T, frame);
      } : null,
      onRowGone: onRowGone || k ? (row) => {
        k?.gone(keyOf.current(row as T));
        onRowGone?.(row as T);
      } : null,
    };
  }, [rowInset, onRowFrame, onRowGone, keeping]);

  const renderItem = useCallback(
    ({ item }: SectionListRenderItemInfo<T, PlannedSection<T>>) => renderRow(item),
    [renderRow],
  );
  const renderSectionHeader = useCallback(
    ({ section }: { section: SectionListData<T, PlannedSection<T>> }) => {
      if (section.title !== null) {
        return (
          <>
            <Section style={section.first ? { paddingTop: FIRST_GROUP_TOP } : undefined}>{section.title}</Section>
            {section.note !== null ? (
              <Txt variant="caption" tone="ink3" style={{ paddingHorizontal: 14, paddingBottom: 6 }}>
                {section.note}
              </Txt>
            ) : null}
          </>
        );
      }
      return section.padTop > 0 ? <View style={{ height: section.padTop }} /> : null;
    },
    [],
  );

  /* The panel, once the head has a height to start under. Its foot is where the footer's is: the
     content's bottom padding plus whatever sits on the canvas below the panel. */
  const surfaceNode =
    surface && headH !== null ? (
      <View
        pointerEvents="none"
        accessible={false}
        importantForAccessibility="no-hide-descendants"
        accessibilityElementsHidden
        style={[
          {
            position: "absolute",
            left: insets.paddingLeft,
            right: insets.paddingRight,
            top: headH,
            bottom: insets.paddingBottom + tailH,
          },
          panelSurface(t),
        ]}
      />
    ) : null;
  const renderScroll = useCallback(
    (p: ScrollViewProps) => <SurfacedScroll {...p} surface={surfaceNode} />,
    [surfaceNode],
  );

  const footer = (
    <View>
      {surface ? <View style={{ paddingBottom: PANEL_FOOT }}>{foot}</View> : foot}
      {tail !== undefined && tail !== null ? <View onLayout={onTail}>{tail}</View> : null}
    </View>
  );

  return (
    <CellRulesContext.Provider value={rules}>
      <SectionList<T, PlannedSection<T>>
        ref={listRef}
        accessibilityRole="list"
        sections={sections}
        keyExtractor={rowKey}
        getItemLayout={itemLayout}
        renderItem={renderItem}
        renderSectionHeader={renderSectionHeader}
        CellRendererComponent={Cell}
        renderScrollComponent={renderScroll}
        ListHeaderComponent={
          <View onLayout={onHead}>
            {head}
            {gapAbove > 0 ? <View style={{ height: gapAbove }} /> : null}
          </View>
        }
        ListFooterComponent={footer}
        ListEmptyComponent={empty !== undefined && empty !== null ? <View>{empty}</View> : undefined}
        stickySectionHeadersEnabled={false}
        showsVerticalScrollIndicator={false}
        refreshControl={pullRefreshControl(t, refresh)}
        onScroll={gestures?.onScroll ?? onScroll}
        onScrollBeginDrag={gestures?.onScrollBeginDrag ?? onScrollBeginDrag}
        onScrollEndDrag={gestures?.onScrollEndDrag ?? onScrollEndDrag}
        onMomentumScrollBegin={gestures?.onMomentumScrollBegin ?? onMomentumScrollBegin}
        onMomentumScrollEnd={gestures?.onMomentumScrollEnd ?? onMomentumScrollEnd}
        scrollEventThrottle={scrollEventThrottle}
        /* The list keys its window by the first ROW (the first group is never empty), so rows arriving
           above move the window with them; keyed by the group's header it stayed put, and at the end
           of News the rows on screen left it. The native hold starts at the first cell
           (`SurfacedScroll`): a first ROW there let the head's growth (the doorbell arriving) scroll
           the title off on the fold AVD. Within TOP_HOLD of the top a change scrolls back to 0. */
        maintainVisibleContentPosition={topFor !== undefined ? undefined : {
          minIndexForVisible: 1,
          autoscrollToTopThreshold: TOP_HOLD,
        }}
        /* Android detaches clipped rows; a list placed by its caller's ledger and jumped by offset
           (History) does not: after a rail press a small swipe left its viewport blank on Android
           only. The window still bounds what is mounted. */
        removeClippedSubviews={Platform.OS === "android" && rowLayout === undefined}
        {...LIST_WINDOW}
        style={{ flex: 1 }}
        contentContainerStyle={insets}
      />
    </CellRulesContext.Provider>
  );
}
