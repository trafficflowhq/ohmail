import { createContext, useContext, type ReactNode } from "react";
import { dayOfIso, isoOfDay, nowIn, readerZones } from "@ohmail/app-logic/calendar";
import { useNow, useSettings } from "../calendar/where.js";
import { useFrame } from "../frame/commands.js";
import { useTimeZone } from "../text/index.js";
import { useMonthRun, type MonthRun } from "./use-month-run.js";

const MonthRunContext = createContext<MonthRun | null>(null);

/** The grid, heading and sidebar all follow the same visible weeks. */
export function MonthRunScope({ children }: { children: ReactNode }) {
  const { host, plan, route } = useFrame();
  const zone = useTimeZone();
  const { weekStart } = useSettings(host.wires.calendar);
  const active = route.place === "month" && plan.device !== "phone" && route.stage === null;
  const now = useNow(active);
  const picked = active ? (dayOfIso(route.sub) ?? nowIn(now, zone, readerZones())?.day) : null;
  const run = useMonthRun(picked ? isoOfDay(picked) : null, weekStart);
  return <MonthRunContext.Provider value={run}>{children}</MonthRunContext.Provider>;
}

export const useMonthViewport = () => useContext(MonthRunContext);
