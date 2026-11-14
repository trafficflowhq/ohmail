import type { WireCall } from "@ohmail/client-engine";
import type { AnswerOf, RequestOf, RouteName, Untrusted } from "@ohmail/wire";
import { answer, answerBuilt, jsonResponse } from "../../src/responses.js";
import type { Route } from "../../src/router.js";

/**
 * A DRIFT BETWEEN A CLIENT AND THE SERVER DOES NOT COMPILE, PINNED WHERE THE COMPILER SEES IT.
 *
 * No runtime code and no test: assertions that exist only as types, run by `tsc` (this
 * directory is its own project, referenced from the root). Each `@ts-expect-error` below is one
 * way the two sides could come apart; the line under it MUST fail to compile, and the day it
 * stops failing the directive itself is the error. So this file is red exactly when the wire has
 * stopped holding one of them.
 *
 * Both sides are here because both are the same type: the server answers through
 * `answer<R>()(body)` with `AnswerOf<R>`, a client reads `AnswerOf<R>` (or the same names, each
 * still unchecked, `Untrusted<AnswerOf<R>>`) and sends `RequestOf<R>` through its one typed call
 * (`WireCall`, the type of the engine client's door).
 */

declare const page: AnswerOf<"GET /sync">;
declare const letter: AnswerOf<"GET /messages/:id">;

/* ── the server renames a field of an answer, alone ─────────────────────────────────────── */

const { hasMore, ...withoutHasMore } = page;
// @ts-expect-error the wire's page says `hasMore`; a server that says `more` no longer answers it
export const renamedOnTheServer = answer<"GET /sync">()({ ...withoutHasMore, more: hasMore });

// @ts-expect-error a field the wire's answer does not have is not answered either
export const addedOnTheServer = answer<"POST /messages/:id/restore">()({ restoreTo: "INBOX", pending: false, restoredTo: "INBOX" });

// @ts-expect-error one route's answer is not another's
export const anotherRoutesAnswer = answer<"GET /messages/:id/body">()(letter);

// @ts-expect-error a route that answers JSON does not build its own response
export const builtWhereTheWireSaysJson = answerBuilt<"GET /sync">(new Response(null, { status: 204 }));

/* ── the same, where the field is not written out in the answer's own literal ─────────────
   An optional field is usually spread in, and a result is often built by a service. The compiler
   checks neither against the names of the type it is given to; `answer` does. */

declare const first: { status: string; at: string } | undefined;
export const spreadOnTheServer = answer<"POST /sends/withdraw">()({ outcome: "withdrawn", ...(first ? { firstSend: first } : {}) });
// @ts-expect-error the wire says `firstSend`: spread in under another name, it is refused all the same
export const renamedInASpreadOnTheServer = answer<"POST /sends/withdraw">()({ outcome: "withdrawn", ...(first ? { firstSendAt: first } : {}) });

declare const built: AnswerOf<"POST /messages/:id/restore"> & { restoredTo?: string };
// @ts-expect-error a result built elsewhere that carries a name the wire's answer does not have
export const builtElsewhereWithAnotherName = answer<"POST /messages/:id/restore">()(built);

/* ── a client reads a field the server does not send ────────────────────────────────────── */

// @ts-expect-error `more` is not in the wire's page: a client that reads it reads nothing
export const renamedInTheClient = page.more;

declare const unchecked: Untrusted<AnswerOf<"GET /screener/held-releases">>;
// @ts-expect-error the same holds where a client checks every field itself: the names are the wire's
export const renamedInADefensiveRead = unchecked.groupz;

/* ── a client sends a field under another name, or leaves a needed one out ──────────────── */

export const move: RequestOf<"POST /messages/:id/move"> = { folder: "INBOX" };
// @ts-expect-error the move's body says `folder`
export const renamedInARequest: RequestOf<"POST /messages/:id/move"> = { dest: "INBOX" };
// @ts-expect-error a decision needs its `decision`
export const leftOutOfARequest: RequestOf<"POST /screener/:id"> = { scope: "sender" };

/* ── the same through the client's one call, a spread member included ───────────────────── */

declare const call: WireCall;
declare const from: string | undefined;
export const moved = call("POST /messages/:id/move", { params: { id: "m" }, body: { folder: "INBOX", ...(from !== undefined ? { from } : {}) } });
// @ts-expect-error the move's body says `from`: spread in as `fromFolder`, the server would read nothing
export const renamedInASpreadInTheClient = call("POST /messages/:id/move", { params: { id: "m" }, body: { folder: "INBOX", ...(from !== undefined ? { fromFolder: from } : {}) } });
// @ts-expect-error a route whose path names a letter is not asked without one
export const askedWithoutItsId = call("POST /messages/:id/move", { body: { folder: "INBOX" } });

/* ── a route marked as bound answers through the wire, in every arm ────────────────────── */

export const bound: Route = {
  method: "POST", pattern: "/messages/:id/restore", wire: true, relay: true, cost: "work",
  handler: async () => answer<"POST /messages/:id/restore">()({ restoreTo: "INBOX", pending: false }),
};

// @ts-expect-error one arm answers through a bare `jsonResponse`: the handler is not the wire's any more
export const boundWithAnEarlyReturnAroundTheWire: Route = {
  method: "POST", pattern: "/messages/:id/restore", wire: true, relay: true, cost: "work",
  handler: async (req) => {
    if (req.headers.has("x-early")) return jsonResponse({ restoredTo: "INBOX" });
    return answer<"POST /messages/:id/restore">()({ restoreTo: "INBOX", pending: false });
  },
};

// @ts-expect-error a bound route's name is its method and its pattern: this one answers as another route
export const boundAndAnsweringAsAnotherRoute: Route = {
  method: "POST", pattern: "/messages/:id/move", wire: true, relay: true, cost: "work",
  handler: async () => answer<"POST /messages/:id/restore">()({ restoreTo: "INBOX", pending: false }),
};

const plain = async (): Promise<Response> => jsonResponse({});
// @ts-expect-error the mark is for a route the wire names: this method and pattern are no entry of it
export const markedAndNotOnTheWire: Route = { method: "GET", pattern: "/no-such-route", wire: true, relay: true, cost: "work", handler: plain };

/** In a table, as the route files write them: the same holds for each element. */
export const table: Route[] = [
  { method: "GET", pattern: "/health-of-nothing", relay: false, cost: "work", handler: plain },
  // @ts-expect-error a bound route in a table does not take a handler that answers with a plain response
  { method: "POST", pattern: "/messages/:id/restore", wire: true, relay: true, cost: "work", handler: plain },
];

/* ── a route that is not on the wire cannot be asked for by name ────────────────────────── */

// @ts-expect-error not a bound route
export const noSuchRoute: RouteName = "GET /nowhere";
