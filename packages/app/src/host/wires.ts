/**
 * THE WIRES: the calls that are not mail acts. One route each; the control is shared and only
 * the transport is the shell's. Each key of {@link HostWires} is its transport, or `none`.
 *
 * Thirteen replace an input of the old shell and repeat the type that input has there, verb for
 * verb, so the transport a mount hands in today is a wire as it stands. Seven replace no input:
 * four shared files reach their route through the server client today, one control exists only
 * in the desktop's own pane, the Mailboxes pane's verbs live inside the node a mount passes, and
 * five forms connect a mailbox each by its own calls.
 *
 * Until its first caller arrives, a shell answers `none` for a call today's views still make themselves: the seven wires
 * that replace no input, and a browser's `images`. The `none:` sentences below say what a 2.0 view does with that answer.
 */
import type { OlderBodyWire } from "@ohmail/client-engine";
import type { CalendarPort } from "@ohmail/app-logic/calendar/port";
import type {
  Answered, CodeCeremony, Connected, ConnectInput, ConnectPatch, ConnectProbed, ConnectPurposeKind, MailboxId,
  Secret, SignInProvider, SignInReturn, SignInWays,
} from "@ohmail/app-logic/mailboxes/contract";
import type { None } from "./contract.js";
import type {
  AutoFiled, AutoFiledPutBack, AwayDraft, AwaySaved, AwayState, ConnectAllowance, ConsentReadFailure, ConsentState,
  DraftReplyRead, FirstRunCount, FirstRunMailbox, FirstRunOrganizeIntent, FirstRunOrganized, FirstRunProbed,
  FirstRunStepUp, FolderSummary, JunkFound, JunkPage, JunkRescued, JunkSweep, MailboxErased, MailboxRow,
  OrganizeAnswer, OrganizerPeek, OwnModelAutoSuggest, ProfileImportApplied, ProfileImportCandidate,
  ProfileImportStatus, ReleaseAnswer, ScreenerPage, ScreenerSuggested, ScreeningChange, ScreeningPreference,
  SeedConfirmed, SeedReview, TrashPage, TravelledChange,
} from "./payloads.js";
import type { Signal } from "./signals.js";

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
 * A PROVIDER'S OWN SIGN-IN, the shell's whole: the start, the state, whose ceremony it is, where it lands, its
 * completion and the loop of a sign-in by code. A view presses and draws two signals; it holds no state, no code and
 * no handle of a ceremony.
 */
export interface ProviderSignInWire {
  /** Which ceremonies this shell can run. It fails closed inside the shell: unread or unreadable is shut. */
  ways(): Promise<SignInWays>;
  /**
   * Leave for the provider. `leaving`: the browser is on its way. `retired`: the press was withdrawn while the
   * server answered (`stillWanted` said no); nothing was recorded and nothing navigates. `mailboxId` is a
   * reconnect's subject and only preselects the account at the provider.
   */
  start(o: {
    provider: SignInProvider;
    purpose: ConnectPurposeKind;
    mailboxId?: MailboxId;
    stillWanted: () => boolean;
  }): Promise<Answered<"leaving" | "retired">>;
  /** What a sign-in started earlier came back with; `null` where none did. */
  readonly returned: Signal<SignInReturn | null>;
  /**
   * The sign-in by a code typed at the provider. `begin` starts one; `live` is what to draw, polled at the server's
   * pace and only while something subscribes; `stop` forgets it. `none`: this shell runs no such ceremony here.
   */
  readonly code:
    | { begin(provider: SignInProvider): Promise<Answered<null>>; readonly live: Signal<CodeCeremony | null>; stop(): void }
    | None;
}

/**
 * THE CONNECT FORM'S CALLS. No input today: five forms reach their routes themselves. Every member answers and none
 * throws; a refusal is the plain record a shell's adapter read off its transport.
 */
export interface ConnectWire {
  /** Try the login and store nothing. */
  probe(input: ConnectInput): Promise<Answered<ConnectProbed>>;
  /** Connect it. `seed`: an install's first mailbox; `add`: a further one. The mode is stated, never defaulted. */
  connect(input: ConnectInput, mode: "seed" | "add"): Promise<Answered<Connected>>;
  /** New credentials for a connected mailbox, proven before they are stored. It names no mailbox in its answer: the one asked. */
  edit: ((mailboxId: MailboxId, patch: ConnectPatch) => Promise<Answered<null>>) | None;
  /** Who hosts a domain's mail. The domain alone, never the part before the @. */
  discover: ((domain: string, signal: AbortSignal) => Promise<unknown>) | None;
  signIn: ProviderSignInWire | None;
  /** A server on this computer may take minutes to answer a test: the form says so while it waits. */
  readonly localServerWait: boolean;
}

/**
 * The Mailboxes pane's own calls. No input today. Which of them a shell offers is the capability `mailboxes` and a
 * member's own `none`, together: a withheld verb is absent, never disabled. Connecting and editing are the connect
 * form's ({@link ConnectWire}).
 */
export interface MailboxesWire {
  list(o: { counts: boolean }): Promise<Answered<readonly MailboxRow[]>>;
  allowance: (() => Promise<Answered<ConnectAllowance>>) | None;
  resync(mailboxId: MailboxId): Promise<Answered<null>>;
  remove: ((mailboxId: MailboxId) => Promise<Answered<null>>) | None;
  /** `typed`: the address as the person typed it; never filled in for them. */
  erase: ((mailboxId: MailboxId, typed: string) => Promise<Answered<MailboxErased>>) | None;
  organizer: ((mailboxId: MailboxId) => Promise<Answered<OrganizerPeek>>) | None;
  organizeHere: ((mailboxId: MailboxId, o: { password?: Secret }) => Promise<Answered<OrganizeAnswer>>) | None;
  stopOrganizing: ((mailboxId: MailboxId) => Promise<Answered<ReleaseAnswer>>) | None;
  dismissForwardingNotice: ((mailboxId: MailboxId) => Promise<Answered<MailboxRow>>) | None;
  selfCheck: ((mailboxId: MailboxId) => Promise<Answered<unknown>>) | None;
  filings:
    | {
        read(mailboxId: MailboxId): Promise<Answered<unknown>>;
        retry(mailboxId: MailboxId, folder: string): Promise<Answered<{ reset: number; skipped: number }>>;
        leave(mailboxId: MailboxId, folder: string, through: string): Promise<Answered<{ settled: number; remaining: number }>>;
      }
    | None;
  /** The way out where this shell changes mailboxes elsewhere (the capability `resyncAndOut`). */
  out: (() => void) | None;
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
  /** Replaces `imageWire`. `none`: this shell hands in no fetcher. Whether pictures are drawn at all is `capabilities.imagesFrom`. */
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
  /** `none`: nothing is connected or edited from this shell. */
  readonly connect: ConnectWire | None;
  /** `none`, with the capability `mailboxes` at `none`. */
  readonly mailboxes: MailboxesWire | None;
  /** The calendar's port over this shell's engine. `none`: no calendar here; with the capability `products` at `none`. */
  readonly calendar: CalendarPort | None;
}
