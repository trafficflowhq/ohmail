/**
 * THE LOCK SCREEN IN THE WINDOW — what an account the service has refused sees instead of its mail.
 *
 * The browser tab's `AccessLock.tsx`, mirrored and not imported (that file signs out through
 * `app/sign-out.ts`, aliased here to the refusing api-client stub): the same `accessLock` sentences,
 * this window's chrome and door. Two doors stay open, because a lock with no way out is a trap:
 * signing out, and the way back, which MINTS AT THE PRESS — the 402's `manageUrl` only says a page
 * exists — and draws the minted page as a link the person's own click opens (`useMintedPage`). It
 * lifts on the account's fresh `access: "open"` read (`useWallLift`) and on nothing else, and
 * deletes and wipes nothing itself.
 */

import { useCallback, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { ActivityLine, Button, Mark, Page, RefusalLine, Sentence } from "@ohmail/ui/base";

import {
  ACCOUNT_ACCESS_PATH, bridgeFetch, engineLogout,
  type AccessRefusedFacts, type AccountLifecycle, type EngineStatus, type SignedOut, type SignOutPress,
} from "./bridge-fetch.js";
import { useWallLift } from "@ohmail/app-logic/doors/wall-lift";
import { linksOutToBilling } from "./distribution.js";
import { AccountPageLink, MANAGE_LINK_PATH, useMintedPage } from "./DesktopSubscription.js";
import { dayStamp } from "../../webapp/app/shell/format.js";
import { DOOR_COPY } from "./door-copy.js";

/**
 * What the headline says, and the date it carries — the browser tab's rule, mirrored.
 *
 * ERASED IS NOT A SCREEN: erasure deletes the users, the sessions and the credentials, so nobody
 * signs in to read an "erased on" sentence. A closure with no date falls to the sentence that has
 * never claimed one rather than to a guess from this machine's clock.
 */
function headlineOf(
  lifecycle: AccountLifecycle | undefined,
  suspended: boolean,
): { key: "title" | "suspendedTitle" | "trialEnded" | "canceled" | "unpaid"; date?: string } {
  const plain = { key: (suspended ? "suspendedTitle" : "title") as "title" | "suspendedTitle" };
  if (lifecycle === undefined || lifecycle.state !== "closed") return plain;
  if (lifecycle.closedReason === "suspended") return { key: "suspendedTitle" };
  const date = lifecycle.closedAt;
  if (date === null || date === undefined) return plain;
  if (lifecycle.closedReason === "trial_ended") return { key: "trialEnded", date };
  if (lifecycle.closedReason === "canceled") return { key: "canceled", date };
  if (lifecycle.closedReason === "unpaid") return { key: "unpaid", date };
  return plain;
}

/** One fresh read of the account through the door: `true` only for its own `access: "open"`. */
async function accountOpens(): Promise<boolean> {
  const res = await bridgeFetch(ACCOUNT_ACCESS_PATH);
  if (!res.ok) return false;
  const body = (await res.json().catch(() => null)) as { metered?: unknown; access?: unknown } | null;
  return body?.metered === true && body.access === "open";
}

export function DesktopAccessLock(
  { facts, scope, press = null, onSignedOut, onLifted }: {
    facts: AccessRefusedFacts;
    /** The mailbox the gate mounts, or `null` while it names none: whose wall this is, and whose lift is recorded. */
    scope: string | null;
    /** The door and session the gate reads, so the sign-out can end that session at its server. */
    press?: SignOutPress | null;
    onSignedOut: (status: EngineStatus, stillListedFrom?: EngineStatus | null, waiting?: SignedOut["waiting"]) => void;
    onLifted?: () => void;
  },
) {
  const t = useTranslations("accessLock");
  const { check, armPoll, checkAgain } = useWallLift({ lifts: accountOpens, onLifted, scope, owner: null });
  const [signingOut, setSigningOut] = useState(false);
  /** The shell's reason when the last sign-out was refused, said under the button. */
  const [signOutRefused, setSignOutRefused] = useState<string | null>(null);
  const lang = useLocale() === "de" ? "de" : "en";
  const [minting, setMinting] = useState(false);
  const [mintRefusal, setMintRefusal] = useState<"failed" | "unverified" | null>(null);
  const page = useMintedPage();
  const showPage = page.show;

  const doMint = useCallback(async () => {
    if (minting) return;
    setMintRefusal(null);
    setMinting(true);
    try {
      const res = await bridgeFetch(MANAGE_LINK_PATH, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ lang }),
      });
      const body = (await res.json().catch(() => null)) as
        { url?: unknown; error?: { code?: unknown } } | null;
      if (res.ok && typeof body?.url === "string" && body.url.length > 0) {
        // Drawn, not opened: the person's own click on the drawn page is the open.
        if (showPage(body.url)) armPoll();
        else setMintRefusal("failed");
        return;
      }
      setMintRefusal(res.status === 403 && body?.error?.code === "email_unverified" ? "unverified" : "failed");
    } catch {
      setMintRefusal("failed");
    } finally {
      setMinting(false);
    }
  }, [armPoll, lang, minting, showPage]);

  const doSignOut = useCallback(async () => {
    if (signingOut) return;
    setSigningOut(true);
    setSignOutRefused(null);
    try {
      /* The gate hears the new engine state and leaves this screen; nothing here navigates. */
      const out = await engineLogout(press);
      onSignedOut(out.status, out.stillListedFrom, out.waiting);
    } catch (err) {
      /* A refusal leaves the session live and the button available again, and says so. */
      setSignOutRefused(err instanceof Error ? err.message : String(err));
      setSigningOut(false);
    }
  }, [onSignedOut, press, signingOut]);

  const lifecycle = facts.lifecycle;
  const headline = headlineOf(lifecycle, facts.reason === "suspended");
  const erasureAt = lifecycle?.erasureAt ?? null;
  const held = lifecycle !== undefined && lifecycle.closedReason === "suspended";
  /* THE STORE BUILD LINKS OUT TO NOTHING (App Review 3.1.1), so it loses the button and gains the
     one sentence that replaces it: where to go instead. A screen that simply dropped its only
     control would leave a person with nowhere, which is the trap this lock may never be. */
  const mayLinkOut = linksOutToBilling();
  const browserOnly = Boolean(facts.manageUrl) && !mayLinkOut;

  const title = headline.date !== undefined
    ? t(headline.key, { date: dayStamp(headline.date) })
    : t(headline.key);
  const line = lifecycle === undefined ? t("kept") : t("mailboxUntouched");
  const note = lifecycle === undefined ? undefined : held
    ? t("erasureHeld")
    : erasureAt !== null ? t("erasure", { date: dayStamp(erasureAt) }) : t("erasureUnknown");
  const mintSaid = mintRefusal === null ? null
    : t(mintRefusal === "unverified" ? "mintUnverified" : "mintFailed");

  const signOutSaid = signOutRefused === null ? null : DOOR_COPY.accessLockSignOutRefused(signOutRefused);

  const hasFeedback = browserOnly || check !== "idle" || mintSaid !== null || signOutSaid !== null;

  return (
    <div className="app-root oh-root">
      <Page
        trail={<Mark>ohmail</Mark>}
        line={line}
        note={note}
        afterLine={hasFeedback ? (
          <>
            {browserOnly ? <p className="oh-text">{t("openInBrowser")}</p> : null}
            {check === "checking" ? (
              <div role="status" aria-busy="true">
                <p className="oh-text">{t("checking")}</p>
                <ActivityLine />
              </div>
            ) : null}
            {check === "pending" ? <p className="oh-text" role="status">{t("pending")}</p> : null}
            {mintSaid === null ? null : <RefusalLine start alert>{mintSaid}</RefusalLine>}
            {signOutSaid === null ? null : <RefusalLine start alert>{signOutSaid}</RefusalLine>}
          </>
        ) : undefined}
        acts={
          <>
            {check === "pending" ? <Button kind="two" onPress={checkAgain}>{t("checkAgain")}</Button> : null}
            {facts.manageUrl && mayLinkOut && check !== "checking"
              ? page.href !== null
                ? <AccountPageLink href={page.href} label={t("openPage")} onFollow={page.followed} />
                : <Button busy={minting} onPress={() => void doMint()}>{lifecycle !== undefined ? t("openAccount") : t("manage")}</Button>
              : null}
            <Button kind="quiet" onPress={() => void doSignOut()} disabled={signingOut}>{t("signOut")}</Button>
          </>
        }
      >
        <Sentence level={1} size="xl">{title}</Sentence>
      </Page>
    </div>
  );
}
