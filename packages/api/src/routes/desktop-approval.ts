import { serviceContext } from "../context.js";
import type { Route } from "../router.js";
import { json, readBody } from "./shared.js";
import { auth } from "./shared-cloud.js";

/**
 * Signing a desktop in by confirming in the browser: ask, claim, read, confirm, deny. Mounted by
 * the hosted table only (`routes/index.ts`), never by `selfHostRoutes`. The shipped desktop asks
 * only the hosted service for an approval, so on a self-hosted server every request would be
 * somebody else's; and behind that server's proxy the request's network cannot be told from the
 * browser's, so the page could not say when they differ.
 */
export const desktopApprovalRoutes: Route[] = [
  {
    // Signing a desktop in by confirming in the browser, step one: the desktop asks. Public — the
    // desktop holds nothing yet — and bounded per IP in the service. The body is the PKCE
    // challenge, the claim kind and the desktop's own name; the answer is the request id the
    // desktop puts in the page's URL. Nothing here is a credential on its own.
    method: "POST",
    pattern: "/auth/desktop-approval",
    relay: false,  /* the browser hand-off ceremony */
    cost: "ceremony",
    options: { public: true },
    handler: async (req, deps) => {
      const body = await readBody<{ challenge?: unknown; kind?: unknown; label?: unknown }>(req);
      return json(await auth(deps).issueDesktopApproval(serviceContext(deps, req), body), 200);
    },
  },
  {
    // Step four: the desktop polls with the verifier. 202 while nobody has confirmed, 200 with the
    // bearer pair once, and never a cookie — a `Set-Cookie` would make the approval a browser
    // session on whatever origin fetched it (`/auth/desktop-claim`'s reason).
    method: "POST",
    pattern: "/auth/desktop-approval/claim",
    relay: false,  /* carries the hosted hand-off verifier */
    cost: "ceremony",
    options: { public: true, credentialSubject: true },
    handler: async (req, deps) => {
      const body = await readBody<{ approvalId?: unknown; verifier?: unknown; kind?: unknown }>(req);
      const result = await auth(deps).claimDesktopApproval(serviceContext(deps, req), body);
      return "tokens" in result ? json(result, 200) : json(result, 202);
    },
  },
  {
    // Step two: the signed-in page reads what it is about to confirm. A read, so the page can
    // render on load; another account's request is a 404 whatever its state.
    method: "GET",
    pattern: "/auth/desktop-approval/:id",
    relay: false,  /* the browser hand-off ceremony */
    cost: "read",
    handler: async (req, deps, params) =>
      json(await auth(deps).readDesktopApproval(serviceContext(deps, req), params.id!), 200),
  },
  {
    // Step three: the ONE confirm. `stepUp: true` for `/auth/desktop-link`'s reason — this lets a
    // computer mint a four-hundred-day native session — and an unsafe method on a cookie session,
    // so `withCsrf` applies. The page answers a 403 `step_up_required` with the factor inline.
    method: "POST",
    pattern: "/auth/desktop-approval/:id/confirm",
    relay: false,  /* the browser hand-off ceremony */
    cost: "ceremony",
    options: { stepUp: true },
    handler: async (req, deps, params) =>
      json(await auth(deps).confirmDesktopApproval(serviceContext(deps, req), params.id!), 200),
  },
  {
    // "Not me". No step-up: refusing a computer can only reduce what can reach the account.
    method: "POST",
    pattern: "/auth/desktop-approval/:id/deny",
    relay: false,  /* the browser hand-off ceremony */
    cost: "ceremony",
    handler: async (req, deps, params) =>
      json(await auth(deps).denyDesktopApproval(serviceContext(deps, req), params.id!), 200),
  },
];
