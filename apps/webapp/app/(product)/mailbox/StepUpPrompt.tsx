"use client";

/**
 * The inline step-up — the second factor, asked for in place, where the dead end used to be. Every credential verb in
 * Settings is step-up-gated on a five-minute window, and the pane's only answer to a stale window used to be "sign in
 * again" — a full round trip for someone already sitting in their signed-in mailbox. This asks for the factor the
 * account actually has (passkey preferred when the browser can do the ceremony, the authenticator code otherwise —
 * `LoginScreen`'s exact preference), calls the step-up re-verification endpoints, and hands control back to the
 * caller, which retries the refused verb.
 */

/**
 * No sign-out, no new session, no cookie changes — the server re-stamps the session the browser holds, and a census
 * holds its response to nothing else. The factor set comes from `GET /auth/session` (`twofaEnrolled`) at mount, the
 * read `SecuritySection` trusts, so the prompt never offers a ceremony the account cannot finish.
 */

import { useCallback, useEffect, useLayoutEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@ohmail/ui";
import { auth, assertPasskey, webauthnAvailable } from "../../api-client";
import { isOwnerAbsent } from "../approve/settle-owner";
import { useCeremonyGeneration } from "../ceremony-generation";
import { serverAnswered, useRefusalSentence } from "../refusal-sentence";

interface Props {
  /** The re-verification succeeded — retry the verb that was refused. */
  onVerified: () => void;
  onCancel: () => void;
  /**
   * A factor landed after Cancel and was discarded — the parked verb did NOT run. The host says
   * so, not this prompt: Cancel hands the pane back, so by then there is nothing here to read.
   */
  onDiscarded: () => void;
  /**
   * This browser's marker went while the prompt was up (`owner_absent`): the host's settle step
   * answers it (`approve/settle-owner.ts`) and the prompt says nothing. A host with no settle step
   * leaves it out, and the refusal is said like any other.
   */
  onOwnerAbsent?: () => void;
}

export function StepUpPrompt({ onVerified, onCancel, onDiscarded, onOwnerAbsent }: Props) {
  const t = useTranslations("devices");
  const refusalSentence = useRefusalSentence();

  /**
   * The refusal, in the reader's language. A server answer is never shown as written: the step-up
   * doors answer in lowercase English diagnostics ("two-factor verification failed"), so each maps
   * to this prompt's sentence — a 401 by the factor `tried`, the lockout with its `retryAfter`
   * ("too many attempts" without "for how long" reads as for ever), the throttle, and one sentence
   * for anything else. Client-raised refusals go through the one renderer.
   */
  const refusalText = useCallback(
    (err: unknown, tried?: "code" | "passkey" | "recovery"): string => {
      if (!serverAnswered(err)) return refusalSentence(err);
      if (err.code === "account_locked") {
        const retryAfter = (err.details as { retryAfter?: unknown } | undefined)?.retryAfter;
        const seconds = typeof retryAfter === "number" && retryAfter > 0 ? retryAfter : 15 * 60;
        return t("stepUpLocked", { minutes: Math.max(1, Math.ceil(seconds / 60)) });
      }
      if (err.code === "sign_in_slowed") return t("stepUpSlowed");
      if (err.status === 401 && tried) {
        return t(tried === "code" ? "stepUpBadCode" : tried === "passkey" ? "stepUpBadPasskey" : "stepUpBadRecoveryCode");
      }
      return t("stepUpRefused");
    },
    [t, refusalSentence],
  );
  const [enrolled, setEnrolled] = useState<{ webauthn: boolean; totp: boolean; recoveryCodes: boolean } | null>(null);
  const [method, setMethod] = useState<"webauthn" | "totp" | "recovery">("totp");
  const [code, setCode] = useState("");
  /** A recovery code, for somebody whose authenticator is gone. Kept apart from the six digits. */
  const [recovery, setRecovery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * THE CEREMONY'S GENERATION, the same one the account erase runs on, in place of the unmount
   * latch this used to rely on. Unmount closed the window only because the host happens to drop
   * the prompt on Cancel — a pane need not go away for the ceremony to be over, and the parked
   * verb is somebody's device or session either way. Cancel bumps, `finish` compares.
   */
  const ceremony = useCeremonyGeneration();
  // Leaving ends it as Cancel does: the wall's Back or another Settings pane drops the prompt with
  // no Cancel pressed, and a factor landing after that runs nothing. In the commit that removes it.
  useLayoutEffect(() => () => { ceremony.end(); }, [ceremony.end]);

  useEffect(() => {
    void (async () => {
      try {
        const { user } = await auth.session();
        const e = {
          webauthn: user.twofaEnrolled.webauthn, totp: user.twofaEnrolled.totp,
          recoveryCodes: user.twofaEnrolled.recoveryCodes === true,
        };
        setEnrolled(e);
        // The sign-in screen's preference verbatim: a passkey when one exists AND this
        // browser can run the ceremony; the code otherwise.
        setMethod(e.webauthn && webauthnAvailable() ? "webauthn" : "totp");
      } catch (err) {
        // The ceremony ends first, so a factor already on its way runs nothing the page parked.
        if (isOwnerAbsent(err) && onOwnerAbsent) { ceremony.end(); onOwnerAbsent(); return; }
        setError(refusalText(err));
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one read, at mount
  }, []);

  const finish = useCallback(
    (tried: "code" | "passkey" | "recovery", fn: () => Promise<void>) => {
      setBusy(true);
      setError(null);
      // BEFORE the first await: this closure's identity is the ceremony it started in, never
      // whichever one is current when its response happens to land.
      const gen = ceremony.begin();
      void (async () => {
        try {
          await fn();
          // THE ONE DOOR. A factor that lands after Cancel runs no parked verb and says so.
          if (!ceremony.claim(gen)) {
            setBusy(false);
            onDiscarded();
            return;
          }
          onVerified();
        } catch (err) {
          // A failed ceremony is over: end it, so a second response cannot act either.
          ceremony.end();
          setBusy(false);
          if (isOwnerAbsent(err) && onOwnerAbsent) { onOwnerAbsent(); return; }
          setError(refusalText(err, tried));
        }
      })();
    },
    [ceremony, onDiscarded, onOwnerAbsent, onVerified, refusalText],
  );

  const withPasskey = () =>
    finish("passkey", async () => {
      const { options } = await auth.stepUpWebauthnOptions();
      const credential = await assertPasskey(options);
      await auth.stepUpWebauthnVerify({ credential });
    });

  const withCode = (e: React.FormEvent) => {
    e.preventDefault();
    if (busy || code.trim().length === 0) return;
    finish("code", async () => {
      await auth.stepUpTotp({ code: code.trim() });
      setCode("");
    });
  };

  const withRecovery = (e: React.FormEvent) => {
    e.preventDefault();
    if (busy || recovery.trim().length === 0) return;
    finish("recovery", async () => {
      await auth.stepUpRecoveryCode({ code: recovery.trim() });
      setRecovery("");
    });
  };

  const choose = (next: "webauthn" | "totp" | "recovery") => {
    setMethod(next);
    setError(null);
  };
  /** The way to a recovery code, offered beside either factor when the account has a sheet. */
  const recoveryToggle = enrolled?.recoveryCodes ? (
    <button type="button" className="join-alt" onClick={() => choose("recovery")}>
      {t("stepUpRecoveryToggle")}
    </button>
  ) : null;

  return (
    <div className="acct-confirm" data-testid="step-up-prompt">
      <p className="acct-lead">{t("stepUpLead")}</p>
      {error ? (
        <p className="acct-warn" role="alert">
          {error}
        </p>
      ) : null}

      {method === "webauthn" ? (
        <>
          <div className="acct-actions">
            <Button variant="primary" icon="shield" onClick={withPasskey} disabled={busy}>
              {busy ? t("working") : t("stepUpPasskey")}
            </Button>
            {/* THE BUMP COMES FIRST — it is what makes a factor already in flight discard its
                result; handing the pane back is what happens after. */}
            <Button variant="ghost" onClick={() => { ceremony.end(); onCancel(); }}>
              {t("cancel")}
            </Button>
          </div>
          {enrolled?.totp ? (
            <button type="button" className="join-alt" onClick={() => choose("totp")}>
              {t("stepUpTotpToggle")}
            </button>
          ) : null}
          {recoveryToggle}
        </>
      ) : method === "recovery" ? (
        <>
          <form onSubmit={withRecovery} className="login-totp">
            <label className="set-note-inline" htmlFor="stepup-recovery">
              {t("stepUpRecoveryLabel")}
            </label>
            <div className="set-row set-tag-edit">
              <input
                id="stepup-recovery"
                className="join-input set-tag-input"
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                maxLength={64}
                value={recovery}
                onChange={(e) => setRecovery(e.target.value)}
              />
              <span className="set-tag-acts">
                <Button variant="primary" type="submit" disabled={busy || recovery.trim().length === 0}>
                  {busy ? t("working") : t("stepUpVerify")}
                </Button>
                <Button variant="ghost" onClick={() => { ceremony.end(); onCancel(); }}>
                  {t("cancel")}
                </Button>
              </span>
            </div>
          </form>
          {enrolled?.totp ? (
            <button type="button" className="join-alt" onClick={() => choose("totp")}>
              {t("stepUpTotpToggle")}
            </button>
          ) : null}
          {enrolled?.webauthn && webauthnAvailable() ? (
            <button type="button" className="join-alt" onClick={() => choose("webauthn")}>
              {t("stepUpPasskeyToggle")}
            </button>
          ) : null}
        </>
      ) : (
        <>
          <form onSubmit={withCode} className="login-totp">
            <label className="set-note-inline" htmlFor="stepup-code">
              {t("stepUpTotpLabel")}
            </label>
            <div className="set-row set-tag-edit">
              <input
                id="stepup-code"
                className="join-input set-tag-input"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={10}
                value={code}
                onChange={(e) => setCode(e.target.value)}
              />
              <span className="set-tag-acts">
                <Button variant="primary" type="submit" disabled={busy || code.trim().length === 0}>
                  {busy ? t("working") : t("stepUpVerify")}
                </Button>
                {/* Same press, same rule — see the passkey arm above. */}
                <Button variant="ghost" onClick={() => { ceremony.end(); onCancel(); }}>
                  {t("cancel")}
                </Button>
              </span>
            </div>
            {/* Codes are single-use ACROSS doors: the one that just signed this person in is
                spent, and the server refuses it with the wrong-code sentence on purpose. Said
                here, before it happens, because the refusal itself may not explain. */}
            <p className="set-note-inline">{t("stepUpCodeHint")}</p>
          </form>
          {enrolled?.webauthn && webauthnAvailable() ? (
            <button type="button" className="join-alt" onClick={() => choose("webauthn")}>
              {t("stepUpPasskeyToggle")}
            </button>
          ) : null}
          {recoveryToggle}
        </>
      )}
    </div>
  );
}
