"use client";

import { useEffect, useState } from "react";
import { readOwner } from "../../shell/owner-cookie";

/**
 * The seam: "is there an ohmail session in this browser?", as one tiny hook. The landing is a
 * cached server component, so nothing here may block first paint or fetch per-user data; the header
 * SSRs the stranger state unconditionally, and this hook is the single place the signed-in answer
 * comes from (`Nav.tsx` collapses its acquisition trio on it, `LangSwitch.tsx` steps aside on it).
 * "none" — no evidence; the header offers Sign in, right even for an expired visitor. "present"
 * — evidence of a live session; the header collapses to "Open ohmail" → `/`, and the language
 * switch withdraws because its `/` href would open the app, not the landing its `hrefLang` claims.
 */

/**
 * The signal is `tf_owner`, the one READABLE cookie the session already sets: `tf_session`, `tf_refresh` and
 * `tf_resume` are HttpOnly on purpose. It is minted beside them at sign-in, re-stamped by every refresh, cleared by
 * sign-out on both sides, and carries the refresh token's `Max-Age` — present exactly as long as this browser could
 * still resume, exactly the window in which `/` answers with the app or the resume splash.
 */

/**
 * `readOwner` is that cookie's single reader. Two contract lines: the FIRST client render answers "none" (hydration
 * must match the stranger SSR; the flip happens in an effect), and no network round trip — presence is a HINT, not an
 * authorization: `/` still decides for real, so a stale answer costs one redirect or one extra click, no exposure.
 * Read once at mount: the one navigation this gates re-decides at the middleware anyway.
 */
export type SessionPresence = "none" | "present";

export function useSessionPresence(): SessionPresence {
  const [presence, setPresence] = useState<SessionPresence>("none");
  useEffect(() => {
    if (readOwner() !== null) setPresence("present");
  }, []);
  return presence;
}
