import { Platform, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme } from "../../theme";
import { mailColors } from "../../theme/mail";
import { badgeAtScale } from "../../theme/type";
import { useBottomChromeSlot } from "../bottom-chrome";
import { a11yRole } from "../a11y-role";
import { Tap, Txt } from "../base";
import { NavigationIcon, type IconName, type NavigationIconName } from "../Icon";
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

type DockAction = { label: string; onPress: () => void };

const paperTabs: Partial<Record<string, NavigationIconName>> = {
  index: "ohbox",
  screener: "screener",
  reads: "reads",
  receipts: "receipts",
  more: "more",
};

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
  search: DockAction & { current?: boolean };
  compose?: DockAction;
  onRoom?: (width: number) => void;
}) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const foot = Math.max(insets.bottom, t.mail ? 16 : 10);
  const standing = useBottomChromeSlot("dock");
  return (
    <View
      pointerEvents="box-none"
      onLayout={(e) => {
        standing(foot + e.nativeEvent.layout.height);
        onRoom?.(e.nativeEvent.layout.width);
      }}
      style={{ position: "absolute", left: 0, right: 0, bottom: foot, alignItems: "center", zIndex: t.zLayer.tabBar }}
    >
      {t.mail ? (
        <View pointerEvents="box-none" style={{
          width: "100%", maxWidth: 440, flexDirection: "row", alignItems: "center",
          gap: MAIL_DOCK.groupGap, paddingHorizontal: MAIL_DOCK.sideInset,
        }}>
          <View style={[t.lift("l3"), {
            flex: 1, height: MAIL_DOCK.action, borderRadius: t.radius.pill, backgroundColor: t.c.panel,
            flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: MAIL_DOCK.groupPad / 2,
          }]}>
            {items.map((item) => (
              <PaperDockButton key={item.id} icon={paperTabs[item.id] ?? "more"} label={item.label} badge={item.badge} hot={item.badgeHot}
                current={item.id === activeId} tab onPress={() => onItemPress(item.id)} />
            ))}
          </View>
          <PaperDockButton icon="search" label={search.label} current={search.current} onPress={search.onPress} />
          {compose ? <PaperDockButton icon="pen" label={compose.label} onPress={compose.onPress} /> : null}
        </View>
      ) : (
        <View style={{ flexDirection: "row", gap: DOCK.groupGap, maxWidth: "100%", paddingHorizontal: DOCK.sideInset }}>
          <GlassPill horizontal level="l3" contentStyle={{ gap: DOCK.itemGap }}>
            {items.map((item) => (
              <GlassIconButton key={item.id} role="tab" icon={item.icon} label={item.label}
                on={item.id === activeId} size={DOCK.btn} badge={item.badge} badgeHot={item.badgeHot}
                onPress={() => onItemPress(item.id)} />
            ))}
          </GlassPill>
          <GlassPill horizontal level="l3">
            {compose ? <GlassIconButton icon="pen" label={compose.label} onPress={compose.onPress} /> : null}
            <GlassIconButton icon="search" label={search.label} size={DOCK.btn} onPress={search.onPress} />
          </GlassPill>
        </View>
      )}
    </View>
  );
}

function PaperDockButton({ icon, label, onPress, tab = false, current = false, badge, hot }: DockAction & {
  icon: NavigationIconName;
  tab?: boolean;
  current?: boolean;
  badge?: number;
  hot?: boolean;
}) {
  const t = useTheme();
  const colors = mailColors(t);
  const { fontScale } = useWindowDimensions();
  const badgeSize = badgeAtScale(fontScale);
  const write = icon === "pen";
  const size = tab ? MAIL_DOCK.btn : MAIL_DOCK.action;
  const fill = current ? colors["nav-on"] : write ? colors.solid : tab ? "transparent" : colors.sheet;
  const ink = current ? colors["on-nav-on"] : write ? colors["on-solid"] : colors.ink;
  return (
    <Tap accessibilityRole={a11yRole(tab ? "tab" : "button", Platform.OS === "ios" ? "ios" : "android")}
      accessibilityLabel={label} accessibilityState={{ selected: current }} onPress={onPress}
      style={[
        tab ? null : t.lift("l3"),
        { width: size, height: size, borderRadius: t.radius.pill, backgroundColor: fill,
          alignItems: "center", justifyContent: "center" },
      ]}>
      <NavigationIcon name={icon} size={write ? 22 : 20} color={ink} />
      {badge !== undefined && badge > 0 ? (
        <View style={{
          position: "absolute", top: 1, left: size / 2 + 2,
          minWidth: Math.max(22, badgeSize.height + 4), paddingHorizontal: 5, height: Math.max(22, badgeSize.height + 4),
          borderRadius: t.radius.pill, justifyContent: "center", alignItems: "center",
          backgroundColor: hot ? colors.hot : colors.ground,
          borderColor: current ? colors["nav-on"] : colors.sheet, borderWidth: 2,
        }}>
          <Txt variant="railCount" tabular allowFontScaling={false}
            style={{ ...badgeSize.text, includeFontPadding: false, color: hot ? colors["on-hot"] : colors.ink }}>{badge}</Txt>
        </View>
      ) : null}
    </Tap>
  );
}
