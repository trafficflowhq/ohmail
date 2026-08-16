"use client";

/**
 * SIGN-IN, wired.
 *
 * Until this landed it was a visual: a passkey button that raised a toast saying accounts
 * were not open yet. It now drives the real two-step flow.
 *
 * ── THE TWO OUTCOMES OF `POST /auth/login` ──────────────────────────────────────────────
 *
 * Login is a UNION (`LoginResult`), and both arms matter here:
 *
 *  · `twofa_required` — the ordinary path. A single-use login token plus the list of
 *    methods the user actually enrolled, and the second factor completes the session.
 *  · `enrollment` — the RE-ENTRY path. A user with ZERO enrolled factors gets the
 *    same enrollment session `register` hands out, because for them the password IS the
 *    only factor in existence and the alternative is a permanently unusable account. This
 *    screen routes that straight to `/join`, which resumes at the passkey step.
 *
 * ── THE PASSWORD FIELD IS NOT A REGRESSION ──────────────────────────────────────────────
 *
 * The earlier visual implied passkey-only sign-in. The server has never worked that way:
 * the password is the FIRST factor and the passkey is the second (`AuthService.login`
 * verifies a password hash before it mints a login token). A UI that hid the first factor
 * could not have signed anyone in. What the product does promise — "no password to leak" —
 * is about the second factor being a passkey and about `credentials` storing a scrypt hash,
 * and both remain true.
 *
 * ── WHAT THIS FILE MUST NOT DO ──────────────────────────────────────────────────────────
 *
 * Store anything. The session is three `HttpOnly` cookies set by the server; the login
 * token lives in a local variable for the duration of one ceremony and is single-use. There
 * is no "remember me", because that would mean a credential this code could read.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Button, Icon } from "@ohmail/ui";
import {
  ApiError, apiConfigured, assertPasskey, auth, messageOf, webauthnAvailable,
  type TwofaChallenge,
} from "../../api-client";

type Stage = "password" | "twofa";

/**
 * ── THE REFUSALS A PERSON MEETS AT THIS FORM GET THIS FORM'S OWN SENTENCES ────────────────────
 *
 * `messageOf` renders the server's message verbatim, which is right for the refusal taxonomy the
 * services write for humans ("that invite is already used", the lockout sentence with its
 * minutes) and wrong for the auth ceremony's bare 401s: `AuthService` answers those with
 * lowercase wire strings — "invalid email or password", "two-factor verification failed" —
 * written as diagnostics, not as copy. They rendered raw on this screen. So a 401 here is mapped
 * to a sentence in the catalogue, keyed by WHICH factor was being tried (the caller knows;
 * the status alone does not say), and everything that is not a bare 401 keeps the server's own
 * sentence exactly as before — this maps presentation, it re-derives no taxonomy.
 */
type FactorTried = "password" | "code" | "passkey";

function loginError(err: unknown, tried: FactorTried, t: (key: string) => string): string {
  if (err instanceof ApiError && err.status === 401) {
    return t(tried === "password" ? "badCredentials" : tried === "code" ? "badCode" : "badPasskey");
  }
  return messageOf(err);
}

export function LoginScreen() {
  const t = useTranslations("login");
  const router = useRouter();

  const [stage, setStage] = useState<Stage>("password");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [challenge, setChallenge] = useState<TwofaChallenge | null>(null);
  const [method, setMethod] = useState<"webauthn" | "totp" | "recovery_code">("webauthn");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const configured = apiConfigured();

  /**
   * ALREADY SIGNED IN? THEN THIS PAGE IS NOT WHAT YOU WANTED.
   *
   * `/login` is a plain credential page — middleware does not gate it, so a visitor with a
   * perfectly live session was shown a sign-in form and had to sign in again to reach a
   * mailbox they were already signed in to. Reported from live use, exactly this way.
   *
   * `api()` refreshes and retries on a 401 (`app/session-refresh.ts`), so this also covers the
   * lapsed-but-resumable case: a browser whose access cookie died an hour ago silently gets a
   * new one here and goes straight through. Only a session that cannot be recovered at all
   * falls through to the form.
   *
   * `replace`, not `push`: signing in should not leave the login page in the back stack. The
   * fragment rides along so a link to `/login#/settings` lands on Settings.
   */
  useEffect(() => {
    if (!configured) return;
    let cancelled = false;
    void (async () => {
      try {
        const { scope } = await auth.session();
        if (!cancelled && scope === "full") router.replace(`/${window.location.hash}`);
      } catch {
        /* no session, or unreachable — the form below is the right answer */
      }
    })();
    return () => { cancelled = true; };
  }, [configured, router]);

  const run = async (fn: () => Promise<void>, tried: FactorTried): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(loginError(err, tried, t));
    } finally {
      setBusy(false);
    }
  };

  const submitPassword = (e: React.FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const result = await auth.login({ email: email.trim(), password });
      setPassword("");
      if (result.status === "enrollment") {
        // The re-entry path: registered, never finished 2FA. `/join` reads the live
        // enrollment session from `GET /auth/session` and resumes at the factor step.
        router.push("/join");
        return;
      }
      setChallenge(result);
      // Prefer a passkey when the user has one AND this browser can do the ceremony;
      // otherwise start on whatever they actually enrolled.
      const preferred = result.methods.includes("webauthn") && webauthnAvailable()
        ? "webauthn"
        : result.methods.includes("totp") ? "totp" : result.methods[0]!;
      setMethod(preferred);
      setStage("twofa");
    }, "password");
  };

  const finishWithPasskey = () => void run(async () => {
    if (!challenge) return;
    const { options } = await auth.webauthnAssertOptions({ loginToken: challenge.loginToken });
    const credential = await assertPasskey(options);
    await auth.webauthnAssertVerify({ loginToken: challenge.loginToken, credential });
    router.push("/");
  }, "passkey");

  const finishWithCode = (e: React.FormEvent) => {
    e.preventDefault();
    void run(async () => {
      if (!challenge) return;
      if (method === "recovery_code") {
        await auth.recoveryVerify({ loginToken: challenge.loginToken, code: code.trim() });
      } else {
        await auth.totpVerify({ loginToken: challenge.loginToken, code: code.trim() });
      }
      router.push("/");
    }, "code");
  };

  /**
   * A login token is SINGLE-USE and short-lived. Once a ceremony has been attempted the
   * safe move is a fresh password step, not a retry against a token that may already be
   * spent — a "try again" that silently 401s is worse than starting over.
   */
  const restart = () => {
    setChallenge(null);
    setCode("");
    setError(null);
    setStage("password");
  };

  return (
    <div className="login">
      <div className="login-card">
        {/* Two elements, not one string: `.login-card .wordmark em` paints the `em`
            half in accent-ink. Split at the word boundary — oh | mail — lower-case,
            accent on "oh". The rendered textContent is what the suite asserts,
            because a grep for the brand as one string cannot see a mark that is
            split across elements. */}
        <span className="wordmark"><b><em>oh</em>mail</b></span>
        <h1>{t("title")}</h1>
        {/* THE SUBTITLE FOLLOWS THE FACTS ON SCREEN — claims-are-contracts. The old fixed
            "Your password, then your passkey… nothing to type" stood over the TOTP step, which
            was at that moment asking the user to type a six-digit code — directly false for the
            flow shown. The password step cannot yet know which factor the account enrolled, so
            it promises only "a second factor"; the passkey sentence renders exactly when a
            passkey ceremony is what is being offered. */}
        <p className="sub">
          {stage === "twofa"
            ? method === "webauthn"
              ? t("sub")
              : t("subCode")
            : t("subFirst")}
        </p>

        {error && <p className="join-error" role="alert">{error}</p>}

        {!configured ? (
          <div className="login-beta">
            <b>{t("betaNote")}</b>
            {t("betaBody")}
            <br />
            <Link className="btn" href="/?demo=1">
              <Icon name="spark" /> {t("betaCta")}
            </Link>
          </div>
        ) : stage === "password" ? (
          <form onSubmit={submitPassword}>
            <label className="join-label" htmlFor="login-email">{t("emailLabel")}</label>
            <input
              id="login-email" className="join-input" type="email" autoComplete="username"
              value={email} onChange={(e) => setEmail(e.target.value)} required
            />
            <label className="join-label" htmlFor="login-pw">{t("passwordLabel")}</label>
            <input
              id="login-pw" className="join-input" type="password" autoComplete="current-password"
              value={password} onChange={(e) => setPassword(e.target.value)} required
            />
            <div className="join-actions">
              <Button variant="primary" type="submit" disabled={busy}>
                {busy ? t("working") : t("continue")}
              </Button>
            </div>
            {/* NO passkey note here. "Face ID… nothing to type and nothing to leak" was rendered
                before the account's methods are known, and for a TOTP account it was a promise
                the very next step broke. It renders in the webauthn branch below, where the
                ceremony it describes is the one on screen. */}
            <p className="login-invite-note">
              {t("inviteOnly")} <Link href="/join">{t("haveInvite")}</Link>
            </p>
          </form>
        ) : (
          <>
            {method === "webauthn" ? (
              <>
                <Button
                  variant="primary" icon="shield" className="login-passkey"
                  onClick={finishWithPasskey} disabled={busy}
                >
                  {busy ? t("working") : t("passkey")}
                </Button>
                <p className="login-passkey-note">{t("passkeyNote")}</p>
              </>
            ) : (
              <form onSubmit={finishWithCode} className="login-totp">
                <label className="join-label" htmlFor="login-code">
                  {method === "recovery_code" ? t("recoveryLabel") : t("totpLabel")}
                </label>
                <input
                  id="login-code" className="join-input join-code"
                  inputMode={method === "totp" ? "numeric" : "text"}
                  autoComplete="one-time-code"
                  /* The code step is TIME-BOXED — a TOTP rolls every 30 s — and this input is
                     the only thing on it, yet focus stayed on nothing after the password
                     submit: one extra click on the step least able to afford it. The form
                     mounts fresh both on entering the stage and on switching method, so
                     autoFocus covers both arrivals. */
                  autoFocus
                  value={code} onChange={(e) => setCode(e.target.value)}
                />
                <div className="join-actions">
                  <Button variant="primary" type="submit" disabled={busy || code.trim().length === 0}>
                    {busy ? t("working") : t("totpVerify")}
                  </Button>
                </div>
              </form>
            )}

            {/* Only the methods this user actually enrolled — offering TOTP to somebody
                who never set one up is a dead end that reads like a broken sign-in. */}
            <div className="login-methods">
              {challenge?.methods.includes("webauthn") && method !== "webauthn" && webauthnAvailable() && (
                <button type="button" className="join-alt" onClick={() => { setMethod("webauthn"); setCode(""); }}>
                  {t("usePasskey")}
                </button>
              )}
              {challenge?.methods.includes("totp") && method !== "totp" && (
                <button type="button" className="join-alt" onClick={() => { setMethod("totp"); setCode(""); }}>
                  {t("totpToggle")}
                </button>
              )}
              {challenge?.methods.includes("recovery_code") && method !== "recovery_code" && (
                <button type="button" className="join-alt" onClick={() => { setMethod("recovery_code"); setCode(""); }}>
                  {t("useRecovery")}
                </button>
              )}
              <button type="button" className="join-alt" onClick={restart}>{t("startOver")}</button>
            </div>
          </>
        )}
      </div>
      <p className="login-foot">{t("footer")}</p>
    </div>
  );
}
