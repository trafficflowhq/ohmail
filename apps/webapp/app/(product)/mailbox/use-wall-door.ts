"use client";

/**
 * The wall's ceremony, cut from `AccessLock` word for word: what the headline says and the date it carries, the way
 * back that MINTS AT THE PRESS, the settings export, the sign-out with its sentences, and the lift on the service's
 * fresh `access: "open"` (`useWallLift`). It deletes nothing and wipes nothing on its own, and its facts come from the
 * 402 the gate answered rather than from a read of its own.
 */

import { useCallback, useState } from "react";
import { useLocale } from "next-intl";
// The ONE correct way out — revokes server-side and wipes the local mirror. The sign-out guard
// asserts every `auth.logout` call in this app goes through it, so never call logout directly.
import { signOut } from "../../sign-out";
import { signOutTrouble, type SignOutTrouble } from "../../sign-out-trouble";
import { readOwner } from "@ohmail/app-logic/storage/owner-cookie";
import { saveBlob } from "../../shell/attachments";
import { ApiError, account, type AccessRefusedFacts, type AccountLifecycle } from "../../api-client";
import { leaveForManagePage } from "./SubscriptionSection";
import { useWallLift } from "@ohmail/app-logic/doors/wall-lift";
import { neverStarted, opensTheWall } from "../../access-verdict";

export type HeadlineKey = "title" | "suspendedTitle" | "trialEnded" | "canceled" | "unpaid" | "neverStartedTitle";

/** What the headline says, and the date it carries. `null` = the undated sentence. A never-started
 *  account (`neverStarted`) stopped nothing, so it is offered the trial and told nothing about erasure. */
export function headlineOf(
  lifecycle: AccountLifecycle | undefined,
  suspended: boolean,
): { key: HeadlineKey; date?: string } {
  if (!suspended && neverStarted(lifecycle)) return { key: "neverStartedTitle" };
  // ERASED IS NOT A SCREEN: erasure deletes the users, the sessions and the credentials, so
  // nobody signs in to read an "erased on" sentence. If the word ever reaches this client it
  // falls to the undated title rather than to a date about a deletion.
  if (lifecycle === undefined || lifecycle.state !== "closed") {
    return { key: suspended ? "suspendedTitle" : "title" };
  }
  if (lifecycle.closedReason === "suspended") return { key: "suspendedTitle" };
  const date = lifecycle.closedAt;
  // A dated sentence needs a date. Without one the honest thing is the sentence that has never
  // claimed one — inventing "today" would be a fact about the browser's clock.
  if (date === null || date === undefined) return { key: suspended ? "suspendedTitle" : "title" };
  if (lifecycle.closedReason === "trial_ended") return { key: "trialEnded", date };
  if (lifecycle.closedReason === "canceled") return { key: "canceled", date };
  if (lifecycle.closedReason === "unpaid") return { key: "unpaid", date };
  return { key: suspended ? "suspendedTitle" : "title" };
}

/** The export's filename: dated, so two downloads a month apart do not collide in a folder. */
export function exportFilename(now: Date): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  return `ohmail-settings-${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}.json`;
}

/** What the wall's ceremony holds and does: exactly what its page reads. */
export interface WallCeremony {
  check: ReturnType<typeof useWallLift>["check"];
  checkAgain: () => void;
  signingOut: boolean;
  /** Why the last sign-out did not finish, in the account pane's own sentences. */
  signOutSaid: SignOutTrouble | null;
  exporting: boolean;
  exportFailed: boolean;
  /** The password change, in place. */ changingPassword: boolean;
  setChangingPassword(on: boolean): void;
  minting: boolean;
  /** Why the last press did not leave: an unconfirmed address is its own sentence. */
  mintRefusal: "failed" | "unverified" | null;
  doMint(): Promise<void>;
  doSignOut(): Promise<void>;
  doExport(): Promise<void>;
  lifecycle: AccountLifecycle | undefined;
  headline: { key: HeadlineKey; date?: string };
  /** An account that has not started its trial: the trial is the screen, nothing else is said. */
  fresh: boolean;
  erasureAt: string | null;
  /** An operator hold: no erasure clock. */
  held: boolean;
  /** The dated erasure sentence is on this screen. */
  datedErasure: boolean;
}

export function useWallDoor({ facts, onLifted }: { facts: AccessRefusedFacts; onLifted?: () => void }): WallCeremony {
  const { check, armPoll, checkAgain } = useWallLift({
    lifts: async () => opensTheWall(await account.access({ fresh: true })),
    onLifted,
    owner: readOwner(),
  });
  const [signingOut, setSigningOut] = useState(false);
  /** Why the last sign-out did not finish, in the account pane's own sentences. */
  const [signOutSaid, setSignOutSaid] = useState<SignOutTrouble | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportFailed, setExportFailed] = useState(false);
  /**
   * The password change, in place, on the same terms: a refused subscription must not keep a
   * person from taking back a password somebody else knows (`POST /auth/password` is `ceremony`,
   * which a refused account still reaches). Opened by a press, so the wall itself takes no password.
   */
  const [changingPassword, setChangingPassword] = useState(false);
  const lang = useLocale() === "de" ? "de" : "en";
  const [minting, setMinting] = useState(false);
  /** Why the last press did not leave: an unconfirmed address is its own sentence. */
  const [mintRefusal, setMintRefusal] = useState<"failed" | "unverified" | null>(null);

  const doMint = useCallback(async () => {
    if (minting) return;
    setMintRefusal(null);
    setMinting(true);
    try {
      const url = (await account.manageLink({ lang }))?.url;
      if (typeof url === "string" && url.length > 0) {
        // The return is a poll: in this document if it survives the hand-off, in the next one if not.
        armPoll();
        leaveForManagePage(url);
        return;
      }
      setMintRefusal("failed");
    } catch (err) {
      const unverified = err instanceof ApiError && err.status === 403 && err.code === "email_unverified";
      setMintRefusal(unverified ? "unverified" : "failed");
    } finally {
      setMinting(false);
    }
  }, [armPoll, lang, minting]);

  const doSignOut = useCallback(async () => {
    setSigningOut(true);
    setSignOutSaid(null);
    // `owner` is captured before the call: afterwards there is nobody to ask which mirror to wipe.
    const said = signOutTrouble(await signOut(readOwner() ?? undefined));
    /* A wipe that did not land keeps the button and says why under it; a finished sign-out leaves
       for the sign-in page, as the error page's does; a server half that went unconfirmed leaves
       for `/`, which sends it to the sign-in page, which finishes it at the sign-out door. */
    if (said !== null && said.key !== "signOutServerRefused") {
      setSignOutSaid(said);
      setSigningOut(false);
      return;
    }
    if (said !== null) { window.location.assign("/"); return; }
    window.location.assign("/login");
  }, []);

  const doExport = useCallback(async () => {
    setExportFailed(false);
    setExporting(true);
    try {
      const document_ = await account.exportSettings();
      saveBlob(
        new Blob([JSON.stringify(document_, null, 2)], { type: "application/json" }),
        exportFilename(new Date()),
        document,
      );
    } catch {
      // Said rather than swallowed: a press that appears to do nothing is the state this screen
      // can least afford, and the remedy is to try again.
      setExportFailed(true);
    } finally {
      setExporting(false);
    }
  }, []);

  const lifecycle = facts.lifecycle;
  const headline = headlineOf(lifecycle, facts.reason === "suspended");
  /* An account that has not started its trial: the trial is the screen, nothing else is said. */
  const fresh = headline.key === "neverStartedTitle";
  const erasureAt = lifecycle?.erasureAt ?? null;
  /* An operator hold is not a departure, so it has no erasure clock (ruling §1(a)). The sentence
     says who holds it and where to ask, rather than leaving a date-shaped hole. */
  const held = lifecycle !== undefined && lifecycle.closedReason === "suspended";
  /* Is the DATED erasure sentence on this screen? The delete hint below says "rather than on the
     date above", and three states render no date (held, unknown, no lifecycle) — a hint that
     points at a date that is not there gets the undated sentence instead. */
  const datedErasure =
    lifecycle !== undefined && lifecycle.state !== "erased" && !held && erasureAt !== null;

  return {
    check, checkAgain, signingOut, signOutSaid, exporting, exportFailed, changingPassword,
    setChangingPassword, minting, mintRefusal, doMint, doSignOut, doExport, lifecycle, headline, fresh, erasureAt, held,
    datedErasure,
  };
}
