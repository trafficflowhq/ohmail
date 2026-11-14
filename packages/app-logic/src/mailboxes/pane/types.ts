/**
 * WHAT THE MAILBOXES PANE READS AND ITS VERBS ANSWER. Types only. A row is the mailbox facts every other part reads,
 * with the id of the account's own list (a {@link MailboxId}) and the few fields only this pane shows. A shell's
 * adapter narrows its own rows to these, and drops a row whose id is none.
 */
import type { MailboxFacts } from "../../mail-state/mail-state.js";
import type { MailboxId } from "../connect/types.js";

/** One mailbox of the account, as the pane draws it. */
export type MailboxRow = Readonly<Omit<MailboxFacts, "id">> & {
  readonly id: MailboxId;
  /** The provider's tile it was connected with. */
  readonly provider: string;
  /** How much of its mail ohmail holds; absent where the read did not ask for counts, which is not `0`. */
  readonly messageCount?: number;
  /** An erasure of ohmail's copy still running, with what it has left; absent on every other row. */
  readonly erasure?: { readonly remaining: number };
  /** Since when a failing mailbox fails, and how often it was tried: the tooltip's facts. */
  readonly failedAt?: string | null;
  readonly retryCount?: number;
  /** Letters this mailbox set aside. */
  readonly setAside?: number;
};

/**
 * Whether another mailbox may be connected: the account's address proven (`null` unread), and the server's own
 * verdict (`null` unread or unreadable; `mailboxes: null` is unbounded). Every unknown fails open.
 */
export interface ConnectAllowance {
  readonly emailVerified: boolean | null;
  readonly access: { readonly canAddMailbox: boolean; readonly mailboxes: number | null } | null;
}

/** What an erasure of ohmail's copy answered: still sweeping, or done, and what it took. */
export interface MailboxErased {
  readonly erasing: boolean;
  readonly mailboxId: MailboxId;
  readonly messages: number;
  readonly drafts: number;
  readonly draftsUnanchored: number;
}

/** One install that holds a mailbox's claim, as a fresh read of the mailbox found it. */
export interface OrganizerHolder {
  readonly kind: "local" | "cloud" | "unknown";
  readonly displayName: string | null;
  readonly heartbeatAt: string;
  /** Its claim is still renewed inside the window the worker's own gate judges by. */
  readonly active: boolean;
}

/** Who holds a mailbox, read from the mailbox itself; reads and writes nothing else. */
export interface OrganizerPeek {
  readonly state: "none" | "held" | "stopped";
  readonly holders: readonly OrganizerHolder[];
  /** Claims found that could not be read: still evidence somebody claimed. */
  readonly unreadable: number;
}

/** What asking to organize a mailbox here answered: asked for, already so, or the mailbox is gone. */
export interface OrganizeAnswer {
  readonly outcome: "authorized" | "already_organizing" | "disconnected";
}

/** What asking to stop organizing it here answered. */
export interface ReleaseAnswer {
  readonly outcome: "requested" | "not_organizing" | "disconnected";
}
