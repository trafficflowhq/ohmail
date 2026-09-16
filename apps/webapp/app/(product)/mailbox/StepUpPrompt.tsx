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

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@ohmail/ui";
import { ApiError, auth, assertPasskey, messageOf, webauthnAvailable } from "../../api-client";
import { useCeremonyGeneration } from "../ceremony-generation";

interface Props {
  /** The re-verification succeeded — retry the verb that was refused. */
  onVerified: () => void;
  onCancel: () => void;
  /**
   * A factor landed after Cancel and was discarded — the parked verb did NOT run. The host says
   * so, not this prompt: Cancel hands the pane back, so by then there is nothing here to read.
   */
  onDiscarded: () => void;
}

export function StepUpPrompt({ onVerified, onCancel, onDiscarded }: Props) {
  const t = useTranslations("devices");

  /**
   * The refusal, told honestly. A lockout (423 `account_locked`) carries `retryAfter` seconds
   * in its details, and "too many failed attempts" without the "for how long" reads as
   * for ever — the sentence must say when trying again is worth it. Everything else is the
   * server's own message, verbatim, `messageOf`'s standing contract.
   */
  const refusalText = useCallback(
    (err: unknown): string => {
      if (err instanceof ApiError && err.code === "account_locked") {
        const retryAfter = (err.details as { retryAfter?: unknown } | undefined)?.retryAfter;
        const seconds = typeof retryAfter === "number" && retryAfter > 0 ? retryAfter : 15 * 60;
        return t("stepUpLocked", { minutes: Math.max(1, Math.ceil(seconds / 60)) });
      }
      return messageOf(err);
    },
    [t],
  );
  const [enrolled, setEnrolled] = useState<{ webauthn: boolean; totp: boolean } | null>(null);
  const [method, setMethod] = useState<"webauthn" | "totp">("totp");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * THE CEREMONY'S GENERATION, the same one the account erase runs on, in place of the unmount
   * latch this used to rely on. Unmount closed the window only because the host happens to drop
   * the prompt on Cancel — a pane need not go away for the ceremony to be over, and the parked
   * verb is somebody's device or session either way. Cancel bumps, `finish` compares.
   */
  const ceremony = useCeremonyGeneration();

  useEffect(() => {
    void (async () => {
      try {
        const { user } = await auth.session();
        const e = { webauthn: user.twofaEnrolled.webauthn, totp: user.twofaEnrolled.totp };
        setEnrolled(e);
        // The sign-in screen's preference verbatim: a passkey when one exists AND this
        // browser can run the ceremony; the code otherwise.
        setMethod(e.webauthn && webauthnAvailable() ? "webauthn" : "totp");
      } catch (err) {
        setError(messageOf(err));
      }
    })();
  }, []);

  const finish = useCallback(
    (fn: () => Promise<void>) => {
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
          setError(refusalText(err));
          setBusy(false);
        }
      })();
    },
    [ceremony, onDiscarded, onVerified, refusalText],
  );

  const withPasskey = () =>
    finish(async () => {
      const { options } = await auth.stepUpWebauthnOptions();
      const credential = await assertPasskey(options);
      await auth.stepUpWebauthnVerify({ credential });
    });

  const withCode = (e: React.FormEvent) => {
    e.preventDefault();
    if (busy || code.trim().length === 0) return;
    finish(async () => {
      await auth.stepUpTotp({ code: code.trim() });
      setCode("");
    });
  };

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
            <button
              type="button"
              className="join-alt"
              onClick={() => {
                setMethod("totp");
                setError(null);
              }}
            >
              {t("stepUpTotpToggle")}
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
            <button
              type="button"
              className="join-alt"
              onClick={() => {
                setMethod("webauthn");
                setError(null);
              }}
            >
              {t("stepUpPasskeyToggle")}
            </button>
          ) : null}
        </>
      )}
    </div>
  );
}
