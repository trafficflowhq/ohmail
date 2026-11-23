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
import { mailColors } from "../../theme/mail";
import { useBottomChromeSlot } from "../bottom-chrome";
import type { IconName } from "../Icon";
import { GlassIconButton } from "./GlassIconButton";
import { GlassPill } from "./GlassPill";
import { DOCK, MAIL_DOCK } from "./fold";

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
  onRoom,
}: {
  items: readonly DockItem[];
  activeId: string | null;
  onItemPress: (id: string) => void;
  search: { label: string; onPress: () => void };
  /** Starting a mail is a verb, not a destination — it rides the trailing pill beside search. */
  compose?: { label: string; onPress: () => void };
  /** The dock's own width, every layout — the room `dockFold` folds destinations against. */
  onRoom?: (width: number) => void;
}) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const foot = Math.max(insets.bottom, t.mail ? 16 : 10);
  const metrics = t.mail ? MAIL_DOCK : DOCK;
  const searchButton = <GlassIconButton icon="search" label={search.label} size={metrics.btn} onPress={search.onPress} />;
  /* The dock tells the toast how far up it reaches (`bottom-chrome.ts`): its foot plus its
     measured height, so the pill clears it by the same rule that clears the reader's bar. */
  const standing = useBottomChromeSlot("dock");
  return (
    <View
      pointerEvents="box-none"
      onLayout={(e) => {
        standing(foot + e.nativeEvent.layout.height);
        onRoom?.(e.nativeEvent.layout.width);
      }}
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        bottom: foot,
        alignItems: "center",
        zIndex: t.zLayer.tabBar,
      }}
    >
      <View style={{ flexDirection: "row", gap: metrics.groupGap, maxWidth: "100%", paddingHorizontal: metrics.sideInset }}>
        <GlassPill horizontal level="l3" contentStyle={{ gap: metrics.itemGap }}>
          {items.map((item) => (
            <GlassIconButton
              key={item.id}
              role="tab"
              icon={t.mail && item.id === "screener" ? "screener" : item.icon}
              glyph={t.mail && item.id === "more" ? "⋯" : undefined}
              label={item.label}
              on={item.id === activeId}
              inkFill={t.mail && item.id === activeId}
              size={metrics.btn}
              badge={item.badge}
              badgeHot={item.badgeHot}
              onPress={() => onItemPress(item.id)}
            />
          ))}
        </GlassPill>
        <GlassPill horizontal level="l3">
          {!t.mail && compose ? <GlassIconButton icon="pen" label={compose.label} onPress={compose.onPress} /> : null}
          {searchButton}
        </GlassPill>
        {t.mail && compose ? (
          <GlassPill horizontal level="l3" contentStyle={{ backgroundColor: mailColors(t).solid }}>
            <GlassIconButton icon="pen" label={compose.label} size={metrics.btn} inkFill onPress={compose.onPress} />
          </GlassPill>
        ) : null}
      </View>
    </View>
  );
}
