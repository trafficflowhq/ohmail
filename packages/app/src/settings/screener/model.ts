import { NONE, type HostContract } from "../../host/index.js";

/**
 * Settings › Screener, as data. Every control about the mail a connected mailbox brings: what reaches the Ohbox (the
 * posture, impersonations, the words), how far back the Screener asks, the suggestions and what may act on them,
 * unsubscribing on a screen-out, what was filed automatically with Put back, and the door back to the review of who
 * you write to. Each part is `null` where this host withholds it or has not answered yet: a control is never drawn
 * before its stored value is known, except the disabled automatic suggestion switch, which shows the default.
 *
 * The writes are the shell's, handed in as verbs that answer when the server did and throw when it refused; the pane
 * holds what each press is doing (pending, failed), as the shipped rows do.
 */

/** Where a change went when it was sent to the install that organizes, and its answer. */
export type TravelledNote =
  | { readonly kind: "asked" }
  | { readonly kind: "applied" }
  | {
      readonly kind: "refused";
      readonly holder: string | null;
      readonly refusal: "unreadable" | "other" | null;
    };

/** What reaches the Ohbox: one account setting, two switches and the words. */
export interface ScreenerOhbox {
  /** A host with navigation can ask about unsaved words before leaving. */
  readonly holdLeave?: (ask: (leave: () => void) => void) => () => void;
  /** "Keep my Ohbox for what's relevant". */
  readonly relevant: boolean;
  /** Filing impersonations to Spam; `null` from an older server, which files none. */
  readonly impersonation: boolean | null;
  /** The stored words, or `null` while the account is on the default. */
  readonly bar: string | null;
  /** The server's default words, in English. */
  readonly defaultBar: string;
  /** Where the last change went. */
  readonly note: TravelledNote | null;
  /** Writes a switch. Answers `true` when the change travelled (nothing was written here, so nothing is "Saved."). */
  change(next: { readonly relevant?: boolean; readonly impersonation?: boolean }): Promise<boolean>;
  /** Writes the words (`null`: back to the default). Answers what is stored, and whether the change travelled. */
  saveBar(next: string | null): Promise<{ readonly bar: string | null; readonly travelled: boolean }>;
}

/** How far back the Screener asks about senders never decided about. */
export interface ScreenerWindow {
  readonly days: number;
  readonly scope: "window" | "all_time";
  /** The engine's default window, marked among the choices. */
  readonly defaultDays: number;
  /** A change on its way to the install that organizes, or its refusal; an applied change is not news here. */
  readonly note: TravelledNote | null;
  set(days: number | undefined, scope: "window" | "all_time"): Promise<unknown>;
}

/**
 * Suggestions for new senders, automatically. Turning it on prices the next batch first and asks; turning it off
 * writes at once. Its sentences are the Screener's (`screener.suggest.*`), handed in as said.
 */
export interface ScreenerSuggest {
  readonly on: boolean | null;
  /** The confirm: closed, pricing the batch, or priced and asking. */
  readonly phase: "closed" | "pricing" | "ready";
  /** The server's price for the next batch; no price, no consent. */
  readonly priced: boolean;
  readonly said: {
    readonly title: string;
    /** "On since …" or "Off …". */
    readonly state: string;
    readonly what: string;
    /** What it costs, where credits count; `null` on an unmetered host. */
    readonly cost: string | null;
    readonly decides: string;
    /** "Checking the price…", or the price; `null` before either. */
    readonly quote: string | null;
    readonly notice: string | null;
    readonly turnOn: string;
    readonly cancel: string;
    readonly failed: string;
  };
  open(): void;
  cancel(): void;
  set(on: boolean): Promise<unknown>;
}

/** Acting on confident suggestions. Its sentences are the Screener's too. */
export interface ScreenerAct {
  readonly on: boolean;
  /** Why it cannot be pressed: this install reads and another organizes, or suggestions are off. */
  readonly why: "reader" | "needsSuggest" | null;
  readonly said: {
    readonly title: string;
    readonly description: string;
    readonly why: string | null;
    readonly failed: string;
  };
  set(on: boolean): Promise<unknown>;
}

/**
 * Suggestions by the person's own model, where this install runs one: a switch with no price. Its words are the
 * host's, handed in as said.
 */
export interface ScreenerOwnSuggest {
  readonly on: boolean;
  readonly said: { readonly title: string; readonly description: string; readonly failed: string };
  set(on: boolean): Promise<unknown>;
}

/** Unsubscribing when a sender is screened out or marked spam. */
export interface ScreenerUnsubscribe {
  readonly on: boolean;
  /** Whose machine sends the request: the service's, or this computer, which the sender then sees. */
  readonly from: "service" | "computer";
  /** Writes the stored block: `true` turns unsubscribing off. */
  setBlocked(blocked: boolean): Promise<unknown>;
}

export interface FiledLetter {
  readonly id: string;
  readonly from: string | null;
  readonly subject: string | null;
  /** The pile it was filed to, as the shared `place` words name it. */
  readonly to: string;
}

/** What the Screener filed on its own, still where it put it. */
export interface ScreenerFiled {
  readonly letters: readonly FiledLetter[];
  /** More were filed than the list holds. */
  readonly more: boolean;
  /** Puts letters back; answers how many went back here and how many were sent to the install that organizes. */
  putBack(ids: readonly string[]): Promise<{ readonly back: number; readonly requested: number }>;
}

/** The door back to the review of who you write to. Its words are the consent vocabulary's, handed in as said. */
export interface ScreenerReview {
  readonly said: { readonly label: string; readonly body: string; readonly action: string };
  open(): void;
}

export interface ScreenerModel {
  readonly ohbox: ScreenerOhbox | null;
  readonly window: ScreenerWindow | null;
  readonly suggest: ScreenerSuggest | null;
  readonly ownSuggest: ScreenerOwnSuggest | null;
  readonly act: ScreenerAct | null;
  readonly unsubscribe: ScreenerUnsubscribe | null;
  readonly filed: ScreenerFiled | null;
  readonly review: ScreenerReview | null;
}

/** Which of the Screener's controls a host can offer at all, from its answers alone. */
export interface ScreenerOffers {
  readonly ohbox: boolean;
  readonly window: boolean;
  readonly suggest: "priced" | "ownModel" | null;
  readonly unsubscribe: "service" | "computer" | null;
  readonly filed: boolean;
  readonly review: boolean;
}

/**
 * Each control withheld where its own wire is `none`: what reaches the Ohbox needs `screening`, the window and the
 * consent switches need `consent`, the suggestion switch needs the suggest wire its capability names, unsubscribing
 * needs a machine that sends it, the filed list needs `autoFiled`, the review's door needs `seedReview`.
 */
export function screenerOffers(host: Pick<HostContract, "wires" | "capabilities">): ScreenerOffers {
  const { wires, capabilities } = host;
  const consent = wires.consent !== NONE;
  const suggest =
    capabilities.suggest === "priced" && consent && wires.suggest !== NONE
      ? "priced"
      : capabilities.suggest === "ownModel" && wires.ownModelAutoSuggest !== NONE
        ? "ownModel"
        : null;
  return {
    ohbox: wires.screening !== NONE,
    window: consent,
    suggest,
    unsubscribe: consent && capabilities.unsubscribeFrom !== NONE ? capabilities.unsubscribeFrom : null,
    filed: wires.autoFiled !== NONE,
    review: wires.seedReview !== NONE,
  };
}

/** The window's choices: the presets, the engine's default and the stored value, once each, in order. */
export function windowRungs(days: number, defaultDays: number): readonly number[] {
  return [...new Set<number>([90, 180, 365, defaultDays, days])].sort((a, b) => a - b);
}

/** Whether a model has anything to draw. */
export function screenerHasAny(model: ScreenerModel): boolean {
  return Object.values(model).some((part) => part !== null);
}
