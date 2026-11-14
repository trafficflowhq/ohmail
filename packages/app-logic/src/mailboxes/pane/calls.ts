/**
 * WHAT THE MAILBOXES PANE'S HOOKS CALL. A shell's `wires.mailboxes` answers {@link PaneCalls} by structure: every
 * member answers and none throws; a member a shell cannot offer is `none`, and its verb is not drawn. Every call
 * takes a {@link MailboxId} of the account's own list, never a route's word.
 */
import type { Answered, MailboxId } from "../connect/types.js";
import type { Secret } from "../connect/secret.js";
import type {
  ConnectAllowance,
  MailboxErased,
  MailboxRow,
  OrganizeAnswer,
  OrganizerPeek,
  ReleaseAnswer,
} from "./types.js";

export type None = "none";
export const NONE: None = "none";

/** The filings that wait on the mail server: read them, try them again, or leave them where they are. */
export interface FilingCalls {
  read(mailboxId: MailboxId): Promise<Answered<unknown>>;
  retry(mailboxId: MailboxId, folder: string): Promise<Answered<{ reset: number; skipped: number }>>;
  leave(
    mailboxId: MailboxId,
    folder: string,
    through: string,
  ): Promise<Answered<{ settled: number; remaining: number }>>;
}

export interface PaneCalls {
  list(o: { counts: boolean }): Promise<Answered<readonly MailboxRow[]>>;
  readonly allowance: (() => Promise<Answered<ConnectAllowance>>) | None;
  resync(mailboxId: MailboxId): Promise<Answered<null>>;
  readonly remove: ((mailboxId: MailboxId) => Promise<Answered<null>>) | None;
  readonly erase: ((mailboxId: MailboxId, typed: string) => Promise<Answered<MailboxErased>>) | None;
  readonly organizer: ((mailboxId: MailboxId) => Promise<Answered<OrganizerPeek>>) | None;
  readonly organizeHere:
    ((mailboxId: MailboxId, o: { password?: Secret }) => Promise<Answered<OrganizeAnswer>>) | None;
  readonly stopOrganizing: ((mailboxId: MailboxId) => Promise<Answered<ReleaseAnswer>>) | None;
  readonly dismissForwardingNotice: ((mailboxId: MailboxId) => Promise<Answered<MailboxRow>>) | None;
  readonly selfCheck: ((mailboxId: MailboxId) => Promise<Answered<unknown>>) | None;
  readonly filings: FilingCalls | None;
  readonly out: (() => void) | None;
}
