"use client";

import { useCallback, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Button, Spinner } from "@ohmail/ui";
// The ONE correct way out — revokes server-side and wipes the local mirror. The sign-out guard
// asserts every `auth.logout` call in this app goes through it, so never call logout directly.
import { signOut } from "../../sign-out";
import { readOwner } from "../../shell/owner-cookie";
import { dayStamp } from "../../shell/format";
import { saveBlob } from "../../shell/attachments";
import { ApiError, account, type AccessRefusedFacts, type AccountLifecycle } from "../../api-client";
import { AccountSection } from "./AccountSection";
import { leaveForManagePage } from "./SubscriptionSection";
import { useWallLift } from "../../shell/wall-lift";
import { opensTheWall } from "../../access-verdict";

/**
 * The wall — what an account the service has refused sees instead of its mail. Three things it
 * must do: say WHAT HAPPENED AND WHEN; say that the MAILBOX IS UNTOUCHED, because a screen that
 * only says "no" reads as data loss; and leave every door open, because a lock with no way out is
 * a trap. It deletes nothing and wipes nothing on its own, and its facts come from the 402 the
 * gate answered rather than from a read of its own. The way back MINTS AT THE PRESS: a link held
 * from the 402 lives ten minutes and once, so `manageUrl` only decides whether the button exists.
 * It lifts itself only on the service's fresh `access: "open"` (`useWallLift`), via `onLifted`.
 */

/** What the headline says, and the date it carries. `null` = the undated sentence. */
function headlineOf(
  lifecycle: AccountLifecycle | undefined,
  suspended: boolean,
): { key: "title" | "suspendedTitle" | "trialEnded" | "canceled" | "unpaid"; date?: string } {
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

export function AccessLock(
  { facts, onLifted }: { facts: AccessRefusedFacts; onLifted?: () => void },
) {
  const t = useTranslations("accessLock");
  const { check, armPoll, checkAgain } = useWallLift({
    lifts: async () => opensTheWall(await account.access({ fresh: true })),
    onLifted,
    owner: readOwner(),
  });
  const [signingOut, setSigningOut] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportFailed, setExportFailed] = useState(false);
  /** The erasure ceremony, in place. It is the Settings pane's own, not a second door. */
  const [deleting, setDeleting] = useState(false);
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
    // `owner` is captured before the call: afterwards there is nobody to ask which mirror to wipe.
    await signOut(readOwner() ?? undefined);
    // `signOut` navigates on success. A refusal leaves the session live and the button available
    // again, which is the honest state — this screen has nothing else to fall back to.
    setSigningOut(false);
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
  const erasureAt = lifecycle?.erasureAt ?? null;
  /* An operator hold is not a departure, so it has no erasure clock (ruling §1(a)). The sentence
     says who holds it and where to ask, rather than leaving a date-shaped hole. */
  const held = lifecycle !== undefined && lifecycle.closedReason === "suspended";
  /* Is the DATED erasure sentence on this screen? The delete hint below says "rather than on the
     date above", and three states render no date (held, unknown, no lifecycle) — a hint that
     points at a date that is not there gets the undated sentence instead. */
  const datedErasure =
    lifecycle !== undefined && lifecycle.state !== "erased" && !held && erasureAt !== null;

  /* THE SHELL EVERY FULL-SCREEN SENTENCE IN THIS APP STANDS IN — `.gate` / `.gate-card` /
     `.gate-actions` from `app.css`, the same one the resume splash, the engine's four states and
     the desktop window's own lock screen use. `<main>` rather than the siblings' `<div>` — this is
     the whole page, and the landmark costs nothing that `.gate` cares about. */
  return (
    <main className="gate">
      <div className="gate-card wall-card">
        {/* oh | mail, split so `.gate-card .wordmark em` can carry accent-ink — the form every
            gate in this app writes. */}
        <span className="wordmark">
          <b>
            <em>oh</em>mail
          </b>
        </span>
        <h1>
          {headline.date !== undefined
            ? t(headline.key, { date: dayStamp(headline.date) })
            : t(headline.key)}
        </h1>
        {lifecycle !== undefined
          ? (
            <>
              {/* THE HALF A REFUSAL SCREEN GETS WRONG. Said as two short sentences and not one
                  paragraph: the second is the one a person needs to believe, and it is the
                  product's oldest promise — the mailbox is the master. */}
              <p className="wall-lead">{t("stopped")}</p>
              <p className="wall-master">{t("mailboxUntouched")}</p>
              {/* SAID ONLY WHERE THERE IS SOMETHING TRUE TO SAY. An erased account has no erasure
                  sentence at all: "nothing has been erased" would be false, and the dated one is
                  the sentence the ruling drops. That state is unreachable — erasure takes the
                  sessions with it — and a false claim in an unreachable state is still a false
                  claim. */}
              {lifecycle.state === "erased"
                ? null
                : (
                  <p className="wall-fine">
                    {held
                      ? t("erasureHeld")
                      : erasureAt !== null
                        ? t("erasure", { date: dayStamp(erasureAt) })
                        : t("erasureUnknown")}
                  </p>
                )}
            </>
          )
          /* A server that predates the wall says nothing about when or why, so this screen says
             what it has always said. Not a fallback that guesses — one that stops claiming. */
          : <p>{t("kept")}</p>}

        {deleting
          ? (
            <div className="wall-erase">
              <AccountSection />
              <Button onClick={() => setDeleting(false)}>{t("back")}</Button>
            </div>
          )
          : check === "checking"
          ? (
            /* While the answer is in flight nothing else is true to offer; the way out stays. */
            <>
              <div className="wall-check" role="status" aria-busy="true">
                <Spinner className="mbx-spin" />
                <span>{t("checking")}</span>
              </div>
              <div className="gate-actions">
                <Button onClick={doSignOut} disabled={signingOut}>{t("signOut")}</Button>
              </div>
            </>
          )
          : (
            <>
              {/* THE ACTIONS ARE THE PAGE'S ONLY EMPHASIS, one column, in the order a person
                  meets them: the way back first, the way out second, the end third. Each says
                  what it does underneath, because two of the three cannot be undone by pressing
                  again. */}
              <div className="wall-actions">
                {check === "pending"
                  ? (
                    <>
                      <p className="wall-note" role="status">{t("pending")}</p>
                      <Button className="wall-act" onClick={checkAgain}>{t("checkAgain")}</Button>
                    </>
                  )
                  : null}
                {/* Rendered ONLY where the service operates a page: `manageUrl` is that fact and
                    nothing more. The address itself is minted by the press. */}
                {facts.manageUrl
                  ? (
                    <>
                      <Button
                        variant="primary"
                        className="wall-act"
                        data-run={minting ? "working" : undefined}
                        aria-busy={minting || undefined}
                        onClick={() => { void doMint(); }}
                      >
                        {/* "Subscribe" is the verb for a closure the customer can undo by paying.
                            A staff hold is not one — the account may be fully paid — so it gets
                            the neutral door the desktop window already uses. */}
                        {lifecycle === undefined
                          ? t("manage")
                          : held ? t("openAccount") : t("subscribe")}
                      </Button>
                      {mintRefusal !== null
                        ? (
                          <p className="wall-warn" role="alert">
                            {t(mintRefusal === "unverified" ? "mintUnverified" : "mintFailed")}
                          </p>
                        )
                        : null}
                      {lifecycle !== undefined && !held ? <p className="wall-hint">{t("subscribeHint")}</p> : null}
                    </>
                  )
                  : null}
                {/* The export door, only where this server serves one. It downloads the rules,
                    the Screener's decisions and the settings — the document a self-hosted
                    install reads when it joins the mailbox. No mail: the mailbox has it. */}
                {facts.exportPath
                  ? (
                    <>
                      <Button
                        className="wall-act"
                        onClick={() => { void doExport(); }}
                        disabled={exporting}
                      >
                        {t("moveOut")}
                      </Button>
                      <p className="wall-hint">
                        {t("moveOutHint")}{" "}
                        <a href={SELF_HOST_GUIDE} target="_blank" rel="noopener noreferrer">
                          {t("moveOutGuide")}
                        </a>
                      </p>
                      {exportFailed ? <p className="wall-warn" role="alert">{t("moveOutFailed")}</p> : null}
                    </>
                  )
                  : null}
                <Button variant="ghost" className="wall-act" onClick={() => setDeleting(true)}>
                  {t("deleteNow")}
                </Button>
                <p className="wall-hint">{t(datedErasure ? "deleteHint" : "deleteHintUndated")}</p>
              </div>
              <div className="gate-actions">
                <Button onClick={doSignOut} disabled={signingOut}>
                  {t("signOut")}
                </Button>
              </div>
            </>
          )}
      </div>
    </main>
  );
}

/** Where the self-host guide lives — the same address the download page links to. */
const SELF_HOST_GUIDE = "https://github.com/trafficflowhq/ohmail/blob/main/docs/self-host/README.md";
