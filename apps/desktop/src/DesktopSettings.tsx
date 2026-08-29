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
import { DesktopAiSettings } from "./DesktopAiSettings.js";
import type { LocalAiStatus } from "./local-ai.js";
import { MACHINE_WORD } from "./platform.js";

/**
 * The label the Settings nav shows for this pane. Supplied with the node; see `SettingsView`.
 *
 * "Desktop", not "This install". Every other entry in that list names a THING — Mailboxes, Tags,
 * Rules, Screener — and this one named a relationship, which reads as jargon beside them and gives
 * no clue that it is where the app itself is configured.
 */
export const DESKTOP_PANE_LABEL = "Desktop";

const DOOR_NAME: Record<string, string> = {
  local: `On this ${MACHINE_WORD}`,
  cloud: "ohmail Cloud",
};

/**
 * What the engine says about the credential, in words rather than in its own vocabulary.
 *
 * Four states and four different sentences, because the recoveries are different: nothing to do,
 * type it again, type it again for a different reason, and "this engine is newer than this
 * window, so carry on". Collapsing them into "connected / not connected" is how somebody is sent
 * to re-enter a password that was never the problem.
 */
function credentialLine(status: EngineStatus): { value: string; description: string } {
  const cloud = status.mode === "cloud";
  switch (status.credentialState) {
    case "ready":
      return {
        value: "Signed in",
        description: cloud
          ? "This install holds a session for your hosted account."
          : `Your mailbox password is stored on this ${MACHINE_WORD} and works.`,
      };
    case "absent":
      return {
        value: "Signed out",
        description: cloud
          ? "There is no session for this account on this machine. Sign in again below."
          : `No mailbox password is stored on this ${MACHINE_WORD}, so nothing is being synced yet.`,
      };
    case "unreadable":
      return {
        value: "Needs re-entering",
        description:
          "Something is stored, and this install's key does not open it. Entering it again " +
          "seals it afresh; no mail is affected.",
      };
    default:
      return {
        value: "Unknown",
        description:
          "The mail engine did not say, which happens when it is newer than this window. " +
          "Nothing is wrong.",
      };
  }
}

/** The engine's own state, as one line. `serving` is the only one that needs no explanation. */
function engineLine(status: EngineStatus): string {
  switch (status.state) {
    case "serving":
      return "Running";
    case "starting":
      return "Starting…";
    case "restarting":
      return "Restarting…";
    case "stopped":
      return "Stopped";
    case "failed":
      return status.reason ?? "Stopped and did not come back";
    case "no_key":
      return status.reason ?? "This computer's keystore would not answer";
    case "not_configured":
      return "No mailbox chosen";
    default:
      return "Not in this build";
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
}: {
  status: EngineStatus;
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

  const door = status.mode ? (DOOR_NAME[status.mode] ?? status.mode) : "Not chosen";
  const credential = credentialLine(status);

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
        label="Mailbox"
        description="The mailbox this copy of ohmail organizes."
        value={status.address ?? "—"}
      />
      <SettingsRow label="Connected through" description={doorDescription(status.mode)} value={door} />
      <SettingsRow
        label="Login"
        description={credential.description}
        value={credential.value}
      />
      <SettingsRow label="Mail engine" description="The process that opens your mailbox." value={engineLine(status)} />

      <SettingsSubhead>Changing this install</SettingsSubhead>

      {problem ? <p className="join-error">{problem}</p> : null}

      {status.mode === "cloud" && status.credentialState !== "ready" ? (
        <SettingsRow
          label="Sign in again"
          description="Your hosted session has gone. Signing in happens in the mail engine on this machine."
          control={<Button onClick={onSignIn}>Sign in</Button>}
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
        label="Switch mailbox"
        description={
          `Open a different mail server, or move between this ${MACHINE_WORD} and your hosted ` +
          "account. The copy of your mail from this one is frozen where it is rather than " +
          "deleted, so coming back does not cost a full re-sync."
        }
        control={<Button onClick={onSwitchDoor} disabled={busy}>Switch…</Button>}
      />

      {mode === "confirm" ? (
        <SettingsRow
          label="Sign out of this mailbox?"
          description={
            `The copy of your mail already on this ${MACHINE_WORD} stays where it is. What is ` +
            "cleared is the login — the stored password, or the session for your hosted account " +
            "— and which door this install came in by. Nothing is removed from your mail server."
          }
          control={
            <span className="set-tag-acts">
              <Button variant="primary" className="danger" onClick={() => void signOut()} disabled={busy}>
                {busy ? "Signing out…" : "Sign out"}
              </Button>
              <Button variant="ghost" onClick={() => setMode("rest")} disabled={busy}>Cancel</Button>
            </span>
          }
        />
      ) : (
        <SettingsRow
          label="Sign out"
          description={`Clears the login and forgets which mailbox this is. Your mail stays on this ${MACHINE_WORD} and on your server.`}
          control={<Button onClick={() => setMode("confirm")} disabled={busy}>Sign out</Button>}
        />
      )}

      <SettingsNote>
        Your password never passes through the app's window or its settings file: it goes straight
        to the mail engine, which seals it under a key held in this computer's keychain.
      </SettingsNote>

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
  if (mode === "cloud") {
    return "A hosted ohmail account. The organizing happens on our servers and this app keeps a copy.";
  }
  if (mode === "local") {
    return "Your own mail server, opened by this computer. Nothing about your mail is sent to us.";
  }
  return "No mailbox has been chosen on this install yet.";
}
