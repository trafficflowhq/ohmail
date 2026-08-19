/**
 * The persistent chrome: top bar, the Screener doorbell, and the toast.
 *
 * The desktop shell has a rail and a command dock. A phone has neither, so the
 * wordmark moves into a top bar that also carries the two things a thumb wants
 * within reach — search, and the route out to everything the tabs do not hold.
 */
import { useEffect, useRef } from "react";
import { Animated, Easing, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router } from "expo-router";
import { Copy } from "../copy";
import { useTheme } from "../theme";
import { useStore } from "../state/store";
import { useWorld, useWorldToast } from "../state/world";
import { Icon } from "./Icon";
import { Wordmark } from "./Icon";
import { Tap, Txt } from "./base";

/* ----------------------------------------------------------------- top bar */

export function TopBar({ trailing }: { trailing?: React.ReactNode }) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <View
      style={{
        paddingTop: insets.top + 6,
        paddingBottom: 6,
        paddingHorizontal: 16,
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
      }}
    >
      <Wordmark color={t.c.ink} dot={t.c.accent} size={17} />
      <View style={{ flex: 1 }} />
      {trailing}
      <Tap
        onPress={() => router.push("/search")}
        accessibilityRole="button"
        accessibilityLabel={Copy.search}
        style={{ padding: 8 }}
      >
        <Icon name="search" size={17} color={t.c.ink2} />
      </Tap>
    </View>
  );
}

/** A back bar for the pushed screens (message, screener detail, settings…). */
export function DetailBar({ title, right }: { title?: string; right?: React.ReactNode }) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <View
      style={{
        paddingTop: insets.top + 6,
        paddingBottom: 8,
        paddingHorizontal: 10,
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
      }}
    >
      <Tap
        onPress={() => router.back()}
        accessibilityRole="button"
        accessibilityLabel={Copy.back}
        style={{ flexDirection: "row", alignItems: "center", gap: 4, padding: 8 }}
      >
        <View style={{ transform: [{ rotate: "180deg" }] }}>
          <Icon name="chev" size={15} color={t.c.ink2} />
        </View>
        <Txt variant="button" tone="ink2">
          {Copy.back}
        </Txt>
      </Tap>
      {title ? (
        <Txt variant="button" tone="ink3" numberOfLines={1} style={{ flexShrink: 1, marginLeft: 4 }}>
          {title}
        </Txt>
      ) : null}
      <View style={{ flex: 1 }} />
      {right}
    </View>
  );
}

/* ---------------------------------------------------------------- doorbell */

/**
 * `.doorbell` — a knock, not a nag. One tinted capsule above the Ohbox rows
 * that says how many strangers are waiting and gets out of the way when none
 * are.
 */
export function Doorbell({ initials, count }: { initials: string[]; count: number }) {
  const t = useTheme();
  if (count === 0) return null;
  return (
    <Tap
      onPress={() => router.push("/screener")}
      accessibilityRole="button"
      accessibilityLabel={`${Copy.doorbell(count)} ${Copy.doorbellRest}. ${Copy.doorbellGo}`}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        marginHorizontal: 10,
        marginBottom: 12,
        paddingLeft: 10,
        paddingRight: 16,
        paddingVertical: 9,
        borderRadius: t.radius.pill,
        backgroundColor: t.c.accentSoft,
      }}
    >
      <View style={{ flexDirection: "row" }}>
        {initials.map((i, n) => (
          <View
            key={`${i}-${n}`}
            style={[
              {
                width: 26,
                height: 26,
                borderRadius: 13,
                backgroundColor: t.c.float,
                alignItems: "center",
                justifyContent: "center",
                marginLeft: n === 0 ? 0 : -7,
              },
              t.lift("l0"),
            ]}
          >
            <Txt variant="tagchip" tone="ink2">
              {i}
            </Txt>
          </View>
        ))}
      </View>
      <Txt variant="meta" tone="ink2" numberOfLines={1} style={{ flexShrink: 1 }}>
        <Txt variant="settingsLabel" tone="ink">
          {Copy.doorbell(count)}
        </Txt>{" "}
        {Copy.doorbellRest}
      </Txt>
      <View style={{ flex: 1 }} />
      <Txt variant="button" tone="accent">
        {Copy.doorbellGo}
      </Txt>
    </Tap>
  );
}

/* ------------------------------------------------------------------- toast */

/**
 * The toast. Rises once, holds, and offers the undo when the action had one.
 * Under reduced motion it appears and disappears instantly — Blanc's policy is
 * that a state change becomes instant, never merely slower.
 *
 * Two worlds, one capsule — GATED BY THE ACTIVE WORLD. On a live session only
 * the live sentence renders (a retained fixture toast is the demo's story, and
 * showing it over real mail — or letting it out-shout a live failure — mixes
 * the worlds the split exists to keep apart); in the demo only the store's
 * toast renders, undo and all. A live rejection carries no undo: the engine
 * has already rolled the act back.
 */
export function Toast() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const { s, undo, dismissToast } = useStore();
  const w = useWorld();
  const live = useWorldToast();
  const anim = useRef(new Animated.Value(0)).current;
  const fromDemo = !w.live;
  const message = fromDemo ? s.toast?.message : live.toast?.message;
  const hasUndo = fromDemo && !!s.toast?.undo;
  const dismiss = fromDemo ? dismissToast : live.dismiss;

  useEffect(() => {
    if (!message) return;
    Animated.timing(anim, {
      toValue: 1,
      duration: t.ms("base"),
      easing: Easing.bezier(...t.motion.easing.spring),
      useNativeDriver: true,
    }).start();
    const timer = setTimeout(dismiss, hasUndo ? 6000 : 3200);
    return () => {
      clearTimeout(timer);
      anim.setValue(0);
    };
  }, [message, hasUndo, anim, dismiss, t]);

  if (!message) return null;

  return (
    <Animated.View
      pointerEvents="box-none"
      style={{
        position: "absolute",
        left: 12,
        right: 12,
        bottom: insets.bottom + 74,
        zIndex: t.zLayer.toast,
        opacity: anim,
        transform: [
          { translateY: anim.interpolate({ inputRange: [0, 1], outputRange: [10, 0] }) },
        ],
      }}
    >
      <View
        style={[
          {
            flexDirection: "row",
            alignItems: "center",
            gap: 12,
            alignSelf: "center",
            maxWidth: "100%",
            backgroundColor: t.c.float,
            borderRadius: t.radius.pill,
            paddingVertical: 10,
            paddingHorizontal: 18,
          },
          t.lift("l2"),
        ]}
      >
        <Txt variant="meta" numberOfLines={2} style={{ flexShrink: 1 }}>
          {message}
        </Txt>
        {hasUndo ? (
          <Tap onPress={undo} accessibilityRole="button" style={{ paddingVertical: 2 }}>
            <Txt variant="button" tone="accent">
              {Copy.undo}
            </Txt>
          </Tap>
        ) : null}
      </View>
    </Animated.View>
  );
}
