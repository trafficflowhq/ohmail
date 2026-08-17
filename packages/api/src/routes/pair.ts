import {
  mintPairingToken, listPairingTokens, revokePairingToken,
  redeemInviteGrant, redeemDevicePair, type PairingGrant,
} from "@trafficflow/services";
import { ServiceError } from "@trafficflow/services/mail";
import { serviceContext } from "../context.js";
import { errorResponse } from "../responses.js";
import type { Route } from "../router.js";
import { json, noContent, readBody } from "./shared.js";
import { auth } from "./shared-cloud.js";

/**
 * THE PAIRING CEREMONY (`/pair*`) — mounted by `routes/self-host.ts` and by NOTHING ELSE.
 *
 * Not on the hosted table: an invite redeem there would mint a registration that bypasses the
 * billing funnel. Not on the local table: the single-user engine mints one session per launch
 * and has nobody to invite. `/hello`'s `features.pairing` is what makes the not-mounting safe —
 * a client learns the ceremony's absence from the descriptor, never from a 404 mid-flow — and
 * the composition census in `hello.test.ts` proves all three tables hold exactly what this
 * paragraph claims.
 *
 * The lifecycle, the bounds and the redeem semantics live in `packages/services/src/pairing.ts`;
 * this module is transport. Authority:
 *
 *  · **Mint and revoke are step-up-gated** (`options.stepUp`) — handing out a credential that
 *    can open the account (device-pair) or the server (invite) is a ceremony, and taking one
 *    back must never be harder than handing it out. Both are `cost: "ceremony"` on
 *    `DELETE /devices/:id`'s exact reasoning: credential lifecycle, costs nothing, and for the
 *    revoke, a verification gate in front of it would keep a leaked token alive.
 *  · **The list is `cost: "read"`** — the caller's own rows, no hashes, nothing crossing
 *    accounts (the projection is creator-scoped in the service).
 *  · **Redeem is `public + anonymous`, `cost: "unauthenticated"`** — the token IS the
 *    credential, exactly as `POST /auth/desktop-claim`'s code is, and the redeemer by
 *    definition has no session yet. `anonymous` (the `/hello` pipeline: no session resolution,
 *    no envelope above the handler) rather than desktop-claim's `public` (full pipeline),
 *    because the redeemer may be the SETUP PAGE of a server whose first account does not exist:
 *    there is no cookie to resolve, no CSRF pair to check, and a stray ambient credential must
 *    not be able to fail the request outside this handler. The census fence holds — an
 *    anonymous route is `unauthenticated`, and an unauthenticated route is public — and the
 *    handler therefore NEVER throws: every branch, the service refusals included, is mapped to
 *    the standard `ApiError` envelope here.
 *
 * Entropy is the defense on redeem (256-bit single-use tokens, TTL-bounded, grant-scoped in the
 * burn statement); there is deliberately no lockout table and no per-IP slot claim — see the
 * service header for the argument.
 */
export const pairRoutes: Route[] = [
  {
    method: "POST",
    pattern: "/pair",
    cost: "ceremony",
    options: { stepUp: true },
    handler: async (req, deps) => {
      const b = await readBody<{ grant?: unknown; label?: unknown; ttlSeconds?: unknown }>(req);
      // The casts carry wire input into the service, whose runtime whitelist and bounds are the
      // actual gate (`mintPairingToken` refuses an unknown grant and a non-integer ttl) — the
      // same division `readBody` already establishes for every other handler.
      const minted = await mintPairingToken(serviceContext(deps, req), {
        grant: b.grant as PairingGrant,
        label: typeof b.label === "string" ? b.label : null,
        ...(b.ttlSeconds !== undefined ? { ttlSeconds: b.ttlSeconds as number } : {}),
      });
      // The raw token's ONE appearance. It is not in the list read and not at rest anywhere.
      return json(minted, 200);
    },
  },
  {
    method: "GET",
    pattern: "/pair",
    cost: "read",
    handler: async (req, deps) =>
      json({ items: await listPairingTokens(serviceContext(deps, req)) }, 200),
  },
  {
    method: "DELETE",
    pattern: "/pair/:id",
    cost: "ceremony",
    options: { stepUp: true },
    handler: async (req, deps, params) => {
      const revoked = await revokePairingToken(serviceContext(deps, req), params.id!);
      // `false` is one answer for every miss (spent, expired, someone else's, unknown): the
      // caller's own GET /pair already distinguishes their rows, and nothing else's are theirs
      // to probe.
      if (!revoked) throw new ServiceError("not_found", 404, "no live pairing token of yours has this id");
      return noContent();
    },
  },
  {
    method: "POST",
    pattern: "/pair/redeem",
    cost: "unauthenticated",
    options: { public: true, anonymous: true },
    handler: async (req, deps) => {
      try {
        const b = await readBody<{ grant?: unknown; token?: unknown; email?: unknown }>(req);
        const token = typeof b.token === "string" ? b.token : "";
        const ctx = serviceContext(deps, req);
        if (b.grant === "invite") {
          const invite = await redeemInviteGrant(ctx, {
            token, email: typeof b.email === "string" ? b.email : "",
          });
          // The client's next move is `POST /auth/register` with this code — the existing
          // invite path, which stamps `email_verified_at` because the code is email-bound.
          return json({ grant: "invite", invite }, 200);
        }
        if (b.grant === "device-pair") {
          const { tokens } = await redeemDevicePair(ctx, auth(deps), { token });
          // The bearer pair and nothing else — `POST /auth/desktop-claim`'s shape. No cookie:
          // a token shown on a screen must not be spendable into a browser session.
          return json({ grant: "device-pair", tokens }, 200);
        }
        return errorResponse("validation_failed", 400, 'grant must be "invite" or "device-pair"');
      } catch (e) {
        // The ANONYMOUS pipeline has no error envelope above this handler, so the mapping
        // `withErrorEnvelope` does for every other route happens here — same envelope, same
        // codes — and anything unexpected is a content-free 500, never a stack.
        if (e instanceof ServiceError) {
          return errorResponse(e.code, e.httpStatus, e.message, e.details, e.retryable);
        }
        return errorResponse("internal", 500, "internal error");
      }
    },
  },
];
