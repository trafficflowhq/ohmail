import { errorResponse, jsonResponse, serviceContext, type ApiDeps, type Route } from "@trafficflow/api/local";
import {
  mintPairingToken, listPairingTokens, revokePairingToken, ServiceError, type SessionLifecycle,
} from "@trafficflow/services/auth";

/**
 * THE WINDOW'S OWN PAIRING SURFACE — token mint/list/revoke AND the device list/take-back, on
 * the STDIO door, and nowhere else.
 *
 * Defined here, in the engine, rather than in the shared route tables — the same structural
 * argument as `ai-routes.ts`: mounting is what makes "this door only" a property of the module
 * graph instead of a condition in a render. `engine.ts` spreads this array into the stdio table
 * ONLY when host mode is armed; the desktop-host door (`@trafficflow/api/desktop-host`) carries
 * the anonymous REDEEM and none of this, so a remote device can never mint the very credential
 * that admits remote devices. The standalone server's `/pair*` (`packages/api/src/routes/pair.ts`)
 * is untouched and keeps its step-up gates.
 *
 * ── `stepUp: false`, AND WHY THAT IS THE HONEST GATE HERE ───────────────────────────────────
 *
 * The machine's own login IS the step-up on this tier — the exact argument under
 * `mintLaunchSession`: there is no second factor on a local install, the per-launch bearer
 * never leaves the shell, and no page in the window can compose a stdio request itself. A
 * `stepUp: true` here would also be a defect, not merely a formality: the launch session's
 * factor stamp is written ONCE at boot, so `withStepUp` would refuse every mint from five
 * minutes after launch (`stepUpWindowMs`) for the rest of the process's life. The revoke is
 * `stepUp: false` for the same reason plus the ceremony rule `pair.ts` states: taking a
 * credential back must never be harder than handing it out.
 *
 * ── DEVICE-PAIR GRANTS ONLY, REFUSED AT THE DOOR ────────────────────────────────────────────
 *
 * The shared mint accepts `grant: "invite"` because a standalone server has an invites table
 * and a registration for the redeem to bridge into. This engine has neither: its own redeem
 * refuses the invite arm, so an invite token minted here would be a credential NOTHING can
 * spend. Refusing the grant at mint time — `validation_failed`, before the service writes a
 * row — is the honest shape; silently minting device-pair for whatever was asked would be
 * worse, and letting the service mint an unspendable invite would be worse still.
 *
 * The wire shapes match the shared ceremony exactly (`POST /pair` → the minted token's one
 * appearance; `GET /pair` → the caller's own rows; `DELETE /pair/:id` → 204 or one 404 for
 * every kind of miss), so the window's Devices pane speaks one vocabulary on either door.
 *
 * ── AND THE TAKE-BACK LIVES HERE TOO, BECAUSE THE MINT DOES ─────────────────────────────────
 *
 * `GET /devices` / `DELETE /devices/:id`, same paths as the shared surface, mounted with the
 * mint and under the same arm. They cannot be the shared `deviceRoutes` objects: those carry
 * the step-up gate, which is right on every surface where a second factor exists and is the
 * boot-stamp decay defect here — the window would lose the ability to revoke a pairing five
 * minutes after launch, leaving a paired credential with NO take-back path. That is the one
 * composition that makes offering a pairing unsafe (the revocation path is the reason pairing
 * is safe to offer at all), so the revoke passes the service's explicit step-up opt-out with
 * the machine-login argument, and the HOST door's revoke keeps the real gate — a paired phone
 * still cannot sign out other devices.
 */

/** The session lifecycle from the bag; a misconfigured bag is a clean 500, never a TypeError. */
function lifecycle(deps: ApiDeps): SessionLifecycle {
  const svc = deps.services?.auth;
  if (!svc || typeof svc.listDevices !== "function") {
    throw new ServiceError("internal", 500, "auth service not configured");
  }
  return svc;
}

/** A JSON body as a plain object — `pair.ts`'s coercion, for the same validation_failed reason. */
async function readObjectBody(req: Request): Promise<Record<string, unknown>> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    raw = undefined;
  }
  return raw !== null && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
}

export const hostPairRoutes: Route[] = [
  {
    method: "POST",
    pattern: "/pair",
    cost: "ceremony",
    options: { stepUp: false },
    handler: async (req, deps) => {
      const b = await readObjectBody(req);
      if (b.grant !== "device-pair") {
        // The full pipeline's error envelope sits above this handler, but a refusal this
        // deliberate is answered directly rather than thrown: it is the door's contract, not a
        // service fault. See the header for why the invite grant has no meaning on this engine.
        return errorResponse(
          "validation_failed", 400,
          'this door mints "device-pair" tokens only — an invite has nothing to redeem into here',
        );
      }
      const minted = await mintPairingToken(serviceContext(deps, req), {
        grant: "device-pair",
        label: typeof b.label === "string" ? b.label : null,
        ...(b.ttlSeconds !== undefined ? { ttlSeconds: b.ttlSeconds as number } : {}),
      });
      // The raw token's ONE appearance, exactly as the shared mint answers it.
      return jsonResponse(minted, { status: 200 });
    },
  },
  {
    method: "GET",
    pattern: "/pair",
    cost: "read",
    handler: async (req, deps) =>
      jsonResponse({ items: await listPairingTokens(serviceContext(deps, req)) }, { status: 200 }),
  },
  {
    method: "DELETE",
    pattern: "/pair/:id",
    cost: "ceremony",
    options: { stepUp: false },
    handler: async (req, deps, params) => {
      const revoked = await revokePairingToken(serviceContext(deps, req), params.id!);
      // One answer for every miss (spent, expired, unknown) — the shared revoke's rule.
      if (!revoked) throw new ServiceError("not_found", 404, "no live pairing token of yours has this id");
      return new Response(null, { status: 204 });
    },
  },
  {
    method: "GET",
    pattern: "/devices",
    cost: "read",
    handler: async (req, deps) =>
      jsonResponse(await lifecycle(deps).listDevices(serviceContext(deps, req)), { status: 200 }),
  },
  {
    // The take-back — see the header. `stepUp: false` on the route AND the explicit opt-out in
    // the service call, both carrying the same machine-login argument; the shared surface keeps
    // both gates on every other door.
    method: "DELETE",
    pattern: "/devices/:id",
    cost: "ceremony",
    options: { stepUp: false },
    handler: async (req, deps, params) => {
      await lifecycle(deps).revokeDevice(serviceContext(deps, req), params.id!, { requireStepUp: false });
      return new Response(null, { status: 204 });
    },
  },
];
