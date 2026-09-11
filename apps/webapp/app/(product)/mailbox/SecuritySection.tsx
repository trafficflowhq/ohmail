"use client";

/**
 * Settings → Security. Every route this calls already shipped; what was missing was any way to reach them after
 * onboarding: no way to see whether you still hold recovery codes (burning the last one silently removed the option
 * from the sign-in screen), no way to mint new ones (`POST /auth/2fa/recovery-codes` had one caller, in the signup
 * wizard), no way to re-enrol or remove TOTP — a lost authenticator meant a lost account for anyone who had used up
 * their codes.
 */

/**
 * Injected as a ReactNode by `CloudShell`, like `AccountSection` and for the same reason: `auth`, `apiConfigured()`
 * and a step-up ceremony exist neither in the Desktop mirror nor under `?demo=1`. Regeneration is destructive and
 * says so: `recoveryCodes()` replaces the whole set, so the confirm step exists for that, not ceremony. Rebuilt on
 * the parts every other pane uses (`SettingsSection`, `SettingsRow`, `Button`, the `.join-codes` grid the wizard
 * prints into) — the shipped markup named a private class set with no rule anywhere in the stylesheet, so the pane
 * was not styled differently, it was unstyled. Behaviour untouched.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Button, SettingsRow, SettingsSection } from "@ohmail/ui";
import { ApiError, apiConfigured, auth, messageOf } from "../../api-client";

type Busy = null | "codes" | "totp-enroll" | "totp-activate" | "totp-remove";

interface Enrolled {
  webauthn: boolean;
  totp: boolean;
  recoveryCodes: boolean;
}

export function SecuritySection() {
  const t = useTranslations("security");

  const [enrolled, setEnrolled] = useState<Enrolled | null>(null);
  const [loading, setLoading] = useState(true);
  /** A failed read is not an empty result. The enrollment read REFUSED — distinct from "not back yet" (`loading`). */
  const [readFailed, setReadFailed] = useState(false);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);

  const [codes, setCodes] = useState<string[] | null>(null);
  const [confirmCodes, setConfirmCodes] = useState(false);

  const [totp, setTotp] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [totpCode, setTotpCode] = useState("");

  /** The pane can be navigated away from mid-ceremony; nothing may set state after that. */
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const refresh = useCallback(async () => {
    try {
      const { user } = await auth.session();
      if (!alive.current) return;
      setEnrolled(user?.twofaEnrolled ?? null);
      setReadFailed(false);
    } catch (err) {
      /**
       * A failed read is not an empty result — the comment here was the claim, and it was false. It said an
       * unreadable session "renders nothing actionable rather than something false"; both halves were wrong, and this
       * is the worst of the five panes it was wrong in: `enrolled` stayed `null`, the pane painted "You have no
       * unused recovery codes… losing your authenticator locks you out.", "No authenticator app is set up.", and
       * offered "Generate recovery codes" — a call that REPLACES the set the account already holds.
       */

      /**
       * A swallowed read did not merely say something false: it argued a person into destroying credentials they were
       * relying on, with an alarming sentence as the argument. A pane whose entire content is assertions about
       * `enrolled` has nothing honest to render when `enrolled` was never read — it renders the reason and stops,
       * which a read-failure guard now holds it to.
       */
      if (alive.current) { setReadFailed(true); setError(messageOf(err)); }
    } finally {
      if (alive.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!apiConfigured()) {
      setLoading(false);
      return;
    }
    void refresh();
  }, [refresh]);

  /**
   * A step-up-gated call, reported honestly. `withStepUp` answers 401/403 when the window has
   * closed, and the ONLY correct response is to tell the user to sign in again — silently
   * swallowing it is how "2FA does not work" becomes the report instead of "your step-up
   * expired".
   */
  const run = useCallback(async (kind: Exclude<Busy, null>, fn: () => Promise<void>) => {
    setBusy(kind);
    setError(null);
    try {
      await fn();
    } catch (err) {
      if (!alive.current) return;
      setError(err instanceof ApiError && (err.status === 401 || err.status === 403)
        ? t("stepUpExpired")
        : messageOf(err));
    } finally {
      if (alive.current) setBusy(null);
    }
  }, [t]);

  const regenerate = () => run("codes", async () => {
    const { codes: fresh } = await auth.recoveryCodes();
    if (!alive.current) return;
    setCodes(fresh);
    setConfirmCodes(false);
    await refresh();
  });

  const enrollTotp = () => run("totp-enroll", async () => {
    const started = await auth.totpEnroll();
    if (alive.current) setTotp(started);
  });

  const activateTotp = () => run("totp-activate", async () => {
    await auth.totpActivate({ code: totpCode.trim() });
    if (!alive.current) return;
    setTotp(null);
    setTotpCode("");
    await refresh();
  });

  const removeTotp = () => run("totp-remove", async () => {
    await auth.totpRemove();
    if (alive.current) await refresh();
  });

  if (!apiConfigured() || loading) return null;

  return (
    <SettingsSection className="acct">
      <h2 className="acct-h">{t("title")}</h2>
      <p className="acct-lead">{t("intro")}</p>

      {error ? <p className="acct-warn" role="alert">{error}</p> : null}

      {/* ── A FAILED READ IS NOT AN EMPTY RESULT — NOTHING BELOW THIS LINE IS KNOWN, SO NOTHING BELOW IT IS SHOWN ──
          Every block that follows is an assertion about `enrolled`, and the destructive one
          ("Generate recovery codes", which replaces the set in use) is offered precisely when
          `enrolled` is falsy. An unread session must not be able to reach it. */}
      {readFailed ? null : (
      <>
      {/* ── Recovery codes ─────────────────────────────────────────────────────────────
          The state is the row's description and the verb is its control, which is the shape
          every other settings row in the product already has. The two ceremonies below it
          — reveal, and confirm-before-replace — take the row's place rather than growing
          under it, so the pane never shows a button and the consequence of pressing it as
          two competing things. */}
      <SettingsRow
        label={t("codesTitle")}
        description={enrolled?.recoveryCodes ? t("codesHeld") : t("codesNone")}
        control={
          codes || confirmCodes ? undefined : (
            <span className="acct-row-act">
              <Button onClick={() => setConfirmCodes(true)}>
                {enrolled?.recoveryCodes ? t("codesReplace") : t("codesGenerate")}
              </Button>
            </span>
          )
        }
      />

      {codes ? (
        <div className="acct-confirm">
          <p className="acct-warn">{t("codesShownOnce")}</p>
          {/* `.join-codes` — the same two-column grid the signup wizard prints these into.
              A second layout for one list of codes is a second thing to keep in step. */}
          <ul className="join-codes">
            {codes.map((c) => <li key={c}><code>{c}</code></li>)}
          </ul>
          <div className="acct-actions">
            <Button onClick={() => setCodes(null)}>{t("codesDone")}</Button>
          </div>
        </div>
      ) : confirmCodes ? (
        <div className="acct-confirm">
          <p className="acct-warn">{t("codesReplaceWarning")}</p>
          <div className="acct-actions">
            <Button variant="primary" className="danger" onClick={regenerate} disabled={busy === "codes"}>
              {busy === "codes" ? t("working") : t("codesConfirm")}
            </Button>
            <Button onClick={() => setConfirmCodes(false)}>{t("cancel")}</Button>
          </div>
        </div>
      ) : null}

      {/* ── Authenticator app ────────────────────────────────────────────────────────── */}
      <SettingsRow
        label={t("totpTitle")}
        description={enrolled?.totp ? t("totpOn") : t("totpOff")}
        control={
          totp ? undefined : (
            <span className="acct-row-act">
              <Button onClick={enrollTotp} disabled={busy === "totp-enroll"}>
                {busy === "totp-enroll" ? t("working") : enrolled?.totp ? t("totpReplace") : t("totpAdd")}
              </Button>
              {/* Removal is offered only when another factor would survive it. Taking away the
                  last factor from inside a signed-in session is how an account becomes
                  unreachable, and the server refuses it anyway — so do not offer it. */}
              {enrolled?.totp && enrolled.webauthn ? (
                <Button onClick={removeTotp} disabled={busy === "totp-remove"}>
                  {busy === "totp-remove" ? t("working") : t("totpRemove")}
                </Button>
              ) : null}
            </span>
          )
        }
      />

      {totp ? (
        <div className="acct-confirm">
          <p className="acct-fine">{t("totpScan")}</p>
          {/* The secret is shown as text as well as a URI: an authenticator that cannot scan
              still has to be enrollable, and this is the "secret key" entry path. */}
          <p className="join-secret">{totp.secret}</p>
          <label className="join-label" htmlFor="sec-totp">{t("totpCodeLabel")}</label>
          <input
            id="sec-totp"
            className="join-input join-code"
            value={totpCode}
            onChange={(e) => setTotpCode(e.target.value)}
            inputMode="numeric"
            autoComplete="one-time-code"
          />
          <div className="acct-actions">
            <Button
              variant="primary"
              onClick={activateTotp}
              disabled={busy === "totp-activate" || totpCode.trim().length === 0}
            >
              {busy === "totp-activate" ? t("working") : t("totpActivate")}
            </Button>
            <Button onClick={() => { setTotp(null); setTotpCode(""); }}>{t("cancel")}</Button>
          </div>
        </div>
      ) : null}
      </>
      )}
    </SettingsSection>
  );
}
