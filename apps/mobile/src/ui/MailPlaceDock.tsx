import { useState } from "react";
import { Platform, useWindowDimensions, View } from "react-native";
import { router } from "expo-router";
import { Copy } from "../copy";
import { useWorld } from "../state/world";
import { GlassDock } from "./glass";
import { dockFold } from "./glass/fold";
import { MailPlacesDrawer } from "./MailPlacesDrawer";
import { usePosture } from "./posture";
import { scaffoldPlan } from "./scaffold/plan";

/** The compact mail dock on a place opened outside the tab navigator. */
export function MailPlaceDock({ onSearch, children }: {
  onSearch?: () => void;
  children: React.ReactNode;
}) {
  const posture = usePosture();
  const { width } = useWindowDimensions();
  const world = useWorld();
  const [drawer, setDrawer] = useState(false);
  if (scaffoldPlan(posture, Platform.OS === "ios" ? "ios" : "android").nav !== "dock") return children;

  const places = [
    { id: "index", icon: "ohbox", label: Copy.ohbox, badge: world.ohbox.unread },
    { id: "screener", icon: "screener", label: Copy.screener, badge: world.screener.waiting.length, badgeHot: true },
    { id: "reads", icon: "reads", label: Copy.reads, badge: world.reads.newCount },
    { id: "receipts", icon: "receipts", label: Copy.receipts, badge: world.receipts.newCount },
    { id: "more", icon: "more", label: Copy.tabMore, badge: 0 },
  ] as const;
  const { kept, folded } = dockFold(places.map((p) => p.id), width, true);
  const items = places.filter((p) => kept.includes(p.id)).map((place) => {
    const badge = place.id === "more" ? places.reduce((sum, p) => sum + (folded.includes(p.id) ? p.badge : 0), 0) : place.badge;
    return { ...place, badge, label: badge ? Copy.ariaLabelCount(place.label, badge) : place.label };
  });
  const go = (place: string) => {
    if (place === "index") router.dismissTo("/");
    if (place === "screener") router.dismissTo("/screener");
    if (place === "reads") router.dismissTo("/reads");
    if (place === "receipts") router.dismissTo("/receipts");
  };
  const compose = () => router.push("/compose");
  return (
    <View style={{ flex: 1 }}>
      <View style={{ flex: 1 }} accessibilityElementsHidden={drawer} importantForAccessibility={drawer ? "no-hide-descendants" : "auto"}>
        {children}
        <GlassDock items={items} activeId={null} onItemPress={(id) => id === "more" ? setDrawer(true) : go(id)}
          search={{ label: Copy.search, onPress: onSearch ?? (() => router.push("/search")) }}
          compose={{ label: Copy.composeNew, onPress: compose }} />
      </View>
      <MailPlacesDrawer open={drawer} active={null} onClose={() => setDrawer(false)} onPlace={go} onCompose={compose} />
    </View>
  );
}
