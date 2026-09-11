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
 * chrome is wired here too (menu, badge, notification — only this build has them); the menu
 * drives `go()`, the same function the rail, palette and number keys call.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { OhmailEngine } from "@ohmail/client-engine";

import { AppShell } from "../../webapp/app/shell/AppShell";
import { setStorageOwner } from "../../webapp/app/shell/storage-owner";
import { BootSkeleton } from "../../webapp/app/shell/BootSkeleton";
import { go, goFirstRun, goSettings, useHashRoute } from "../../webapp/app/shell/routing";
import { setMailtoSink } from "../../webapp/app/shell/open-external";
import { agoStamp } from "../../webapp/app/shell/format";
import {
  unknownSpeaks, type HostConnection,
} from "../../webapp/app/shell/host-connection";
import { BootStatus } from "./BootStatus.js";
import { bridgeAvailable, bridgeFetch } from "./bridge-fetch.js";
import { DoorChooser } from "./DoorChooser.js";
import { DesktopAbout } from "./DesktopAbout.js";
import { DesktopMailboxes, readMirrorFreshness } from "./DesktopMailboxes.js";
import { readMailboxFacts } from "./local-mailbox-facts.js";
/* The OS-answer reader this window has to bring itself — see the injection below. */
import { desktopNotificationHost } from "./notify-host.js";
import { DesktopScreening } from "./DesktopScreening.js";
import { GateNotice } from "./GateNotice.js";
import { DOOR_COPY, machineWord } from "./door-copy.js";
import { desktopPaneLabel, DesktopSettings } from "./DesktopSettings.js";
import { DesktopAiAccount } from "./DesktopAiAccount.js";
import { DesktopSubscription, useDesktopManageLink } from "./DesktopSubscription.js";
import { DesktopWebSection } from "./DesktopWebSection.js";
import {
  accountDoorFor, awayDoorFor, consentDoorFor, firstRunDoorFor, gateFor, hostLabelOf,
  hostDoorFor, hostViaOf, isDesktopHost, mailMount, profileImportDoorFor, readShell,
  suggestDoorFor, type HostedSession, type Shell,
} from "./doors.js";
import { DesktopDevices } from "./DesktopDevices.js";
import { awayOverBridge } from "./local-away.js";
import { organizerNoticeOverBridge } from "./local-organizer-notice.js";
import { profileImportOverBridge } from "./local-profile-import.js";
import { consentOverBridge, consentOverBridgeStandalone } from "./local-consent.js";
import { olderBodyOverBridge } from "./local-older-body.js";
import { junkOverBridge } from "./local-junk.js";
import { trashOverBridge } from "./local-trash.js";
import { cloudSuggestWire } from "./cloud-suggest.js";
import { readAiStatus, type LocalAiStatus } from "./local-ai.js";
import { AiProviderForm } from "./AiProviderForm.js";
import { useLocalFirstRun } from "./local-first-run.js";
import { LocalSuggest } from "./local-suggest.js";
import { CloudSuggest } from "./CloudSuggest.js";
import {
  claimMailto, postOsNotice, onMailto, onMenuCommand, onMenuNavigate, setBadge, type MenuCommand,
} from "./native.js";
import { decideNotices } from "@ohmail/client-engine";
import { readChannels } from "../../webapp/app/shell/notification-settings";
import { parseMailto, type MailtoDraft } from "./mailto.js";
import { DefaultMailAsk, DefaultMailRow } from "./DesktopDefaultMail.js";
import { createLocalEngine, type EngineStatus } from "./bridge-fetch.js";

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
 * finished mailbox derives to `null` and `FirstRun` renders nothing — no blank overlay. The
 * hosted door is excluded structurally: `firstRunDoorFor` answers `null` there.
 */
function openSetupOnStandalone(status: EngineStatus | null): void {
  if (firstRunDoorFor(status) !== "local") return;
  /* BEFORE the status is delivered, so the first render of `AppShell` already carries the route
     and the person does not see one frame of the Ohbox before the stage arrives. */
  goFirstRun();
}

export function DesktopGate() {
  const [shell, setShell] = useState<Shell | null>(null);
  /* The door chooser, opened from Settings over a working install. Distinct from the chooser a
     fresh install lands on: this one is cancellable, because there is something to go back to. */
  const [overlay, setOverlay] = useState<null | "doors" | "cloud" | "host" | "takeover">(null);

  const refresh = useCallback(async () => {
    setShell(await readShell());
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /* Re-ask while the engine is coming up, and not otherwise. A permanent poll would be four
     inter-process calls a second for the life of the app to learn nothing; a poll that never
     runs would leave "Starting…" on screen after the engine had started. While it runs it is
     also what carries the engine's boot narration (`status.bootPhase`) onto the screen. */
  const settling =
    shell?.kind === "status" && (shell.status.state === "starting" || shell.status.state === "restarting");
  useEffect(() => {
    if (!settling) return;
    const timer = setInterval(() => void refresh(), SETTLING_POLL_MS);
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
  const [mailtoDraft, setMailtoDraft] = useState<MailtoDraft | null>(null);
  useEffect(() => {
    /* ONE READING OF A MAILTO, TWO ORIGINS. The OS hands one to the shell and this window
       claims it; the window's own link seam hands one straight over. Both go through
       `parseMailto` and both land in the same state, so a link clicked in a message and a link
       clicked in another application cannot open different compose forms. */
    const seed = (raw: string): void => {
      const draft = parseMailto(raw);
      if (draft) setMailtoDraft(draft);
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

  const onStatus = useCallback((next: EngineStatus) => {
    setShell({ kind: "status", status: next });
    setOverlay(null);
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
  /* WHERE THE APP IS, for the one-ask rule below — the SAME hash route `AppShell` gates the
     first-run stage on, so the flow being open and this prompt waiting cannot disagree. A hook,
     so it belongs up here with `onUnread` for the reason that comment gives. */
  const routeNow = useHashRoute();

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
  const [hostedAuth, setHostedAuth] = useState<
    { key: string; gone: boolean; preAuth: boolean; restartRequired: boolean } | null
  >(null);
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
      : hostedAuth.gone || hostedAuth.preAuth
        ? "out"
        : "live";
  const [signInAfterExpiry, setSignInAfterExpiry] = useState(false);

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
   * WHERE THIS ACCOUNT MANAGES ITS SUBSCRIPTION — `null` where no page is served. Read in the
   * GATE, not inside the pane: `SettingsView` grows the nav entry from the prop's presence,
   * so withholding the entry means withholding the node. UP HERE with the unconditional
   * hooks — everything below the mount switch sits behind an early return, and a hook below
   * one renders on some paths only ("Rendered more hooks than during the previous render").
   * `accountDoor` gates the ask as well as the mount: a door with no hosted account has no
   * manage page and no server to ask.
   */
  const manageUrl = useDesktopManageLink(accountDoor);
  useEffect(() => {
    // A new key is a new engine (or no cloud engine at all): the expiry flow's held step is
    // about an answer that no longer exists. The stored answer itself needs no reset — a stale
    // key already reads as pending.
    setSignInAfterExpiry(false);
  }, [authKey]);
  useEffect(() => {
    if (authKey === null) return;
    let cancelled = false;
    const probe = async (): Promise<void> => {
      try {
        const res = await bridgeFetch("/health");
        if (!res.ok) return; // a dead ENGINE is the status path's story, not this one's
        // `sessionExpired` and never bare `signedIn: false` decides the WORDING: an ordinary
        // pre-auth engine also answers signedIn:false, and the engine latches sessionExpired
        // only on the hosted API's definitive refusal to renew. Both states leave the mail
        // client — the difference is the sentence over the sign-in, never whether it shows.
        const health = (await res.json()) as {
          signedIn?: boolean;
          sessionExpired?: boolean;
          restartRequired?: boolean;
        };
        if (cancelled) return;
        setHostedAuth({
          key: authKey,
          /* THE THIRD REASON `signedIn` CAN BE FALSE, and it is read FIRST because the other two
             are wrong about it. A pairing that succeeded and is waiting for a relaunch answers
             `signedIn: false` with `sessionExpired: false` — which is `preAuth`'s exact shape, so
             without this the window draws the hosted PASSWORD FORM for an account that does not
             exist, at the moment the pairing worked. Had the engine set `sessionExpired` instead
             it would be worse: "no longer paired with {host}", the precise opposite of what
             happened. Neither is a wording problem; both are the window having no third reading
             available. `restartRequired` is that reading. */
          restartRequired: health.restartRequired === true,
          gone: health.sessionExpired === true,
          preAuth: health.sessionExpired !== true && health.signedIn === false,
        });
      } catch {
        /* engine unreachable — the status path owns that; the fast first-answer loop retries */
      }
    };
    // Once at mount — a relaunch onto a signed-out engine must land on sign-in now, not a
    // minute from now — then on the slow steady cadence.
    void probe();
    const timer = setInterval(() => void probe(), HOSTED_SESSION_PROBE_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [authKey]);
  /* UNTIL THE FIRST ANSWER, ask fast: the door's auth state is pending and the app is withheld,
     and the ask is one local stdio call answered in milliseconds once the engine serves. This
     loop exists only while the state is unknown — the flip to known unmounts it, and a new
     `authKey` (a replaced engine) re-mounts it because the stored answer stops matching. */
  useEffect(() => {
    if (authKey === null || hostedAuthKnown) return;
    let cancelled = false;
    const probe = async (): Promise<void> => {
      try {
        const res = await bridgeFetch("/health");
        if (!res.ok) return;
        const health = (await res.json()) as {
          signedIn?: boolean;
          sessionExpired?: boolean;
          restartRequired?: boolean;
        };
        if (cancelled) return;
        setHostedAuth({
          key: authKey,
          /* THE THIRD REASON `signedIn` CAN BE FALSE, and it is read FIRST because the other two
             are wrong about it. A pairing that succeeded and is waiting for a relaunch answers
             `signedIn: false` with `sessionExpired: false` — which is `preAuth`'s exact shape, so
             without this the window draws the hosted PASSWORD FORM for an account that does not
             exist, at the moment the pairing worked. Had the engine set `sessionExpired` instead
             it would be worse: "no longer paired with {host}", the precise opposite of what
             happened. Neither is a wording problem; both are the window having no third reading
             available. `restartRequired` is that reading. */
          restartRequired: health.restartRequired === true,
          gone: health.sessionExpired === true,
          preAuth: health.sessionExpired !== true && health.signedIn === false,
        });
      } catch {
        /* engine still starting — the next tick asks again */
      }
    };
    const fast = setInterval(() => void probe(), 400);
    return () => {
      cancelled = true;
      clearInterval(fast);
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
  const [live, setLive] = useState<{ key: string; engine: OhmailEngine } | null>(null);
  const gate = gateFor(shell ?? { kind: "none" });
  const mount = mailMount(shell ?? { kind: "none" }, live?.key ?? null);
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
  if (mount.kind === "engine" && live?.key !== mount.key) {
    setLive({ key: mount.key, engine: createLocalEngine() });
  } else if (mount.kind !== "engine" && live !== null) {
    /* Signed out, or the door was given up. Dropping the reference is what takes the mirror — a
       copy of somebody's mail — out of this window's memory; keeping it would leave it sitting
       behind the chooser for the life of the process. */
    setLive(null);
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

  if (gate.kind === "notice") {
    /* The same card the boot check and the error boundary draw — one apology, three ways of
       reaching it, differing only in the sentence and the button. See `GateNotice.tsx`. */
    return (
      <GateNotice
        reason={gate.reason}
        actionLabel={DOOR_COPY.gateTryAgain}
        onAction={() => void refresh()}
      />
    );
  }

  if (gate.kind === "choose") {
    return (
      <DoorChooser
        onEntered={(r) => {
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
      <div className="gate gate-boot">
        <BootSkeleton active rail />
        <BootStatus phase={status?.bootPhase} />
      </div>
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
   * here — the pairing SUCCEEDED and the previous copy is deliberately replaced.
   */
  if (hostedRestartRequired) {
    return (
      <div className="gate">
        <div className="gate-card">
          <span className="wordmark"><b>ohmail</b><em>.</em></span>
          <h1>{DOOR_COPY.gateRestartTitle}</h1>
          <p>{DOOR_COPY.gateRestart(hostLabelOf(status?.baseUrl) ?? DOOR_COPY.doorHostName)}</p>
        </div>
      </div>
    );
  }

  /* A PRE-AUTH cloud engine under a configured door: the sign-in surface, plainly — the app
     would render mail routes that refuse. (The expiry branch below carries the sentence.) */
  if (hostedPreAuth && !hostedSessionGone) {
    return (
      <DoorChooser
        start="cloud"
        cloudAction="signIn"
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

  if (hostedSessionGone) {
    /**
     * ── A PAIRED INSTALL WHOSE PAIRING WAS REVOKED — a different fact, a different card ──
     * `gateSessionGone` reads "You were signed out of your hosted account", which on this
     * door names an account that never existed; what happened is Remove was pressed on the
     * OTHER computer's Devices list. TWO ACTIONS, because the remedies are opposites: pair
     * again, or stop depending on that computer and open the mailbox from here — a card with
     * only the first is a dead end when the other machine is gone for good. "The copy of
     * your mail here is kept" is a claim about what re-pairing DOES: signing out freezes the
     * mirror, and the redeem refuses a different computer at that address.
     */
    const revokedHost = hostLabelOf(status?.baseUrl);
    if (paired && revokedHost !== null && !signInAfterExpiry) {
      return (
        <GateNotice
          reason={DOOR_COPY.gateUnpaired(machineWord(), revokedHost)}
          actionLabel={DOOR_COPY.gatePairAgain}
          onAction={() => setOverlay("host")}
          secondaryLabel={DOOR_COPY.gateOwn}
          onSecondary={beginTakeover}
        />
      );
    }
    if (signInAfterExpiry) {
      /* Straight to the CLOUD sign-in, in place — the same `start`/`cloudAction` pair the
         Settings reauthentication overlay passes. The chooser's defaults would ask the person
         to pick a door again and then RECONFIGURE the engine (which replaces the mirror);
         an expired session needs a new session over the mirror it already has. */
      return (
        <DoorChooser
          start="cloud"
          cloudAction="signIn"
          onEntered={(r) => {
            setAuthEpoch((n) => n + 1);
            setSignInAfterExpiry(false);
            if (r.status) onStatus(r.status);
            else void refresh();
          }}
        />
      );
    }
    return (
      <GateNotice
        reason={DOOR_COPY.gateSessionGone}
        actionLabel={DOOR_COPY.signIn}
        onAction={() => setSignInAfterExpiry(true)}
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
  const hostLabel = hostLabelOf(status?.baseUrl);
  const hostConnection: HostConnection | undefined = ((): HostConnection | undefined => {
    if (!paired || freshness === null || hostLabel === null) return undefined;
    const settingsLink = { href: "#/settings/desktop", label: DOOR_COPY.hostFootSettings };
    const check = hostViaOf(status?.baseUrl) === "lan"
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

  if (engine === null) {
    /* A door is chosen and no engine has served yet — a first launch migrating a database,
       or an engine on its way back up. No mail: the only alternative is a guess about
       somebody's own mailbox. `BootSkeleton` is `mailMount`'s answer drawn out, never a
       second opinion: it carries no text and nothing derived from any mailbox — a shape is
       not invented mail for exactly as long as there is nothing in it — and it is delayed
       behind its own grace, so the ordinary launch stays a quiet frame; the wait it exists
       for is the one-off recovery launch (`SETTLE_MS` in `doors.ts`). The words sit at the
       foot of the rail where the sync line will sit: `BootStatus` renders the engine's own
       `status.bootPhase` ("Replaying recent changes…"); the settling poll refreshes it. */
    return (
      <div className="gate gate-boot">
        <BootSkeleton active rail />
        <BootStatus phase={status?.bootPhase} />
      </div>
    );
  }

  return (
    <>
      <AppShell
        /**
         * KEYED BY THE MAILBOX, so a mailbox change REMOUNTS the shell. Partitioning the
         * storage was half of it: `ShellInner` holds the compose form in React state and
         * loads the scratch in a mount effect, so without a key React preserves the
         * component across a mailbox switch — the owner moves to B while mailbox A's
         * recipients, subject and body sit in state, and the next autosave writes them into
         * B's partition or a press sends them under B's identity. `mount.key` is the same id
         * the partition and the engine are chosen by, so all three change together; a
         * remount costs a re-read of the correct buffer, which is what was wanted.
         */
        key={shellKey}
        /* Always false, structurally: the early return above means this line is only reached
           with a real engine behind the window, and `demo` — the ribbon, the frozen clock, the
           fixtures adapter — would be a lie about somebody's own mail. The desktop has no demo
           surface at all; the one demo lives on ohmail.app's landing page. */
        demo={false}
        {...(engine ? { engine } : {})}
        /* WHAT THE SYNC LINE IS ALLOWED TO SAY. Its ladder begins with "can we see this
           account's mailboxes?" and stays silent when it cannot — which this window used to
           be through the whole of a first sync. `GET /mailboxes` is served by both doors
           from the database on this machine, so the answer costs one call down the pipe;
           withheld while there is no engine (see `DesktopMailboxes.tsx` for why the probe
           must reject rather than answer an empty list). On the hosted door these are the
           ACCOUNT's own mailboxes under the account's own ids, and the same facts feed the
           From selector — the addresses on offer are the addresses a send can leave from. */
        {...(engine ? { mailboxFacts: readMailboxFacts } : {})}
        /* HOW OLD IS THE MAIL ON SCREEN — the sidecar's own verdict (`GET /mirror/freshness`),
           because the window engine drains the LOCAL feed and cannot know the desktop is days
           behind the hosted account. Feeds the shared strip's "As of <time> · catching up" arm;
           withheld with no engine for `mailboxFacts`'s reason. CLOUD DOOR ONLY, structurally:
           the local door's engine has no such route (its organizer syncs in-process), and
           passing the probe there anyway would leave the provider holding a previous Cloud
           door's last verdict — a label about an account this window no longer shows. The
           provider also resets its held answer when the engine or probe changes; this gate is
           the first line, that reset the second. */
        {...(engine && status?.mode === "cloud" ? { mirrorFreshness: readMirrorFreshness } : {})}
        /* THE OTHER COMPUTER IS NOT ANSWERING — the one standing state this window can be in that
           the shared shell has no way to learn for itself. Present only on the paired door and
           only when there is something wrong to say; it also silences the sync strip's "catching
           up" arm, which would otherwise claim activity that is not happening. See the derivation
           above and `host-connection.ts` for the grace. */
        {...(hostConnection ? { hostConnection } : {})}
        /* WHAT A SEND FROM THIS WINDOW RIDES. On the STANDALONE door the compose form, the
           send handler and the SMTP dial are one process — the mail engine's own service bag
           makes the same declaration, `sendSurfaceMaxTotalBytes: null` — so the attach
           ceiling the form may promise is the sending mailbox's own announced limit, not the
           hosted constant. The CLOUD door stays SILENT on purpose: its writes,
           `POST /drafts/:id/send` included, are forwarded verbatim to the hosted API
           (`cloud-proxy.ts`), whose serverless body limit is exactly what the shared
           constant expresses — an uncapped declaration there would promise attachments the
           forwarded send must refuse. Both halves are guarded from source by
           `apps/desktop/test/desktop-attach-cap.test.ts`. */
        {...(engine && status?.mode === "local" ? { sendSurfaceMaxTotalBytes: null } : {})}
        /* SETTINGS → MAILBOXES. The shared pane's own list used to be drawn from the mirror's
           `mailbox` entities, which only the invented world has — so on a real install it was an
           empty pane; that fallback is deleted now. This one reads the same facts the sync line
           does, and names its mode from the door (Cloud on the hosted door, local on the other). */
        /* THE PANE IS NO LONGER TOLD WHICH ONE MAILBOX THE ENGINE OPENS, and that absence is the
           multi-mailbox change on this seam — the pane's own header carries the argument.
           `onStatus` is what replaced it: removing the LAST mailbox leaves the install configured
           for a mailbox it no longer has, so the pane runs the shell's sign-out afterwards and
           this gate re-reads its routing from the engine state that comes back. */
        {...(engine ? { mailboxSection: (
          <DesktopMailboxes
            door={status?.mode ?? null}
            /* NAMED ONLY WHEN THERE IS A NAME. The pane's paired arm falls back to the hosted
               wording without it, which is wrong but not broken; a sentence with a hole in it
               would be both. */
            host={paired ? hostLabel : null}
            onShellStatus={onStatus}
          />
        ) } : {})}
        /* SETTINGS → SCREENER. The shared shell's own section reaches an API client that is not
           in this build, so it drew nothing and the pane was blank. This is the same three
           controls over the same three columns, over the pipe. */
        {...(status ? { screeningSection: <DesktopScreening door={status.mode ?? null} /> } : {})}
        /* SETTINGS → NOTIFICATIONS' OS ANSWER. Unconditional and not gated on `status`: this is a
           fact about the WINDOW — it holds no notification permission and cannot acquire one, so
           its shell asks the platform on first use — and that is true before the shell has said
           anything about a door. Without it the pane falls back to the browser reader, whose
           `Notification.requestPermission()` resolves here without granting anything: the master
           switch could not be turned on and nothing on the pane said why. See `notify-host.ts`. */
        notificationHost={desktopNotificationHost}
        /* SETTINGS → ABOUT. Injected everywhere, because the facts differ by surface — and the
           facts a standalone install has to answer are not the hosted service's. */
        {...(status ? { aboutSection: <DesktopAbout status={status} /> } : {})}
        /* The pane the web client cannot have. Present only when the shell answered — outside
           the app there is no install to describe, and an empty one would be a pane about
           nothing. */
        desktopSection={
          status
            ? {
                label: desktopPaneLabel(),
                node: (
                  <DesktopSettings
                    status={status}
                    session={hostedSession}
                    /* THE SAME READ THE RAIL LINE USES, handed down rather than taken again: two
                       clocks for one fact would let the pane and the rail disagree for up to a
                       poll about whether the other machine is answering. */
                    connection={paired ? freshness : null}
                    onStatus={onStatus}
                    onSwitchDoor={() => setOverlay("doors")}
                    onSignIn={() => setOverlay("cloud")}
                    /* PAIR AGAIN opens the pairing card over the running app, exactly as "Sign in
                       again" opens the cloud form: the door is already chosen, and reconfiguring
                       would replace the engine and take the mail off the screen to change
                       nothing. */
                    onPairAgain={() => setOverlay("host")}
                    onTakeOver={beginTakeover}
                    onAiStatus={setAi}
                  />
                ),
              }
            : undefined
        }
        /* SETTINGS → DEVICES — one pane id, one entry per door, two different things behind
           it. STANDALONE: host mode's pane — publishing the engine on THIS computer is
           something only an install holding the whole mailbox can offer (`hostDoorFor` is
           the rule). HOSTED: the ACCOUNT's devices — sessions, the pairing mint, the
           take-back — which this window did not have at all: an install mirroring the
           account could not see or revoke a device. A DOOR OUT rather than a form,
           `DesktopWebSection`'s reason: `POST /pair` and `DELETE /devices/:id` are step-up
           gated and nothing this app does asserts a second factor — a list over verbs that
           could only refuse would be worse than the absence. */
        {...(hostDoorFor(status) === "local"
          ? { devicesSection: <DesktopDevices /> }
          : accountDoor
            ? {
                devicesSection: (
                  <DesktopWebSection
                    place="devices"
                    copy={{ title: "webDevicesTitle", why: "webDevicesWhy", note: "webDevicesNote" }}
                  />
                ),
              }
            : {})}
        /* A SUGGEST CONTROL PER DOOR, because the two doors are not buying the same thing.
           On the STANDALONE door nothing is metered, so the control names no price and says
           whether there is a model at all; on the HOSTED door the question is a browser
           tab's — what would this cost — so that door renders the SHARED ladder over a
           transport that reaches the account through the engine. Neither is a control with
           nothing behind it: the hosted one is offered only once a session is held. Which of
           the three it is — including "none" — is `suggestDoorFor`, a pure function in
           `doors.ts` for `gateFor`'s reason. */
        {...(suggestDoor === "local"
          ? {
              screenerSuggest: ({ senders, absorb }) => (
                <LocalSuggest
                  senders={senders}
                  absorb={absorb}
                  ai={ai}
                  /* THE PANE THE FORM IS ACTUALLY ON. `go("settings")` opened the settings
                     view at its own default — General — and the model form lives under Desktop,
                     below the fold: a control saying "Set up a model" that lands somewhere with
                     no model form on it, leaving the person to find it. `goSettings` names the
                     pane, and "desktop" is where `DesktopAiSettings` is mounted. */
                  onConfigure={() => goSettings("desktop")}
                />
              ),
            }
          : suggestDoor === "cloud"
            ? {
                screenerSuggest: ({ senders, resuggestable, absorb }) => (
                  <CloudSuggest senders={senders} resuggestable={resuggestable} absorb={absorb} />
                ),
              }
            : {})}
        /* SETTINGS → AWAY RESPONDER. The shared shell offers this when `apiConfigured()`
           says there is a server — false in EVERY desktop build — so the responder was
           withheld from a hosted install with a real account, and from a standalone install,
           wrong too now that the pass lives in `@trafficflow/services` (this engine bundles
           it; the sidecar's drain runs it with this machine's own SMTP dial). A TRANSPORT
           and not a section: the same control over whichever row the door owns. `awayDoorFor`
           returns WHICH door, and `awayIsLocal` carries the one difference: on the
           standalone door replies go out only while this window is open, and the pane says
           so rather than borrowing Cloud's always-on copy. */
        {...(awayDoorFor(status, hostedSession) !== null
          ? {
              awayTransport: awayOverBridge,
              awayIsLocal: awayDoorFor(status, hostedSession) === "local",
              /* THE THIRD PROMISE. On a paired desktop the row and the drain are the OTHER
                 computer's, so neither of the two sentences the shell already had is true here:
                 Cloud's promises an always-on service, and the standalone one names THIS machine
                 while the machine that has to be awake is the other one. Passing the label is the
                 whole of the difference, and `AwayResponderRow` prefers it over `awayIsLocal` —
                 which `awayDoorFor` makes unreachable in this window, since it answers exactly
                 one arm. WITHOUT this the paired door would have rendered Cloud's copy, which is
                 the same class of false state the flavor seam exists to end. */
              /* WITHHELD RATHER THAN EMPTY when there is no label to give. `hostLabelOf` answers
                 null for an absent or unparseable base, and `?? ""` would have rendered "…while
                 ohmail is open on ." — a sentence with a hole in it, which is worse than the
                 standalone one this then falls back to. */
              ...(awayDoorFor(status, hostedSession) === "host" && hostLabelOf(status?.baseUrl)
                ? { awayOnHost: hostLabelOf(status?.baseUrl) }
                : {}),
            }
          : {})}
        /* ACKNOWLEDGING THE ORGANIZER NOTICE — on BOTH doors, and with no door rule of its
           own, unlike the two seams around it. Those need one because what the route DOES
           differs between a standalone install and a Cloud-connected one; this one stamps an
           instant on the caller's own mailbox row, and it is mounted on both doors — served
           locally on the standalone one, forwarded to the account on the hosted one. The
           window presses the same path either way, so there is nothing to branch on. */
        organizerNoticeTransport={organizerNoticeOverBridge}
        /* SETTINGS FOUND ON A MAILBOX — the profile-import card, on BOTH doors, and this is the
           desktop-standalone tier gaining the flow's flagship case: a mailbox that arrives
           carrying another ohmail's settings (leave Cloud, install the app) is asked before
           anything is applied. The same transport-not-a-section rule as the away responder — the
           card, the counts and the fingerprint-as-consent have ONE implementation and only the
           wire is injected — but a different door rule, because the engine on this machine
           serves the three routes ITSELF on the standalone door and forwards them to the account
           on the hosted one. `profileImportDoorFor` is the rule, a pure function a test drives. */
        {...(profileImportDoorFor(status, hostedSession) !== null ? { profileImportTransport: profileImportOverBridge } : {})}
        /* SETTINGS → SCREENER AND GENERAL, THE ACCOUNT'S OWN ROW — the dormancy dial, the
           auto-suggest opt-in and auto-unsubscribe, all built by the shared shell and withheld
           here while its `GET /consent` could not run. Two wires, two questions:
           `consentTransport` reads and writes the FLAG; `suggestWire` PRICES what turning it
           on would buy — a switch that authorises spending without a quote is the one thing
           that control must never be. The wires part company at the STANDALONE door
           (mail 0083): `consentRoutes` are mounted on `localRoutes`, so that install has the
           row and threads the resolved cutoff as the hosted worker does (`local-consent.ts`);
           it also feeds `consent.known`, one of the four first-run gates. `suggestWire` STAYS
           hosted-only: no ledger, no watermark behind a standalone engine. */
        /* ONE WIRE PER DOOR, and the two differ by exactly one declared capability: the
           standalone engine serves no folder verb, so its transport says the folders flag is not
           storable and the shared shell withholds that pane instead of drawing a switch that
           snaps back. Everything else about the two objects is the same ten calls against the
           same paths — see `local-consent.ts`. */
        /* ONE RULE, NOT TWO CONDITIONS. This was `accountDoor ? … : firstRunDoorFor === "local" ? …`,
           and the pair had a hole exactly where a third door appeared: a paired desktop is
           neither, so it would have got NO consent transport — no screening window, and nothing
           on screen saying why — on a door where the host serves the row perfectly well one hop
           away. `consentDoorFor` is the rule, a pure function a test can drive. */
        {...(consentDoorFor(status, hostedSession) === "cloud"
          ? { consentTransport: consentOverBridge }
          : consentDoorFor(status, hostedSession) === "standalone"
            ? { consentTransport: consentOverBridgeStandalone }
            : {})}
        {...(accountDoor ? { suggestWire: cloudSuggestWire } : {})}
        /* THE REACH-PAST BODY WIRE — BOTH doors, `consentTransport`'s transport-not-a-control
           rule: the door, its states and its sentences are the shared shell's
           (`shell/older-body.ts`); this hands in the pipe. On the HOSTED door the engine serves
           a mirrored message's body locally and FORWARDS a reach-past row's to the hosted
           account. On the STANDALONE door the window's engine boots a BOUNDED in-memory mirror
           over a store that holds the whole mailbox, so its lists can also hand the shell
           reach-past rows — and the local `/messages/:id/body` route answers them from the
           store on this machine. Gating this on the account door was review-caught: it left the
           standalone reader with exactly the stalled Retry the wire exists to remove. */
        {...{ olderBodyWire: olderBodyOverBridge }}
        /* THE JUNK WINDOW'S WIRE — BOTH doors, the same transport-not-a-control rule. The
           segment, its states, verbs and sweep offer are the shared shell's
           (`shell/junk-window.ts`); this hands in the pipe. HOSTED: the engine has no junk
           routes of its own — Junk is never mirrored — so every ask falls through to the
           write-through proxy. STANDALONE: the engine serves them itself, but the segment
           stays withheld by the flag in front of it — that door cannot STORE "Use folders"
           (§17), and the shell gates the control on the flag. NOT "no consent row": the
           `consentTransport` spread earlier in this prop list hands that door the row's wire;
           `withoutFoldersFlag` strips this one FIELD (no folder verb; `local-junk.ts`). */
        {...{ junkWire: junkOverBridge }}
        /* THE LIVE TRASH WINDOW's wire, on the same terms. Both doors serve `/trash/window*` —
           the standalone one from `localRoutes`, the hosted one through the relay — and without a
           wire the section reports "no server" and is withheld, which is what this window did.
           Two reads and no verb; `local-trash.ts` carries the argument. */
        {...{ trashWire: trashOverBridge }}
        /* SETTINGS → SUBSCRIPTION, SECURITY AND ACCOUNT — the three panes the web client has
           on a hosted account and this window did not: an absent entry reads as "this product
           does not have that", which for account deletion contradicts what the site promises.
           All three are doors and nothing else: every control behind Security and Account is
           step-up gated and nothing this app can do asserts a second factor; Subscription is
           the service operator's own page, whose state this program does not hold. See
           `DesktopWebSection` and `DesktopSubscription` — the latter renders nothing where no
           such page is served, so the nav entry follows the page. */
        /* THE ACCOUNT'S AI SWITCH — behind `accountDoor` like the three panes below, and
           unconditional within it: the flag exists for every hosted account. The standalone door
           has no account and keeps its own local-model form on the Desktop pane instead. */
        {...(accountDoor ? { aiSection: <DesktopAiAccount /> } : {})}
        {...(accountDoor && manageUrl
          ? { billingSection: <DesktopSubscription url={manageUrl} /> }
          : {})}
        {...(accountDoor
          ? {
              securitySection: (
                <DesktopWebSection
                  place="security"
                  copy={{ title: "webSecurityTitle", why: "webSecurityWhy" }}
                />
              ),
            }
          : {})}
        {...(accountDoor
          ? {
              accountSection: (
                <DesktopWebSection
                  place="account"
                  copy={{
                    title: "webAccountTitle",
                    why: "webAccountWhy",
                    note: "webAccountNote",
                  }}
                />
              ),
            }
          : {})}
        /* SETTINGS → GENERAL, THE DEFAULT-MAIL ROW. Present whenever the shell answered — the
           question is about this COMPUTER, not about a door, so both doors get it. Every read
           and verb in the row is a shell command (`DesktopDefaultMail.tsx`). */
        {...(status ? { defaultMailSection: <DefaultMailRow /> } : {})}
        /* A MAILTO CLICK BECOMING THE COMPOSE FORM — the claim effect above holds the parsed
           fields until this render has a real engine behind it, and the shell seeds compose
           exactly the way `writeTo` does (see `AppShell`'s `mailtoDraft`). Cleared once seeded,
           so a remount cannot seed the same click twice. */
        {...(mailtoDraft ? { mailtoDraft, onMailtoDraftSeeded: () => setMailtoDraft(null) } : {})}
        /* ── THE GUIDED SETUP FLOW, ON THE DOOR IT WAS WRITTEN FOR ─────────────────────────
         * The stage is the shared shell's (`app/shell/FirstRun.tsx`) and knows no door; it
         * asks for one object that can make the calls, and this is the standalone door's.
         * Absent on the hosted door and before a door is chosen — the whole gate, not a
         * withheld feature (`firstRunDoorFor` is the rule). THE PROVIDER FORM IS INJECTED
         * RATHER THAN IMPORTED: `apps/webapp` may not import `AiProviderForm` (a pin asserts
         * it), and it is the SAME component Settings → AI mounts — one write path to the
         * model file, and its `onStatus` echo lands in the same `ai` state the suggest
         * control reads. `pairNode` is the devices surface on `hostDoorFor`'s rule: only an
         * install that may publish its engine has anything to pair to. */
        {...(firstRun ? { firstRun } : {})}
        onUnread={onUnread}
      />
      {/* THE ONE-TIME DEFAULT-MAIL ASK — over the mail, once a mailbox is connected, and
          never twice: either answer persists, and "already the default" persists too; the
          Settings row above is the durable way back for "Not now". NOT WHILE THE SETUP FLOW
          IS OPEN — measured on the released 0.13.7: at +15 s this prompt stacked ON TOP of
          the flow's own Continue and Cancel and HID them until dismissed. `route.firstRun`
          is the stage's own gate in `AppShell`, read through the shared hash router so the
          two cannot disagree. It WAITS rather than being withheld: the ask is one-time and
          un-answered, so it is offered on the next visit with the flow closed. */}
      {routeNow.firstRun ? null : <DefaultMailAsk />}
      {overlay ? (
        /* OVER the client, not under it. `.gate` is a full-height flow element — correct when it
           IS the window, wrong when the mail is already on screen behind it, where it would
           simply render below the fold. The wrapper takes it out of flow and puts it above the
           command palette (`--z-pal`) and below the toasts, which is where a modal setup step
           belongs: nothing in the app should be reachable while it is open, and a toast it
           produces still has to be readable over it. Inline because it is the only element in
           either product that needs it. */
        <div
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
            void refresh();
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
      ) : null}
    </>
  );
}

/**
 * WHAT THE ICON SAYS, AND WHEN THE MACHINE SPEAKS UP. One sink for the client's unread
 * count, driving both native surfaces: the DOCK BADGE is the count itself, set on change and
 * removed at zero (a badge reading "0" says what taking it off already says); a NOTIFICATION
 * fires only when the count RISES and the window is not the one being looked at — falling
 * counts are the user reading their own mail. The first render seeds the previous count
 * rather than notifying against zero: an app opened with eleven unread has not just
 * received eleven.
 */
function useUnreadSink(): (unread: number) => void {
  const previous = useRef<number | null>(null);
  return useCallback((unread: number) => {
    const before = previous.current;
    previous.current = unread;
    /* Swallowed rather than reported: a platform that cannot draw a badge (Windows carries an
       overlay icon instead) must not leave an unhandled rejection behind a piece of decoration.
       The BADGE is deliberately outside the notification switches: it is a number on an icon the
       user is already looking at, not an interruption, and turning notifications off should not
       cost somebody their unread count. */
    void setBadge(unread).catch(() => {});
    if (typeof document !== "undefined" && document.hasFocus()) return;

    /* ── THE GATE, AND WHY THIS CALL EXISTS ──────────────────────────────────────────────
       This emitter used to fire unconditionally while Settings said ohmail "doesn't send
       notifications yet" — the sentence renders whenever the mirror carries no notifications
       row, which on the desktop is always. So the app told you about new mail and its own
       settings screen said it never would. Now it asks the shared gate, exactly as the
       browser and the phone do: `decideNotices` is handed the counts and the stored switches
       and answers with what may be drawn — nothing at all when the master is off. */
    const spec = decideNotices(
      before === null ? null : { ohboxUnread: before, screenerWaiting: 0 },
      { ohboxUnread: unread, screenerWaiting: 0 },
      readChannels(),
      /* The shell holds the OS permission, not this window: its `notify` command asks the
         platform itself on first use and reports a refusal as a rejection, which the catch below
         absorbs. Passing "granted" here says "this window may ask the shell", not "the OS has
         agreed" — the gate's other three states belong to hosts that can read the answer. */
      "granted",
    ).find((n) => n.event === "ohbox");
    if (spec === undefined) return;

    const fresh = spec.count;
    void postOsNotice("ohmail", DOOR_COPY.notifyNewMail(fresh)).catch(() => {
      /* Notifications are off for ohmail, or this platform has none. Not a reason to fail. */
    });
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
function runMenuCommand(command: MenuCommand): void {
  switch (command) {
    case "compose":
      go("compose");
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
