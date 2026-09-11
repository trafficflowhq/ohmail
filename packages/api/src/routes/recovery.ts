import { serviceContext } from "../context.js";
import type { Route } from "../router.js";
import { json, readBody } from "./shared.js";
import { auth, webSession } from "./shared-cloud.js";

/**
 * Recovery codes. Generation is part of the `/auth/2fa/*` enrollment surface, so it carries
 * `enrollmentOk` — but it is also `stepUp`, and the two gates are independent by design: an
 * enrollment session has no `lastTwofaAt`, so `withStepUp` (and `AuthService.requireStepUp`)
 * still 403 it. Recovery codes therefore become reachable only once the first factor is enrolled
 * and the enrollment session exchanged for a full one with a fresh `lastTwofaAt` — exactly the
 * onboarding order (passkey → codes), enforced structurally rather than by client discipline.
 */
export const recoveryRoutes: Route[] = [
  {
    method: "POST",
    pattern: "/auth/2fa/recovery-codes",
    relay: true,
    cost: "ceremony",
    options: { stepUp: true, enrollmentOk: true },
    handler: async (req, deps) => json(await auth(deps).generateRecoveryCodes(serviceContext(deps, req)), 200),
  },
  {
    // Public step-two: consumes one single-use code and establishes the session;
    // `remainingCodes` survives the token-stripping (webSession keeps extra fields).
    method: "POST",
    pattern: "/auth/2fa/recovery-codes/verify",
    relay: false,  /* resolves a credential from the request body */
    cost: "ceremony",
    options: { public: true, credentialSubject: true },
    handler: async (req, deps) => {
      const body = await readBody<{ loginToken: string; code: string }>(req);
      return webSession(deps, await auth(deps).recoveryVerify(serviceContext(deps, req), body));
    },
  },
];
