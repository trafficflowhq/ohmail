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
     * ── `GET /push/vapid-key` — the key a UnifiedPush connector needs before it can register ──
     *
     * A connector registers by handing the device's distributor a VAPID public key, and from then
     * on it renders only wakes signed by the matching private half. So the phone must be able to
     * ask the server it paired with for that key, and there is no earlier moment it could have
     * learned it: the key is per-deployment, and the app can be pointed at the hosted service, an
     * operator's own install, or a friend's.
     *
     * **HERE AND NOT ON `/hello`, deliberately.** `/hello` is the pre-credential negotiation and
     * its wire shape is frozen — booleans grouped under `auth` and `features`, pinned by a
     * contract test — while this is a per-deployment VALUE that is only ever wanted after
     * pairing, from an authenticated Settings pane, right before `POST /push/subscriptions`. It
     * belongs beside the registration it feeds. Adding a `features.wake` boolean as well would
     * create a second source of truth that can disagree with this one: `/hello` says the
     * capability exists, this answers `null`, and the client has been told two things.
     *
     * **`{ publicKey: null }` IS THE ANSWER, not a failure.** A self-host that has not generated
     * a keypair has no key, and that is a supported state — wakes still reach raw consumers and
     * the app still syncs on foreground. A 404 or a 503 here would make the app show an error for
     * a server that is working exactly as configured, so the route answers 200 with an honest
     * null and the app turns it into one sentence.
     *
     * `cost: "read"` and authenticated like every other route in this table. The key is not a
     * secret — it ships to every device that registers and travels in the clear in the `k=` field
     * of every wake — but there is no reason to serve it to unauthenticated callers either, and
     * inheriting this table's mounts means a composition that has no push surface has no key
     * route either.
     */
    method: "GET",
    pattern: "/push/vapid-key",
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
    cost: "work",
    handler: async (req, deps, params) => {
      await push(deps).unsubscribe(serviceContext(deps, req), params.id!);
      return noContent();
    },
  },
];
