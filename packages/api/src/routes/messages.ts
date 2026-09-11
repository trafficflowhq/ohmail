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
 * Messages. `GET /messages?view=…` is the view-partitioned list (400 on a missing or unknown
 * view). `PATCH` (unread/folder), `POST …/move` and `DELETE /messages/:id` are the mutations;
 * each echoes `X-Sync-Seq` from the emitted change. `move` and `delete` are idempotent (the
 * service writes the idempotency row in its tx, so `deps.idempotency` is threaded). Every read
 * and write is account-scoped in the service (404 cross-account). No IMAP here: a move — a delete
 * included; it is a move to the provider's Trash, never an expunge — only writes desired state,
 * and the worker performs the physical move.
 */
export const messageRoutes: Route[] = [
  {
    method: "GET",
    pattern: "/messages",
    relay: true,
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
    // The batch body read, two modes over one route: `?after=<cursor>&limit=` — the keyset text
    // pull (the Cloud-local text mirror's foundation), body row only; `?ids=a,b,c` — the thread
    // open, capped at 20, with the unsubscribe posture derived per row; ids the account does not
    // own are silently absent — never a 404, which would be an existence oracle for other
    // accounts' ids. One route because it is one read of the same rows under the same ownership
    // proof; a second route would be a second place to write the account scoping.
    // Static-beats-param, verified against `router.ts#cmpSpec`: `/messages/bodies` and
    // `/messages/:id` are both two segments, and the static route's specificity vector wins —
    // placement before `:id` here is readability only.
    method: "GET",
    pattern: "/messages/bodies",
    relay: true,
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
    relay: true,
    cost: "read",
    handler: async (req, deps, params) => {
      const dto = await message(deps).get(serviceContext(deps, req), params.id!);
      return jsonResponse(dto);
    },
  },
  {
    method: "GET",
    pattern: "/messages/:id/body",
    relay: true,
    cost: "read",
    handler: async (req, deps, params) => {
      const dto = await message(deps).getBody(serviceContext(deps, req), params.id!);
      return jsonResponse(dto);
    },
  },
  {
    // The batch read-state route: `{ ids, unread }`, one transaction, one `change_log` row per
    // message, `flag_state.desired_seen` upserted so the worker can put `\Seen` on the real
    // server. Capped at 200 ids (413 above). Before `/messages/:id` for readability only —
    // `matchRoute` compares segment counts first. `idempotent: true` for `move`'s reason: a
    // multi-row write whose retry would re-emit N delta rows; the service does not claim the key
    // itself — `withIdempotency` replays the stored response, and setting `unread` to the same
    // value twice is the same end state anyway.
    method: "PATCH",
    pattern: "/messages",
    relay: true,
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
    relay: true,
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
    // `POST /messages/:id/draft` — AI draft-from-history. Assembles a sensitivity-safe context
    // (KB + this thread; `no_kb`/`no_ai`/sensitive structurally excluded), calls the injected
    // drafter, and stores a `drafts` row (never sent). A `no_ai`/sensitive target is refused 422
    // before the drafter is called. Echoes X-Sync-Seq. Idempotent-marked, and metering made it a
    // prerequisite: `debit_draft`'s attempt key must be the client's `Idempotency-Key`, so on a
    // metered deployment the key is required (400 without) — the `POST /drafts/:id/send` shape: a
    // paid, non-repeatable action needs the client to say "this is one intent" before we spend.
    method: "POST",
    pattern: "/messages/:id/draft",
    relay: true,
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
    relay: true,
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
    /**
     * `POST /messages/:id/restore` — put a deleted message back (mail 0099); the other end of
     * `DELETE`. It writes desired state only — the `trashed_from` origin recorded at the delete,
     * resolved against live folders, INBOX fallback — and does not clear the tombstone: the
     * mirror says the message is back when the server has it back. `cost: "work"`: rows plus a
     * queued IMAP move. `idempotent: true`, and the replaced argument was wrong about one caller:
     * a second press correctly meets 409 `not_in_trash`, but a replay of a lost response would
     * read as "Couldn't restore" about a restore already committed — the key tells them apart.
     * The response is `{ restoreTo, pending }`, not the DTO; `X-Sync-Seq` echoed.
     */
    method: "POST",
    pattern: "/messages/:id/restore",
    relay: true,
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
    relay: true,
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
