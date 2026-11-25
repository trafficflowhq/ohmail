import { spacing } from "@ohmail/tokens";
import type { ReactNode } from "react";
import { Platform, StyleSheet, View } from "react-native";
import Svg, { Circle } from "react-native-svg";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Copy } from "../copy";
import { useTheme } from "../theme";
import { onboardingLook, points } from "../theme/onboarding";
import { onboardingDisplay, onboardingTagType, onboardingType } from "../theme/type";
import { Button, Screen, Scroller, Tap, Txt, useTopPad } from "./base";
import { Icon } from "./Icon";
import { useNavDrawn } from "./nav-drawn";
import { usePosture } from "./posture";
import { scaffoldPlan } from "./scaffold/plan";
import { UnsavedChanges } from "./UnsavedChanges";

export function useOnboardingLook() {
  return onboardingLook(useTheme());
}

export function OnboardingPage({
  back, aside, children, actions, actionBelow, centered = false, row = false, showUnsaved = false,
}: {
  back?: () => void;
  aside?: ReactNode;
  children: ReactNode;
  actions?: ReactNode;
  actionBelow?: ReactNode;
  centered?: boolean;
  row?: boolean;
  showUnsaved?: boolean;
}) {
  const { palette } = useOnboardingLook();
  const top = useTopPad(0);
  const { bottom } = useSafeAreaInsets();
  const posture = usePosture();
  const railBack = useNavDrawn() && scaffoldPlan(posture, Platform.OS === "ios" ? "ios" : "android").nav === "rail";
  return (
    <Screen style={{ backgroundColor: palette.stage }}>
      <View style={{ paddingTop: top }}>
        <View style={row && back === undefined && aside === undefined ? undefined : styles.top}>
          {back !== undefined && !railBack ? (
            <Tap
              onPress={back}
              accessibilityRole="button"
              accessibilityLabel={Copy.back}
              style={[styles.back, { backgroundColor: palette.sheet, borderColor: palette["ctl-ring"] }]}
            >
              <Icon name="back" size={22} color={palette.ink} />
            </Tap>
          ) : null}
          {aside !== undefined ? <View style={styles.aside}>{aside}</View> : null}
        </View>
      </View>
      {showUnsaved ? <UnsavedChanges /> : null}
      <Scroller bounded avoidKeyboard contentStyle={[styles.scroll, { paddingBottom: 24 + bottom }]}>
        <View style={centered ? styles.centered : styles.content}>{children}</View>
        {actions !== undefined ? (
          actionBelow === undefined ? (
            <View style={[styles.actions, row ? styles.actionRow : undefined]}>{actions}</View>
          ) : (
            <View style={styles.actions}>
              <View style={row ? styles.actionRow : styles.actionStack}>{actions}</View>
              {actionBelow}
            </View>
          )
        ) : null}
      </Scroller>
    </Screen>
  );
}

export function OnboardingTitle({ text, compact = false, end = "hot" }: {
  text: string;
  compact?: boolean;
  end?: "hot" | "ink" | "none";
}) {
  return <Txt accessibilityRole="header" {...useOnboardingTitle(text, compact, end)} />;
}

export function useOnboardingTitle(text: string, compact = false, end: "hot" | "ink" | "none" = "hot") {
  const { palette, type } = useOnboardingLook();
  const display = onboardingDisplay(type, compact);
  const size = display.fontSize;
  const words = text.endsWith(".") ? text.slice(0, -1) : text;
  const radius = size * points(type["dot-size"]) / 2;
  return {
    accessibilityLabel: text,
    style: [display, { color: palette.ink }],
    children: <>{words}{end === "none" || /[!?]$/.test(words) ? null : (
      <Svg width={radius * 2} height={radius * 2} style={{ marginLeft: size * 0.08 }} accessible={false}>
        <Circle cx={radius} cy={radius} r={radius} fill={end === "ink" ? palette.ink : palette.hot} />
      </Svg>
    )}</>,
  };
}

export function OnboardingTag({ label, accessibilityLabel, onPress, expanded, large, disclosure }: {
  label: string;
  accessibilityLabel?: string;
  onPress?: () => void;
  expanded?: boolean;
  large?: boolean;
  disclosure?: boolean;
}) {
  const { palette, type } = useOnboardingLook();
  const words = <Txt style={[onboardingTagType(type, large), { color: palette.ink2 }]}>{label}</Txt>;
  const shape = {
    alignSelf: "flex-start" as const,
    backgroundColor: palette.soft,
    paddingVertical: 4,
    paddingHorizontal: 9,
    borderRadius: 999,
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: 4,
  };
  return onPress === undefined ? <View style={shape}>{words}</View> : (
    <Tap
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ expanded: expanded }}
      onPress={onPress}
      style={shape}
    >
      {words}
      {disclosure ? (
        <View style={{ transform: [{ rotate: expanded ? "180deg" : "0deg" }] }}>
          <Icon name="down" size={14} color={palette.ink2} />
        </View>
      ) : null}
    </Tap>
  );
}

export function OnboardingButton({ label, onPress, kind = "ink", short = false, grow = false, subtle = false }: {
  label: string;
  onPress: () => void;
  kind?: "ink" | "quiet" | "soft" | "sheet";
  short?: boolean;
  grow?: boolean;
  subtle?: boolean;
}) {
  return (
    <Button label={label} onPress={onPress} appearance={useOnboardingButton(kind, short, subtle)}
      style={grow ? styles.grow : undefined} />
  );
}

export function useOnboardingButton(kind: "ink" | "quiet" | "soft" | "sheet" = "ink", short = false, subtle = false) {
  const { palette, type } = useOnboardingLook();
  return {
    color: kind === "ink" ? palette["on-solid"] : subtle ? palette.ink2 : palette.ink,
    surface: {
      ...styles.button,
      backgroundColor: kind === "ink" ? palette.solid :
        kind === "soft" ? palette.soft : kind === "sheet" ? palette.sheet : "transparent",
      minHeight: points(type[short ? "h-s" : "h-xl"]),
    },
    text: styles.buttonText,
  };
}

const styles = StyleSheet.create({
  top: { width: "100%", maxWidth: 640, alignSelf: "center", paddingHorizontal: 24, height: 52, flexDirection: "row", alignItems: "center" },
  back: { width: 44, height: 44, alignItems: "center", justifyContent: "center", borderRadius: 22, borderWidth: 1 },
  aside: { marginLeft: "auto" },
  scroll: { flexGrow: 1, paddingLeft: 24, paddingRight: 24 },
  centered: { flexGrow: 1, justifyContent: "center", paddingVertical: 24 },
  content: { paddingTop: 24 },
  actions: { marginTop: "auto", paddingTop: 24, gap: spacing.scale[3] },
  actionRow: { flexDirection: "row", gap: spacing.scale[3] },
  actionStack: { gap: spacing.scale[3] },
  button: { alignItems: "center", justifyContent: "center", borderRadius: 999, paddingHorizontal: 16, paddingVertical: 8 },
  buttonText: { textAlign: "center", ...onboardingType.button },
  grow: { flex: 1 },
});
