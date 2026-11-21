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
 * The erase is TRIED on the press. `DELETE /account` is `stepUp: true`, so a closed five-minute
 * window answers `step_up_required` before anything is touched; the pane then shows `StepUp`,
 * which re-stamps the session this browser holds, and the verified factor runs the erase once. A
 * fresh window erases on the first press. Nothing here signs in: the erase runs as the session the
 * pane was opened with, so there is no other account it could reach and no check for one. The
 * address is typed back before the press, against the session's own.
 */

/**
 * After the delete, signOut is not reused — named without parentheses here because its one-caller
 * census reads raw source. Its logout call would 401 (the session row is gone and `resolveSession`
 * inner-joins `users`) and its `try/finally` rethrows past the mirror wipe; the API clears the three
 * cookies on the 200 instead. What is left is the IndexedDB mirror — every message that ever came
 * down `/sync`, still readable on this machine — wiped here for THIS account only, by the erased
 * door's scope (another account's copy in the browser stays), with `owner` captured before the call
 * because afterwards there is nobody to ask.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Button, Field, RefusalLine, Sentence } from "@ohmail/ui/base";
import { SettingActs, SettingNote, SettingsSheet } from "@ohmail/ui/mail";
import { SELF_HOST_BUILD } from "../../hello";
// The ONE correct way out — revokes server-side and wipes the local mirror. The sign-out guard
// asserts every `auth.logout` call in this app goes through it, so never call logout directly.
import { forgetThisBrowser, signOut, signOutStayReason } from "../../sign-out";
import { purgeSiteCache } from "../../session-refresh";
import { markAccountErased } from "@ohmail/app-logic/session/account-erased";
import {
  account,
  ApiError,
  apiConfigured,
  auth,
  type ErasureResult,
} from "../../api-client";
import { useRefusalSentence } from "../refusal-sentence";
import { useManageOffer } from "./use-manage-offer";
import { StepUp } from "./StepUp";
import { gatedRefusal } from "./gated-refusal";

/** `stepup`: the erase was refused for a closed window and waits on the prompt. */
type Stage = "facts" | "stepup" | "erasing" | "done";

/** What a failed erase's answer says the release did before the failure (`details.subscription`). */
function releaseOf(err: unknown): ErasureResult["subscription"] | null {
  const s = err instanceof ApiError ? (err.details as { subscription?: unknown } | undefined)?.subscription : undefined;
  return s === "none" || s === "cancelled" || s === "cancel_failed" ? s : null;
}

interface Who {
  accountId: string;
  familyId?: string;
  email: string;
}

export function AccountSection() {
  const t = useTranslations("account");
  /* The step-up prompt's namespace, for the sentence an erase says when signing in is the remedy. */
  const td = useTranslations("devices");
  const sentence = useRefusalSentence();

  const [who, setWho] = useState<Who | null>(null);
  const [loading, setLoading] = useState(true);
  /**
   * A failed read is not an empty result. The renderer's sentence when `GET /auth/session` could not be ASKED, as
   * opposed to answering that there is no session. `null` in both the healthy case and the
   * genuinely-signed-out one, which is what keeps the signed-out card meaning what it says.
   */
  const [sessionFailed, setSessionFailed] = useState<string | null>(null);
  /**
   * Whether this account has a subscription to speak of at all.
   *
   * Read to decide whether the confirmation says anything about one — a self-hosted or unmetered
   * account has none, and a bullet about cancelling one would be a sentence about somebody else's
   * deployment. The OFFER and not the address: this screen is the erasure ceremony, it renders no
   * link, and a mount that minted one was minting it for a page nobody here can reach.
   */
  const { manageOffered } = useManageOffer(false);
  const [stage, setStage] = useState<Stage>("facts");
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);
  /** A factor landed after the prompt's Cancel and was discarded: nothing was erased, and it is said. */
  const erasePress = useRef<HTMLButtonElement>(null);
  const [stepUpDiscarded, setStepUpDiscarded] = useState(false);
  const [result, setResult] = useState<ErasureResult | null>(null);
  /**
   * A press that failed AFTER the subscription was cancelled: kept, because the retry's release has
   * nothing left to cancel and answers `none`, and the receipt must still say it was cancelled.
   */
  const [cancelledEarlier, setCancelledEarlier] = useState(false);

  const [signingOut, setSigningOut] = useState(false);
  /** The wipe was blocked by another tab: the mail is still on this browser. See `doSignOut`. */
  const [signOutBlocked, setSignOutBlocked] = useState(false);
  /** This browser will not say what it holds, so the wipe cannot be proved complete. */
  const [signOutUnverified, setSignOutUnverified] = useState(false);
  /** The erasure landed and the local wipe did not. See `erase`. */
  const [eraseMirrorBlocked, setEraseMirrorBlocked] = useState(false);

  /** The pane can be navigated away from mid-ceremony; nothing may set state, or erase, after that. */
  const alive = useRef(true);
  // Re-armed on mount: StrictMode replays the cleanup once, and a pane left at false never loads.
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  /**
   * Sign out of THIS browser. Not step-up gated, deliberately: it destroys nothing the user cannot
   * get back by signing in again, and a password prompt in front of "get me off this machine" is
   * exactly backwards on the shared computer this exists for. The failure path matters more:
   * `signOut` wipes the local mirror whatever the server said, so an unreachable server still clears
   * the mail from this browser, and the press leaves for `/`, which sends it to the sign-in page, which
   * finishes the server half behind its form and says so if it cannot (`login/finish-sign-out.ts`).
   * `location.assign` rather than a router push: the cookie is gone, so the shell must be re-decided by
   * the server — a client-side navigation would keep the signed-in React tree alive on a dead session.
   */
  const doSignOut = useCallback(async (owner: string, expectedFamily?: string) => {
    setSigningOut(true);
    setSignOutBlocked(false);
    setSignOutUnverified(false);
    const outcome = await signOut(owner, { expectedFamily });
    /* If the mail is still here this does not leave: an IndexedDB delete is BLOCKED while another
       tab holds the database open, and leaving would be a silent false promise about mail on a
       borrowed machine. A server half that went unconfirmed DOES leave, for `/`: the browser is
       wiped and marked, and the front door sends it to the sign-in page, which finishes it
       (`session-gate.ts`). */
    const stay = signOutStayReason(outcome);
    if (stay !== null) {
      if (alive.current) {
        if (stay === "unverified") setSignOutUnverified(true);
        else setSignOutBlocked(true);
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
        const { user, scope, familyId } = await auth.session();
        if (!alive.current) return;
        if (scope === "full" && user?.accountId) {
          setWho({ accountId: user.accountId, email: user.email, familyId });
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
          setSessionFailed(sentence(err));
        }
      } finally {
        if (alive.current) setLoading(false);
      }
    })();
  }, []);

  /**
   * THE ERASE, TRIED FIRST — `DELETE /account` is step-up gated, so a closed window answers 403
   * `step_up_required` before anything is touched and the prompt opens; the verified factor calls
   * this again with `afterFactor`, and a second refusal then is a sentence, never another prompt.
   * `owner` is the account the pane's session named at mount, captured before the call: afterwards
   * there is nobody to ask. Only THAT account's copy goes; another account's in this browser stays.
   */
  const erase = useCallback(async (owner: string, afterFactor = false) => {
    setStage("erasing");
    setError(null);
    setStepUpDiscarded(false);
    try {
      const out = await account.erase();
      // The receipt no longer carries the cache clear (Chrome held it for a walk of its whole cache).
      purgeSiteCache();
      // The account is gone: this tab asks nothing more under it. The binding the wipe below keeps
      // would otherwise read the cleared marker as a lost name on every later request.
      markAccountErased(owner);
      // Defaults to unclean: only a wipe that returns proves otherwise, on the one screen that can
      // never be reached again. Its answer is read — an IndexedDB delete is BLOCKED while another
      // tab holds the database open, and a localStorage removal can refuse, both without throwing.
      let unclean = true;
      try {
        const local = await forgetThisBrowser(owner, { only: true, erased: true });
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
      const why = gatedRefusal(err, afterFactor);
      if (why === "factor") {
        setStage("stepup");
        return;
      }
      // Back to the top, the typed address kept. A refusal the SERVER answered rolled its one
      // transaction back and is said in our words, never its "internal error", naming what the
      // release had already done. An outcome nobody confirmed (the server said so, or a 5xx with no
      // envelope of ours: the function cut mid-erasure) says exactly that, with the release's known
      // outcome. A request that never got an answer keeps the client's own sentence.
      const released = releaseOf(err);
      const cancelled = released === "cancelled" || cancelledEarlier;
      if (released === "cancelled") setCancelledEarlier(true);
      const unconfirmed = err instanceof ApiError
        && (err.code === "erasure_unconfirmed" || (err.status >= 500 && !err.wire.coded));
      setStage("facts");
      setError(why === "sign-in" ? td("stepUpExpired")
        : !(err instanceof ApiError && err.status >= 400) ? sentence(err)
          : unconfirmed ? (cancelled ? t("eraseUnconfirmedSubCancelled")
            : released === "cancel_failed" ? t("eraseUnconfirmedSubFailed") : t("eraseUnconfirmed"))
            : cancelled ? t("eraseRefusedSubCancelled")
              : released === "cancel_failed" ? t("eraseRefusedSubFailed") : t("eraseRefused"));
    }
  }, [sentence, t, td, cancelledEarlier]);

  // ── The states that are not the ceremony ────────────────────────────────────────────

  if (!apiConfigured()) {
    return <Pane><p className="oh-text">{t("unavailableBody")}</p></Pane>;
  }
  if (loading) {
    return <Pane><p className="oh-text">{t("loading")}</p></Pane>;
  }
  /* A failed read is not an empty result — checked BEFORE `!who`, because `who` is null in both states and the one
     below it is the confident claim. A read we could not make says so and offers no remedy,
     since "sign in again" is not the remedy for a 503 and following it would sign a working
     session out. */
  if (sessionFailed !== null) {
    return <Pane><RefusalLine alert>{sessionFailed}</RefusalLine></Pane>;
  }
  if (!who) {
    return (
      <Pane>
        <p className="oh-text">{t("signedOutBody")}</p>
        <Button kind="two" href="/login">{t("signIn")}</Button>
      </Pane>
    );
  }
  if (stage === "done" && result) {
    const subscription = cancelledEarlier ? "cancelled" : result.subscription;
    return (
      <Pane>
        <Sentence level={2}>{t("doneTitle")}</Sentence>
        <p className="oh-text">{t("doneBody")}</p>
        {/* The server's own sentence about what survives, verbatim. */}
        <p className="oh-text">{result.retained}</p>
        {subscription === "cancelled" ? (
          <p className="oh-text">{t("doneSubCancelled")}</p>
        ) : null}
        {subscription === "cancel_failed" ? (
          <RefusalLine alert>{t("doneSubFailed")}</RefusalLine>
        ) : null}
        {/* The account is erased and the LOCAL copy is not. Said here, beside the receipt,
            because after an erasure there is no session left to route the reader anywhere
            else with — the remedy has to be one they can perform on this page. */}
        {eraseMirrorBlocked ? (
          <RefusalLine alert>{t("erasedMirrorBlocked")}</RefusalLine>
        ) : null}
        <SettingActs>
          {/* A full navigation, not a router push: it tears down the engine and its in-memory
              mirror, and the cookies are already cleared, so `/` re-decides and renders the
              marketing page. */}
          <Button onPress={() => window.location.replace("/")}>
            {t(SELF_HOST_BUILD ? "doneHomeSelfHost" : "doneHome")}
          </Button>
        </SettingActs>
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
      <SettingsSheet title={t("signOutTitle")}>
        <p className="oh-text">{t("signedInAs", { email: who.email })}</p>
        <>
          <div>
            <p className="oh-text">{t("signOutBody")}</p>
            {signOutBlocked ? <RefusalLine alert>{t("signOutBlocked")}</RefusalLine> : null}
            {signOutUnverified ? <RefusalLine alert>{t("signOutUnverified")}</RefusalLine> : null}
          </div>
          <SettingActs>
          <Button
            kind="two"
            icon="go"
            disabled={signingOut}
            onPress={() => { void doSignOut(who.accountId, who.familyId); }}
          >
            {signingOut ? t("signOutBusy") : t("signOut")}
          </Button>
          </SettingActs>
        </>
      </SettingsSheet>

    <Pane>
      <Sentence level={2}>{t("title")}</Sentence>
      {/* Attached to DELETION and to nothing else. */}
      <p className="oh-text">{t("lead")}</p>

      {error ? <RefusalLine alert>{error}</RefusalLine> : null}
      {/* Not an error — the person got what they asked for. It is here because after a cancel
          the pane is back at the facts, which on their own look exactly like a pane that erased
          nothing because nothing was ever started. */}
      {stepUpDiscarded ? <SettingNote said>{t("cancelledNothingErased")}</SettingNote> : null}

      {/* Said once, first, and not repeated: it is the product's central promise and the
          reason erasure can be as blunt as it is. */}
      <SettingNote>{t("mail")}</SettingNote>

      <>
        <SettingsSheet title={t("goneTitle")}>
          <ul className="oh-text">
            <li>{t("gone1")}</li>
            <li>{t("gone2")}</li>
            <li>{t("gone3")}</li>
            <li>{t("gone4")}</li>
          </ul>
          <p className="oh-text">{t("goneWhen")}</p>
        </SettingsSheet>
        <SettingsSheet title={t("keptTitle")}>
          <ul className="oh-text">
            {/* What THIS server keeps: the managed sentence names a billing row and a processor a
                self-hosted database has no table for. */}
            <li>{t(SELF_HOST_BUILD ? "keptSelfHost" : "kept1")}</li>
            {/* GENERIC, and shown only where there is a subscription to speak of. It used to name
                the plan, which this app no longer knows — and does not need to: what the person
                is being told is that the money stops with the account, which is true of every
                plan. `releaseAccount` is what makes it true, and the response's own three words
                are what the result screen reports. */}
            {manageOffered ? <li>{t("keptSub")}</li> : null}
          </ul>
          {/* The retention SENTENCE is true on every deployment and stays; only the pointer is
              deployment-specific. `/privacy` describes the hosted service and is not served at
              all on a self-host build (`app/self-host-marketing.ts`), so the link would be a
              404 — and this is the deletion flow, the worst place to hand somebody a dead link
              to the explanation of what survives their deletion. Backups on somebody's own
              server are theirs to describe. */}
          <p className="oh-text">
            {t("backups")}
            {SELF_HOST_BUILD ? null : <> <a href="/privacy">{t("backupsLink")}</a></>}
          </p>
        </SettingsSheet>
      </>

      {stage === "facts" || stage === "stepup" || stage === "erasing" ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            // The press IS the erase on a fresh window, so the typed address is checked here too,
            // not only by the button it disables.
            if (stage !== "facts" || typed.trim().toLowerCase() !== who.email.toLowerCase()) return;
            void erase(who.accountId);
          }}
        >
          <Field
            id="acct-typed" autoComplete="off" label={t("typeLabel", { email: who.email })}
            value={typed} onChange={setTyped} disabled={stage !== "facts"}
          />
          <SettingActs>
            <Button
              ref={erasePress} type="submit" busy={stage !== "facts"}
              disabled={typed.trim().toLowerCase() !== who.email.toLowerCase()}
            >
              {t("begin")}
            </Button>
          </SettingActs>
        </form>
      ) : null}

      {stage === "stepup" ? (
        <StepUp
          inline
          line={t("factorBody", { email: who.email })}
          returnFocus={() => erasePress.current}
          onVerified={() => { if (alive.current) void erase(who.accountId, true); }}
          onCancel={() => setStage("facts")}
          onDiscarded={() => setStepUpDiscarded(true)}
        />
      ) : null}

      {stage === "erasing" ? <p className="oh-text">{t("erasing")}</p> : null}
    </Pane>
    </>
  );
}

function Pane({ children }: { children: React.ReactNode }) {
  return <SettingsSheet>{children}</SettingsSheet>;
}
