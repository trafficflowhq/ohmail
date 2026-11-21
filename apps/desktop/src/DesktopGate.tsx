/**
 * WHAT THE WINDOW SHOWS, AND WHO DECIDES — the engine-bearing build's outermost component.
 * One question at boot ("shell, what is the engine doing?") routes the whole window: the door
 * chooser on a fresh install, an honest notice when an engine exists and something is wrong,
 * otherwise the mail client — the same `AppShell` the hosted client renders, plus one Settings
 * pane the web cannot have. "There is no shell at all" is NOT an error: the bundle is loaded
 * outside the app (dev server, render check), and it lands on the door chooser — two states,
 * not connected and connected, no third surface, no sample mailbox. When an engine is serving,
 * `AppShell` gets a real client engine over the bridge; {@link mailMount} is the pure decision.
 */

/*
 * A MAILTO CLICK ANYWHERE ON THIS COMPUTER LANDS HERE: the OS delivers it to the shell, which
 * holds the link until this window claims it (`native.ts`, take-once) — claimed on the shell's
 * poke and once at mount for the click that STARTED the app; the parsed fields (`mailto.ts`)
 * wait in state until the mail client is on screen, then seed the compose through `AppShell`'s
 * `mailtoDraft` seam. A click INSIDE the window takes the same path — `shell/open-external.ts`
 * used to cancel every non-http scheme, so a clicked address did nothing, silently. The native
 * chrome is wired here too (menu and badge — only this build has them; its notices are
 * `notice-emitter.ts`'s); the menu
 * drives `go()`, the same function the rail, palette and number keys call.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { OhmailEngine } from "@ohmail/client-engine";
import { Button, Spinner, useOptionalToast } from "@ohmail/ui";

import { createFeed, NONE, type HostConnectionState } from "@ohmail/app/host";
import { EngineProvider } from "../../webapp/app/shell/engine";
import { DesktopFrame } from "./DesktopFrame.js";
import { linkSlot } from "./link-in.js";
import { setStorageOwner, storageOwner } from "@ohmail/app-logic/storage/storage-owner";
import { setComposerScope } from "@ohmail/app-logic/writing/compose";
import { BootSkeleton } from "../../webapp/app/shell/BootSkeleton";
import { go, goFirstRun, goSettings, useHashRoute } from "../../webapp/app/shell/routing";
import { goCompose } from "@ohmail/app-logic/writing/compose-door";
import { setMailtoSink } from "@ohmail/app-logic/session/open-external";
import { agoStamp } from "../../webapp/app/shell/format";
import {
  unknownSpeaks, type HostConnection,
} from "@ohmail/app-logic/doors/host-connection";
import { BootStatus } from "./BootStatus.js";
import {
  bridgeAvailable,
  bridgeFetch,
  engineRetry,
  engineStartOver,
  engineUnlockRetry,
  unlockRefusal,
  type UnlockRefusal,
} from "./bridge-fetch.js";
import { forgetWindowSentFolders } from "./window-outbox-store.js";
import { listenForUpdateAnswers } from "./update-answer-door.js";
import {
  cloudNoticeDue, copyRemovedBy, sessionOf, sessionReaders, signInCauseOf, waitForSessionMove, type CloudSessionWire,
} from "./cloud-session.js";
import { DoorChooser, focusFirstControl } from "./DoorChooser.js";
import { BUILD_SHA, BUILD_VERSION } from "./build-id.js";
import { readMirrorFreshness } from "./DesktopMailboxes.js";
import { MailboxSelfCheck } from "../../webapp/app/shell/MailboxSelfCheck";
import { ReuseSweepNotice } from "../../webapp/app/shell/ReuseSweepNotice";
import { MailboxFilings } from "../../webapp/app/shell/MailboxFilings";
import { filingsOverBridge } from "./local-filings.js";
import { checkMailboxHere } from "./local-self-check.js";
import { readMailboxFacts } from "./local-mailbox-facts.js";
/* The OS-answer reader this window has to bring itself — see the injection below. */
import { desktopNotificationHost } from "./notify-host.js";
import { GateNotice } from "./GateNotice.js";
import { DOOR_COPY, keyringSentence, machineWord } from "./door-copy.js";
import { BUILD_PLATFORM } from "./platform.js";
import { isPreview, linksOutToBilling } from "./distribution.js";
import { PreviewMark } from "./PreviewMark.js";
import { useDesktopManageOffer, useHostedSession } from "./DesktopSubscription.js";
import { liveBodyVia } from "@ohmail/app-logic/reading/live-body";
import { DesktopAccessLock } from "./DesktopAccessLock.js";
import { useDesktopFirstPaint, useDesktopUnnamedWall } from "./desktop-first-paint.js";
import { reviveStandingDown } from "@ohmail/app-logic/session/sync-scheduler";
import {
  accountDoorFor, awayDoorFor, consentDoorFor, firstRunDoorFor, flavorOf, gateFor, imagesFromComputer,
  hostDoorFor, isDesktopHost, isManagedDoor, listedOnLabel, mailMount, pairedHostOf, pairedViaOf, profileImportDoorFor, readShell,
  restorePairingSwitch, selfHostedServerOf, suggestDoorFor, type HostedSession, type Shell,
} from "./doors.js";
import { DesktopDevices } from "./DesktopDevices.js";
import { awayOverBridge } from "./local-away.js";
import { organizerNoticeOverBridge } from "./local-organizer-notice.js";
import { reuseSweepsOverBridge } from "./reuse-sweeps-wire.js";
import { gapLettersOverBridge } from "./local-gap-letters.js";
import { profileImportOverBridge } from "./local-profile-import.js";
import { localImageDoor } from "./local-images.js";
import { consentOverBridge, consentOverBridgeStandalone } from "./local-consent.js";
import { olderBodyOverBridge } from "./local-older-body.js";

import { junkOverBridge } from "./local-junk.js";
import { trashOverBridge } from "./local-trash.js";
import { cloudSuggestWire } from "./cloud-suggest.js";
import { draftReplyOverBridgeFor } from "./local-draft-reply.js";
import { readAiStatus, type LocalAiStatus } from "./local-ai.js";
import { AiProviderForm } from "./AiProviderForm.js";
import { useLocalFirstRun } from "./local-first-run.js";
import {
  claimMailto, offLinkAsk, offLinkRefused, onLinkAsk, onLinkRefused, onMailto, onMenuCommand, onMenuNavigate,
  setBadge, type LinkAsk as HeldPress, type LinkRefusal, type MenuCommand,
} from "./native.js";
import { LinkAsk } from "./LinkAsk.js";
import { parseMailto } from "@trafficflow/core/mailto";
import { DefaultMailAsk, DefaultMailRow } from "./DesktopDefaultMail.js";
import {
  createLocalEngine, onAccessRefused, waitingFor, type AccessRefusedFacts, type EngineStatus, type SignedOut,
} from "./bridge-fetch.js";
import { desktopSendSurface, stagesAttachments } from "./desktop-send-surface.js";
import { forgetErasedWindowScopes, forgetWindowScopes, rememberCloudScope, rememberedCloudScope } from "./window-sweep.js";

/** How much of a refused address the one-line toast shows. The host is at the front. */
const ADDRESS_SHOWN = 80;

/**
 * How often the window re-asks while the engine is on its way up.
 *
 * Every millisecond between the engine serving and the next poll is a millisecond of skeleton
 * over a mailbox that is ready — at the old 1000 this was most of a healthy launch, whose
 * engine-side cost is a few hundred milliseconds. 250 matches the settle loop in `doors.ts`,
 * and the poll exists only while the engine is starting, so the steady state still costs zero.
 */
const SETTLING_POLL_MS = 250;

/**
 * How often the window re-asks the shell what the engine is doing ONCE IT HAS SETTLED. The ask
 * used to stop at "serving", and Rust goes on changing its mind after that: an engine can die, be
 * restarted by its supervisor, come back. Every one of those was written to the log and delivered
 * to nobody, so the window kept describing a run that had ended — a mailbox on screen with nothing
 * behind it — until somebody reopened it. This is the live owner of that fact, and it is
 * deliberately SLOW: one local stdio call every five seconds, the floor the ruling names, because
 * liveness bought with a fast poll is an idle cost on every install that is working. The settling
 * cadence above is the fast one and exists only while the engine climbs.
 */
export const LIFECYCLE_POLL_MS = 5_000;

/**
 * How often a CLOUD-door window re-asks the engine whether the hosted session still exists.
 *
 * The engine learns a dead session on its own (`cloud-auth.ts`'s definitive-refusal cue) and
 * flips `/health` to `signedIn: false` — but nothing pushed that fact into a window that was
 * already showing mail, so the person kept reading a mirror that had silently stopped
 * receiving, for days, with no sentence anywhere. Measured live on a paired desktop whose
 * refresh family was revoked. One local stdio call a minute is the whole steady-state cost,
 * and only on the cloud door — the standalone door has no hosted session to lose.
 */
const HOSTED_SESSION_PROBE_MS = 60_000;
/** …and while the session is renewing or not answering: the notice should leave when it does. */
const HOSTED_SESSION_DEGRADED_PROBE_MS = 5_000;
/**
 * A held session question answered sooner than this was not held. Three in a row and the loop
 * waits {@link SESSION_WAIT_RETRY_MS} between asks rather than spinning the bridge — an engine
 * that is leaving answers every one at once. A held one comes back at the engine's bound.
 */
const SESSION_WAIT_UNHELD_MS = 1_000;
const SESSION_WAIT_RETRY_MS = 5_000;

/** What the gate keeps from one `/health` answer, under the key it was earned under. */
interface HostedAuth {
  key: string; gone: boolean; preAuth: boolean; restartRequired: boolean; sealFailed: boolean;
  /** `/health.accountErased` — the hosted account was deleted; read before every other card. */
  erased: boolean;
  /** `/health.session` — the dialog's cause and the rail's notice. Null from an older engine. */
  session: CloudSessionWire | null;
  /** Has the fault in `session` lasted long enough to say so (`cloud-session.ts`)? */
  noticeDue: boolean;
  /** `/health.queued.count` — the window's changes this launch's owner still keeps; 0 from an older engine. */
  queued: number;
}

/**
 * ONE READING OF `/health` for both probes below. `gone` is the engine's verdict alone
 * (`sessionExpired`, set only by a coded refusal); `preAuth` is signed out WITHOUT that verdict;
 * `restartRequired` is read first where it is used, because its shape is `preAuth`'s. An older
 * engine sends no `sealed` and no `session`, and an absent field is not a fault.
 */
/** Load it now over the bridge: the hosted door forwards `GET /messages/:id/live-body`. */
function liveBodyBridge(path: string): Promise<Response> { return bridgeFetch(path); }
const liveBodyOverBridge = liveBodyVia(liveBodyBridge);

function hostedAuthOf(key: string, health: {
  signedIn?: boolean; sessionExpired?: boolean; restartRequired?: boolean; sealed?: boolean; session?: unknown;
  accountErased?: boolean; queued?: { count?: unknown } | null;
}): HostedAuth {
  const session = sessionOf(health.session);
  const queued = health.queued?.count;
  return {
    key,
    restartRequired: health.restartRequired === true,
    erased: health.accountErased === true,
    sealFailed: health.sealed === false,
    gone: health.sessionExpired === true,
    preAuth: health.sessionExpired !== true && health.signedIn === false,
    session,
    noticeDue: cloudNoticeDue(session, Date.now()),
    queued: typeof queued === "number" && Number.isInteger(queued) && queued > 0 ? queued : 0,
  };
}

/** One `/health` ask under `key`, or null when the engine did not answer — every asker's reader. */
async function readHostedAuth(key: string): Promise<HostedAuth | null> {
  try {
    const res = await bridgeFetch("/health");
    if (!res.ok) return null; // a dead ENGINE is the status path's story, not this one's
    return hostedAuthOf(key, (await res.json()) as Parameters<typeof hostedAuthOf>[1]);
  } catch {
    return null; // engine unreachable or still starting — the next ask tries again
  }
}

/** Keep the held answer when a new one says the same: a repaint of the whole window for nothing. */
function sameHostedAuth(a: HostedAuth | null, b: HostedAuth): boolean {
  return a !== null && a.key === b.key && a.gone === b.gone && a.preAuth === b.preAuth
    && a.restartRequired === b.restartRequired && a.sealFailed === b.sealFailed && a.erased === b.erased
    && a.noticeDue === b.noticeDue && a.queued === b.queued && a.session?.state === b.session?.state
    && a.session?.code === b.session?.code && a.session?.since === b.session?.since;
}

/**
 * How often a PAIRED window re-asks the engine how old its copy of the other computer's mail
 * is. The mirror pulls every twenty seconds, so asking on the same beat is the finest
 * granularity there is anything new to learn at. NOT a second poller in the forbidden sense:
 * it dials nothing — `GET /mirror/freshness` is a local stdio call answered out of a stamp
 * the engine keeps for its own drain; a poller would be a second opinion about reachability,
 * this reads the one that exists. Only on the paired door: the hosted door has the shared
 * strip's own arm, and the standalone door has no mirror to be behind.
 */
const HOST_FRESHNESS_PROBE_MS = 20_000;

/**
 * THE STANDALONE DOOR'S ENTRY POINT INTO GUIDED SETUP — the one thing that opens the stage
 * here. `AppShell` renders the stage only at `#/first-run` and never opens it itself, which
 * left this door with no entry at all: a person who chose "On this computer" and typed a
 * password landed in the mail client with nothing having asked them anything (measured on a
 * released build). CONNECTING IS THE ENTRY POINT — it navigates, and only that: WHICH step,
 * and whether the stage opens at all, stay with `deriveOnboardingStep`, so a re-seal on a
 * finished mailbox derives to `null` and `FirstRun` hands the route back — no blank overlay. The
 * hosted door is excluded structurally: `firstRunDoorFor` answers `null` there.
 */
function openSetupOnStandalone(status: EngineStatus | null): void {
  if (firstRunDoorFor(status) !== "local") return;
  /* BEFORE the status is delivered, so the first render of `AppShell` already carries the route
     and the person does not see one frame of the Ohbox before the stage arrives. NAMING the mailbox
     this engine serves — the one the door just connected: unnamed, the stage took the install's
     first row, which after a refused first door under another address is that attempt's bare row. */
  goFirstRun(status?.mailboxId ? { mailboxId: status.mailboxId } : {});
}

/**
 * THE RUN BEHIND THE BRIDGE, AS ONE STRING — what tells a delivered lifecycle change from the
 * same answer arriving again. The fields are the ones that describe WHICH engine and WHAT it is
 * doing; a change in any of them is a different run or a different state of this one, and both
 * are things the window must re-read rather than remember. `JSON.stringify` rather than a joined
 * key: a separator byte in an address would make two runs compare equal.
 */
function lifecycleMark(shell: Shell): string {
  if (shell.kind !== "status") return JSON.stringify([shell.kind, shell.kind === "unreachable" ? shell.reason : null]);
  const s = shell.status;
  return JSON.stringify([
    "status", s.state, s.mode ?? null, s.flavor ?? null, s.mailboxId ?? null,
    s.credentialState ?? null, s.baseUrl ?? null, s.cloudUrl ?? null,
  ]);
}

/**
 * THE GATE, AND THE ASK A HELD LINK PRESS PUTS OVER WHICHEVER SCREEN IT SHOWS (`LinkAsk.tsx`): the
 * shell may hold a marked link's press on any of them, so the ask stands outside them all.
 */
export function DesktopGate() {
  const [ask, setAsk] = useState<HeldPress | null>(null);
  return (
    <>
      <GateScreens onLinkAsk={setAsk} />
      {ask ? <LinkAsk key={ask.token} ask={ask} onClose={() => setAsk(null)} /> : null}
      <PreviewMark />
    </>
  );
}

function GateScreens({ onLinkAsk: showAsk }: { onLinkAsk: (ask: HeldPress) => void }) {
  const [shell, setShell] = useState<Shell | null>(null);
  /* The door chooser, opened from Settings over a working install. Distinct from the chooser a
     fresh install lands on: this one is cancellable, because there is something to go back to. */
  const [overlay, setOverlay] = useState<null | "doors" | "cloud" | "host" | "takeover" | "local">(null);
  /* A SIGN-OUT ITS SERVER DID NOT CONFIRM: the door it was pressed on, for the one line on the
     chooser the press lands on. Held here because the lifecycle poll replaces `shell`; cleared by
     the next door action; never written anywhere. */
  const [signedOutFrom, setSignedOutFrom] = useState<EngineStatus | null>(null);
  /* …and the window's changes that press left waiting on this computer, and whose. Held and
     cleared beside `signedOutFrom`, never written; said whether or not the server confirmed. */
  const [signedOutWaiting, setSignedOutWaiting] = useState<SignedOut["waiting"]>(null);

  /**
   * WHAT THE WINDOW HAS BEEN TOLD THE ENGINE IS — the settled lifecycle, owned by the one
   * writer that paints it. A ref rather than state because nothing renders it, and written in
   * the delivery itself rather than in the component body: a body-written ref is only as fresh
   * as the last paint, and the comparison below is made in an async callback where no paint has
   * happened yet. Record, then paint.
   */
  const delivered = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    let next = await readShell();
    /* A SWITCH THIS WINDOW DID NOT START. A mount's first answer can only find a pairing a previous
       window left unanswered (a reload mid-pairing), and its answer is never coming: the door it
       replaced comes back before anything is drawn over it. */
    if (delivered.current === null && next.kind === "status" && next.status.switchPending === true) {
      next = await restorePairingSwitch().then((status): Shell => ({ kind: "status", status }), () => next);
    }
    const mark = lifecycleMark(next);
    /* `null` is "nothing delivered yet", which is the first answer of the launch and not a
       change — the window has no previous run to have been describing. */
    const moved = delivered.current !== null && delivered.current !== mark;
    delivered.current = mark;
    setShell(next);
    /* A DIFFERENT RUN, OR THE SAME ONE IN A DIFFERENT STATE: whatever /health said describes an
       engine that has gone. Re-key so the door's auth state is earned again from the engine now
       behind the bridge, exactly as every other lifecycle act here does. */
    if (moved) setAuthEpoch((n) => n + 1);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /* ONE OWNER OF THE LIFECYCLE, TWO CADENCES. Fast while the engine is coming up — every
     millisecond there is a millisecond of skeleton over a mailbox that is ready, and this is
     also what carries the boot narration (`status.bootPhase`) onto the screen — and slow for
     ever after, because the shell goes on changing its mind once it has served and nothing
     pushed those changes here. The steady half is `LIFECYCLE_POLL_MS`, one local stdio call
     every five seconds; the alternative was a window describing an engine that had died. No
     bridge, no owner: outside the app there is nothing to ask. */
  const settling =
    shell?.kind === "status" && (shell.status.state === "starting" || shell.status.state === "restarting");
  useEffect(() => {
    if (!bridgeAvailable()) return;
    const timer = setInterval(() => void refresh(), settling ? SETTLING_POLL_MS : LIFECYCLE_POLL_MS);
    return () => clearInterval(timer);
  }, [settling, refresh]);

  /* THE MENU, ONCE. `go` is the shared client's own navigation — the same call the rail makes,
     the palette makes and the bare number keys make — so the menu is a second way to reach the
     one route rather than a second routing implementation. */
  useEffect(() => {
    void onMenuNavigate((view) => go(view));
    void onMenuCommand(runMenuCommand);
  }, []);

  /* A MAILTO CLICK, CLAIMED. The shell holds the link (take-once); this window claims it on the
     shell's poke and once at mount — the mount claim is the activation that STARTED the app,
     whose poke fired before this bundle's scripts ran. The parsed draft waits in state until the
     mail client is on screen (the AppShell below consumes it), so a click on a not-yet-connected
     install becomes the compose the moment a mailbox is. See the header. */
  const [links] = useState(linkSlot);
  useEffect(() => {
    /* ONE READING OF A MAILTO, TWO ORIGINS. The OS hands one to the shell and this window
       claims it; the window's own link seam hands one straight over. Both go through
       `parseMailto` and both land in the same state, so a link clicked in a message and a link
       clicked in another application cannot open different compose forms. */
    const seed = (raw: string): void => {
      const draft = parseMailto(raw);
      if (draft) links.offer(draft);
    };
    const claim = async (): Promise<void> => {
      const raw = await claimMailto();
      if (raw === null) return;
      seed(raw);
    };
    void onMailto(() => void claim());
    void claim();
    /* THE IN-WINDOW HALF. Registered here rather than at the entry point because the compose
       form is this component's state: `main.tsx` arms the interceptor before React exists and
       has nothing to point it at. Taken away on unmount so a stale closure cannot hold a
       setter for a gate that is gone. */
    setMailtoSink(seed);
    return () => setMailtoSink(null);
  }, []);

  /* AND WHO SAYS SO WHEN A LINK WILL NOT OPEN. Registered here because the only surface that can
     say anything is under a toast host that does not exist before the gate mounts. The buttons
     that open a web page have shown this sentence since they were written; an anchor once had a
     console line and nothing on screen, which is the defect this feature exists to end. A long
     address is cut: the host is at the front and a toast is one line. Every link leaves as a
     new-window request and the shell refuses any of them with one event, `link:refused`, so a
     link in the app's document and one in a message frame cannot be worded differently. The event
     says why: ohmail's own gate refusing is said as ohmail's, and only the opener's refusal
     blames this computer. */
  const toast = useOptionalToast();
  useEffect(() => {
    if (!toast) return;
    /* The whole address, written inside the press; "copied" only once the write fulfilled
       (`DesktopDevices.tsx`'s rule: a false "copied" strands the person). */
    const copy = (url: string): void => {
      void (async () => {
        try {
          await navigator.clipboard.writeText(url);
          toast(DOOR_COPY.linkAddressCopied);
        } catch {
          toast(DOOR_COPY.linkAddressNotCopied);
        }
      })();
    };
    const say = ({ url, why }: LinkRefusal): void => {
      const shown = url.length > ADDRESS_SHOWN ? `${url.slice(0, ADDRESS_SHOWN)}…` : url;
      const sentence = why === "opener" ? DOOR_COPY.linkNoBrowser(machineWord(), shown) : DOOR_COPY.linkNotOpened(shown);
      toast(sentence, {
        action: DOOR_COPY.linkCopyAddress,
        onAction: () => copy(url),
        duration: 10_000,
      });
    };
    void onLinkRefused(say);
    return () => {
      offLinkRefused(say);
    };
  }, [toast]);
  /* …AND WHO ASKS WHEN THE SHELL HOLDS A MARKED LINK'S PRESS: the gate draws the ask over every
     screen (`LinkAsk.tsx`), and a newer press replaces one still up, as in the shell's one slot. */
  useEffect(() => {
    void onLinkAsk(showAsk);
    return () => {
      offLinkAsk(showAsk);
    };
  }, [showAsk]);

  /**
   * THE MAILBOX WHOSE SHELL WAS ON SCREEN, and whether on a Cloud door: written only by `ScopeShown`,
   * once the shell is drawn, and read when that account ends here (the sweeps below).
   */
  const served = useRef<{ scope: string; cloud: boolean } | null>(null);
  /** The last door this window served: a Sign out's status names none. */
  const leftDoor = useRef<string | null>(null);
  /* THE WINDOW KEYS A SIGN OUT OWES (`window-sweep.ts`), swept after the commit that took the shell
     away, never inside the press. */
  const [owed, setOwed] = useState<(string | null)[] | null>(null);
  useEffect(() => {
    if (owed === null) return;
    forgetWindowScopes(owed);
    setOwed(null);
  }, [owed]);

  const onStatus = useCallback((
    next: EngineStatus, stillListedFrom: EngineStatus | null = null, waiting: SignedOut["waiting"] = null,
  ) => {
    /* RECORDED, THEN PAINTED, as `refresh` does: a delivery painted without its record read as a
       lifecycle move at the next poll, which re-keyed the gate and remounted the mail a pairing had
       just opened. */
    delivered.current = lifecycleMark({ kind: "status", status: next });
    /* SIGNED OUT — from Settings, the access lock or the last mailbox removed; no other not-configured
       delivery has a shell on screen. The mailbox shown owes its window keys, and on a Cloud door the
       one an earlier launch showed. */
    if (next.state === "not_configured") {
      const scopes = [served.current?.scope ?? null, leftDoor.current === "cloud" ? rememberedCloudScope() : null];
      setOwed((held) => [...(held ?? []), ...scopes]);
      served.current = null;
    }
    setShell({ kind: "status", status: next });
    setOverlay(null);
    setSignedOutFrom(stillListedFrom);
    setSignedOutWaiting(waiting);
    /* Every status delivered here follows an engine-lifecycle act — a door entered, a sign-in,
       a reconfigure — any of which may have REPLACED the engine behind the bridge. The auth
       answer below is keyed on this counter, so bumping it makes whatever /health said about
       the PREVIOUS engine unusable and the gate withholds the mail app until the new engine's
       own first answer lands. Same door or not: `engine_configure` restarts the engine either
       way, and a fresh engine's session is a fact to be read, never remembered. */
    setAuthEpoch((n) => n + 1);
  }, []);

  /* At the TOP, above every early return: this is a hook, and a hook called from inside the JSX
     below would be skipped on the renders that return early — which is the "rendered fewer hooks
     than expected" crash, arriving on whichever render first took a different branch. */
  const onUnread = useUnreadSink();
  /* The other computer's silence as a signal the frame reads: made once, above every early return, for `onUnread`'s
     reason. */
  const [connectionFeed] = useState(() => createFeed<HostConnectionState | null>(null, sameConnection));
  /* WHERE THE APP IS, for the one-ask rule below — the SAME hash route `AppShell` gates the
     first-run stage on, so the flow being open and this prompt waiting cannot disagree. A hook,
     so it belongs up here with `onUnread` for the reason that comment gives. */
  // The frame canonicalizes addresses, including Calendar routes the first-run reader never handles.
  const routeNow = useHashRoute(false);

  /**
   * WHAT THIS INSTALL HAS FOR A MODEL — read once, here, because two surfaces need the
   * answer: the Settings pane could read it itself, but the Screener's suggest control must
   * tell somebody who never opened Settings that nothing is behind it yet. Reading it at the
   * gate keeps the two saying the same thing, and the pane publishes what it changes, so a
   * saved key makes the Screener control live without a relaunch (the engine rebuilds its
   * services per request). `null` means "not on this door, or not asked yet": only the
   * standalone door has a local model — a hosted install's AI is the account's.
   */
  const [ai, setAi] = useState<LocalAiStatus | null>(null);
  const door = shell?.kind === "status" ? (shell.status.mode ?? null) : null;
  useEffect(() => {
    if (door !== null) leftDoor.current = door;
  }, [door]);

  /**
   * THE FIRST-RUN STAGE'S DOOR — built here, at the top, for `onUnread`'s reason: it is a
   * hook, and a hook inside the JSX below is skipped on early-return renders ("rendered fewer
   * hooks than expected" on whichever render first branches). The two injected nodes are
   * MEMOISED, not inline: an inline element is a new object every render, defeating the
   * host's own `useMemo` and handing the stage a new `host` on every keystroke.
   * `AiProviderForm`'s echo is the gate's own `ai` setter — the same state Settings → AI and
   * the suggest control read, so a key saved in the flow is live everywhere; a `useState`
   * setter is stable.
   */
  const gateStatus = shell?.kind === "status" ? shell.status : null;
  const providerForm = useMemo(() => <AiProviderForm onStatus={setAi} />, []);
  const pairNode = useMemo(
    () => (hostDoorFor(gateStatus) === "local" ? <DesktopDevices /> : undefined),
    [gateStatus],
  );
  const firstRun = useLocalFirstRun({
    status: gateStatus,
    ai,
    providerForm,
    ...(pairNode ? { pairNode } : {}),
  });

  /**
   * THE HOSTED SESSION'S LIVE TRUTH, asked of the engine rather than remembered from launch —
   * and never remembered ACROSS ENGINES: `authEpoch` counts engine-lifecycle acts (every
   * status `onStatus` delivers) and `authKey` names the (door, epoch) an answer was earned
   * under; an answer is believed only while its key matches, so re-entering a door or
   * replacing the engine mints a key no stored answer matches — structurally PENDING until
   * the NEW engine's own first `/health` lands. `gone` latches on the expiry verdict
   * (`sessionExpired`): an honest sentence plus the sign-in surface. `preAuth` is
   * signedIn:false WITHOUT that verdict — no "you were signed out" for a session that never was.
   */
  const [authEpoch, setAuthEpoch] = useState(0);
  const authKey = door === "cloud" && bridgeAvailable() ? `cloud:${authEpoch}` : null;
  const [hostedAuth, setHostedAuth] = useState<HostedAuth | null>(null);
  /* THE READING THE HELD QUESTION NAMES, recorded by whichever ask learned it before the paint —
     the wait loop runs between paints, where a body-written ref would still hold the last one. */
  const sessionHeld = useRef<CloudSessionWire | null>(null);
  /** TRUE once the CURRENT engine's first `/health` answer has been read — pending otherwise.
      Until then the mail app is withheld: React would otherwise commit `AppShell` once, before
      the asynchronous probe responds, over an engine whose mail routes refuse. Non-cloud doors
      and bridge-less environments never consult it. */
  const hostedAuthKnown = hostedAuth !== null && hostedAuth.key === authKey;
  const hostedSessionGone = hostedAuthKnown && hostedAuth.gone;
  const hostedPreAuth = hostedAuthKnown && hostedAuth.preAuth;
  /**
   * A PAIRING THAT SUCCEEDED AND IS WAITING FOR A RELAUNCH.
   *
   * Read BEFORE `gone` and `preAuth` at the render below, and the order is the whole of it: this
   * state's `/health` shape is `signedIn:false, sessionExpired:false`, which is byte-for-byte
   * `preAuth`'s. An arm added after them would be correct, unreachable, and invisible — the code
   * would exist, read well, and never run.
   */
  const hostedRestartRequired = hostedAuthKnown && hostedAuth.restartRequired;
  /** This engine could not write the session to disk — Settings → Desktop says so; see `/health`. */
  const hostedSealFailed = hostedAuthKnown && hostedAuth.sealFailed;
  /**
   * THE ENGINE REMOVED THIS COMPUTER'S COPY: the session was revoked at its server (`copyRemovedBy`).
   * The window keeps no client and draws no mail; the card stands on the window's own page.
   */
  const copyRemoved = door === "cloud" && hostedAuthKnown && copyRemovedBy(hostedAuth.session);
  /** The hosted account was deleted (`/health.accountErased`): the window keeps no client for it either. */
  const erased = hostedAuthKnown && hostedAuth.erased;
  /* THE ACCOUNT ENDED HERE — a revoke or an erasure: the window's keys go with the copy, for the mailbox
     shown and the one a Cloud door showed at an earlier launch (a card at launch shows none). An erasure
     takes the send lanes too, since the engine discarded their outbox with the account; a revoke keeps
     them for the next sign-in, as Sign out does. */
  const accountEnded = copyRemoved || erased;
  useEffect(() => {
    if (!accountEnded) return;
    const scopes = [served.current?.scope ?? null, rememberedCloudScope()];
    if (erased) forgetErasedWindowScopes(scopes);
    else forgetWindowScopes(scopes);
    served.current = null;
  }, [accountEnded, erased]);
  /**
   * THE ONE FACT EVERY ACCOUNT-SHAPED SURFACE BELOW IS DECIDED BY — this engine's own live
   * verdict on the hosted session, in the door rules' shape ({@link HostedSession}). Derived
   * from the SAME probe state the whole-window routing reads — one expression, one name — so
   * the settings surface and the routing cannot disagree about whether this install is
   * signed in. It replaced `status.credentialState`, which the shell copies from the one-shot
   * `ready` frame and never rewrites: an install that signed in through the surface above ran
   * the whole session reported signed OUT, nine settings surfaces missing until relaunch.
   */
  const hostedSession: HostedSession =
    door !== "cloud" || !hostedAuthKnown
      ? "unknown"
      : hostedAuth.gone || hostedAuth.preAuth || hostedAuth.erased
        ? "out"
        : "live";

  /**
   * IS THERE A HOSTED ACCOUNT BEHIND THIS WINDOW — the one gate every account-shaped surface
   * below reads, so they appear and disappear together. The engine serves mail READS from its
   * mirror and forwards the rest to the account with its bearer (`cloud-proxy.ts`), so
   * `/consent`, `/consent/settings`, `/screener`, `/billing/subscription` and `/account/ai`
   * are the account's own rows one hop away. What was missing was the ASKING:
   * `apiConfigured()` is false in every desktop build, so the shared shell's reads never ran —
   * true of the standalone door, false of this one; `accountDoorFor` holds the distinction.
   * DERIVED UP HERE, above every early return, because the manage-link hook below reads it.
   */
  const accountDoor =
    accountDoorFor(shell?.kind === "status" ? shell.status : null, hostedSession) === "cloud";

  /**
   * WHETHER THIS ACCOUNT'S DOOR SERVES A SUBSCRIPTION PAGE — `false` where none is. The OFFER
   * and not the address: the address is minted when somebody presses Manage, which is what
   * stopped every launch asking for a link nobody was going to follow. Read in the GATE, not
   * inside the pane: `SettingsView` grows the nav entry from the prop's presence, so
   * withholding the entry means withholding the node. UP HERE with the unconditional hooks —
   * everything below the mount switch sits behind an early return, and a hook below one renders
   * on some paths only ("Rendered more hooks than during the previous render"). `accountDoor`
   * gates the ask as well as the mount: a door with no hosted account has nothing to ask.
   */
  const { manageOffered, withdrawManage, storage, reread: rereadAccess } = useDesktopManageOffer(accountDoor);
  const { accountId: hostedAccountId, reuseSweeps, recheck: recheckHostedSession } = useHostedSession(accountDoor);
  /** The Subscription pane is offered AND this build may point at a purchase (not the Mac App Store). */
  /** May this build point at a purchase at all (not the Mac App Store)? */
  const mayLinkOut = linksOutToBilling();
  const billingLinksOut = accountDoor && manageOffered && mayLinkOut;

  /**
   * HAS THE SERVICE REFUSED THIS ACCOUNT — subscribed once, for the whole window.
   *
   * Any hosted door may answer `402 subscription_required`, so this was met one failed write at
   * a time, each pane saying its own thing about somebody's account. The bridge raises it once
   * and the whole surface swaps for the lock screen below — mail beside a refusal is the state
   * that prevents. A later request that happens to succeed is not evidence it was lifted; the lock
   * comes down on the account's own fresh `access: "open"` read (`DesktopAccessLock`'s lift) and on
   * nothing else. Behind `accountDoor`, because a standalone install has nothing that could refuse.
   */
  const [accessRefused, setAccessRefused] = useState<AccessRefusedFacts | null>(null);
  useEffect(() => {
    if (!accountDoor) {
      setAccessRefused(null);
      return;
    }
    return onAccessRefused((facts) => setAccessRefused((held) => held ?? facts));
  }, [accountDoor]);

  /**
   * A SERVER SAID THIS APP IS TOO OLD FOR IT, OR THAT IT IS BEING UPDATED — told once to the one
   * update line, with the verb that asks the updater now (the shell's own check or restart; this
   * window names no feed and installs nothing). FOR THE WINDOW'S WHOLE LIFE, not behind a live
   * session: a sign-in and a pairing meet the answer before there is one, and a door's refusal
   * shows the same verb (`HostedDoorProblem`). A standalone engine says neither, so there it hears nothing.
   */
  useEffect(() => listenForUpdateAnswers(), []);

  /** Not live: renewing, unreachable or unable to save. The probe then asks every few seconds. */
  const hostedDegraded = hostedAuthKnown && hostedAuth.session !== null && hostedAuth.session.state !== "live";
  useEffect(() => {
    if (authKey === null) return;
    let cancelled = false;
    const probe = async (): Promise<void> => {
      // `sessionExpired` and never bare `signedIn: false` decides the WORDING: an ordinary
      // pre-auth engine also answers signedIn:false, and the engine latches sessionExpired only
      // on the hosted API's coded refusal to renew (`hostedAuthOf`).
      const next = await readHostedAuth(authKey);
      if (cancelled || next === null) return;
      sessionHeld.current = next.session;
      setHostedAuth((held) => (sameHostedAuth(held, next) ? held : next));
    };
    // Once at mount — a relaunch onto a signed-out engine must land on sign-in now, not a
    // minute from now — then on the slow steady cadence.
    void probe();
    const timer = setInterval(
      () => void probe(),
      hostedDegraded ? HOSTED_SESSION_DEGRADED_PROBE_MS : HOSTED_SESSION_PROBE_MS,
    );
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [authKey, hostedDegraded]);
  /* UNTIL THE FIRST ANSWER, ask fast: the door's auth state is pending and the app is withheld,
     and the ask is one local stdio call answered in milliseconds once the engine serves. This
     loop exists only while the state is unknown — the flip to known unmounts it, and a new
     `authKey` (a replaced engine) re-mounts it because the stored answer stops matching. */
  useEffect(() => {
    if (authKey === null || hostedAuthKnown) return;
    let cancelled = false;
    const probe = async (): Promise<void> => {
      const next = await readHostedAuth(authKey);
      if (cancelled || next === null) return;
      sessionHeld.current = next.session;
      setHostedAuth(next);
    };
    const fast = setInterval(() => void probe(), 400);
    return () => {
      cancelled = true;
      clearInterval(fast);
    };
  }, [authKey, hostedAuthKnown]);
  /**
   * THE ENGINE SAYS WHEN THE SESSION MOVES. The probes above ask on a clock — a minute while live
   * — so a refusal the engine knew in three seconds reached the window up to a minute later, over
   * a strip already saying "Retrying". One held question stays open instead: the engine answers it
   * the moment its reading changes, and the change is read at once through `/health`. An engine
   * with no such door answers null, and the minute's probe is the fallback.
   */
  useEffect(() => {
    if (authKey === null || !hostedAuthKnown) return;
    let cancelled = false;
    void (async () => {
      let fast = 0;
      while (!cancelled) {
        const asked = Date.now();
        const moved = await waitForSessionMove(sessionHeld.current);
        if (cancelled || moved === null) return;
        if (moved.changed) {
          sessionHeld.current = moved.session;
          const next = await readHostedAuth(authKey);
          if (cancelled) return;
          if (next !== null) {
            sessionHeld.current = next.session;
            setHostedAuth((held) => (sameHostedAuth(held, next) ? held : next));
          }
        }
        fast = Date.now() - asked < SESSION_WAIT_UNHELD_MS ? fast + 1 : 0;
        if (fast >= 3) await new Promise((r) => setTimeout(r, SESSION_WAIT_RETRY_MS));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authKey, hostedAuthKnown]);
  /**
   * ═══ IS THE OTHER COMPUTER ANSWERING? — the paired door's standing fact ═════════════════
   * AT THE TOP, WITH THE OTHER HOOKS: this component returns early five times, and a hook
   * after any of those is skipped on exactly the renders that take them — the hook-order
   * crash (the settings census caught it before a window did). Read here rather than in the
   * shell because the shared shell also compiles into a browser tab, never paired to
   * anybody's laptop — the shell gets the finished sentence. The verdict is read twice on
   * purpose: `mirrorFreshness`'s provider lives UNDER this component, and lifting it above
   * the gate would put a mail-state concern above the routing — both reads describe one stamp.
   */
  const [freshness, setFreshness] = useState<
    { state: "unknown" | "stale" | "current"; asOf: string | null } | null
  >(null);
  /**
   * WHEN THIS ENGINE FIRST SAID `unknown`, or null while it never has.
   *
   * A ref and not state: it is read only when a verdict arrives, and holding it in state would
   * re-render the whole gate on the first probe of every launch to change nothing on screen.
   * KEYED BY THE ENGINE through the effect's own reset — a door change or a restart clears it, so
   * the sixty-second grace is always measured against the engine currently behind the bridge and
   * never inherited from one that no longer exists.
   */
  const firstUnknownAt = useRef<number | null>(null);
  /* `shell` and not the narrowed `status` below, because that one is derived AFTER the early
     returns and this has to be a hook — see the block comment on the first-run door for the
     "rendered fewer hooks than expected" crash that placement causes. Same value either way. */
  const paired = isDesktopHost(shell?.kind === "status" ? shell.status : null);
  useEffect(() => {
    if (!paired || !bridgeAvailable()) {
      setFreshness(null);
      firstUnknownAt.current = null;
      return;
    }
    let cancelled = false;
    const probe = async (): Promise<void> => {
      try {
        const next = await readMirrorFreshness();
        if (cancelled) return;
        /* THE FIRST `unknown` OF THIS ENGINE, stamped once and never moved while the verdict
           stays `unknown`. Re-stamping on every probe would restart the grace on every tick and
           the line would never appear at all — the quiet failure this ref exists to avoid. */
        if (next.state === "unknown") {
          firstUnknownAt.current ??= Date.now();
        } else {
          firstUnknownAt.current = null;
        }
        setFreshness(next);
      } catch {
        /* The engine is still coming up, or the route is not there. Left as the last answer seen,
           per the freshness probe's own contract: an unanswerable question must not be dressed as
           "current" (which would silently unlabel an old copy) or as "stale" (which would put a
           sentence about an unreachable computer on a window whose engine is merely starting). */
      }
    };
    void probe();
    const timer = setInterval(() => void probe(), HOST_FRESHNESS_PROBE_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
    /* `authKey` is in the list so a REPLACED engine restarts the grace and drops the previous
       engine's verdict — the same re-keying the hosted probe above does, for the same reason. */
  }, [paired, authKey]);

  /**
   * ═══ SETTING THIS MACHINE UP ON ITS OWN — the roster, captured BEFORE the door moves ═════
   * The state is up here with every other hook, and the trigger is a PLAIN FUNCTION rather
   * than a `useCallback` — this component returns early five times, and a hook after any of
   * them crashes the hook order. THE ORDERING IS THE WHOLE OF THIS: leaving a paired door is
   * a door CHANGE, `enforceMirrorOwner` DISCARDS the mirror, and the roster lives only in
   * that mirror — read afterwards it is an empty list, "no mailboxes to take over", failure
   * looking healthy; so it is captured at the press. An UNREADABLE roster is not an empty
   * one: `null` renders its own sentence, never "none". Kept: `organizerRole === "organizer"`.
   */
  const [takeoverRoster, setTakeoverRoster] = useState<
    { address: string; id: string }[] | null | undefined
  >(undefined);
  const beginTakeover = (): void => {
    /* `undefined` while the read is in flight, so the card can say it is looking rather than
       claiming an answer it has not got. */
    setTakeoverRoster(undefined);
    setOverlay("takeover");
    void readMailboxFacts().then(
      (facts) => {
        setTakeoverRoster(
          facts
            .filter((m) => m.organizerRole === "organizer")
            .map((m) => ({ address: m.address, id: m.id })),
        );
      },
      () => {
        /* NOT `[]`. See the block above: an unreadable roster and a host that held nothing are
           different facts and only one of them is a reason to say "there is nothing to take
           over". */
        setTakeoverRoster(null);
      },
    );
  };

  useEffect(() => {
    if (door !== "local") {
      setAi(null);
      return;
    }
    let cancelled = false;
    void readAiStatus().then(
      (next) => {
        if (!cancelled) setAi(next);
      },
      () => {
        /* The engine is still coming up, or it did not answer. Left as "not asked yet": the
           control says it is checking rather than claiming there is no model. */
      },
    );
    return () => {
      cancelled = true;
    };
  }, [door]);

  /**
   * THE CLIENT ENGINE ON SCREEN — one per mailbox, kept across a restart of the process
   * behind it. State rather than a memo because it must SURVIVE: `mailMount` answers with the
   * same key while the engine bounces, which only means anything if the object is still here.
   * Built during the render that first needs it (React's "adjusting state when a prop
   * changes"), not in an effect, so the mail surface never paints one empty frame between the
   * shell saying `serving` and the client. The constructor opens nothing; the shared shell
   * starts the engine and drives its sync loop, exactly as for a browser tab.
   */
  const [live, setLive] = useState<{
    key: string;
    stage: boolean;
    localDoorVersion?: number;
    engine: OhmailEngine;
  } | null>(null);
  const gate = gateFor(shell ?? { kind: "none" });
  const mount = mailMount(shell ?? { kind: "none" }, live?.key ?? null);
  /**
   * THE FIRST-RUN CHOOSER, HELD while an adopted claim's engine is relaunched behind its door: the
   * door on disk flips the gate to the app a moment before that engine serves, and the person must
   * see the sign-in finish rather than a boot frame or a second chooser. Held until the mail can
   * mount with the door's auth state known; a refused relaunch hands the screen back at once.
   */
  const [adoption, setAdoption] = useState(false);
  const adoptionHeld = adoption && !(mount.kind === "engine" && (authKey === null || hostedAuthKnown));
  useEffect(() => {
    if (adoption && !adoptionHeld) setAdoption(false);
  }, [adoption, adoptionHeld]);
  /**
   * AND HELD FROM A PRESS ON PAIR. The pairing writes its door before the other computer answers,
   * so the lifecycle poll read a chosen door mid-pairing and drew the boot frame over the card, then
   * the pre-auth arm drew the Cloud sign-in form. `held` until a door the chooser opens is entered —
   * a refusal stays on the card — and `entered` until that engine's auth answer is read.
   */
  const [pairing, setPairing] = useState<"none" | "held" | "entered">("none");
  const pairingHeld = pairing === "held" || (pairing === "entered" && authKey !== null && !hostedAuthKnown);
  useEffect(() => {
    if (pairing === "entered" && !pairingHeld) setPairing("none");
  }, [pairing, pairingHeld]);
  /**
   * WHOSE `localStorage` PARTITION THE SHARED SHELL IS ABOUT TO USE — established HERE, in
   * render, above the `AppShell` this returns. With no account cookie, `readOwner()` answered
   * `null` and the four owner-keyed keys all resolved to the literal `"local"` — the compose
   * scratch, send lanes, intent journal and Search order were common to every mailbox this
   * install mounts: a message written under one could be sent under another's identity. `mount.key` is `status.mailboxId`, the
   * same id `live` is keyed by, so partition and engine change together. It CANNOT be an
   * effect: `AppShell` reads the scratch in its own `useEffect` and a child's effects run
   * before the parent's — a module write during render is the ordering the shell needs.
   */
  setStorageOwner(mount.kind === "engine" ? mount.key : null);
  /* The wall before mail on the Cloud door: asked only where a hosted account stands behind the
     mailbox, under the same storage owner the bridge keeps the verdict for. */
  const firstPaint = useDesktopFirstPaint(
    accountDoor && mount.kind === "engine" ? mount.key : null,
    (facts) => setAccessRefused((held) => held ?? facts),
  );
  /* …and while no mailbox is named: a refused account's list never names one (`useDesktopUnnamedWall`). */
  const unnamed = useDesktopUnnamedWall(
    accountDoor && mount.kind === "opening" && accessRefused === null,
    (facts) => setAccessRefused((held) => held ?? facts),
  );
  // One window, one composer, across restarts — see `setComposerScope`.
  setComposerScope("window");
  // The hosted door stages a large send's bytes through the engine; no other door has storage.
  const serving = shell?.kind === "status" ? shell.status : null;
  const stage = stagesAttachments(serving);
  // The same mailbox can be installed again. Its durable storage key still names the mailbox,
  // while the in-memory client's roster and pending reads belong to the previous native engine.
  const localDoorVersion = serving?.mode === "local" ? serving.localDoorVersion : undefined;
  if (mount.kind === "engine" && !copyRemoved && !erased &&
      (live?.key !== mount.key || live.stage !== stage || live.localDoorVersion !== localDoorVersion)) {
    setLive({ key: mount.key, stage, localDoorVersion, engine: createLocalEngine(mount.key, { stageAttachments: stage }) });
  } else if ((mount.kind !== "engine" || copyRemoved || erased) && live !== null) {
    /* Signed out, the door given up, the copy removed or its account erased. Dropping the reference is
       what takes the mirror — a copy of somebody's mail — out of this window's memory; keeping it would
       leave it sitting behind the chooser for the life of the process. */
    forgetWindowSentFolders(live.key);
    setLive(null);
  }

  /* ONE SCREEN, AHEAD OF EVERY OTHER — the refused account's whole surface, the way the browser
     tab swaps its own. Below the render-time state above so the mirror and the storage partition
     are still settled correctly, and above the screens that follow because none of them is the
     answer to this: a person whose account is refused should not be reading mail behind it, nor
     be handed a door chooser. It takes nothing away — only the sign-out button wipes. */
  if (accessRefused) {
    return (
      <DesktopAccessLock
        facts={accessRefused}
        scope={mount.kind === "engine" ? mount.key : null}
        press={shell?.kind === "status" ? { status: shell.status, session: hostedSession } : null}
        onSignedOut={onStatus}
        onLifted={() => { setAccessRefused(null); reviveStandingDown(); }}
      />
    );
  }

  if (shell === null) {
    /* Nothing has been asked yet, and no guessing: a window that guesses at this moment is a
       window that guesses wrong on a slow first launch. The same surface the opening state below
       draws — the skeleton behind its grace, the boot line at the rail's foot — with no phase,
       because no phase has been read. In the packaged app this frame lasts one status call; on a
       dev server it is replaced by the chooser before either grace elapses. */
    return (
      <div className="gate gate-boot">
        <BootSkeleton active rail />
        <BootStatus sentence={DOOR_COPY.gateOpening} />
      </div>
    );
  }

  if (gate.kind === "notice" && !pairingHeld) {
    /* The same card the boot check and the error boundary draw — one apology, three ways of
       reaching it, differing only in the sentence and the button. See `GateNotice.tsx`.

       A STRUCTURED failure never renders its log line: `failureClass` picks the person's
       sentence (`doors.ts#failureClassOf` is where the class is read). For the locked store the
       press that helps is removing the leftover lock. The shell keeps a lock whose process is
       still running — after a restart, the previous copy's engine — and the card says so; the
       refresh after the press paints whatever the restart then says. */
    if (gate.failureClass === "LocalStoreOpenError") {
      return <StartOverNotice onSettled={() => void refresh()} />;
    }
    /* THE KEY STORE WOULD NOT ANSWER. Its own card: a keyring is the fact, the platform's store
       and the remedy are the sentence, and Try again reads the store again (`Shell::retry`
       re-plans from `NoKey`). The library's error stays in the log. */
    if (gate.keyring === true) {
      return <KeyringNotice onSettled={() => void refresh()} />;
    }
    if (gate.failureClass === "DataDirLockedError") {
      return <UnlockNotice onSettled={() => void refresh()} />;
    }
    /* EVERY OTHER GIVEN-UP ENGINE IS RESTARTED BY THE PRESS; a card with no engine behind it (an
       unreachable shell, a build without one) can only ask again, and its label says so. */
    const givenUp = shell.kind === "status" && shell.status.state === "failed";
    if (gate.failureClass !== undefined || givenUp) {
      return (
        <RetryNotice
          reason={gate.failureClass !== undefined ? DOOR_COPY.gateEngineReported(gate.failureClass) : gate.reason}
          onSettled={() => void refresh()}
        />
      );
    }
    return (
      <GateNotice
        reason={gate.reason}
        actionLabel={DOOR_COPY.gateReadAgain}
        onAction={() => void refresh()}
      />
    );
  }

  /* The one path the shell reads the operator's certificate authority from, for both choosers. */
  const caFile = shell?.kind === "status" ? shell.status.operatorCaFile ?? null : null;

  if (gate.kind === "choose" || adoptionHeld || pairingHeld) {
    const listedOn = signedOutFrom === null ? null : listedOnLabel(signedOutFrom);
    /* The waiting changes first, the still-listed session after: both are said when both apply. */
    const left = [
      signedOutWaiting === null ? null : DOOR_COPY.changesWaiting(signedOutWaiting.count, signedOutWaiting.who, machineWord()),
      listedOn === null ? null : DOOR_COPY.signedOutStillListed(machineWord(), listedOn),
    ].filter((line): line is string => line !== null);
    const forgetSignOut = (): void => { setSignedOutFrom(null); setSignedOutWaiting(null); };
    return (
      <DoorChooser
        addressless
        operatorCaFile={caFile}
        notice={left.length === 0 ? null : left.join(" ")}
        onAdoption={(holding) => { forgetSignOut(); setAdoption(holding); }}
        onPairing={() => { forgetSignOut(); setPairing("held"); }}
        onEntered={(r) => {
          forgetSignOut();
          /* A pairing's answer re-keys the auth answer whatever it carries: the hold ends on the
             reading of the engine that answered, never on one earned before the press. Updaters,
             not this render's `pairing`: the chooser calls the `onEntered` of the render it pressed in. */
          setPairing((held) => (held === "held" ? "entered" : held));
          setAuthEpoch((n) => n + 1);
          /* THE FIRST LAUNCH'S CHOOSER, and the standalone door's only way into guided setup.
             See {@link openSetupOnStandalone}. */
          openSetupOnStandalone(r.status ?? null);
          if (r.status) onStatus(r.status);
          else void refresh();
        }}
      />
    );
  }

  const status = shell.kind === "status" ? shell.status : null;
  /* A door to the person's own server signs in there, never to ohmail Cloud. */
  const ownServer = flavorOf(status) === "selfhost" && status?.cloudUrl && status.address
    ? { base: status.cloudUrl, address: status.address }
    : null;
  /* THE CHANGES THIS ACCOUNT LEFT WAITING HERE, for the two sign-in surfaces below: the engine's
     count of its own owner's kept writes, read in the same `/health` answer that opens the card. */
  const waitingWho = status === null ? null : waitingFor(status);
  const waitingNotice = hostedAuthKnown && hostedAuth.queued > 0 && waitingWho !== null
    ? DOOR_COPY.changesWaiting(hostedAuth.queued, waitingWho, machineWord())
    : null;

  /**
   * THE DOOR OVERLAY, BUILT ABOVE THE EARLY RETURNS — because one of them needs it.
   *
   * It used to be composed at the bottom of this component, under the mail client, and the
   * revoked-pairing branch below returns long before that: its two buttons set this state and
   * the person stayed on the same card, with nothing on screen having changed. One element,
   * rendered by whichever branch is on screen, is what makes a press lead to its door.
   */
  const hostLabel = pairedHostOf(status);
  const doorOverlay = overlay ? (
    /* OVER the client, not under it. `.gate` is a full-height flow element — correct when it
       IS the window, wrong when the mail is already on screen behind it, where it would
       simply render below the fold. The wrapper takes it out of flow and puts it above the
       command palette (`--z-pal`) and below the toasts, which is where a modal setup step
       belongs: nothing in the app should be reachable while it is open, and a toast it
       produces still has to be readable over it. Inline because it is the only element in
       either product that needs it. ONE KEY in every branch that renders it: React keeps a keyed
       child across branches whatever its position, so a door attempt that re-keys the gate never
       remounts the door (and empties the link typed into it). */
    <div
      key="door-overlay"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 85,
        overflowY: "auto",
        background: "var(--canvas)",
      }}
    >
    <DoorChooser
      start={overlay}
      operatorCaFile={caFile}
      /* "Sign in again" is not "choose the cloud door again": the door is already chosen, and
         re-configuring it would replace the engine — taking somebody's mail off the screen
         for the length of a restart to change nothing. */
      /* THE SAME DISTINCTION FOR THE PAIRED DOOR. `"host"` here means "pair again with the
         computer this install already reads through", which is two requests against the
         running engine; the chooser's default would reconfigure and give `enforceMirrorOwner`
         grounds to discard the copy the Settings row promises is kept. */
      cloudAction={overlay === "cloud" || overlay === "host" ? "signIn" : "configure"}
      /* THE MAILBOXES THE OTHER COMPUTER HELD, captured at the press and BEFORE this overlay
         changes anything — see `beginTakeover`. Three states, three sentences; `null` is a
         read that failed and must never render as an empty list. */
      {...(overlay === "takeover" ? { roster: takeoverRoster, host: hostLabel } : {})}
      onCancel={() => {
        /* CANCEL IS NOT "NOTHING HAPPENED". A door attempt inside this overlay may have
           already REPLACED the engine (`engine_configure` runs before the credential
           step) without reaching `onEntered`, so the epoch never moved and the stored
           /health answer describes the PREVIOUS engine. Closing the overlay is the reveal
           moment, so the EPOCH advances here — clearing the stored answer is not enough,
           because a probe already in flight holds the OLD key in its closure and a late
           old-engine answer would re-store under a still-current key. The bump re-keys
           the gate, retires both probe effects and withholds the app until the engine
           actually behind the bridge gives its own first /health. `refresh()` re-reads
           the shell: the door state itself may have moved under an abandoned attempt. */
        setAuthEpoch((n) => n + 1);
        setOverlay(null);
        /* A pairing still provisional when its card is left is undone: only an accepted one keeps
           its door. Nothing provisional, nothing changed. */
        void restorePairingSwitch().catch(() => undefined).finally(() => void refresh());
      }}
      onEntered={(r) => {
        /* THE SETTINGS OVERLAY, which is where a mailbox is CONNECTED AGAIN after a removal
           — the same act as the first launch's connect, so it opens setup on the same rule.
           A cloud entry here answers `null` at the door rule and navigates nowhere.

           EXCEPT AFTER A TAKEOVER. The guided setup walks somebody through consenting to
           organize a mailbox as if it were new, and this one is not: its rules and its
           consent travel in the mailbox itself, the profile-import card is what asks about
           them, and the peek that names who held it last is on the Mailboxes pane rather
           than on that stage. Sending somebody through the from-scratch walk here would ask
           them to answer questions they already answered on the other computer. */
        if (overlay === "takeover") goSettings("mailboxes");
        else openSetupOnStandalone(r.status ?? null);
        if (r.status) onStatus(r.status);
        else void refresh();
      }}
    />
    </div>
  ) : null;

  /* THE HOSTED SESSION ENDED under a window that was already serving mail. Say so, in a
     sentence, and offer the way back — never a mailbox that silently stopped moving. The
     mirrored mail is kept on disk (sign-out freezes the directory) and returns with the
     sign-in. */
  /* THE CLOUD DOOR'S AUTH STATE IS PENDING: the CURRENT engine's first answer has not landed —
     withhold the mail app (React would commit it once over an engine whose mail routes
     refuse) and draw THE SAME whole-window frame every other boot branch draws. THE FULL
     GEOMETRY, NOT ROWS ALONE: on a cold start this branch covers the engine's whole climb,
     and a bare `<BootSkeleton active />` was the 0.12.0 boot frame — full-width rows with no
     rail and no wrapper, matching no window this app has shown. The rail's EXISTENCE is
     certain at boot, so every boot branch carries the three-column silhouette, JSX-identical
     to its neighbours so React reconciles them as one element and the grace runs once. A
     healthy relaunch resolves inside the grace and nothing is drawn. */
  if (authKey !== null && !hostedAuthKnown) {
    return (
      <>
        <div className="gate gate-boot">
          <BootSkeleton active rail />
          <BootStatus phase={status?.bootPhase} applied={status?.bootApplied} pending={status?.bootPending} />
        </div>
        {/* AND THE DOOR SOMEBODY IS STANDING IN, KEPT. This branch is reached DURING a door
            attempt — the attempt replaces the engine, the delivered lifecycle move re-keys the
            auth answer, and the withheld app is this frame. The overlay's key is what keeps React
            from remounting it here: measured, a remount empties the pairing link already typed. */}
        {doorOverlay}
      </>
    );
  }

  /* THE HOSTED ACCOUNT WAS DELETED. Before the sign-in and the mail client, because it is
     neither: a mailbox drawn here is empty and stopped, and a sign-in asks for an account that
     no longer exists. One way on — this computer on its own, straight to the mail server. The
     engine has already discarded the session and asks the hosted API nothing more. Before the
     relaunch card too, which the erasure's staged discard also raises. */
  if (erased) {
    return (
      <>
        <GateNotice
          reason={DOOR_COPY.gateAccountErased(machineWord())}
          actionLabel={DOOR_COPY.gateOwn}
          onAction={() => setOverlay("local")}
        />
        {doorOverlay}
      </>
    );
  }

  /**
   * ═══ A PAIRING THAT WORKED AND IS WAITING FOR A RELAUNCH ══════════════════════════════
   * FIRST, by design: its `/health` shape (`signedIn:false, sessionExpired:false`) is
   * byte-for-byte the `preAuth` arm's — placed after it, this branch would be correct,
   * unreachable and invisible, and the window would draw the hosted PASSWORD FORM at the
   * exact moment a pairing succeeded (or, via `sessionExpired`, claim "no longer paired").
   * NO BUTTON — nothing here can restart the app, so the card says quit and reopen. NOT
   * `GateNotice`: its "cannot open your mailbox" and "Your mail is untouched" are both false
   * here — the pairing SUCCEEDED and the previous copy is deliberately replaced. Only the
   * erased card stands before it: an erasure raises `restartRequired` too.
   */
  if (hostedRestartRequired) {
    return (
      <div className="gate">
        <div className="gate-card">
          <span className="wordmark"><b>ohmail</b><em>.</em></span>
          <h1>{DOOR_COPY.gateRestartTitle}</h1>
          <p>{DOOR_COPY.gateRestart(hostLabel ?? DOOR_COPY.doorHostName)}</p>
        </div>
      </div>
    );
  }

  /* A PRE-AUTH cloud engine under a configured door: the sign-in surface, plainly — the app
     would render mail routes that refuse. (The expiry branch below carries the sentence.) A PAIRED
     door has no Cloud account to sign in to: a pairing that did not finish lands on the Not-paired
     card and its two remedies, with the door it opens kept over it. */
  if (hostedPreAuth && !hostedSessionGone && paired) {
    return (
      <>
        <div className="gate">
          <UnpairedCard host={hostLabel} notice={waitingNotice} onPairAgain={() => setOverlay("host")} onOwn={beginTakeover} removed={copyRemoved} />
        </div>
        {doorOverlay}
      </>
    );
  }
  if (hostedPreAuth && !hostedSessionGone) {
    return (
      <DoorChooser
        start={ownServer ? "server" : "cloud"}
        server={ownServer}
        cloudAction="signIn"
        signInCause={signInCauseOf(hostedAuth?.session ?? null)}
        notice={waitingNotice}
        onEntered={(r) => {
          /* Back to PENDING, never to "signed in": the fresh probe against the engine the
             sign-in just touched is the only thing allowed to say what its session is. The
             EPOCH bump (not a bare clear) also retires any probe already in flight against the
             old engine — a late answer under a still-current key would re-store the stale
             state. `onStatus` bumps again for its own reason; a double bump is two re-keys and
             costs nothing. */
          setAuthEpoch((n) => n + 1);
          if (r.status) onStatus(r.status);
          else void refresh();
        }}
      />
    );
  }

  /**
   * THE FINISHED SENTENCE, or `undefined` when there is nothing wrong to say.
   *
   * `undefined` covers three situations on purpose — not paired, not asked yet, and answering
   * normally — because a line that said "reachable" would stand in the rail for ever and make the
   * one state worth noticing a change of wording rather than the arrival of a warning.
   */
  const hostConnection: HostConnection | undefined = ((): HostConnection | undefined => {
    if (!paired || freshness === null || hostLabel === null) return undefined;
    const settingsLink = { href: "#/settings/desktop", label: DOOR_COPY.hostFootSettings };
    const check = pairedViaOf(status) === "lan"
      ? DOOR_COPY.hostCheckLan(machineWord())
      : DOOR_COPY.hostCheckTs;
    if (freshness.state === "stale") {
      return {
        state: "stale",
        words: {
          title: DOOR_COPY.hostFootStale(hostLabel),
          /* THE AGE, AS "3 days ago" AND NOT AS A CLOCK TIME. `waterlineStamp`'s "Mon 18:40" goes
             ambiguous after six days, which is exactly the span a machine somebody has stopped
             using sits in; and a DURATION ("for 3 days") says nothing about when it last worked.
             `asOf` is non-null on this arm by the freshness contract; the fallback is unreachable
             rather than load-bearing. */
          detail: DOOR_COPY.hostFootStaleWhy(
            freshness.asOf ? agoStamp(freshness.asOf, Date.now()).rel : "",
            machineWord(),
          ),
          link: settingsLink,
        },
      };
    }
    /* `unknown`, and only once it has been unknown long enough to mean something. Below the grace
       this returns `undefined` and the window says nothing — which is right for the first seconds
       of every successful pairing, when `unknown` is simply "the first pull has not landed yet". */
    if (freshness.state === "unknown" && unknownSpeaks(firstUnknownAt.current, Date.now())) {
      return {
        state: "unknown",
        words: { title: DOOR_COPY.hostFootUnknown(hostLabel), detail: check, link: settingsLink },
      };
    }
    return undefined;
  })();

  /* ONE READING, THREE READERS (`sessionReaders`): the sign-in card, the rail's line and the sync
     strip all key on the engine's session reading, never on this window's pull — on both doors.
     The rail line is for a session that is still there; the paired door's own line (the other
     computer not answering) says that there, so the Cloud wording stays off it. */
  const readers = door === "cloud" && hostedAuthKnown
    ? sessionReaders(hostedAuth.session, hostedAuth.gone, hostedAuth.noticeDue, isManagedDoor(status))
    : null;
  const cloudConnection = paired ? undefined : readers?.rail;
  const railConnection = hostConnection ?? cloudConnection;
  /* A REFUSED SESSION: a card OVER the mail, its first sentence the cause; the mail on screen is
     real and stays. The doors differ only in the way back in: Cloud signs in inside the card; a
     paired install was removed on the other computer, so it pairs again or sets up on its own
     (opposite remedies, both offered) through a door opened over the card, which yields while
     that door is open and returns if it is cancelled. With no pull of this launch finished the
     window holds no mail (a signed-out engine refuses reads), so the card stands on the window's
     own page, as at launch, rather than over an empty list. */
  const overMail = mount.kind === "engine" && live?.key === mount.key && live.engine.drainsCompleted() > 0;
  const layer = overMail ? "session-end" : "session-end session-whole";
  const refusedCard = readers === null || readers.card === "closed" || overlay !== null ? null : paired ? (
    <RefusedLayer className={layer} label={DOOR_COPY.credHostOutValue}>
      <UnpairedCard host={hostLabel} notice={waitingNotice} onPairAgain={() => setOverlay("host")} onOwn={beginTakeover} causeId={REFUSED_CAUSE} removed={copyRemoved} />
    </RefusedLayer>
  ) : (
    <RefusedLayer className={`${layer} session-signin`} label={ownServer ? DOOR_COPY.doorServerName : DOOR_COPY.cloudTitle}>
      <DoorChooser
        start={ownServer ? "server" : "cloud"}
        server={ownServer}
        cloudAction="signIn"
        signInCause={readers.card}
        causeId={REFUSED_CAUSE}
        notice={waitingNotice}
        onEntered={(r) => {
          /* Back to PENDING: only the fresh probe against the engine the sign-in touched says
             what its session is now (the pre-auth branch's reason). */
          setAuthEpoch((n) => n + 1);
          if (r.status) onStatus(r.status);
          else void refresh();
        }}
      />
    </RefusedLayer>
  );

  const suggestDoor = suggestDoorFor(status, hostedSession);

  /* Null on the one render where the engine has just been asked for and the state that holds it
     has not caught up. React re-renders before painting, so that render is never seen; it still
     has to draw something, and the honest something is the line below. */
  const engine = mount.kind === "engine" && live?.key === mount.key ? live.engine : null;
  /* The mailbox this render is for, captured beside the engine so the shell's key below is
     the same id the engine and the storage partition were chosen by. Narrowed here rather
     than at the render, where the early return has already made it non-null in fact but not
     in the type. */
  const shellKey = mount.kind === "engine" ? mount.key : "opening";

  /* THE COPY WAS REMOVED: the card on the window's own page and nothing behind it — the mail it
     would draw is gone from this computer. The door a press opens stands where the card stood. */
  if (copyRemoved) {
    return (
      <>
        {refusedCard}
        {doorOverlay}
      </>
    );
  }

  if (engine === null) {
    /* A door is chosen and no engine has served yet — a first launch migrating a database,
       or an engine on its way back up. No mail: the only alternative is a guess about
       somebody's own mailbox. `BootSkeleton` is `mailMount`'s answer drawn out, never a
       second opinion: it carries no text and nothing derived from any mailbox — a shape is
       not invented mail for exactly as long as there is nothing in it — and it is delayed
       behind its own grace, so the ordinary launch stays a quiet frame; the wait it exists
       for is the one-off recovery launch (`SETTLE_MS` in `doors.ts`). The words sit at the
       foot of the rail where the sync line will sit: `BootStatus` renders the engine's own
       `status.bootPhase` ("Replaying recent changes…"); the settling poll refreshes it. An account
       door whose engine names no mailbox and answers offline says its server is not answering. */
    const outage = unnamed === "unreachable"
      ? { sentence: isManagedDoor(status) ? DOOR_COPY.cloudUnreachableTitle : DOOR_COPY.serverUnreachableTitle }
      : {};
    return (
      <div className="gate gate-boot">
        <BootSkeleton active rail />
        <BootStatus phase={status?.bootPhase} applied={status?.bootApplied} pending={status?.bootPending} {...outage} />
      </div>
    );
  }

  /* The Cloud door's account has not been read on this mailbox yet: the wordmark, and nothing
     that could be somebody's mail, until the answer or its bound. */
  if (firstPaint === "asking") {
    return (
      <div className="gate" aria-busy="true">
        <div className="gate-card">
          <span className="wordmark"><b>ohmail</b><em>.</em></span>
          <Spinner className="mbx-spin" />
        </div>
      </div>
    );
  }

  return (
    <>
      <ConnectionValue feed={connectionFeed} value={railConnection ?? null} />
      {status === null ? (
        <div className="gate gate-boot">
          <BootSkeleton active rail />
        </div>
      ) : (
        /**
         * KEYED BY THE MAILBOX, so a mailbox change REMOUNTS the engine's provider and everything under it.
         * Partitioning the storage was half of it: today's views hold the compose form in React state and load the
         * scratch in a mount effect, so without a key React preserves them across a mailbox switch: the owner moves to
         * B while mailbox A's recipients, subject and body sit in state, and the next autosave writes them into B's
         * partition or a press sends them under B's identity. `mount.key` is the same id the partition and the engine
         * are chosen by, so all three change together. On the outermost element, so B's frame never mounts for one
         * commit over A's engine.
         */
        <EngineProvider key={shellKey} demo={false} engine={engine}>
          <DesktopFrame
            engine={engine}
            status={status}
            session={hostedSession}
            /* THE CONNECTION NOTICE YIELDS for a refused session: the card says why. */
            sessionRefused={readers !== null && !readers.strip}
            sealFailed={hostedSealFailed}
            paired={paired}
            hostLabel={hostLabel}
            freshness={freshness}
            account={hostedAccountId}
            storage={accountDoor ? storage : null}
            mayLinkOut={mayLinkOut}
            manageOffered={manageOffered}
            withdrawManage={withdrawManage}
            rereadAccess={rereadAccess}
            reuseSweeps={accountDoor ? reuseSweeps : NO_SWEEPS}
            recheckSweeps={recheckHostedSession}
            ai={ai}
            setAi={setAi}
            onStatus={onStatus}
            openOverlay={setOverlay}
            takeOver={beginTakeover}
            firstRunOpen={routeNow.firstRun}
            firstRun={firstRun}
            takesMailLinks={!isPreview()}
            scope={shellKey}
            liveNoticeScope={storageOwner}
            onUnread={onUnread}
            liveBody={liveBodyOverBridge}
            links={links}
            connection={connectionFeed}
          />
        </EngineProvider>
      )}
      {doorOverlay}
      {refusedCard}
      <ScopeShown scope={shellKey} cloud={status?.mode === "cloud"} into={served} />
    </>
  );
}

/**
 * THE MAILBOX ON SCREEN, recorded once its shell is drawn, and kept across launches on a Cloud door.
 * Never from `live`: that client is built before the session is read, so a launch that shows only a
 * revoke's card would record a mailbox it never showed, over the one whose keys are owed.
 */
/** Two readings of the other computer's silence are one when they say the same. */
function sameConnection(a: HostConnectionState | null, b: HostConnectionState | null): boolean {
  if (a === null || b === null) return a === b;
  return a.state === b.state && a.words.title === b.words.title && a.words.detail === b.words.detail
    && a.words.link?.href === b.words.link?.href && a.words.link?.label === b.words.link?.label;
}

const NO_SWEEPS: readonly never[] = [];

/** Feeds the frame's signal with the gate's reading, after each render that changed it. */
function ConnectionValue({ feed, value }: { feed: ReturnType<typeof createFeed<HostConnectionState | null>>; value: HostConnectionState | null }) {
  useLayoutEffect(() => feed.set(value), [feed, value]);
  return null;
}

function ScopeShown({ scope, cloud, into }: {
  scope: string; cloud: boolean; into: { current: { scope: string; cloud: boolean } | null };
}) {
  useEffect(() => {
    into.current = { scope, cloud };
    if (cloud) rememberCloudScope(scope);
  }, [scope, cloud, into]);
  return null;
}

/** The id of the refused card's first sentence, which describes its dialog. One card is up at a time. */
const REFUSED_CAUSE = "session-end-cause";

/**
 * THE REFUSED CARD CLAIMS THE WINDOW while it is up: everything beside it, up to the body, is
 * inert (no Tab, press or reader reaches the mail behind the scrim), and focus goes back where it
 * stood when the card closes. The card itself takes focus on arrival. A layout effect, so it reads
 * the focus before the card's own effect moves it.
 */
function RefusedLayer({ className, label, children }: { className: string; label: string; children: ReactNode }) {
  const layer = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const stood = document.activeElement;
    const held: Array<[Element, boolean]> = [];
    for (let at: HTMLElement | null = layer.current; at && at !== document.body; at = at.parentElement) {
      for (const sib of Array.from(at.parentElement?.children ?? [])) {
        if (sib === at) continue;
        held.push([sib, sib.hasAttribute("inert")]);
        sib.setAttribute("inert", "");
      }
    }
    return () => {
      for (const [el, was] of held) if (!was) el.removeAttribute("inert");
      if (stood instanceof HTMLElement && stood !== document.body && stood.isConnected) stood.focus();
    };
  }, []);
  return (
    <div ref={layer} className={className} role="dialog" aria-modal="true" aria-label={label} aria-describedby={REFUSED_CAUSE}>
      {children}
    </div>
  );
}

/**
 * "Not paired", the other computer named, and the two remedies: pair again, or stand alone.
 * `removed`: the pairing was revoked there, and the engine removed this computer's copy.
 */
function UnpairedCard({ host, notice = null, causeId, removed = false, onPairAgain, onOwn }: {
  host: string | null; notice?: string | null; causeId?: string; removed?: boolean; onPairAgain: () => void; onOwn: () => void;
}) {
  const card = useRef<HTMLDivElement | null>(null);
  useEffect(() => focusFirstControl(card.current), []);
  const other = host ?? DOOR_COPY.doorHostName;
  return (
    <div className="gate-card" ref={card}>
      <span className="wordmark"><b>ohmail</b><em>.</em></span>
      <h1>{DOOR_COPY.credHostOutValue}</h1>
      <p id={causeId}>{removed ? DOOR_COPY.gateUnpairedRemoved(machineWord(), other) : DOOR_COPY.gateUnpaired(machineWord(), other)}</p>
      {notice ? <div className="join-note" role="status">{notice}</div> : null}
      <div className="gate-actions">
        <Button onClick={onPairAgain}>{DOOR_COPY.gatePairAgain}</Button>
        <Button variant="ghost" onClick={onOwn}>{DOOR_COPY.gateOwn}</Button>
      </div>
    </div>
  );
}

/**
 * WHAT THE ICON SAYS. One sink for the client's unread count: the DOCK BADGE is the count itself,
 * set on change and removed at zero (a badge reading "0" says what taking it off already says).
 * The notices are not drawn here: the one caller (`use-notices`) asks the gate and hands this
 * window's emitter (`notice-emitter.ts`) what may be drawn.
 */
function useUnreadSink(): (unread: number) => void {
  return useCallback((unread: number) => {
    /* Swallowed rather than reported: a platform that cannot draw a badge (Windows carries an
       overlay icon instead) must not leave an unhandled rejection behind a piece of decoration.
       The BADGE is deliberately outside the notification switches: it is a number on an icon the
       user is already looking at, not an interruption, and turning notifications off should not
       cost somebody their unread count. */
    void setBadge(unread).catch(() => {});
  }, []);
}

/**
 * WHAT A MENU COMMAND DOES — every one of them is something the client already does. Three
 * of the five are routes and take `go`, as the navigation items do. The palette and the
 * shortcut sheet are state inside `AppShell`, which this file must stay outside of — so they
 * are DELIVERED AS THE KEYSTROKE THE CLIENT ALREADY BINDS: the shared keymap is one
 * `keydown` listener on `document`, and a dispatched event reaches it exactly as a typed one
 * does, so ⌘K from the menu runs the same binding as ⌘K from the keyboard — and an
 * accelerator the platform swallowed is handed back to the page rather than lost. `bubbles`
 * because the listener is on `document`; `cancelable` because the binding calls `preventDefault()`.
 */
export function runMenuCommand(command: MenuCommand): void {
  switch (command) {
    case "compose":
      goCompose(() => go("compose"));
      return;
    case "settings":
      go("settings");
      return;
    case "search":
      go("search");
      return;
    case "palette":
      typeKey({ key: "k", metaKey: true });
      return;
    case "shortcuts":
      typeKey({ key: "?", shiftKey: true });
      return;
  }
}

function typeKey(init: KeyboardEventInit): void {
  if (typeof document === "undefined") return;
  document.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
}

/**
 * AN ENGINE THE SHELL GAVE UP ON, for every class without a card of its own. The press restarts
 * it through `engine_retry`, which removes nothing; a refused press says so.
 */
function RetryNotice({ reason, onSettled }: { reason: string; onSettled: () => void }) {
  const [refused, setRefused] = useState(false);
  const [pressing, setPressing] = useState(false);
  const press = (): void => {
    if (pressing) return;
    setPressing(true);
    void engineRetry()
      .then(() => setRefused(false), () => setRefused(true))
      .finally(() => {
        setPressing(false);
        onSettled();
      });
  };
  return (
    <GateNotice reason={reason} actionLabel={DOOR_COPY.gateTryAgain} onAction={press}>
      {refused ? <p role="alert">{DOOR_COPY.gateRetryRefused}</p> : null}
    </GateNotice>
  );
}

/**
 * THE KEY STORE'S CARD, with the press that asks it again. A store that still refuses answers
 * `no_key` once more, said under the button; one that answers now leaves this card for whatever
 * the engine does next. A refused press says the retry's own sentence.
 */
function KeyringNotice({ onSettled }: { onSettled: () => void }) {
  const [said, setSaid] = useState<"still" | "refused" | null>(null);
  const [pressing, setPressing] = useState(false);
  const press = (): void => {
    if (pressing) return;
    setPressing(true);
    void engineRetry()
      .then((status) => setSaid(status?.state === "no_key" ? "still" : null), () => setSaid("refused"))
      .finally(() => {
        setPressing(false);
        onSettled();
      });
  };
  return (
    <GateNotice
      title={DOOR_COPY.gateKeyringTitle}
      reason={keyringSentence(BUILD_PLATFORM)}
      actionLabel={DOOR_COPY.gateTryAgain}
      onAction={press}
    >
      {said === "still" ? <p role="alert">{DOOR_COPY.gateKeyringStillLocked}</p> : null}
      {said === "refused" ? <p role="alert">{DOOR_COPY.gateRetryRefused}</p> : null}
    </GateNotice>
  );
}

/**
 * A LOCKED LOCAL STORE — `DataDirLockedError` in the sidecar. The press removes a torn record or a
 * dead process's lock and starts the engine; a lock whose process is still running is kept. A
 * refused press says why under the button instead of leaving the card looking unpressed, and only
 * a running holder is told as another copy (`unlockRefusal`).
 */
function UnlockNotice({ onSettled }: { onSettled: () => void }) {
  const [refused, setRefused] = useState<UnlockRefusal | null>(null);
  const [pressing, setPressing] = useState(false);
  const press = (): void => {
    if (pressing) return;
    setPressing(true);
    void engineUnlockRetry()
      .then(() => setRefused(null), (err: unknown) => setRefused(unlockRefusal(err)))
      .finally(() => {
        setPressing(false);
        onSettled();
      });
  };
  return (
    <GateNotice reason={DOOR_COPY.gateLockedStore} actionLabel={DOOR_COPY.gateUnlockRetry} onAction={press}>
      {refused !== null ? <p role="alert">{unlockSentence(refused)}</p> : null}
    </GateNotice>
  );
}

/** The sentence under the unlock button, read at render so the catalogue's language applies. */
function unlockSentence(refused: UnlockRefusal): string {
  switch (refused) {
    case "held":
      return DOOR_COPY.gateUnlockRefused;
    case "noEngine":
      return DOOR_COPY.gateUnlockNoEngine;
    case "noAnswer":
      return DOOR_COPY.gateUnlockNoAnswer;
    case "other":
      return DOOR_COPY.gateRetryRefused;
  }
}

/**
 * A STORE THE ENGINE CANNOT OPEN — `LocalStoreOpenError` in the sidecar. Quitting reruns the same
 * open, so the card offers the one press that changes something: the shell sets the store aside
 * and starts the engine. A refused press says so rather than leaving the card as it was.
 */
function StartOverNotice({ onSettled }: { onSettled: () => void }) {
  const [refused, setRefused] = useState(false);
  const [pressing, setPressing] = useState(false);
  const press = (): void => {
    if (pressing) return;
    setPressing(true);
    void engineStartOver()
      .then(() => setRefused(false), () => setRefused(true))
      .finally(() => {
        setPressing(false);
        onSettled();
      });
  };
  return (
    <GateNotice reason={DOOR_COPY.gateStoreUnopenable} actionLabel={DOOR_COPY.gateStartOver} onAction={press}>
      {refused ? <p role="alert">{DOOR_COPY.gateStartOverRefused}</p> : null}
    </GateNotice>
  );
}
