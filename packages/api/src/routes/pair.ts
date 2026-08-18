/* THE `/auth` ENTRY, not the barrel — the Phase 3 retarget. The full barrel would drag
 * `nodemailer` (its `SmtpMailer` re-export) and the paid-gate registration (its one import-time
 * side effect) into every bundle that mounts a pairing route, which the desktop-host door
 * (the desktop-host door, next slice) is about to be. The invite-grant redeem — the one arm that queries the
 * Cloud-half `invites` table — arrives through the dependency bag instead (`inviteRedeem`
 * below), so this module's import graph is shippable from the mail half alone. */
import {
  mintPairingToken, listPairingTokens, revokePairingToken,
  redeemDevicePair, type PairingGrant, type PairedDeviceSessionMinter,
} from "@trafficflow/services/auth";
import { ServiceError } from "@trafficflow/services/mail";
import { silentLogger } from "@trafficflow/core/mail";
import { serviceContext } from "../context.js";
import type { ApiDeps } from "../deps.js";
import { errorResponse } from "../responses.js";
import type { Route } from "../router.js";
import { json, noContent, readBody } from "./shared.js";

/**
 * A JSON body read as a plain object. `readBody` returns whatever `JSON.parse` produced, and
 * `null`, `[]` and a bare primitive are all valid JSON — so a handler that reads `b.grant` off
 * the raw result throws a `TypeError` on any of them, which surfaces as a 500 for what is a
 * client sending a well-formed body of the wrong SHAPE. Coercing a non-object to `{}` lets the
 * field reads yield `undefined` and the ordinary `validation_failed` path answer 400.
 */
async function readObjectBody<T extends Record<string, unknown>>(req: Request): Promise<Partial<T>> {
  const raw = await readBody<unknown>(req);
  return (raw !== null && typeof raw === "object" && !Array.isArray(raw)) ? (raw as Partial<T>) : {};
}

/**
 * The session minter for the device-pair arm — `deps.services.auth`, which every composition
 * that mounts this table fills (the hosted `AuthService` IS one; the desktop-host door will
 * wire the bare lifecycle). Read through an accessor so a misconfigured bag is the same clean
 * 500 `shared-cloud.ts#auth` answers, not a TypeError mid-ceremony. Deliberately NOT that
 * accessor itself: this module needs only {@link PairedDeviceSessionMinter}, and importing the
 * cloud accessor would put `deps-cloud.ts` — a private module — back into a file the engine
 * bundle is about to carry.
 */
function sessionMinter(deps: ApiDeps): PairedDeviceSessionMinter {
  const svc = deps.services?.auth;
  if (!svc) throw new ServiceError("internal", 500, "auth service not configured");
  return svc;
}

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
      const b = await readObjectBody<{ grant?: unknown; label?: unknown; ttlSeconds?: unknown }>(req);
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
        const b = await readObjectBody<{ grant?: unknown; token?: unknown; email?: unknown; kind?: unknown }>(req);
        const token = typeof b.token === "string" ? b.token : "";
        const ctx = serviceContext(deps, req);
        if (b.grant === "invite") {
          // Absent port ⇒ this composition's database has no `invites` table to bridge to (the
          // desktop-host door's exact position, the next slice — the desktop-host door) — a 400 the redeemer can act on,
          // never a 42P01 dressed as a 500. The self-host composition wires the real function.
          const redeemInvite = deps.services?.inviteRedeem;
          if (!redeemInvite) {
            return errorResponse(
              "validation_failed", 400, 'grant "invite" is not redeemable on this server',
            );
          }
          const invite = await redeemInvite(ctx, {
            token, email: typeof b.email === "string" ? b.email : "",
          });
          // The client's next move is `POST /auth/register` with this code — the existing
          // invite path. Whether the account starts email-verified is the minted invite row's
          // `confers_verified`, decided in the service from the CONSUMED TOKEN's own record
          // (first-boot ownerless token: yes; a user's token: no — see `redeemInviteGrant`).
          // This handler forwards `token` and `email` and nothing else, so no wire field can
          // reach that decision.
          return json({ grant: "invite", invite }, 200);
        }
        if (b.grant === "device-pair") {
          // `kind` is the redeemer's own declaration — "web" when absent, whitelist-gated in
          // the service BEFORE the burn (the same wire-input division as the mint's `grant`).
          const { tokens } = await redeemDevicePair(ctx, sessionMinter(deps), {
            token,
            ...(b.kind !== undefined ? { kind: b.kind as "web" | "macos" } : {}),
          });
          // The bearer pair and nothing else — `POST /auth/desktop-claim`'s shape. No cookie:
          // a token shown on a screen must not be spendable into a browser session.
          return json({ grant: "device-pair", tokens }, 200);
        }
        return errorResponse("validation_failed", 400, 'grant must be "invite" or "device-pair"');
      } catch (e) {
        // The ANONYMOUS pipeline has no error envelope above this handler, so the mapping AND the
        // structured logging `withErrorEnvelope` does for every other route both happen here —
        // same envelope, same codes, same 5xx trace — and anything unexpected is a content-free
        // 500, never a stack. Without the log a persistent redeem outage (a driver fault, a
        // session-mint throw) would leave no request/error-class record anywhere, which is
        // exactly the observability the envelope middleware exists to guarantee.
        const log = deps.logger ?? silentLogger;
        if (e instanceof ServiceError) {
          if (e.httpStatus >= 500) {
            log.error("request_failed", {
              method: req.method, route: "/pair/redeem", status: e.httpStatus, code: e.code, err: e,
            });
          }
          return errorResponse(e.code, e.httpStatus, e.message, e.details, e.retryable);
        }
        log.error("request_unhandled", { method: req.method, route: "/pair/redeem", status: 500, err: e });
        return errorResponse("internal", 500, "internal error");
      }
    },
  },
];
