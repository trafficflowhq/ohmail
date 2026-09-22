import {
  IdempotencyRaceLost, ServiceError, sha256,
  type CreateRuleBody, type PatchRuleBody, type RuleRemoval, type RuleRequestResult,
} from "@trafficflow/services/mail";
import { serviceContext } from "../context.js";
import { lookupIdempotent, storedResponse, type StoredIdempotent } from "../idempotency.js";
import { canonicalQuery } from "../middleware.js";
import { errorResponse, jsonResponse } from "../responses.js";
import type { Route } from "../router.js";
import { rules, readBody } from "./shared.js";

/**
 * Rules CRUD. Mutations emit a `rule` change (X-Sync-Seq echoed); all account-scoped (404
 * cross-account); invalid kind/destination/priority → 400. All three honour `Idempotency-Key`,
 * and the service writes the row in its own transaction — `idempotent: true` alone fixes nothing:
 * the middleware only exposes the handle, and a claim outside the transaction leaves the
 * concurrent case doubling the effect. What a retry costs differs per verb, and only POST is
 * about duplicate data: POST — a second rule (no unique constraint, so only the key tells a retry
 * from a deliberate duplicate); DELETE — a wrong answer, 404 for a revoke that succeeded; PATCH —
 * churn, not data.
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
    replay: "handler",

    // The key dance is done HERE rather than by `options: { idempotent: true }` for one reason:
    // the concurrent case ends in `not_found` more often than in a lost claim (the loser blocks on
    // the winner's ROW lock at the delete and wakes to zero rows), and `withIdempotency` catches
    // only the lost claim. The lookup and the hash are mirrored line for line (`canonicalQuery`
    // imported, so the two cannot drift).
    //
    // What is NOT done here is the replay's SHAPE — it was, and that is this route's defect: every
    // stored row was rendered as the ordinary 204, so a QUEUED delete replayed as done.
    handler: async (req, deps, params) => {
      const key = req.headers.get("idempotency-key");
      const accountId = deps.session?.accountId;

      /** The revoke's answer: 204, no body, the seq of the delete that actually happened. */
      const revoked = (seq: number | null): Response =>
        jsonResponse(null, { status: 204, seq: seq ?? undefined });

      /**
       * ONE VALUE IS BOTH THE ANSWER AND THE STORED RESPONSE — the shape `POST /rules` and
       * `PATCH /rules/:id` already use. `202` is a delete that removed nothing here (mail 0094):
       * the row kept is the only visible copy of a rule still running on the machine that runs
       * it, so 204 would be a false claim, and `claimRequestReplay` stores exactly this object at
       * exactly this status. A mixed account still answers 204 — the row IS gone there — and the
       * request in flight shows on the rules surface instead. What is new is that nothing
       * re-derives which of the two states it holds.
       */
      const answer = (r: RuleRemoval | RuleRequestResult): Response =>
        "pending" in r ? jsonResponse(r, { status: 202 }) : revoked(r.seq);

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

      // A DIFFERENT hash under the same key is a different request — most usefully, the same key
      // aimed at another rule's id — and that is a 409, never a silent success. A MATCHING hash
      // is answered by the row itself: this route has two statuses, and the premise that it could
      // only have stored the 204 is what made a queued delete replay as done.
      const replay = (found: StoredIdempotent): Response =>
        found.requestHash !== requestHash
          ? errorResponse("idempotency_replay", 409, "idempotency key reused with a different request")
          : storedResponse(found);

      const found = await lookupIdempotent(deps.db, accountId, key, deps.now());
      if (found) return replay(found);

      try {
        return answer(await rules(deps).remove(serviceContext(deps, req), params.id!, {
          idempotency: { key, requestHash },
        }));
      } catch (err) {
        // A concurrent same-key delete ends in two different ways, and `IdempotencyRaceLost` is
        // not the common one. Two requests deleting the same rule contend on the rules row first:
        // the loser blocks inside `tx.delete`, wakes after the winner commits, matches 0 rows and
        // throws `not_found` — never reaching the key claim. Handling only the lost claim would
        // leave the fix answering 404 for exactly the concurrent case it exists for. The lost
        // claim is reachable with one key aimed at two different ids: disjoint row locks,
        // colliding claim — resolved below to a 409, because the winner's stored hash names a
        // different path. Sound under READ COMMITTED both ways: the loser observes neither
        // outcome until the winner commits.
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
