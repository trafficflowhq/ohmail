"use client";

/**
 * The resume splash — the half-second that turns a 15-minute session into a 90-day one. `tf_refresh` is
 * scoped `Path=/auth/refresh`, invisible to a request for `/`, so `tf_resume` lets the gate send such a
 * browser here and this page makes the same-origin `POST /auth/refresh` the edge cannot (widening the
 * cookie's Path is forbidden). It reads the refresh door's ANSWER, never its absence: a mint reloads; the
 * door's three refusals go to `/login` with the sentence that names which; a fault — a busy database, a
 * 429, no response — retries here with the jar untouched and ends on "could not be reached", never on
 * a sign-in. It RELOADS rather than navigating: `location.replace("/" + hash)` is a fragment change.
 * Its card paints from the first frame, server-rendered: the wait for the door is never a blank page.
 * It never finishes a sign-out: see {@link signOutPending}.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { REFRESH_ENDPOINT, lastRefreshReport, resumeSession, type RefreshReport } from "../../session-refresh";
import { readOwnerCookie, readOwnerMarker } from "../../shell/owner-cookie";
import { storageOwner } from "../../shell/storage-owner";
import { durableSessionRemove, durableSessionSet } from "../../shell/durable";
import { CONFIRM_ATTEMPTS, nextConfirmDelay } from "../../shell/confirm-schedule";
import { useLoadingGrace } from "../../shell/loading-grace";
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

/**
 * A SIGN-OUT THIS BROWSER ASKED FOR AND THE SERVER NEVER CONFIRMED, read off the jar itself. The edge
 * sends such a browser to `/login`, which finishes it; but `tf_owner` is `SameSite=Strict`, so a
 * navigation from another site reaches the edge without it and lands here. Such a jar is never
 * resumed: the splash asks no door and leaves for `/login`.
 */
function signOutPending(): boolean {
  return readOwnerMarker().kind === "signed-out";
}

type View = { kind: "working" } | { kind: "busy" } | { kind: "signedOut"; reason: SignedOutReason };

export function ResumeScreen({ initialOwner = null, staleJar }: { initialOwner?: string | null; staleJar?: string }) {
  const t = useTranslations("resume");
  const [view, setView] = useState<View>({ kind: "working" });
  /** Past the loading grace the card says what it waits for; below it, the card alone. */
  const slow = useLoadingGrace(view.kind === "working");
  /** React 18 StrictMode double-invokes effects in dev; the refresh must fire once. */
  const started = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /*
   * The account this splash was chosen for. `initialOwner` is the marker as the EDGE saw it; the jar
   * can have changed hands since (hydration, then the lock's wait), and a refresh under somebody
   * else's jar rotates THEIR session from a window that is not theirs. `null` means the edge saw no
   * marker — a cross-site navigation that withheld the cookies — and nothing is compared. Raw against
   * raw: the parsed reading is null for `signed_out_pending` and for any malformed value, so it never
   * matched the edge's and every pass reloaded. A pending sign-out in the jar is never this splash's,
   * whatever the edge saw.
   */
  const stillMine = useCallback(
    (): boolean => !signOutPending() && (initialOwner === null || readOwnerCookie() === initialOwner),
    [initialOwner],
  );

  /** The jar is not this splash's: a pending sign-out goes to `/login`, anything else to the edge again. */
  const leave = useCallback((): void => {
    if (signOutPending()) { window.location.replace("/login"); return; }
    window.location.reload();
  }, []);

  /**
   * One pass of the ladder: ask, then act on the answer. `resumeSession` consults `stillMine` inside
   * the lock, so no second check stands before the call. `landing`: a reload of this splash while
   * its renewal was out waits for that renewal's answer rather than presenting the token again.
   * `staleJar`: the jar the edge judged stale; one another tab renewed past it is taken, not rotated again.
   */
  const attempt = useCallback(async (n: number): Promise<void> => {
    const before = lastRefreshReport();
    const ok = await resumeSession({ mayProceed: stillMine, landing: true, staleJar }) === "resumed";
    const report = lastRefreshReport();
    // The door's own refusal clears the jar, tf_owner with it: that is this splash's answer.
    const owner = readOwnerCookie();
    const refusedHere = !ok && report !== before && report?.outcome === "revoked" && report.status === 401
      && (owner === null || owner === initialOwner);
    // The jar changed while this waited for the lock: somebody else's session, or its own sign-out.
    if (!ok && !refusedHere && !stillMine()) { leave(); return; }
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
    // A renewal that met its own deadline already waited longer than the whole ladder would: the
    // busy card at once, whose Try again asks again. Never a sign-in — nothing was learned.
    if (n >= CONFIRM_ATTEMPTS || report?.timedOut !== undefined) { setView({ kind: "busy" }); return; }
    timer.current = setTimeout(() => void attempt(n + 1), nextConfirmDelay(n, report?.retryAfterMs ?? null));
  }, [initialOwner, leave, staleJar, stillMine]);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    // Before anything is asked: a sign-out this browser asked for is finished at `/login`.
    if (signOutPending()) { leave(); return; }
    if (countPass() > RESUME_PASS_LIMIT) { setView({ kind: "busy" }); return; }
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
  }, [attempt, leave]);

  useEffect(() => () => { if (timer.current !== null) clearTimeout(timer.current); }, []);

  const tryAgain = useCallback(() => {
    // A person asked: the pass count starts again from here.
    durableSessionRemove(RESUME_PASSES_KEY, "resume.passes");
    setView({ kind: "working" });
    void attempt(1);
  }, [attempt]);

  // The card from the first frame. While it works, one line once the wait outlasts the grace: a
  // sentence that flashes is worse than a quiet card, and a bare page for the door's whole wait
  // reads as broken (measured: 20 s of nothing behind a slow refresh door).
  const working = view.kind === "working";
  return (
    <div className="gate" aria-busy={working ? "true" : undefined} aria-live={working ? "polite" : undefined}>
      <div className="gate-card">
        <span className="wordmark">
          <b>
            <em>oh</em>mail
          </b>
        </span>
        {view.kind === "working" ? (
          slow ? <p>{t("workingBody")}</p> : null
        ) : view.kind === "busy" ? (
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
