"use client";

/**
 * `/account/delete` — the account erasure ceremony reached from Settings › Account.
 *
 * What a page of its own adds: it settles whose browser this is first, as `/approve` does (`approve/settle-owner.ts`),
 * and reads the session's own address only while settled on that account; the press always asks the second factor
 * (the server's gate stays as it is), and the erase runs only from the verified factor, so a second closed window
 * after it is a sentence, never another prompt. A marker that goes while the page is up settles the page again;
 * nothing parked runs by itself.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { readOwner } from "@ohmail/app-logic/storage/owner-cookie";
import { markAccountErased } from "@ohmail/app-logic/session/account-erased";
import { pendApiOwner } from "../../../api-client";
import { account, ApiError, OFFLINE_CODE, apiConfigured, auth, type ErasureResult } from "../../../api-client";
// The ONE correct way out — revokes server-side and wipes the local mirror. The sign-out guard
// asserts every `auth.logout` call in this app goes through it, so never call logout directly.
import { forgetThisBrowser } from "../../../sign-out";
import { purgeSiteCache } from "../../../session-refresh";
import { useRefusalSentence } from "../../refusal-sentence";
import { isOwnerAbsent, useSettledOwner, type Settled } from "../../approve/settle-owner";
import { gatedRefusal } from "../../mailbox/gated-refusal";
import { useManageOffer } from "../../mailbox/use-manage-offer";

/** `factor`: the press asked the second factor and the erase waits on it. */
export type Stage = "facts" | "factor" | "erasing" | "done";

/** What a failed erase's answer says the release did before the failure (`details.subscription`). */
function releaseOf(err: unknown): ErasureResult["subscription"] | null {
  const s = err instanceof ApiError ? (err.details as { subscription?: unknown } | undefined)?.subscription : undefined;
  return s === "none" || s === "cancelled" || s === "cancel_failed" ? s : null;
}

interface Who {
  accountId: string;
  email: string;
}

/** What the delete page's ceremony holds and does: exactly what its page reads. */
export interface DeleteAccountCeremony {
  settled: Settled;
  /** The session's own account, while the page is settled on it. */
  who: Who | null;
  /** No live session here, or one that is not a full sign-in: deleting needs one. */
  signedOut: boolean;
  /** The session read could not be asked (not "no session"): the one renderer's sentence. */
  sessionFailed: string | null;
  manageOffered: boolean;
  stage: Stage;
  typed: string;
  setTyped(value: string): void;
  error: string | null;
  /** A factor landed after the dialog's Cancel and was thrown away: nothing was erased, and it is said. */
  discarded: boolean;
  result: ErasureResult | null;
  /** The subscription was cancelled by an earlier press that failed after it. */
  cancelledEarlier: boolean;
  eraseMirrorBlocked: boolean;
  /** The typed address is the session's own: the second factor is asked. */
  begin(): void;
  stepUpVerified(): void;
  stepUpCancelled(): void;
  stepUpDiscarded(): void;
  stepUpOwnerAbsent(): void;
}

export function useDeleteAccountDoor(): DeleteAccountCeremony {
  /* THIS PAGE ACTS ON AN ACCOUNT — `/link-desktop`'s reason: the account is pended during render so a press that comes
     before any effect still asks as the account this browser is bound to. */
  pendApiOwner(readOwner());
  const t = useTranslations("account");
  /* The step-up prompt's namespace, for the sentence an erase says when signing in is the remedy. */
  const td = useTranslations("devices");
  const sentence = useRefusalSentence();
  /* Nothing is asked for until this says whose browser it is; see `approve/settle-owner.ts`. */
  const { settled, resettle } = useSettledOwner(apiConfigured());

  /** The session read's answer: its account, `none` for no full session, null while it is asked. */
  const [read, setRead] = useState<Who | "none" | null>(null);
  const [sessionFailed, setSessionFailed] = useState<string | null>(null);
  const who = settled.kind === "owner" && read !== null && read !== "none" && read.accountId === settled.accountId
    ? read : null;
  const signedOut = settled.kind === "none" || (settled.kind === "owner" && read === "none");
  /* Whether there is a subscription to speak of — asked only once the page is settled on its account (no read leaves
     before that); the hook's switch is its demo flag, which asks nothing while it is on. */
  const { manageOffered } = useManageOffer(settled.kind !== "owner");
  const [stage, setStage] = useState<Stage>("facts");
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);
  /** A factor landed after the dialog's Cancel and was discarded: nothing was erased, and it is said. */
  const [discarded, setDiscarded] = useState(false);
  const [result, setResult] = useState<ErasureResult | null>(null);
  /**
   * A press that failed AFTER the subscription was cancelled: kept, because the retry's release has
   * nothing left to cancel and answers `none`, and the receipt must still say it was cancelled.
   */
  const [cancelledEarlier, setCancelledEarlier] = useState(false);
  /** The erasure landed and the local wipe did not. See `erase`. */
  const [eraseMirrorBlocked, setEraseMirrorBlocked] = useState(false);

  /** The page can be navigated away from mid-ceremony; nothing may set state, or erase, after that. */
  const alive = useRef(true);
  // Re-armed on mount: StrictMode replays the cleanup once, and a page left at false never loads.
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  /* Settling again drops what the page read for the account before, and an erase parked behind the factor. */
  const settleAgain = useCallback((): void => {
    setStage("facts");
    setRead(null);
    resettle();
  }, [resettle]);

  /* The session's own address, once the page is settled on its account. A 401 is "no session"; anything else is a
     read that could not be made, and says so rather than claiming either. */
  useEffect(() => {
    if (settled.kind !== "owner") return;
    let live = true;
    void (async () => {
      try {
        const { user, scope } = await auth.session();
        if (!live || !alive.current) return;
        setRead(scope === "full" && user?.accountId ? { accountId: user.accountId, email: user.email } : "none");
      } catch (err) {
        if (!live || !alive.current) return;
        if (isOwnerAbsent(err)) { settleAgain(); return; }
        if (err instanceof ApiError && (err.status === 401 || err.status === 403)) setRead("none");
        else setSessionFailed(sentence(err));
      }
    })();
    return () => { live = false; };
    // One read per settle: the account the page settled on is what the read is for.
  }, [settled]);

  /**
   * THE ERASE, from the verified factor only — `DELETE /account` is step-up gated, and the page asks the factor on every
   * press, so a closed window after the factor is a sentence, never another prompt. `owner` is the account the page
   * settled on, captured before the call: afterwards there is nobody to ask. Only THAT account's copy goes; another
   * account's in this browser stays.
   */
  const erase = useCallback(async (owner: string, afterFactor = false) => {
    setStage("erasing");
    setError(null);
    setDiscarded(false);
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
      // The marker went while the page was up: whose browser this is is asked again, and nothing is said.
      if (isOwnerAbsent(err)) { settleAgain(); return; }
      const why = gatedRefusal(err, afterFactor);
      if (why === "factor") {
        setStage("factor");
        return;
      }
      // Back to the top, the typed address kept. A refusal the SERVER answered rolled its one
      // transaction back and is said in our words, never its "internal error", naming what the
      // release had already done. A lost response, an uncoded 5xx, or an explicit unconfirmed
      // outcome leaves the deletion uncertain. Keep what the page already knows about the release.
      const released = releaseOf(err);
      const cancelled = released === "cancelled" || cancelledEarlier;
      if (released === "cancelled") setCancelledEarlier(true);
      const unconfirmed = err instanceof ApiError
        && (err.code === "erasure_unconfirmed" || err.code === OFFLINE_CODE || (err.status >= 500 && !err.wire.coded));
      setStage("facts");
      if (why === "sign-in") {
        setError(td("stepUpExpired"));
        return;
      }
      if (unconfirmed) {
        setError(cancelled ? t("eraseUnconfirmedSubCancelled")
          : released === "cancel_failed" ? t("eraseUnconfirmedSubFailed") : t("eraseUnconfirmed"));
        return;
      }
      setError(!(err instanceof ApiError && err.status >= 400) ? sentence(err)
          : cancelled ? t("eraseRefusedSubCancelled")
            : released === "cancel_failed" ? t("eraseRefusedSubFailed") : t("eraseRefused"));
    }
  }, [sentence, t, td, cancelledEarlier, settleAgain]);

  /** The press: only for the session's own address, typed back; it asks the factor and erases nothing yet. */
  const begin = (): void => {
    if (who === null || stage !== "facts") return;
    if (typed.trim().toLowerCase() !== who.email.toLowerCase()) return;
    setError(null);
    setDiscarded(false);
    setStage("factor");
  };

  return {
    settled, who, signedOut, sessionFailed, manageOffered, stage, typed, setTyped, error, discarded, result,
    cancelledEarlier, eraseMirrorBlocked, begin,
    stepUpVerified: () => { if (alive.current && who !== null) void erase(who.accountId, true); },
    stepUpCancelled: () => setStage("facts"),
    stepUpDiscarded: () => setDiscarded(true),
    stepUpOwnerAbsent: settleAgain,
  };
}
