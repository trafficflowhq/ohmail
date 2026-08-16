"use client";

/**
 * THE RESUME SPLASH — the half-second that turns a 15-minute session into a 90-day one.
 *
 * A signed-in customer's `tf_session` cookie lives fifteen minutes. Their `tf_refresh` cookie
 * lives ninety days — rolling, so every rotation re-issues it — but is scoped `Path=/auth/refresh`,
 * so it is invisible to a request for `/` and the edge gate cannot see it. The result, seen
 * live: an account created the day before, entirely intact, and its holder served the
 * marketing page with no way back in.
 *
 * `tf_resume` (a `Lax`, credential-free marker — `packages/api/src/cookies.ts`) is what lets
 * the gate notice such a browser and send it here instead. This page does the one thing the
 * edge cannot: a same-origin `POST /auth/refresh`, which IS a request to the path the refresh
 * cookie is scoped to, so the browser finally attaches it.
 *
 * ── WHY A PAGE AND NOT A REDIRECT ───────────────────────────────────────────────────────
 *
 * Because only a browser can make this request. Middleware runs at the edge with the cookies
 * the browser chose to send, and `tf_refresh` is not among them for `/`. Widening its Path so
 * the edge could read it is forbidden (`next.config.mjs`) and would put a live credential on
 * every request to every page — precisely the exposure the narrow path exists to prevent.
 *
 * ── IT MUST NEVER LOOP ──────────────────────────────────────────────────────────────────
 *
 * Two independent guards, because a loop here is an unusable product:
 *
 *  1. The SERVER clears the whole cookie jar — marker included — when a cookie refresh fails
 *     (`packages/api/src/routes/core.ts`). A revoked or already-rotated family therefore stops
 *     being resumable at the source, on the first attempt.
 *  2. This page keeps a one-shot flag in `sessionStorage` for the case guard 1 cannot cover:
 *     a refresh that neither succeeds nor cleanly fails (a 5xx, an offline tab). Without it a
 *     browser could bounce `/` → resume → `/` → resume for as long as the marker lives.
 *
 * ── THE HASH IS THE VIEW, AND `reload()` IS WHAT KEEPS IT ───────────────────────────────
 *
 * `app/shell/routing.ts` routes the client on the URL FRAGMENT — `/#/settings`, `/#/screener`.
 * A fragment is never sent to the server, so the edge gate cannot see it: the browser is
 * ALREADY at the right URL, and the only thing that needs to change is the server's answer,
 * now that the cookie jar has a live session in it.
 *
 * So this reloads rather than navigating, and that is a correction of a real bug rather than a
 * stylistic choice. `location.replace("/" + hash)` looks right and does nothing: the URL it
 * computes is byte-identical to the current one, so the browser treats it as a fragment change
 * and never re-requests the document. Observed live — the refresh succeeded, fresh
 * cookies arrived, and the page sat on this splash for ever because no second `GET /` was ever
 * made. `reload()` re-runs the gate and preserves the fragment by definition.
 */

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { REFRESH_ENDPOINT, resumeSession } from "../../session-refresh";

/** Survives the reload a successful resume performs; scoped to this tab. */
const ONCE_KEY = "ohmail.resume-attempted";

/**
 * How recent a previous attempt has to be to count as a LOOP rather than a later, legitimate
 * resume in the same tab.
 *
 * A timestamp, not a boolean. A boolean cleared on success cannot see a loop at all (each pass
 * erases the evidence of the last); a boolean left set breaks the honest case where a tab open
 * for hours lapses a second time. Ten seconds is far longer than a resume takes and far
 * shorter than any real interval between two of them.
 */
const LOOP_WINDOW_MS = 10_000;

export function ResumeScreen() {
  const t = useTranslations("resume");
  const [failed, setFailed] = useState(false);
  /** React 18 StrictMode double-invokes effects in dev; the refresh must fire once. */
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    // Guard 2. If this tab has already tried and we are somehow back here, the resume is not
    // working and the honest thing is to say so rather than bounce again.
    let looping = false;
    try {
      const last = Number(sessionStorage.getItem(ONCE_KEY) ?? 0);
      looping = Number.isFinite(last) && last > 0 && Date.now() - last < LOOP_WINDOW_MS;
      sessionStorage.setItem(ONCE_KEY, String(Date.now()));
    } catch {
      /* private mode, storage disabled — fall through and rely on guard 1 */
    }
    if (looping) {
      setFailed(true);
      return;
    }

    void (async () => {
      const ok = await resumeSession();
      if (!ok) {
        // NOT the marketing page. This browser was signed in a moment ago; showing it the
        // pitch would be answering "let me back in" with "here is what ohmail is". The server
        // has already cleared the jar, so `/` would render marketing — so go where the person
        // is actually trying to get to.
        //
        // No `?next=`: this is a single origin with fragment routing, so there is nothing to
        // pass that is not already in the fragment, and a redirect parameter is an
        // open-redirect surface this product has no reason to own.
        window.location.replace("/login");
        return;
      }
      // The stamp is deliberately LEFT IN PLACE across this reload — it is what lets the next
      // pass recognise a loop. `LOOP_WINDOW_MS` is what stops it from being a permanent veto.
      //
      // Reload, not replace: the URL is already correct, fragment and all. Only the server's
      // answer needs to change now that the jar holds a live session. See the header — the
      // replace-to-the-same-URL version shipped and silently did nothing.
      window.location.reload();
    })();
  }, []);

  // Deliberately silent while it works. This is normally 200-400ms, and a sentence that
  // flashes for a third of a second is worse than a quiet frame — the same call
  // `EngineProvider`'s "resolving" state makes.
  if (!failed) return <div className="gate" aria-busy="true" aria-live="polite" />;

  return (
    <div className="gate">
      <div className="gate-card">
        <span className="wordmark">
          <b>
            <em>oh</em>mail
          </b>
        </span>
        <h1>{t("failedTitle")}</h1>
        <p>{t("failedBody")}</p>
        <div className="gate-actions">
          <Link className="btn primary" href="/login">{t("signIn")}</Link>
          <Link className="btn" href="/?demo=1">{t("openDemo")}</Link>
        </div>
      </div>
    </div>
  );
}

/** Re-exported so `test/api-rewrite.test.ts` can assert the splash posts the bare path. */
export { REFRESH_ENDPOINT };
