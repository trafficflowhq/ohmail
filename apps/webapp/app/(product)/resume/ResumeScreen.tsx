"use client";

/**
 * The resume splash — the half-second that turns a 15-minute session into a 90-day one. `tf_refresh` is
 * scoped `Path=/auth/refresh`, invisible to a request for `/`, so `tf_resume` lets the gate send such a
 * browser here and this page makes the same-origin `POST /auth/refresh` the edge cannot (widening the
 * cookie's Path is forbidden). It reads the refresh door's ANSWER, never its absence: a mint reloads; the
 * door's three refusals go to `/login` with the sentence that names which; a fault — a busy database, a
 * 429, no response — retries here with the jar untouched and ends on "could not be reached", never on
 * a sign-in. It RELOADS rather than navigating: `location.replace("/" + hash)` is a fragment change.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { REFRESH_ENDPOINT, lastRefreshReport, resumeSession, type RefreshReport } from "../../session-refresh";
import { readOwner } from "../../shell/owner-cookie";
import { durableSessionSet } from "../../shell/durable";
import { CONFIRM_ATTEMPTS, nextConfirmDelay } from "../../shell/confirm-schedule";
import { REASON_BODY, isSignedOutReason, leaveSignedOutNote, type SignedOutReason } from "./signed-out-note";

/** Survives the reload a successful resume performs; scoped to this tab. */
const ONCE_KEY = "ohmail.resume-attempted";

/**
 * How recent the previous pass has to be to count as a LOOP rather than a later, legitimate resume
 * in the same tab. A timestamp, not a boolean: a boolean cleared on success cannot see a loop, one
 * left set breaks a tab that lapses twice in an afternoon.
 */
const LOOP_WINDOW_MS = 10_000;

/**
 * Back here within the window right after a MINT means the gate refused a session this tab just
 * renewed. The jar is live, so this reloads after a backoff rather than spending another rotation,
 * and after this many says the server could not be reached.
 */
export const GATE_RELOADS = 3;

/** What one pass learned from the refresh door. */
export type ResumeAnswer = "minted" | SignedOutReason | "unavailable";

/**
 * THE ONE SWITCH. A refusal is a coded 401 (`outcome: "revoked"` in the report) and names its kind
 * by code; everything else — 5xx, 429, status 0, an uncoded 401 — is a fault and decides nothing.
 * A code this build does not know (the legacy `unauthorized` included) reads as revoked.
 */
export function answerOf(ok: boolean, report: RefreshReport | null): ResumeAnswer {
  if (ok) return "minted";
  if (report === null || report.outcome !== "revoked") return "unavailable";
  if (report.code === "refresh_expired") return "expired";
  if (report.code === "refresh_missing") return "absent";
  return "revoked";
}

interface Stamp { at: number; answer: ResumeAnswer | null; reloads: number }

function isAnswer(v: unknown): v is ResumeAnswer {
  return v === "minted" || v === "unavailable" || isSignedOutReason(v);
}

/** The previous pass, or null. The previous build wrote a bare timestamp; it reads as no answer. */
function readStamp(): Stamp | null {
  try {
    const raw = sessionStorage.getItem(ONCE_KEY);
    if (raw === null) return null;
    if (/^\d+$/.test(raw)) return { at: Number(raw), answer: null, reloads: 0 };
    const v = JSON.parse(raw) as Partial<Stamp> | null;
    if (typeof v?.at !== "number") return null;
    return {
      at: v.at,
      answer: isAnswer(v.answer) ? v.answer : null,
      reloads: typeof v.reloads === "number" ? v.reloads : 0,
    };
  } catch {
    return null;
  }
}

function writeStamp(answer: ResumeAnswer, reloads = 0): void {
  durableSessionSet(ONCE_KEY, JSON.stringify({ at: Date.now(), answer, reloads }), "resume.once");
}

type View = { kind: "working" } | { kind: "busy" } | { kind: "signedOut"; reason: SignedOutReason };

export function ResumeScreen({ initialOwner = null }: { initialOwner?: string | null }) {
  const t = useTranslations("resume");
  const [view, setView] = useState<View>({ kind: "working" });
  /** React 18 StrictMode double-invokes effects in dev; the refresh must fire once. */
  const started = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /*
   * The account this splash was chosen for. `initialOwner` is the marker as the EDGE saw it; the jar
   * can have changed hands since (hydration, then the lock's wait), and a refresh under somebody
   * else's jar rotates THEIR session from a window that is not theirs. `null` means the edge saw no
   * marker — a cross-site navigation that withheld the cookies — and nothing is compared.
   */
  const stillMine = useCallback(
    (): boolean => initialOwner === null || readOwner() === initialOwner,
    [initialOwner],
  );

  /**
   * One pass of the ladder: ask, then act on the answer. `resumeSession` consults `stillMine` inside
   * the lock, so no second check stands before the call.
   */
  const attempt = useCallback(async (n: number): Promise<void> => {
    const ok = await resumeSession({ mayProceed: stillMine });
    // The jar changed while this waited for the lock: the browser holds somebody else's session.
    if (!ok && !stillMine()) { window.location.reload(); return; }
    const report = lastRefreshReport();
    const answer = answerOf(ok, report);
    if (answer === "minted") {
      // Stamped BEFORE the reload: the next pass reads it to tell the gate refusing a live jar.
      writeStamp("minted");
      window.location.reload();
      return;
    }
    if (answer !== "unavailable") {
      // The server cleared the jar (or held none). No `?next=`: nothing to pass that is not
      // already in the fragment, and a redirect parameter is an open-redirect surface.
      writeStamp(answer);
      leaveSignedOutNote(answer);
      window.location.replace("/login");
      return;
    }
    if (n >= CONFIRM_ATTEMPTS) { setView({ kind: "busy" }); return; }
    timer.current = setTimeout(() => void attempt(n + 1), nextConfirmDelay(n, report?.retryAfterMs ?? null));
  }, [stillMine]);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const prev = readStamp();
    const looping = prev !== null && Date.now() - prev.at < LOOP_WINDOW_MS;
    if (looping && prev.answer !== null && isSignedOutReason(prev.answer)) {
      writeStamp(prev.answer);
      setView({ kind: "signedOut", reason: prev.answer });
      return;
    }
    if (looping && prev.answer === "minted") {
      if (prev.reloads >= GATE_RELOADS) { setView({ kind: "busy" }); return; }
      const reloads = prev.reloads + 1;
      timer.current = setTimeout(() => {
        writeStamp("minted", reloads);
        window.location.reload();
      }, nextConfirmDelay(reloads, null));
      return;
    }
    void attempt(1);
  }, [attempt]);

  useEffect(() => () => { if (timer.current !== null) clearTimeout(timer.current); }, []);

  const tryAgain = useCallback(() => {
    setView({ kind: "working" });
    void attempt(1);
  }, [attempt]);

  // Deliberately silent while it works: a sentence that flashes for a third of a second is worse
  // than a quiet frame — the same call `EngineProvider`'s "resolving" state makes.
  if (view.kind === "working") return <div className="gate" aria-busy="true" aria-live="polite" />;

  return (
    <div className="gate">
      <div className="gate-card">
        <span className="wordmark">
          <b>
            <em>oh</em>mail
          </b>
        </span>
        {view.kind === "busy" ? (
          <>
            <h1>{t("busyTitle")}</h1>
            <p>{t("busyBody")}</p>
            <div className="gate-actions">
              <button type="button" className="btn primary" onClick={tryAgain}>{t("tryAgain")}</button>
            </div>
          </>
        ) : (
          <>
            <h1>{t("failedTitle")}</h1>
            <p>{t(REASON_BODY[view.reason])}</p>
            <div className="gate-actions">
              <Link className="btn primary" href="/login">{t("signIn")}</Link>
              <Link className="btn" href="/?demo=1">{t("openDemo")}</Link>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** Re-exported so the rewrite guard can assert the splash posts the bare path. */
export { REFRESH_ENDPOINT };
