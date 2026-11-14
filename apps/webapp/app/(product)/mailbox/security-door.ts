"use client";

import { useMemo } from "react";
import type { Answer, SecurityDoor } from "@ohmail/app/account";
import { ApiError, auth } from "../../api-client";
import { useRefusalSentence } from "../refusal-sentence";

type Refused = Exclude<Answer<never>, { ok: true }>;

/**
 * A REFUSED VERB OF THIS PANE, AS ITS WORD, read in this order: 403 `step_up_required` asks the factor (the
 * group's machine says a second one, right after a verified factor, as the way back in); any other 401 or 403 is the
 * way back in; everything else is said by the one renderer, in the reader's language.
 */
export function securityRefusal(err: unknown, say: (err: unknown) => string): Refused {
  if (err instanceof ApiError && err.status === 403 && err.code === "step_up_required") {
    return { ok: false, word: "factor" };
  }
  if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
    return { ok: false, word: "sign_in" };
  }
  return { ok: false, word: "said", said: say(err) };
}

/**
 * THE WEB'S SECURITY DOOR. What is enrolled is the session's own answer (`GET /auth/session`): a read that failed
 * is said and nothing is claimed in its place. New recovery codes (`POST /auth/2fa/recovery-codes {}`), an
 * authenticator's enrolment (`POST /auth/2fa/totp/enroll {}`, then `POST /auth/2fa/totp/activate {code}`) and its
 * removal (`DELETE /auth/2fa/totp`) are each one request, tried as they are: the server decides whether the factor
 * is asked. The enrolment's address for a scanner is dropped here; only its key leaves this file.
 */
export function securityDoor(say: (err: unknown) => string, expectedOwner?: string | null): SecurityDoor {
  const tried = async <T>(call: () => Promise<T>): Promise<Answer<T>> => {
    try {
      return { ok: true, value: await call() };
    } catch (err) {
      return securityRefusal(err, say);
    }
  };
  return {
    async read() {
      try {
        const { user } = await auth.session({ expectedOwner });
        const enrolled = user?.twofaEnrolled;
        return {
          ok: true,
          value: {
            passkey: Boolean(enrolled?.webauthn),
            authenticator: Boolean(enrolled?.totp),
            recoveryCodes: Boolean(enrolled?.recoveryCodes),
          },
        };
      } catch (err) {
        return { ok: false, word: "said", said: say(err) };
      }
    },
    newCodes: () => tried(async () => (await auth.recoveryCodes(expectedOwner)).codes),
    startAuthenticator: () => tried(async () => ({ key: (await auth.totpEnroll(expectedOwner)).secret })),
    activate: (code) =>
      tried(async () => {
        await auth.totpActivate({ code }, expectedOwner);
        return null;
      }),
    removeAuthenticator: () =>
      tried(async () => {
        await auth.totpRemove(expectedOwner);
        return null;
      }),
  };
}

/** The web's Security door, its refusals said in the reader's language. */
export function useSecurityDoor(expectedOwner?: string | null): SecurityDoor {
  const say = useRefusalSentence();
  return useMemo(() => securityDoor(say, expectedOwner), [say, expectedOwner]);
}
