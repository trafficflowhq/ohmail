/**
 * One round 44pt button in a glass pill — the prototype's `.ebtn`: icon 17 on the 16-grid,
 * count badge at the top-right corner with a float-coloured ring, `on` in the accent wash,
 * `accent` the one solid fill (Compose, Reply). The accessible name is required — a rail of
 * icons with no names is a rail a screen reader cannot drive — and the badge joins it through
 * the caller's label (the dock passes `Copy.ariaLabelCount`).
 */
import { Platform, View } from "react-native";
import { Text } from "react-native";
import { useTheme } from "../../theme";
import { Icon, type IconName } from "../Icon";
import { Tap } from "../base";
import { a11yRole } from "../a11y-role";

export function GlassIconButton({
  icon,
  glyph,
  label,
  onPress,
  on,
  accent,
  badge,
  badgeHot,
  role = "button",
  size = 44,
  testID,
}: {
  icon?: IconName;
  /** A textual mark where no icon exists — the rail's ⋯/More. One of icon | glyph. */
  glyph?: string;
  label: string;
  onPress?: () => void;
  /** The active destination — the accent wash, the prototype's `.ebtn.on`. */
  on?: boolean;
  /** The one solid fill — Compose, Reply. */
  accent?: boolean;
  badge?: number;
  /** A hot badge is solid accent (Ohbox, Screener); a quiet one the tint track. */
  badgeHot?: boolean;
  role?: "button" | "tab";
  size?: number;
  testID?: string;
}) {
  const t = useTheme();
  const color = accent ? t.c.onAccent : on ? t.c.accentInk : t.c.ink2;
  return (
    <Tap
      accessibilityRole={a11yRole(role, Platform.OS === "ios" ? "ios" : "android")}
      accessibilityState={{ selected: role === "tab" && on === true }}
      accessibilityLabel={label}
      onPress={onPress}
      testID={testID}
      style={({ pressed }) => ({
        width: size,
        height: size,
        borderRadius: t.radius.pill,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: accent ? t.c.accent : on ? t.c.accentSoft : pressed ? t.c.tint : "transparent",
      })}
    >
      {glyph !== undefined ? (
        <Text style={[t.type.button, { color, fontWeight: "700", letterSpacing: 0.5 }]}>{glyph}</Text>
      ) : icon !== undefined ? (
        <Icon name={icon} size={17} weight={on ? 1.7 : 1.3} color={color} />
      ) : null}
      {badge !== undefined && badge > 0 ? (
        <View
          style={{
            position: "absolute",
            top: 0,
            right: 0,
            minWidth: 16,
            height: 16,
            paddingHorizontal: 4,
            borderRadius: t.radius.pill,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: badgeHot ? t.c.accent : t.c.tint2,
            borderWidth: 1.5,
            borderColor: t.c.float,
          }}
        >
          <Text
            style={[
              t.type.badge,
              { color: badgeHot ? t.c.onAccent : t.c.ink3, fontVariant: ["tabular-nums"] },
            ]}
          >
            {badge}
          </Text>
        </View>
      ) : null}
    </Tap>
  );
}
