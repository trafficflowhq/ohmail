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
 * reserved for the case that matters, which is a shell that IS there and cannot answer.
 *
 * ── THE MAIL IS THE MAILBOX'S ───────────────────────────────────────────────────────────────
 *
 * When the shell says an engine is serving, `AppShell` below is handed a real client engine
 * running over the bridge (`bridge-fetch.ts`) and renders that mailbox — the same component, the
 * same views, the same keyboard, with the data coming from the process on this machine instead of
 * from fixtures. {@link mailMount} is the decision and it is a pure function, so which of the three
 * surfaces a given engine state produces is something a test drives rather than something this
 * component describes.
 *
 * Loaded WITHOUT a shell — a development server, or the render check that loads the built files in
 * a headless DOM — there is no engine to run against and the bundle shows the invented mailbox it
 * has always shown. That is the same "there is no shell" case the notice section below is about,
 * seen from the mail surface.
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
import { DoorChooser } from "./DoorChooser.js";
import { DesktopAbout } from "./DesktopAbout.js";
import { DesktopMailboxes, readMailboxFacts } from "./DesktopMailboxes.js";
import { DesktopScreening } from "./DesktopScreening.js";
import { GateNotice } from "./GateNotice.js";
import { DESKTOP_PANE_LABEL, DesktopSettings } from "./DesktopSettings.js";
import { DesktopBilling } from "./DesktopBilling.js";
import { DesktopWebSection } from "./DesktopWebSection.js";
import {
  accountDoorFor, awayDoorFor, gateFor, mailMount, profileImportDoorFor, readShell, suggestDoorFor,
  type Shell,
} from "./doors.js";
import { awayOverBridge } from "./local-away.js";
import { profileImportOverBridge } from "./local-profile-import.js";
import { consentOverBridge } from "./local-consent.js";
import { cloudSuggestWire } from "./cloud-suggest.js";
import { readAiStatus, type LocalAiStatus } from "./local-ai.js";
import { LocalSuggest } from "./local-suggest.js";
import { CloudSuggest } from "./CloudSuggest.js";
import { notify, onMenuCommand, onMenuNavigate, setBadge, type MenuCommand } from "./native.js";
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

  const onStatus = useCallback((next: EngineStatus) => {
    setShell({ kind: "status", status: next });
    setOverlay(null);
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
    /* Nothing has been asked yet, and no sample world: a window that guesses at this moment is a
       window that guesses wrong on a slow first launch. The same surface the opening state below
       draws — the skeleton behind its grace, the boot line at the rail's foot — with no phase,
       because no phase has been read. In the packaged app this frame lasts one status call; on a
       dev server it is replaced by the preview before either grace elapses. */
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

  if (mount.kind !== "sample" && engine === null) {
    /* A door is chosen and no engine has served yet — a first launch migrating a database, or an
       engine on its way back up. No mail: the two things this window could put on screen instead
       are a guess and the sample mailbox, and the sample mailbox under somebody's own address is
       the worse of the two. The settling poll above is what ends this state.

       AND, ONCE THE WAIT STOPS BEING AN ORDINARY ONE, THE SHAPE OF THE WINDOW BEHIND IT.
       `BootSkeleton` is `mailMount`'s answer drawn out, never a second opinion about it: this
       branch is chosen entirely above, and the silhouette is decoration inside a decision that
       has already been made. It carries no text and nothing derived from any mailbox, which is
       what keeps it on the right side of the rule this comment states — a shape is not the sample
       world, for exactly as long as there is nothing in it.

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
        /* The invented mailbox is what a window with no engine behind it shows; a window with one
           shows that engine's mail. `demo` is the client's own flag for the first — it is what
           puts the ribbon on screen and freezes the clock — and it must be false in the second,
           because every one of those things would be a lie about somebody's own mail. */
        demo={engine === null}
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
        onUnread={onUnread}
      />
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
          onCancel={() => setOverlay(null)}
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
