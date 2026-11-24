/**
 * WHAT THE WIRES AND READS CARRY, named in one place.
 *
 * A payload here is opaque: the contract says which verbs a shell hands in and what each is
 * called with, and leaves the shape of an answer to the one declaration of it. Today that
 * declaration is the server client's or a shell file's, which this package may not import. Each
 * name is bound to its one declaration as that declaration comes into reach, and nothing else in
 * the contract changes when it is.
 */

/** One mailbox as the account knows it. */
export type MailboxFacts = unknown;
/** How far behind the mail on screen is. */
export type CopyAge = unknown;
/** The account's access answer: a trial, a payment, the storage block. */
export type AccessAnswer = unknown;

/** The away responder as stored, and what a save answers. */
export type {
  AwayResponderRead as AwayState,
  AwayResponderEdit as AwayDraft,
  AwayResponderSaveReading as AwaySaved,
} from "@ohmail/wire";

/** The settings a mailbox arrived with, and the answers to taking them. */
export type {
  ProfileImportCandidateWire as ProfileImportCandidate,
  ProfileImportAppliedWire as ProfileImportApplied,
  ProfileImportPendingWire as ProfileImportPending,
  ProfileImportStatusWire as ProfileImportStatus,
} from "../profile-import/wire.js";

/** The consent row; a change that travelled with the mailbox; a read that failed. */
export type ConsentState = unknown;
export type TravelledChange = unknown;
export type ConsentReadFailure = unknown;

/** Pages of the Junk and Trash windows, and the answers to Junk's verbs. */
export type JunkPage = unknown;
export type JunkRescued = unknown;
export type JunkFound = unknown;
export type JunkSweep = unknown;
export type TrashPage = unknown;

/** The Screener's page of senders, and a batch of suggestions. */
export type ScreenerPage = unknown;
export type ScreenerSuggested = unknown;

/** A draft reply as it is read back. */
export type DraftReplyRead = unknown;

/** What organizing and counting answer during the first run. */
export type FirstRunOrganizeIntent = unknown;
export type FirstRunOrganized = unknown;
export type FirstRunCount = unknown;
export type FirstRunStepUp = unknown;

/** What reaches the Ohbox; what was filed automatically; who you write to; a folder's count; the own-model switch. */
export interface ScreeningPreference {
  readonly ohboxPolicy: "people_only" | "people_and_replied" | null;
  readonly ohboxBar: string | null;
  readonly defaultBar: string;
  readonly impersonationFiling?: boolean;
  readonly pending?: true;
  readonly change?: import("@ohmail/app-logic/consent/travelled-change").TravelledChangeWire;
}
export type ScreeningChange = Partial<
  Pick<ScreeningPreference, "ohboxPolicy" | "ohboxBar" | "impersonationFiling">
>;
export interface AutoFiled {
  readonly items: readonly Pick<
    import("@ohmail/wire").AutoFiledItemWire,
    "messageId" | "from" | "subject" | "to"
  >[];
  readonly more: boolean;
}
export type { AutoFiledUndoWire as AutoFiledPutBack } from "@ohmail/wire";
export type SeedReview = unknown;
export type SeedConfirmed = unknown;
export type FolderSummary = { folders: number; messages: number } | null;
export type OwnModelAutoSuggest = unknown;

/**
 * The Mailboxes pane: a mailbox's row, whether another may be connected, and what its verbs answer. A row's `id` is
 * a `MailboxId`. Bound to the pane's own declarations through their two-name path, which every shell's bundle
 * resolves.
 */
export type {
  ConnectAllowance,
  MailboxErased,
  MailboxRow,
  OrganizeAnswer,
  OrganizerPeek,
  ReleaseAnswer,
} from "@ohmail/app-logic/mailboxes/pane-contract";
