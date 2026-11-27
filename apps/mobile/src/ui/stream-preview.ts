import { useIsFocused } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, type SectionListProps } from "react-native";
import type { WorldMail } from "../state/live";
import { useLiveSession } from "../state/world";

const PREVIEW_WINDOW = 4;

/** Ask for a few bodies as their stream cards come into view. */
export function useStreamPreview(enabled: boolean): NonNullable<SectionListProps<WorldMail>["onViewableItemsChanged"]> {
  const engine = useLiveSession()?.engine;
  const focused = useIsFocused();
  const [visible, setVisible] = useState<string[]>([]);
  const [active, setActive] = useState(AppState.currentState === "active");
  const pending = useRef(Promise.resolve());

  useEffect(() => {
    if (!enabled || !focused) return;
    const sub = AppState.addEventListener("change", (state) => setActive(state === "active"));
    setActive(AppState.currentState === "active");
    return () => sub.remove();
  }, [enabled, focused]);

  useEffect(() => {
    if (!enabled || !focused || !active || !engine || visible.length === 0) return;
    let stopped = false;
    // Keep one request in flight. A newer viewport replaces any unstarted work.
    pending.current = pending.current.then(async () => {
      for (const id of visible) {
        if (stopped || AppState.currentState !== "active") return;
        await engine.hydrateBody(id).catch(() => undefined);
      }
    });
    return () => { stopped = true; };
  }, [enabled, focused, active, engine, visible]);

  return useCallback(({ viewableItems }) => {
    const ids = viewableItems.filter(({ index }) => index !== null).slice(0, PREVIEW_WINDOW).map(({ item }) => item.id);
    setVisible((current) => current.length === ids.length && current.every((id, index) => id === ids[index])
      ? current
      : ids);
  }, []);
}
