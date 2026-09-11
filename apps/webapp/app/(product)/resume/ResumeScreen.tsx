"use client";

/**
 * The resume splash — the half-second that turns a 15-minute session into a 90-day one. `tf_session` lives
 * fifteen minutes; `tf_refresh` lives ninety days but is scoped `Path=/auth/refresh`, invisible to a request
 * for `/` — seen live: an intact day-old account served the marketing page with no way back in. `tf_resume`
 * lets the gate send such a browser here, and this page does the one thing the edge cannot: a same-origin `POST
 * /auth/refresh` (widening the cookie's Path is forbidden). It must never loop: the server clears the whole jar
 * when a refresh fails, and a one-shot `sessionStorage` flag covers the 5xx/offline case. It RELOADS rather
 * than navigating: `location.replace("/" + hash)` computes a byte-identical URL, treated as a fragment change
 * and never re-requested (observed live — the splash sat for ever).
 */

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { REFRESH_ENDPOINT, resumeSession } from "../../session-refresh";
import { readOwner } from "../../shell/owner-cookie";
import { durableSessionSet } from "../../shell/durable";

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

export function ResumeScreen({ initialOwner = null }: { initialOwner?: string | null }) {
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
    } catch {
      /* private mode, storage disabled — fall through and rely on guard 1 */
    }
    // A stamp that could not be written leaves guard 1 as the only loop defence, which is what
    // the catch above already accepted; it is no longer accepted in silence.
    durableSessionSet(ONCE_KEY, String(Date.now()), "resume.once");
    if (looping) {
      setFailed(true);
      return;
    }

    /*
     * The account this splash was chosen for. `initialOwner` is the marker as the EDGE saw it when
     * it decided to serve this page; the jar can have changed hands since — this effect runs after
     * hydration, and the lock inside the refresh adds a second wait. A refresh under a jar that has
     * become somebody else's rotates THEIR session from a window that is not theirs. `null` means
     * the edge saw no marker — the ordinary shape of a cross-site navigation that withheld the
     * cookies — so nothing is compared and the resume runs exactly as it always has.
     */
    const stillMine = (): boolean => initialOwner === null || readOwner() === initialOwner;

    void (async () => {
      /*
       * No second check before this call, deliberately. One stood here and was removed when its
       * mutation could not be made to bite: `resumeSession` consults the same predicate inside the
       * lock, so an early copy changed no outcome in any reachable sequence — a check nothing can
       * watch fail is not defence in depth, it is decoration a later reader will trust. The one gap
       * the predicate does not cover is `resumeSession`'s own `inFlight` dedupe: a refresh already
       * running when this effect starts is returned as-is — an early check would not help there
       * either, the request has left.
       */
      const ok = await resumeSession({ mayProceed: stillMine });
      if (!ok) {
        // The predicate refused: the jar changed while this waited for the lock. Same answer as
        // above, and NOT `/login` — that would send a signed-in person to the front door.
        if (!stillMine()) { window.location.reload(); return; }
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

/** Re-exported so the rewrite guard can assert the splash posts the bare path. */
export { REFRESH_ENDPOINT };
