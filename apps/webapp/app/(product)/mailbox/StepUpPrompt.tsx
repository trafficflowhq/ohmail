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
 * holds its response to nothing else. The factor set, the verify bodies and the refusal's word are the web's step-up
 * door (`web-step-up.ts`); this prompt says them in its own sentences.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@ohmail/ui";
import type { StepUpFactors, StepUpRefusal } from "@ohmail/app/doors/step-up";
import { useCeremonyGeneration } from "@ohmail/app/doors/step-up/ceremony-generation";
import { useRefusalSentence } from "../refusal-sentence";
import { webStepUp } from "./web-step-up";

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

  /** The web's step-up door: the factor set, the three verify bodies, and the refusal as a word. */
  const door = useMemo(() => webStepUp(refusalSentence), [refusalSentence]);

  /**
   * The refusal, in the reader's language. A server answer is never shown as written: the door
   * hands a word — a 401 by the factor tried, the lockout with its minutes ("too many attempts"
   * without "for how long" reads as for ever), the throttle, and one sentence for anything else.
   * Client-raised refusals come said by the one renderer.
   */
  const refusalText = useCallback(
    (refusal: StepUpRefusal): string => {
      switch (refusal.word) {
        case "said": case "owner_absent": return refusal.said;
        case "locked": return t("stepUpLocked", { minutes: refusal.minutes });
        case "slowed": return t("stepUpSlowed");
        case "bad_code": return t("stepUpBadCode");
        case "bad_passkey": return t("stepUpBadPasskey");
        case "bad_recovery": return t("stepUpBadRecoveryCode");
        case "refused": return t("stepUpRefused");
      }
    },
    [t],
  );
  const [enrolled, setEnrolled] = useState<StepUpFactors | null>(null);
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
      const read = await door.factors();
      if (read.ok) {
        setEnrolled(read.factors);
        // The sign-in screen's preference verbatim: a passkey when one exists AND this
        // browser can run the ceremony; the code otherwise.
        setMethod(read.factors.passkey ? "webauthn" : "totp");
        return;
      }
      // The ceremony ends first, so a factor already on its way runs nothing the page parked.
      if (read.refusal.word === "owner_absent" && onOwnerAbsent) { ceremony.end(); onOwnerAbsent(); return; }
      setError(refusalText(read.refusal));
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one read, at mount
  }, []);

  const finish = useCallback(
    (tried: "code" | "passkey" | "recovery", typed: string, verified: () => void) => {
      setBusy(true);
      setError(null);
      // BEFORE the first await: this closure's identity is the ceremony it started in, never
      // whichever one is current when its response happens to land.
      const gen = ceremony.begin();
      void (async () => {
        const out = await door.verify(tried, typed);
        if (out.ok) {
          verified();
          // THE ONE DOOR. A factor that lands after Cancel runs no parked verb and says so.
          if (!ceremony.claim(gen)) {
            setBusy(false);
            onDiscarded();
            return;
          }
          onVerified();
          return;
        }
        // A failed ceremony is over: end it, so a second response cannot act either.
        ceremony.end();
        setBusy(false);
        if (out.refusal.word === "owner_absent" && onOwnerAbsent) { onOwnerAbsent(); return; }
        setError(refusalText(out.refusal));
      })();
    },
    [ceremony, door, onDiscarded, onOwnerAbsent, onVerified, refusalText],
  );

  const withPasskey = () => finish("passkey", "", () => {});

  const withCode = (e: React.FormEvent) => {
    e.preventDefault();
    if (busy || code.trim().length === 0) return;
    finish("code", code, () => setCode(""));
  };

  const withRecovery = (e: React.FormEvent) => {
    e.preventDefault();
    if (busy || recovery.trim().length === 0) return;
    finish("recovery", recovery, () => setRecovery(""));
  };

  const choose = (next: "webauthn" | "totp" | "recovery") => {
    setMethod(next);
    setError(null);
  };
  /** The way to a recovery code, offered beside either factor when the account has a sheet. */
  const recoveryToggle = enrolled?.recovery ? (
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
          {enrolled?.code ? (
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
          {enrolled?.code ? (
            <button type="button" className="join-alt" onClick={() => choose("totp")}>
              {t("stepUpTotpToggle")}
            </button>
          ) : null}
          {enrolled?.passkey ? (
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
          {enrolled?.passkey ? (
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
