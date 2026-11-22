/**
 * `@trafficflow/api/calendar` — the calendar's routes, mounted only by a composition that keeps a
 * calendar (the one that hands `ApiServices.calendar` in, and says `features.calendar` on
 * `/hello`). No route table re-exports them: the phone's engine carries every byte of those
 * tables, and none of the calendar's. Every later calendar route that reads or writes the
 * account's calendar asks `requireCalendarOn` first; the place suggestions read nothing of it.
 */
import { isWriteKey } from "@trafficflow/db/calendar";
import {
  calendarSettings, dismissCalendarWrite, recordCalendarWrite, retryCalendarWrite, sendInvitationProposal, setCalendarSettings, setCalendarSuggestionDismissed,
} from "@trafficflow/services/calendar";
import { ServiceError } from "@trafficflow/services";
import { serviceContext } from "../context.js";
import { answer } from "../responses.js";
import type { Route } from "../router.js";
import { sendDepsOf, sendKeyOf } from "../send-deps.js";
import { readBody } from "../routes/shared.js";
import { placesOff, readPlaceQuestion } from "./places.js";
import { calendarConnectRoutes } from "./connect.js";

export {
  makePlaceSuggester, readPlaceQuestion,
  type PlaceQuestion, type PlaceSuggester, type PlaceSuggesterConfig, type PlaceSuggesterDeps,
} from "./places.js";
export { placeRowsOf } from "./place-rows.js";

/**
 * A calendar write's key, as a device makes it for one press: required, printable, short. It is the
 * write's row for as long as the row is kept, so a second arrival is that row and never a second one.
 */
function writeKeyOf(req: Request): string {
  const key = req.headers.get("idempotency-key");
  if (key === null || key === "") throw new ServiceError("idempotency_key_required", 400, "Idempotency-Key header is required");
  if (!isWriteKey(key)) throw new ServiceError("validation_failed", 400, "Idempotency-Key is no key a calendar write takes");
  return key;
}

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
  {
    method: "PATCH",
    pattern: "/calendar/suggestions/:id",
    wire: true,
    relay: true,
    cost: "work",
    replay: "state",
    handler: async (req, deps, params) => {
      const { dismissed, seq } = await setCalendarSuggestionDismissed(
        serviceContext(deps, req), params.id!, await readBody<unknown>(req),
      );
      return answer<"PATCH /calendar/suggestions/:id">()({ dismissed }, { seq });
    },
  },
  {
    method: "POST",
    pattern: "/calendar/proposals",
    wire: true,
    relay: true,
    cost: "connection",
    replay: "guarded",
    handler: async (req, deps) => {
      const { status, seq } = await sendInvitationProposal(
        serviceContext(deps, req), await readBody<unknown>(req), sendKeyOf(req), { send: sendDepsOf(deps) },
      );
      return answer<"POST /calendar/proposals">()({ status }, { seq: seq ?? undefined });
    },
  },
  {
    /**
     * An act on an event, RECORDED: the worker carries it to the provider, and this route calls no
     * provider. `guarded`: the key is the row (one key, one row), so a second arrival answers the
     * first's state and writes nothing. `202`: the provider has not taken it yet.
     */
    method: "POST",
    pattern: "/calendar/writes",
    wire: true,
    relay: true,
    cost: "work",
    replay: "guarded",
    handler: async (req, deps) => {
      const key = writeKeyOf(req);
      const { answer: answered, seq } = await recordCalendarWrite(serviceContext(deps, req), key, await readBody<unknown>(req));
      return answer<"POST /calendar/writes">()(answered, { status: 202, seq });
    },
  },
  {
    /** A refused write owed again. A write still owed answers as it stands. */
    method: "POST",
    pattern: "/calendar/writes/:id/retry",
    wire: true,
    relay: true,
    cost: "work",
    replay: "state",
    handler: async (req, deps, params) => {
      const { answer: answered, seq } = await retryCalendarWrite(serviceContext(deps, req), params.id!);
      return answer<"POST /calendar/writes/:id/retry">()(answered, { seq });
    },
  },
  {
    /** A refused write, or one not tried yet, let go. One under way or done is refused (`calendar_write_left`). */
    method: "DELETE",
    pattern: "/calendar/writes/:id",
    wire: true,
    relay: true,
    cost: "work",
    replay: "state",
    handler: async (req, deps, params) => {
      const { answer: answered, seq } = await dismissCalendarWrite(serviceContext(deps, req), params.id!);
      return answer<"DELETE /calendar/writes/:id">()(answered, { seq });
    },
  },
  {
    /**
     * PLACES FOR AN EVENT'S PLACE FIELD (`places.ts`). What the person typed rides in the body, goes
     * on to the geocoder alone and is written nowhere; a refusal never repeats it. The session's
     * own read is the one this question costs the database. `connection`: this process asks a
     * geocoder for the caller, as `GET /img` asks a sender's host. 200 for every well-formed
     * question, the geocoder's troubles in the answer's state; `off` where no geocoder is set.
     */
    method: "POST",
    pattern: "/calendar/places/suggest",
    wire: true,
    relay: true,
    cost: "connection",
    handler: async (req, deps) => {
      const question = readPlaceQuestion(await readBody<unknown>(req));
      const places = deps.services?.places;
      return answer<"POST /calendar/places/suggest">()(places === undefined
        ? placesOff()
        : await places.suggest(deps.session!.accountId, question, { signal: req.signal, ...(deps.logger ? { logger: deps.logger } : {}) }));
    },
  },
  // The connect door: the ways, a connection made, removed, asked now and signed in again, and a calendar's own (`./connect.ts`).
  ...calendarConnectRoutes,
];
