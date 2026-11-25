import { serviceContext } from "../context.js";
import { presentedResumeMarker } from "../cookies.js";
import type { Route } from "../router.js";
import { json, readBody } from "./shared.js";
import { auth } from "./shared-cloud.js";

/** Browser approval uses the same protected ceremony for Cloud and self-hosted phones. */
const isPhone = (kind: unknown) => kind === "mobile-ios" || kind === "mobile-android";
const unavailable = () => json({ error: { code: "not_found", message: "Not found." } }, 404);

function launchOrigin(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 2048) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && url.origin === value) return url.origin;
  } catch { /* refuse malformed origins */ }
  return undefined;
}

const approvalRoutes = (phoneOnly: boolean): Route[] => [
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
      const body = await readBody<{ challenge?: unknown; kind?: unknown; label?: unknown; launchOrigin?: unknown; scope?: unknown }>(req);
      if (phoneOnly && !isPhone(body?.kind)) return unavailable();
      if (body?.scope === "calendar" && !deps.services?.calendar) return unavailable();
      const origin = phoneOnly ? launchOrigin(body?.launchOrigin) : undefined;
      return json(await auth(deps).issueDesktopApproval(serviceContext(deps, req), body, origin), 200);
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
    options: { public: true, credentialSubject: true, credentialLookup: true },
    handler: async (req, deps) => {
      const body = await readBody<{ approvalId?: unknown; verifier?: unknown; kind?: unknown; previousSession?: unknown }>(req);
      if (phoneOnly && !isPhone(body?.kind)) return unavailable();
      // `/auth/desktop-claim`'s carrier: the install's previous family, or nothing.
      const ctx = { ...serviceContext(deps, req), supersedesInstall: presentedResumeMarker(body.previousSession) };
      const result = await auth(deps).claimDesktopApproval(ctx, body);
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

export const desktopApprovalRoutes = approvalRoutes(false);
export const selfHostApprovalRoutes: Route[] = [
  ...approvalRoutes(true),
  {
    method: "POST",
    pattern: "/auth/desktop-approval/launch",
    relay: false,
    cost: "read",
    options: { public: true },
    handler: async (req, deps) => {
      const body = await readBody<{ approvalId?: unknown; origin?: unknown; launch?: unknown }>(req);
      const origin = launchOrigin(body?.origin);
      if (!origin) return unavailable();
      const proof = auth(deps).verifyApprovalLaunch(deps.now(), body?.approvalId, origin, body?.launch);
      if (proof === "invalid") return unavailable();
      return new Response(null, { status: proof === "expired" ? 410 : 204, headers: { "cache-control": "no-store" } });
    },
  },
];
