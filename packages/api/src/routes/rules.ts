import {
  IdempotencyRaceLost, ServiceError, sha256,
  type CreateRuleBody, type PatchRuleBody,
} from "@trafficflow/services/mail";
import { serviceContext } from "../context.js";
import { lookupIdempotent, type StoredIdempotent } from "../idempotency.js";
import { canonicalQuery } from "../middleware.js";
import { errorResponse, jsonResponse } from "../responses.js";
import type { Route } from "../router.js";
import { rules, readBody } from "./shared.js";

/**
 * §5.6 — rules CRUD. create/update/delete emit a `rule` change (X-Sync-Seq echoed
 * from the emitted seq, §3.4). All account-scoped in the service (404 cross-account);
 * invalid kind/destination/priority → 400.
 *
 * ALL THREE MUTATIONS honour `Idempotency-Key`, and in every case the service writes
 * the `idempotency_keys` row IN its own transaction — so `deps.idempotency` (or, for
 * DELETE, a handle this file builds) is threaded through. `idempotent: true` alone would
 * NOT have fixed anything: the middleware only EXPOSES the handle, and a claim outside the
 * mutation's transaction leaves the concurrent case (both lookups miss in autocommit)
 * doubling the effect.
 *
 * What a retry costs on each verb differs, and only `POST` was ever about duplicate DATA:
 *  - `POST`   — a second RULE. `rules` carries no unique constraint, so two identical rules
 *               are legal and only the key can tell a retry from a deliberate duplicate.
 *  - `DELETE` — a WRONG ANSWER: 404 for a revoke that succeeded.
 *  - `PATCH`  — a second `change_log` row and a different seq: churn, not data.
 */
export const rulesRoutes: Route[] = [
  {
    method: "GET",
    pattern: "/rules",
    relay: true,
    cost: "read",
    handler: async (req, deps) => {
      const items = await rules(deps).list(serviceContext(deps, req));
      return jsonResponse({ items });
    },
  },
  {
    method: "POST",
    pattern: "/rules",
    relay: true,
    cost: "work",
    // A retried creation must replay the first rule, never mint a second: `rules` has no
    // unique constraint, so two identical rules are legal and only the key can tell a
    // retry from a deliberate duplicate.
    options: { idempotent: true },
    handler: async (req, deps) => {
      const body = await readBody<CreateRuleBody>(req);
      const result = await rules(deps).create(
        serviceContext(deps, req), body, { idempotency: deps.idempotency ?? null },
      );
      // 201 IS A RULE THAT EXISTS; 202 IS A RULE ASKED FOR — the Screener route's rule, and the
      // same reason (mail 0094). On an account whose every live mailbox another install
      // organizes, no `rules` row was written and there is nothing to hand back at 201. The
      // service stores exactly this status for the idempotent replay, so a first press and its
      // replay agree. `travel` says which install each request is waiting on.
      if ("pending" in result) return jsonResponse(result, { status: 202 });
      return jsonResponse(
        // `travel` rides BESIDE the rule on a mixed account, never instead of it: the row exists
        // here AND the same edit is in flight to the installs holding the other mailboxes.
        result.travel === undefined ? result.rule : { ...result.rule, travel: result.travel },
        { status: 201, seq: result.seq },
      );
    },
  },
  {
    method: "GET",
    pattern: "/rules/:id",
    relay: true,
    cost: "read",
    handler: async (req, deps, params) => {
      const dto = await rules(deps).get(serviceContext(deps, req), params.id!);
      return jsonResponse(dto);
    },
  },
  {
    method: "PATCH",
    pattern: "/rules/:id",
    relay: true,
    cost: "work",
    // A retried edit used to emit a SECOND `rule` change at a DIFFERENT seq, waking
    // every synced client for a delta that changes nothing. The response is JSON, so this
    // verb rides the ordinary middleware replay; `RulesService.update` claims the row inside
    // its update transaction and materializes the stored DTO there too.
    options: { idempotent: true },
    handler: async (req, deps, params) => {
      const patch = await readBody<PatchRuleBody>(req);
      const result = await rules(deps).update(
        serviceContext(deps, req), params.id!, patch, { idempotency: deps.idempotency ?? null },
      );
      // 202 when the edit wrote nothing here — see the create route above. The body carries the
      // UNCHANGED rule, because that is what this install still holds.
      if ("pending" in result) return jsonResponse(result, { status: 202 });
      return jsonResponse(
        result.travel === undefined ? result.rule : { ...result.rule, travel: result.travel },
        { status: 200, seq: result.seq },
      );
    },
  },
  {
    method: "DELETE",
    pattern: "/rules/:id",
    relay: true,
    cost: "work",

    // ── DO NOT ADD `options: { idempotent: true }` HERE ──────────────────────────────────
    //
    // It would BREAK this route rather than help it. `withIdempotency` replays a stored
    // response through `jsonResponse`, which always calls `JSON.stringify(body)` and hands
    // the result to `new Response(...)`; a revoke answers **204 with no body at all**, and
    // `new Response(JSON.stringify(null), { status: 204 })` is a
    // `TypeError: Response constructor: Invalid response status code 204` — a null-body
    // status may not carry a body. Marking this route idempotent therefore turns every
    // successful REPLAY into a 500, which is worse than the 404 it was sent to fix.
    //
    // The alternative was to make the delete answer `200 {…}` so the shared path could
    // replay it verbatim. Rejected: every other DELETE in this API answers 204, and
    // `packages/client-engine/src/adapters/http-adapter.ts` documents this endpoint's
    // contract in prose ("A 204 CARRIES NO BODY, SO THERE IS NOTHING TO ECHO") — changing
    // the status would make a shipped claim false to fix a bug about wrong answers.
    //
    // So the lookup / hash / race-lost dance is done HERE, deliberately mirroring
    // `withIdempotency` line for line (including `canonicalQuery`, imported rather than
    // re-derived, so the two hashes can never drift). The moment `jsonResponse` learns to
    // emit a bodiless status, this collapses back to the one-line option above.
    handler: async (req, deps, params) => {
      const key = req.headers.get("idempotency-key");
      const accountId = deps.session?.accountId;

      /** The revoke's answer: 204, no body, the seq of the delete that actually happened. */
      const revoked = (seq: number | null): Response =>
        new Response(null, {
          status: 204,
          headers: seq === null ? {} : { "X-Sync-Seq": String(seq) },
        });

      /**
       * THE ANSWER FOR A DELETE THAT REMOVED NOTHING HERE (mail 0094).
       *
       * `204` says "it is gone". On an account whose every live mailbox another install
       * organizes, the row is deliberately NOT removed — deleting it would take away the only
       * visible copy of a rule that is still running on the machine that runs it, and the
       * organizer's next published document would put it straight back — so 204 would be the one
       * thing this route's own comment forbids: a false claim to fix a bug about wrong answers.
       * `202` is a state the shipped 204 contract never covered rather than a change to it, and
       * it is not a null-body status, so the pending state can ride the response itself instead
       * of needing a second poll.
       */
      const asked = (travel: unknown): Response => jsonResponse({ pending: true, travel }, { status: 202 });

      /**
       * A MIXED ACCOUNT STILL ANSWERS 204, and the pending half is NOT in this response.
       *
       * The row IS gone here, so 204 is true, and every other DELETE in this API answers 204 —
       * `http-adapter.ts` documents the contract in prose ("A 204 CARRIES NO BODY, SO THERE IS
       * NOTHING TO ECHO"), so widening it would make a shipped claim false. What that costs is
       * real and is stated rather than hidden: a caller deleting a rule on an account with one
       * organized and one held mailbox learns nothing here about the request in flight to the
       * other install, and has to see it on the rules surface. That surface is L-D's, and this is
       * the one place in the family where the outcome does not ride its own response.
       */
      const answer = (r: { seq: number | null; travel?: unknown }): Response =>
        r.seq === null && r.travel !== undefined ? asked(r.travel) : revoked(r.seq);

      // No key ⇒ nothing distinguishes a retry from a probe, so the service's plain 404 for
      // an id that is not there stands. `accountId` is belt-and-braces: `withSession` has
      // already 401'd an unauthenticated caller on this protected route.
      if (!key || !accountId) {
        return answer(await rules(deps).remove(serviceContext(deps, req), params.id!));
      }

      const url = new URL(req.url);
      const requestHash = sha256(
        `${req.method}\n${url.pathname}\n${canonicalQuery(url)}\n${await req.clone().text()}`,
      ).toString("hex");

      // A matching hash can only have been stored by this method at this path, so the row is
      // one of ours and its status is 204. A DIFFERENT hash under the same key is a
      // different request — most usefully, the same key aimed at another rule's id — and
      // that is a 409, never a silent success.
      const replay = (found: StoredIdempotent): Response =>
        found.requestHash !== requestHash
          ? errorResponse("idempotency_replay", 409, "idempotency key reused with a different request")
          : revoked(found.seq);

      const found = await lookupIdempotent(deps.db, accountId, key, deps.now());
      if (found) return replay(found);

      try {
        return answer(await rules(deps).remove(serviceContext(deps, req), params.id!, {
          idempotency: { key, requestHash },
        }));
      } catch (err) {
        // ── A CONCURRENT SAME-KEY DELETE ENDS IN TWO DIFFERENT WAYS ──────────────────────
        //
        // `IdempotencyRaceLost` is only ONE of them, and it is not the common one. Two
        // requests deleting the SAME rule contend on the rules ROW first: the loser blocks
        // inside `tx.delete`, wakes after the winner commits, matches 0 rows and throws
        // `not_found` — never reaching the key claim at all. Handling only the lost claim
        // would leave the fix answering 404 for exactly the concurrent case it exists for.
        //
        // The lost claim IS reachable, with one key aimed at two DIFFERENT ids: disjoint row
        // locks, colliding claim. That one resolves below to a 409, because the winner's
        // stored hash names a different path.
        //
        // Sound under READ COMMITTED both ways: the loser cannot observe either outcome
        // until the winner has COMMITTED, so the winner's key row is visible to this re-read.
        const raced = err instanceof IdempotencyRaceLost;
        const vanished = err instanceof ServiceError && err.code === "not_found";
        if (!raced && !vanished) throw err;

        const winner = await lookupIdempotent(deps.db, accountId, key, deps.now());
        // Nothing stored ⇒ this was not a race. Either the rule genuinely does not exist
        // (rethrow the honest 404, key unburnt) or the claim vanished, which is a real fault
        // and must become a 500 rather than a fabricated success.
        if (!winner) throw err;
        return replay(winner);
      }
    },
  },
];
