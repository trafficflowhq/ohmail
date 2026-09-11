"use client";

/**
 * "Link the desktop app" — mint a one-use code, show it, and let it die on screen. The code is NOT
 * minted on load: a page-load mint is a prefetch mint, a restored-tab mint, an accidental
 * navigation mint — each a live credential nobody asked for; the press is also where the honest
 * sentence goes. The countdown is the SERVER's number (`expiresIn`): a literal here would be a
 * second copy of `desktopLinkTtlMs` that drifts, and a page saying "2 minutes" about a code that
 * died after one is worse than a page saying nothing. At zero the code is REMOVED, not greyed out —
 * a dead credential left visible is something a person keeps trying to type.
 */

/**
 * The step-up is re-asserted here, in place — the loop fix. `POST /auth/desktop-link` is step-up
 * gated (it mints a credential on a rolling four-hundred-day window); the page used to answer the
 * 403 by sending the visitor to `/login`, which treats a live session as "already done" and
 * bounces straight back WITHOUT re-asserting a factor — so the next mint 403'd again, round and
 * round. Nothing refreshes `sessions.last_twofa_at` except completing a factor, so one is completed
 * RIGHT HERE (the `AccountSection`/`MailboxSection` ceremony) and the mint retried the instant it
 * verifies; a plain 401 falls through the same ceremony for free, and a visitor with no factor is
 * pointed at `/join` rather than shown a dead ceremony.
 */

/**
 * The deep link is offered only for a code that is BOUND: when the app opened this page it appended `?challenge=` —
 * the public half of a PKCE pair whose verifier stays in the app's memory — and the code that comes back is spendable
 * only by a caller producing that verifier. That is the whole licence for the "Open ohmail" button: `ohmail://` is
 * claimed by whichever program registered it, and nothing authenticates that, so an interceptor receives a code it
 * cannot use.
 */

/**
 * With NO challenge there is no button — a deliberate refusal: an unbound code over a scheme anybody can claim is
 * strictly worse than the same code retyped into a window a person is looking at. A visitor who opened this page
 * themselves gets exactly the page that shipped before; the retype path is unchanged.
 */

import { useEffect, useRef, useState } from "react";
import { pendApiOwner } from "../../api-client";
import { readOwner } from "../../shell/owner-cookie";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Button, Icon } from "@ohmail/ui";
import {
  ApiError,
  apiConfigured,
  assertPasskey,
  auth,
  messageOf,
  webauthnAvailable,
  type TwofaChallenge,
} from "../../api-client";

/** A live code and the moment it stops being one. */
interface Minted {
  code: string;
  expiresAtMs: number;
}

/**
 * `idle` is the mint button (or the code, once one exists). The other three are the in-place
 * re-assertion the step-up gate forces: a password step, a factor step, and the dead end an
 * account with no factor at all lands on.
 */
type Phase = "idle" | "password" | "factor" | "enroll";
type Factor = "webauthn" | "totp" | "recovery_code";

/**
 * Where a bound code is handed back to the app. The scheme and the parameter name are a contract
 * with the desktop shell's handler — `code` and nothing else, because a deep link carries the
 * handoff code and never a token.
 */
const deepLink = (code: string): string => `ohmail://link?code=${encodeURIComponent(code)}`;

/**
 * TWO DIFFERENT THINGS ARE CALLED A CHALLENGE ON THIS SCREEN, so the PKCE one is bound under
 * another name: `challenge` below is the 2FA challenge the in-place sign-in ceremony carries, and
 * `commitment` is the PKCE digest the app committed to. Same word, unrelated mechanisms — sharing
 * an identifier here would be a bug waiting for whoever edits this next.
 */
export function LinkDesktopScreen({ challenge: commitment = "" }: { challenge?: string }) {
  /*
   * ── THIS PAGE ACTS ON AN ACCOUNT, SO IT IS NOT A PUBLIC SURFACE ─────────────────────────
   *
   * A fresh `/link-desktop` load left the Cloud client `public`, which permits every request.
   * The sequence review walked: the page is opened under A, another tab establishes B, and
   * pressing the button mints and RENDERS a one-use pairing credential for B — on a screen whose
   * whole job is to show a credential to whoever is looking at it.
   *
   * `pendApiOwner` during render, for `CloudShell`'s reason: an effect runs after the commit that
   * mounted the button, and the press can come first. It never widens, so a confirmed shell keeps
   * its binding and a refused sign-out keeps its block.
   */
  pendApiOwner(readOwner());
  const t = useTranslations("linkDesktop");
  /** The sign-in fields and factor controls are the same words `/login` uses; read them once. */
  const tl = useTranslations("login");

  const [minted, setMinted] = useState<Minted | null>(null);
  const [remaining, setRemaining] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Where the in-place re-assertion is, when one is running. `idle` means it is not. */
  const [phase, setPhase] = useState<Phase>("idle");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [challenge, setChallenge] = useState<TwofaChallenge | null>(null);
  const [method, setMethod] = useState<Factor>("webauthn");

  /** The page can be navigated away from mid-flight; nothing may set state after that. */
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  /**
   * Begin the in-place re-assertion. Prefill the address from the live session when there is one
   * (the 403 case: signed in, but the step-up window closed); a 401 has no session and the field
   * starts empty for the person to type. Either way the ceremony, not a redirect, is what runs.
   */
  const beginReauth = async (): Promise<void> => {
    try {
      const { user } = await auth.session();
      if (alive.current && user.email) setEmail(user.email);
    } catch {
      /* no session on this browser — the address is typed below */
    }
    if (!alive.current) return;
    setError(null);
    setPhase("password");
  };

  const mint = (): void => {
    setBusy(true);
    setError(null);
    void (async () => {
      try {
        // The commitment travels with every mint on this page, including the one retried after a
        // step-up ceremony — a retry that dropped it would silently hand back an UNBOUND code to
        // an app that is still holding a verifier, and the handoff would fail with nothing on
        // either screen saying why.
        const { code: minted, expiresIn } = await auth.desktopLink({ challenge: commitment });
        if (!alive.current) return;
        setMinted({ code: minted, expiresAtMs: Date.now() + expiresIn * 1000 });
        setRemaining(expiresIn);
        setPhase("idle");
      } catch (err) {
        if (!alive.current) return;
        // Both refusals mean "prove who you are on this browser", and both are answered in place
        // rather than by a trip to `/login` — see this file's header for the loop that trip was.
        if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
          await beginReauth();
        } else {
          setError(messageOf(err));
        }
      } finally {
        if (alive.current) setBusy(false);
      }
    })();
  };

  /* The countdown, and the removal at zero. One interval, cleared on unmount and whenever a new
     code replaces the old one — a leaked interval here would keep writing state into a page
     somebody has left. */
  useEffect(() => {
    if (!minted) return;
    const tick = (): void => {
      const left = Math.max(0, Math.ceil((minted.expiresAtMs - Date.now()) / 1000));
      setRemaining(left);
      if (left === 0) setMinted(null);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [minted]);

  const submitPassword = (e: React.FormEvent): void => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    void (async () => {
      try {
        const result = await auth.login({ email: email.trim(), password });
        if (!alive.current) return;
        setPassword("");
        if (result.status === "enrollment") {
          // Registered, but never finished a second factor — so there is no factor to assert and
          // no way to step up. `/join` resumes setup at the factor step.
          setPhase("enroll");
          setBusy(false);
          return;
        }
        setChallenge(result);
        setMethod(
          result.methods.includes("webauthn") && webauthnAvailable() ? "webauthn"
            : result.methods.includes("totp") ? "totp" : result.methods[0]!,
        );
        setPhase("factor");
        setBusy(false);
      } catch (err) {
        if (!alive.current) return;
        setError(messageOf(err));
        setBusy(false);
      }
    })();
  };

  /** A verified factor lands the session step-up fresh; the mint the visitor came for is retried. */
  const afterFactor = (): void => {
    if (!alive.current) return;
    setChallenge(null);
    setCode("");
    mint();
  };

  const finishWithPasskey = (): void => {
    if (!challenge) return;
    setBusy(true);
    setError(null);
    void (async () => {
      try {
        const { options } = await auth.webauthnAssertOptions({ loginToken: challenge.loginToken });
        const credential = await assertPasskey(options);
        await auth.webauthnAssertVerify({ loginToken: challenge.loginToken, credential });
        afterFactor();
      } catch (err) {
        if (!alive.current) return;
        setError(messageOf(err));
        setBusy(false);
      }
    })();
  };

  const finishWithCode = (e: React.FormEvent): void => {
    e.preventDefault();
    if (!challenge) return;
    setBusy(true);
    setError(null);
    void (async () => {
      try {
        if (method === "recovery_code") {
          await auth.recoveryVerify({ loginToken: challenge.loginToken, code: code.trim() });
        } else {
          await auth.totpVerify({ loginToken: challenge.loginToken, code: code.trim() });
        }
        afterFactor();
      } catch (err) {
        if (!alive.current) return;
        setError(messageOf(err));
        setBusy(false);
      }
    })();
  };

  /** Abandon the ceremony and return to the code screen. Password never lingers in state. */
  const cancelReauth = (): void => {
    setPassword("");
    setCode("");
    setChallenge(null);
    setError(null);
    setPhase("idle");
  };

  if (!apiConfigured()) {
    return (
      <Shell title={t("unavailableTitle")}>
        <p className="sub">{t("unavailableBody")}</p>
      </Shell>
    );
  }

  if (phase === "enroll") {
    return (
      <Shell title={t("enrollTitle")}>
        <p className="sub">{t("enrollBody")}</p>
        <div className="join-actions">
          <Link className="btn primary" href="/join">{t("enrollCta")}</Link>
        </div>
      </Shell>
    );
  }

  if (phase === "password") {
    return (
      <Shell title={t("reauthTitle")}>
        <p className="sub">{t("reauthLead")}</p>
        {error ? <p className="join-error" role="alert">{error}</p> : null}
        <form onSubmit={submitPassword}>
          <label className="join-label" htmlFor="link-email">{tl("emailLabel")}</label>
          <input
            id="link-email" className="join-input" type="email" autoComplete="username"
            value={email} onChange={(e) => setEmail(e.target.value)} required
          />
          <label className="join-label" htmlFor="link-pw">{tl("passwordLabel")}</label>
          <input
            id="link-pw" className="join-input" type="password" autoComplete="current-password"
            value={password} onChange={(e) => setPassword(e.target.value)} required
          />
          <div className="join-actions">
            <Button variant="primary" type="submit" disabled={busy}>
              {busy ? tl("working") : tl("continue")}
            </Button>
            <Button variant="ghost" type="button" onClick={cancelReauth} disabled={busy}>
              {t("reauthCancel")}
            </Button>
          </div>
        </form>
      </Shell>
    );
  }

  if (phase === "factor") {
    return (
      <Shell title={t("reauthTitle")}>
        {error ? <p className="join-error" role="alert">{error}</p> : null}
        {method === "webauthn" ? (
          <>
            <Button
              variant="primary" icon="shield" className="login-passkey"
              onClick={finishWithPasskey} disabled={busy}
            >
              {busy ? tl("working") : tl("passkey")}
            </Button>
            <p className="login-passkey-note">{tl("passkeyNote")}</p>
          </>
        ) : (
          <form onSubmit={finishWithCode} className="login-totp">
            <label className="join-label" htmlFor="link-code">
              {method === "recovery_code" ? tl("recoveryLabel") : tl("totpLabel")}
            </label>
            <input
              id="link-code" className="join-input join-code"
              inputMode={method === "totp" ? "numeric" : "text"}
              autoComplete="one-time-code"
              value={code} onChange={(e) => setCode(e.target.value)}
            />
            <div className="join-actions">
              <Button variant="primary" type="submit" disabled={busy || code.trim().length === 0}>
                {busy ? tl("working") : tl("totpVerify")}
              </Button>
            </div>
          </form>
        )}

        {/* Only the methods this user actually enrolled — offering TOTP to somebody who never set
            one up is a dead end that reads like a broken sign-in. */}
        <div className="login-methods">
          {challenge?.methods.includes("webauthn") && method !== "webauthn" && webauthnAvailable() && (
            <button type="button" className="join-alt" onClick={() => { setMethod("webauthn"); setCode(""); }}>
              {tl("usePasskey")}
            </button>
          )}
          {challenge?.methods.includes("totp") && method !== "totp" && (
            <button type="button" className="join-alt" onClick={() => { setMethod("totp"); setCode(""); }}>
              {tl("totpToggle")}
            </button>
          )}
          {challenge?.methods.includes("recovery_code") && method !== "recovery_code" && (
            <button type="button" className="join-alt" onClick={() => { setMethod("recovery_code"); setCode(""); }}>
              {tl("useRecovery")}
            </button>
          )}
          <button type="button" className="join-alt" onClick={cancelReauth}>{t("reauthCancel")}</button>
        </div>
      </Shell>
    );
  }

  return (
    <Shell title={t("title")}>
      <p className="sub">{t("lead")}</p>
      {error ? <p className="join-error" role="alert">{error}</p> : null}

      {minted ? (
        <>
          {/* `aria-live` so the code is announced when it appears — the whole page is one value
              a person has to read and carry, and it arrives after a press rather than on load. */}
          <p className="join-secret" aria-live="polite">{minted.code}</p>
          <p className="join-hint">{t("expiresIn", { seconds: remaining })}</p>
          {/* Only for a BOUND code — see this file's header. A plain anchor rather than `Link`:
              `next/link` is a client router and a custom scheme is not a route it can take. */}
          {commitment ? (
            <>
              <div className="join-actions">
                <a className="btn primary" href={deepLink(minted.code)}>{t("openApp")}</a>
              </div>
              {/* The retype steps below stay on screen and stay accurate. A scheme handler can
                  be missing, or claimed by something that does nothing visible, and a page whose
                  only route forward is a button that quietly did not work is a dead end. */}
              <p className="join-hint">{t("openAppFallback")}</p>
            </>
          ) : null}
          <ol className="join-hint">
            <li>{t("step1")}</li>
            <li>{t("step2")}</li>
          </ol>
          <div className="join-actions">
            <Button onClick={mint} disabled={busy}>{busy ? t("working") : t("again")}</Button>
          </div>
        </>
      ) : (
        <div className="join-actions">
          <Button variant="primary" onClick={mint} disabled={busy}>
            {busy ? t("working") : t("mint")}
          </Button>
        </div>
      )}

      <p className="join-hint">{t("safety")}</p>
    </Shell>
  );
}

function Shell({ title, children }: { title: string; children: React.ReactNode }) {
  const t = useTranslations("linkDesktop");
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
