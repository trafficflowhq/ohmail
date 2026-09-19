/**
 * The layout shell — places the navigation, the panes, the fold and the reader's verbs where
 * `plan.ts` says they go for the current posture. NOTHING here decides; `scaffoldPlan` and
 * `paneSplit` decide and the suite measures them — this file renders. No wordmark anywhere in
 * this chrome. Continuity is structural: a posture change restyles this tree, it never
 * remounts the slots, so the open message, scroll and focus survive fold and rotation. The
 * fold: FLAT draws nothing and the panes meet at the hinge line with the ordinary gutter;
 * HALF-OPEN reserves the keep-out band, its edges a hairline pair; a hardware hinge keeps its
 * own width. A closed drawer or sheet unmounts — nothing peeks inside the safe-area inset.
 */
import { useState, type ReactNode } from "react";
import { Platform, StyleSheet, View, type LayoutChangeEvent } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme } from "../../theme";
import { usePosture } from "../posture";
import { GlassDock, type DockItem } from "../glass/GlassDock";
import { GlassRail, type RailAction } from "../glass/GlassRail";
import { GlassSidebar } from "../glass/GlassSidebar";
import { paneSplit, scaffoldPlan, RAIL_W, type ScaffoldPlan } from "./plan";

export { scaffoldPlan, paneSplit } from "./plan";

const platformName = Platform.OS === "ios" ? ("ios" as const) : ("android" as const);

export interface ScaffoldNav {
  items: readonly DockItem[];
  activeId: string | null;
  onItemPress: (id: string) => void;
  search: { label: string; onPress: () => void };
}

export function AppScaffold({
  nav,
  railVerbs,
  drawer,
  list,
  reader,
  children,
}: {
  /** The destinations + search — the dock's items or the nav rail's, per posture. */
  nav: ScaffoldNav;
  /**
   * The reader's verbs for the postures whose rail carries them (the unfolded Duo landscape) —
   * back, reply, reply all, forward, Done, Park, Junk, folding bottom-to-top. Supplied by the
   * surface; absent, the rail carries the destinations.
   */
  railVerbs?: readonly RailAction[][] | null;
  /** The destinations drawer behind the list pane's toggle — mounts over the list pane only. */
  drawer?: { open: boolean; onClose: () => void; label: string; content: ReactNode } | null;
  /** The two-pane slots. Absent, `children` is the one pane. */
  list?: ReactNode;
  reader?: ReactNode;
  children?: ReactNode;
}) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const posture = usePosture();
  const plan = scaffoldPlan(posture, platformName);
  const [box, setBox] = useState<{ w: number; h: number } | null>(null);
  const measure = (e: LayoutChangeEvent) =>
    setBox({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height });

  const split = box === null ? null : paneSplit(posture, plan, box.w, box.h);
  const two = split !== null && list !== undefined && reader !== undefined;

  /* The rail: message verbs where the plan says the rail carries them, else the destinations
     in the prototype's grammar — the pill of tabs, then search, its own pill. */
  const railGroups: RailAction[][] =
    plan.railCarriesReaderVerbs && railVerbs != null && railVerbs.length > 0
      ? railVerbs.map((g) => [...g])
      : [
          nav.items.map((item) => ({
            id: item.id,
            icon: item.icon,
            label: item.label,
            badge: item.badge,
            badgeHot: item.badgeHot,
            on: item.id === nav.activeId,
            role: "tab" as const,
            onPress: () => nav.onItemPress(item.id),
          })),
          [{ id: "__search", icon: "search" as const, label: nav.search.label, fixed: true, onPress: nav.search.onPress }],
        ];

  const railBottom =
    plan.railUpperHalfOnly && posture.hinge !== null
      ? // the rail owns the UPPER half: it ends above the seam, so nothing sits on or below it
        (box?.h ?? 0) - (posture.hinge.y + posture.hinge.h / 2 - plan.foldGap / 2)
      : Math.max(insets.bottom, 12);

  return (
    <View style={{ flex: 1 }} onLayout={measure}>
      {/* the panes */}
      {two ? (
        <View
          style={{
            flex: 1,
            flexDirection: plan.paneAxis,
            padding: plan.gutter,
            paddingLeft: plan.gutter + (plan.nav === "rail" && plan.navSide === "left" ? RAIL_W : 0),
            paddingRight: plan.gutter + (plan.nav === "rail" && plan.navSide === "right" ? RAIL_W : 0),
          }}
        >
          <View style={plan.paneAxis === "row" ? { width: split.first } : { height: split.first }}>
            {plan.paneAxis === "column" ? reader : list}
          </View>
          {/* the seam: flat, an empty gutter; half-open, the keep-out band with its hairline pair */}
          <View
            style={
              plan.paneAxis === "row"
                ? { width: split.gap, flexDirection: "row", justifyContent: "space-between" }
                : { height: split.gap, flexDirection: "column", justifyContent: "space-between" }
            }
          >
            {plan.foldPaint === "hairlines" ? (
              <>
                <View
                  style={
                    plan.paneAxis === "row"
                      ? { width: StyleSheet.hairlineWidth * 2, backgroundColor: t.c.hairSoft }
                      : { height: StyleSheet.hairlineWidth * 2, backgroundColor: t.c.hairSoft }
                  }
                />
                <View
                  style={
                    plan.paneAxis === "row"
                      ? { width: StyleSheet.hairlineWidth * 2, backgroundColor: t.c.hairSoft }
                      : { height: StyleSheet.hairlineWidth * 2, backgroundColor: t.c.hairSoft }
                  }
                />
              </>
            ) : null}
          </View>
          <View style={{ flex: 1 }}>{plan.paneAxis === "column" ? list : reader}</View>
        </View>
      ) : (
        <View style={{ flex: 1 }}>{children ?? list ?? reader}</View>
      )}

      {/* the navigation, in the one glass grammar, positioned by the plan */}
      {plan.nav === "dock" ? (
        <GlassDock
          items={nav.items}
          activeId={nav.activeId}
          onItemPress={nav.onItemPress}
          search={nav.search}
        />
      ) : plan.nav === "rail" ? (
        <View
          pointerEvents="box-none"
          style={{
            position: "absolute",
            top: insets.top + 6,
            bottom: railBottom,
            left: plan.navSide === "left" ? Math.max(insets.left, 0) : undefined,
            right: plan.navSide === "right" ? Math.max(insets.right, 0) : undefined,
            zIndex: t.zLayer.tabBar,
          }}
        >
          <GlassRail groups={railGroups} foldInto={plan.railCarriesReaderVerbs ? "sheet" : "none"} />
        </View>
      ) : null}

      {/* the destinations drawer — over the list pane's region, never across the hinge */}
      {drawer !== null && drawer !== undefined && plan.drawer ? (
        <View
          pointerEvents="box-none"
          style={[
            StyleSheet.absoluteFill,
            two && plan.paneAxis === "row"
              ? { right: undefined, width: plan.gutter + split.first + (plan.navSide === "left" ? RAIL_W : 0) }
              : null,
          ]}
        >
          <GlassSidebar
            open={drawer.open}
            onClose={drawer.onClose}
            side={posture.split === "right" ? "right" : "left"}
            label={drawer.label}
          >
            {drawer.content}
          </GlassSidebar>
        </View>
      ) : null}
    </View>
  );
}

export type { ScaffoldPlan };
