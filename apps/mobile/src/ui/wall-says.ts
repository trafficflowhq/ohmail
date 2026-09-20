/**
 * WHAT THE WALL SAYS, as data — every decision the closed-account screen makes, in one pure
 * function the suite drives. There is no React Native renderer in this workspace
 * (`test/mail-row-badges-spoken.test.ts` states the rule), so a screen that decided anything in
 * its own JSX would measure nothing; `AccountWall.tsx` renders this list and chooses nothing.
 *
 * The sentences are the browser wall's, in the same order, because one account must not read two
 * different accounts of itself on two devices. What differs is the LAST step of each action: a
 * phone opens the account page in the system browser and never inside itself.
 */

import { Copy } from "../copy";
import type { AccessRefusedFacts, AccountLifecycle } from "../net/access-lock";
import { linksOutToBilling, type Distribution } from "../distribution";

/** A line of the wall, in the order it is read. `date` is the server's, never this phone's clock. */
export type WallLine = { key: WallLineKey; date?: string };

export type WallLineKey =
  /* the headline */
  | "wallTitle" | "wallSuspendedTitle" | "wallTrialEnded" | "wallCanceled" | "wallUnpaid"
  /* the body */
  | "wallStopped" | "wallMailboxUntouched" | "wallKept"
  /* the erasure sentence, or none at all */
  | "wallErasure" | "wallErasureHeld" | "wallErasureUnknown"
  /* the sentence that stands in for the withheld buttons on a store build */
  | "wallOpenInBrowser";

/**
 * What a press does. `manage` and `delete` leave for the system browser; `export` runs here.
 * `servers` is the way out of the screen — a lock with no way out is a trap.
 */
export type WallAction =
  | { id: "manage"; label: string; url: string }
  | { id: "export"; label: string; hint: string; path: string }
  | { id: "delete"; label: string; hint: string; url: string }
  | { id: "servers"; label: string };

export interface WallSays {
  headline: WallLine;
  /** The two or one sentences under it. */
  body: WallLine[];
  /** The erasure sentence, or `null` — an ERASED account is told nothing about an erasure. */
  erasure: WallLine | null;
  /**
   * The sentence that REPLACES the outbound buttons on a store build, or `null`. Never both: a
   * screen that says "open it in a browser" beside a button that opens it is telling somebody to
   * do by hand what the control in front of them does.
   */
  openElsewhere: "wallOpenInBrowser" | null;
  actions: WallAction[];
}

/** What the headline says, and the date it carries. The browser wall's rule, mirrored. */
function headlineOf(lifecycle: AccountLifecycle | undefined, suspended: boolean): WallLine {
  const plain: WallLine = { key: suspended ? "wallSuspendedTitle" : "wallTitle" };
  /* ERASED IS NOT A SCREEN: erasure takes the users, the sessions and the credentials, so nobody
     signs in to read an "erased on" sentence. If the word ever reaches this build it falls to the
     undated title rather than to a date about a deletion. */
  if (lifecycle === undefined || lifecycle.state !== "closed") return plain;
  if (lifecycle.closedReason === "suspended") return { key: "wallSuspendedTitle" };
  const date = lifecycle.closedAt;
  /* A dated sentence needs a date. Without one the honest thing is the sentence that has never
     claimed one — inventing "today" would be a fact about this phone's clock. */
  if (date === null || date === undefined) return plain;
  if (lifecycle.closedReason === "trial_ended") return { key: "wallTrialEnded", date };
  if (lifecycle.closedReason === "canceled") return { key: "wallCanceled", date };
  if (lifecycle.closedReason === "unpaid") return { key: "wallUnpaid", date };
  return plain;
}

/**
 * The whole screen, decided.
 *
 * `distribution` is a parameter with the build's own literal as its default, so a case can drive
 * both faces without a bundler — and so the STORE face, which is the one a review reads, is
 * exercised by name rather than by whatever the test runner's environment happens to hold.
 */
export function wallSays(
  facts: AccessRefusedFacts,
  distribution?: Distribution,
): WallSays {
  const lifecycle = facts.lifecycle;
  const suspended = facts.reason === "suspended";
  /* An operator hold is not a departure, so it has no erasure clock (ruling §1(a)) and it is not
     a closure the person can undo by paying — the account may be fully paid. */
  const held = lifecycle !== undefined && lifecycle.closedReason === "suspended";
  const mayLinkOut = distribution === undefined
    ? linksOutToBilling()
    : linksOutToBilling(distribution);

  const body: WallLine[] = lifecycle === undefined
    /* A server that predates the wall says nothing about when or why, so this screen says what it
       has always said. Not a fallback that guesses — one that stops claiming. */
    ? [{ key: "wallKept" }]
    : [{ key: "wallStopped" }, { key: "wallMailboxUntouched" }];

  let erasure: WallLine | null = null;
  if (lifecycle !== undefined && lifecycle.state !== "erased") {
    /* SAID ONLY WHERE THERE IS SOMETHING TRUE TO SAY. An erased account gets no erasure sentence
       at all: "nothing has been erased" would be false, and the dated one is about a deletion
       that has happened. That state is unreachable — erasure takes the sessions with it — and a
       false claim in an unreachable state is still a false claim. */
    erasure = held
      ? { key: "wallErasureHeld" }
      : lifecycle.erasureAt
        ? { key: "wallErasure", date: lifecycle.erasureAt }
        : { key: "wallErasureUnknown" };
  }

  const actions: WallAction[] = [];
  /* THE WAY BACK, and only where the service supplied an address — this app holds no plan, no
     balance and no page of its own to send anybody to. A button that goes nowhere is worse than
     no button: it is the one control on this screen somebody will press. */
  if (facts.manageUrl && mayLinkOut) {
    actions.push({
      id: "manage",
      label: lifecycle === undefined
        ? Copy.wallManage
        : held ? Copy.wallOpenAccount : Copy.wallSubscribe,
      url: facts.manageUrl,
    });
  }
  /* THE WAY OUT, on BOTH faces: it opens no page and buys nothing. It hands over the rules, the
     Screener's decisions and the settings — the document a self-hosted install reads when it
     takes this mailbox over. No mail: the mailbox has it. */
  if (facts.exportPath) {
    actions.push({
      id: "export",
      label: Copy.wallMoveOut,
      hint: Copy.wallMoveOutHint,
      path: facts.exportPath,
    });
  }
  /* THE END, and it leaves for the browser BY MEASUREMENT rather than by preference: `DELETE
     /account` is `stepUp: true` and a paired phone's bearer is minted `twofaAt: null` — "NULL
     fails step-up closed, so pairing cannot beget pairing" (`session-lifecycle.ts`). A press here
     would be a permanent 403, and a control that can only refuse is worse than a sentence saying
     where the deletion happens. */
  if (facts.manageUrl && mayLinkOut) {
    actions.push({
      id: "delete",
      label: Copy.wallDeleteNow,
      hint: Copy.wallDeleteElsewhere,
      url: facts.manageUrl,
    });
  }
  /* The way off the screen. Servers holds disconnect and forget, and this wall replaces the tabs
     those used to be reachable behind. */
  actions.push({ id: "servers", label: Copy.serversTitle });

  return {
    headline: headlineOf(lifecycle, suspended),
    body,
    erasure,
    /* Said ONLY where a button was withheld: a store build with no `manageUrl` at all has nothing
       to point anybody at, and "open it in a browser" would name a page this server never gave. */
    openElsewhere: !mayLinkOut && facts.manageUrl ? "wallOpenInBrowser" : null,
    actions,
  };
}

/** Every line key this module can answer — the census's subject. Order is the reading order. */
export const WALL_LINE_KEYS: readonly WallLineKey[] = [
  "wallTitle", "wallSuspendedTitle", "wallTrialEnded", "wallCanceled", "wallUnpaid",
  "wallStopped", "wallMailboxUntouched", "wallKept",
  "wallErasure", "wallErasureHeld", "wallErasureUnknown",
  "wallOpenInBrowser",
];
