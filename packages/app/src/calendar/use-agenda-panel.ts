import { UI_KEYS, usePersistedFlag } from "@ohmail/app-logic/storage/persisted-ui";
import { useFrame } from "../frame/commands.js";
import type { LayoutPlan, Route } from "../frame/contract.js";
import { useSignal } from "../frame/feeds.js";
import { isView } from "./where.js";

export function useAgendaPanel(route: Route, plan: LayoutPlan) {
  const { commands, host } = useFrame();
  const { width, posture } = useSignal(host.device.window);
  const [closed, setClosed] = usePersistedFlag(UI_KEYS.dayAgendaClosed, false);
  const compact = width < 1120;
  const wideDay = route.place === "day" && plan.device === "desktop" && !compact;
  const visible =
    plan.device !== "phone" &&
    route.place !== "agenda" &&
    (route.words.panel === "agenda" || (!route.words.panel && wideDay && !closed));
  const toggle = () => {
    if (visible && wideDay) setClosed(true);
    else if (!visible && closed) setClosed(false);
    commands.go({
      place: isView(route.place) ? route.place : "week",
      sub: route.sub,
      open: route.open,
      words: visible ? {} : { panel: "agenda" },
    });
  };
  return { visible, compact: compact && posture === "flat", toggle };
}
