/**
 * The vertical navigation rail, rendered ONCE at the root so it stands on every screen of the
 * postures that own it — the closed Duo's tab roots AND its pushed screens, where Back leads
 * the column (the prototype's pushed rail), the unfolded-landscape Duo's list while no message
 * is open, a split's outer edge. The tab bar yields to it (`(tabs)/_layout.tsx` renders the
 * dock alone), the reader's claim outranks it (`reader-rail.ts`, rendered by `ReaderRailHost`)
 * and the connect flow never sees it (`gateFor`). Placement is `plan.ts#railHome`'s: in the
 * safe-area strip iOS reserves on the closed Duo, below the status cluster. This file renders.
 */
import { useState } from "react";
import { Platform, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router, usePathname } from "expo-router";
import { Copy } from "../copy";
import { useLocale } from "../i18n/LocaleProvider";
import { useConnection } from "../net/connection";
import { gateFor } from "../state/gate";
import { useWorld } from "../state/world";
import { useTheme } from "../theme";
import { Txt } from "./base";
import { GlassRail, type RailAction } from "./glass";
import type { IconName } from "./Icon";
import { useAppWindow, usePosture, useStatusCluster } from "./posture";
import { useReaderRail } from "./reader-rail";
import { isTabRoute, railHome, scaffoldPlan } from "./scaffold/plan";
import { CancelRow, Sheet } from "./Sheet";

const platformName = Platform.OS === "ios" ? ("ios" as const) : ("android" as const);

/* The five destinations — labels through GETTERS, so a language switch re-reads the deck. */
const DESTINATIONS: { id: string; path: string; readonly label: string; icon: IconName }[] = [
  { id: "index", path: "/", get label() { return Copy.ohbox; }, icon: "ohbox" },
  { id: "screener", path: "/screener", get label() { return Copy.screener; }, icon: "door" },
  { id: "reads", path: "/reads", get label() { return Copy.reads; }, icon: "reads" },
  { id: "receipts", path: "/receipts", get label() { return Copy.receipts; }, icon: "receipts" },
  { id: "more", path: "/more", get label() { return Copy.tabMore; }, icon: "more" },
];

export function NavRail() {
  useLocale();
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const posture = usePosture();
  const plan = scaffoldPlan(posture, platformName);
  const readerRail = useReaderRail();
  const pathname = usePathname();
  const conn = useConnection();
  const w = useWorld();
  const win = useAppWindow();
  const cluster = useStatusCluster();
  const [searchOpen, setSearchOpen] = useState(false);

  if (plan.nav !== "rail") return null;
  if (gateFor(conn.state, conn.profiles.length).to !== "mail") return null;
  /* The reader holds the rail (a message open where the rail carries its verbs): one rail. */
  if (plan.railCarriesReaderVerbs && readerRail !== null) return null;

  /* The engine's counts over the mirror — the same fields the dock badges read. */
  const badgeOf: Record<string, number> = {
    index: w.ohbox.unread,
    screener: w.screener.waiting.length,
    reads: w.reads.newCount,
    receipts: w.receipts.newCount,
    more: 0,
  };
  const here = pathname === "/index" ? "/" : pathname;
  const active = DESTINATIONS.find((d) => d.path === here)?.id ?? null;

  const groups: RailAction[][] = [];
  if (!isTabRoute(here) && router.canGoBack()) {
    groups.push([{ id: "__back", icon: "back", label: Copy.back, fixed: true, onPress: () => router.back() }]);
  }
  groups.push(
    DESTINATIONS.map((d) => {
      const count = badgeOf[d.id] ?? 0;
      return {
        id: d.id,
        icon: d.icon,
        label: count ? Copy.ariaLabelCount(d.label, count) : d.label,
        badge: count,
        badgeHot: d.id === "screener" || d.id === "index",
        on: d.id === active,
        role: "tab" as const,
        onPress: () => {
          if (d.id !== active) router.navigate(d.path);
        },
      };
    }),
  );
  groups.push([{ id: "__search", icon: "search", label: Copy.search, fixed: true, onPress: () => setSearchOpen(true) }]);

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
      <GlassRail groups={groups} foldInto="none" />
      {/* Search rides the navigation on every posture; no search screen exists on the phone
          yet, so the press answers with the sentence the More screen states. */}
      <Sheet open={searchOpen} onClose={() => setSearchOpen(false)} label={Copy.search}>
        <View style={{ paddingHorizontal: 20, paddingVertical: 16, gap: 4 }}>
          <Txt variant="cardTitle">{Copy.search}</Txt>
          <Txt variant="note" tone="ink3">
            {Copy.searchLater}
          </Txt>
        </View>
        <CancelRow onPress={() => setSearchOpen(false)} />
      </Sheet>
    </View>
  );
}
