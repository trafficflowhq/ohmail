// The root barrel — see `packages/db/src/ledger-source.ts`. The local engine mounts these routes,
// so an edge from here into the hosted half would ship it.
import { clientIdempotencyKey } from "@trafficflow/db";
import {
  ServiceError, type MarkSeenBody, type MessagePatchBody, type MoveBody,
} from "@trafficflow/services/mail";
import { serviceContext } from "../context.js";
import { jsonResponse } from "../responses.js";
import type { Route } from "../router.js";
import { message, drafting, drafter, readBody, spendOf } from "./shared.js";

/**
 * §5.2 — messages. `GET /messages?view=…` is the view-partitioned list (400
 * on a missing/unknown view). `PATCH` (unread/folder), `POST …/move` and
 * `DELETE /messages/:id` are the
 * mutations: each echoes `X-Sync-Seq` from the emitted change (§3.4). `move` and `delete` are
 * idempotent (Idempotency-Key) — the service writes the idempotency row IN its tx,
 * so `deps.idempotency` is threaded through. Every read/write is
 * account-scoped in the service (404 cross-account). NO IMAP here: a move (a delete included —
 * it is a move to the provider's Trash, never an expunge) only
 * writes DESIRED state; the worker performs the physical IMAP move.
 */
export const messageRoutes: Route[] = [
  {
    method: "GET",
    pattern: "/messages",
    cost: "read",
    handler: async (req, deps) => {
      const url = new URL(req.url);
      const view = url.searchParams.get("view") ?? "";
      const cursor = url.searchParams.get("cursor") ?? undefined;
      const limitRaw = url.searchParams.get("limit");
      const limit = limitRaw != null ? Number(limitRaw) : undefined;
      // `view=folder` (the folders foundation): the folder ENTITY id addresses the list, and
      // the optional (beforeDate, beforeId) keyset is the caller's mirror boundary — page one
      // starts strictly below it so a windowed client is never re-served what it already holds.
      const folderId = url.searchParams.get("folderId") ?? undefined;
      const beforeId = url.searchParams.get("beforeId") ?? undefined;
      const beforeDate = url.searchParams.get("beforeDate") ?? undefined;
      const page = await message(deps).list(serviceContext(deps, req), {
        view, cursor, limit, folderId,
        ...(beforeId ? { before: { date: beforeDate ?? null, id: beforeId } } : {}),
      });
      return jsonResponse({ items: page.items, nextCursor: page.nextCursor });
    },
  },
  {
    // The batch body read, in TWO MODES over one route.
    //
    //  · `?after=<cursor>&limit=` — the keyset text pull, the foundation of the macOS
    //    Cloud-local text mirror. Pages the account's bodies by `messages.id`, body row only.
    //  · `?ids=a,b,c`             — the THREAD OPEN: exactly these messages, capped at 20, with
    //    the unsubscribe posture derived per row. Ids the account does not own are silently
    //    absent — never a 404, which would make the route an existence oracle for other
    //    accounts' ids. `after`/`limit` are ignored when `ids` is present.
    //
    // ONE ROUTE because it is one read of the same rows under the same ownership proof and the
    // same cost class; only the row selection differs, and a second route would have been a
    // second place to write the account scoping.
    //
    // `read`: it reads rows already stored for the caller's own account and writes nothing.
    //
    // STATIC-BEATS-PARAM, verified against `router.ts#tryMatch`/`cmpSpec` and not assumed:
    // `/messages/bodies` and `/messages/:id` are both two segments, so both match this path;
    // their specificity vectors are [1,1] and [1,0], and `cmpSpec` compares lexicographically —
    // `1 > 0` at index 1 — so the static `bodies` route always wins. `/messages/bodies` can
    // therefore never resolve to `GET /messages/:id` with `id === "bodies"`. Placed before the
    // `:id` route here only for readability; `matchRoute` picks the most specific regardless.
    method: "GET",
    pattern: "/messages/bodies",
    cost: "read",
    handler: async (req, deps) => {
      const url = new URL(req.url);
      const after = url.searchParams.get("after") ?? undefined;
      const limitRaw = url.searchParams.get("limit");
      const limit = limitRaw != null ? Number(limitRaw) : undefined;
      // Split on the wire rather than validated here: the service owns the cap and the id shape,
      // for the same reason it owns the cursor's — one place decides what this route accepts.
      // A present-but-empty `ids=` is still the ids MODE (an empty answer), never a silent
      // fall-through to the keyset page, which would send a client asking for nothing the
      // account's first fifty bodies.
      const idsRaw = url.searchParams.get("ids");
      const ids = idsRaw === null ? undefined : idsRaw.split(",").map((s) => s.trim()).filter((s) => s !== "");
      const page = await message(deps).getBodies(serviceContext(deps, req), { after, limit, ids });
      return jsonResponse({ items: page.items, nextCursor: page.nextCursor });
    },
  },
  {
    method: "GET",
    pattern: "/messages/:id",
    cost: "read",
    handler: async (req, deps, params) => {
      const dto = await message(deps).get(serviceContext(deps, req), params.id!);
      return jsonResponse(dto);
    },
  },
  {
    method: "GET",
    pattern: "/messages/:id/body",
    cost: "read",
    handler: async (req, deps, params) => {
      const dto = await message(deps).getBody(serviceContext(deps, req), params.id!);
      return jsonResponse(dto);
    },
  },
  {
    // §5.2 — the BATCH read-state route. `{ ids, unread }`, one transaction, one
    // `change_log` row per message, `flag_state.desired_seen` upserted per message so the worker
    // can put `\Seen` on the real server. Capped at 200 ids (413 above it).
    //
    // It sits BEFORE `/messages/:id` in this table only for readability — `matchRoute` compares
    // segment counts first, so `/messages` and `/messages/:id` can never contend.
    //
    // `idempotent: true` for the reason `POST …/move` carries it: this is a multi-row write
    // whose retry after a lost response would re-emit N delta rows for changes the client
    // already has. The service does not claim the key itself (unlike `move`, whose claim
    // lives in its transaction) — `withIdempotency` replays the stored response, and the
    // operation is naturally idempotent anyway, since setting `unread` to the same value twice
    // is the same end state.
    method: "PATCH",
    pattern: "/messages",
    cost: "work",
    options: { idempotent: true },
    handler: async (req, deps) => {
      const body = await readBody<MarkSeenBody>(req);
      const { items, seq } = await message(deps).markSeen(serviceContext(deps, req), body);
      return jsonResponse({ items }, { status: 200, seq });
    },
  },
  {
    method: "PATCH",
    pattern: "/messages/:id",
    cost: "work",
    handler: async (req, deps, params) => {
      const body = await readBody<MessagePatchBody>(req);
      const { dto, seq, pending } = await message(deps).patch(serviceContext(deps, req), params.id!, body);
      // A `folder` half that became a request is a 202, exactly as `POST /messages/:id/move` is —
      // this route is the same door under another name. The DTO and `seq` still describe what
      // this store actually did (an `unread` half in the same patch lands locally), and `pending`
      // says what is waiting on the install that organizes the mailbox.
      if (pending) return jsonResponse({ ...pending, dto }, { status: 202, seq });
      return jsonResponse(dto, { status: 200, seq });
    },
  },
  {
    // §5 POST /messages/:id/draft — AI draft-from-history. Assembles a
    // sensitivity-safe context (KB + this thread, `no_kb`/`no_ai`/sensitive
    // structurally excluded), calls the INJECTED drafter, and STORES a
    // `drafts` row (never sent). A `no_ai`/sensitive target is refused 422 before
    // the drafter is called. Echoes X-Sync-Seq.
    //
    // IDEMPOTENT-MARKED, and metering is what made it a prerequisite rather than a
    // nicety: `debit_draft`'s attempt key must be the CLIENT's `Idempotency-Key`,
    // and until this flag existed no such key reached the handler at all. On a metered
    // deployment the key is therefore REQUIRED (400 without it) — the same shape
    // `POST /drafts/:id/send` already uses, and for the same reason: a paid, non-repeatable
    // action needs the client to say "this is one intent" before we spend on it.
    method: "POST",
    pattern: "/messages/:id/draft",
    // `paid`: this is the model-inference call, metered against the credit ledger. It carried
    // no cost class at all until this table gained one, which made an unverified account one
    // POST away from token spend.
    cost: "paid",
    options: { idempotent: true },
    handler: async (req, deps, params) => {
      const ctx = serviceContext(deps, req);
      const credits = spendOf(deps);
      if (credits && !deps.idempotency) {
        throw new ServiceError(
          "idempotency_key_required", 400,
          "an Idempotency-Key header is required for AI drafting",
        );
      }
      const { draftId, seq } = await drafting(deps).draftFromMessage(ctx, params.id!, {
        drafter: drafter(deps),
        credits,
        attemptKey: deps.idempotency ? clientIdempotencyKey(deps.idempotency.key) : undefined,
        idempotency: deps.idempotency
          ? {
              key: deps.idempotency.key,
              requestHash: deps.idempotency.requestHash,
              responseStatus: 202,
              response: (r) => ({ draftId: r.draftId }),
            }
          : undefined,
      });
      return jsonResponse({ draftId }, { status: 202, seq });
    },
  },
  {
    method: "POST",
    pattern: "/messages/:id/move",
    cost: "work",
    options: { idempotent: true },
    handler: async (req, deps, params) => {
      const body = await readBody<MoveBody>(req);
      const result = await message(deps).move(serviceContext(deps, req), params.id!, body, {
        idempotency: deps.idempotency ?? null,
      });
      // 200 IS A MOVE MADE; 202 IS A MOVE ASKED FOR — the Screener route's rule (mail 0094), and
      // it is the same rule for the same reason: on a mailbox this install merely reads, nothing
      // has moved and the honest code is 202. `requestMove` stores exactly this status for the
      // idempotent replay, so the first press and its replay agree.
      if ("pending" in result) return jsonResponse(result, { status: 202 });
      return jsonResponse(result.dto, { status: 200, seq: result.seq });
    },
  },
  {
    /* §5.2 POST /messages/:id/restore — PUT A DELETED MESSAGE BACK WHERE IT WAS (mail 0099).
     *
     * The other end of `DELETE /messages/:id`. It writes DESIRED state and nothing else — the
     * origin `folder_state.trashed_from` recorded at the delete, resolved against the mailbox's
     * live folders and falling back to INBOX — so the mail server performs the physical move on
     * the organizer's next turn. It does NOT clear the tombstone: the mirror says the message is
     * back when the SERVER has it back, which is the whole of `MessageService.restore`'s header.
     *
     * `cost: "work"`, the class every desired-state write here carries: it writes rows for the
     * caller's own account and queues an IMAP move for the organizer. It opens no socket and
     * calls no metered third party, so it is not `paid`.
     *
     * `options: { idempotent: true }`, and the argument it replaces was wrong about one caller.
     * "Idempotent in the state" holds for a second PRESS — the message is no longer in Trash, so
     * 409 `not_in_trash` is true and moves nothing. It is false for a REPLAY: a client whose
     * first response was lost after the commit re-sends the same durable intent, and that 409
     * reads on screen as "Couldn't restore" about a restore this server is already committed to.
     * The key tells the two apart — a replay carries the first request's key and is answered with
     * the first response; a new press carries a new key and meets the state check.
     *
     * The response is `{ restoreTo, pending }` rather than the message DTO: the DTO would still
     * carry the Trash folder and a `deleted_at`, i.e. it would describe the state the caller is
     * leaving. `restoreTo` is what the surface says in its toast, and `pending` is the honest
     * middle the filing strip already renders. `X-Sync-Seq` is echoed from the recorded change
     * exactly as the other mutations do.
     */
    method: "POST",
    pattern: "/messages/:id/restore",
    cost: "work",
    options: { idempotent: true },
    handler: async (req, deps, params) => {
      const { restoreTo, pending, seq } = await message(deps).restore(
        serviceContext(deps, req), params.id!,
        { idempotency: deps.idempotency ?? null },
      );
      return jsonResponse({ restoreTo, pending }, { status: 200, seq });
    },
  },
  {
    // §5.2 DELETE — the message rides to the provider's native \Trash (worker-drained desired
    // state, NEVER an expunge) and the emitted `delete` change tombstones it in every client's
    // mirror. 422 `no_trash_folder` when the mailbox has none — the service carries the rule.
    method: "DELETE",
    pattern: "/messages/:id",
    cost: "work",
    options: { idempotent: true },
    handler: async (req, deps, params) => {
      const result = await message(deps).delete(serviceContext(deps, req), params.id!, {
        idempotency: deps.idempotency ?? null,
      });
      // 202 when the delete became a request — see the move route above.
      if ("pending" in result) return jsonResponse(result, { status: 202 });
      return jsonResponse(result.dto, { status: 200, seq: result.seq });
    },
  },
];
