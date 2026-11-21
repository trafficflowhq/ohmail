/**
 * THE ONE CONNECT FORM'S CONTRACT: what a mount hands it and what it answers. The form takes its wire as an input,
 * so a page with no frame (the join) mounts it as a place under the frame does.
 *
 * It imports no other feature. The second factor's dialog and the calendar's half arrive as slots a shell fills.
 */
import type { ReactNode } from "react";
import type { ConnectKept, MailboxId } from "@ohmail/app-logic/mailboxes/connect/types";
import type { AskLeave } from "../../host/device.js";
import type { ConnectWire, None } from "../../host/index.js";

/** The wire the form calls: a shell's `wires.connect`, or what a page with no frame built itself. */
export type ConnectDoor = ConnectWire;

/** The mailbox an edit or a reconnect is about. Its id comes from the account's own rows, never from an address. */
export interface ConnectSubject {
  readonly id: MailboxId;
  readonly address: string;
  readonly provider: string;
  /** How it signs in: with a password the form takes, or at its provider. */
  readonly signsIn: "password" | "provider";
}

/**
 * What the form is opened for. `join` and `firstRun` connect an install's first mailbox, `add` a further one;
 * `standalone` opens a phone's own mailbox, which that phone organizes itself.
 */
export type ConnectPurpose =
  | { readonly kind: "join" }
  | { readonly kind: "firstRun" }
  | { readonly kind: "add" }
  | { readonly kind: "standalone" }
  | { readonly kind: "edit"; readonly mailbox: ConnectSubject }
  | { readonly kind: "reconnect"; readonly mailbox: ConnectSubject };

/** What the form ended with. Leaving for a provider's sign-in ends with nothing: its return is read by the mount. */
export type ConnectResult =
  | {
      readonly kind: "connected";
      readonly mailboxId: MailboxId;
      readonly address: string | null;
      readonly created: boolean;
    }
  /** An edit was stored for the mailbox that was asked. */
  | { readonly kind: "saved"; readonly mailboxId: MailboxId }
  /** The person closed the form; nothing was sent after that press. */
  | { readonly kind: "left" };

/** What the second factor's dialog is handed: the doors' four answers and the form's own line, by structure. */
export interface FactorAsk {
  /** The factor verified: the parked press is sent, once, as it was. */
  onVerified(): void;
  /** Cancel, Esc or the scrim: the parked press is dropped. */
  onCancel(): void;
  /** A factor landed after Cancel and was thrown away: nothing ran, and the form says so. */
  onDiscarded(): void;
  onOwnerAbsent?(): void;
  readonly line?: string;
}
export type FactorSlot = (ask: FactorAsk) => ReactNode;

/** The calendar's half of a connected mailbox, where a shell has one. */
export type CalendarHalfSlot = (of: {
  readonly mailboxId: MailboxId;
  readonly provider: string;
}) => ReactNode;

/**
 * Whose browser this is, asked before every press that carries a credential. `before` answers false when the press
 * must not be sent; `said` is then the caller's own sentence.
 */
export interface ConnectGuard {
  before(): Promise<boolean>;
  readonly said: string | null;
  clear(): void;
}

export interface ConnectAsk {
  readonly purpose: ConnectPurpose;
  onDone(result: ConnectResult): void;
  /** The Mailboxes list takes over display and polling once the device sign-in starts. */
  onCodeStarted?(): void;
  /** Typed words held by a caller that outlives the form; memory only, and never the password. */
  readonly kept?: ConnectKept;
  readonly guard?: ConnectGuard;
  /** The surrounding Settings pane can hold a departure while an inline edit is unsaved. */
  readonly holdLeave?: (ask: AskLeave) => () => void;
  /** "Do this later", where the mount has such a way. */
  readonly later?: () => void;
  readonly setup?: { restart: () => void; close: () => void };
  /** A mail to support, where the mount has one: the provider's id and the last refusal's code, nothing typed. */
  readonly help?: (facts: { readonly provider: string | null; readonly reason: string | null }) => void;
}

export interface ConnectFormProps {
  readonly ask: ConnectAsk;
  readonly door: ConnectDoor;
  /** The second factor's dialog. `none`: a refusal that asks for it says to sign in again, and nothing is parked. */
  readonly factor: FactorSlot | None;
  readonly page?: (
    material: ReactNode,
    backToProviders: (() => void) | null,
    providerBlank?: ReactNode,
    later?: () => void,
  ) => ReactNode;
}

/** The form as another feature's page mounts it. */
export type ConnectSlot = (ask: ConnectAsk) => ReactNode;
