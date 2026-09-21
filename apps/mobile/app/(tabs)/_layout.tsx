/**
 * The tab navigation, in the flying-menu grammar — one glass material, positioned by posture
 * (`src/ui/scaffold/plan.ts`): compact phones get the bottom dock with the search pill beside
 * it (Material's/Apple's position); the closed Duo, a compact-height landscape and a split get
 * the vertical rail, which the ROOT renders (`src/ui/nav-rail.tsx`) so it stands on the pushed
 * screens too. The five destinations, their routes and their badges are the old dock's.
 *
 * NO WORDMARK here: the chrome is navigation, and the space is the app's.
 */
import { router, Tabs } from "expo-router";
import { Platform } from "react-native";
import { useWorld } from "../../src/state/world";
import { Gated } from "../../src/ui/Gated";
import { type IconName } from "../../src/ui/Icon";
import { GlassDock, type DockItem } from "../../src/ui/glass";
import { usePosture } from "../../src/ui/posture";
import { useReaderRail } from "../../src/ui/reader-rail";
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
  const w = useWorld();
  const posture = usePosture();
  const plan = scaffoldPlan(posture, Platform.OS === "ios" ? "ios" : "android");
  const readerRail = useReaderRail();

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

  /* Search, in the navigation on every posture — the pill opens the mirror-search screen
     (`app/search.tsx`). */
  const search = { label: Copy.search, onPress: () => router.push("/search") };
  /* Starting a mail, in the navigation on every posture — the composer route. */
  const compose = { label: Copy.composeNew, onPress: () => router.push("/compose") };

  /* THE TWO-PANE iOS POSTURES (the iPad, the unfolded-portrait Duo): no dock, no rail — the
     destinations live behind the list pane's sidebar toggle as a drawer and the search field
     sits at the pane's foot (`src/ui/list-detail.tsx`, prototype v5; a bottom dock on an
     Apple tablet was the expert review's finding). */
  if (plan.nav === "bars") return null;

  /* THE READER HOLDS THE RAIL (unfolded-landscape Duo, a message open): one rail, and it is
     carrying back · reply · reply all · forward — the nav yields rather than doubling it.
     The claim releases when the reader closes and the destinations return here. */
  if (plan.railCarriesReaderVerbs && readerRail !== null) return null;

  /* THE RAIL IS THE ROOT'S (`src/ui/nav-rail.tsx`): it stands on the pushed screens too, where
     Back leads it, and sits in the strip iOS reserves on the closed Duo. This slot yields. */
  if (plan.nav === "rail") return null;

  return (
    <>
      <GlassDock items={items} activeId={activeId} onItemPress={press} search={search} compose={compose} />
    </>
  );
}
