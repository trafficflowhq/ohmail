"use client";

/**
 * SETTINGS → SECURITY. The pane that did not exist.
 *
 * Every route this calls already shipped; what was missing was any way to reach them once
 * onboarding was over. `JoinScreen` enrolled a factor and issued recovery codes exactly once,
 * and after that the API surface was unreachable from the product:
 *
 *  · **no way to see whether you still hold recovery codes.** `enrolledMethods()` offers
 *    `recovery_code` at login only while at least one UNUSED code remains, so burning the last
 *    one silently removes the option from the sign-in screen — with no message, and no page
 *    anywhere that says so.
 *  · **no way to mint new ones.** `POST /auth/2fa/recovery-codes` existed and had one caller,
 *    in the signup wizard.
 *  · **no way to re-enrol or remove TOTP** after the fact — so a lost authenticator meant a lost
 *    account for anyone who had also used up their codes.
 *
 * Injected as a ReactNode by `CloudShell`, exactly like `AccountSection`, and for the same
 * reason: this pane is `auth`, `apiConfigured()` and a step-up ceremony, none of which exist in
 * the Desktop mirror or under `?demo=1`. `SettingsView` renders the slot and knows nothing.
 *
 * REGENERATION IS DESTRUCTIVE AND SAYS SO. `recoveryCodes()` replaces the whole set, so the old
 * codes — possibly the ones in the user's password manager — stop working the moment the new
 * list appears. The confirm step exists for that, not for ceremony.
 *
 * ── AND IT IS BUILT OUT OF THE SAME PARTS AS EVERY OTHER PANE ───────────────────────────
 *
 * Reported as looking unlike the rest of Settings, and it did, for a plain reason: the markup
 * it shipped with named a private set of classes — `.set-security`, `.set-sec-block`,
 * `.set-sec-actions`, `.set-sec-warn`, `.set-sec-codes`, `.set-sec-secret`, `.set-sec-error` —
 * and **not one of them had a rule anywhere in the stylesheet**. Its controls were bare
 * `<button>` elements, so they never picked up the `.btn` capsule either. The pane was not
 * styled differently; it was unstyled, next to four panes that are.
 *
 * So it is rebuilt on what Account, Subscription and Mailboxes already use: `SettingsSection`
 * for the panel, `SettingsRow` for a fact with a control beside it, `Button` for every verb,
 * and the `acct-*` / `join-*` classes that exist. The recovery-code list reuses `.join-codes`
 * — the same grid the signup wizard prints the same codes into, which is the one place a user
 * has seen them before.
 *
 * Behaviour is untouched: same calls, same order, same states, same sentences.
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
       * ── A FAILED READ IS NOT AN EMPTY RESULT — THE COMMENT HERE WAS THE CLAIM, AND IT WAS FALSE ──────────────────
       *
       * It said an unreadable session "renders nothing actionable rather than something
       * false". Both halves were wrong, and this is the worst of the five panes it was wrong
       * in, because of what the second half offers.
       *
       * `enrolled` stayed `null`, `loading` was cleared in the `finally`, and the pane
       * painted: `:139` reads **"You have no unused recovery codes. Without them, losing
       * your authenticator locks you out."**, `:174` reads **"No authenticator app is set
       * up."**, and `:166` — because `enrolled?.recoveryCodes` is falsy — offers
       * **"Generate recovery codes"** rather than "Replace". That call REPLACES the set the
       * account already holds. So a swallowed read did not merely say something false: it
       * argued a person into destroying credentials they were relying on, using an alarming
       * sentence about being locked out as the argument.
       *
       * A pane whose entire content is assertions about `enrolled` has nothing honest to
       * render when `enrolled` was never read. So it renders the reason and stops — which is
       * what the old comment claimed and what a read-failure guard now holds
       * it to.
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
