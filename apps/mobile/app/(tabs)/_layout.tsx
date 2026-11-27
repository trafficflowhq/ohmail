/**
 * The tab navigation, in the flying-menu grammar — one glass material, positioned by posture
 * (`src/ui/scaffold/plan.ts`): compact phones get the bottom dock with the search pill beside
 * it (Material's/Apple's position); the closed Duo, a compact-height landscape and a split get
 * the vertical rail, which the ROOT renders (`src/ui/nav-rail.tsx`) so it stands on the pushed
 * screens too. The five destinations, their routes and their badges are the old dock's.
 *
 * NO WORDMARK here: the chrome is navigation, and the space is the app's.
 */
import { MailAppearance } from "../../src/theme/mail";
import { useTheme } from "../../src/theme";
import { router, Tabs } from "expo-router";
import { memo, type RefObject, useCallback, useEffect, useRef, useState } from "react";
import { Platform, useWindowDimensions, View } from "react-native";
import { useWorld } from "../../src/state/world";
import { beginMark, endMark } from "../../src/engine/ui-marks";
import { Gated } from "../../src/ui/Gated";
import { ProfileImportCard } from "../../src/ui/ProfileImportCard";
import { SeedOfferCard } from "../../src/ui/SeedOfferCard";
import { type IconName } from "../../src/ui/Icon";
import { MailPlacesDrawer } from "../../src/ui/MailPlacesDrawer";
import { GlassDock, type DockItem } from "../../src/ui/glass";
import { dockFold, nextRoom } from "../../src/ui/glass/fold";
import { publishFolded } from "../../src/ui/nav-fold";
import { usePosture } from "../../src/ui/posture";
import { usePushMailPlace, type PlaceNavigation } from "../../src/ui/place-navigation";
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
  state: { index: number; routes: { key: string; name: string; params?: object }[] };
  navigation: {
    emit: (event: {
      type: "tabPress";
      target: string;
      canPreventDefault: true;
    }) => { defaultPrevented: boolean };
    navigate: (name: string) => void;
    preload: (name: string) => void;
    getState: () => NavProps["state"];
    getParent: () => PlaceNavigation | undefined;
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
      {/* Another ohmail's settings in the mailbox: the organizer files no stranger and writes no
          decision until this is answered, so it stands above the lists. */}
      <ProfileImportCard />
      {/* The people this account wrote to, once that question is answered: one card at a time. */}
      <SeedOfferCard />
      <MailAppearance>
        <MailTabs />
      </MailAppearance>
    </Gated>
  );
}

function MailTabs() {
  const t = useTheme();
  const [drawer, setDrawer] = useState(false);
  const [active, setActive] = useState<string | null>("index");
  const move = useRef<(place: string) => void>(() => undefined);
  const drawerOpen = useRef(false);
  const close = useCallback(() => {
    drawerOpen.current = false;
    setDrawer(false);
  }, []);
  const open = useCallback((place: string | null) => {
    drawerOpen.current = true;
    setActive(place);
    setDrawer(true);
  }, []);
  const onActive = useCallback((place: string | null) => {
    if (drawerOpen.current) setActive(place);
  }, []);
  return (
    <View style={{ flex: 1 }}>
      <View style={{ flex: 1 }} accessibilityElementsHidden={drawer} importantForAccessibility={drawer ? "no-hide-descendants" : "auto"}>
        <MailTabNavigator onMore={t.mail ? open : undefined} onActive={onActive} onNavigate={move} />
      </View>
      <MailPlacesDrawer open={drawer} active={active} onClose={close}
        onPlace={(place) => move.current(place)} onCompose={() => router.push("/compose")} />
    </View>
  );
}

const MailTabNavigator = memo(function MailTabNavigator({ onMore, onActive, onNavigate }: {
  onMore?: (place: string | null) => void;
  onActive: (place: string | null) => void;
  onNavigate: RefObject<(place: string) => void>;
}) {
  useLocale();
  return (
    <Tabs
      screenOptions={{ headerShown: false, freezeOnBlur: true, sceneStyle: { backgroundColor: "transparent" } }}
      tabBar={(props) => <GlassNav {...props} onMore={onMore}
        onActive={onActive} onNavigate={onNavigate} />}
    >
      {TABS.map((tab) => (
        <Tabs.Screen key={tab.name} name={tab.name} options={{ title: tab.label }} />
      ))}
    </Tabs>
  );
});

function GlassNav({ state, navigation, onMore, onActive, onNavigate }: NavProps & {
  onMore?: (active: string | null) => void;
  onActive?: (active: string | null) => void;
  onNavigate: { current: (place: string) => void };
}) {
  const w = useWorld();
  const t = useTheme();
  const pushPlace = usePushMailPlace();
  const posture = usePosture();
  const plan = scaffoldPlan(posture, Platform.OS === "ios" ? "ios" : "android");
  const readerRail = useReaderRail();
  /* THE DOCK FOLDS; NOTHING CLIPS — against its own measured width (a 0 reading keeps the last). */
  const [room, setRoom] = useState<number | null>(null);
  const { width } = useWindowDimensions();

  // Prepare the Screener after the mirror settles so its first visit can use the waiting list.
  useEffect(() => {
    if (!t.mail || !w.boot.settled) return;
    const idle = requestIdleCallback(() => {
      const screener = navigation.getState().routes.find(({ name }) => name === "screener");
      if (screener && screener.params === undefined) navigation.preload("screener");
    });
    return () => cancelIdleCallback(idle);
  }, [navigation, t.mail, w.boot.settled]);

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

  const fold = dockFold(state.routes.map((r) => r.name).filter((n) => TABS.some((x) => x.name === n)), t.mail ? width : room, t.mail);
  const foldedKey = fold.folded.join(",");
  const docked = plan.nav !== "bars" && plan.nav !== "rail" && !(plan.railCarriesReaderVerbs && readerRail !== null);
  useEffect(() => {
    publishFolded("dock", docked && foldedKey !== "" ? foldedKey.split(",") : []);
    return () => publishFolded("dock", []);
  }, [foldedKey, docked]);
  const activeId = state.routes[state.index]?.name ?? null;
  /* THE SWITCH MARK ENDS in the commit that made the pressed destination active (begun in `press`). */
  useEffect(() => {
    if (activeId !== null) endMark("switch", activeId);
  }, [activeId]);
  useEffect(() => onActive?.(activeId), [activeId, onActive]);
  /* More carries what folded: `on` while the active route is one of them, a quiet count of their new mail. */
  const foldedCount = fold.folded.reduce((n, id) => n + (badgeOf[id] ?? 0), 0);
  const items: DockItem[] = fold.kept.flatMap((name) => {
    const tab = TABS.find((x) => x.name === name);
    if (!tab) return [];
    const count = name === "more" && !t.mail ? foldedCount : badgeOf[name] ?? 0;
    return [
      {
        id: name,
        icon: tab.icon,
        label: count ? Copy.ariaLabelCount(tab.label, count) : tab.label,
        badge: count,
        badgeHot: name === "screener" || (!t.mail && name === "index"),
      },
    ];
  });
  const shownActive = activeId !== null && fold.folded.includes(activeId) ? "more" : activeId;
  const press = (id: string) => {
    if (id === "more" && onMore) {
      onMore(activeId);
      return;
    }
    const route = state.routes.find((r) => r.name === id);
    if (!route) return;
    const event = navigation.emit({ type: "tabPress", target: route.key, canPreventDefault: true });
    if (id !== activeId && !event.defaultPrevented) {
      beginMark("switch", id);
      navigation.navigate(id);
    }
  };

  onNavigate.current = press;

  /* Search, in the navigation on every posture — the pill opens the mirror-search screen
     (`app/search.tsx`). */
  const search = { label: Copy.search, onPress: () => pushPlace("/search", navigation.getParent()) };
  /* Starting a mail, in the navigation on every posture — the composer route. */
  const compose = { label: t.mail ? Copy.mailWrite : Copy.composeNew, onPress: () => router.push("/compose") };

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
      <GlassDock
        items={items}
        activeId={shownActive}
        onItemPress={press}
        search={search}
        compose={compose}
        onRoom={(width) => setRoom((prev) => nextRoom(prev, width))}
      />
    </>
  );
}
