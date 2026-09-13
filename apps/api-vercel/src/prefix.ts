
/**
 * The two CONSTANTS this host's pipeline is configured by — and nothing else. The WEB APP
 * reaches into this module (its tests import {@link API_PREFIX} so the browser rewrite and the
 * stripped prefix cannot drift) and it typechecks its tests, so every specifier here must
 * resolve inside the web app's own install: a check refuses a workspace import here by name,
 * because in a workspace checkout `@trafficflow/api` resolves through the repository root
 * whether or not the app declares it, and a production `next build` then fails where every
 * local command is green.
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
