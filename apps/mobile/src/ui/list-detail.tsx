/**
 * List-detail on the big-screen postures — the selected row and the reader side by side,
 * one composition every mail list mounts. The LAW lives in `scaffold/plan.ts`
 * (`scaffoldPlan`, `paneSplit` — the functions `AppScaffold` renders too); this renders it
 * inside the tab navigator, whose nav the tab bar owns. The list ends at the hinge, the
 * reader begins past it (flat: no keep-out; half-open: the band with its hairline pair);
 * the sidebar toggle opens the destinations drawer over the list only — never across the
 * hinge; search sits at the list pane's foot wherever the nav carries no pill. CONTINUITY: the selection is
 * the route's `open` param, and when the pane goes the reading migrates to the pushed route.
 */
import { useEffect, useState, type ReactNode } from "react";
import { Platform, ScrollView, StyleSheet, View, type LayoutChangeEvent } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router, useLocalSearchParams, usePathname } from "expo-router";
import { Copy } from "../copy";
import { useTheme } from "../theme";
import { useWorld } from "../state/world";
import { Empty, Rule, Screen, Tap, Txt } from "./base";
import { GlassRail, GlassSidebar } from "./glass";
import { Icon } from "./Icon";
import { MoreNav, Nav } from "./MoreNav";
import { PaneChromeContext } from "./pane-chrome";
import { useAppWindow, usePosture, useStatusCluster } from "./posture";
import { useReaderRail } from "./reader-rail";
import { paneFootSearch, paneSplit, railHome, scaffoldPlan, RAIL_W } from "./scaffold/plan";

const platformName = Platform.OS === "ios" ? ("ios" as const) : ("android" as const);

/**
 * The screen half of the pair: the `open` param as selection, and one press verb that
 * SELECTS beside a second pane and PUSHES without one — the same row, both postures.
 */
export function useListDetail(toRoute: (id: string) => string): {
  open: string | null;
  openRow: (id: string) => void;
  close: () => void;
  twoPane: boolean;
} {
  const posture = usePosture();
  const plan = scaffoldPlan(posture, platformName);
  const params = useLocalSearchParams<{ open?: string }>();
  const open = typeof params.open === "string" && params.open !== "" ? params.open : null;
  return {
    open,
    openRow: (id: string) => {
      if (plan.panes === 2) router.setParams({ open: id });
      else router.push(toRoute(id));
    },
    close: () => router.setParams({ open: "" }),
    twoPane: plan.panes === 2,
  };
}

export function ListDetail({
  open,
  onClose,
  toRoute,
  list,
  renderDetail,
}: {
  /** The selection — the route's `open` param, held by the caller via {@link useListDetail}. */
  open: string | null;
  onClose: () => void;
  /** The pushed route for one-pane postures — where a selection migrates when the pane goes. */
  toRoute: (id: string) => string;
  /** The existing list screen body, unchanged — it is the one pane when no second exists. */
  list: ReactNode;
  /** The reading pane's content for a selection (a message, or a sender's decision view). */
  renderDetail: (id: string, ctx: { inPane: boolean; onClose: () => void }) => ReactNode;
}) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const posture = usePosture();
  const plan = scaffoldPlan(posture, platformName);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [box, setBox] = useState<{ w: number; h: number } | null>(null);
  const measure = (e: LayoutChangeEvent) =>
    setBox({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height });

  /* THE PANE WENT (folding mid-read): hand the open message to the pushed route — the same
     reading, moved; the id survives and `pane-memory` restores the scroll. The route is
     pushed BEFORE the param clears so no frame renders the bare list over an open reading. */
  const twoPane = plan.panes === 2;
  useEffect(() => {
    if (!twoPane && open !== null) {
      router.push(toRoute(open));
      onClose();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [twoPane, open]);

  if (!twoPane) {
    /* The transition frame before the effect lands keeps the reader up — never a list flash. */
    if (open !== null) return <Screen>{renderDetail(open, { inPane: false, onClose })}</Screen>;
    return <>{list}</>;
  }

  const split = box === null ? null : paneSplit(posture, plan, box.w, box.h);
  const railPad = plan.nav === "rail" ? RAIL_W : 0;

  const listPane = (
    <PaneChromeContext.Provider value={plan.drawer ? { openDrawer: () => setDrawerOpen(true) } : null}>
      <View style={{ flex: 1 }}>
        <View style={{ flex: 1 }}>{list}</View>
        {/* The search field at the list pane's foot, with New mail beside it — Mail's shape on
            the iPad and the Duo's inner portrait (owner rule 5 keeps search in every
            navigation). They open `app/search.tsx` and `app/compose.tsx`. Where the nav IS the
            rail its pill already carries both, so the foot stands down rather than render the
            same controls twice (`paneFootSearch`). */}
        {paneFootSearch(plan, platformName) ? (
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 8,
              marginHorizontal: 14,
              marginTop: 8,
              marginBottom: Math.max(insets.bottom, 12),
            }}
          >
            <Tap
              accessibilityRole="button"
              accessibilityLabel={Copy.search}
              onPress={() => router.push("/search")}
              style={{
                flex: 1,
                flexDirection: "row",
                alignItems: "center",
                gap: 9,
                paddingHorizontal: 14,
                minHeight: 44,
                borderRadius: t.radius.pill,
                backgroundColor: t.c.tint,
              }}
            >
              <Icon name="search" size={14} color={t.c.ink3} />
              <Txt variant="meta" tone="ink3">
                {Copy.search}
              </Txt>
            </Tap>
            <Tap
              accessibilityRole="button"
              accessibilityLabel={Copy.composeNew}
              onPress={() => router.push("/compose")}
              style={{
                alignItems: "center",
                justifyContent: "center",
                width: 44,
                minHeight: 44,
                borderRadius: t.radius.pill,
                backgroundColor: t.c.tint,
              }}
            >
              <Icon name="pen" size={14} color={t.c.ink3} />
            </Tap>
          </View>
        ) : null}
      </View>
    </PaneChromeContext.Provider>
  );

  const readerPane =
    open !== null ? (
      renderDetail(open, { inPane: true, onClose })
    ) : (
      <View style={{ flex: 1, justifyContent: "center" }}>
        <Empty title={Copy.paneNothingOpen} hint={Copy.paneNothingOpenHint} />
      </View>
    );

  const hair = (
    <View
      style={
        plan.paneAxis === "row"
          ? { width: StyleSheet.hairlineWidth * 2, backgroundColor: t.c.hairSoft }
          : { height: StyleSheet.hairlineWidth * 2, backgroundColor: t.c.hairSoft }
      }
    />
  );

  return (
    <Screen>
      <View style={{ flex: 1 }} onLayout={measure}>
        {split !== null ? (
          <View
            style={{
              flex: 1,
              flexDirection: plan.paneAxis,
              padding: plan.gutter,
              paddingLeft: plan.gutter + (plan.navSide === "left" ? railPad : 0),
              paddingRight: plan.gutter + (plan.navSide === "right" ? railPad : 0),
            }}
          >
            <View style={plan.paneAxis === "row" ? { width: split.first } : { height: split.first }}>
              {plan.paneAxis === "column" ? readerPane : listPane}
            </View>
            {/* The seam: flat, an empty gutter; half-open, the keep-out band with its
                hairline pair; a hardware hinge is its own width and nothing is painted. */}
            <View
              style={
                plan.paneAxis === "row"
                  ? { width: split.gap, flexDirection: "row", justifyContent: "space-between" }
                  : { height: split.gap, flexDirection: "column", justifyContent: "space-between" }
              }
            >
              {plan.foldPaint === "hairlines" ? (
                <>
                  {hair}
                  {hair}
                </>
              ) : null}
            </View>
            <View style={{ flex: 1 }}>{plan.paneAxis === "column" ? listPane : readerPane}</View>
          </View>
        ) : null}
      </View>

      {/* The reader's rail (unfolded-landscape Duo, message open): the claim the reader
          published — the tab bar's nav yields to it, so the ONE right-edge rail carries
          back · reply · reply all · forward, Done · Park · Junk, ⋯ and nothing twice. */}
      <ReaderRailHost />

      {/* The destinations drawer — over the list pane's region, never across the hinge. */}
      {plan.drawer ? (
        <View
          pointerEvents="box-none"
          style={[
            StyleSheet.absoluteFill,
            split !== null && plan.paneAxis === "row"
              ? { right: undefined, width: plan.gutter + split.first + (plan.navSide === "left" ? railPad : 0) }
              : null,
          ]}
        >
          <GlassSidebar
            open={drawerOpen}
            onClose={() => setDrawerOpen(false)}
            side={posture.split === "right" ? "right" : "left"}
            label={Copy.sidebar}
          >
            <DrawerContent onNavigate={() => setDrawerOpen(false)} />
          </GlassSidebar>
        </View>
      ) : null}
    </Screen>
  );
}

/**
 * The claimed reader rail, rendered wherever the reader can hold it: the list-detail pair AND
 * the pushed full-screen routes (the closed Duo's reader; gate-held and folder mail on the
 * unfolded-landscape Duo — their verbs must still stand somewhere, and this is where). The
 * claim is `reader-rail`'s; the root nav rail yields to it; nothing renders twice.
 */
export function ReaderRailHost() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const posture = usePosture();
  const plan = scaffoldPlan(posture, platformName);
  const readerRail = useReaderRail();
  const win = useAppWindow();
  const cluster = useStatusCluster();
  if (!(plan.railCarriesReaderVerbs && readerRail !== null)) return null;
  /* The same home the nav rail takes (`railHome`): the closed Duo's reserved strip, below the
     status cluster; the inner display's right edge. */
  const home = railHome(plan, insets, { w: win.width, h: win.height }, cluster);
  return (
    <View
      pointerEvents="box-none"
      style={{
        position: "absolute",
        top: home.top,
        bottom: home.bottom,
        left: home.x,
        width: home.width,
        alignItems: "center",
        zIndex: t.zLayer.tabBar,
      }}
    >
      <GlassRail groups={readerRail.groups} foldInto="sheet" />
    </View>
  );
}

/**
 * The drawer's content — the account line, the five destinations with the engine's own
 * counts (the same fields the dock badges read), then everything the More screen carries
 * (`MoreNav`, shared, so the two lists cannot drift). Prototype v5: "the destinations …
 * live behind the sidebar toggle as a drawer over the list pane".
 */
function DrawerContent({ onNavigate }: { onNavigate: () => void }) {
  const w = useWorld();
  const insets = useSafeAreaInsets();
  const pathname = usePathname();
  const go = (path: string) => {
    onNavigate();
    router.navigate(path);
  };
  // The current destination still renders — pressing it just closes the drawer, which is
  // what `router.navigate` to the same route does; no decorated "you are here" state here.
  const dest = (path: string, label: string, count: number) => (
    <Nav label={label} count={count} onPress={() => (pathname === path ? onNavigate() : go(path))} />
  );
  return (
    <ScrollView contentContainerStyle={{ paddingTop: insets.top + 14, paddingBottom: insets.bottom + 14 }}>
      <View style={{ paddingHorizontal: 20, paddingBottom: 10 }}>
        <Txt variant="cardTitle" numberOfLines={1}>
          {w.account.name}
        </Txt>
        <Txt variant="caption" tone="ink3" numberOfLines={1} style={{ marginTop: 2 }}>
          {w.account.email}
        </Txt>
      </View>
      {dest("/", Copy.ohbox, w.ohbox.unread)}
      {dest("/screener", Copy.screener, w.screener.waiting.length)}
      {dest("/reads", Copy.reads, w.reads.newCount)}
      {dest("/receipts", Copy.receipts, w.receipts.newCount)}
      <Rule inset={20} />
      <MoreNav onNavigate={onNavigate} />
    </ScrollView>
  );
}
