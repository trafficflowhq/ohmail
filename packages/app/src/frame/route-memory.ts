import { useRef } from "react";
import type { Route } from "./contract.js";
import { isCalendarPlace } from "./product.js";

/** Where each product and each transient place returns while the frame lives. */
export function useRouteMemory(route: Route, home: Route) {
  const memory = useRef<{
    lastCalendar: Route | null;
    calendarView: Route | null;
    beforeCalendarSettings: Route | null;
    lastMail: Route;
    addressFrom: Route;
    searchFrom: Route;
  }>({
    lastCalendar: null,
    calendarView: null,
    beforeCalendarSettings: null,
    lastMail: home,
    addressFrom: home,
    searchFrom: home,
  });
  if (route.stage !== null) return memory;

  const saved = memory.current;
  if (route.place !== "search") saved.searchFrom = route;
  if (isCalendarPlace(route.place)) {
    saved.lastCalendar = route;
    if (route.place !== "calsettings") saved.beforeCalendarSettings = route;
    if (route.place !== "calsettings" && route.place !== "frommail" && route.place !== "calsearch") {
      saved.calendarView = route;
    }
  } else {
    if (route.place === "address") {
      if (saved.lastMail.place !== "address") saved.addressFrom = saved.lastMail;
      else if (saved.lastMail.sub !== route.sub) saved.addressFrom = home;
    }
    saved.lastMail = route;
  }
  return memory;
}
