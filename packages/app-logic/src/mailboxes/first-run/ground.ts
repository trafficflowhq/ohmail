/**
 * WHAT THE FIRST RUN READS, by name: the facts of the ground (the mail state, the consent row, the Screener's model)
 * as one input record a host fills from the ground's readers, never from the old shell's values, and the first-run
 * verbs of the host contract as the stage calls them. Types only.
 */
import type { OnboardingAccount, OnboardingAi, OnboardingMailbox } from "../../doors/onboarding.js";
import type { MailboxId } from "../connect/types.js";

/** One mailbox as the run reads it: the account's own id and address beside its onboarding facts. */
export interface FirstRunRow extends OnboardingMailbox {
  readonly id: MailboxId;
  readonly address: string;
  /** The provider's id it was connected with, where the row names one. */
  readonly provider?: string;
  /** How much mail the server says is in the mailbox; absent until a cycle has counted a folder. */
  readonly serverMessageCount?: number;
  /** When its holder became its organizer, as a date the host formatted; absent where the row names no instant. */
  readonly holderSince?: string;
}

/** The five places a decision files a sender into, and how wide the decision reaches. */
export type DecideTo = "ohbox" | "reads" | "receipts" | "screened" | "spam";
export type DecideScope = "sender" | "domain";

/** The one sender the guided decision is about: the head of this mailbox's own queue. */
export interface FirstRunSender {
  readonly name: string;
  readonly address: string;
  /** How many of their messages wait. */
  readonly held: number;
  /** How many senders wait in the Screener: the rail's count. */
  readonly waiting: number;
  /** The install holds several mailboxes: the lead counts this mailbox's own waiting senders. */
  readonly many: boolean;
  /** The Screener's own caption for the card, in words. */
  readonly since: string;
  decide(to: DecideTo, opts: { readonly markRead: boolean; readonly scope: DecideScope }): void;
}

/** The pull screen's numbers for one mailbox: what this device holds of it, and what it has read. */
export interface FirstRunPull {
  readonly screened: number;
  readonly history: number;
  /** The import's own numerator, never a windowed mirror's row count. */
  readonly pulled: number;
  /** The store says this device holds every message: the two counts are the mailbox's own. */
  readonly whole: boolean;
}

/** What the ground says about the mailbox a run is about. */
export interface FirstRunAbout {
  /** How many senders wait in this mailbox's queue: zero skips the guided decision. */
  readonly queuedSenders: number;
  readonly pull: FirstRunPull;
  readonly sender: FirstRunSender | null;
  /** The import is over and the store is asked again about the Screener's queue. */
  readonly queueSettling: boolean;
  /** Ask the store for the Screener's queue again. */
  rereadQueue(): Promise<void>;
}

/** The ground's facts as the first run reads them. Filled once a frame by the host, from the ground's readers. */
export interface FirstRunGround {
  /** The account's live mailboxes (removed copies left out), or `null` while unread: nothing is drawn then. */
  readonly rows: readonly FirstRunRow[] | null;
  /** The account's own facts: the stamp that closes the flow. */
  readonly account: OnboardingAccount;
  /** What the account stored of the window, only where something is stored. */
  readonly screening?: { readonly dormancyDays: number; readonly scope: "window" | "all_time" };
  /** Who organizes this account's mail, read from the rows it holds, or `null` where nothing names one. */
  readonly accountOrganizer: { readonly kind: string | null; readonly name: string | null } | null;
  /** The facts about one mailbox, or about none. */
  about(mailboxId: MailboxId | null): FirstRunAbout;
  /** Read the facts again. The stage waits for it after every write, never past a bound. */
  refresh(): Promise<void>;
  /** The stage drew a step: this launch has asked the organize decision of an undecided mailbox. */
  drawn(): void;
}

/** The window an Agree carries. */
export type Screening = { readonly dormancyDays?: number; readonly scope?: "window" | "all_time" };

/** What Agree sends: the window, what it asks for, and whether the shown count is screened after it. */
export interface OrganizeBody {
  readonly screening?: Screening;
  readonly intent?: "join" | "takeover";
  readonly screenBacklog?: true;
}

/**
 * THE FIRST-RUN VERBS AS THE STAGE CALLS THEM: the host contract's `FirstRunWire`, by structure. Its answers are read
 * by the narrowing readers of `answers.ts`; each verb throws on a refusal.
 */
export interface FirstRunVerbs {
  readonly ai: OnboardingAi;
  organize(mailboxId: MailboxId, body: OrganizeBody): Promise<unknown>;
  countDecision?(mailboxId: MailboxId, screening: Screening): Promise<unknown>;
  countWaiting?: (mailboxId: MailboxId) => Promise<unknown>;
  complete(): Promise<void>;
  setAiEnabled?: (enabled: boolean) => Promise<void>;
  forgetMailbox?: (mailboxId: MailboxId) => Promise<void>;
  /** The door's second-factor reader, where Agree can meet one; read by `stepUpOf`. */
  readonly stepUp?: unknown;
  readonly selfhostAi?: boolean;
  /** Where a first mailbox is connected when that is a page of its own (the web's join), and the way there. */
  readonly setupHref?: string;
  resume?: () => void;
}
