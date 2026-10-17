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
import { OWNER_SIGNED_OUT, readOwnerCookie } from "../../shell/owner-cookie";
import { signOutTrouble, type SignOutTrouble } from "../../sign-out-trouble";
import { storageOwner } from "../../shell/storage-owner";
import { durableSessionRemove, durableSessionSet } from "../../shell/durable";
import { CONFIRM_ATTEMPTS, nextConfirmDelay } from "../../shell/confirm-schedule";
import { REASON_BODY, isSignedOutReason, leaveSignedOutNote, type SignedOutReason } from "./signed-out-note";

/**
 * Survives the reload a successful resume performs; scoped to this tab AND to the account, so a
 * second account resuming in the same tab never reads the first one's loop guard as its own.
 */
export function resumeOnceKey(owner: string | null = storageOwner()): string {
  return `ohmail.resume-attempted.${owner ?? "local"}`;
}

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
    const raw = sessionStorage.getItem(resumeOnceKey());
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
  durableSessionSet(resumeOnceKey(), JSON.stringify({ at: Date.now(), answer, reloads }), "resume.once");
}

/**
 * EVERY PASS THROUGH THIS SPLASH, counted per tab and keyed by nothing that can change between
 * passes. The stamp above is keyed by `tf_owner`, and a pass that reloaded without stamping (the
 * jar compared as changed hands) left nothing to read: on ohmail.app the splash reloaded about five
 * times a second until the platform's firewall stepped in. Past the limit the busy card stands
 * until somebody presses Try again; the minted ladder above takes five passes at most.
 */
export const RESUME_PASSES_KEY = "ohmail.resume.passes";
export const RESUME_PASS_LIMIT = 6;
export const RESUME_PASS_WINDOW_MS = 60_000;

/** Count this pass and answer its number within the window. */
function countPass(): number {
  let prev: { first?: unknown; n?: unknown } | null = null;
  try {
    const raw = sessionStorage.getItem(RESUME_PASSES_KEY);
    prev = raw === null ? null : (JSON.parse(raw) as { first?: unknown; n?: unknown } | null);
  } catch {
    prev = null;
  }
  const now = Date.now();
  const age = typeof prev?.first === "number" ? now - prev.first : -1;
  const open = age >= 0 && age < RESUME_PASS_WINDOW_MS && typeof prev?.n === "number";
  const pass = { first: open ? (prev!.first as number) : now, n: open ? (prev!.n as number) + 1 : 1 };
  durableSessionSet(RESUME_PASSES_KEY, JSON.stringify(pass), "resume.passes");
  return pass.n;
}

type View =
  | { kind: "working" } | { kind: "busy" } | { kind: "signedOut"; reason: SignedOutReason }
  | { kind: "signOut"; said: SignOutTrouble };

export function ResumeScreen({ initialOwner = null }: { initialOwner?: string | null }) {
  const t = useTranslations("resume");
  /* The account pane's sentences for a sign-out that did not finish: one taxonomy, one set of words. */
  const ta = useTranslations("account");
  /** The edge chose this splash for a sign-out the server never confirmed: it is finished, not resumed. */
  const finishing = initialOwner === OWNER_SIGNED_OUT;
  const [view, setView] = useState<View>({ kind: "working" });
  /** React 18 StrictMode double-invokes effects in dev; the refresh must fire once. */
  const started = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /*
   * The account this splash was chosen for. `initialOwner` is the marker as the EDGE saw it; the jar
   * can have changed hands since (hydration, then the lock's wait), and a refresh under somebody
   * else's jar rotates THEIR session from a window that is not theirs. `null` means the edge saw no
   * marker — a cross-site navigation that withheld the cookies — and nothing is compared. Raw against
   * raw: the parsed reading is null for `signed_out_pending` and for any malformed value, so it never
   * matched the edge's and every pass reloaded.
   */
  const stillMine = useCallback(
    (): boolean => initialOwner === null || readOwnerCookie() === initialOwner,
    [initialOwner],
  );

  /**
   * One pass of the ladder: ask, then act on the answer. `resumeSession` consults `stillMine` inside
   * the lock, so no second check stands before the call. `landing`: a reload of this splash while
   * its renewal was out waits for that renewal's answer rather than presenting the token again.
   */
  const attempt = useCallback(async (n: number): Promise<void> => {
    const ok = await resumeSession({ mayProceed: stillMine, landing: true }) === "resumed";
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

  /**
   * FINISH THE SIGN-OUT THIS BROWSER ASKED FOR. Its server half went unconfirmed, so the session may
   * still be live: it is presented at the sign-out door, never the refresh door, and the local half
   * runs again. Confirmed lands on /login; a fault walks the confirm ladder, then says so. No reload.
   */
  const finish = useCallback(async (n: number): Promise<void> => {
    // Another tab signed in since the edge chose this page: that jar is not this splash's to end.
    if (!stillMine()) { window.location.reload(); return; }
    const { signOut } = await import("../../sign-out");
    const said = signOutTrouble(await signOut());
    if (said === null) { window.location.replace("/login"); return; }
    if (said.key === "signOutServerRefused" && n < CONFIRM_ATTEMPTS) {
      timer.current = setTimeout(() => void finish(n + 1), nextConfirmDelay(n, null));
      return;
    }
    setView({ kind: "signOut", said });
  }, [stillMine]);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (countPass() > RESUME_PASS_LIMIT) { setView({ kind: "busy" }); return; }
    if (finishing) { void finish(1); return; }
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
  }, [attempt, finish, finishing]);

  useEffect(() => () => { if (timer.current !== null) clearTimeout(timer.current); }, []);

  const tryAgain = useCallback(() => {
    // A person asked: the pass count starts again from here.
    durableSessionRemove(RESUME_PASSES_KEY, "resume.passes");
    setView({ kind: "working" });
    void (finishing ? finish(1) : attempt(1));
  }, [attempt, finish, finishing]);

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
        ) : view.kind === "signOut" ? (
          <>
            <h1>{ta("signOutTitle")}</h1>
            <p role="alert">
              {view.said.key === "signOutServerRefused"
                ? ta(view.said.key, { reason: view.said.reason })
                : ta(view.said.key)}
            </p>
            <div className="gate-actions">
              <button type="button" className="btn primary" onClick={tryAgain}>{ta("signOut")}</button>
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
