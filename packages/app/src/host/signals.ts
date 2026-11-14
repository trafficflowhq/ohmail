import type { None } from "./contract.js";

/** What changes while the app runs: read it now, and be told when to read again. */
export interface Signal<T> {
  read(): T;
  subscribe(changed: () => void): () => void;
}

/** The link to another computer has gone quiet. The shell's `HostConnection`. */
export interface HostConnectionState {
  state: "stale" | "unknown";
  words: {
    title: string;
    detail: string;
    link: { href: string; label: string } | null;
  };
}

/** A letter to write, handed in from outside. The shell's `ComposePrefill`. */
export interface LinkedDraft {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
}

/** A link handed in from outside. Taking it is its acknowledgement: it is handed over once. */
export interface LinkIn {
  take(): LinkedDraft | null;
  subscribe(arrived: () => void): () => void;
}

/**
 * Subscriptions. A signal with nothing to say is silent, never a second wording.
 *
 * Five keys are `none` in every shell for now: their facts reach the old shell as inputs of
 * another part (`session.state`, `reads.copyAge`, `reads.access`) or not through it at all.
 */
export interface HostSignals {
  /** Replaces `hostConnection`. `none`: this shell is never paired to another computer. */
  readonly hostConnection: Signal<HostConnectionState | null> | None;
  /** Replaces `mailtoDraft` and `onMailtoDraftSeeded`. */
  readonly linkIn: LinkIn | None;
  /** The session's refusal, as it happens. */
  readonly sessionState: None;
  /** The copy's age, as it changes. */
  readonly copyAge: None;
  /** The access answer, as it changes. */
  readonly access: None;
  /** A newer build is offered. */
  readonly updateOffer: None;
  /** Files dropped on the window. */
  readonly droppedFiles: None;
}
