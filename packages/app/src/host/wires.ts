/**
 * THE WIRES: the calls that are not mail acts. One route each; the control is shared and only
 * the transport is the shell's. Each key of {@link HostWires} is its transport, or `none`.
 *
 * Thirteen replace an input of the old shell and repeat the type that input has there, verb for
 * verb, so the transport a mount hands in today is a wire as it stands. Six replace no input:
 * four shared files reach their route through the server client today, one control exists only
 * in the desktop's own pane, and the Mailboxes pane's verbs live inside the node a mount passes.
 */
import type { OlderBodyWire } from "@ohmail/client-engine";
import type { None } from "./contract.js";
import type {
  AutoFiled, AutoFiledPutBack, AwayDraft, AwaySaved, AwayState, ConsentReadFailure, ConsentState, DraftReplyRead,
  FirstRunCount, FirstRunMailbox, FirstRunOrganizeIntent, FirstRunOrganized, FirstRunProbed, FirstRunStepUp,
  FolderSummary, JunkFound, JunkPage, JunkRescued, JunkSweep, MailboxConnection, MailboxVerbAnswer,
  OwnModelAutoSuggest, ProfileImportApplied, ProfileImportCandidate, ProfileImportStatus, ScreenerPage,
  ScreenerSuggested, ScreeningChange, ScreeningPreference, SeedConfirmed, SeedReview, TrashPage, TravelledChange,
} from "./payloads.js";

/** Acknowledges the organizer's notice for a mailbox. The shell's `OrganizerNoticeTransport`. */
export type OrganizerNoticeWire = (mailboxId: string) => Promise<unknown>;

/** Answers the offer to file the letters a gap left. The shell's `GapLettersTransport`. */
export type GapLettersWire = (
  mailboxId: string,
  answer: { file: boolean; count: number; strangers: number },
) => Promise<unknown>;

/** Why a body could not be loaded now. */
export type LiveBodyRefusal = "gone" | "too_large" | "busy" | "unreachable" | "failed";
/** "Load it now": one letter's body, fetched live. The shell's `LiveBodyWire`. */
export type LiveBodyWire = (messageId: string) => Promise<
  | { kind: "loaded"; text: string; html: string | null }
  | { kind: "refused"; reason: LiveBodyRefusal }
>;

/** The away responder. The shell's `AwayTransport`. */
export interface AwayWire {
  state(): Promise<AwayState>;
  save(next: AwayDraft): Promise<AwaySaved>;
}

/** Settings a mailbox arrived with. The shell's `ProfileImportTransport`. */
export interface ProfileImportWire {
  candidate(mailboxId: string): Promise<ProfileImportCandidate>;
  apply(mailboxId: string, fingerprint: string, signatureReplaces?: string): Promise<ProfileImportApplied>;
  status(mailboxId: string, fingerprint: string): Promise<ProfileImportStatus>;
  decline(mailboxId: string, subject: { fingerprint?: string; v?: number }): Promise<unknown>;
  replace(mailboxId: string, fingerprint: string): Promise<unknown>;
}

/**
 * The consent row and its switches. The shell's `ConsentTransport`, without the fact it carries
 * beside its verbs: whether folders can be stored is the capability `foldersStorable`.
 */
export interface ConsentWire {
  state: () => Promise<ConsentState>;
  setAutoSuggest: (enabled: boolean) => Promise<{ autoSuggestAt: string | null; autoActAt?: string | null }>;
  setAutoAct?: (enabled: boolean) => Promise<{ autoActAt: string | null }>;
  setDormancyDays: (days: number | null | undefined, scope?: "window" | "all_time") => Promise<{
    dormancyDays?: number;
    screeningScope?: "window" | "all_time";
    dormancyChange?: TravelledChange;
  }>;
  setBlockRemoteImages: (blocked: boolean) => Promise<{ blockRemoteImagesAt: string | null }>;
  setBlockTrackingPixels: (blocked: boolean) => Promise<{ loadTrackingPixelsAt: string | null }>;
  setBlockAutoUnsubscribe: (blocked: boolean) => Promise<{ blockAutoUnsubscribeAt: string | null }>;
  setFoldersEnabled: (enabled: boolean) => Promise<{ foldersEnabledAt: string | null }>;
  setMailboxFoldersEnabled: (mailboxId: string, enabled: boolean) => Promise<{ folderMailboxesOff: Record<string, string> }>;
  setMailboxSignature: (mailboxId: string, signature: string | null, signatureHtml?: string | null) => Promise<{
    signatures: Record<string, string>;
    signaturesHtml?: Record<string, string>;
    signatureSources?: Record<string, "organizer" | "local">;
    signatureChanges?: Record<string, TravelledChange>;
  }>;
  setThemeFace?: (themeFace: string | null) => Promise<{ themeFace: string | null }>;
  setResurfaceTime?: (resurfaceTime: string | null) => Promise<{ resurfaceTime: string | null }>;
  readFailed?(report: ConsentReadFailure): void | Promise<void>;
}

/** A letter's pictures, fetched by this shell. The shell's `ImageDoor`. */
export interface ImageWire {
  fetch: (messageId: string, url: string) => Promise<string | null>;
  record: (messageId: string) => Promise<void>;
}

/** The Junk window. The shell's `JunkWire`. */
export interface JunkWire {
  list(opts?: { cursor?: string }): Promise<JunkPage>;
  body(mailboxId: string, uid: number, uidValidity: string): Promise<{ subject: string; text: string }>;
  rescue(mailboxId: string, uid: number, uidValidity: string, opts?: { allow?: { sender: string } }): Promise<JunkRescued>;
  dismissRescue(rescueId: string): Promise<unknown>;
  search(q: string): Promise<JunkFound>;
  sweepPreview(): Promise<JunkSweep>;
  sweepRequest(): Promise<JunkSweep>;
  isGone(err: unknown): boolean;
  codeOf(err: unknown): string | null;
}

/** The live Trash window. The shell's `TrashWire`. */
export interface TrashWire {
  list(opts?: { cursor?: string }): Promise<TrashPage>;
  body(mailboxId: string, uid: number, uidValidity: string): Promise<{ subject: string; text: string }>;
}

/** The Screener's two spend calls. The shell's `SuggestWire`. */
export interface SuggestWire {
  configured: () => boolean;
  list: (opts: { limit?: number }) => Promise<ScreenerPage>;
  suggest: (
    senders: string[],
    opts?: { dryRun?: boolean; idempotencyKey?: string; maxCredits?: number; automatic?: boolean },
  ) => Promise<ScreenerSuggested>;
  messageFor: (err: unknown, fallback: string) => string;
  aiAvailable?: () => Promise<boolean | null>;
}

/** A reply drafted by a model. The shell's `DraftReplyWire`. */
export interface DraftReplyWire {
  configured: () => boolean;
  create: (messageId: string, idempotencyKey: string) => Promise<{ draftId: string }>;
  read: (draftId: string) => Promise<DraftReplyRead>;
  noModel?: "noModelHere" | "noModelHost";
}

/**
 * The first run's calls. The shell's `FirstRunHost`, without its door (the capability
 * `firstRunDoor`) and without the two finished nodes it carries today, which are features.
 */
export interface FirstRunWire {
  ai: "unset" | "off" | "on-unconfigured" | "on";
  probe(input: FirstRunMailbox): Promise<FirstRunProbed>;
  connect(input: FirstRunMailbox, mode: "seed" | "add"): Promise<{ id: string }>;
  organize(mailboxId: string, body: {
    imap?: { pass: string };
    screening?: { dormancyDays?: number; scope?: "window" | "all_time" };
    intent?: FirstRunOrganizeIntent;
    screenBacklog?: true;
  }): Promise<FirstRunOrganized>;
  countDecision?(mailboxId: string, screening: { dormancyDays?: number; scope?: "window" | "all_time" }): Promise<FirstRunCount>;
  countWaiting?: (mailboxId: string) => Promise<{ senders: number }>;
  complete: () => Promise<void>;
  setAiEnabled?: (enabled: boolean) => Promise<void>;
  forgetMailbox?: (mailboxId: string) => Promise<void>;
  probeReason: (err: unknown) => string | null;
  probeMessage: (err: unknown) => string | null;
  probeLocalServer?: (err: unknown) => boolean;
  localServerWait?: boolean;
  plaintextOffer?: (err: unknown) => "imap" | "smtp" | null;
  discover?: (body: { domain: string }, signal: AbortSignal) => Promise<unknown>;
  selfhostAi?: boolean;
  stepUp?: FirstRunStepUp;
  setupHref?: string;
  resume?: () => void;
  oauthPending?: () => boolean;
}

/** What reaches the Ohbox, the bar's words, filing impersonations to Spam. No input today. */
export interface ScreeningWire {
  read(): Promise<ScreeningPreference>;
  change(next: ScreeningChange): Promise<ScreeningPreference>;
}

/** The list of what was filed automatically, and Put back. No input today. */
export interface AutoFiledWire {
  list(): Promise<AutoFiled>;
  putBack(messageIds: readonly string[]): Promise<AutoFiledPutBack>;
}

/** The review of who you write to. No input today. */
export interface SeedReviewWire {
  read(): Promise<SeedReview>;
  confirm(addresses: string[], opts?: { idempotencyKey?: string }): Promise<SeedConfirmed>;
}

/** The count a folder's deletion is confirmed with. No input today. */
export type FolderSummaryWire = (folderId: string) => Promise<FolderSummary>;

/** The switch for automatic suggestions by the person's own model. No input today. */
export interface OwnModelAutoSuggestWire {
  read(): Promise<OwnModelAutoSuggest>;
  save(on: boolean): Promise<OwnModelAutoSuggest>;
}

/**
 * The Mailboxes pane's verbs. No input today. Which of them a shell offers is the capability
 * `mailboxes`, not this wire.
 */
export interface MailboxesWire {
  connect(mailbox: MailboxConnection): Promise<MailboxVerbAnswer>;
  edit(mailboxId: string, mailbox: MailboxConnection): Promise<MailboxVerbAnswer>;
  remove(mailboxId: string): Promise<MailboxVerbAnswer>;
  resync(mailboxId: string): Promise<MailboxVerbAnswer>;
  organizeHere(mailboxId: string): Promise<MailboxVerbAnswer>;
  stopOrganizing(mailboxId: string): Promise<MailboxVerbAnswer>;
  takeOver(mailboxId: string): Promise<MailboxVerbAnswer>;
  dismissForwardingNotice(mailboxId: string): Promise<MailboxVerbAnswer>;
}

export interface HostWires {
  /** Replaces `organizerNoticeTransport`. `none`: the notice is withheld entirely. */
  readonly organizerNotice: OrganizerNoticeWire | None;
  /** Replaces `gapLettersTransport`. `none`: the offer is withheld. */
  readonly gapLetters: GapLettersWire | None;
  /** Replaces `liveBodyWire`. `none`: no "Load it now". */
  readonly liveBody: LiveBodyWire | None;
  /** Replaces `awayTransport`. `none`: no Away pane. */
  readonly away: AwayWire | None;
  /** Replaces `profileImportTransport`. `none`: no card. */
  readonly profileImport: ProfileImportWire | None;
  /** Replaces `consentTransport`. `none`: every consent control is withheld. */
  readonly consent: ConsentWire | None;
  /** Replaces `imageWire`. `none`: no pictures and no switch. */
  readonly images: ImageWire | None;
  /** Replaces `olderBodyWire`. */
  readonly olderBody: OlderBodyWire | None;
  /** Replaces `junkWire`. `none`: no Junk segment. */
  readonly junk: JunkWire | None;
  /** Replaces `trashWire`. `none`: the live section is withheld. */
  readonly trash: TrashWire | None;
  /** Replaces `suggestWire`. `none`: no spend, no opt-in row. */
  readonly suggest: SuggestWire | None;
  /** Replaces `draftReplyWire`. */
  readonly draftReply: DraftReplyWire | None;
  /** Replaces `firstRun`. `none`: the stage does not exist. */
  readonly firstRun: FirstRunWire | None;
  /** `none`: the three Ohbox controls are not drawn. */
  readonly screening: ScreeningWire | None;
  /** `none`: no list. */
  readonly autoFiled: AutoFiledWire | None;
  /** `none`: no review, and no door back to it in Settings. */
  readonly seedReview: SeedReviewWire | None;
  /** `none`: the confirm says its sentence without numbers. */
  readonly folderSummary: FolderSummaryWire | None;
  /** `none` everywhere `suggest` is not `ownModel`. */
  readonly ownModelAutoSuggest: OwnModelAutoSuggestWire | None;
  /** `none`, with the capability `mailboxes` at `none`. */
  readonly mailboxes: MailboxesWire | None;
}
