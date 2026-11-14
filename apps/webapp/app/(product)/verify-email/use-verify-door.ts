"use client";

/**
 * Confirm an email address — the page the verification mail links to. There is a password field because the obvious
 * design (auto-POST the URL token on mount) is an account-takeover primitive: `POST /auth/register` answers
 * identically for a taken and a free address (the constant 202), so anyone can create an account on somebody else's
 * address; the real owner then receives a legitimate-looking verification mail, and if clicking were enough, their
 * click would verify the ATTACKER's account (`AuthService.verifyEmail`'s doc writes the chain in full).
 */

/**
 * So the token proves the address and the password proves the account — the person who signed up chose it minutes
 * ago, and anyone who lost it signs in instead. A side effect: a link-prefetching mail scanner cannot verify
 * anything, because a scanner issues a GET and never submits a password.
 */

/**
 * The token leaves the address bar immediately — the same `replaceState` scrub `JoinScreen` does
 * for `?code=`; the sibling mitigations (`Referrer-Policy: no-referrer`, `Cache-Control: no-store`)
 * are paid by `middleware.ts`'s `credentialPage`. What this file must NOT do: interpret the
 * refusal. Every failure mode of a link — unknown, expired, already used, the loser of a race — is
 * deliberately ONE sentence from the server (`invalid_token`), because distinguishing them would
 * tell whoever holds a spent link that it was once real, i.e. that the address it was mailed to has
 * an account. This screen shows what it is given.
 */

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { apiConfigured, auth, codeOf, messageOf } from "../../api-client";
import { readOwnerMarker } from "@ohmail/app-logic/storage/owner-cookie";
import { offerHandoff } from "../join/handoff";
import { verifyRefusal } from "../join/signup-refusals";
import { usePendingSignOut, type PendingSignOut } from "../login/pending-sign-out";
import { checkAnswered, revokedWipeSettled } from "../../revoked-door";
import { resolveOwnerOutcome } from "../session-outcome";

/** What the confirmation's ceremony shows, and its acts. The link's token is typed back only where it came with none. */
export interface VerifyCeremony {
  /** A server stands behind this build. */
  configured: boolean;
  token: string;
  setToken(v: string): void;
  password: string;
  setPassword(v: string): void;
  busy: boolean;
  error: string | null;
  done: boolean;
  handedOff: boolean;
  pending: PendingSignOut;
  submit(e: { preventDefault(): void }): void;
}

export function useVerifyDoor({ initialToken }: { initialToken: string }): VerifyCeremony {
  const t = useTranslations("verify");
  /** The sign-in throttle's two sentences: this form claims the same keys `login` does. */
  const tl = useTranslations("login");
  const router = useRouter();

  const [token, setToken] = useState(initialToken);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  /** A tab waiting on "Check your email" took the setup over: this page opens no second wizard. */
  const [handedOff, setHandedOff] = useState(false);
  /** Aborted when the page goes away: an offer still open then ends, and nothing is opened. */
  const leaving = useRef<AbortController | null>(null);
  useEffect(() => {
    const gone = new AbortController();
    leaving.current = gone;
    return () => gone.abort();
  }, []);

  /**
   * SCRUB THE TOKEN OUT OF THE URL once it is in component state.
   *
   * Identical in shape and reason to `JoinScreen`'s `?code=` scrub: the credential arrives in
   * the address bar and otherwise stays there — visible for the whole session, in browser
   * history permanently, and in the `Referer` of any same-origin navigation off this page. The
   * platform access-log line for the document request is already written by the time this runs,
   * which is the one part `replaceState` cannot fix and which §7b duty #3 covers instead.
   */
  useEffect(() => {
    if (typeof window === "undefined" || !initialToken) return;
    const url = new URL(window.location.href);
    if (!url.searchParams.has("token")) return;
    url.searchParams.delete("token");
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  }, [initialToken]);

  /**
   * A SIGN-OUT THIS BROWSER ASKED FOR AND THE SERVER NEVER CONFIRMED (`login/pending-sign-out.tsx`). A
   * confirmation can mint a session, and one minted beside that sign-out leaves its family live in this
   * jar for good. So the sign-out is finished at the door behind the form from the moment the page opens,
   * and asked once more before the confirmation; `stopFinish` is how the press stops the ladder's next ask.
   */
  const pending = usePendingSignOut();
  const stopFinish = useRef<(() => void) | null>(null);
  /** The arrival's session check, and how the press stops it once heard. */
  const checkOut = useRef<Promise<unknown> | null>(null);
  const stopCheck = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (!apiConfigured()) return;
    if (readOwnerMarker().kind !== "signed-out") {
      // Every other jar is asked on arrival, as /join and /login do: a revoke it carries starts its wipe now.
      const abort = new AbortController();
      stopCheck.current = () => abort.abort();
      checkOut.current = resolveOwnerOutcome({ signal: abort.signal }).catch(() => undefined);
      return () => abort.abort();
    }
    let cancelled = false;
    stopFinish.current = () => { cancelled = true; };
    void pending.finish(() => cancelled);
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `pending.finish` is the page's for its life
  }, []);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    void (async () => {
      try {
        stopFinish.current?.();
        // Asked first, within the bound, unless a sign-out is pending (its door is asked below): an enrollment
        // answer expires the jar's renewal, after which a revoke of its session could never be heard here. A jar
        // naming nobody too: Safari keeps the script-written name seven days, the session cookie longer.
        if (readOwnerMarker().kind !== "signed-out") await checkAnswered(checkOut.current, (signal) => resolveOwnerOutcome({ signal }));
        stopCheck.current?.();
        // A revoke's wipe this browser still owes, or the one just heard, is done before a confirmation mints a session.
        await revokedWipeSettled();
        if (!await pending.settle()) return;
        const out = await auth.verifyEmail({ token: token.trim(), password });
        setPassword("");
        if (out.status === "enrollment") {
          // Zero enrolled factors, so the server handed back the same enrollment session the
          // re-entry login gives — onboarding continues at the passkey step. `/join` derives
          // that from `GET /auth/session`, so there is nothing to pass along. A tab still on
          // "Check your email" is offered it first; this page opens /join only if none takes it.
          const signal = leaving.current?.signal;
          const taken = await offerHandoff(signal);
          if (signal?.aborted) return;
          if (taken) { setHandedOff(true); return; }
          router.push("/join");
          return;
        }
        // The address is proven and a second factor already exists. No session was minted, on
        // purpose: a mailed link plus a password must not skip a factor somebody added.
        setDone(true);
      } catch (err) {
        // `invalid_token` is the one-sentence refusal for every dead link; `credential_refused` is a
        // wrong password, and the token is still live so retrying in place is the right remedy.
        // Each in this screen's words; a refusal not named there keeps the server's sentence.
        const said = verifyRefusal(err);
        setError(said === null ? messageOf(err) : said.ns === "login" ? tl(said.key) : t(said.key));
        if (codeOf(err) === "invalid_token") setToken("");
      } finally {
        setBusy(false);
      }
    })();
  };

  return {
    configured: apiConfigured(),
    token, setToken, password, setPassword, busy, error, done, handedOff, pending, submit,
  };
}
