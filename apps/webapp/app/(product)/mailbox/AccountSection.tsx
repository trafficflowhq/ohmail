"use client";

/**
 * DELETE YOUR ACCOUNT. The control behind the landing page's "Leave anytime".
 *
 * `DELETE /account` has existed and worked since the auth surface landed; what did not exist was any way for a
 * customer to reach it. The endpoint's own header quoted the marketing copy while the only
 * caller in the world was an operator with curl, which makes it a published claim with no
 * path — the one defect class this project treats as never acceptable, and under Art. 17
 * more than a copy problem.
 *
 * ── WHERE IT LIVES, AND WHY NOT ON A PAGE OF ITS OWN ────────────────────────────────────
 *
 * Settings → Account, inside the mail client. Not a new URL: the single-origin merge made
 * `ohmail.app/` the product's ONE address, and a `/account` route would have needed a link
 * from inside this same shared shell anyway — so it would have bought a second public URL, a
 * `OWN_PATHS` entry and a middleware matcher line to arrive exactly where this already is.
 * Settings is also where a person looks for it, which is what "anytime" has to mean.
 *
 * This file is Cloud-only: the desktop program builds without it. `SettingsView` takes it
 * as a NODE (`accountSection`) for that reason — the shared view knows nothing about
 * accounts, and Desktop, which is standalone and has none, grows no pane.
 *
 * ── THE CEREMONY IS RUN ALWAYS, NOT ON A 403 ────────────────────────────────────────────
 *
 * The route is `stepUp: true`, and NOTHING in this API refreshes `sessions.last_twofa_at`
 * except completing a login: the `/auth/2fa/…/verify` routes all require a single-use
 * `loginToken` that
 * only `POST /auth/login` mints. The window is five minutes. So a person sitting in their
 * mailbox is, essentially always, not step-up fresh — "try it and translate the 403" would
 * be a button that fails for everyone, and `JoinScreen`'s "sign in again and the setup
 * carries on" answer does not transfer, because signing in again lands you at `/` and this
 * pane is three clicks away.
 *
 * So the password and the second factor are asked for HERE, up front, every time. That is
 * not a second step-up pattern — it is the only mechanism the server has, performed in place
 * instead of by bouncing the user through `/login`.
 *
 * ── TWO GUARDS THAT ARE NOT OBVIOUS ─────────────────────────────────────────────────────
 *
 *  1. **The address is read-only.** A login mints a session for whatever account the
 *     credentials name, and `DELETE /account` then erases THAT account. An editable email
 *     field would be a delete-somebody-else's-account control.
 *  2. **The account id is re-checked after the factor verifies.** Belt to that brace: if the
 *     session that comes back is not the account this pane was opened for, nothing is sent.
 *
 * ── AFTER THE DELETE ────────────────────────────────────────────────────────────────────
 *
 * `signOut()` is deliberately NOT reused: the logout call inside it would 401 (the session row
 * is gone and `resolveSession` INNER JOINs `users`), and its `try/finally` rethrows past the
 * mirror wipe. (Written without the parentheses the sign-out guard greps for, on purpose — its
 * "only one caller" rule reads raw source and a mention in prose would trip it.) The API clears
 * the three cookies on the 200 instead. What is left is the IndexedDB mirror — every message
 * that ever came down `/sync`, still readable on this machine — so it is wiped for the same
 * reason `sign-out.ts` wipes it, with `owner` captured BEFORE the call because afterwards
 * there is nobody to ask.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { clearAllMirrors } from "@ohmail/client-engine";
import { Button, SettingsNote, SettingsSection } from "@ohmail/ui";
// The ONE correct way out — revokes server-side and wipes the local mirror. The sign-out guard
// asserts every `auth.logout` call in this app goes through it, so never call logout directly.
import { signOut } from "../../sign-out";
import { forgetOwner } from "../../shell/owner-cookie";
import {
  account,
  ApiError,
  apiConfigured,
  assertPasskey,
  auth,
  billing,
  codeOf,
  messageOf,
  webauthnAvailable,
  type ErasureResult,
  type SubscriptionStatus,
  type TwofaChallenge,
} from "../../api-client";

type Stage = "facts" | "password" | "factor" | "erasing" | "done";
type Factor = "webauthn" | "totp" | "recovery_code";

interface Who {
  accountId: string;
  email: string;
}

export function AccountSection() {
  const t = useTranslations("account");

  const [who, setWho] = useState<Who | null>(null);
  const [loading, setLoading] = useState(true);
  /**
   * A failed read is not an empty result. The server's own sentence when `GET /auth/session` could not be ASKED, as
   * opposed to answering that there is no session. `null` in both the healthy case and the
   * genuinely-signed-out one, which is what keeps the signed-out card meaning what it says.
   */
  const [sessionFailed, setSessionFailed] = useState<string | null>(null);
  const [plan, setPlan] = useState<string | null>(null);
  const [stage, setStage] = useState<Stage>("facts");
  const [typed, setTyped] = useState("");
  const [password, setPassword] = useState("");
  const [challenge, setChallenge] = useState<TwofaChallenge | null>(null);
  const [method, setMethod] = useState<Factor>("webauthn");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [noFactor, setNoFactor] = useState(false);
  const [result, setResult] = useState<ErasureResult | null>(null);

  const [signingOut, setSigningOut] = useState(false);
  /** The wipe was blocked by another tab: the mail is still on this browser. See `doSignOut`. */
  const [signOutBlocked, setSignOutBlocked] = useState(false);
  /** `POST /auth/logout` refused or never arrived, so the SESSION is still live. See `doSignOut`. */
  const [signOutServerRefused, setSignOutServerRefused] = useState<string | null>(null);
  /** The erasure landed and the local wipe did not. See `erase`. */
  const [eraseMirrorBlocked, setEraseMirrorBlocked] = useState(false);

  /** The pane can be navigated away from mid-ceremony; nothing may set state after that. */
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  /**
   * Sign out of THIS browser. Not step-up gated, deliberately: it destroys nothing the user
   * cannot get back by signing in again, and putting a password prompt in front of "get me off
   * this machine" is exactly backwards on the shared computer this exists for.
   *
   * The failure path matters more than the happy one. `signOut` wipes the local mirror in a
   * `finally`, so an unreachable server still clears the mail from this browser — and that is
   * why this does not surface a network error and stay put. Either way the user asked to be
   * signed out here, and either way they are, so it always leaves.
   *
   * `location.assign` rather than a router push: the session cookie is gone, so the shell must
   * be re-decided by the server. A client-side navigation would keep the signed-in React tree
   * alive on a dead session — the same class of mistake as the resume `location.replace` that
   * never re-requested.
   */
  const doSignOut = useCallback(async (owner: string) => {
    setSigningOut(true);
    setSignOutBlocked(false);
    setSignOutServerRefused(null);
    const outcome = await signOut(owner);
    /**
     * ── AND IF THE MAIL IS STILL HERE, THIS DOES NOT LEAVE ─────────────────────────────────
     *
     * An IndexedDB delete is BLOCKED — not failed — while any other connection holds the
     * database open, and our own page yields its handle but a SECOND TAB on the mailbox does
     * not. `signOut` used to resolve as though the wipe had worked and this navigated away, so
     * signing out of tab A with tab B open said "signed out" and left every message on disk on
     * exactly the borrowed machine this control exists for.
     *
     * Staying put costs a dead shell behind an actionable sentence; leaving costs a silent
     * false promise about somebody's mail. The remedy is one gesture (close the other tab and
     * press again), and the session and cookie are already gone either way — so pressing again
     * is safe and is what the copy asks for.
     */
    if (!outcome.cleared) {
      if (alive.current) {
        setSignOutBlocked(true);
        setSigningOut(false);
      }
      return;
    }
    /**
     * ── AND THE SERVER HALF IS A SECOND FACT, NOT THE SAME ONE ─────────────────────────────
     *
     * The header above argues correctly that a failed logout must not stop the local wipe. It
     * does not license CLAIMING the session ended. `tf_session` is HttpOnly and server-set:
     * nothing this page can do expires it, so a refused or unreachable logout leaves a live
     * credential that the next reachable request authenticates with — while this control's own
     * copy says "Ends this session". Leaving would have put the reader back into the mailbox on
     * the machine they had just asked to be signed out of.
     *
     * So the mail is gone, the pane stays, and the sentence says which half did not happen and
     * what to do about it. Pressing again is safe and is the first remedy; the second — revoking
     * this device — works from anywhere and does not need this browser at all.
     */
    if (outcome.serverRefused !== null) {
      if (alive.current) {
        setSignOutServerRefused(outcome.serverRefused);
        setSigningOut(false);
      }
      return;
    }
    window.location.assign("/");
  }, []);

  useEffect(() => {
    if (!apiConfigured()) {
      setLoading(false);
      return;
    }
    void (async () => {
      try {
        const { user, scope } = await auth.session();
        if (!alive.current) return;
        if (scope === "full" && user?.accountId) {
          setWho({ accountId: user.accountId, email: user.email });
        }
      } catch (err) {
        /**
         * ── A FAILED READ IS NOT AN EMPTY RESULT — "No session, OR the server is unreachable" ARE NOT ONE STATE ─────
         *
         * The comment named both and the code rendered only the first. `who` stayed `null`,
         * the `finally` cleared `loading`, and `:288` told a tab that is signed in
         * **"Deleting an account needs a live session on that account."** beside a **Sign
         * in** link — on the pane whose whole subject is proving who you are.
         *
         * A 401 genuinely IS "no session" and must keep the signed-out card; anything else
         * is our failure to answer, and `sessionFailed` is the difference. `codeOf`/`status`
         * is the discriminator rather than the presence of an error, because "we could not
         * ask" and "we asked and you are not signed in" have opposite remedies.
         */
        if (alive.current && !(err instanceof ApiError && (err.status === 401 || err.status === 403))) {
          setSessionFailed(messageOf(err));
        }
      } finally {
        if (alive.current) setLoading(false);
      }
      try {
        // Only to decide whether the subscription sentence is shown at all. A deployment with
        // no Stripe configured answers 503, which is not an error worth reporting here.
        const sub: SubscriptionStatus = await billing.subscription();
        if (alive.current) setPlan(sub.subscription?.plan ?? null);
      } catch {
        /* no billing, no subscription sentence */
      }
    })();
  }, []);

  const fail = (err: unknown): void => {
    setError(messageOf(err));
    // The five-minute window closing mid-ceremony is the one refusal with a specific remedy,
    // and it is the same branch `JoinScreen` takes: start the confirmation again.
    if (codeOf(err) === "step_up_required") {
      setStage("facts");
      setChallenge(null);
      setTyped("");
    }
    setBusy(false);
  };

  /** The last step, reached only from a verified second factor. */
  const erase = useCallback(async (owner: string) => {
    setStage("erasing");
    try {
      const out = await account.erase();
      // `owner` was captured before the call on purpose: `GET /auth/session` cannot answer
      // afterwards, and an un-wiped mirror is a readable copy of the mailbox left on this
      // machine. Best-effort — a browser that refuses to enumerate its databases must not
      // turn a completed erasure into an error message.
      //
      // The remembered account id goes with it, for the reason `sign-out.ts` pairs the two: the
      // shell opens a mirror on that name before the server has confirmed anything, so a name
      // left behind after an erasure would point the next load at a database that is gone and
      // an account that no longer exists.
      let remaining: string[] = [];
      try {
        forgetOwner();
        // READ THE ANSWER. `clearAllMirrors` returns the mirror names still on this origin —
        // an IndexedDB delete is BLOCKED, not failed, while another tab holds the database
        // open, so it resolves without throwing and this used to discard the one value that
        // said the mailbox copy survived. An erasure that reports itself complete over a
        // readable local copy is the worst instance of the class this whole change closes:
        // the account is gone, so there is no ordinary retry flow left to reach it with.
        remaining = await clearAllMirrors(owner);
      } catch {
        /* the same race `sign-out.ts` already accepts */
      }
      if (!alive.current) return;
      // The erasure DID happen and its receipt is shown either way — refusing to show it would
      // hide a completed, irreversible act. What changes is the sentence beside it.
      setEraseMirrorBlocked(remaining.length > 0);
      setResult(out);
      setStage("done");
    } catch (err) {
      if (!alive.current) return;
      setStage("factor");
      fail(err);
    }
  }, []);

  /** Shared tail of all three second factors: check the account, then erase. */
  const verified = async (accountId: string): Promise<void> => {
    if (!who || accountId !== who.accountId) {
      setError(t("mismatch"));
      setStage("facts");
      setBusy(false);
      return;
    }
    await erase(who.accountId);
  };

  const submitPassword = (e: React.FormEvent): void => {
    e.preventDefault();
    if (!who) return;
    setBusy(true);
    setError(null);
    void (async () => {
      try {
        const out = await auth.login({ email: who.email, password });
        setPassword("");
        if (out.status === "enrollment") {
          // Zero enrolled factors. Step-up has no bypass and should not have one, so this
          // account cannot be erased until it has a second factor — said plainly rather
          // than presented as a failure.
          setNoFactor(true);
          setBusy(false);
          return;
        }
        setChallenge(out);
        setMethod(
          out.methods.includes("webauthn") && webauthnAvailable() ? "webauthn"
            : out.methods.includes("totp") ? "totp" : out.methods[0]!,
        );
        setStage("factor");
        setBusy(false);
      } catch (err) {
        fail(err);
      }
    })();
  };

  const finishWithPasskey = (): void => {
    if (!challenge) return;
    setBusy(true);
    setError(null);
    void (async () => {
      try {
        const { options } = await auth.webauthnAssertOptions({ loginToken: challenge.loginToken });
        const credential = await assertPasskey(options);
        const s = await auth.webauthnAssertVerify({ loginToken: challenge.loginToken, credential });
        await verified(s.user.accountId);
      } catch (err) {
        fail(err);
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
        const s = method === "recovery_code"
          ? await auth.recoveryVerify({ loginToken: challenge.loginToken, code: code.trim() })
          : await auth.totpVerify({ loginToken: challenge.loginToken, code: code.trim() });
        setCode("");
        await verified(s.user.accountId);
      } catch (err) {
        fail(err);
      }
    })();
  };

  // ── The states that are not the ceremony ────────────────────────────────────────────

  if (!apiConfigured()) {
    return <Pane><p className="acct-lead">{t("unavailableBody")}</p></Pane>;
  }
  if (loading) {
    return <Pane><p className="acct-lead">{t("loading")}</p></Pane>;
  }
  /* A failed read is not an empty result — checked BEFORE `!who`, because `who` is null in both states and the one
     below it is the confident claim. A read we could not make says so and offers no remedy,
     since "sign in again" is not the remedy for a 503 and following it would sign a working
     session out. */
  if (sessionFailed !== null) {
    return <Pane><p className="acct-warn" role="alert">{sessionFailed}</p></Pane>;
  }
  if (!who) {
    return (
      <Pane>
        <p className="acct-lead">{t("signedOutBody")}</p>
        <Link className="btn" href="/login">{t("signIn")}</Link>
      </Pane>
    );
  }
  if (noFactor) {
    return (
      <Pane>
        <h2 className="acct-h">{t("noFactorTitle")}</h2>
        <p className="acct-lead">{t("noFactorBody")}</p>
        <Link className="btn" href="/join">{t("noFactorCta")}</Link>
      </Pane>
    );
  }
  if (stage === "done" && result) {
    return (
      <Pane>
        <h2 className="acct-h">{t("doneTitle")}</h2>
        <p className="acct-lead">{t("doneBody")}</p>
        {/* The server's own sentence about what survives, verbatim. */}
        <p className="acct-fine">{result.retained}</p>
        {result.subscription === "cancelled" ? (
          <p className="acct-fine">{t("doneSubCancelled")}</p>
        ) : null}
        {result.subscription === "cancel_failed" ? (
          <p className="acct-warn" role="alert">{t("doneSubFailed")}</p>
        ) : null}
        {/* The account is erased and the LOCAL copy is not. Said here, beside the receipt,
            because after an erasure there is no session left to route the reader anywhere
            else with — the remedy has to be one they can perform on this page. */}
        {eraseMirrorBlocked ? (
          <p className="acct-warn" role="alert">{t("erasedMirrorBlocked")}</p>
        ) : null}
        <div className="acct-actions">
          {/* A full navigation, not a router push: it tears down the engine and its in-memory
              mirror, and the cookies are already cleared, so `/` re-decides and renders the
              marketing page. */}
          <Button variant="primary" onClick={() => window.location.replace("/")}>
            {t("doneHome")}
          </Button>
        </div>
      </Pane>
    );
  }

  // ── The ceremony ────────────────────────────────────────────────────────────────────

  return (
    <>
      {/*
       * ═══ SIGN OUT IS ITS OWN CARD, AND THAT IS THE WHOLE POINT ═══════════════════════
       *
       * It used to sit INSIDE the delete card, directly under the words "This cannot be
       * undone" — so the one reversible control on this screen was wrapped in the language
       * and the frame of the irreversible one. A person looking for "get me off this
       * machine" read a permanence warning first and had to work out that it was not about
       * the button underneath it.
       *
       * Separating the CARDS is what fixes that, not separating the buttons: a rule inside
       * one panel still reads as two parts of one ceremony. Two panels are two subjects.
       *
       * The identity line moved here with it. "Signed in as …" is a fact about the SESSION,
       * which is what this card acts on; it was fused into the delete card's lead
       * ("Signed in as x. This cannot be undone."), a sentence that answered two unrelated
       * questions and attached the permanence of deletion to the fact of being signed in.
       *
       * `signOut` (app/sign-out.ts) is the only correct way out: it revokes server-side AND
       * wipes the IndexedDB mirror, which is where the mail actually is on this machine.
       * `owner` is passed explicitly and captured from state BEFORE the call, for the same
       * reason erasure captures it — afterwards there is nobody to ask.
       */}
      <SettingsSection className="acct acct-session">
        <h2 className="acct-h">{t("signOutTitle")}</h2>
        <p className="acct-lead">{t("signedInAs", { email: who.email })}</p>
        <div className="acct-signout">
          <div>
            <p className="acct-fine">{t("signOutBody")}</p>
            {signOutBlocked ? <p className="acct-fine acct-warn" role="alert">{t("signOutBlocked")}</p> : null}
            {signOutServerRefused === null ? null : (
              <p className="acct-fine acct-warn" role="alert">
                {t("signOutServerRefused", { reason: signOutServerRefused })}
              </p>
            )}
          </div>
          {/* `acct-signout-btn` is `flex:0 0 auto` and `white-space:nowrap`. Without it the
              button is an ordinary flex item beside a paragraph that wants the whole row, so
              it is squeezed until its two-word label breaks across two lines — which is how
              this control was reported. The door icon is the conventional mark for leaving a
              session; the button stays the quiet default variant because signing out is
              reversible and the card below is where the irreversible control lives. */}
          <Button
            className="acct-signout-btn"
            icon="door"
            disabled={signingOut}
            onClick={() => { void doSignOut(who.accountId); }}
          >
            {signingOut ? t("signOutBusy") : t("signOut")}
          </Button>
        </div>
      </SettingsSection>

    <Pane>
      <h2 className="acct-h">{t("title")}</h2>
      {/* Attached to DELETION and to nothing else. */}
      <p className="acct-lead">{t("lead")}</p>

      {error ? <p className="acct-warn" role="alert">{error}</p> : null}

      {/* Said once, first, and not repeated: it is the product's central promise and the
          reason erasure can be as blunt as it is. */}
      <SettingsNote icon="shield">{t("mail")}</SettingsNote>

      <div className="acct-cols">
        <div>
          <h3 className="acct-sub">{t("goneTitle")}</h3>
          <ul className="acct-list">
            <li>{t("gone1")}</li>
            <li>{t("gone2")}</li>
            <li>{t("gone3")}</li>
            <li>{t("gone4")}</li>
          </ul>
          <p className="acct-fine">{t("goneWhen")}</p>
        </div>
        <div>
          <h3 className="acct-sub">{t("keptTitle")}</h3>
          <ul className="acct-list">
            <li>{t("kept1")}</li>
            {plan ? <li>{t("keptSub", { plan })}</li> : null}
          </ul>
          <p className="acct-fine">
            {t("backups")}{" "}
            <Link href="/privacy">{t("backupsLink")}</Link>
          </p>
        </div>
      </div>

      {stage === "facts" ? (
        <form
          className="acct-confirm"
          onSubmit={(e) => { e.preventDefault(); setError(null); setStage("password"); }}
        >
          <label className="join-label" htmlFor="acct-typed">
            {t("typeLabel", { email: who.email })}
          </label>
          <input
            id="acct-typed" className="join-input" autoComplete="off" spellCheck={false}
            value={typed} onChange={(e) => setTyped(e.target.value)}
          />
          <div className="acct-actions">
            <Button
              variant="primary" type="submit" className="danger"
              disabled={typed.trim().toLowerCase() !== who.email.toLowerCase()}
            >
              {t("begin")}
            </Button>
          </div>
        </form>
      ) : null}

      {stage === "password" ? (
        <form className="acct-confirm" onSubmit={submitPassword}>
          <h3 className="acct-sub">{t("confirmTitle")}</h3>
          <p className="acct-fine">{t("confirmBody")}</p>
          {/* READ-ONLY, and see guard 1 in the header: an editable address here would let a
              password erase somebody else's account. */}
          <label className="join-label" htmlFor="acct-email">{t("emailLabel")}</label>
          <input id="acct-email" className="join-input" type="email" value={who.email} readOnly />
          <label className="join-label" htmlFor="acct-pw">{t("passwordLabel")}</label>
          <input
            id="acct-pw" className="join-input" type="password" autoComplete="current-password"
            value={password} onChange={(e) => setPassword(e.target.value)} required
          />
          <div className="acct-actions">
            <Button variant="primary" type="submit" className="danger" disabled={busy}>
              {busy ? t("working") : t("continue")}
            </Button>
            <Button onClick={() => { setStage("facts"); setPassword(""); setError(null); }}>
              {t("cancel")}
            </Button>
          </div>
        </form>
      ) : null}

      {stage === "factor" ? (
        <div className="acct-confirm">
          <h3 className="acct-sub">{t("factorTitle")}</h3>
          {/* The destructive act is named at the moment it fires — the next successful
              factor sends the DELETE, with no further click. */}
          <p className="acct-fine">{t("factorBody", { email: who.email })}</p>

          {method === "webauthn" ? (
            <div className="acct-actions">
              <Button
                variant="primary" icon="shield" className="danger"
                onClick={finishWithPasskey} disabled={busy}
              >
                {busy ? t("working") : t("passkey")}
              </Button>
            </div>
          ) : (
            <form onSubmit={finishWithCode}>
              <label className="join-label" htmlFor="acct-code">
                {method === "recovery_code" ? t("recoveryLabel") : t("totpLabel")}
              </label>
              <input
                id="acct-code" className="join-input join-code"
                inputMode={method === "totp" ? "numeric" : "text"}
                autoComplete="one-time-code"
                value={code} onChange={(e) => setCode(e.target.value)}
              />
              <div className="acct-actions">
                <Button
                  variant="primary" type="submit" className="danger"
                  disabled={busy || code.trim().length === 0}
                >
                  {busy ? t("working") : t("verifyErase")}
                </Button>
              </div>
            </form>
          )}

          <div className="acct-methods">
            {challenge?.methods.includes("webauthn") && method !== "webauthn" && webauthnAvailable() ? (
              <button type="button" className="join-alt" onClick={() => { setMethod("webauthn"); setCode(""); }}>
                {t("usePasskey")}
              </button>
            ) : null}
            {challenge?.methods.includes("totp") && method !== "totp" ? (
              <button type="button" className="join-alt" onClick={() => { setMethod("totp"); setCode(""); }}>
                {t("totpToggle")}
              </button>
            ) : null}
            {challenge?.methods.includes("recovery_code") && method !== "recovery_code" ? (
              <button type="button" className="join-alt" onClick={() => { setMethod("recovery_code"); setCode(""); }}>
                {t("useRecovery")}
              </button>
            ) : null}
            {/* A login token is single-use: after an attempted ceremony the safe move is a
                fresh password step, not a retry against a token that may be spent. */}
            <button
              type="button" className="join-alt"
              onClick={() => { setChallenge(null); setCode(""); setError(null); setStage("facts"); setTyped(""); }}
            >
              {t("cancel")}
            </button>
          </div>
        </div>
      ) : null}

      {stage === "erasing" ? <p className="acct-lead">{t("erasing")}</p> : null}
    </Pane>
    </>
  );
}

function Pane({ children }: { children: React.ReactNode }) {
  return <SettingsSection className="acct">{children}</SettingsSection>;
}
