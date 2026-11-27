import { useCallback, useEffect, useRef, useState, type ComponentPropsWithRef } from "react";
import { Animated, Easing, Platform, ScrollView, View, type GestureResponderEvent } from "react-native";
import { PULL_FIRE, PULL_HOLD, PULL_MAX, PULL_RATE, PULL_SLOP, pullEnd, pullMove, pullOffset, pullStart, type PullTrack } from "@ohmail/app-logic/touch";
import { pullMark } from "@ohmail/tokens";
import { useTheme } from "../theme";
import { mailColors } from "../theme/mail";
import type { PullToSync } from "../state/pull";
import { androidPullSurface } from "./android-pull-native";

type ScrollProps = ComponentPropsWithRef<typeof ScrollView>;

export function PullScroll({ refresh, ...props }: ScrollProps & { refresh?: PullToSync }) {
  return refresh ? <RefreshableScroll {...props} refresh={refresh} /> : <ScrollView {...props} />;
}

function RefreshableScroll({ ref, refresh, onScroll, scrollEnabled = true, scrollEventThrottle, ...props }: ScrollProps & { refresh: PullToSync }) {
  const { reduceMotion, c } = useTheme();
  const ios = Platform.OS === "ios";
  const stretch = useRef(0);
  const iosRebound = useRef(false);
  const [offset] = useState(() => new Animated.Value(0));
  const [androidMotion] = useState(() => ios ? undefined :
    Animated.event([{ nativeEvent: { offset } }], { useNativeDriver: true }));
  const [bounce] = useState(() => new Animated.Value(0));
  const [position] = useState(() => ios ? Animated.subtract(offset, bounce) : offset);
  const [waiting, setWaiting] = useState(false);
  const scroll = useRef<ScrollView | null>(null);
  const nativePosition = useRef({ y: props.contentOffset?.y ?? 0, inset: props.contentInset?.top ?? 0 });
  const atTop = () => nativePosition.current.y + nativePosition.current.inset <= 1;
  const track = useRef<PullTrack | null>(null);
  const dragging = useRef(false);
  const pending = useRef(false);
  const alive = useRef(true);
  const setScroll = useCallback((node: ScrollView | null) => {
    scroll.current = node;
    if (typeof ref === "function") return ref(node);
    if (ref) ref.current = node;
  }, [ref]);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; offset.stopAnimation(); };
  }, [offset]);

  const settle = (toValue: number) => {
    if (reduceMotion) offset.setValue(toValue);
    else Animated.timing(offset, {
      toValue, duration: pullMark.settleMs, easing: Easing.bezier(...pullMark.settleEasing), useNativeDriver: true, isInteraction: false,
    }).start();
  };
  const move = (event: GestureResponderEvent) => {
    if (track.current === null) return false;
    const { pageX, pageY } = event.nativeEvent;
    track.current = pullMove(track.current, pageX, pageY, atTop());
    return track.current?.claimed ?? false;
  };
  const finish = (cancelled: boolean) => {
    const hadDrag = dragging.current;
    const decision = pullEnd(track.current, cancelled || !hadDrag, pending.current || refresh.refreshing);
    track.current = null;
    dragging.current = false;
    if (!hadDrag) return;
    if (pending.current) { settle(PULL_HOLD); return; }
    if (!decision.hold || (!decision.run && !refresh.pending)) { settle(0); return; }

    pending.current = true;
    setWaiting(true);
    settle(PULL_HOLD);
    const done = () => {
      pending.current = false;
      if (alive.current) {
        setWaiting(false);
        const { y, inset } = nativePosition.current;
        if (dragging.current) {
          if (ios) offset.setValue(track.current?.offset ?? 0);
        } else if (!atTop()) {
          // Preserve the visible row when the person has scrolled on during the check.
          offset.setValue(0);
          scroll.current?.scrollTo({ y: Math.max(-inset, y - PULL_HOLD), animated: false });
        } else settle(0);
      }
    };
    try {
      void Promise.resolve(decision.run ? refresh.onRefresh() : refresh.pending).then(done, done);
    } catch {
      done();
    }
  };

  const draw = () => offset.setValue(Math.max(track.current?.offset ?? 0, pending.current ? PULL_HOLD : 0));

  const content = (
    <>
      <PullMark offset={offset} waiting={waiting} />
      <Animated.View style={{ flex: 1, backgroundColor: ios ? undefined : c.canvas, transform: [{ translateY: position }] }}>
        <ScrollView
          {...props}
          ref={setScroll}
          scrollEnabled={scrollEnabled}
          alwaysBounceVertical={ios || props.alwaysBounceVertical}
          scrollEventThrottle={ios ? 16 : scrollEventThrottle ?? 16}
          onScroll={(e) => {
            const { contentInset, contentOffset } = e.nativeEvent;
            const inset = contentInset?.top ?? 0;
            nativePosition.current = { y: contentOffset.y, inset };
            if (ios) {
              stretch.current = Math.max(0, -contentOffset.y - inset);
              if (iosRebound.current) {
                bounce.setValue(stretch.current);
                if (stretch.current === 0 && !dragging.current) iosRebound.current = false;
              }
            }
            onScroll?.(e);
          }}
        />
      </Animated.View>
    </>
  );

  if (Platform.OS === "android") {
    const Surface = androidPullSurface();
    return (
      <Surface
        style={{ flex: 1, overflow: "hidden" }}
        enabled={scrollEnabled}
        slop={PULL_SLOP}
        rate={PULL_RATE}
        maximum={PULL_MAX}
        hold={waiting ? PULL_HOLD : 0}
        onPullClaim={() => { dragging.current = true; }}
        onPullMotion={androidMotion!}
        onPullFinish={({ nativeEvent }) => {
          dragging.current = true;
          if (!nativeEvent.cancelled) {
            track.current = { x: 0, y: 0, claimed: true, offset: pullOffset(nativeEvent.distance) };
          }
          finish(nativeEvent.cancelled);
        }}
      >
        {content}
      </Surface>
    );
  }

  return (
    <View
      style={{ flex: 1, overflow: "hidden" }}
      onTouchStart={(e) => {
        if (e.nativeEvent.touches.length !== 1) { finish(true); return; }
        if (!scrollEnabled) return;
        const { pageX, pageY } = e.nativeEvent;
        track.current = pullStart(pageX, pageY, atTop());
      }}
      onTouchMove={(e) => {
        // UIKit's pan keeps ordinary scrolling, and the root still sees the finger's
        // actual travel and cancellation. Compensate for UIKit's own top overscroll.
        if (!move(e)) return;
        if (!dragging.current) {
          dragging.current = true;
          iosRebound.current = true;
          bounce.setValue(stretch.current);
        }
        draw();
      }}
      onTouchCancel={() => finish(true)}
      onTouchEnd={(e) => {
        move(e);
        finish(false);
      }}
    >
      {content}
    </View>
  );
}

function PullMark({ offset, waiting }: { offset: Animated.Value; waiting: boolean }) {
  const t = useTheme();
  const [cycle] = useState(() => new Animated.Value(0));
  useEffect(() => {
    if (!waiting || t.reduceMotion) return;
    const lap = Animated.loop(Animated.timing(cycle, {
      toValue: pullMark.beats.length, duration: pullMark.busyMs, easing: Easing.linear,
      useNativeDriver: true, isInteraction: false,
    }));
    lap.start();
    return () => { lap.stop(); cycle.setValue(0); };
  }, [cycle, waiting, t.reduceMotion]);

  const size = waiting ? pullMark.squareSize : pullMark.dragSize;
  const opacity = offset.interpolate({ inputRange: [0, pullMark.revealDistance], outputRange: [0, 1], extrapolate: "clamp" });
  const center = offset.interpolate({ inputRange: [0, 2], outputRange: [-size / 2, 1 - size / 2] });
  const grow = offset.interpolate({ inputRange: [0, PULL_FIRE], outputRange: [pullMark.minScale, 1], extrapolate: "clamp" });
  const fill = offset.interpolate({ inputRange: [PULL_FIRE - 1, PULL_FIRE], outputRange: [0, 1], extrapolate: "clamp" });
  const round = t.face !== "ohmarchy";
  return (
    <Animated.View
      pointerEvents="none" accessible={false} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden
      style={{ position: "absolute", top: 0, left: 0, right: 0, alignItems: "center", opacity, transform: [{ translateY: center }] }}
    >
      {waiting ? (
        <View style={{ flexDirection: "row", gap: pullMark.squareGap }}>
          {pullMark.beats.map((beat) => {
            const dot = beat === pullMark.beats.length - 1;
            const pulse = (rest: number) => t.reduceMotion ? (dot ? 1 : rest) : cycle.interpolate({
              inputRange: [beat, beat + 0.5, beat + 1], outputRange: [rest, 1, rest], extrapolate: "clamp",
            });
            return (
              <Animated.View key={beat} style={{
                width: size, height: size, borderRadius: dot ? (round ? size / 2 : 0) : pullMark.squareRadius,
                backgroundColor: dot ? t.c.accent : t.mail ? mailColors(t)["sq-read"] : t.c.ink3,
                opacity: pulse(pullMark.restOpacity), transform: [{ scale: pulse(pullMark.restScale) }],
              }} />
            );
          })}
        </View>
      ) : (
        <Animated.View style={{ width: size, height: size, borderRadius: round ? size / 2 : 0,
          borderWidth: pullMark.dragStroke, borderColor: t.c.accent, transform: [{ scale: grow }] }}>
          <Animated.View style={{ position: "absolute", top: 0, bottom: 0, left: 0, right: 0,
            borderRadius: round ? size / 2 : 0, opacity: fill, backgroundColor: t.c.accent }} />
        </Animated.View>
      )}
    </Animated.View>
  );
}
