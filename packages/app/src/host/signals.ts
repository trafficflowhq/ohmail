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

/** One fold, as the platform states it, in window coordinates (CSS px). */
export interface FoldFeature {
  readonly bounds: { readonly x: number; readonly y: number; readonly w: number; readonly h: number };
  readonly state: "flat" | "half";
  readonly orientation: "horizontal" | "vertical";
  /** A full occlusion is hardware between two screens. */
  readonly occlusion: "none" | "full";
}

/** The folds crossing the window now, and whether the device has a fold at all, whatever its pose. */
export interface FoldReading {
  readonly folds: readonly FoldFeature[];
  readonly hasFold: boolean;
}

/** What the system draws over the window's edges, in CSS px. */
export interface SafeInsets {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

/** How much of the window the keyboard covers, in CSS px; 0 while it is down. */
export interface KeyboardReading {
  readonly height: number;
}

/**
 * The system's back. Handlers run newest first; the first to answer true took it. When none
 * does, the app leaves. A handler answers at once: back does not wait for work.
 */
export interface BackSignal {
  subscribe(handle: () => boolean): () => void;
}

/** The app was woken: brought to the front, or by a push while it was away. */
export interface WakeSignal {
  subscribe(woke: (why: "foreground" | "push") => void): () => void;
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
  /** The fold. `none`: no window this shell draws in can be folded. */
  readonly posture: Signal<FoldReading> | None;
  /** The safe areas. `none`: the shell's window has no edge the system draws over. */
  readonly insets: Signal<SafeInsets> | None;
  /** The keyboard's height. `none`: no keyboard covers this shell's window. */
  readonly keyboard: Signal<KeyboardReading> | None;
  /** The system's back. `none`: the shell has no back of its own; a browser's is the address. */
  readonly back: BackSignal | None;
  /** A wake. `none`: nothing wakes this shell but the person. */
  readonly wake: WakeSignal | None;
}
