import type { None } from "./contract.js";
import type { AccessAnswer, CopyAge, MailboxFacts } from "./payloads.js";

/**
 * The account's facts, by name. A read rejects on failure and never answers empty for it: an
 * empty list is a claim about the account.
 */
export interface HostReads {
  /** Replaces `mailboxFacts`. `none`: every state keyed by a mailbox is withheld, never guessed. */
  readonly mailboxes: ((opts?: { counts?: boolean }) => Promise<MailboxFacts[]>) | None;
  /** How old the mail on screen is. Replaces `mirrorFreshness`. `none`: the engine's own verdict stands. */
  readonly copyAge: (() => Promise<CopyAge>) | None;
  /** The account's access answer. No input today: each mount reads it and passes finished nodes. */
  readonly access: (() => Promise<AccessAnswer>) | None;
}
