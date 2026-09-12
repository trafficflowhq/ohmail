import { errorResponse, jsonResponse, serviceContext, type ApiDeps, type Route } from "@trafficflow/api/local";
import {
  mintPairingToken, listPairingTokens, revokePairingToken, ServiceError, type SessionLifecycle,
} from "@trafficflow/services/auth";

/**
 * The window's own pairing surface — token mint/list/revoke AND the device list/take-back, on the
 * STDIO door and nowhere else. Defined in the engine, not the shared tables (the `ai-routes.ts`
 * argument): mounting makes "this door only" a property of the module graph, and `engine.ts` spreads
 * it into the stdio table ONLY when host mode is armed, so a remote device can never mint the
 * credential that admits remote devices. `stepUp: false` is the honest gate — the machine's own login
 * IS the step-up (`mintLaunchSession`), and `stepUp: true` would be a defect (the boot factor stamp
 * decays, refusing every mint five minutes after launch). Device-pair grants only, refused at the
 * door. The take-back lives here too with the machine-login opt-out, or the window loses revocation.
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
    relay: false,  /* served by this engine; never forwarded */
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
    relay: false,  /* served by this engine; never forwarded */
    cost: "read",
    handler: async (req, deps) =>
      jsonResponse({ items: await listPairingTokens(serviceContext(deps, req)) }, { status: 200 }),
  },
  {
    method: "DELETE",
    pattern: "/pair/:id",
    relay: false,  /* served by this engine; never forwarded */
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
    relay: false,  /* served by this engine; never forwarded */
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
    relay: false,  /* served by this engine; never forwarded */
    cost: "ceremony",
    options: { stepUp: false },
    handler: async (req, deps, params) => {
      await lifecycle(deps).revokeDevice(serviceContext(deps, req), params.id!, { requireStepUp: false });
      return new Response(null, { status: 204 });
    },
  },
];
