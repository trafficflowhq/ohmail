/**
 * ONE OF A CONVERSATION'S SQUARES — the reader's rail and the list row's strip draw the same one:
 * 10dp, solid accent unread, dimmed read, hollow the account's own; its opacity settles with the
 * panel's tint. The ring around the current one is 18dp. Corners follow the theme's control radius
 * at the web's ratios (2/8 the square, 4/8 the ring), so they are square under ohmarchy.
 */
import { useEffect, useRef } from "react";
import { Animated, Easing } from "react-native";
import { useTheme } from "../theme";
import { THREAD_READ_FADE_MS, THREAD_UNREAD_BACK_MS } from "./reader-seen";
import type { MarkKind } from "./reader-marks";

/** The ring around the current square. */
export const MARK_RING = 18;
/** The square's corner and the ring's, from the control radius (`radius.focus`, the ctl band). */
export const squareRadius = (ctl: number): number => (ctl * 2) / 8;
export const ringRadius = (ctl: number): number => (ctl * 4) / 8;

const EASE = Easing.bezier(0.22, 0.61, 0.36, 1);

export function MarkSquare({ kind }: { kind: MarkKind }) {
  const t = useTheme();
  const target = kind === "unread" ? 1 : kind === "mine" ? t.c.markMine : t.c.markRead;
  const v = useRef(new Animated.Value(target)).current;
  const was = useRef(target);
  useEffect(() => {
    if (was.current === target) return;
    was.current = target;
    if (t.reduceMotion) { v.setValue(target); return; }
    Animated.timing(v, {
      toValue: target,
      duration: kind === "unread" ? THREAD_UNREAD_BACK_MS : THREAD_READ_FADE_MS,
      easing: EASE,
      useNativeDriver: true,
    }).start();
  }, [target, kind, t.reduceMotion, v]);
  return (
    <Animated.View
      style={{
        width: 10,
        height: 10,
        opacity: v,
        backgroundColor: kind === "mine" ? "transparent" : t.c.accent,
        borderWidth: kind === "mine" ? 2 : 0,
        borderColor: t.c.accent,
        borderRadius: squareRadius(t.radius.focus),
      }}
    />
  );
}
