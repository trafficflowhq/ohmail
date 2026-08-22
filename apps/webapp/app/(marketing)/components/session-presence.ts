"use client";

import { useEffect, useState } from "react";
import { readOwner } from "../../shell/owner-cookie";

/**
 * THE SEAM: "is there an ohmail session in this browser?", as one tiny hook.
 *
 * The landing is a cached server component and must stay cacheable for strangers, so
 * nothing here may block first paint or fetch per-user data during render. The header
 * SSRs the stranger state unconditionally; this hook is the single place the signed-in
 * answer comes from. `Nav.tsx` collapses its acquisition trio on it, and `LangSwitch.tsx`
 * steps aside on it — both for the same underlying fact.
 *
 *  · "none"    — no evidence of a session. The header offers "Sign in". An expired but
 *                returning visitor is exactly this: sign-in is the right offer, and
 *                there is no half state to design for.
 *  · "present" — evidence of a live session. The header collapses its acquisition pair
 *                (Sign in + Get ohmail.) into one entry: "Open ohmail" → `/`, where the
 *                middleware serves the app to a session; the language switch withdraws,
 *                because its `/` href would open that app, not the English landing the
 *                link's `hrefLang` claims.
 *
 * ── THE SIGNAL: `tf_owner`, THE ONE READABLE COOKIE THE SESSION ALREADY SETS ──────────
 *
 * The session itself is invisible on purpose — `tf_session` and `tf_refresh` are
 * `HttpOnly`, and the resume marker `tf_resume` is `HttpOnly` precisely so XSS cannot
 * plant it. What the middleware keys `/` on is that pair: a validated session, or the
 * resume marker (`middleware.ts`). Their readable twin is `tf_owner`
 * (`packages/api/src/cookies.ts`): minted BESIDE them at sign-in, re-stamped by every
 * refresh, cleared by sign-out on both the server and the client, and carrying the
 * refresh token's `Max-Age` — present for exactly as long as this browser could still
 * resume, which is exactly the window in which `/` answers with the app or the resume
 * splash rather than the landing. No new cookie, no attribute touched, no second
 * parser: `readOwner` (`app/shell/owner-cookie.ts`) is that cookie's single reader,
 * shape-checks the value, and answers `null` for anything malformed or absent.
 *
 * Two contract lines, held from the stub that preceded this and still binding:
 *  1. The FIRST client render answers "none" — hydration has to match the stranger SSR,
 *     which is also what keeps every crawler and the static prerender on the stranger
 *     branch. The flip to "present" happens only in an effect, after mount.
 *  2. No network round-trip. Presence here is a HINT for the header, not an
 *     authorization: `/` still decides for real, so a stale "present" costs one
 *     redirect and nothing else, and a stale "none" offers Sign in to someone the
 *     middleware would have let straight through — one extra click, no exposure.
 *
 * Read once at mount, deliberately: the header does not track a session that dies
 * mid-visit (neither does anything else on a static page), and the one navigation this
 * hint gates re-decides at the middleware anyway.
 */
export type SessionPresence = "none" | "present";

export function useSessionPresence(): SessionPresence {
  const [presence, setPresence] = useState<SessionPresence>("none");
  useEffect(() => {
    if (readOwner() !== null) setPresence("present");
  }, []);
  return presence;
}
