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
  useMemo,
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
import { Section, panelSurface, pullRefreshControl, useListInsets, type PullRefresh } from "./base";
import {
  FIRST_GROUP_TOP,
  LIST_WINDOW,
  PANEL_FOOT,
  TOP_HOLD,
  isSection,
  planSections,
  type ListGroup,
  type PlannedSection,
} from "./mail-list-plan";

export type { ListGroup } from "./mail-list-plan";

/** A row's frame inside the scroll content — what a read-line sweep compares against. */
export interface RowFrame {
  y: number;
  height: number;
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
  scrollEventThrottle?: number;
  /** A row's frame in scroll-content coordinates, as its cell lays out — the sweeps' geometry. */
  onRowFrame?: (row: T, frame: RowFrame) => void;
}

interface CellRules {
  rowInset: number;
  onRowFrame: ((row: unknown, frame: RowFrame) => void) | null;
}

const CellRulesContext = createContext<CellRules>({ rowInset: 0, onRowFrame: null });

/**
 * Every cell, rows and section headers alike. Module-scope on purpose: a new component identity
 * per render would remount every mounted row. The list's own measurement runs first (that is
 * how it sizes its window); a row's frame is then reported as the cell's, which sits directly
 * in the scroll content, so `y` is already in the coordinates the read-line sweeps compare.
 */
function Cell({ children, onLayout, style, item, onFocusCapture }: CellRendererProps<unknown>) {
  const { rowInset, onRowFrame } = useContext(CellRulesContext);
  const row = !isSection(item);
  const measure = (e: LayoutChangeEvent) => {
    onLayout?.(e);
    if (row && onRowFrame !== null) {
      onRowFrame(item, { y: e.nativeEvent.layout.y, height: e.nativeEvent.layout.height });
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

/** The scroll view with the panel surface as its content's FIRST child — behind every cell. */
function SurfacedScroll({
  ref,
  surface,
  children,
  ...rest
}: ScrollViewProps & { ref?: Ref<ScrollView>; surface: ReactNode }) {
  return (
    <ScrollView ref={ref} {...rest}>
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
  scrollEventThrottle,
  onRowFrame,
}: MailListProps<T>) {
  const t = useTheme();
  const insets = useListInsets();
  const sections = useMemo(() => planSections(groups), [groups]);

  const [headH, setHeadH] = useState<number | null>(null);
  const [tailH, setTailH] = useState(0);
  const onHead = useCallback((e: LayoutChangeEvent) => setHeadH(e.nativeEvent.layout.height), []);
  const onTail = useCallback((e: LayoutChangeEvent) => setTailH(e.nativeEvent.layout.height), []);
  useEffect(() => {
    if (tail === undefined || tail === null) setTailH(0);
  }, [tail]);

  const rules = useMemo<CellRules>(
    () => ({
      rowInset,
      onRowFrame: onRowFrame ? (row, frame) => onRowFrame(row as T, frame) : null,
    }),
    [rowInset, onRowFrame],
  );

  const renderItem = useCallback(
    ({ item }: SectionListRenderItemInfo<T, PlannedSection<T>>) => renderRow(item),
    [renderRow],
  );
  const renderSectionHeader = useCallback(
    ({ section }: { section: SectionListData<T, PlannedSection<T>> }) => {
      if (section.title !== null) {
        return (
          <Section style={section.first ? { paddingTop: FIRST_GROUP_TOP } : undefined}>{section.title}</Section>
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
            left: insets.paddingHorizontal,
            right: insets.paddingHorizontal,
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
        accessibilityRole="list"
        sections={sections}
        keyExtractor={rowKey}
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
        onScroll={onScroll}
        scrollEventThrottle={scrollEventThrottle}
        /* The head is the anchor at the top: the hold skips only the children that precede it, and
           the surface is one of them only once it has mounted. Handed `1` before that, the first
           ROW anchored and the head's later growth (the doorbell arriving) scrolled the title off
           on the fold AVD. Within TOP_HOLD of the top a change scrolls back to 0 as the belt. */
        maintainVisibleContentPosition={{
          minIndexForVisible: surfaceNode !== null ? 1 : 0,
          autoscrollToTopThreshold: TOP_HOLD,
        }}
        removeClippedSubviews={Platform.OS === "android"}
        {...LIST_WINDOW}
        style={{ flex: 1 }}
        contentContainerStyle={insets}
      />
    </CellRulesContext.Provider>
  );
}
