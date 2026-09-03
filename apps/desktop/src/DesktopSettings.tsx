/**
 * SETTINGS → THIS INSTALL: which door, which mailbox, and the three things that change either.
 *
 * The pane the shared `SettingsView` cannot contain. Every control here is a call to the native
 * shell — a command, or a request down the pipe the shell holds — and that file is compiled into
 * a browser tab as well as into this app. So it takes the pane as a node and this file supplies
 * one, which is the same seam the hosted client uses for its Account and Security panes and the
 * mirror image of it: the web has no shell, the desktop has no account.
 *
 * ── THE WEBVIEW NEVER TOUCHES THE DISK, INCLUDING HERE ──────────────────────────────────────
 *
 * Signing out clears a sealed credential and removes a settings file, and both of those happen
 * in the shell. This page's part is one command and rendering what it answered. There is no
 * filesystem access to grant and none is granted — the window's whole reach is the handful of
 * commands the shell registers.
 *
 * ── WHAT EACH ACTION COSTS, SAID BEFORE IT IS TAKEN ─────────────────────────────────────────
 *
 * Signing out keeps the copy of your mail that is already on this machine and clears the login.
 * Switching doors freezes the mirror you are leaving instead of deleting it. Both sentences are
 * on screen next to the button, because both are the question somebody is actually asking, and
 * an app that answers them afterwards has answered too late.
 */

import { useState } from "react";
import { Button, SettingsNote, SettingsRow, SettingsSection, SettingsSubhead } from "@ohmail/ui";

import { engineLogout, type EngineStatus } from "./bridge-fetch.js";
import type { HostedSession } from "./doors.js";
import { DOOR_COPY, machineWord } from "./door-copy.js";
import { DesktopAiSettings } from "./DesktopAiSettings.js";
import type { LocalAiStatus } from "./local-ai.js";

/* WHAT THIS INSTALL DOES WITH THE MAILBOX BELOW — "organizes" or "reads". One rule, two
   panes and one confirmation bullet; see `install-role.ts` for the measured defect and
   why the predicate is the shared one. `useMailboxFacts` is the NON-throwing accessor,
   so a pane mounted without the provider keeps the sentence it always had. */
import { useMailboxFacts } from "../../webapp/app/shell/MailStateProvider";
import { screenerReadOnly } from "../../webapp/app/shell/mail-state";
import { mailboxRowWhy } from "./install-role.js";

/**
 * The label the Settings nav shows for this pane. Supplied with the node; see `SettingsView`.
 *
 * "Desktop", not "This install". Every other entry in that list names a THING — Mailboxes, Tags,
 * Rules, Screener — and this one named a relationship, which reads as jargon beside them and gives
 * no clue that it is where the app itself is configured.
 *
 * A FUNCTION, not a constant, and that is the whole of what the translation changed here: the
 * word comes from the catalogue, which the host sets during ITS render, and a module-level
 * constant would be evaluated at import time — long before any provider exists — and then never
 * again. `desktopScreener.autoSuggestNoModel` names this pane inside a sentence, so a frozen
 * English word here would be an English word in the middle of a German one.
 */
export function desktopPaneLabel(): string {
  return DOOR_COPY.paneLabel;
}

/**
 * What this install says about its credential, in words rather than in the engine's vocabulary.
 *
 * ── THE ROW IS NOT THE SAME QUESTION ON BOTH DOORS ──────────────────────────────────────────
 *
 * It was "Login: Signed in" everywhere, which is one word for two different things. On the hosted
 * door there is a sign-in and a session, so "Account session" is what the row is about. On the
 * standalone door there is NO sign-in at all — the credential is the mailbox password this
 * computer holds for an IMAP server — so "Login" invited somebody to look for an account they do
 * not have, and "Signed out" described a state that has no signing-in to undo.
 *
 * The STANDALONE door keeps five states and five different sentences, because the recoveries are
 * different: nothing to do, type it again, type it again for a different reason, finish the server
 * change you started, and "this engine is newer than this window, so carry on". Collapsing them
 * into "connected / not connected" is how somebody is sent to re-enter a password that was never
 * the problem.
 *
 * ── AND ON THE CLOUD DOOR THE FIELD IT SWITCHED ON WAS THE WRONG ONE ────────────────────────
 *
 * `credentialState` is the engine's LAUNCH frame, copied through `engine_status` unchanged for
 * the life of the process. On the STANDALONE door that is harmless: re-sealing a mailbox password
 * restarts the engine, so the next frame carries the new state. On the CLOUD door a sign-in
 * happens IN PLACE (`POST /cloud/signin` against the running engine), so an install that started
 * pre-auth kept reporting `absent` — and this pane told somebody whose mail was arriving that
 * they were "Signed out" and offered to sign them in again, beside a Settings nav that had
 * dropped six panes for the same reason. The live verdict is the one the window routes the whole
 * app off (`HostedSession`), so it is what the cloud arm reads; the other four states are about a
 * stored secret and stay the engine's own.
 */
function credentialLine(
  status: EngineStatus,
  session: HostedSession,
): { label: string; value: string; description: string } {
  const cloud = status.mode === "cloud";
  const label = cloud ? DOOR_COPY.credCloudLabel : DOOR_COPY.localPassword;
  /* ── THE TWO NON-LIVE ARMS ARE DEFENSIVE, AND SAYING SO IS THE POINT ──────────────────────
   *
   * Neither is reachable from `DesktopGate` today: the gate returns the door chooser on a pre-auth
   * engine and the expiry notice on a dead session, both BEFORE it renders `AppShell` — and this
   * pane is `AppShell`'s `desktopSection`. So on the cloud door `session` is always `live` here.
   *
   * They stay, worded, for one reason: the condition that makes them unreachable is three
   * components away and is not this file's to keep. What must never come back is the previous
   * shape, where the pane derived the sentence from a field that COULD disagree with the window
   * around it and did — telling a signed-in person they were signed out. An arm that agrees with
   * the gate is safe whether or not the gate ever selects it; a second source of truth is not. */
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
    /* THE BOOT CONTRACT, in words. What disagrees is which server the password was proved against
       and which one this install is set to use, so the engine withheld it rather than offer one
       server's password to another. Saying "needs re-entering" here would be true of the action
       and false about the cause, and it is the exact sentence the credential-state seam exists to
       stop: a person re-typing a password into whichever of the two servers the install happens to
       be pointing at.

       It does NOT claim the keystore can open the row. The engine compares the servers before it
       decrypts, so `foreign-host` takes precedence over `unreadable` rather than ruling it out.

       ── WHAT THIS SENTENCE MAY NOT SAY, AND WHY ─────────────────────────────────────────────
       It said "it has not been sent to either" and that was FALSE. Reaching this state by the
       ordinary route means `PATCH /mailboxes/:id` already PROVED the password against the server
       it recorded — a real login to a real server — so the only true claim is about the server
       this install is currently configured for, which is the one that was withheld from. A
       reassurance about credential handling that is broader than the code is worse than none. */
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
}: {
  status: EngineStatus;
  session: HostedSession;
  onStatus: (next: EngineStatus) => void;
  onSwitchDoor: () => void;
  onSignIn: () => void;
  onAiStatus?: (next: LocalAiStatus | null) => void;
}) {
  /* Two states, held as one value rather than two booleans: "resting" and "asked whether you
     meant it". The same shape the tag rows use, and for the reason given there — two booleans
     can both be true, which is a state there is no rendering for. */
  const [mode, setMode] = useState<"rest" | "confirm">("rest");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  /* What this install's door is called. Built in the render for the reason `DesktopAbout`'s is:
     both halves are catalogue reads, and a module constant would freeze the locale that was set
     when this file was first imported. */
  const doorName: Record<string, string> = {
    local: DOOR_COPY.doorLocalName(machineWord()),
    cloud: DOOR_COPY.doorCloudName,
  };
  const door = status.mode ? (doorName[status.mode] ?? status.mode) : DOOR_COPY.doorNotChosen;
  const credential = credentialLine(status, session);
  /* "organizes" or "reads" — see `install-role.ts`. This pane said the first on an install that
     did the second, beside a Mailboxes pane saying the truth on the same machine. */
  const readOnly = screenerReadOnly(useMailboxFacts());

  const signOut = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    try {
      onStatus(await engineLogout());
      setMode("rest");
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsSection>
      <SettingsRow
        label={DOOR_COPY.mailboxLabel}
        description={mailboxRowWhy(readOnly)}
        value={status.address ?? "—"}
      />
      <SettingsRow
        label={DOOR_COPY.installConnectedThrough}
        description={doorDescription(status.mode)}
        value={door}
      />
      <SettingsRow
        label={credential.label}
        description={credential.description}
        value={credential.value}
      />
      {/* Only when it is NOT serving — see `engineWhy`. A row that says "Running" on every healthy
          install is a row nobody reads, including on the day it stops saying it. */}
      {status.state === "serving" ? null : (
        <SettingsRow
          label={DOOR_COPY.engineLabel}
          description={engineWhy(status)}
          value={engineLine(status)}
        />
      )}

      <SettingsSubhead>{DOOR_COPY.installChangingHead}</SettingsSubhead>

      {problem ? <p className="join-error">{problem}</p> : null}

      {status.mode === "cloud" && session === "out" ? (
        <SettingsRow
          label={DOOR_COPY.installSignInAgain}
          description={DOOR_COPY.installSignInAgainWhy}
          control={<Button onClick={onSignIn}>{DOOR_COPY.signIn}</Button>}
        />
      ) : null}

      {/* "YOUR OHMAIL ACCOUNT" WAS HERE, AND IT HAS MOVED — into the three panes it was standing
          in for. It was one row that named a password, an authenticator, recovery codes and a plan
          together, on the pane about this INSTALL, because Settings had no Security, Account or
          Subscription pane at all on the hosted door. Those panes exist now
          (`DesktopWebSection`, `DesktopBilling`) and each carries its own door out, so keeping this
          row would be a second door to the same place under different words — on the one pane
          nobody looking for their password would think to open. Everything below this line is about
          the install: which mailbox, which door, and how to change either. */}

      <SettingsRow
        label={DOOR_COPY.installSwitch}
        description={DOOR_COPY.installSwitchWhy(machineWord())}
        control={
          <Button onClick={onSwitchDoor} disabled={busy}>{DOOR_COPY.installSwitchAction}</Button>
        }
      />

      {mode === "confirm" ? (
        <SettingsRow
          label={DOOR_COPY.installSignOutConfirm}
          description={DOOR_COPY.installSignOutConfirmWhy(machineWord())}
          control={
            <span className="set-tag-acts">
              <Button variant="primary" className="danger" onClick={() => void signOut()} disabled={busy}>
                {busy ? DOOR_COPY.installSigningOut : DOOR_COPY.signOut}
              </Button>
              <Button variant="ghost" onClick={() => setMode("rest")} disabled={busy}>
                {DOOR_COPY.cancel}
              </Button>
            </span>
          }
        />
      ) : (
        <SettingsRow
          label={DOOR_COPY.signOut}
          description={DOOR_COPY.installSignOutWhy(machineWord())}
          control={
            <Button onClick={() => setMode("confirm")} disabled={busy}>{DOOR_COPY.signOut}</Button>
          }
        />
      )}

      <SettingsNote>{DOOR_COPY.installPasswordNote}</SettingsNote>

      {/* WHAT BELONGS IN THIS MAILBOX'S OHBOX HAS MOVED, to Settings → Screener, where the rest
          of the screening controls are and where somebody looking for it would look first. It was
          here because this pane was the only one on the desktop with a working transport; it is
          not any more. `DesktopScreening.tsx` is the same editor over the same column. */}

      {/* The model, last, because it is the one part of this install that is optional. Everything
          above describes a mailbox that has to work; this describes something you may never turn
          on, and the app is complete without it. */}
      <DesktopAiSettings door={status.mode ?? null} {...(onAiStatus ? { onStatus: onAiStatus } : {})} />
    </SettingsSection>
  );
}

function doorDescription(mode: EngineStatus["mode"]): string {
  if (mode === "cloud") return DOOR_COPY.doorCloudWhy;
  if (mode === "local") return DOOR_COPY.doorLocalWhy;
  return DOOR_COPY.doorNoneWhy;
}
