"use client";

/**
 * Change the password — `POST /auth/password`, for somebody told their password is known. The
 * server checks the current password on the sign-in lockout, asks for a second factor inside the
 * step-up window, and signs every OTHER session out; this one stays as it is. Its own component:
 * `AccountSection` is the erasure ceremony and stays out of it.
 *
 * The change is TRIED on the press, as the erase is. A closed window answers `step_up_required`
 * before anything is checked; the typed values are parked here (memory only) while
 * `StepUpPrompt` re-stamps the session, and the verified factor sends them once. Two answers are
 * read BEFORE `gatedRefusal`, which takes every 401 for a dead session: a wrong current password
 * is 401 `credential_refused`, a verdict said in place (never renewed, never the sign-in dead
 * end), and 423 is the lockout it shares with sign-in. The three fields are emptied on every
 * attempt.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Button, SettingsSection } from "@ohmail/ui";
import { ApiError, apiConfigured, auth } from "../../api-client";
import { serverAnswered, useRefusalSentence } from "../refusal-sentence";
import { StepUpPrompt } from "./StepUpPrompt";
import { gatedRefusal } from "./gated-refusal";

/** The server's rule (`requirePassword`), said before anything is sent. Counted in code points. */
const MIN_LENGTH = 12;
const MAX_LENGTH = 256;

interface Change {
  currentPassword: string;
  newPassword: string;
}

/** `stepup`: the change was refused for a closed window and waits on the prompt. */
type Stage = "form" | "stepup" | "sending";

/** Whole minutes left on a lockout, from the refusal's `retryAfter` seconds; 15 when unsaid. */
function minutesOf(err: ApiError): number {
  const retryAfter = (err.details as { retryAfter?: unknown } | undefined)?.retryAfter;
  const seconds = typeof retryAfter === "number" && retryAfter > 0 ? retryAfter : 15 * 60;
  return Math.max(1, Math.ceil(seconds / 60));
}

export function PasswordSection() {
  const t = useTranslations("passwordChange");
  /* The step-up prompt's namespace, for the sentence when signing in again is the remedy. */
  const td = useTranslations("devices");
  const sentence = useRefusalSentence();

  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [repeat, setRepeat] = useState("");
  const [stage, setStage] = useState<Stage>("form");
  const [error, setError] = useState<string | null>(null);
  /** The last change landed: how many other sessions it signed out. */
  const [revoked, setRevoked] = useState<number | null>(null);
  /** A factor landed after the prompt's Cancel and was discarded: nothing was changed. */
  const [discarded, setDiscarded] = useState(false);
  /** The change the verified factor sends, held only while the prompt is open. */
  const parked = useRef<Change | null>(null);

  /** The pane can be left mid-ceremony; nothing may set state after that. */
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const send = useCallback(async (change: Change, afterFactor: boolean) => {
    setStage("sending");
    setError(null);
    setRevoked(null);
    setDiscarded(false);
    try {
      const out = await auth.changePassword(change);
      parked.current = null;
      if (!alive.current) return;
      setRevoked(out.revoked);
      setStage("form");
    } catch (err) {
      if (!alive.current) return;
      if (err instanceof ApiError && err.status === 401 && err.code === "credential_refused") {
        parked.current = null;
        setStage("form");
        setError(t("wrongCurrent"));
        return;
      }
      if (err instanceof ApiError && err.status === 423) {
        parked.current = null;
        setStage("form");
        setError(t("locked", { minutes: minutesOf(err) }));
        return;
      }
      const why = gatedRefusal(err, afterFactor);
      if (why === "factor") {
        parked.current = change;
        setStage("stepup");
        return;
      }
      parked.current = null;
      setStage("form");
      if (why === "sign-in") setError(td("stepUpExpired"));
      else if (!serverAnswered(err)) setError(sentence(err));
      else if (err.code === "sign_in_slowed") setError(t("slowed"));
      else if (err.status === 409) setError(t("conflict"));
      else setError(t("refused"));
    }
  }, [sentence, t, td]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (stage !== "form") return;
    const change: Change = { currentPassword: current, newPassword: next };
    const again = repeat;
    // Every attempt empties the fields: nothing typed stays on the page behind it.
    setCurrent("");
    setNext("");
    setRepeat("");
    setRevoked(null);
    setDiscarded(false);
    const length = [...change.newPassword].length;
    const refusal = change.currentPassword.length === 0 ? "needCurrent"
      : change.newPassword !== again ? "mismatch"
        : length < MIN_LENGTH ? "tooShort"
          : length > MAX_LENGTH ? "tooLong"
            : change.newPassword === change.currentPassword ? "same"
              : null;
    if (refusal !== null) {
      setError(t(refusal));
      return;
    }
    void send(change, false);
  };

  if (!apiConfigured()) return null;

  return (
    <SettingsSection className="acct">
      <h2 className="acct-h">{t("title")}</h2>
      <p className="acct-lead">{t("lead")}</p>

      {error ? <p className="acct-warn" role="alert">{error}</p> : null}
      {revoked !== null ? (
        <p className="acct-warn" role="status">{t("done", { count: revoked })}</p>
      ) : null}
      {discarded ? <p className="acct-warn" role="status">{t("cancelled")}</p> : null}

      {stage === "stepup" ? (
        <div className="acct-confirm">
          <h3 className="acct-sub">{t("confirmTitle")}</h3>
          {/* Named at the moment it fires: the verified factor sends the change, no further click. */}
          <p className="acct-fine">{t("factorBody")}</p>
          <StepUpPrompt
            onVerified={() => {
              const change = parked.current;
              if (change !== null && alive.current) void send(change, true);
            }}
            onCancel={() => {
              parked.current = null;
              setStage("form");
            }}
            onDiscarded={() => {
              parked.current = null;
              setStage("form");
              setDiscarded(true);
            }}
          />
        </div>
      ) : (
        <form className="acct-confirm" onSubmit={submit}>
          <label className="join-label" htmlFor="pwc-current">{t("currentLabel")}</label>
          <input
            id="pwc-current" className="join-input" type="password" autoComplete="current-password"
            value={current} onChange={(e) => setCurrent(e.target.value)} disabled={stage === "sending"}
          />
          <label className="join-label" htmlFor="pwc-next">{t("nextLabel")}</label>
          <input
            id="pwc-next" className="join-input" type="password" autoComplete="new-password"
            value={next} onChange={(e) => setNext(e.target.value)} disabled={stage === "sending"}
          />
          <label className="join-label" htmlFor="pwc-repeat">{t("repeatLabel")}</label>
          <input
            id="pwc-repeat" className="join-input" type="password" autoComplete="new-password"
            value={repeat} onChange={(e) => setRepeat(e.target.value)} disabled={stage === "sending"}
          />
          <p className="join-hint">{t("nextHint")}</p>
          <div className="acct-actions">
            <Button variant="primary" type="submit" disabled={stage === "sending"}>
              {stage === "sending" ? t("working") : t("submit")}
            </Button>
          </div>
        </form>
      )}
    </SettingsSection>
  );
}
