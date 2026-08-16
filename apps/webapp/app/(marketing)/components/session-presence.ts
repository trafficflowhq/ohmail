"use client";

/**
 * THE SEAM: "is there an ohmail session in this browser?", as one tiny hook.
 *
 * The landing is a cached server component and must stay cacheable for strangers, so
 * nothing here may block first paint or fetch per-user data during render. The header
 * SSRs the stranger state unconditionally; this hook is the single place the signed-in
 * answer comes from, and `Nav.tsx` is its only consumer.
 *
 * Until the session/auth work wires it, it answers "none" — the honest static answer,
 * and the reason the header can never flash "Open ohmail" at a stranger.
 *
 *  · "none"    — no evidence of a session. The header offers "Sign in". An expired but
 *                returning visitor is exactly this: sign-in is the right offer, and
 *                there is no half state to design for.
 *  · "present" — evidence of a live session. The header collapses its acquisition pair
 *                (Sign in + Get ohmail.) into one entry: "Open ohmail" → `/`, where the
 *                middleware serves the app to a session.
 *
 * Contract for whoever wires it (see the concurrent session/auth slice):
 *  1. The FIRST client render must still answer "none" — hydration has to match the
 *     stranger SSR. Flip to "present" only after mount (a `useEffect` reading whatever
 *     the auth slice decides is the browser-visible presence signal, e.g. a readable
 *     marker cookie set alongside the HttpOnly session).
 *  2. No network round-trip to answer it. Presence here is a HINT for the header, not
 *     an authorization: `/` still decides for real, so a stale "present" costs one
 *     redirect and nothing else.
 */
export type SessionPresence = "none" | "present";

export function useSessionPresence(): SessionPresence {
  return "none";
}
