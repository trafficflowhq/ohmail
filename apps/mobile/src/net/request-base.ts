/**
 * WHERE ON A SERVER THIS APP'S REQUESTS GO — one resolver, and every helper composes off it.
 *
 * A self-host stack serves one origin behind one Caddy site: `/api/*` plus a short bare-routed
 * family (`/auth/*`, `/pair/*`, `/hello`, `/health`, `/events`, `/internal/*`) reach the API and
 * everything else the web container's HTML 404. Only sync used the MEASURED base: consent, the
 * roster and release, push and the screener appended to the ORIGIN, so a supported `/api`
 * deployment synced mail while those surfaces read a 404 — a configuration that half works,
 * silently. `null` means the API is at the origin. Censused in `phone-state-is-the-accounts`.
 */
export function apiBaseOf(origin: string, apiBase: string | null): string {
  const base = (apiBase ?? "").trim() === "" ? origin : apiBase!;
  return base.replace(/\/+$/, "");
}

/** {@link apiBaseOf} for a connected session — the form every request helper takes. */
export function requestBase(session: {
  readonly profile: { readonly origin: string; readonly apiBase: string | null };
}): string {
  return apiBaseOf(session.profile.origin, session.profile.apiBase);
}
