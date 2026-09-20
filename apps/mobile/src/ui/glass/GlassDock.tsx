/**
 * The bottom dock — Material's/Apple's position, the Duo rail's look: one glass pill of round
 * icon buttons for the destinations, and the SEARCH pill beside it (search rides the
 * navigation on every device). Floats over the home-indicator band at
 * `max(10, inset)`, exactly the prototype's `.dock`; every scroller already reserves
 * `space.tabClearance`, and the canvas runs under the glass — that translucency is the point,
 * so there is no fade strip here.
 */
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme } from "../../theme";
import type { IconName } from "../Icon";
import { GlassIconButton } from "./GlassIconButton";
import { GlassPill } from "./GlassPill";

export interface DockItem {
  id: string;
  icon: IconName;
  label: string;
  badge?: number;
  badgeHot?: boolean;
}

export function GlassDock({
  items,
  activeId,
  onItemPress,
  search,
  compose,
}: {
  items: readonly DockItem[];
  activeId: string | null;
  onItemPress: (id: string) => void;
  search: { label: string; onPress: () => void };
  /** Starting a mail is a verb, not a destination — it rides the trailing pill beside search. */
  compose?: { label: string; onPress: () => void };
}) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <View
      pointerEvents="box-none"
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        bottom: Math.max(insets.bottom, 10),
        alignItems: "center",
        zIndex: t.zLayer.tabBar,
      }}
    >
      <View style={{ flexDirection: "row", gap: 8, maxWidth: "100%", paddingHorizontal: 12 }}>
        <GlassPill horizontal level="l3">
          {items.map((item) => (
            <GlassIconButton
              key={item.id}
              role="tab"
              icon={item.icon}
              label={item.label}
              on={item.id === activeId}
              badge={item.badge}
              badgeHot={item.badgeHot}
              onPress={() => onItemPress(item.id)}
            />
          ))}
        </GlassPill>
        <GlassPill horizontal level="l3">
          {compose ? (
            <GlassIconButton icon="pen" label={compose.label} onPress={compose.onPress} />
          ) : null}
          <GlassIconButton icon="search" label={search.label} onPress={search.onPress} />
        </GlassPill>
      </View>
    </View>
  );
}
