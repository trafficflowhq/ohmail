/**
 * WHERE ON A SERVER THIS APP'S REQUESTS GO — one resolver, and every helper composes off it.
 *
 * A self-host stack serves one origin behind one Caddy site: `/api/*` plus a short bare-routed
 * family (`/auth/*`, `/pair/*`, `/hello`, `/health`, `/events`, `/internal/*`) reach the API and
 * everything else reaches the web container, which answers HTML 404. The base is MEASURED at
 * pairing time and stored on the profile (`resolveApiBase`, `ServerProfile.apiBase`). Only the
 * engine's sync used it: consent, the mailbox roster and release, push and the screener appended
 * their routes to the ORIGIN, so a supported `/api` deployment synced mail while every one of
 * those surfaces read an HTML 404 and reported a default or a refusal — a configuration that
 * half works, silently. One resolver, imported by every helper, is what makes that shape
 * unrepresentable; `test/phone-state-is-the-accounts.test.ts` censuses the compositions.
 *
 * `null` means the API is at the origin, which is what the hosted service and a desktop host are.
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
