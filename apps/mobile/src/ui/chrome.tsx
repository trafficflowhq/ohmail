/**
 * The persistent chrome: top bar, the Screener doorbell, and the toast.
 *
 * The desktop shell has a rail and a command dock. A phone has neither, so the
 * wordmark moves into a top bar. (No search affordance yet: search over the
 * synced mirror arrives with a later update, and a control that cannot perform
 * does not render.)
 */
import { useEffect, useRef } from "react";
import { Animated, Easing, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router } from "expo-router";
import { Copy } from "../copy";
import { useTheme } from "../theme";
import { useWorld, useWorldToast } from "../state/world";
import { Icon } from "./Icon";
import { Wordmark } from "./Icon";
import { Tap, Txt } from "./base";

/* ----------------------------------------------------------------- top bar */

export function TopBar({ trailing }: { trailing?: React.ReactNode }) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  // THE FRESHNESS LABEL (INSTANT-ARCH §6.6): while the mirror on screen is stale, every tab
  // says so under the wordmark — "As of Fri 09:00 · catching up" — and says nothing once a
  // drain settles. In the shared chrome rather than any screen, the SyncBar lesson: a view can
  // only speak about itself, and the next tab added must get the sentence for free. The world
  // layer derives it (`boot.staleAsOf`, sentence-ready time or null); this renders words.
  // "Catching up" only while it is TRUE: a failed round with nothing scheduled drops the
  // activity claim and states the age alone (`staleAsOfIdle`) — the web ladder makes the same
  // call by ranking its failure arms above the stale arm.
  const boot = useWorld().boot;
  const stale = boot.staleAsOf;
  return (
    <View>
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
      </View>
      {stale !== null ? (
        <Txt
          variant="meta"
          tone="ink3"
          accessibilityRole="text"
          style={{ paddingHorizontal: 16, paddingBottom: 4 }}
        >
          {boot.syncFailure !== null ? Copy.staleAsOfIdle(stale) : Copy.staleAsOf(stale)}
        </Txt>
      ) : null}
    </View>
  );
}

/**
 * A back bar for the pushed screens (message, screener detail, settings…).
 * The Servers screen can also be the FIRST screen (the gate lands a paired but
 * disconnected phone there), where there is no history to pop — the back
 * affordance hides rather than offering a press that goes nowhere.
 */
export function DetailBar({ title, right }: { title?: string; right?: React.ReactNode }) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const canBack = router.canGoBack();
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
      {canBack ? (
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
      ) : null}
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
 * The toast. Rises once, holds, dismisses itself. Under reduced motion it
 * appears and disappears instantly — Blanc's policy is that a state change
 * becomes instant, never merely slower.
 *
 * One sentence, no undo: a rejection means the engine has already rolled the
 * act back, and a stated act needs no ceremony.
 */
export function Toast() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const { toast, dismiss } = useWorldToast();
  const anim = useRef(new Animated.Value(0)).current;
  const message = toast?.message;
  // The ID, not the text: the queue can hold two ADJACENT identical sentences (two replies
  // confirmed by one flush), and an effect keyed on the string would never re-arm the
  // dismiss timer for the second — a toast that stands forever and blocks the queue.
  const toastId = toast?.id;

  useEffect(() => {
    if (!message) return;
    Animated.timing(anim, {
      toValue: 1,
      duration: t.ms("base"),
      easing: Easing.bezier(...t.motion.easing.spring),
      useNativeDriver: true,
    }).start();
    const timer = setTimeout(dismiss, 3200);
    return () => {
      clearTimeout(timer);
      anim.setValue(0);
    };
    // `message` is rendered; `toastId` is what re-arms the timer per queue entry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toastId, anim, dismiss, t]);

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
      </View>
    </Animated.View>
  );
}
