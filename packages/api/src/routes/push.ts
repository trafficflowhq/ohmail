import type { PushSubscribeBody } from "@trafficflow/services/mail";
import { serviceContext } from "../context.js";
import { jsonResponse } from "../responses.js";
import type { Route } from "../router.js";
import { push, readBody, noContent } from "./shared.js";

/**
 * §4.2 — push subscriptions. `POST` is idempotent (Idempotency-Key): the service
 * writes the idempotency row IN its mutation tx, so `deps.idempotency` is
 * threaded through. The stored/returned response is a bare `{ id }` (verbatim on
 * replay). `DELETE` is scoped to the account (404 cross-account).
 */
export const pushRoutes: Route[] = [
  {
    /**
     * `GET /push/vapid-key` — the key a UnifiedPush connector needs to register: it hands the
     * distributor a VAPID public key and thereafter renders only wakes signed by the matching
     * private half; the key is per-deployment, so the phone must be able to ask. Here and not
     * `/hello`: that is the frozen pre-credential negotiation, and a `features.wake` boolean
     * there could disagree with this answer. `{ publicKey: null }` is the answer, not a failure:
     * a self-host with no keypair is a supported state, and a 404 would show an error for a
     * server working as configured. `cost: "read"`, authenticated: the key is not a secret, but
     * there is no reason to serve it anonymously.
     */
    method: "GET",
    pattern: "/push/vapid-key",
    relay: true,
    cost: "read",
    handler: (_req, deps) => {
      // Normalised so that an operator's empty-string environment variable and an unset one are
      // the same answer — a `""` served here would be a key the connector would try to register
      // with and be rejected for.
      const key = deps.vapidPublicKey ?? null;
      return Promise.resolve(jsonResponse({
        publicKey: typeof key === "string" && key.trim() !== "" ? key.trim() : null,
      }));
    },
  },
  {
    method: "POST",
    pattern: "/push/subscriptions",
    relay: true,
    cost: "work",
    options: { idempotent: true },
    handler: async (req, deps) => {
      const body = await readBody<PushSubscribeBody>(req);
      const { id } = await push(deps).subscribe(serviceContext(deps, req), body, {
        idempotency: deps.idempotency ?? null,
      });
      return jsonResponse({ id }, { status: 201 });
    },
  },
  {
    method: "DELETE",
    pattern: "/push/subscriptions/:id",
    relay: true,
    cost: "work",
    handler: async (req, deps, params) => {
      await push(deps).unsubscribe(serviceContext(deps, req), params.id!);
      return noContent();
    },
  },
];
