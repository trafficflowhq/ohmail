/**
 * The tab navigation, in the flying-menu grammar — one glass material, positioned by posture
 * (`src/ui/scaffold/plan.ts`): compact phones get the bottom dock with the search pill beside
 * it (Material's/Apple's position); the closed Duo and a compact-height landscape get the
 * vertical rail on the edge the plan names; a split mirrors it to the app's half. The five
 * destinations, their routes and their badges are the ones the old dock carried, unchanged.
 *
 * NO WORDMARK here: the chrome is navigation, and the space is the app's.
 */
import { Tabs } from "expo-router";
import { useState } from "react";
import { Platform, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme } from "../../src/theme";
import { useWorld } from "../../src/state/world";
import { Gated } from "../../src/ui/Gated";
import { type IconName } from "../../src/ui/Icon";
import { Txt } from "../../src/ui/base";
import { Sheet } from "../../src/ui/Sheet";
import { GlassDock, GlassRail, type DockItem, type RailAction } from "../../src/ui/glass";
import { usePosture } from "../../src/ui/posture";
import { scaffoldPlan } from "../../src/ui/scaffold/plan";
import { Copy } from "../../src/copy";
import { useLocale } from "../../src/i18n/LocaleProvider";

/**
 * The slice of the navigator's tab-bar props this nav uses. Typed here rather than imported
 * from `@react-navigation/bottom-tabs`: that package is a transitive dependency of
 * `expo-router` and pnpm's isolated store does not expose it to this workspace, so importing
 * its types would couple the build to a hoisting accident.
 */
interface NavProps {
  state: { index: number; routes: { key: string; name: string }[] };
  navigation: {
    emit: (event: {
      type: "tabPress";
      target: string;
      canPreventDefault: true;
    }) => { defaultPrevented: boolean };
    navigate: (name: string) => void;
  };
}

/*
 * The five tab names read from the deck through GETTERS, not as captured strings. This table is
 * built at module scope, long before a language is resolved, so a plain string here would be the
 * language the process started in for the rest of its life — which is exactly what it was: two of
 * the five ("Receipts" and "More") stayed English under a German interface, and the other three
 * are the same word in both languages, so nothing looked wrong enough to notice.
 */
const TABS: { name: string; readonly label: string; icon: IconName }[] = [
  { name: "index", get label() { return Copy.ohbox; }, icon: "ohbox" },
  { name: "screener", get label() { return Copy.screener; }, icon: "door" },
  { name: "reads", get label() { return Copy.reads; }, icon: "reads" },
  { name: "receipts", get label() { return Copy.receipts; }, icon: "receipts" },
  { name: "more", get label() { return Copy.tabMore; }, icon: "more" },
];

export default function TabsLayout() {
  /* Subscribed to the language, so a switch in Settings redraws this screen instead of
     waiting for the next navigation — see `src/i18n/LocaleProvider.tsx`. */
  useLocale();
  return (
    <Gated>
      <Tabs
        screenOptions={{ headerShown: false, sceneStyle: { backgroundColor: "transparent" } }}
        tabBar={(props) => <GlassNav {...props} />}
      >
        {TABS.map((tab) => (
          <Tabs.Screen key={tab.name} name={tab.name} options={{ title: tab.label }} />
        ))}
      </Tabs>
    </Gated>
  );
}

function GlassNav({ state, navigation }: NavProps) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const window = useWindowDimensions();
  const w = useWorld();
  const posture = usePosture();
  const plan = scaffoldPlan(posture, Platform.OS === "ios" ? "ios" : "android");
  const [searchOpen, setSearchOpen] = useState(false);

  /**
   * The engine's counts over the mirror, not a third derivation computed here.
   * Both streams read `newCount`, `FeedPartition`'s own field (above this
   * device's waterline and still unread on the server) — the same number the
   * browser and desktop rails show, so one account cannot report two counts
   * for one pile. What is drawn and what is counted are different questions;
   * `WorldMail.unread` answers the first, these fields the second.
   */
  const badgeOf: Record<string, number> = {
    index: w.ohbox.unread,
    screener: w.screener.waiting.length,
    reads: w.reads.newCount,
    receipts: w.receipts.newCount,
    more: 0,
  };

  const items: DockItem[] = state.routes.flatMap((route) => {
    const tab = TABS.find((x) => x.name === route.name);
    if (!tab) return [];
    const count = badgeOf[route.name] ?? 0;
    return [
      {
        id: route.name,
        icon: tab.icon,
        label: count ? Copy.ariaLabelCount(tab.label, count) : tab.label,
        badge: count,
        badgeHot: route.name === "screener" || route.name === "index",
      },
    ];
  });
  const activeId = state.routes[state.index]?.name ?? null;
  const press = (id: string) => {
    const route = state.routes.find((r) => r.name === id);
    if (!route) return;
    const event = navigation.emit({ type: "tabPress", target: route.key, canPreventDefault: true });
    if (id !== activeId && !event.defaultPrevented) navigation.navigate(id);
  };

  /* Search, in the navigation on every posture. There is no search screen on
     the phone yet, and a silent control would be a lie — the press answers with the same
     sentence the More screen states. */
  const search = { label: Copy.search, onPress: () => setSearchOpen(true) };
  const searchSheet = (
    <Sheet open={searchOpen} onClose={() => setSearchOpen(false)} label={Copy.search}>
      <View style={{ paddingHorizontal: 20, paddingVertical: 16, gap: 4 }}>
        <Txt variant="cardTitle">{Copy.search}</Txt>
        <Txt variant="note" tone="ink3">
          {Copy.searchLater}
        </Txt>
      </View>
    </Sheet>
  );

  if (plan.nav === "rail") {
    /* This component mounts in the navigator's zero-height tab-bar slot at the window's foot,
       so the rail is anchored from the BOTTOM and given its height explicitly. */
    const groups: RailAction[][] = [
      items.map((item) => ({
        id: item.id,
        icon: item.icon,
        label: item.label,
        badge: item.badge,
        badgeHot: item.badgeHot,
        on: item.id === activeId,
        role: "tab" as const,
        onPress: () => press(item.id),
      })),
      [{ id: "__search", icon: "search" as const, label: search.label, fixed: true, onPress: search.onPress }],
    ];
    const bottomPad = Math.max(insets.bottom, 12);
    return (
      <View
        pointerEvents="box-none"
        style={{
          position: "absolute",
          bottom: bottomPad,
          height: window.height - insets.top - 6 - bottomPad,
          left: plan.navSide === "left" ? Math.max(insets.left, 0) : undefined,
          right: plan.navSide !== "left" ? Math.max(insets.right, 0) : undefined,
          zIndex: t.zLayer.tabBar,
        }}
      >
        <GlassRail groups={groups} foldInto="none" />
        {searchSheet}
      </View>
    );
  }

  return (
    <>
      <GlassDock items={items} activeId={activeId} onItemPress={press} search={search} />
      {searchSheet}
    </>
  );
}
