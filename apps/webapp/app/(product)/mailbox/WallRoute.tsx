"use client";

/**
 * The wall as the web serves it, in place of the mail: the wall's page over its ceremony (`use-wall-door.ts`), its facts
 * the ones the gate's 402 carried. The account page is minted at the press; deleting now leaves for `/account/delete`,
 * the page of its own; the password change stays on this route.
 */
import { useTranslations } from "next-intl";
import { Button, Page, Sentence } from "@ohmail/ui/base";
import { WallPage, type WallDoor, type WallHeadline, type WallState, type WallStanding } from "@ohmail/app/doors/wall";
import type { AccessRefusedFacts } from "../../api-client";
import { dayStamp } from "../../shell/format";
import { WebDoor } from "../door-device";
import { PasswordSection } from "./PasswordSection";
import { useWallDoor, type WallCeremony } from "./use-wall-door";

/** Where the self-host guide lives — the same address the download page links to. */
const SELF_HOST_GUIDE = "https://github.com/trafficflowhq/ohmail/blob/main/docs/self-host/README.md";

/** The headline, its date as a reader says it; the dated sentences always carry one (`headlineOf`). */
function headlineOf(headline: WallCeremony["headline"]): WallHeadline {
  switch (headline.key) {
    case "trialEnded":
    case "canceled":
    case "unpaid":
      return { key: headline.key, date: dayStamp(headline.date) };
    default:
      return { key: headline.key };
  }
}

/** What the wall says under its headline, from the lifecycle the gate carried. */
function standingOf(c: WallCeremony): WallStanding {
  if (c.fresh) return { kind: "fresh" };
  /* A server that predates the wall says nothing about when or why: not a fallback that guesses, one that stops claiming. */
  if (c.lifecycle === undefined) return { kind: "kept" };
  /* An erased account has no erasure sentence at all: "nothing has been erased" would be false. */
  if (c.lifecycle.state === "erased") return { kind: "stopped", erasure: { kind: "none" } };
  if (c.held) return { kind: "stopped", erasure: { kind: "held" } };
  if (c.erasureAt !== null) return { kind: "stopped", erasure: { kind: "dated", date: dayStamp(c.erasureAt) } };
  return { kind: "stopped", erasure: { kind: "unknown" } };
}

function stateOf(c: WallCeremony, facts: AccessRefusedFacts, signOutSaid: string | null): WallState {
  return {
    at: "refused",
    headline: headlineOf(c.headline),
    standing: standingOf(c),
    check: c.check,
    /* Only where the service operates a page: `manageUrl` is that fact and nothing more. "Subscribe" is the verb for a
       closure the customer can undo by paying; a staff hold is not one, so it gets the neutral door. */
    wayBack: facts.manageUrl
      ? {
          label: c.lifecycle === undefined ? "manage" : c.held ? "openAccount" : c.fresh ? "startTrial" : "subscribe",
          hint: c.lifecycle !== undefined && !c.held ? (c.fresh ? "startTrialHint" : "subscribeHint") : null,
          minting: c.minting,
          refusal: c.mintRefusal === "unverified" ? "mintUnverified" : c.mintRefusal === "failed" ? "mintFailed" : null,
        }
      : null,
    /* Only where this server serves one; an account that never started has nothing to take along. */
    moveOut: facts.exportPath && !c.fresh ? { exporting: c.exporting, failed: c.exportFailed } : null,
    deleteHint: c.fresh ? "deleteHintNeverStarted" : c.datedErasure ? "deleteHint" : "deleteHintUndated",
    signingOut: c.signingOut,
    signOutSaid,
  };
}

export function WallRoute({ facts, onLifted }: { facts: AccessRefusedFacts; onLifted?: () => void }) {
  const c = useWallDoor({ facts, onLifted });
  const t = useTranslations("accessLock");
  const ta = useTranslations("account");
  /* The password change, in place, as Settings draws it: a refused subscription must not keep a person from taking
     back a password somebody else knows. */
  if (c.changingPassword) {
    return (
      <WebDoor>
        <Page
          material={<PasswordSection />}
          acts={<Button kind="quiet" onPress={() => c.setChangingPassword(false)}>{t("back")}</Button>}
        >
          <Sentence size="xl" end="hot">{t("changePassword")}</Sentence>
        </Page>
      </WebDoor>
    );
  }
  const said = c.signOutSaid === null
    ? null
    : c.signOutSaid.key === "signOutServerRefused"
      ? ta(c.signOutSaid.cleanupIncomplete ? "signOutServerRefusedUnverified" : c.signOutSaid.key, { reason: c.signOutSaid.reason })
      : ta(c.signOutSaid.key);
  const door: WallDoor = {
    state: stateOf(c, facts, said),
    wayBack: () => { void c.doMint(); },
    checkAgain: c.checkAgain,
    moveOut: () => { void c.doExport(); },
    guide: () => { window.open(SELF_HOST_GUIDE, "_blank", "noopener,noreferrer"); },
    deleteNow: () => { window.location.assign("/account/delete"); },
    signOut: () => { void c.doSignOut(); },
    changePassword: () => c.setChangingPassword(true),
    home: () => { window.location.assign("/"); },
  };
  return (
    <WebDoor>
      <WallPage door={door} />
    </WebDoor>
  );
}
