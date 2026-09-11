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

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Button, Icon } from "@ohmail/ui";
import { apiConfigured, auth, codeOf, messageOf } from "../../api-client";

export function VerifyEmailScreen({ initialToken }: { initialToken: string }) {
  const t = useTranslations("verify");
  const router = useRouter();

  const [token, setToken] = useState(initialToken);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

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

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    void (async () => {
      try {
        const out = await auth.verifyEmail({ token: token.trim(), password });
        setPassword("");
        if (out.status === "enrollment") {
          // Zero enrolled factors, so the server handed back the same enrollment session the
          // re-entry login gives — onboarding continues at the passkey step. `/join` derives
          // that from `GET /auth/session`, so there is nothing to pass along.
          router.push("/join");
          return;
        }
        // The address is proven and a second factor already exists. No session was minted, on
        // purpose: a mailed link plus a password must not skip a factor somebody added.
        setDone(true);
      } catch (err) {
        // `invalid_token` is the one-sentence refusal for every dead link; `unauthorized` is a
        // wrong password, and the token is still live so retrying in place is the right remedy.
        setError(messageOf(err));
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
          <Button variant="primary" type="submit" disabled={busy || token.trim().length === 0}>
            {busy ? t("working") : t("confirm")}
          </Button>
        </div>
      </form>

      <p className="join-hint">{t("lostLink")}</p>
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
