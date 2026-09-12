
/**
 * The two CONSTANTS this host's pipeline is configured by — and nothing else, because this is
 * the module the WEB APP reaches into: its tests import {@link API_PREFIX} so the browser
 * rewrite and the stripped prefix cannot drift, and that app typechecks its tests, so every
 * specifier here has to resolve inside the web app's own install. A check refuses a workspace
 * import here by name; it was paid for by a production `next build` that failed with "Cannot
 * find module '@trafficflow/api'" while every local command was green — in a workspace
 * checkout the package resolves through the repository root whether or not the app declares it.
 *
 * THE CANONICALIZER USED TO LIVE HERE and now lives once, in `@trafficflow/api`
 * (`canonical-path.ts`), reached from `normalize.ts` and `handler.ts` — modules nothing
 * outside this app imports. Three code-identical copies of the rule that decides a request
 * hash meant it could be corrected in one and stay wrong in two.
 */

/** The prefix the webapp's `/api/:path*` rewrite may leave on the path. */
export const API_PREFIX = "/api";

/**
 * The door's ceiling for the one route that carries attachment bytes inline
 * (`POST /drafts/:id/send`; see `LARGE_BODY_ROUTES`). 4.5 MB because that is the platform's
 * own request-body cap on this host: larger never fires, smaller refuses a send the platform
 * would deliver. The bytes are bounded more tightly one layer in by
 * `SEND_ATTACHMENT_MAX_TOTAL_BYTES` (3 MiB raw) inside `SendService.reserve`; every other
 * route is held to `JSON_BODY_MAX_BYTES`.
 */
export const HOSTED_LARGE_BODY_MAX_BYTES = 4_500_000;
