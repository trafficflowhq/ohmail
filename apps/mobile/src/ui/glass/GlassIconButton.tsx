/**
 * One round 44pt button in a glass pill — the prototype's `.ebtn`: icon 17 on the 16-grid,
 * count badge at the top-right corner with a float-coloured ring, `on` in the accent wash,
 * `accent` the one solid fill (Compose, Reply). The accessible name is required — a rail of
 * icons with no names is a rail a screen reader cannot drive — and the badge joins it through
 * the caller's label (the dock passes `Copy.ariaLabelCount`).
 */
import { Platform, View, useWindowDimensions } from "react-native";
import { Text } from "react-native";
import { useTheme } from "../../theme";
import { Icon, type IconName } from "../Icon";
import { Tap } from "../base";
import { a11yRole } from "../a11y-role";
import { badgeAtScale } from "../../theme/type";
import { mailColors } from "../../theme/mail";

export function GlassIconButton({
  icon,
  glyph,
  label,
  onPress,
  on,
  accent,
  inkFill = false,
  badge,
  badgeHot,
  role = "button",
  size = 44,
  testID,
  disabled,
  accessibilityHint,
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
  inkFill?: boolean;
  badge?: number;
  /** A hot badge is solid accent (Ohbox, Screener); a quiet one the tint track. */
  badgeHot?: boolean;
  role?: "button" | "tab";
  size?: number;
  testID?: string;
  disabled?: boolean;
  accessibilityHint?: string;
}) {
  const t = useTheme();
  const badgeSize = badgeAtScale(useWindowDimensions().fontScale);
  const paper = inkFill ? mailColors(t) : null;
  const badgeColors = t.mail ? mailColors(t) : null;
  const color = paper?.["on-solid"] ?? (accent ? t.c.onAccent : on ? t.c.accentInk : t.c.ink2);
  return (
    <Tap
      accessibilityRole={a11yRole(role, Platform.OS === "ios" ? "ios" : "android")}
      accessibilityState={{ selected: role === "tab" && on === true, disabled: disabled === true }}
      accessibilityLabel={label}
      accessibilityHint={accessibilityHint}
      disabled={disabled}
      onPress={onPress}
      testID={testID}
      style={({ pressed }) => ({
        width: size,
        height: size,
        borderRadius: t.radius.pill,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: paper?.solid ?? (accent ? t.c.accent : on ? t.c.accentSoft : pressed ? t.c.tint : "transparent"),
        ...(disabled ? { opacity: 0.5 } : {}),
      })}
    >
      {glyph !== undefined ? (
        <Text maxFontSizeMultiplier={t.textCap} minimumFontScale={t.textKey} style={[t.type.button, { color, fontWeight: "700", letterSpacing: 0.5 }]}>{glyph}</Text>
      ) : icon !== undefined ? (
        <Icon name={icon} size={17} weight={on ? 1.7 : 1.3} color={color} />
      ) : null}
      {badge !== undefined && badge > 0 ? (
        <View
          style={{
            position: "absolute",
            top: 0,
            right: 0,
            minWidth: badgeSize.height,
            height: badgeSize.height,
            paddingHorizontal: 4,
            borderRadius: t.radius.pill,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: badgeHot ? t.c.accent : badgeColors?.solid ?? t.c.tint2,
            borderWidth: 1.5,
            borderColor: t.c.float,
          }}
        >
          {/* The scale is applied here, from the same number as the pill, not by the OS. */}
          <Text
            maxFontSizeMultiplier={t.textCap} minimumFontScale={t.textKey}
            allowFontScaling={false}
            style={[
              t.type.badge,
              badgeSize.text,
              {
                includeFontPadding: false,
                textAlignVertical: "center",
                color: badgeHot ? t.c.onAccent : badgeColors?.["on-solid"] ?? t.c.ink3,
                fontVariant: ["tabular-nums"],
              },
            ]}
          >
            {badge}
          </Text>
        </View>
      ) : null}
    </Tap>
  );
}
