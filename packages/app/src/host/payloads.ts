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
export type AwayState = unknown;
export type AwayDraft = unknown;
export type AwaySaved = unknown;

/** The settings a mailbox arrived with, and the answers to taking them. */
export type ProfileImportCandidate = unknown;
export type ProfileImportApplied = unknown;
export type ProfileImportStatus = unknown;

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

/** The first run: a mailbox as typed in, and what probing and organizing it answer. */
export type FirstRunMailbox = unknown;
export type FirstRunProbed = unknown;
export type FirstRunOrganizeIntent = unknown;
export type FirstRunOrganized = unknown;
export type FirstRunCount = unknown;
export type FirstRunStepUp = unknown;

/** What reaches the Ohbox; what was filed automatically; who you write to; a folder's count; the own-model switch. */
export type ScreeningPreference = unknown;
export type ScreeningChange = unknown;
export type AutoFiled = unknown;
export type AutoFiledPutBack = unknown;
export type SeedReview = unknown;
export type SeedConfirmed = unknown;
export type FolderSummary = unknown;
export type OwnModelAutoSuggest = unknown;

/** A mailbox as the Mailboxes pane connects or edits it, and what a verb answers. */
export type MailboxConnection = unknown;
export type MailboxVerbAnswer = unknown;
