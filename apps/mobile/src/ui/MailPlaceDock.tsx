import { useState } from "react";
import { Platform, useWindowDimensions, View } from "react-native";
import { router, useLocalSearchParams, useNavigation, usePathname } from "expo-router";
import { Copy } from "../copy";
import { useWorld } from "../state/world";
import { GlassDock } from "./glass/GlassDock";
import { dockFold } from "./glass/fold";
import { MailPlacesDrawer } from "./MailPlacesDrawer";
import { morePaneKeyOf } from "./pane-routes";
import { usePushMailPlace } from "./place-navigation";
import { usePosture } from "./posture";
import { scaffoldPlan } from "./scaffold/plan";

const tabs = { index: "/", screener: "/screener", reads: "/reads", receipts: "/receipts" } as const;

/** The compact mail dock on a place opened outside the tab navigator. */
export function MailPlaceDock({ onSearch, children }: {
  onSearch?: () => void;
  children: React.ReactNode;
}) {
  const posture = usePosture();
  const { width } = useWindowDimensions();
  const world = useWorld();
  const navigation = useNavigation();
  const pushPlace = usePushMailPlace();
  const pathname = usePathname();
  const { id, pile, pane } = useLocalSearchParams<{ id?: string; pile?: string; pane?: string }>();
  const [drawer, setDrawer] = useState(false);
  if (scaffoldPlan(posture, Platform.OS === "ios" ? "ios" : "android").nav !== "dock") return children;

  const places = [
    { id: "index", icon: "ohbox", label: Copy.ohbox, badge: world.ohbox.unread },
    { id: "screener", icon: "screener", label: Copy.screener, badge: world.screener.waiting.length, badgeHot: true },
    { id: "reads", icon: "reads", label: Copy.reads, badge: world.reads.newCount },
    { id: "receipts", icon: "receipts", label: Copy.receipts, badge: world.receipts.newCount },
    { id: "more", icon: "more", label: Copy.tabMore, badge: 0 },
  ] as const;
  const { kept } = dockFold(places.map((p) => p.id), width, true);
  const items = places.filter((p) => kept.includes(p.id)).map((place) => ({
    ...place, label: place.badge ? Copy.ariaLabelCount(place.label, place.badge) : place.label,
  }));
  const searchCurrent = pathname === "/search";
  const keyedPlace = pathname.startsWith("/tag/") ? "tag" : pathname.startsWith("/folder/") ? "folder" : null;
  const active = keyedPlace ? (id ? `${keyedPlace}:${id}` : null) : morePaneKeyOf({ pathname, params: { pile, pane } });
  const go = (place: string) => {
    const path = tabs[place as keyof typeof tabs];
    if (!path) return;
    const state = navigation.getState();
    const previous = state?.routes[state.index - 1];
    const underneath = previous?.name === "(tabs)" ? previous.state : undefined;
    const selected = underneath?.routes[underneath.index ?? 0];
    // Reveal the existing tab when the destination needs no route state changes.
    if (selected?.name === place && Object.keys(selected.params ?? {}).length === 0 && !selected.state) {
      navigation.goBack();
    } else {
      router.dismissTo(path);
    }
  };
  const compose = () => router.push("/compose");
  return (
    <View style={{ flex: 1 }}>
      <View style={{ flex: 1 }} accessibilityElementsHidden={drawer} importantForAccessibility={drawer ? "no-hide-descendants" : "auto"}>
        {children}
        <GlassDock items={items} activeId={searchCurrent ? null : "more"}
          onItemPress={(id) => id === "more" ? setDrawer(true) : go(id)}
          search={{ label: Copy.search, current: searchCurrent, onPress: onSearch ?? (() => pushPlace("/search")) }}
          compose={{ label: Copy.mailWrite, onPress: compose }} />
      </View>
      <MailPlacesDrawer open={drawer} active={active} onClose={() => setDrawer(false)} onPlace={go} onCompose={compose} />
    </View>
  );
}
