/**
 * THE STEP-UP'S DOOR AS THE WEB ANSWERS IT — cut from `StepUpPrompt`: the factor set it reads at mount, the three
 * verify bodies, and the classification its refusals were said by. No sign-out, no new session, no cookie changes:
 * the server re-stamps the session this browser holds, and a census holds its response to nothing else. The factor
 * set comes from `GET /auth/session` (`twofaEnrolled`), the read `SecuritySection` trusts, so the dialog never offers
 * a ceremony the account cannot finish. The act a verified factor allows is the caller's, behind its generation.
 */

import type { StepUpDoor, StepUpFactor, StepUpRefusal } from "@ohmail/app/doors/step-up";
import { auth, assertPasskey, webauthnAvailable } from "../../api-client";
import { isOwnerAbsent } from "../approve/settle-owner";
import { serverAnswered } from "../refusal-sentence";

/**
 * The refusal, as a word. A server answer is never shown as written: the step-up doors answer in lowercase English
 * diagnostics ("two-factor verification failed"), so each maps to a word — a 401 by the factor `tried`, the lockout
 * with its `retryAfter` ("too many attempts" without "for how long" reads as for ever), the throttle, and one word
 * for anything else. Client-raised refusals go through the one renderer, `say`. The marker's absence is asked first,
 * by each catch below: a host with a settle step answers it, and nothing is said.
 */
export function stepUpRefusalOf(
  err: unknown,
  tried: StepUpFactor | undefined,
  say: (err: unknown) => string,
): StepUpRefusal {
  if (!serverAnswered(err)) return { word: "said", said: say(err) };
  if (err.code === "account_locked") {
    const retryAfter = (err.details as { retryAfter?: unknown } | undefined)?.retryAfter;
    const seconds = typeof retryAfter === "number" && retryAfter > 0 ? retryAfter : 15 * 60;
    return { word: "locked", minutes: Math.max(1, Math.ceil(seconds / 60)) };
  }
  if (err.code === "sign_in_slowed") return { word: "slowed" };
  if (err.status === 401 && tried) {
    return { word: tried === "code" ? "bad_code" : tried === "passkey" ? "bad_passkey" : "bad_recovery" };
  }
  return { word: "refused" };
}

/** The web's step-up door. `say` is the one renderer for a refusal this client raised, in the reader's language. */
export function webStepUp(say: (err: unknown) => string): StepUpDoor {
  return {
    async factors() {
      try {
        const { user } = await auth.session();
        const e = {
          webauthn: user.twofaEnrolled.webauthn, totp: user.twofaEnrolled.totp,
          recoveryCodes: user.twofaEnrolled.recoveryCodes === true,
        };
        // The sign-in screen's preference verbatim: a passkey when one exists AND this browser can run the ceremony.
        return { ok: true, factors: { passkey: e.webauthn && webauthnAvailable(), code: e.totp, recovery: e.recoveryCodes } };
      } catch (err) {
        if (isOwnerAbsent(err)) return { ok: false, refusal: { word: "owner_absent", said: say(err) } };
        return { ok: false, refusal: stepUpRefusalOf(err, undefined, say) };
      }
    },
    async verify(factor, code) {
      try {
        await VERIFY[factor](code);
        return { ok: true };
      } catch (err) {
        if (isOwnerAbsent(err)) return { ok: false, refusal: { word: "owner_absent", said: say(err) } };
        return { ok: false, refusal: stepUpRefusalOf(err, factor, say) };
      }
    },
  };
}

/**
 * The three verify bodies, the prompt's own, last in this file: nothing follows a verify here, because the act it
 * allows is the caller's. The code is sent trimmed, as typed.
 */
const VERIFY: Readonly<Record<StepUpFactor, (code: string) => Promise<unknown>>> = {
  code: (code) => auth.stepUpTotp({ code: code.trim() }),
  recovery: (code) => auth.stepUpRecoveryCode({ code: code.trim() }),
  passkey: async () => {
    const { options } = await auth.stepUpWebauthnOptions();
    const credential = await assertPasskey(options);
    await auth.stepUpWebauthnVerify({ credential });
  },
};
