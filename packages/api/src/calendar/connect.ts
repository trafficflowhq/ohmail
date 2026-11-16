/**
 * THE CALENDAR'S CONNECT DOOR, ITS ROUTES. Mounted with the calendar's other routes, only by a
 * composition that keeps a calendar; what the door is composed with is `ApiServices.calendarConnect`
 * (the address policy and the ways' switches), and an absent one refuses every way.
 *
 * NONE OF THESE DIALS: a sign-in is sealed and written, and the worker tries it. NONE IS RELAYED
 * (`relay: false` on all six): a route that carries a typed sign-in, and the routes that act on
 * what it made, are asked of the account's own server and of no door in between, until a ruling
 * says a relay may carry them. A secret rides in a body and never in a path or a query.
 */
import { isWriteKey } from "@trafficflow/db/calendar";
import {
  calendarWays, checkCalendarConnection, connectCalendar, parseConnectAsk, removeCalendarConnection, setCalendar,
  signInCalendarAgain, CalendarConnectionTaken, type CalendarConnectAsk, type CalendarConnectDoor,
} from "@trafficflow/services/calendar-connect";
import { IdempotencyRaceLost, ServiceError, sha256 } from "@trafficflow/services/mail";
import { serviceContext } from "../context.js";
import type { ApiDeps } from "../deps.js";
import { lookupIdempotent, replayOf } from "../idempotency.js";
import { answer } from "../responses.js";
import type { Route } from "../router.js";
import { readBody } from "../routes/shared.js";

const doorOf = (deps: ApiDeps): CalendarConnectDoor => ({ port: deps.services?.calendarConnect, keys: deps.keyProvider });

/** The press's key: required, printable, short. One key makes one connection. */
function connectKeyOf(req: Request): string {
  const key = req.headers.get("idempotency-key");
  if (key === null || key === "") throw new ServiceError("idempotency_key_required", 400, "Idempotency-Key header is required");
  if (!isWriteKey(key)) throw new ServiceError("validation_failed", 400, "Idempotency-Key is no key a calendar connect takes");
  return key;
}

/**
 * What a key is held to. NOT the body: the body holds a password or a subscription's address, and
 * a digest of it kept in the key's row would be a way to try guesses against either. The way and
 * the connection's id say which request this is; nothing typed is in it.
 */
const connectHashOf = (ask: CalendarConnectAsk): string =>
  sha256(`POST\n/calendar/connections\n${ask.way}\n${ask.connectionId}`).toString("hex");

export const calendarConnectRoutes: Route[] = [
  {
    /** The ways this server offers the account now. A way that is absent is off: the client holds no list of its own. */
    method: "GET",
    pattern: "/calendar/connect",
    wire: true,
    relay: false,
    cost: "read",
    handler: async (req, deps) =>
      answer<"GET /calendar/connect">()(await calendarWays(serviceContext(deps, req), deps.services?.calendarConnect)),
  },
  {
    /**
     * A calendar connected. `work`: what the sealed sign-in buys is the worker reading somebody's
     * calendar, which an unverified account may not start. `handler`: the key is read here, because
     * the middleware would keep a digest of the body (see {@link connectHashOf}); the claim is made
     * in the mutation's own transaction and a second arrival answers the first's stored `202`.
     */
    method: "POST",
    pattern: "/calendar/connections",
    wire: true,
    relay: false,
    cost: "work",
    replay: "handler",
    handler: async (req, deps) => {
      const key = connectKeyOf(req);
      const ask = parseConnectAsk(await readBody<unknown>(req));
      const ctx = serviceContext(deps, req);
      const claim = { key, requestHash: connectHashOf(ask) };
      const found = await lookupIdempotent(deps.db, ctx.accountId, key, deps.now());
      if (found) return replayOf(found, claim.requestHash);
      try {
        const { record, seq } = await connectCalendar(ctx, doorOf(deps), ask, claim);
        return answer<"POST /calendar/connections">()(record, { status: 202, seq });
      } catch (err) {
        // The same key at the same instant ends in one of two ways for the one that came second: its
        // claim is lost, or it waited on the first's row and found the id taken. Both are answered
        // by the first's stored row; with no such row the refusal stands as it is.
        if (!(err instanceof IdempotencyRaceLost) && !(err instanceof CalendarConnectionTaken)) throw err;
        const winner = await lookupIdempotent(deps.db, ctx.accountId, key, deps.now());
        if (!winner) throw err;
        return replayOf(winner, claim.requestHash);
      }
    },
  },
  {
    /** A connection removed with everything that hangs on it. The same request again goes on where one stopped. */
    method: "DELETE",
    pattern: "/calendar/connections/:id",
    wire: true,
    relay: false,
    cost: "work",
    replay: "state",
    handler: async (req, deps, params) => {
      const { removed, seq } = await removeCalendarConnection(serviceContext(deps, req), params.id!);
      return answer<"DELETE /calendar/connections/:id">()({ removed }, { status: removed ? 200 : 202, seq });
    },
  },
  {
    /** Ask the connection's provider now. `state`: a second ask inside the minute is refused, and changes nothing. */
    method: "POST",
    pattern: "/calendar/connections/:id/check",
    wire: true,
    relay: false,
    cost: "work",
    replay: "state",
    handler: async (req, deps, params) => {
      const { record, seq } = await checkCalendarConnection(serviceContext(deps, req), params.id!);
      return answer<"POST /calendar/connections/:id/check">()(record, { status: 202, seq });
    },
  },
  {
    /** The connection's sign-in typed again. `state`: the sealed sign-in is set to what the body carries, however often. */
    method: "POST",
    pattern: "/calendar/connections/:id/sign-in",
    wire: true,
    relay: false,
    cost: "work",
    replay: "state",
    handler: async (req, deps, params) => {
      const { record, seq } = await signInCalendarAgain(serviceContext(deps, req), doorOf(deps), params.id!, await readBody<unknown>(req));
      return answer<"POST /calendar/connections/:id/sign-in">()(record, { status: 202, seq });
    },
  },
  {
    /** What is the person's own of one calendar. A request that changes nothing writes nothing and names no seq. */
    method: "PATCH",
    pattern: "/calendar/calendars/:id",
    wire: true,
    relay: false,
    cost: "work",
    replay: "state",
    handler: async (req, deps, params) => {
      const { record, seq } = await setCalendar(serviceContext(deps, req), params.id!, await readBody<unknown>(req));
      return answer<"PATCH /calendar/calendars/:id">()(record, { seq });
    },
  },
];
