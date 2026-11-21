"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { useTranslations } from "next-intl";
import { Spinner } from "@ohmail/ui";
import type { MailboxFacts } from "@ohmail/app-logic/mail-state/mail-state";
import { toMailboxFacts } from "./mailbox-facts";
import { buildToken } from "@ohmail/app-logic/doors/app-update";
import { startBuildWatch } from "@ohmail/app-logic/doors/build-watch";
import { mirrorOwnerOf, reviveStandingDown } from "@ohmail/app-logic/session/sync-scheduler";
import { isCalendarFragment } from "@ohmail/app/frame";
import { MailFrame, useBrowserMail } from "../../shell/browser-mail";
import { EngineProvider, useEngine, useResolvedDemoMode, useResolvedDemoModeFrom } from "../../shell/engine";
import { DemoFrame, DemoShell } from "../demo/DemoShell";
import { sendSurfaceFor } from "./send-surface";
import { useWebFeatureCards } from "./web-feature-cards";
import { WEB_MAIL_PARTS } from "./mail-parts";
import { useWebHost, webRecover, type WebWords } from "./web-supplies";
import { discardLegacyDeviceSignIn } from "./device-sign-in";
import {
  apiConfigured, apiOwnerBinding, apiOwnerHolds, bindApiOwner, boundApiOwner, mailboxes as mailboxApi, onAccessRefused, pendApiOwner,
  type AccessRefusedFacts,
} from "../../api-client";
import { readOwner } from "@ohmail/app-logic/storage/owner-cookie";
import { resolveOwnerOutcome } from "../session-outcome";
import { SELF_HOST_BUILD } from "../../hello";
import { WallRoute } from "./WallRoute";
import { ErasedRoute } from "./ErasedRoute";
import { useErasedWall, watchErasedElsewhere } from "../../erased-door";
import { useRevokedHere } from "../../revoked-door";
import { AccountLocale } from "./AccountLocale";
import { useCloudStorage } from "./storage-change";
import { DevicesSection } from "./DevicesSection";
import { useServerWords } from "../../server-words";
import { useUserInvites } from "./InvitesSection";
import { useManageOffer } from "./SubscriptionSection";
import { beginOAuthReturn, noJoinLanding, oauthLandsInJoin, subscribeOAuthOutcome } from "./oauth-return";
import { useCloudFirstRun } from "./useCloudFirstRun";
import { useFirstPaintGate } from "./useFirstPaintGate";
import { useSignedOutElsewhere } from "./useSignedOutElsewhere";
import { AccountCleanupContext, AccountCleanupGate, type AccountCleanup } from "./AccountCleanupGate";

/**
 * The Microsoft consent return, at module scope — before the router, before
 * the first render. Not an effect: the ceremony must be finished on any
 * page load that carries its parameters, including ones the shell routes
 * somewhere else entirely — the production failure `oauth-return.ts`
 * documents, where a dropped URL fragment put the browser on the Ohbox and
 * the `POST …/complete` in a pane's mount effect was never called. This is
 * the earliest client code on this route: idempotent, a no-op on every
 * non-return load, guarded for the server render inside.
 */
/*
 * The boundary closes before the ceremony completes, not after. `beginOAuthReturn()` runs at module
 * scope — before any render, so before the render-time `pendApiOwner` — and it used to send the
 * completion while the client was still `public`: a consent return for A loading while the jar had
 * become B sent the completion under B's session; the server consumed A's single-use ceremony and
 * only then rejected the mismatch — no mailbox attached, A's ceremony destroyed, nothing on screen
 * saying why. So the pend happens first, on the same synchronous line: `readOwner()` is a cookie
 * read with no side effects, safe at module scope.
 */
pendApiOwner(readOwner());
beginOAuthReturn();

/** What the demo says of itself when `?demo=1` boots through this page: this build's service and send ceiling. */
/** The staged attachment ceiling supported by this deployment. */
export const SEND_SURFACE = sendSurfaceFor(SELF_HOST_BUILD, process.env.NEXT_PUBLIC_STAGING_ORIGIN);

const DEMO_SAYS = {
  service: SELF_HOST_BUILD ? "self" : "managed",
  sendCeiling: SEND_SURFACE === undefined ? "strict" : SEND_SURFACE === null ? "mailbox" : SEND_SURFACE,
} as const;

/** Only the mail frame uses the address returned alongside its normal session check. */
const resolveMailOwner = () => resolveOwnerOutcome({ includeAddress: true });

/** The account this tab is for, confirmed or pending: the doors' when the jar names nobody. */
function tabAccount(): string | null {
  const b = apiOwnerBinding();
  return b.kind === "bound" || b.kind === "pending" ? b.owner : null;
}

/** Check the confirmed account and current session even after the new catalogue has loaded. */
function localeOwnerHolds(owner: string): boolean {
  return boundApiOwner() === owner && apiOwnerHolds("/consent/settings");
}

/**
 * The Cloud client's seam. `AppShell` is shared with `apps/desktop`, whose build does not bundle this
 * app's session client, so the shell takes "ask the API who is signed in" as a function and this file
 * supplies it. The shell needs an account id because the mirror persists: one shared database once let
 * the second person on a machine inherit the first's cursor and mail — the database is now named for the
 * account, and the id must be SERVER-verified (`middleware.ts` proves a session exists, not whose). Only
 * `scope === "full"` counts: an enrollment-scoped session may not open a mailbox. A failure to ask is not
 * an answer: `session-outcome.ts` classifies into three, `EngineProvider` retries the middle one, and
 * only an ANSWERED refusal reaches the signed-out screen (`AUTH-FLICKER-DIAGNOSIS.md`).
 */
export function CloudShell({ demo, drawMail, settingsAccount }: {
  demo: boolean;
  /**
   * The page's word for the first frame: `page.tsx`, the one mount, always passes it (`now` only after the edge's probe
   * named a full session). Absent is the warm open as before, for the harnesses that mount this shell directly.
   */
  drawMail?: "now" | "wait";
  settingsAccount?: string;
}) {
  /**
   * WHAT THE EFFECTS BELOW ASK, as opposed to what the shell RENDERS.
   *
   * `demo` is the SERVER's word, and a prerendered `?demo=1` page bakes `searchParams = {}` —
   * so it is false here for the life of the mount, not for one render: the capability hooks
   * called `/hello` and `GET /account/ai` from a fixtures world and no corrected value ever
   * arrived. Every gate that ISSUES something reads this; `demo` keeps everything DRAWN, which
   * is what stops the hydration mismatch `useDemoMode` exists to prevent.
   */
  const resolvedDemo = useResolvedDemoModeFrom(demo);
  useEffect(() => {
    if (!resolvedDemo) discardLegacyDeviceSignIn();
  }, [resolvedDemo]);
  /** A Microsoft sign-in started in `/join` finishes here behind the gate, then goes back there. */
  const joinWait = useSyncExternalStore(subscribeOAuthOutcome, oauthLandsInJoin, noJoinLanding);
  /** Another tab of this browser signed out: the shell goes in the same task and the tab leaves. */
  const { gone: signedOutHere, accountChanged, confirmed: listenFor } = useSignedOutElsewhere(resolvedDemo, resolveOwnerOutcome);
  /** This tab's session was revoked from another device: the mail goes, no scrim, and the copy with it. */
  const revokedHere = useRevokedHere(resolvedDemo, tabAccount);
  const [accountCleanup, showAccountCleanup] = useState<AccountCleanup | null>(null);
  /** The server-confirmed account, for the Help & contact pane's diagnostics block. */
  const [account, setAccount] = useState<{ id: string; address: string | null } | null>(null);
  const onConfirmed = useCallback((accountId: string, address?: string, familyId?: string) => {
    // A sign-out pending on this jar: the tab is leaving, and nothing is bound for this answer.
    if (!listenFor(accountId, familyId)) return;
    bindApiOwner(accountId, familyId);
    setAccount({ id: accountId, address: address ?? null });
  }, [listenFor]);
  /**
   * Is this tab still the app this origin serves? A browser client is downloaded once and left
   * running, and nothing tells open tabs about a deployment. The watch asks `/version` occasionally
   * and raises the quiet strip — at most once a day per build. Armed here, not in `AppShell`: the
   * shared shell is also the desktop window, which reaches no network and updates from a signed
   * release feed. Not on the demo: a bar about a newer ohmail over invented mail is a sentence
   * about the wrong thing. The token is computed from constants `next.config.mjs` inlined into THIS
   * bundle, so it names the running build by construction.
   */
  useEffect(() => {
    if (resolvedDemo) return;
    return startBuildWatch({
      token: buildToken(process.env.NEXT_PUBLIC_APP_VERSION, process.env.NEXT_PUBLIC_BUILD),
    });
  }, [resolvedDemo]);

  /**
   * Does this deployment invite users? Two gates in one hook: the COMPILED flavor (the
   * managed bundle's branch is a constant `false` — no `/hello` round trip is even paid) and
   * the server's own `features.pairing` word. The pane node is built only when both hold, so
   * on managed the Settings nav structurally cannot grow an Invites entry.
   */
  /**
   * Has the service refused this account? Subscribed once, for the whole
   * client: any door may answer `402 subscription_required`, and an access
   * read may answer `refused`, so it is raised here rather than at two
   * hundred call sites and the whole surface swaps for the lock screen —
   * mail beside a refusal is the state this prevents. It is cleared by ONE
   * thing: the wall's own fresh read answering `access: "open"`. A
   * door's incidental 200 is not evidence the refusal was lifted and
   * clears nothing. Not on the demo: no server, no account to refuse.
   */
  const [refused, setRefused] = useState<AccessRefusedFacts | null>(null);
  useEffect(() => {
    if (resolvedDemo) return;
    return onAccessRefused((facts) => setRefused((held) => held ?? facts));
  }, [resolvedDemo]);
  const firstPaint = useFirstPaintGate(demo, resolvedDemo, (facts) => setRefused((held) => held ?? facts));
  /**
   * The lift: the shell mounts again and the drain loop picks up from its stored cursors. The
   * remount's boot reconcile re-announces the push registration, once; a call here would be a second.
   */
  const lift = useCallback(() => {
    setRefused(null);
    reviveStandingDown();
  }, []);

  /**
   * HAS THIS ACCOUNT BEEN ERASED ELSEWHERE? The erased door (`erased-door.ts`, registered by every
   * product page) latches on the server's `410 account_erased` and drops this browser's copy; the
   * wall outranks the 402 lock — a deleted account has nothing left to pay for. Every other tab
   * hears it through the door's cross-tab word. Not on the demo: no account to erase.
   */
  const erased = useErasedWall();
  useEffect(() => {
    if (resolvedDemo) return;
    return watchErasedElsewhere(tabAccount);
  }, [resolvedDemo]);

  const userInvites = useUserInvites(resolvedDemo);

  /**
   * DOES THIS DEPLOYMENT OPERATE A SUBSCRIPTION PAGE — `false` on every install that has nowhere.
   *
   * The same absence rule as `userInvites` and `devicePairing`: a node is built only when there is
   * known to be a place, so a self-hosted or unmetered deployment structurally cannot grow a
   * Subscription entry rather than growing one that opens an empty pane. The ADDRESS is not read
   * here and not at mount at all — the pane mints it when somebody presses; see
   * {@link useManageOffer}.
   */
  const { manageOffered, withdrawManage } = useManageOffer(resolvedDemo);
  /** Settings → Storage exists where the access answer carries a storage block (a metered cap). */
  const storageOffered = useCloudStorage() !== null;

  /**
   * Does this server pair devices? ONE gate, the server's runtime `features.pairing` word —
   * no compiled flavor arm, because BOTH flavors mount the device-pair ceremony (the managed
   * table and the self-host table each spread the same `pairRoutes`; see `routes/index.ts`).
   * `false` while `/hello` is pending or on an older server: no nav entry, never a dead pane.
   * The DEMO flag rides in and settles the question first: a fixtures world pays no `/hello`
   * round trip and grows no pane whose every verb mutates real credentials — the hook's own
   * header carries the measured leak this closed.
   */
  const server = useServerWords(resolvedDemo);
  const devicePairing = server.pairing;

  /**
   * The first-run flow's door — the same seam as the panes below, one layer up. `AppShell` renders
   * the setup stage and may not call `POST /mailboxes/probe`, `POST /mailboxes`, `POST
   * /mailboxes/:id/organize` or `PATCH /consent/settings` itself. `undefined` on the demo, which
   * withholds the stage structurally rather than rendering one whose buttons refuse. The pairing
   * panel rides along wherever this server pairs — the same `features.pairing` gate the Devices
   * pane is built on, so setup's last step exists exactly where the surface it links to does.
   */
  const firstRun = useCloudFirstRun(resolvedDemo, devicePairing ? <DevicesSection /> : undefined);

  /**
   * The shell's confirm — now nothing but a pass-through to the shared classifier. It used to hold
   * the predicate itself: `} catch { return null; }`, with the conflation stated as design. `null`
   * was also what an enrollment-scoped session returned, so a `503 db_busy` and a revoked family
   * got the same "You are signed out." over a cookie that answered `200 scope=full` a moment later
   * (measured in production). `session-outcome.ts` is the predicate now, shared with `/login` so
   * the two screens cannot answer differently — which they demonstrably did. Not wrapped in
   * `useCallback`: an imported function already has a stable identity, which is all
   * `EngineProvider`'s effect needs.
   */
  const resolveOwner = useCallback(async () => {
    const outcome = await resolveMailOwner();
    if (settingsAccount && outcome.kind === "owner" && outcome.accountId !== settingsAccount) {
      return { kind: "none" } as const;
    }
    return outcome;
  }, [settingsAccount]);

  /**
   * A named shell is never a public surface. The account boundary's one nullable state meant both "no
   * account here" and "account here, server not answered yet", and let the second through: a deep-linked
   * settings pane over a warm mirror for A issues requests while the confirm is in flight, another tab
   * establishes B, and Security, Devices, Billing and Mailboxes read or change B — with a step-up window
   * open. So the moment a Cloud shell exists the client stops being public: `readOwner()` is the same
   * synchronous read that names the mirror; a cold load pends `null`, still failing closed. DURING
   * RENDER, not an effect: React runs a child's effects before its parent's, so a pane's first request
   * would beat an effect here. `pendApiOwner` never widens — idempotent under StrictMode.
   */
  pendApiOwner(readOwner());

  /**
   * What state are this account's mailboxes in? Same seam, same reason: `GET /mailboxes` is the
   * only surface that knows, and `app/shell/**` may not call it. It DELIBERATELY does not catch:
   * `resolveOwner` maps every failure to `null` because that question has one safe answer; here the
   * outcomes are not interchangeable — an empty array means "no mailboxes", and a 503 mapped to
   * `[]` would put "No mailbox connected" on the screen of somebody with five. A failure propagates
   * and `MailStateProvider` keeps the last thing it knew. Narrowed to `MailboxFacts` at the seam,
   * so the ladder may only consult the fields it names — enforceable rather than aspirational.
   */
  const mailboxFacts = useCallback(async (): Promise<MailboxFacts[]> => {
    const { items } = await mailboxApi.list();
    // The narrowing itself is `toMailboxFacts`, in its own module and tested directly. It used to
    // be inline here, which is what kept its absent-field defaults — including the one that
    // decides whether a claim banner appears at all — out of reach of every test in this app.
    return items.map(toMailboxFacts);
  }, []);

  // After every hook: the tab is leaving, and nothing of the mailbox may paint again.
  if (accountChanged) return <AccountChangedGate />;
  if (signedOutHere && accountCleanup) return <AccountCleanupGate cleanup={accountCleanup} />;
  if (signedOutHere || revokedHere) return <div className="gate" aria-busy="true" />;
  if (joinWait) return <WaitGate />;

  // The payment and erasure answers replace the mail frame entirely. The locale decorator has the same
  // account stamp as the frame, so a pending language choice cannot outlive that account's session.
  if (erased) {
    return (
      <AccountLocale owner={account?.id ?? null} ownerHolds={localeOwnerHolds}>
        <ErasedRoute blocked={(erased.remaining ?? []).some((n) => n.startsWith("ohmail-mirror"))} />
      </AccountLocale>
    );
  }
  if (refused) {
    return (
      <AccountLocale owner={account?.id ?? null} ownerHolds={localeOwnerHolds}>
        <WallRoute facts={refused} onLifted={lift} />
      </AccountLocale>
    );
  }

  /* The server's frame and the client's first are the gate the shell has always opened with,
     empty but for the late Reload; the verdict is asked only after hydration, behind the wordmark. */
  if (firstPaint === "hydrating") return <FirstFrame />;
  if (firstPaint === "asking") return <WaitGate />;

  /* THE DEMO, booted by `?demo=1`: the invented world's host, never the hosted wires (`demo/host.ts`). */
  if (resolvedDemo) return <DemoShell serverDemo={demo} says={DEMO_SAYS} />;

  const words: WebWords = {
    server, invites: userInvites, subscriptionPage: manageOffered, withdrawManage, storageBlock: storageOffered,
    account: account?.id ?? null, accountAddress: account?.address ?? null, firstRun, mailboxFacts, resolve: resolveOwner, confirmed: onConfirmed,
  };
  return (
    <EngineProvider
      demo={demo}
      resolveOwner={resolveOwner}
      onConfirmed={onConfirmed}
      drawMail={settingsAccount ? "confirmed" : drawMail}
    >
      <AccountCleanupContext.Provider value={showAccountCleanup}>
        <WebFrame words={words} />
      </AccountCleanupContext.Provider>
    </EngineProvider>
  );
}

/**
 * THE WEB'S FRAME, inside its engine: the host built from what the page learned, and the mail's places in it over
 * the mail ground. Where the engine it stands on is the demo's (the mode changed after mount), the demo's host, so
 * no hosted wire ever reaches the invented world.
 */
function WebFrame({ words }: { words: WebWords }) {
  const demoNow = useResolvedDemoMode();
  const scope = mirrorOwnerOf(useEngine());
  if (demoNow) return <DemoFrame says={DEMO_SAYS} />;
  return (
    <AccountLocale owner={scope === words.account ? scope : null} ownerHolds={localeOwnerHolds}>
      <SignedInFrame words={words} />
    </AccountLocale>
  );
}

function SignedInFrame({ words }: { words: WebWords }) {
  const engine = useEngine();
  /* What every browser host hands the frame for mail: the places, the stages and the ground, over this page's own
     parts, the look of the theme it stands under and its two ways back. */
  const frame = useBrowserMail(webRecover, WEB_MAIL_PARTS);
  const host = useCloudMailHost(engine, words, frame);
  const { account } = host.session;
  const scope = mirrorOwnerOf(engine);
  useEffect(() => {
    if (scope === null || scope !== account || !apiConfigured()) return;
    // The adapter and API client put these background reads through the same startup lane.
    void engine.readStoreCoverage();
    engine.waitingOnOrganizer();
  }, [engine, account, scope]);
  // Keep an incoming Calendar link while the handshake and this mirror's sign-in are being confirmed.
  if (isCalendarFragment(frame.address.read()) &&
      (words.server.calendar === null || (words.server.calendar === true && words.account === null))) return <WaitGate />;
  return <MailFrame host={host} />;
}

const noSubscription = () => () => {};

function AccountChangedGate() {
  const t = useTranslations("frame.connection.signedOut");
  return <div className="gate" role="status">{t("title")}</div>;
}

/**
 * The server's frame and the client's first. A page whose script never runs (a chunk a changing
 * network dropped) stays on it, so the server's copy carries a Reload, which needs no script;
 * `.gate-late` holds it back for the first seconds. Hydration reads the server's snapshot, so the
 * line hydrates as drawn; a client render (and the next one) leaves it out.
 */
function FirstFrame() {
  const t = useTranslations("session");
  const ta = useTranslations("appError");
  const served = useSyncExternalStore(noSubscription, () => false, () => true);
  return (
    <div className="gate" aria-busy="true" aria-live="polite">
      {served ? <p className="gate-late">{t("opening")} <a href="/">{ta("reload")}</a></p> : null}
    </div>
  );
}

/** The card a browser waits behind before anything of the account paints. */
function WaitGate() {
  return (
    <main className="gate" aria-busy="true">
      <div className="gate-card">
        <span className="wordmark"><b><em>oh</em>mail</b></span>
        <Spinner className="mbx-spin" />
      </div>
    </main>
  );
}

export function useCloudMailHost(
  engine: Parameters<typeof useWebHost>[0],
  words: WebWords,
  frame: Parameters<typeof useWebHost>[2],
) {
  const cards = useWebFeatureCards(words.subscriptionPage, words.withdrawManage);
  return useWebHost(engine, words, frame, cards, SEND_SURFACE);
}
