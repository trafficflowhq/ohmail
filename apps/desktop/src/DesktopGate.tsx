/**
 * WHAT THE WINDOW SHOWS, AND WHO DECIDES — the engine-bearing build's outermost component.
 *
 * One question is asked at boot ("shell, what is the engine doing?") and the answer routes the
 * whole window: the door chooser on a fresh install, an honest notice when there is an engine
 * and something is wrong with it, and otherwise the mail client — the same `AppShell` the hosted
 * client renders, with one extra Settings pane the web cannot have.
 *
 * ── THE ONE CASE THAT IS NOT AN ERROR ───────────────────────────────────────────────────────
 *
 * "There is no shell at all" is not routed to a notice. It means this bundle is being loaded
 * outside the app — a development server, or the render check that loads the built files in a
 * headless DOM — and there is no engine to have a state. In the packaged app it cannot happen:
 * the runtime defines its command channel before any bundle script runs. So the notice is
 * reserved for the case that matters, which is a shell that IS there and cannot answer — and the
 * no-shell case lands on the door chooser, because "nothing is connected" is exactly what is
 * true there. The app has two states, not connected and connected; there is no third surface and
 * no sample mailbox (the one demo lives on ohmail.app's landing page).
 *
 * ── THE MAIL IS THE MAILBOX'S ───────────────────────────────────────────────────────────────
 *
 * When the shell says an engine is serving, `AppShell` below is handed a real client engine
 * running over the bridge (`bridge-fetch.ts`) and renders that mailbox — the same component, the
 * same views, the same keyboard, with the data coming from the process on this machine.
 * {@link mailMount} is the decision and it is a pure function, so which surface a given engine
 * state produces is something a test drives rather than something this component describes.
 *
 * ── A MAILTO CLICK ANYWHERE ON THIS COMPUTER LANDS HERE ─────────────────────────────────────
 *
 * Once ohmail is the default mail app, the OS delivers every mailto click to the shell, which
 * holds the link until this window claims it (`native.ts`, take-once). The claim happens twice —
 * on the shell's poke, and once at mount for the click that STARTED the app — and the parsed
 * fields (`mailto.ts`, the one parser) wait in state until the mail client is on screen, then
 * seed the compose form through `AppShell`'s `mailtoDraft` seam. Clicked before a mailbox is
 * connected, the draft simply waits: connecting is the thing the person has to do first, and the
 * compose opens once it is done.
 *
 * ── AND THE NATIVE CHROME IS DRIVEN FROM HERE ───────────────────────────────────────────────
 *
 * The menu's navigation events, the dock badge and the new-mail notification are wired here
 * rather than inside the shared client, because all three are things only this build has. The
 * menu drives `go()` — the same function the rail, the palette and the number keys call — so a
 * menu item and a keystroke can never land in different places.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { OhmailEngine } from "@ohmail/client-engine";

import { AppShell } from "../../webapp/app/shell/AppShell";
import { BootSkeleton } from "../../webapp/app/shell/BootSkeleton";
import { go } from "../../webapp/app/shell/routing";
import { BootStatus } from "./BootStatus.js";
import { bridgeAvailable, bridgeFetch } from "./bridge-fetch.js";
import { DoorChooser } from "./DoorChooser.js";
import { DesktopAbout } from "./DesktopAbout.js";
import { DesktopMailboxes, readMailboxFacts } from "./DesktopMailboxes.js";
import { DesktopScreening } from "./DesktopScreening.js";
import { GateNotice } from "./GateNotice.js";
import { DESKTOP_PANE_LABEL, DesktopSettings } from "./DesktopSettings.js";
import { DesktopBilling } from "./DesktopBilling.js";
import { DesktopWebSection } from "./DesktopWebSection.js";
import {
  accountDoorFor, awayDoorFor, gateFor, hostDoorFor, mailMount, profileImportDoorFor, readShell,
  suggestDoorFor,
  type Shell,
} from "./doors.js";
import { DesktopDevices } from "./DesktopDevices.js";
import { awayOverBridge } from "./local-away.js";
import { profileImportOverBridge } from "./local-profile-import.js";
import { consentOverBridge } from "./local-consent.js";
import { olderBodyOverBridge } from "./local-older-body.js";
import { junkOverBridge } from "./local-junk.js";
import { cloudSuggestWire } from "./cloud-suggest.js";
import { readAiStatus, type LocalAiStatus } from "./local-ai.js";
import { LocalSuggest } from "./local-suggest.js";
import { CloudSuggest } from "./CloudSuggest.js";
import {
  claimMailto, notify, onMailto, onMenuCommand, onMenuNavigate, setBadge, type MenuCommand,
} from "./native.js";
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

export function DesktopGate() {
  const [shell, setShell] = useState<Shell | null>(null);
  /* The door chooser, opened from Settings over a working install. Distinct from the chooser a
     fresh install lands on: this one is cancellable, because there is something to go back to. */
  const [overlay, setOverlay] = useState<null | "doors" | "cloud">(null);

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
    const claim = async (): Promise<void> => {
      const raw = await claimMailto();
      if (raw === null) return;
      const draft = parseMailto(raw);
      if (draft) setMailtoDraft(draft);
    };
    void onMailto(() => void claim());
    void claim();
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

  /**
   * WHAT THIS INSTALL HAS FOR A MODEL — read once, here, because two surfaces need the answer.
   *
   * The Settings pane is one of them and could read it for itself. The Screener's suggest control
   * is the other, and it cannot: somebody who has never opened Settings still has to be told,
   * where the control is, that there is nothing behind it yet. Reading it at the gate is what lets
   * both say the same thing, and the pane publishes what it changes so saving a key makes the
   * Screener's control live without a relaunch — the engine rebuilds its own services per request,
   * so there is nothing to restart.
   *
   * `null` means "not on this door, or not asked yet". Only the standalone door has a local model
   * to configure: an install pointed at a hosted account mirrors an account whose AI is that
   * account's, and asking the engine there would be a request forwarded to a server that has no
   * such route.
   */
  const [ai, setAi] = useState<LocalAiStatus | null>(null);
  const door = shell?.kind === "status" ? (shell.status.mode ?? null) : null;

  /**
   * THE HOSTED SESSION'S LIVE TRUTH, asked of the engine rather than remembered from launch —
   * and never remembered ACROSS ENGINES either, which is what the key below enforces.
   *
   * `authEpoch` counts engine-lifecycle acts (every status `onStatus` delivers — a door entered,
   * a sign-in, a reconfigure), and `authKey` names the exact (door, epoch) an answer was earned
   * under. An answer is BELIEVED only while its key matches the current one, so leaving the
   * cloud door, coming back to it, or replacing the engine under the same door each mint a key
   * no stored answer matches — the auth state is structurally PENDING again and the mail app is
   * withheld until the NEW engine's own first `/health` lands. The stale-latch failure this
   * closes: a Cloud probe answered once, the person switched to local and back (or re-entered
   * the door over a replaced engine), and the gate mounted `AppShell` on the old answer before
   * the new engine reported pre-auth or expiry — mail routes refusing under a mounted client.
   *
   * `gone` latches on the engine's own expiry verdict (`sessionExpired`, the hosted API's
   * definitive refusal to renew): the gate replaces the mail client with an honest sentence and
   * the sign-in surface, instead of a mailbox that silently stopped moving. `preAuth` is
   * signedIn:false WITHOUT that verdict — a pre-auth engine (relaunch after an expiry already
   * removed the seal, an abandoned handoff): the sign-in surface with no "you were signed out"
   * sentence, because for a session that never existed that sentence would be a lie.
   * `signInAfterExpiry` is the person taking the offered action.
   */
  const [authEpoch, setAuthEpoch] = useState(0);
  const authKey = door === "cloud" && bridgeAvailable() ? `cloud:${authEpoch}` : null;
  const [hostedAuth, setHostedAuth] = useState<{ key: string; gone: boolean; preAuth: boolean } | null>(null);
  /** TRUE once the CURRENT engine's first `/health` answer has been read — pending otherwise.
      Until then the mail app is withheld: React would otherwise commit `AppShell` once, before
      the asynchronous probe responds, over an engine whose mail routes refuse. Non-cloud doors
      and bridge-less environments never consult it. */
  const hostedAuthKnown = hostedAuth !== null && hostedAuth.key === authKey;
  const hostedSessionGone = hostedAuthKnown && hostedAuth.gone;
  const hostedPreAuth = hostedAuthKnown && hostedAuth.preAuth;
  const [signInAfterExpiry, setSignInAfterExpiry] = useState(false);
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
        const health = (await res.json()) as { signedIn?: boolean; sessionExpired?: boolean };
        if (cancelled) return;
        setHostedAuth({
          key: authKey,
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
        const health = (await res.json()) as { signedIn?: boolean; sessionExpired?: boolean };
        if (cancelled) return;
        setHostedAuth({
          key: authKey,
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
   * THE CLIENT ENGINE ON SCREEN — one per mailbox, kept across a restart of the process behind it.
   *
   * It is state rather than a memo because it has to SURVIVE: `mailMount` is told which mailbox is
   * already mounted and answers with the same key while the engine bounces, which only means
   * anything if the object itself is still here to be answered about.
   *
   * Built during the render that first needs it — React's own "adjusting state when a prop
   * changes" — rather than in an effect, so the mail surface never paints one empty frame between
   * the shell saying `serving` and the client that runs against it. The constructor opens nothing;
   * the shared shell is what starts the engine and drives its sync loop, exactly as it does for a
   * browser tab.
   */
  const [live, setLive] = useState<{ key: string; engine: OhmailEngine } | null>(null);
  const gate = gateFor(shell ?? { kind: "none" });
  const mount = mailMount(shell ?? { kind: "none" }, live?.key ?? null);
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
        <BootStatus sentence="Opening…" />
      </div>
    );
  }

  if (gate.kind === "notice") {
    /* The same card the boot check and the error boundary draw — one apology, three ways of
       reaching it, differing only in the sentence and the button. See `GateNotice.tsx`. */
    return <GateNotice reason={gate.reason} actionLabel="Try again" onAction={() => void refresh()} />;
  }

  if (gate.kind === "choose") {
    return <DoorChooser onEntered={(r) => { if (r.status) onStatus(r.status); else void refresh(); }} />;
  }

  /* THE HOSTED SESSION ENDED under a window that was already serving mail. Say so, in a
     sentence, and offer the way back — never a mailbox that silently stopped moving. The
     mirrored mail is kept on disk (sign-out freezes the directory) and returns with the
     sign-in. */
  /* THE CLOUD DOOR'S AUTH STATE IS PENDING: the CURRENT engine's first answer has not landed —
     a first launch, or an engine just replaced/re-entered whose predecessor's answer no longer
     counts. Withhold the mail app — React would otherwise commit it once, over an engine whose
     mail routes refuse — and draw the same skeleton a starting engine draws. Resolved in
     milliseconds. */
  if (authKey !== null && !hostedAuthKnown) {
    return <BootSkeleton active />;
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
        reason={
          "You were signed out of your hosted account, so this install stopped receiving " +
          "new mail. What was already here is kept; sign in again to reconnect."
        }
        actionLabel="Sign in"
        onAction={() => setSignInAfterExpiry(true)}
      />
    );
  }

  const status = shell.kind === "status" ? shell.status : null;
  const suggestDoor = suggestDoorFor(status);
  /**
   * IS THERE A HOSTED ACCOUNT BEHIND THIS WINDOW — the one gate every account-shaped surface below
   * reads, so they can only appear and disappear together.
   *
   * The settings surface an install shows should be the settings surface the same account shows in
   * a browser tab, wherever the routes behind it are reachable — and on this door they are: the
   * engine serves the mail READS out of its mirror and forwards everything else to the account with
   * its bearer (`cloud-proxy.ts`), so `/consent`, `/consent/settings`, `/screener`,
   * `/billing/subscription` and `/account/ai` are the account's own rows, one hop away.
   *
   * What was missing was never the transport, it was the ASKING: `apiConfigured()` is false in
   * every desktop build, so the shared shell's own reads never ran and each control was withheld as
   * "there is no server here". That is true of the standalone door and false of this one.
   * `accountDoorFor` is where the distinction lives, as a pure function a test can drive.
   */
  const accountDoor = accountDoorFor(status) === "cloud";

  /* Null on the one render where the engine has just been asked for and the state that holds it
     has not caught up. React re-renders before painting, so that render is never seen; it still
     has to draw something, and the honest something is the line below. */
  const engine = mount.kind === "engine" && live?.key === mount.key ? live.engine : null;

  if (engine === null) {
    /* A door is chosen and no engine has served yet — a first launch migrating a database, or an
       engine on its way back up. No mail: the only thing this window could put on screen instead
       is a guess, and a guess about somebody's own mailbox is worse than a quiet frame. The
       settling poll above is what ends this state.

       AND, ONCE THE WAIT STOPS BEING AN ORDINARY ONE, THE SHAPE OF THE WINDOW BEHIND IT.
       `BootSkeleton` is `mailMount`'s answer drawn out, never a second opinion about it: this
       branch is chosen entirely above, and the silhouette is decoration inside a decision that
       has already been made. It carries no text and nothing derived from any mailbox, which is
       what keeps it on the right side of the rule this comment states — a shape is not invented
       mail, for exactly as long as there is nothing in it.

       It is delayed behind its own grace, so the ordinary launch is the quiet frame it has always
       been. The wait it exists for is the one-off recovery launch: an install whose previous run
       left a large write-ahead log replays it inside the engine's database open (see `SETTLE_MS`
       in `doors.ts`).

       THE WORDS SIT WHERE THE APP'S OWN SYNC LINE WILL SIT — the foot of the rail — not on a
       centred card over the canvas. `BootStatus` is the sync line's shape with the boot's
       sentence in it, and the sentence is the engine's own account of the wait: each `phase`
       frame the engine writes while starting reaches this window as `status.bootPhase`, so a
       recovery launch says "Replaying recent changes…" instead of one sentence for every wait.
       The settling poll above is also what refreshes the phase. */
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
        /* Always false, structurally: the early return above means this line is only reached
           with a real engine behind the window, and `demo` — the ribbon, the frozen clock, the
           fixtures adapter — would be a lie about somebody's own mail. The desktop has no demo
           surface at all; the one demo lives on ohmail.app's landing page. */
        demo={false}
        {...(engine ? { engine } : {})}
        /* WHAT THE SYNC LINE IS ALLOWED TO SAY. Its ladder begins with "can we see this account's
           mailboxes?" and stays silent when it cannot — which is what this window used to be,
           silent, through the whole of a first sync. `GET /mailboxes` is served by both doors out
           of the database on this machine, so the answer costs one call down the pipe. Withheld
           while there is no engine: the invented mailbox is nobody's account and has nothing to
           report. See `DesktopMailboxes.tsx` for why the probe must reject rather than answer
           with an empty list.

           These are the ACCOUNT's own mailboxes on the hosted door — mirrored under the account's
           own ids by the engine's pull, not the single placeholder row it used to answer with. The
           same facts feed the From selector, which is why the addresses on offer here are the
           addresses a send can actually leave from. */
        {...(engine ? { mailboxFacts: readMailboxFacts } : {})}
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
        {...(engine ? { mailboxSection: <DesktopMailboxes door={status?.mode ?? null} /> } : {})}
        /* SETTINGS → SCREENER. The shared shell's own section reaches an API client that is not
           in this build, so it drew nothing and the pane was blank. This is the same three
           controls over the same three columns, over the pipe. */
        {...(status ? { screeningSection: <DesktopScreening door={status.mode ?? null} /> } : {})}
        /* SETTINGS → ABOUT. Injected everywhere, because the facts differ by surface — and the
           facts a standalone install has to answer are not the hosted service's. */
        {...(status ? { aboutSection: <DesktopAbout status={status} /> } : {})}
        /* The pane the web client cannot have. Present only when the shell answered — outside
           the app there is no install to describe, and an empty one would be a pane about
           nothing. */
        desktopSection={
          status
            ? {
                label: DESKTOP_PANE_LABEL,
                node: (
                  <DesktopSettings
                    status={status}
                    onStatus={onStatus}
                    onSwitchDoor={() => setOverlay("doors")}
                    onSignIn={() => setOverlay("cloud")}
                    onAiStatus={setAi}
                  />
                ),
              }
            : undefined
        }
        /* SETTINGS → DEVICES — host mode's pane, on the STANDALONE door only. `hostDoorFor` is
           the rule and it is a pure function in `doors.ts` for the reason the other door gates
           are: host mode publishes the mailbox THIS computer opens, so an install mirroring a
           hosted account has nothing of its own to serve and gets no entry — withheld
           structurally rather than offered onto the shell's own refusal. */
        {...(hostDoorFor(status) === "local" ? { devicesSection: <DesktopDevices /> } : {})}
        /* A SUGGEST CONTROL PER DOOR, because the two doors are not buying the same thing.
           On the STANDALONE door the model belongs to whoever installed it and nothing is
           metered, so the control names no price and says instead whether there is a model at
           all. On the HOSTED door there is an account with an allowance behind it, and the
           question is the one a browser tab asks — what would this cost — so that door renders
           the SHARED ladder over a transport that reaches the account through the engine.
           Neither is a control with nothing behind it, which is the thing this surface must
           never be: the hosted one is offered only once a session is held, because a purchase
           control on a signed-out install could only ever refuse.
           Which of the three it is — including "none" — is `suggestDoorFor`, a pure function in
           `doors.ts` for the reason `gateFor` and `mailMount` are: a decision a test can drive is
           worth more than a condition a component describes. */
        {...(suggestDoor === "local"
          ? {
              screenerSuggest: ({ senders, absorb }) => (
                <LocalSuggest
                  senders={senders}
                  absorb={absorb}
                  ai={ai}
                  onConfigure={() => go("settings")}
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
        /* SETTINGS → AWAY RESPONDER, on the HOSTED door only.
           The shared shell offers this control when `apiConfigured()` says there is a server — and
           that is false in EVERY desktop build, both doors, because this bundle aliases the Cloud
           client to a refusing stub. So the responder was withheld from a hosted install that has a
           real account behind it, which was wrong, and from a standalone install, which is right and
           is a product boundary rather than a plumbing gap: nothing on that door SENDS the reply.
           A TRANSPORT and not a section, unlike the two seams above: this is the same control over
           the same hosted row, and a second copy of it would be a second definition of when an
           enablement episode begins — the key the worker files its at-most-once record under.
           `awayDoorFor` is where the rule lives, as a pure function a test can drive. */
        {...(awayDoorFor(status) === "cloud" ? { awayTransport: awayOverBridge } : {})}
        /* SETTINGS FOUND ON A MAILBOX — the profile-import card, on BOTH doors, and this is the
           desktop-standalone tier gaining the flow's flagship case: a mailbox that arrives
           carrying another ohmail's settings (leave Cloud, install the app) is asked before
           anything is applied. The same transport-not-a-section rule as the away responder — the
           card, the counts and the fingerprint-as-consent have ONE implementation and only the
           wire is injected — but a different door rule, because the engine on this machine
           serves the three routes ITSELF on the standalone door and forwards them to the account
           on the hosted one. `profileImportDoorFor` is the rule, a pure function a test drives. */
        {...(profileImportDoorFor(status) !== null ? { profileImportTransport: profileImportOverBridge } : {})}
        /* SETTINGS → SCREENER AND GENERAL, THE ACCOUNT'S OWN ROW — the dormancy dial, the
           auto-suggest opt-in and auto-unsubscribe, all of which the shared shell already builds
           and all of which it withheld here because its `GET /consent` could not run. Two wires
           rather than one, because the opt-in row needs both halves and they are different
           questions: `consentTransport` is where the FLAG is read and written, and `suggestWire` is
           what PRICES the batch turning it on would buy — a switch that authorises spending without
           a quote is the one thing that control must never be. Both are the same transport-not-a-
           section rule the away responder states: one implementation of what a consent means, one
           implementation of how money moves, and only the bytes injected.

           On the STANDALONE door neither is passed, and every one of those controls stays absent.
           That is a product boundary, not a gap: there is no account row to hold a window, no
           watermark for an automatic pass to measure from, and no ledger to price against. */
        {...(accountDoor ? { consentTransport: consentOverBridge, suggestWire: cloudSuggestWire } : {})}
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
           segment, its states, its two rescue verbs, the search-append and the sweep offer are
           the shared shell's (`shell/junk-window.ts`); this hands in the pipe. On the HOSTED door
           the engine has no junk routes of its own — Junk is never mirrored — so every ask falls
           through to the write-through proxy and is answered by the hosted account. On the
           STANDALONE door the engine serves them itself (its organizer knows the mailbox's native
           \Junk), but the segment stays withheld there by the flag in front of it: "Use folders"
           has no consent row on that door (§17), and the shell gates the control on the flag.
           `local-junk.ts` carries the argument. */
        {...{ junkWire: junkOverBridge }}
        /* SETTINGS → SUBSCRIPTION, SECURITY AND ACCOUNT — the three panes the web client has on a
           hosted account and this window did not, so its Settings nav was simply shorter with
           nothing on screen saying why. An absent entry does not read as "this is done elsewhere";
           it reads as "this product does not have that", which for account deletion contradicts
           what the site promises.

           Subscription carries real facts (the plan, the renewal, the actions left) and the one
           control among the three that is an ordinary write — the managed-AI switch. The other two
           are doors: every control behind them is step-up gated, and nothing this app can do
           asserts a second factor, so a form here would collect a password and be refused. See
           `DesktopWebSection`. */
        {...(accountDoor ? { billingSection: <DesktopBilling /> } : {})}
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
        onUnread={onUnread}
      />
      {/* THE ONE-TIME DEFAULT-MAIL ASK — over the mail, once a mailbox is connected, and never
          twice: either answer persists, and "already the default" persists too. The Settings row
          above is the durable way back for whoever says "Not now". */}
      <DefaultMailAsk />
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
          cloudAction={overlay === "cloud" ? "signIn" : "configure"}
          onCancel={() => {
            /* CANCEL IS NOT "NOTHING HAPPENED". A door attempt inside this overlay may have
               already REPLACED the engine (`engine_configure` runs before the credential step —
               a rejected password, an abandoned browser handoff) without ever reaching
               `onEntered`, so no status was delivered and the epoch never moved: the stored
               /health answer still matches the current key while describing the PREVIOUS
               engine. Closing the overlay is the reveal moment — the mail client underneath
               would render on that stale answer — so the EPOCH advances here, which does what
               merely clearing the stored answer cannot: a /health probe already in flight holds
               the OLD key in its closure (and the shell deliberately lets requests finish
               against the engine being replaced), so a late old-engine answer would re-store
               under a still-current key. The bump re-keys the gate, retires both probe effects
               (their cleanup cancels the in-flight read), and withholds the app until the
               engine actually behind the bridge gives its own first /health — milliseconds, and
               a cancel that truly changed nothing costs one local probe. `refresh()` re-reads
               the shell for the same reason: the door state itself may have moved under an
               abandoned attempt. */
            setAuthEpoch((n) => n + 1);
            setOverlay(null);
            void refresh();
          }}
          onEntered={(r) => { if (r.status) onStatus(r.status); else void refresh(); }}
        />
        </div>
      ) : null}
    </>
  );
}

/**
 * WHAT THE ICON SAYS, AND WHEN THE MACHINE SPEAKS UP.
 *
 * One sink for the client's unread count, driving both native surfaces:
 *
 *  · the DOCK BADGE is the count itself, set every time it changes and removed at zero — a badge
 *    reading "0" is a badge saying there is nothing, which is what taking it off already says;
 *  · a NOTIFICATION fires only when the count RISES and the window is not the one being looked
 *    at. Falling counts are the user reading their own mail, and notifying somebody about mail
 *    they are looking at is the behaviour every mail client is disliked for.
 *
 * The first render seeds the previous count rather than notifying against zero: an app opened
 * with eleven unread messages has not just received eleven.
 */
function useUnreadSink(): (unread: number) => void {
  const previous = useRef<number | null>(null);
  return useCallback((unread: number) => {
    const before = previous.current;
    previous.current = unread;
    /* Swallowed rather than reported: a platform that cannot draw a badge (Windows carries an
       overlay icon instead) must not leave an unhandled rejection behind a piece of decoration. */
    void setBadge(unread).catch(() => {});
    if (before === null || unread <= before) return;
    if (typeof document !== "undefined" && document.hasFocus()) return;
    const fresh = unread - before;
    void notify(
      "ohmail",
      fresh === 1 ? "One new message for you." : `${fresh} new messages for you.`,
    ).catch(() => {
      /* Notifications are off for ohmail, or this platform has none. Not a reason to fail. */
    });
  }, []);
}

/**
 * WHAT A MENU COMMAND DOES — and every one of them is something the client already does.
 *
 * Three of the five are routes, so they take `go`, exactly as the navigation items do. The other
 * two — the command palette and the shortcut sheet — are state inside `AppShell`, which this file
 * is outside of and must stay outside of: the alternative is two more props threaded down through
 * a component that is also compiled into a browser tab, for two menu items that exist only here.
 *
 * ── SO THEY ARE DELIVERED AS THE KEYSTROKE THE CLIENT ALREADY BINDS ─────────────────────────
 *
 * The shared keymap is ONE `keydown` listener on `document`, and a dispatched event reaches it
 * exactly as a typed one does. So ⌘K from the menu runs the same binding ⌘K from the keyboard
 * runs — not a copy of it, and not a second way to open the palette that could drift from the
 * first. It also means an accelerator the platform swallowed on its way to the menu bar is handed
 * back to the page rather than lost, which is the actual problem: a menu item with ⌘K on it
 * PREVENTS the webview from ever seeing ⌘K.
 *
 * `bubbles` is true because the listener is on `document` and the event is dispatched on it;
 * `cancelable` is true because the binding calls `preventDefault()`, and an uncancelable event
 * makes that a silent no-op rather than an error.
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
