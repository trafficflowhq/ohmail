/**
 * SETTINGS → THIS INSTALL: which door, which mailbox, and the three things that change
 * either. The desktop registers this pane with Settings. Signing out clears the sealed
 * credential and removes the settings file through the native shell. The pane says what each
 * action does before the press, including what happens to the copy of the mail.
 */

import { useState } from "react";
import { Button } from "@ohmail/ui/base";
import { SettingLine, SettingNote, SettingsSheet } from "@ohmail/ui/mail";

import { engineLogout, type EngineStatus, type SignedOut } from "./bridge-fetch.js";
import { renewCloudSession } from "./cloud-session.js";
import type { HostedSession } from "./doors.js";
import { DOOR_COPY, machineWord } from "./door-copy.js";
import { hostLabelOf, isDesktopHost, isManagedDoor, pairedHostOf, pairedViaOf } from "./doors.js";
import { agoStamp } from "../../webapp/app/shell/format";
import { DesktopAiSettings } from "./DesktopAiSettings.js";
import { DefaultMailRow } from "./DesktopDefaultMail.js";
import type { LocalAiStatus } from "./local-ai.js";

/* WHAT THIS INSTALL DOES WITH THE MAILBOX BELOW — "organizes" or "reads". One rule, two
   panes and one confirmation bullet; see `install-role.ts` for the measured defect and
   why the predicate is the shared one. `useMailboxFacts` is the NON-throwing accessor,
   so a pane mounted without the provider keeps the sentence it always had. */
import { useMailboxFacts } from "@ohmail/app-logic/mail-state/mail-state-binding";
import { isRemovedMailbox, readerHolder, screenerMode } from "@ohmail/app-logic/mail-state/mail-state";
import { mailboxRowWhy } from "./install-role.js";

/**
 * The label the Settings nav shows for this pane. "Desktop", not "This install": every other
 * entry names a THING — Mailboxes, Tags, Rules, Screener — and a relationship reads as jargon
 * beside them. A FUNCTION, not a constant: the word comes from the catalogue, which the host
 * sets during ITS render — a module-level constant would be evaluated at import time, before
 * any provider exists, and never again. `desktopScreener.autoSuggestNoModel` names this pane
 * inside a sentence, so a frozen English word here would sit in the middle of a German one.
 */
export function desktopPaneLabel(): string {
  return DOOR_COPY.paneLabel;
}

/**
 * What this install says about its credential, in words rather than the engine's vocabulary.
 * Hosted has a session ("Account session"); standalone has NO sign-in at all — the credential
 * is a mailbox password, so "Login: Signed out" described a state with no signing-in to undo.
 * The STANDALONE door keeps five states and five sentences because the recoveries differ;
 * "connected / not" sends somebody to re-enter a password that was never the problem. On the CLOUD door
 * `credentialState` is the LAUNCH frame, never rewritten, and a cloud sign-in happens IN
 * PLACE — a pre-auth start reported "Signed out" over arriving mail; the cloud arm reads the
 * live verdict (`HostedSession`), and the other four states stay the engine's own.
 */
function credentialLine(
  status: EngineStatus,
  session: HostedSession,
  host: string | null,
): { label: string; value: string; description: string } {
  const cloud = status.mode === "cloud";
  /* ── THE PAIRED DOOR IS ITS OWN ROW, ABOVE THE CLOUD ARM ─────────────────────────────────
   * "Account session · Signed in · This install holds a session for your hosted account" says
   * the wrong thing twice on a paired desktop: there is no account, and what would end this is
   * somebody pressing Remove on the OTHER computer — which the row therefore names, it being
   * also the only remedy. `host === null` falls through to the cloud arm rather than rendering
   * a sentence with a hole in it; that is reachable only for a broken frame (`desktop-host`
   * with no readable `baseUrl`), and the cloud arm's wording is at least true about a session. */
  if (isDesktopHost(status) && host !== null) {
    const label = DOOR_COPY.credHostLabel;
    return session === "live"
      ? {
          label,
          value: DOOR_COPY.credHostLiveValue,
          description: DOOR_COPY.credHostLiveWhy(machineWord(), host),
        }
      : session === "out"
        ? {
            label,
            value: DOOR_COPY.credHostOutValue,
            description: DOOR_COPY.credHostOutWhy(host, machineWord()),
          }
        : {
            label,
            value: DOOR_COPY.credCloudCheckingValue,
            description: DOOR_COPY.credHostCheckingWhy,
          };
  }
  const label = cloud ? DOOR_COPY.credCloudLabel : DOOR_COPY.localPassword;
  /* ── THE TWO NON-LIVE ARMS ARE DEFENSIVE, AND SAYING SO IS THE POINT ──────────────────────
   * Neither is reachable from `DesktopGate` today: the gate returns the door chooser on a
   * pre-auth engine and the expiry notice on a dead session, both BEFORE it renders
   * `AppShell` — and this pane is `AppShell`'s `desktopSection`, so `session` is always `live`
   * here. They stay, worded, because the condition making them unreachable is three components
   * away and not this file's to keep. What must never return is the previous shape: a sentence
   * derived from a field that COULD disagree with the window around it, and did. */
  if (cloud) {
    return session === "live"
      ? { label, value: DOOR_COPY.credCloudLiveValue, description: DOOR_COPY.credCloudLiveWhy }
      : session === "out"
        ? { label, value: DOOR_COPY.credCloudOutValue, description: DOOR_COPY.credCloudOutWhy }
        : {
            label,
            value: DOOR_COPY.credCloudCheckingValue,
            description: DOOR_COPY.credCloudCheckingWhy,
          };
  }
  /* EVERY ARM BELOW IS THE STANDALONE DOOR'S — the cloud door returned above. The two that used
     to carry a `cloud ? … : …` ternary lost it with that return: a branch no call can reach is a
     second wording of the session states that nothing keeps in step with the first. */
  switch (status.credentialState) {
    case "ready":
      return {
        label,
        value: DOOR_COPY.credReadyValue,
        description: DOOR_COPY.credReadyWhy(machineWord()),
      };
    case "absent":
      return {
        label,
        value: DOOR_COPY.credAbsentValue,
        description: DOOR_COPY.credAbsentWhy(machineWord()),
      };
    case "unreadable":
      return {
        label,
        value: DOOR_COPY.credUnreadableValue,
        description: DOOR_COPY.credUnreadableWhy,
      };
    /* THE BOOT CONTRACT, in words. What disagrees is which server the password was proved
       against and which one this install is set to use, so the engine withheld it rather than
       offer one server's password to another. "Needs re-entering" would be true of the action
       and false about the cause — a person re-typing a password into whichever server the
       install points at is the exact thing this seam exists to stop. It does NOT claim the
       keystore can open the row: servers are compared before decrypting, so `foreign-host`
       takes precedence over `unreadable`. And it may not say "it has not been sent to either" —
       FALSE: `PATCH /mailboxes/:id` already PROVED the password against the server it
       recorded; a reassurance broader than the code is worse than none. */
    case "foreign-host":
      return { label, value: DOOR_COPY.credForeignValue, description: DOOR_COPY.credForeignWhy };
    default:
      return { label, value: DOOR_COPY.credUnknownValue, description: DOOR_COPY.credUnknownWhy };
  }
}

/**
 * WHY THE ENGINE ROW IS DRAWN AT ALL, and it is drawn only when it is the problem.
 *
 * "Mail engine: Running" was a permanent row stating the ordinary case. It is the ordinary case on
 * every healthy install, which makes it a line that never says anything — and a settings pane whose
 * rows are mostly noise is one whose one real warning gets read as noise too. `serving` renders
 * nothing now; every other state renders the row with the sentence for THAT state, because the
 * recoveries differ and "stopped and did not come back" is false of an engine that is still coming
 * up. That distinction is the whole reason this is a function and not one string.
 */
function engineWhy(status: EngineStatus): string {
  switch (status.state) {
    case "starting":
    case "restarting":
      return DOOR_COPY.engineWhyStarting;
    case "stopped":
      return DOOR_COPY.engineWhyStopped;
    case "failed":
      return DOOR_COPY.engineWhyFailed;
    case "no_key":
      return DOOR_COPY.engineWhyNoKey(machineWord());
    case "not_configured":
      return DOOR_COPY.doorNoneWhy;
    default:
      return DOOR_COPY.engineWhyUnknown;
  }
}

/** The engine's own state, as one line. `serving` is the only one that needs no explanation. */
function engineLine(status: EngineStatus): string {
  switch (status.state) {
    case "serving":
      return DOOR_COPY.engineRunning;
    case "starting":
      return DOOR_COPY.engineStarting;
    case "restarting":
      return DOOR_COPY.engineRestarting;
    case "stopped":
      return DOOR_COPY.engineStopped;
    case "failed":
      return status.reason ?? DOOR_COPY.engineFailed;
    /* THE MACHINE'S OWN WORD, where this line alone said "computer" whatever the build was — one
       row under a sentence that resolved it correctly, so a Windows install read "This PC's
       keystore would not answer, so …" beside "This computer's keystore would not answer". */
    case "no_key":
      return status.reason ?? DOOR_COPY.engineNoKey(machineWord());
    case "not_configured":
      return DOOR_COPY.engineNotConfigured;
    default:
      return DOOR_COPY.engineUnknown;
  }
}

export function DesktopSettings({
  status,
  /** The status this pane produced. The gate re-reads its own routing from it. */
  onStatus,
  /** Open the door chooser over the app. The gate owns that overlay. */
  onSwitchDoor,
  /** Open the hosted sign-in form. Offered only on the cloud door. */
  onSignIn,
  /**
   * Published upward whenever the model settings below change, so the Screener's own suggest
   * control learns about a key that was just saved without waiting for a relaunch.
   */
  onAiStatus,
  /**
   * THIS ENGINE'S LIVE VERDICT ON THE HOSTED SESSION — the gate's `hostedSession`, handed down
   * rather than re-derived, so the pane and the window can never disagree about whether this
   * install is signed in. Only the cloud door reads it; see {@link credentialLine}.
   */
  session,
  /**
   * THIS ENGINE COULD NOT WRITE THE SESSION TO DISK (`/health.sealed === false`). A rotation the
   * filesystem refused was a log line while the door reported it done, so the first anybody heard
   * of it was a password prompt after the next restart. Handed down like `session`, from the one
   * probe, so the pane cannot disagree with the window.
   */
  sealFailed = false,
  /**
   * HOW OLD THE COPY FROM THE OTHER COMPUTER IS — the paired door's Connection row, handed down
   * from the gate rather than read again here.
   *
   * The gate already polls `GET /mirror/freshness` on this door to decide whether the rail says
   * anything; a second read here would be a second clock for one fact, and the row and the rail
   * would disagree for up to twenty seconds at a time about whether the other machine is
   * answering. `null` on every other door, and before the first answer.
   */
  connection,
  defaultMail = false,
  /** Open the pairing card over the app, for an install whose pairing has ended. */
  onPairAgain,
  /** Begin setting this machine up on its own — the gate owns that flow. */
  onTakeOver,
}: {
  status: EngineStatus;
  session: HostedSession;
  sealFailed?: boolean;
  connection?: { state: "unknown" | "stale" | "current"; asOf: string | null } | null;
  defaultMail?: boolean;
  onStatus: (next: EngineStatus, stillListedFrom?: EngineStatus | null, waiting?: SignedOut["waiting"]) => void;
  onSwitchDoor: () => void;
  onSignIn: () => void;
  onPairAgain?: () => void;
  onTakeOver?: () => void;
  onAiStatus?: (next: LocalAiStatus | null) => void;
}) {
  /* Two states, held as one value rather than two booleans: "resting" and "asked whether you
     meant it". The same shape the tag rows use, and for the reason given there — two booleans
     can both be true, which is a state there is no rendering for. */
  const [mode, setMode] = useState<"rest" | "confirm">("rest");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  /* Try again after a refused save: the engine renews now rather than on its own clock. The gate's
     next probe carries whatever that leaves; nothing here decides the session. */
  const retrySeal = async (): Promise<void> => {
    if (retrying) return;
    setRetrying(true);
    try {
      await renewCloudSession();
    } finally {
      setRetrying(false);
    }
  };

  /* What this install's door is called. Built in the render for the reason `DesktopAbout`'s is:
     both halves are catalogue reads, and a module constant would freeze the locale that was set
     when this file was first imported. */
  const doorName: Record<string, string> = {
    local: DOOR_COPY.doorLocalName(machineWord()),
    cloud: isManagedDoor(status) ? DOOR_COPY.doorCloudName : DOOR_COPY.doorServerNamed,
  };
  /* THE OTHER COMPUTER'S NAME, or null. Every paired sentence below interpolates it, and each one
     falls back to the door's older wording rather than rendering a hole — see `credentialLine`. */
  const host = pairedHostOf(status);
  const paired = isDesktopHost(status) && host !== null;
  const door = paired
    ? host
    : status.mode ? (doorName[status.mode] ?? status.mode) : DOOR_COPY.doorNotChosen;
  const credential = credentialLine(status, session, host);
  /* "organizes" or "reads" — see `install-role.ts`. This pane said the first on an install that
     did the second, beside a Mailboxes pane saying the truth on the same machine. */
  const facts = useMailboxFacts();
  const readOnly = readerHolder(screenerMode(facts));
  /* THE MAILBOXES THIS INSTALL HOLDS, from the roster (`GET /mailboxes`). `status.address` is the
     seed in the settings file, which stays when the seed is removed while another mailbox remains,
     so it named a mailbox the install no longer held. Before the roster answers: the seed. */
  const held = facts === null ? null : facts.filter((m) => !isRemovedMailbox(m)).map((m) => m.address);
  const multipleMailboxes = held !== null && held.length > 1;
  const mailboxValue = held === null ? (status.address ?? "—") : held.length > 0 ? held.join(", ") : "—";

  const signOut = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    try {
      const out = await engineLogout({ status, session });
      onStatus(out.status, out.stillListedFrom, out.waiting);
      setMode("rest");
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const reach = paired ? connectionLine(connection ?? null, pairedViaOf(status)) : null;
  const signOutWhy = paired
    ? DOOR_COPY.installSignOutWhyHost(host, machineWord())
    : DOOR_COPY.installSignOutWhy(machineWord());
  const confirmWhy = paired
    ? DOOR_COPY.installSignOutConfirmWhyHost(machineWord(), host)
    : DOOR_COPY.installSignOutConfirmWhy(machineWord());

  return (
    <>
      <SettingsSheet title={DOOR_COPY.aboutInstallHead} sign="desktop">
        <SettingLine
          label={multipleMailboxes ? DOOR_COPY.mailboxesLabel : DOOR_COPY.mailboxLabel}
          description={mailboxRowWhy(readOnly, paired ? host : null)}
          value={multipleMailboxes ? undefined : mailboxValue}
        >
          {multipleMailboxes ? <span className="set-val-left">{mailboxValue}</span> : null}
        </SettingLine>
        <SettingLine
          label={DOOR_COPY.installConnectedThrough}
          description={doorDescription(status, host)}
          value={door}
        />
        {reach ? <SettingLine label={DOOR_COPY.connLabel} {...reach} /> : null}
        {status.state !== "serving" ? (
          <SettingLine label={DOOR_COPY.engineLabel} description={engineWhy(status)} value={engineLine(status)} />
        ) : null}
      </SettingsSheet>

      <SettingsSheet title={DOOR_COPY.installChangingHead}>
        <SettingLine {...credential} />
        {sealFailed ? (
          <SettingLine label={DOOR_COPY.cloudSealPausedTitle(machineWord())} description={DOOR_COPY.credSealFailedNote(machineWord())}>
            {status.mode === "cloud" && session === "live" ? (
              <Button kind="quiet" size="s" onPress={() => void retrySeal()} disabled={retrying}>
                {DOOR_COPY.gateTryAgain}
              </Button>
            ) : null}
          </SettingLine>
        ) : null}
        {problem ? <SettingNote warn>{problem}</SettingNote> : null}
        {status.mode === "cloud" && session === "out" && !paired ? (
          <SettingLine label={DOOR_COPY.installSignInAgain} description={DOOR_COPY.installSignInAgainWhy}>
            <Button kind="quiet" size="s" onPress={onSignIn}>{DOOR_COPY.signIn}</Button>
          </SettingLine>
        ) : null}
        {paired && session === "out" && onPairAgain ? (
          <SettingLine label={DOOR_COPY.installPairAgain} description={DOOR_COPY.installPairAgainWhy(host, machineWord())}>
            <Button kind="quiet" size="s" onPress={onPairAgain} disabled={busy}>{DOOR_COPY.hostPair}</Button>
          </SettingLine>
        ) : null}
        {paired && onTakeOver ? (
          <SettingLine label={DOOR_COPY.takeoverLabel(machineWord())} description={DOOR_COPY.takeoverWhy(host, machineWord())}>
            <Button kind="quiet" size="s" onPress={onTakeOver} disabled={busy}>{DOOR_COPY.takeoverAction}</Button>
          </SettingLine>
        ) : null}
        <SettingLine
          label={DOOR_COPY.installSwitch}
          description={paired
            ? DOOR_COPY.installSwitchWhyHost(host, machineWord())
            : DOOR_COPY.installSwitchWhy(machineWord())}
        >
          <Button kind="quiet" size="s" onPress={onSwitchDoor} disabled={busy}>{DOOR_COPY.installSwitchAction}</Button>
        </SettingLine>
        {status.pairingLeftAt ? (
          <SettingNote>
            {DOOR_COPY.pairingLeftAt(hostLabelOf(status.pairingLeftAt) ?? status.pairingLeftAt, machineWord())}
          </SettingNote>
        ) : null}
        {mode === "confirm" ? (
          <SettingLine label={DOOR_COPY.installSignOutConfirm} description={confirmWhy}>
            <Button kind="quiet" size="s" onPress={() => setMode("rest")} disabled={busy}>{DOOR_COPY.cancel}</Button>
            <Button size="s" onPress={() => void signOut()} disabled={busy}>
              {busy ? DOOR_COPY.installSigningOut : DOOR_COPY.signOut}
            </Button>
          </SettingLine>
        ) : (
          <SettingLine label={DOOR_COPY.signOut} description={signOutWhy}>
            <Button kind="quiet" size="s" onPress={() => setMode("confirm")} disabled={busy}>{DOOR_COPY.signOut}</Button>
          </SettingLine>
        )}
        <SettingNote>{DOOR_COPY.installPasswordNote}</SettingNote>
      </SettingsSheet>

      {defaultMail ? <SettingsSheet><DefaultMailRow /></SettingsSheet> : null}
      <DesktopAiSettings door={status.mode ?? null} {...(onAiStatus ? { onStatus: onAiStatus } : {})} />
    </>
  );
}

/**
 * WHAT THE "CONNECTED THROUGH" ROW SAYS, per door.
 *
 * The paired arm is the one that needs an argument beyond the mode: it names the other computer,
 * and on a Tailscale origin it also carries the FULL origin. That origin appears exactly once in
 * the whole interface, here, and it is here rather than in the rail because two laptops with the
 * same machine name on two tailnets read alike everywhere else — this is the row somebody opens
 * to tell them apart.
 */
function doorDescription(status: EngineStatus, host: string | null): string {
  if (isDesktopHost(status) && host !== null) {
    return pairedViaOf(status) === "lan"
      ? DOOR_COPY.doorHostWhyLan(host, machineWord())
      : DOOR_COPY.doorHostWhyTs(host, machineWord(), status.cloudUrl ?? host);
  }
  if (status.mode === "cloud") return DOOR_COPY.doorCloudWhy;
  if (status.mode === "local") return DOOR_COPY.doorLocalWhy;
  return DOOR_COPY.doorNoneWhy;
}

/**
 * THE CONNECTION ROW — present in EVERY state, `current` included. A row that appears only
 * when something is wrong is a row nobody knows to look for on the day it is missing, and
 * this one answers a question people ask before anything has gone wrong. `null` means the
 * engine has not been asked yet — its own value, not an absence. The stamp is ABSOLUTE here
 * and relative in the rail, from the same call: the rail is glanced at ("3 days ago" reads
 * as "since"); this row is opened to know exactly when, and "3 Sep 2026, 18:40" is that answer.
 */
function connectionLine(
  freshness: { state: "unknown" | "stale" | "current"; asOf: string | null } | null,
  via: "lan" | "ts" | null,
): { value: string; description: string } {
  const when = freshness?.asOf ? agoStamp(freshness.asOf, Date.now()).abs : "—";
  const check = via === "lan" ? DOOR_COPY.hostCheckLan(machineWord()) : DOOR_COPY.hostCheckTs;
  if (freshness?.state === "current") {
    return { value: DOOR_COPY.connCurrentValue, description: DOOR_COPY.connCurrentWhy(when) };
  }
  if (freshness?.state === "stale") {
    return {
      value: DOOR_COPY.connStaleValue,
      description: DOOR_COPY.connStaleWhy(when, machineWord()),
    };
  }
  /* `unknown` AND "not asked yet" render alike, and that is the honest reading of both: no pull
     has completed, so there is nothing to report but what to check. */
  return { value: DOOR_COPY.connUnknownValue, description: check };
}
