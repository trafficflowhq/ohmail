/**
 * `@trafficflow/api/calendar` — the calendar's routes, mounted only by a composition that keeps a
 * calendar (the one that hands `ApiServices.calendar` in, and says `features.calendar` on
 * `/hello`). No route table re-exports them: the phone's engine carries every byte of those
 * tables, and none of the calendar's. Every later calendar route asks `requireCalendarOn` first.
 */
import { calendarSettings, setCalendarSettings } from "@trafficflow/services/calendar";
import { serviceContext } from "../context.js";
import { answer } from "../responses.js";
import type { Route } from "../router.js";
import { readBody } from "../routes/shared.js";

export const calendarRoutes: Route[] = [
  {
    /** The account's calendar settings: the switch, and the preferences a calendar view reads. */
    method: "GET",
    pattern: "/calendar/settings",
    wire: true,
    relay: true,
    cost: "read",
    handler: async (req, deps) => answer<"GET /calendar/settings">()(await calendarSettings(serviceContext(deps, req))),
  },
  {
    /**
     * The switch and the preferences. `work`: switching the calendar on is what lets an account's
     * calendars be read at their providers, which an unverified account may not start. A write to
     * a value it already holds replays to the same state, and a request that changes nothing
     * writes nothing and names no seq.
     */
    method: "PATCH",
    pattern: "/calendar/settings",
    wire: true,
    relay: true,
    cost: "work",
    replay: "state",
    handler: async (req, deps) => {
      const { settings, seq } = await setCalendarSettings(serviceContext(deps, req), await readBody<unknown>(req));
      return answer<"PATCH /calendar/settings">()(settings, { seq });
    },
  },
];
