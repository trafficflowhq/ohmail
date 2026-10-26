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
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Button, Icon } from "@ohmail/ui";
import { apiConfigured, auth, codeOf, messageOf } from "../../api-client";
import { readOwnerMarker } from "../../shell/owner-cookie";
import { offerHandoff } from "../join/handoff";
import { verifyRefusal } from "../join/signup-refusals";
import { PendingSignOutSaid, usePendingSignOut } from "../login/pending-sign-out";

export function VerifyEmailScreen({ initialToken }: { initialToken: string }) {
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
  useEffect(() => {
    if (!apiConfigured() || readOwnerMarker().kind !== "signed-out") return;
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

  if (!apiConfigured()) {
    return (
      <Shell title={t("unavailableTitle")}>
        <p className="sub">{t("unavailableBody")}</p>
      </Shell>
    );
  }

  if (handedOff) {
    // No control here: the setup goes on in the other tab, and a second one would start a second wizard.
    return (
      <Shell title={t("doneTitle")}>
        <p className="sub" role="status">{t("handedOff")}</p>
      </Shell>
    );
  }

  if (done) {
    return (
      <Shell title={t("doneTitle")}>
        <p className="sub">{t("doneBody")}</p>
        <div className="join-actions">
          <Link className="btn primary" href="/login">{t("signIn")}</Link>
        </div>
      </Shell>
    );
  }

  return (
    <Shell title={t("title")}>
      <p className="sub">{t("lead")}</p>
      {error && <p className="join-error" role="alert">{error}</p>}
      {/* A sign-out this browser asked for that ended unconfirmed here, and Sign out to ask again. */}
      <PendingSignOutSaid pending={pending} busy={busy} />

      <form onSubmit={submit}>
        {/* The token field is VISIBLE when the link did not carry one — somebody who typed the
            URL by hand, or whose mail client mangled the query string, can paste it. It stays
            hidden on the ordinary path so the form is one input. */}
        {!initialToken && (
          <>
            <label className="join-label" htmlFor="verify-token">{t("tokenLabel")}</label>
            <input
              id="verify-token" className="join-input join-code" autoComplete="off"
              spellCheck={false} value={token} onChange={(e) => setToken(e.target.value)} required
            />
          </>
        )}

        <label className="join-label" htmlFor="verify-pw">{t("passwordLabel")}</label>
        <input
          id="verify-pw" className="join-input" type="password" autoComplete="current-password"
          value={password} onChange={(e) => setPassword(e.target.value)} required
        />
        <p className="join-hint">{t("passwordHint")}</p>

        <div className="join-actions">
          <Button variant="primary" type="submit" disabled={busy || pending.signingOut || token.trim().length === 0}>
            {busy ? t("working") : t("confirm")}
          </Button>
        </div>
      </form>

      <p className="join-hint">{t("lostLink")}</p>
      {/* The sentence above names sign-in as the way to a fresh link; this is the control for it, and
          the sign-in carries on into the setup. */}
      <div className="join-actions">
        <Link className="join-alt" href="/login?next=join">{t("signIn")}</Link>
      </div>
    </Shell>
  );
}

function Shell({ title, children }: { title: string; children: React.ReactNode }) {
  const t = useTranslations("verify");
  return (
    <div className="login">
      <div className="login-card join-card">
        {/* oh | mail, split so `.wordmark em` can carry accent-ink; the rendered
            text is pinned by a suite. */}
        <span className="wordmark"><b><em>oh</em>mail</b></span>
        <h1>{title}</h1>
        {children}
      </div>
      <p className="login-foot">
        <Icon name="shield" /> {t("footer")}
      </p>
    </div>
  );
}
