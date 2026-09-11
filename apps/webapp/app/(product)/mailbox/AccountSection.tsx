"use client";

/**
 * Delete your account — the control behind the landing page's "Leave anytime". `DELETE /account` has
 * worked since the auth surface landed; what did not exist was a customer path to it, which made a
 * published claim with no path — never acceptable here, and under Art. 17 more than a copy problem. It
 * lives in Settings → Account inside the mail client, not on a URL of its own: the single-origin merge
 * made `ohmail.app/` the one address, and a `/account` route would have bought a second public URL, an
 * `OWN_PATHS` entry and a middleware matcher to arrive where this already is. Cloud-only: the desktop
 * program builds without it — `SettingsView` takes it as a node (`accountSection`), so Desktop grows
 * no pane.
 */

/**
 * The ceremony runs always, not on a 403: the route is `stepUp: true` and nothing refreshes
 * `sessions.last_twofa_at` except completing a login — the verify routes need a single-use
 * `loginToken` only `POST /auth/login` mints, and the window is five minutes — so a person in their
 * mailbox is essentially never step-up fresh. Password and second factor are asked here, up front; not
 * a second step-up pattern but the server's only mechanism, performed in place instead of by bouncing
 * through `/login`. Two guards: the address is read-only (an editable email field would be a
 * delete-somebody-else's-account control), and the account id is re-checked after the factor
 * verifies — if the session that comes back is not this pane's account, nothing is sent.
 */

/**
 * After the delete, signOut is not reused — named without parentheses here because its one-caller
 * census reads raw source. Its logout call would 401 (the session row is gone and `resolveSession`
 * inner-joins `users`) and its `try/finally` rethrows past the mirror wipe; the API clears the three
 * cookies on the 200 instead. What is left is the IndexedDB mirror — every message that ever came
 * down `/sync`, still readable on this machine — wiped here for the reason `sign-out.ts` wipes it,
 * with `owner` captured before the call because afterwards there is nobody to ask.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Button, SettingsNote, SettingsSection } from "@ohmail/ui";
import { SELF_HOST_BUILD } from "../../hello";
// The ONE correct way out — revokes server-side and wipes the local mirror. The sign-out guard
// asserts every `auth.logout` call in this app goes through it, so never call logout directly.
import { forgetThisBrowser, signOut } from "../../sign-out";
import {
  account,
  ApiError,
  apiConfigured,
  assertPasskey,
  auth,
  codeOf,
  messageOf,
  webauthnAvailable,
  type ErasureResult,
  type TwofaChallenge,
} from "../../api-client";
import { useManageLink } from "./SubscriptionSection";

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
  /**
   * Where this account manages its subscription, or `null` for "nowhere".
   *
   * Read to decide whether the confirmation says anything about a subscription at all — a
   * self-hosted or unmetered account has none, and a bullet about cancelling one would be a
   * sentence about somebody else's deployment. The URL itself is not rendered here: this screen
   * is the erasure ceremony, and its one control must stay the destructive one.
   */
  const manageUrl = useManageLink(false);
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
  /** This browser will not say what it holds, so the wipe cannot be proved complete. */
  const [signOutUnverified, setSignOutUnverified] = useState(false);
  /** `POST /auth/logout` refused or never arrived, so the SESSION is still live. See `doSignOut`. */
  const [signOutServerRefused, setSignOutServerRefused] = useState<string | null>(null);
  /** The erasure landed and the local wipe did not. See `erase`. */
  const [eraseMirrorBlocked, setEraseMirrorBlocked] = useState(false);

  /** The pane can be navigated away from mid-ceremony; nothing may set state after that. */
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  /**
   * Sign out of THIS browser. Not step-up gated, deliberately: it destroys nothing the user cannot
   * get back by signing in again, and a password prompt in front of "get me off this machine" is
   * exactly backwards on the shared computer this exists for. The failure path matters more:
   * `signOut` wipes the local mirror in a `finally`, so an unreachable server still clears the mail
   * from this browser — which is why this does not surface a network error and stay put; either way
   * the user asked to be signed out here, and either way they are. `location.assign` rather than a
   * router push: the cookie is gone, so the shell must be re-decided by the server — a client-side
   * navigation would keep the signed-in React tree alive on a dead session.
   */
  const doSignOut = useCallback(async (owner: string) => {
    setSigningOut(true);
    setSignOutBlocked(false);
    setSignOutUnverified(false);
    setSignOutServerRefused(null);
    const outcome = await signOut(owner);
    /**
     * If the mail is still here, this does not leave. An IndexedDB delete is BLOCKED — not failed —
     * while any other connection holds the database open; our own page yields its handle, but a
     * second tab on the mailbox does not. `signOut` used to resolve as though the wipe had worked, so
     * signing out of tab A with tab B open said "signed out" and left every message on disk on the
     * borrowed machine this control exists for. Staying put costs a dead shell behind an actionable
     * sentence; leaving costs a silent false promise about somebody's mail. The session and cookie
     * are already gone, so pressing again is safe — the first thing the copy asks. The sentence names
     * both causes (a blocked delete or a refused one): this arm cannot tell them apart.
     */
    /**
     * The unverifiable case is tested first because it is a subset of the other: `cleared` is false
     * whenever the inventory is partial, so checking `!cleared` first made this branch unreachable —
     * every browser that simply could not be asked what it holds was told another tab was holding its
     * mail open, and this distinct remedy was dead code. Nothing is holding a database open here: the
     * browser will not say which local databases it has, and the registry it would fall back on has
     * never been anchored on this origin. The deletes we could name went through; what cannot be
     * claimed is that they were all of them.
     */
    if (!outcome.inventoryComplete) {
      if (alive.current) {
        setSignOutUnverified(true);
        setSigningOut(false);
      }
      return;
    }
    /**
     * Same rule as the sign-out arm above: a blocked IndexedDB delete (a second tab holds the
     * database open) or a refused one must not let this leave — leaving would be a silent false
     * promise about mail still on disk. The session and cookie are already gone, so pressing again
     * is safe, and the sentence names both causes because this arm cannot tell them apart.
     */
    if (!outcome.cleared) {
      if (alive.current) {
        setSignOutBlocked(true);
        setSigningOut(false);
      }
      return;
    }
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
         * A failed read is not an empty result — "no session" and "the server is unreachable" are
         * not one state. The comment named both and the code rendered only the first: `who` stayed
         * `null` and a signed-in tab was told "Deleting an account needs a live session on that
         * account." beside a Sign in link. A 401 genuinely is "no session" and keeps the signed-out
         * card; anything else is our failure to answer, and `sessionFailed` is the difference.
         * `codeOf`/`status` discriminates rather than the presence of an error, because "we could
         * not ask" and "you are not signed in" have opposite remedies.
         */
        if (alive.current && !(err instanceof ApiError && (err.status === 401 || err.status === 403))) {
          setSessionFailed(messageOf(err));
        }
      } finally {
        if (alive.current) setLoading(false);
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
      // afterwards, and an un-wiped mirror is a readable copy of the mailbox left on this machine.
      // Best-effort — a browser that refuses to enumerate its databases must not turn a completed
      // erasure into an error. The remembered account id goes with it (the `sign-out.ts` pairing): a
      // name left behind would point the next load at a database that is gone. Defaults to unclean —
      // only a wipe that returns proves otherwise; initialising to `false` made every exception
      // during the wipe indistinguishable from a verified clean browser, on the one screen that can
      // never be reached again: the account is gone, so no session is left to route a retry through.
      let unclean = true;
      try {
        // THE SAME LOCAL CLEANUP SIGN-OUT DOES, not a subset of it. This used to be
        // `forgetOwner()` plus the mirror wipe, which left every durable localStorage store the
        // durability slice added — the compose and reply scratch buffers, the Screener intent
        // journal, the send lanes — sitting on the machine after an IRREVERSIBLE deletion, with
        // no session left to reach them from. One implementation, two callers.
        //
        // And its ANSWER is read: an IndexedDB delete is BLOCKED, not failed, while another tab
        // holds the database open, and a localStorage removal can refuse. Both resolve without
        // throwing, and this discarded the one value that said the mail survived.
        const local = await forgetThisBrowser(owner);
        unclean = local.remaining.length > 0 || !local.inventoryComplete;
      } catch {
        /* the same race `sign-out.ts` already accepts — and `unclean` stays true */
      }
      if (!alive.current) return;
      // The erasure DID happen and its receipt is shown either way — refusing to show it would
      // hide a completed, irreversible act. What changes is the sentence beside it.
      setEraseMirrorBlocked(unclean);
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
       * Sign out is its own card, and that is the point: it used to sit inside the delete card under
       * "This cannot be undone", so the one reversible control on this screen wore the frame of the
       * irreversible one. Separating the cards fixes that, not separating the buttons — a rule inside
       * one panel still reads as two parts of one ceremony; two panels are two subjects. The identity
       * line moved here with it: "Signed in as …" is a fact about the session, which is what this
       * card acts on. `signOut` (app/sign-out.ts) is the only correct way out — it revokes
       * server-side and wipes the IndexedDB mirror — and `owner` is captured from state before the
       * call, for the same reason erasure captures it: afterwards there is nobody to ask.
       */}
      <SettingsSection className="acct acct-session">
        <h2 className="acct-h">{t("signOutTitle")}</h2>
        <p className="acct-lead">{t("signedInAs", { email: who.email })}</p>
        <div className="acct-signout">
          <div>
            <p className="acct-fine">{t("signOutBody")}</p>
            {signOutBlocked ? <p className="acct-fine acct-warn" role="alert">{t("signOutBlocked")}</p> : null}
            {signOutUnverified ? <p className="acct-fine acct-warn" role="alert">{t("signOutUnverified")}</p> : null}
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
            {/* GENERIC, and shown only where there is a subscription to speak of. It used to name
                the plan, which this app no longer knows — and does not need to: what the person
                is being told is that the money stops with the account, which is true of every
                plan. `releaseAccount` is what makes it true, and the response's own three words
                are what the result screen reports. */}
            {manageUrl ? <li>{t("keptSub")}</li> : null}
          </ul>
          {/* The retention SENTENCE is true on every deployment and stays; only the pointer is
              deployment-specific. `/privacy` describes the hosted service and is not served at
              all on a self-host build (`app/self-host-marketing.ts`), so the link would be a
              404 — and this is the deletion flow, the worst place to hand somebody a dead link
              to the explanation of what survives their deletion. Backups on somebody's own
              server are theirs to describe. */}
          <p className="acct-fine">
            {t("backups")}
            {SELF_HOST_BUILD ? null : <> <Link href="/privacy">{t("backupsLink")}</Link></>}
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
