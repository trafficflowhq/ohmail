"use client";

/**
 * FIRST-RUN SETUP — the guided ceremony a fresh self-host server opens with.
 *
 * `docker compose up` leaves a server with zero accounts, one ownerless setup token printed to
 * its own log, and `/hello` answering `needsSetup: true`. This page is what that state is FOR:
 * the operator pastes the token, chooses their sign-in, and the page drives
 *
 *   `POST /pair/redeem` (invite grant → an invite code) → `POST /auth/register` (the existing
 *   invite path; the ownerless token's record makes the account start email-verified) →
 *   an enrollment session → `/join`, which resumes at the second-factor step and carries on
 *   through recovery codes and the first mailbox.
 *
 * It replaces the interim ceremony the guides described — a hand-typed `curl /pair/redeem`
 * followed by pasting the code into `/join` — with the thing the boot log always promised:
 * "open the app in a browser and enter this one-time setup token".
 *
 * ── THE GATE: THIS PAGE EXISTS ONLY WHILE THE SERVER SAYS IT DOES ─────────────────────────────
 *
 * The form renders only after a FRESH `GET /hello` answers `needsSetup: true` — a database fact
 * (users == 0), not a build flag, so the page shows on exactly one server state and never on a
 * server that has accounts. Every other answer gets an honest screen of its own:
 *
 *  · `needsSetup: false` + a live session (mid-enrollment reload is the common case — the
 *    register above flips needsSetup the moment it commits) → straight to `/join`, which
 *    derives the right step from the server;
 *  · `needsSetup: false`, no session → "already set up", with sign-in as the exit;
 *  · no answer at all → "can't reach the server", with retry — never a form whose submit
 *    would fail one step later.
 *
 * ── WHY REDEEM AND REGISTER ARE ONE SUBMIT, AND WHAT THE RETRY KEEPS ──────────────────────────
 *
 * The setup token is SINGLE-USE, so a ceremony that consumed it on one screen and registered on
 * the next would strand anyone who fell between the two. One submit performs both; and if the
 * register half fails after a successful redeem (the redeem-minted invite lives 15 minutes),
 * the minted code is KEPT, keyed to the address it is bound to, so a retry re-uses it instead
 * of burning a token that can no longer be redeemed. Changing the address after a successful
 * redeem is the one unrecoverable edit — the invite is email-bound and the token is spent — and
 * the refusal for it says the true remedy: restart the server for a fresh token.
 *
 * The refusal for a wrong token is THIS form's own sentence, not the service's.
 * `pairing_invalid`'s wire message ends "ask whoever minted it for a fresh one", which is right
 * for every pairing token except this one — the setup token's minter is the server itself, and
 * the operator's remedy is the log or a restart. Same mapping discipline as `LoginScreen`.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Button, Icon } from "@ohmail/ui";
import { apiConfigured, auth, codeOf, messageOf, pair } from "../../api-client";
import { serverHello } from "../../hello";

/**
 * What this page knows about the server, in order of discovery. `checking` is the mount state;
 * everything else is a `/hello` answer wearing a screen.
 */
type Phase = "checking" | "setup" | "settled" | "unreachable";

export function SetupScreen() {
  const t = useTranslations("setup");
  const router = useRouter();

  const [phase, setPhase] = useState<Phase>("checking");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [token, setToken] = useState("");
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  /** A redeem that succeeded while register did not — kept so a retry never re-burns the token. */
  const [minted, setMinted] = useState<{ code: string; email: string } | null>(null);

  /**
   * The gate, re-runnable (the unreachable screen's "try again" is this function). The session
   * probe runs only on the settled branch: a fresh server has nobody to have a session, and the
   * probe's one job is to route a mid-enrollment reload back to `/join` instead of telling the
   * person who JUST created the account that somebody else already did.
   */
  const checkServer = useCallback(async () => {
    setPhase("checking");
    if (!apiConfigured()) {
      setPhase("unreachable");
      return;
    }
    const hello = await serverHello();
    if (hello === null) {
      setPhase("unreachable");
      return;
    }
    if (hello.needsSetup) {
      setPhase("setup");
      return;
    }
    try {
      await auth.session();
      // Any live session — enrollment or full. `/join`'s bootstrap derives the true step.
      router.replace("/join");
    } catch {
      setPhase("settled");
    }
  }, [router]);

  useEffect(() => { void checkServer(); }, [checkServer]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    void (async () => {
      setBusy(true);
      setError(null);
      try {
        const address = email.trim();
        let code = minted !== null && minted.email === address ? minted.code : null;
        if (code === null && minted !== null) {
          // The token was already spent for a DIFFERENT address. Re-redeeming cannot work and
          // the register below would refuse the mismatched code — say the real remedy instead.
          setError(t("tokenSpent", { email: minted.email }));
          return;
        }
        if (code === null) {
          try {
            const out = await pair.redeemInvite({ token: token.trim(), email: address });
            code = out.invite.code;
            setMinted({ code, email: address });
          } catch (err) {
            // The one wire refusal that needs this form's own sentence — see the header.
            setError(codeOf(err) === "pairing_invalid" ? t("badToken") : messageOf(err));
            return;
          }
        }
        await auth.register({
          email: address, password, displayName: displayName.trim(), inviteCode: code,
        });
        setPassword("");
        // The invite path answers an enrollment session; `/join` resumes at the factor step and
        // carries the ceremony through recovery codes and the first mailbox. `replace`, not
        // `push`: the setup form must not sit in the back stack once its token is spent.
        // (The public-path `{status:"ok"}` arm is unreachable with an invite code; routing to
        // `/join` would still land on the right step if it ever answered.)
        router.replace("/join");
      } catch (err) {
        // Register refusals carry the SERVICE's own human sentences (invite taxonomy, password
        // policy) — shown verbatim, the api-client's standing rule.
        setError(messageOf(err));
      } finally {
        setBusy(false);
      }
    })();
  };

  return (
    <div className="login">
      <div className="login-card join-card">
        {/* oh | mail, split so `.wordmark em` carries accent-ink — the rendered textContent is
            what the brand suite asserts. */}
        <span className="wordmark"><b><em>oh</em>mail</b></span>

        {phase === "checking" && (
          <>
            <h1>{t("checkingTitle")}</h1>
            <p className="sub">{t("checking")}</p>
          </>
        )}

        {phase === "unreachable" && (
          <>
            <h1>{t("unreachableTitle")}</h1>
            <p className="sub" role="alert">{t("unreachableBody")}</p>
            <div className="join-actions">
              <Button variant="primary" onClick={() => void checkServer()}>{t("retry")}</Button>
            </div>
          </>
        )}

        {phase === "settled" && (
          <>
            {/* The one state a server with accounts can show. The form above never renders here:
                a setup ceremony offered on an established server would be advertising a token
                that must not exist (`ensureSetupTokenInvariant` revokes it server-side too). */}
            <h1>{t("settledTitle")}</h1>
            <p className="sub">{t("settledBody")}</p>
            <div className="join-actions">
              <Link className="btn primary" href="/login">{t("signIn")}</Link>
            </div>
          </>
        )}

        {phase === "setup" && (
          <>
            <h1>{t("title")}</h1>
            <p className="sub">{t("lead")}</p>

            {error && <p className="join-error" role="alert">{error}</p>}

            <form onSubmit={submit}>
              <label className="join-label" htmlFor="setup-token">{t("tokenLabel")}</label>
              <input
                id="setup-token" className="join-input join-code"
                value={token} onChange={(e) => setToken(e.target.value)}
                autoComplete="off" spellCheck={false} required
              />
              {/* WHERE THE TOKEN COMES FROM, in one place and plainly: it is the value the
                  server printed to its own log at first start — reading that log is what proves
                  the person at this form controls the box. */}
              <p className="join-hint">
                {t("tokenHint")} <code>docker compose logs api</code>. {t("tokenHintRestart")}
              </p>

              <label className="join-label" htmlFor="setup-email">{t("emailLabel")}</label>
              <input
                id="setup-email" className="join-input" type="email" autoComplete="email"
                value={email} onChange={(e) => setEmail(e.target.value)} required
              />
              <p className="join-hint">{t("emailHint")}</p>

              <label className="join-label" htmlFor="setup-name">{t("nameLabel")}</label>
              <input
                id="setup-name" className="join-input" autoComplete="name"
                value={displayName} onChange={(e) => setDisplayName(e.target.value)} required
              />

              <label className="join-label" htmlFor="setup-pw">{t("passwordLabel")}</label>
              <input
                id="setup-pw" className="join-input" type="password" autoComplete="new-password"
                minLength={12} value={password} onChange={(e) => setPassword(e.target.value)} required
              />
              <p className="join-hint">{t("passwordHint")}</p>

              <div className="join-actions">
                <Button variant="primary" type="submit" disabled={busy}>
                  {busy ? t("working") : t("createAccount")}
                </Button>
              </div>
              {/* What comes AFTER the button, said before it is pressed: the ceremony continues
                  through a second factor and recovery codes before the first mailbox connects. */}
              <p className="join-note">{t("nextNote")}</p>
            </form>
          </>
        )}
      </div>
      <p className="login-foot">
        <Icon name="shield" /> {t("footer")}
      </p>
    </div>
  );
}
