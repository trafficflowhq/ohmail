/**
 * Settings › Storage, as data: what is stored against the limit and why the limit is what it is, per mailbox and to
 * scale against what the mail is expected to need, from which month text is kept, the plans with their room, the
 * way to change the plan and the storage mails' switch. The pane draws a {@link StorageModel} and reaches nothing;
 * its hook reaches the server through a {@link StorageDoor} and guards the plan's change with the group's one gated
 * machine.
 *
 * {@link StorageFigures} are drawing values: every size, date and amount as the reader says it, every place on the
 * bar as a share of its scale. The pane formats nothing. An amount stands only where the build links out and the
 * server offered it; `null` is no figure. The plan's change charges the card on file, so the server gates it: the
 * account page's address is made by the press and never leaves the door.
 */
import type { Answer, GatedAsk, StorageWord } from "../contract.js";
import type { GatedRefusal } from "../gated.js";
import type { Signal } from "../../host/index.js";
import {
  GATED_IDLE,
  gatedStep,
  type GatedAnswer,
  type GatedEvent,
  type GatedRun,
  type GatedState,
} from "../gated.js";

export type StoragePlanName = "solo" | "plus" | "pro";

/** The room as the limit's reason names it: a trial's, the plan's own, or one kept until a day. */
export type StorageRoom =
  | { readonly kind: "trial" | "plan"; readonly limit: string }
  | { readonly kind: "held"; readonly limit: string; readonly until: string };

/** A place on the bar and a width on it, each a share of the bar's scale from 0 to 1. */
export interface BarSpan {
  readonly from: number;
  readonly width: number;
}

/** The bar to scale: whichever is largest of what is used, the limit and what the mail is expected to need. */
export interface StorageBar {
  /** One part per mailbox, in the mailboxes' order; one part for all where the answer names none. */
  readonly parts: readonly (BarSpan & { readonly id: string })[];
  /** What is not stored: still to come while a first import runs, or only on the mail server once text was emptied. */
  readonly rest: (BarSpan & { readonly kind: "toCome" | "onServer" }) | null;
  readonly limit: { readonly at: number; readonly said: string };
  /** The plan's own, lower limit, under a trial's room or a held one. */
  readonly plan: { readonly at: number; readonly said: string } | null;
  /** What the mail is expected to need, where that is past the limit. */
  readonly expected: { readonly at: number; readonly said: string } | null;
  /** The scale's end, as said. */
  readonly scale: string;
}

/** One mailbox's row of the table: every cell as said. */
export interface StorageRow {
  readonly id: string;
  readonly mailbox: string;
  readonly letters: string;
  readonly kept: string;
  readonly expected: string;
}

/** What the mail needs once every folder is counted. Counts are numbers: the catalogue's sentence says them. */
export interface StorageNeeds {
  /** A first import is still running: how many letters are stored of how many. */
  readonly importing: { readonly stored: number } | null;
  readonly letters: number;
  readonly size: string;
  /** The average letter, and whether it is this account's own measure or the default. */
  readonly average: { readonly size: string; readonly measured: boolean };
  /** Every folder has a count. */
  readonly complete: boolean;
}

/** The plan's sentence, in its three forms. */
export type StoragePlanLine =
  | { readonly kind: "trial"; readonly limit: string; readonly cap: string }
  | { readonly kind: "until"; readonly limit: string; readonly cap: string; readonly date: string }
  | { readonly kind: "keeps"; readonly limit: string; readonly plan: StoragePlanName | null };

/** One plan among the plans: its room, and a price where one may be shown. */
export interface StoragePlan {
  readonly plan: StoragePlanName;
  readonly room: string;
  readonly letters: number;
  readonly mailboxes: number;
  readonly price: string | null;
  /** The account's own plan; the one that keeps all the mail. */
  readonly tag: "yours" | "keepsAll" | null;
  /** The plan that fits, with the storage it adds. */
  readonly fit: { readonly extra: string; readonly room: string; readonly price: string | null } | null;
}

/** The storage block, as the pane draws it, in the order a person reads it. */
export interface StorageFigures {
  readonly used: string;
  readonly limit: string;
  readonly room: StorageRoom;
  /** From 80 percent a tag says the share; at the limit it says full. */
  readonly tag: { readonly kind: "percent"; readonly percent: number } | { readonly kind: "full" } | null;
  readonly bar: StorageBar;
  readonly rows: readonly StorageRow[];
  readonly total: { readonly letters: string; readonly kept: string; readonly expected: string } | null;
  readonly needs: StorageNeeds | null;
  /** Text was emptied for space: from which month it is kept, or how many letters were emptied. */
  readonly kept:
    | { readonly kind: "from"; readonly month: string; readonly refills: boolean }
    | { readonly kind: "some"; readonly count: number; readonly refills: boolean }
    | null;
  readonly plan: StoragePlanLine;
  /** The plans with their room; `null` where the server offered none. */
  readonly plans: {
    readonly lines: readonly StoragePlan[];
    readonly addon: {
      readonly unit: string;
      readonly letters: number;
      readonly most: number;
      readonly price: string | null;
    } | null;
    /** The server offered a change and this account may change. */
    readonly mayChange: boolean;
  } | null;
  /** Storage mails are on. */
  readonly mail: boolean;
}

/** How a host reaches the account's storage. */
export interface StorageDoor {
  /** The storage block of the access answer the shell already holds, as drawing values; `null` where it carries none. */
  readonly figures: Signal<StorageFigures | null>;
  /** Writes the storage mails' switch, then reads the access answer again. `false`: the write was refused. */
  setMail(on: boolean): Promise<boolean>;
  /**
   * Change plan and Add storage: makes the address of the account page that may change the plan and leaves for it.
   * The address never leaves the door.
   */
  change(): Promise<Answer<"left", StorageWord>>;
}

/** What the pane draws. */
export interface StorageModel {
  /** `null`: nothing is drawn. */
  readonly figures: StorageFigures | null;
  /** The mails' switch as it stands: what was written holds, and a refused write puts it back and says so. */
  readonly mail: { readonly on: boolean; readonly busy: boolean; readonly failed: boolean };
  /** The change is on its way or its factor is asked: both verbs are off. */
  readonly changing: boolean;
  /** Why the last change did not leave. */
  readonly refusal: GatedRefusal<StorageWord> | null;
  /** A factor landed after Cancel: nothing ran. */
  readonly nothingRan: boolean;
  /** The factor is asked: the pane hands this to its factor slot. */
  readonly ask: GatedAsk | null;
  change(): void;
  setMail(on: boolean): void;
}

/*
 * THE TRANSITIONS. Two things move on this pane, and each is a pure step here so that every host keeps its rule:
 *
 * - the storage mails' switch shows what a press writes at once, holds it once the server took it, and goes back to
 *   where it stood and says so when the write was refused; one write at a time;
 * - the plan's change is the group's one gated act: tried first, the factor asked only on the server's refusal, the
 *   parked change sent once after it, a second refusal said and never asked again.
 */

/** The storage mails' switch as the person last set it; `null` until the first press, so the figures' word stands. */
export type StorageMail = StorageModel["mail"] | null;

/** The plan's change is one act: both verbs, Change plan and Add storage, open the same page. */
export type StorageAct = "change";

/** What the pane holds between two events. */
export interface StorageState {
  readonly mail: StorageMail;
  readonly change: GatedState<StorageAct, StorageWord>;
}

export type StorageEvent =
  /** The person turned the switch. */
  | { readonly kind: "mailPressed"; readonly on: boolean }
  /** The server answered the write: taken, or refused. */
  | { readonly kind: "mailAnswered"; readonly on: boolean; readonly taken: boolean }
  /** The plan's change: a press, the door's answer, and the factor dialog's three answers. */
  | GatedEvent<StorageAct, StorageWord>;

export const STORAGE_START: StorageState = { mail: null, change: GATED_IDLE };

/** One event, applied: the state after it, and the change to send now, if any. */
export function storageStep(
  state: StorageState,
  event: StorageEvent,
): { readonly state: StorageState; readonly run: GatedRun<StorageAct> | null } {
  switch (event.kind) {
    case "mailPressed":
      // One write at a time: the switch is off while a write is on its way.
      if (state.mail?.busy === true) return { state, run: null };
      return { state: { ...state, mail: { on: event.on, busy: true, failed: false } }, run: null };
    case "mailAnswered": {
      const mail = event.taken
        ? { on: event.on, busy: false, failed: false }
        : { on: !event.on, busy: false, failed: true };
      return { state: { ...state, mail }, run: null };
    }
    default: {
      const stepped = gatedStep(state.change, event);
      return { state: { ...state, change: stepped.state }, run: stepped.run };
    }
  }
}

/** The door's answer to the change, as the gated machine takes it: it left, or why it did not. */
export function storageChangeAnswer(answer: Answer<"left", StorageWord>): GatedAnswer<StorageWord> {
  return answer.ok ? { ok: true } : answer;
}

/** The model a state draws, over the figures the door holds now and the verbs the hook hands in. */
export function storageModelOf(
  state: StorageState,
  figures: StorageFigures | null,
  ask: GatedAsk | null,
  verbs: Pick<StorageModel, "change" | "setMail">,
): StorageModel {
  const { change } = state;
  return {
    figures,
    // What was written holds over the figures; before any press, the figures' own word.
    mail: state.mail ?? { on: figures?.mail ?? false, busy: false, failed: false },
    changing: change.at === "trying" || change.at === "asking",
    refusal: change.at === "refused" ? change.refusal : null,
    nothingRan: change.nothingRan,
    ask,
    ...verbs,
  };
}
