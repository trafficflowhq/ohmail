/**
 * The live world — what the mail screens render and dispatch when the connection is live; the
 * one seam between screens and engine. Reads are the shared selectors, never re-derived
 * (`ohboxView`, `readsPartition`, `receiptsByDay`, `screenerSegments`, `triagePiles`, `bodyOf`,
 * `threadOf`) over the consent-cutline projection (`presentationReader` ∘ `consentPartition`),
 * so this phone shows the piles any other client shows. Writes go through `engine.mutate`,
 * watched: `rolled_back` raises one sentence, `queued` is not a failure (the webapp's `moveAll`
 * doctrine); the release family rewrites the sender's own holding rule, or writes an address rule
 * beside a domain rule (`releaseRules`), beside physical `move`s. Mutations read the raw mirror ({@link presentedOf} is for renders); no React, no I/O, no network.
 */
import { isSharedProviderDomain } from "@ohmail/client-engine";
import {
  FOLDER_OF_VIEW,
  LAST_DRAIN_AT_META,
  MARK_SEEN_CHUNK,
  chunkMarkSeen,
  VIEW_OF_FOLDER,
  bodyOf,
  canonicalDestination,
  consentIndex,
  consentPartition,
  decidedDestination,
  forwardSubject,
  replySubject,
  appointmentStamp,
  messageDisplayTime,
  composeZonedWallClock,
  zonedFields,
  zonedInstant,
  zonedWeekday,
  feedPartition,
  ohboxView,
  physicalFolderOf,
  presentationReader,
  presentsUnread,
  oneRowPerKey,
  pressOverTwins,
  readsPartition,
  receiptsByDay,
  rulesList,
  storedRuleDestination,
  scheduledSendsList,
  draftsList,
  draftBodyKnown,
  SENDING_STALE_AFTER_MS,
  HELD_SEND_RECHECK_MS,
  screenerRowsOfStore,
  screenerSegments,
  senderKey,
  threadOf,
  isForwardedByUs,
  isOwnSent,
  triagePiles,
  winningStates,
  withSignature,
  OUTBOX_WITHDRAWN_CODE,
  SIG_FOLLOWING,
  effectiveSignature,
  folderNameError,
  PRESS_THREW,
  pressVerdict,
  tallyVerdicts,
  sendingMailboxId,
  type FolderNameError,
  type SignatureState,
  type AddressCounts,
  type AddressDirection,
  isJunkHuskLeaving,
  type BodyState,
  type WithheldMarker,
  type EmailAddress,
  type EngineDraft,
  type EngineMessage,
  type EngineMutation,
  type ComposeAttachment,
  type EntityReader,
  type FeedView,
  type Folder,
  type FolderEntity,
  type MutationResult,
  type OhmailEngine,
  StoreSearchWalker,
  StoreTimelineWalker,
  type ServerSearchOutcome,
  type ServerSearchOpts,
  type PressVerdict,
  type RuleDTO,
  type ScreenDest,
  type ScreenerSenderDTO,
  type StayedWhy,
  inverseMutations,
  routingSubject,
  type DecideIntent,
  type RoutingIntent,
  applySendAndDone,
  intentOf,
  releasePlanAt,
  sendAndDonePlanFor,
  type SendAndDonePlan,
  type TagDTO,
  type TrashRowWire,
  type WallClockVerdict,
  type WithdrawOutcome,
  type ZonedComposition,
  isResurfaced,
  resurfacedThreads,
  ohboxRows,
  rowOpenTarget,
  threadSubject,
  type OhboxRow,
  conversationSize,
  forwardPress,
  tagsCrossView,
  type ForwardAsk,
  holderIsLive,
  ruleMatchKey,
  unscreenedGroups,
  unscreenedTotalOf,
  zonedDayNumber,
  NOT_DERIVED_FROM,
  beginDerive,
  takeClientEngineVitals,
  joinableStandingSend,
  type MessageBody,
} from "@ohmail/client-engine";
import { Copy } from "../copy";
import { activeLocale } from "../i18n/locale";
import { blobToBase64 } from "../mail/blob-base64";
import { logAttachmentRefusal, logLaunchReplay } from "../engine/engine-log";
import { refuse, type Refusal, type RefusalArg } from "../refusal";
import {
  mailboxProfiles, planScreenCommit, pressForecast, pressOutcome, ruleFingerprint, rulesInPlay, stayVerdict,
  type AnyRoutingIntent, type ConsentOptions, type PressForecast, type PressResolution, type RulesInPlay,
  type ScreenIntent,
} from "@ohmail/client-engine";
import { destLabel, DESTINATIONS as SCREEN_DESTS, type MailTag } from "./model";
import { moveStayedInBatches, stayedAsk, type StayedAsk } from "./sender-stayed";
import { tagHueOf } from "../theme/palette";
import { ACCESS_REFUSED_CODE } from "../net/access-lock";
import { folderLeafOf, folderUnreadCounts } from "./folders";
/* Move/Junk: the mail now, the sender's routing after the window. See the module. */
import {
  heldOn, holdRouting, holdScreenRouting, restartRouting, takeRoutingReversal, undoRouting, undoRoutingPress,
  type RoutingReplay, type ScreenCommitAnswer,
} from "./held-routing";
import type { ScreeningAnswer } from "../net/consent";
import { networkNow, type NetworkState } from "../net/network-door";
import type { ServerWaitingSender } from "../net/screener";
import {
  destDone,
  domainOf,
  isPlace,
  pileTitle,
  type Destination,
  type Held,
  type Mail,
  type PileItem,
  type PileKind,
  type Place,
  type Scope,
} from "./model";

/* ─────────────────────────────────────────────────────── the projected read */

/**
 * THE ACCOUNT'S CUTLINE ANSWER AS THIS SESSION KNOWS IT — three states, because `null` was two.
 *
 * `answered` is `GET /consent`'s three fields. The other two were one `null`: **unanswered**, the
 * read has not landed and an answer IS coming; **unsupplied**, nobody can answer — a server
 * carrying none of the three fields, or the standalone door, which has none to ask. Unanswered
 * partitions at `all_time` (the one posture that deletes no row) and WITHHOLDS the piles the
 * answer decides, so a first paint cannot show a superset that then shrinks; unsupplied is the
 * settled "retire nobody" this client has always shown.
 */
export type ScreeningPosture =
  | { readonly state: "answered"; readonly answer: ScreeningAnswer }
  | { readonly state: "unanswered" }
  | { readonly state: "unsupplied" };

/** The read is outstanding: the derived waiting shelf and History are UNKNOWN, never wide. */
export const SCREENING_UNANSWERED: ScreeningPosture = { state: "unanswered" };

/** Nobody can answer — a server with none of the three fields, or the standalone door. */
export const SCREENING_UNSUPPLIED: ScreeningPosture = { state: "unsupplied" };

/** The account's own answer, as the consent read gave it. */
export function screeningAnswered(answer: ScreeningAnswer): ScreeningPosture {
  return { state: "answered", answer };
}

/** The posture a view carries, with the caller who named none in the state whose name that is. */
function postureOf(v: WorldView): ScreeningPosture {
  return v.screening ?? SCREENING_UNSUPPLIED;
}

/** How the reader names days and times: the wall clock, the reader's zone, their language. */
export interface WorldView {
  now: Date;
  /** IANA zone. REQUIRED by `messageDisplayTime` — see its header for why there is no default. */
  zone: string;
  locale?: string;
  /**
   * Is "Use folders" ON for this account — the consent answer (`GET /consent`,
   * `foldersEnabledAt != null`), read by the world layer through `src/net/consent.ts`. Passed
   * into `consentPartition` exactly as the webapp shell passes it (`AppShell` → the consent
   * options), because the cutline DROPS a dormant folder-filed row from the presented list
   * unless the folder lens is on (spec §16.5) — without this flag a folder view loses read
   * mail from quiet senders, which is most of what an archive folder holds. Absent ⇒ `false`,
   * the pre-feature partition byte for byte.
   */
  foldersEnabled?: boolean;
  /**
   * THE READER'S OWN ADDRESSES — every mailbox on the paired account, from `GET /mailboxes`
   * (`src/net/mailboxes.ts`), read by the world layer on the folders flag's own cadence.
   *
   * ABSENT ⇒ {@link NO_OWN_ADDRESSES}, which is what this client had for its whole life and is
   * still the right answer for the render before the first read lands. Present, it is what lets
   * the reader be told apart from the other recipients — see `canReplyAll` in {@link toMail}
   * and `replyAllRecipients`, whose degradation this ends.
   */
  ownAddresses?: readonly string[];
  /**
   * THE ACCOUNT'S MAILBOXES AS ROWS — the same `GET /mailboxes` read {@link WorldView.ownAddresses}
   * is the address column of, kept whole so a message can be labelled with the one it arrived in
   * ({@link WorldMail.mailboxLabel}). ABSENT ⇒ nothing is named, which is a phone that has not read
   * yet and the standalone door: the same silence a one-mailbox account gets.
   */
  mailboxes?: readonly MailboxLabelRow[];
  /**
   * THE ACCOUNT'S CUTLINE ANSWER AND WHETHER IT IS IN — {@link ScreeningPosture}, read by the
   * world layer on the folders flag's own cadence (`GET /consent`). It decides WHICH SENDERS ARE
   * STILL WORTH A DECISION, and the server answers that from `account_settings` while this client
   * used to answer it from the engine's default — six waiting senders listed, two shown. ABSENT ⇒
   * `unsupplied`, the state whose name that is: this caller named no answer and none is coming,
   * which is not the same thing as a read still in flight.
   */
  screening?: ScreeningPosture;
  /** The account's tags ({@link liveTags}), so a row can wear the ones its labels name. */
  tags?: readonly WorldTag[];
}

/** What labelling a delivery needs of a mailbox — `PhoneMailbox`'s three relevant fields. */
export interface MailboxLabelRow {
  id: string;
  address: string;
  displayName?: string | null;
}

/**
 * WHICH OF THE ACCOUNT'S MAILBOXES A MESSAGE WAS DELIVERED TO, as a word — the phone's half of the
 * browser's `mailbox-label.ts`, and the same two rules: the gate is INSIDE (one mailbox, or none
 * read, is no question and answers nothing), and the face is the mailbox's own label with the bare
 * address where it has none, so one mailbox reads the same on every surface.
 */
export function mailboxLabelOf(
  rows: readonly MailboxLabelRow[] | undefined,
  mailboxId: string,
): string | undefined {
  if (rows === undefined || rows.length <= 1) return undefined;
  const row = rows.find((m) => m.id === mailboxId);
  if (row === undefined) return undefined;
  return row.displayName?.trim() || row.address;
}

/** The phone's own zone, once — `Intl` on Hermes; UTC where the runtime cannot say. */
export function readerZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";
  } catch {
    return "UTC";
  }
}

/**
 * The mirror with every message sitting where it is presented — the same projection the webapp
 * shell feeds its pile selectors (`AppShell` → `consentPartition` → `presentationReader`). The
 * cutline takes the account's answer, never this package's default: `screening` is
 * {@link ScreeningPosture} over `GET /consent`'s three fields, `ownAddresses` is
 * `GET /mailboxes`'. Neither state without an answer partitions by a window nobody asked for:
 * both take `all_time`, the one posture that deletes NO row from the projection. What separates
 * them is {@link PresentedWorld.cutlinePending} — see it.
 */
export interface PresentedWorld {
  /** The projection the pile selectors read — History's rows are absent from its `message` list. */
  reader: EntityReader;
  /** History's own contents, newest first — the SAME partition's other arm. */
  history: readonly EngineMessage[];
  /**
   * IS THE ANSWER STILL COMING? True in the `unanswered` posture alone.
   *
   * `all_time` retires nobody, so under it the Screener's derived shelf holds EVERY undecided
   * sender and History holds none — the widest queue any answer can produce. Painting that while
   * the answer is in flight showed mail that then vanished, one shrink per boot. So the piles the
   * answer decides are withheld rather than guessed while this is true, and the screens mark them
   * as unknown ({@link WorldScreener.waitingPending}, {@link WorldHistory.pending}): an empty list
   * with no marker reads as "no mail", and membership may then only GROW when the answer lands.
   */
  cutlinePending: boolean;
}

/**
 * ONE PARTITION, TWO ARMS — the Screener's waiting senders and History's retired mail are the
 * two sides of a single `consentPartition` call, so the two lists cannot disagree about a
 * sender. Partitioning twice (once for the projection, once for History) would be one rule read
 * at two clocks, which is a sender in both lists or in neither.
 */
export function presentedWorld(
  reader: EntityReader, now: Date, foldersEnabled = false,
  screening: ScreeningPosture = SCREENING_UNSUPPLIED,
  ownAddresses?: readonly string[],
): PresentedWorld {
  partitions += 1;
  const partition = consentPartition(reader, presentedOptions(now, foldersEnabled, screening, ownAddresses));
  return {
    reader: presentationReader(reader, partition),
    history: partition.history,
    cutlinePending: screening.state === "unanswered",
  };
}

/** How many whole-mirror partitions this process ran — the ratchet's counter for the cost that dominates a run. */
let partitions = 0;
export function partitionRuns(): number {
  return partitions;
}

/**
 * THE OPTIONS THE PHONE'S LISTS ARE PARTITIONED WITH — one builder, read by {@link presentedWorld}
 * and by a screening press's forecast, so the step and the list cannot place one row two ways.
 */
export function presentedOptions(
  now: Date, foldersEnabled = false,
  screening: ScreeningPosture = SCREENING_UNSUPPLIED,
  ownAddresses?: readonly string[],
): ConsentOptions {
  return {
    now,
    foldersEnabled,
    ...(screening.state === "answered"
      ? {
          ...(screening.answer.dormancyDays === null
            ? {}
            : { dormancyDays: screening.answer.dormancyDays }),
          baselineAt: screening.answer.baselineAt,
          screeningScope: screening.answer.scope,
        }
      : { screeningScope: "all_time" as const }),
    /* Absent ⇒ `consentPartition` falls back to the mirror's `mailbox` entities, and this
       client's sync vocabulary carries none — so an empty set, which is what let the reader
       appear in their own queue. Passed whenever the mailbox read has landed. */
    ...(ownAddresses === undefined ? {} : { ownAddresses }),
  };
}

/** The projection alone — {@link presentedWorld}'s first arm, for a caller with no History list. */
export function presentedOf(
  reader: EntityReader, now: Date, foldersEnabled = false,
  screening: ScreeningPosture = SCREENING_UNSUPPLIED,
  ownAddresses?: readonly string[],
): EntityReader {
  return presentedWorld(reader, now, foldersEnabled, screening, ownAddresses).reader;
}

/* ───────────────────────────────────────────────────────────── row mapping */

/** What a tile press gets back: the bytes as base64, or the engine's own refusal by name. */
export type WorldAttachmentBytes =
  | { state: "ready"; base64: string; mime: string; filename: string }
  /** The engine item's refusal facts: the tile's sentence names the side, `retryable` its tap. */
  | { state: "failed"; code: string | null; retryable: boolean; status: number | null }
  | { state: "too_large" | "unavailable" };

/** One attachment tile: the engine's item (fallback name applied), size as words. */
export interface WorldAttachment {
  id: string;
  filename: string;
  size: string;
  /** A part the body references (`cid:`) rather than a file the sender attached — the tile
      wears the "embedded" tag and sorts after every real file. */
  inline: boolean;
  /** The declared type — what the share sheet and the platform viewer are told. */
  mime: string;
  /** The byte fetch's honest state, the engine's own: a press asks, a refusal stays said. */
  state: "idle" | "loading" | "ready" | "too_large" | "failed";
}

/**
 * THE MESSAGE'S TRIAGE STATE as the action bar reads it — which pile it sits in, or the pin.
 * The webapp bar's `aria-pressed` face and its Done slot are decided from exactly this.
 */
export type WorldPileState = "reply_later" | "set_aside" | "bubbled_up" | "resurfaced" | null;

/**
 * The screens' row type: the mail row plus an attachment strip, the body's honest state, and
 * the facts the ACTION BAR decides from — so the message screen never re-derives a predicate
 * the webapp resolves in one place (reply-all visibility, the forward refusal, the pressed
 * pile, the folder the move panel excludes).
 */
/** How long the reader may say "loading" over a husk moved out of Junk — the engine's number. */
export { JUNK_REFILL_BOUND_MS } from "@ohmail/client-engine";
// Which side failed for a file that could not be fetched — the web reader's own class table.
export { attachmentFaultClass, type AttachmentFaultClass } from "@ohmail/client-engine";
export { ruleMatchKey } from "@ohmail/client-engine";
// The shared-provider list, for the Screening sheet: a domain there is never offered as a scope.
export { isSharedProviderDomain } from "@ohmail/client-engine";
export type { WaitingOnOrganizerView } from "@ohmail/client-engine";
/** Forward's one predicate and its ask, for the reader — the engine's own, through this seam. */
export { forwardOffered, type ForwardAsk } from "@ohmail/client-engine";

/** A conversation member under the opened message, with its own files beside its text. */
export type WorldEarlier = Held & {
  attachments?: WorldAttachment[];
  /** A pinned member: its pin is the row's to release, so the reader's Mark as read leaves it out. */
  resurfaced?: true;
};

export type WorldMail = Omit<Mail, "earlier"> & {
  /** The rest of the conversation, oldest → newest, each member with its files. */
  earlier: WorldEarlier[];
  attachments?: WorldAttachment[];
  bodyState?: BodyState;
  /** WHICH policy emptied a `withheld` body — the reader owes each marker its own sentence. */
  bodyWithheld?: WithheldMarker;
  /** A spam verdict's husk on a message no longer in the spam pile — the engine's `isJunkHuskLeaving`. */
  bodyJunkLeaving?: true;
  /**
   * The hydrated html part, exactly as `bodyOf` reports it — non-null only on a `full` body
   * that carries one. Attached by {@link liveMessage} alone (the reading view is its one
   * consumer); a list row never pays for a document it will not draw.
   */
  html?: string | null;
  /** The body was stored with its remote content already loaded (the account's own switch). */
  loadedRemoteContent?: boolean;
  /**
   * The engine's minted embedded images, `contentId → data: URI` — identity-stable between
   * mints, so the reader's sanitize memo keys on it. Attached by {@link liveMessage} alone.
   */
  inlineImages?: ReadonlyMap<string, string>;
  /** Where the message physically is — the folder a `move` mutation is measured against. */
  folder: Folder;
  /**
   * WHERE THE MESSAGE IS SHOWN — the projection's own answer, which is the sender's routing.
   *
   * A newsletter ruled to `ohmail/News` sits physically in the INBOX, so the two fields
   * disagree for exactly the mail a pile presents. The move panel leaves this one out of its
   * list and `move()` retargets the rules holding the sender HERE — reading `folder` for either
   * offered the place the row is already in and retargeted at the filed one.
   */
  presentedFolder: Folder;
  /**
   * THE MAILBOX THE MESSAGE ARRIVED IN — and therefore THE SENDING MAILBOX of every compose
   * this screen can start: a reply's From is `Engine.enrich`'s own `parent.mailboxId` and the
   * forward arm already passes the same id explicitly, so this is the one id the composer's
   * signature block may follow (`effectiveSignature`; SIG-MOB). The projection used to carry
   * no mailbox handle on purpose; it carries exactly this one now BECAUSE the block must
   * derive from the id the mutation will put on the wire — a block keyed on anything else
   * could show one mailbox's signature and serialize under another's send.
   */
  mailboxId: string;
  /**
   * THAT MAILBOX AS A WORD, and only where the account holds more than one — what the Reads card
   * and the message screen show so a person can tell which of their addresses was written to.
   * Derived here rather than on the wire: the projection already has the id, and the world already
   * holds the rows. Absent is the ordinary single-mailbox case, not a missing read.
   */
  mailboxLabel?: string;
  /** The pile the bar shows as pressed, or the resurface pin the Done slot answers to. */
  pile: WorldPileState;
  /**
   * Whether "Reply all" is offered — `replyAllRecipients(m, ownAddresses) !== null`, the same
   * predicate the webapp bar and its send path resolve, so a 1:1 message offers no second reply.
   */
  canReplyAll: boolean;
  /**
   * The reply-all head's OWN words: the To line and the surviving Cc line of the SAME
   * envelope the send will carry, names first. Carried on the row so the composer states
   * the whole audience it is about to address — a head naming only the sender promised
   * "Reply to Alice" over a send that reached everyone. `null` exactly when
   * {@link canReplyAll} is false.
   */
  replyAllHead: { to: string; cc: string } | null;
  /** `sensitivity.no_forward` — Forward is still offered; the press asks first (`forwardAsk`). */
  noForward: boolean;
  /** Why a Forward press asks once before the composer opens (`forwardPress`); `null` opens it. */
  forwardAsk: ForwardAsk | null;
  /** The tag ids on this message — what the tag sheet shows as checked. */
  labels: string[];
  /**
   * Set EXACTLY when the message physically lives in one of the user's OWN folders (a path
   * `VIEW_OF_FOLDER` does not know): the last path segment, the only safe face for a raw
   * folder string (the engine's own narrow-UI rule). The message screen titles itself with
   * this instead of a place name — a folder-filed message headed "Ohbox" was the fallback lie
   * `placeOfFolder`'s ohbox-default would otherwise tell.
   */
  folderLeaf?: string;
};

/**
 * A SCREENING PRESS READ BACK FROM THE LIST (the web's `press-verdict.ts`, one classifier in the
 * engine): the sentence naming what stays where and why, or `null` when every pressed row is shown
 * at the place. `presented` is the reader the lists are drawn from (`presentedWorld`).
 */
function pressReadBack(
  reader: EntityReader, presented: EntityReader, ofSubject: (m: EngineMessage) => boolean,
  wanted: Folder, place: string, retro: boolean,
): Refusal | null {
  const subject = reader.list<EngineMessage>("message").filter(ofSubject);
  const v = stayVerdict(pressOutcome({
    presented, subject, rules: rulesList(reader), profiles: mailboxProfiles(reader), wanted, retro,
  }), reader);
  switch (v.key) {
    case "none": return null;
    case "kept": return v.rule.kind === "domain"
      ? refuse(v.field === "body" ? "liveVerdictKeptDomainBody" : "liveVerdictKeptDomain",
        v.count, place, v.kept, folderName(v.keptPlace), v.rule.match, v.term)
      : refuse("liveVerdictKept", v.count, place, v.kept, folderName(v.keptPlace), v.term);
    case "keptMany": return refuse("liveVerdictKeptMany", v.count, place, v.kept);
    case "still": return refuse("liveVerdictStill", v.count, place, v.still, v.stillPlace === null ? refuse("history") : folderName(v.stillPlace));
    case "stillSpread": return refuse("liveVerdictStillSpread", v.count, place, v.still);
    case "stillLegacy": return refuse("liveVerdictStillLegacy", v.count, place, v.still, v.folder, folderName(v.folder));
    case "applying": return refuse("liveVerdictApplying", v.count, place);
    case "undecided": return refuse("liveVerdictUndecided", v.count, place, v.still, folderName(v.stillPlace), v.term);
  }
}

/**
 * Where the backlog pass stands for the rules a commit wrote — a create's server id, an update's
 * own: `done`, still `applying`, or `unknown` (a rule with no stamp, an older server, a create
 * whose id is not known, a rule gone). The phone never says every message arrived over a pass it
 * cannot see.
 */
function retroStateOf(
  reader: EntityReader, mutations: readonly EngineMutation[], answers: readonly (MutationResult | null)[],
): "done" | "applying" | "unknown" {
  let applying = false;
  for (let i = 0; i < mutations.length; i++) {
    const m = mutations[i]!;
    const id = m.kind === "rule_update" ? m.ruleId : m.kind === "rule_create" ? answers[i]?.entityId : null;
    if (m.kind !== "rule_update" && m.kind !== "rule_create") continue;
    if (!id) return "unknown";
    const r = reader.get<RuleDTO>("rule", id);
    if (!r?.retro) return "unknown";
    if (r.retro.requestedAt !== null && r.retro.doneAt === null) applying = true;
  }
  return applying ? "applying" : "done";
}

function retroFinished(
  reader: EntityReader, mutations: readonly EngineMutation[], answers: readonly (MutationResult | null)[],
): boolean {
  return retroStateOf(reader, mutations, answers) === "done";
}

/** A pile's name for a folder in either News spelling; a folder of the user's own by its leaf. */
export function folderName(folder: string): string {
  const view = VIEW_OF_FOLDER[folder as Folder];
  return (SCREEN_DESTS as readonly string[]).includes(view) ? destLabel(view as Destination) : folderLeafOf(folder);
}

function placeOfFolder(folder: Folder): Place {
  const view = VIEW_OF_FOLDER[folder];
  return view === "reads" || view === "receipts" ? view : "ohbox";
}

/**
 * THE MESSAGE'S CURRENT TRIAGE CLAIM. Reading `m.triage` alone was measured to miss a
 * just-dispatched `triage_set` entirely (the optimistic effect and the live server both write
 * `message_state` records, not the message row), which turned every toggle into a re-file: press
 * Later twice and the wire carried `reply_later` twice, never `none`. `winningStates` folds BOTH
 * wire homes into one claim — the same derivation the pile lister and the Ohbox hold-out read —
 * so the bar's pressed face, the toggles and the piles cannot disagree about where a message
 * stands. No second read of `m.triage` beside it: the fold already carries it, and a fallback
 * that cannot fire would quietly outrank a newer record.
 */
function triageStateOf(reader: EntityReader, m: EngineMessage): string | null {
  return winningStates(reader).get(m.id)?.state ?? null;
}

function pileOf(reader: EntityReader, m: EngineMessage): WorldPileState {
  const s = triageStateOf(reader, m);
  if (s === "resurfaced") return "resurfaced";
  return s === "reply_later" || s === "set_aside" || s === "bubbled_up" ? s : null;
}

/** A recipient's face: the name, or the address where none was given. */
function displayName(r: EmailAddress): string {
  return r.name || r.address;
}

function toMail(reader: EntityReader, m: EngineMessage, v: WorldView): WorldMail {
  return mailRow(reader, m, v, bodyOf(reader, m));
}

/** A list row carries no body: a body is drawn by the surface that subscribes to it (`useBodyStamp`). */
const NO_BODY: MessageBody = {
  text: "", state: "snippet", html: null, loadedRemoteContent: false, unsubscribe: "no_header", unsubscribeUrl: null,
};

/**
 * A LIST ROW, memoised per ENTITY OBJECT across derivations. Its inputs are the entity (replaced,
 * never edited, on change), the view (the reader's day, zone, language, tags, mailboxes and own
 * addresses — the last three by identity) and two facts the reader answers in O(1) off its own
 * caches: the pile and the conversation length. A hit re-reads those two and returns the SAME row
 * object, so a list re-derived after an arrival changes the identity of the rows that moved and
 * nothing else. No body text is held: the memo is bounded by the window's rows.
 */
const listRows = new WeakMap<EngineMessage, {
  day: string; tags: unknown; mailboxes: unknown; own: unknown; pile: WorldPileState; thread: number; row: WorldMail;
}>();

export function toListRow(reader: EntityReader, m: EngineMessage, v: WorldView): WorldMail {
  const day = `${zonedDayNumber(v.now, v.zone)}|${v.zone}|${v.locale ?? "en"}`;
  const pile = pileOf(reader, m);
  const thread = conversationSize(reader, m);
  const hit = listRows.get(m);
  if (hit !== undefined && hit.day === day && hit.tags === v.tags && hit.mailboxes === v.mailboxes
    && hit.own === v.ownAddresses && hit.pile === pile && hit.thread === thread) return hit.row;
  const row = mailRow(reader, m, v, NO_BODY);
  delete (row as { bodyState?: BodyState }).bodyState;
  listRows.set(m, { day, tags: v.tags, mailboxes: v.mailboxes, own: v.ownAddresses, pile, thread, row });
  return row;
}

/**
 * AN OWN-SENT ROW SAYS WHO IT WENT TO — "Me → Nora", the web's words (`format.ts#sentRowRecipient`).
 * Its sender is the reader's own address, the one fact on the row that says nothing. With no To
 * recipient the sender face stays: never "Me →" with nothing after the arrow.
 */
function sentFaceOf(m: EngineMessage, own: readonly string[] | undefined): string | null {
  if (!own || own.length === 0) return null;
  const from = m.from.address.toLowerCase();
  if (!own.some((a) => a.toLowerCase() === from)) return null;
  const to = m.to ?? [];
  const first = to[0];
  const name = first ? first.name || first.address : "";
  if (!name) return null;
  return to.length > 1 ? Copy.rowSentToMore(name, to.length - 1) : Copy.rowSentTo(name);
}

/** The identity fact off the wire; the phone holds no dictionary and decides nothing itself. */
function senderCheckOf(m: EngineMessage): { senderCheck?: Mail["senderCheck"] } {
  const c = m.senderCheck;
  if (!c || c.reason !== "impersonation" || !c.brand) return {};
  const at = m.from.address.lastIndexOf("@");
  return {
    senderCheck: {
      brand: c.brand, domainShared: c.domainShared === true,
      domain: at < 0 ? "" : m.from.address.slice(at + 1).toLowerCase(),
    },
  };
}

/** The account's own mail, as `isOwn` reads it: the Sent copy, or a sender among its addresses. */
function ownMailOf(m: EngineMessage, physical: string, own: readonly string[] | undefined): boolean {
  if (isOwnSent({ folder: physical as Folder })) return true;
  const from = m.from.address.trim().toLowerCase();
  return (own ?? []).some((a) => a.trim().toLowerCase() === from);
}

function mailRow(reader: EntityReader, m: EngineMessage, v: WorldView, body: MessageBody): WorldMail {
  const env = replyAllRecipients(m, v.ownAddresses ?? NO_OWN_ADDRESSES);
  const physical = physicalFolderOf(m);
  return {
    // A message in one of the user's OWN folders (no view owns its path) names itself by its
    // leaf — see {@link WorldMail.folderLeaf}.
    ...(VIEW_OF_FOLDER[physical as Folder] === undefined ? { folderLeaf: folderLeafOf(physical) } : {}),
    // HELD AT THE GATE — see {@link Mail.gateHeld}. Off the PHYSICAL folder, because the place
    // is exactly what cannot say it: `Place` has three values and none of them is the Screener,
    // so every message the server holds at the gate fell to the ohbox default and the reading
    // screen titled it Ohbox — nine of nine, measured on a device.
    ...(physical === FOLDER_OF_VIEW.screener ? { gateHeld: true as const } : {}),
    id: m.id,
    place: placeOfFolder(m.folder),
    // BOTH LOCATIONS, because the two verbs want different ones: a `move` mutation is measured
    // against the physical folder, and the panel and the routing retarget against the presented
    // one. This reader is the projection, so `m.folder` IS the presented place and
    // `physicalFolder` keeps the real location. Carrying only one of them is what left the phone
    // offering the pile a row is already in and retargeting the rule at the filed folder.
    // (`physicalFolderOf` answers `physicalFolder ?? folder`, both `Folder` values on the
    // wire; its `string` return is the DTO's optional field being untyped, not a new shape.)
    folder: physical as Folder,
    presentedFolder: m.folder,
    mailboxId: m.mailboxId,
    ...(() => {
      const label = mailboxLabelOf(v.mailboxes, m.mailboxId);
      return label === undefined ? {} : { mailboxLabel: label };
    })(),
    // The wire's `name` is nullable; the row shape's is not — a nameless sender reads as
    // their address, exactly as every list row already renders one.
    from: { name: m.from.name || m.from.address, address: m.from.address },
    ...((): { sentTo?: string } => { const f = sentFaceOf(m, v.ownAddresses); return f === null ? {} : { sentTo: f }; })(),
    ...(ownMailOf(m, physical, v.ownAddresses) ? { ownMail: true as const } : {}),
    ...senderCheckOf(m),
    subject: m.subject,
    time: messageDisplayTime(m, v.now, v.zone, v.locale ?? "en"),
    body: body.text,
    bodyState: body.state,
    ...(body.state === "withheld" && body.withheld ? { bodyWithheld: body.withheld } : {}),
    ...(isJunkHuskLeaving(body, physical) ? { bodyJunkLeaving: true as const } : {}),
    snippet: m.snippet,
    /* READ STATE AS DRAWN, not as stored — the one shared derivation, so the phone bolds
       exactly the rows the desktop and the browser do (owner ruling 2026-08-31: a resurfaced
       message reads unread until Done or a reply releases it). `markSeen` below is unaffected:
       it takes the direction it is given and is the DELIBERATE verb, so pressing "Mark as
       read" on a pinned row spends the pin, which is the release this presentation implies. */
    unread: presentsUnread(m),
    pile: pileOf(reader, m),
    /* THE READER IS TOLD APART NOW, where the mailbox read has landed. This carried the
       degradation the predicate documents — offered from two listed people, withheld at one —
       for as long as the phone had no `GET /mailboxes` facts at all. `v.ownAddresses` is that
       read; before it lands (and on a server that could not be asked) the fallback is the same
       empty set as before, so the old behaviour is exactly the unread state and not a
       regression path. */
    canReplyAll: env !== null,
    replyAllHead: env
      ? { to: env.to.map(displayName).join(", "), cc: env.cc.map(displayName).join(", ") }
      : null,
    noForward: m.sensitivity?.no_forward === true,
    forwardAsk: forwardPress(m).ask,
    labels: [...(m.labels ?? [])],
    ...(() => {
      const marks = tagMarksOf(m.labels, v.tags);
      return marks.length > 0 ? { tags: marks } : {};
    })(),
    ...(m.rationale ? { rationale: m.rationale } : {}),
    ...(m.trackerNote ? { trackerNote: m.trackerNote } : {}),
    ...(m.amount ? { amount: m.amount } : {}),
    ...(m.protected ? { protected: m.protected as Mail["protected"] } : {}),
    /* THE CONVERSATION'S LENGTH, ON EVERY ROW OF EVERY LIST — `conversationSize` answers 0 for a
       row standing for one message, and the badge and the spoken sentence both read that one
       number. Before this the count came only from `earlier`, which only the reading view fills,
       so a phone list showed a conversation of five as a single message. */
    ...(() => {
      const thread = conversationSize(reader, m);
      return thread > 1 ? { threadCount: thread } : {};
    })(),
    earlier: [],
  };
}

/**
 * The answer before the mailbox read lands — recognise the reader nowhere. The read exists
 * (`src/net/mailboxes.ts`, fed through {@link WorldView.ownAddresses}); this is the fallback
 * for the render before the first answer arrives, and for a server that could not be asked —
 * the posture the webapp documents (`message-chrome.tsx` `ownAddresses`). A named constant
 * rather than an inline `[]`: that is what made the feed a one-line change.
 */
const NO_OWN_ADDRESSES: readonly string[] = [];

/**
 * Who organizes the mailboxes this phone is showing — the reader banner's one fact, or `null`
 * when nothing true can be said. A phone cannot be the organizer (no IMAP client here), so the
 * deck's `phoneBanner`/`phoneBannerWhy` say who does. Three answers, only one a name: a single
 * named holder is the banner; no named holder (`organizedBy` null on every row — the DTO's
 * "the answering install organizes it") withholds the banner rather than showing an origin URL;
 * two different holders withholds too — the copy has one `{name}` and either would be false
 * about the other. `stopped` rides along because a phone saying "organized by X's laptop" about
 * an organizer that stopped renewing claims decisions are carried out when they are not.
 */
export interface PhoneOrganizer {
  /** The holder's own machine name — never empty, or this is not a `PhoneOrganizer`. */
  name: string;
  /** `cloud` · `local` · `unknown`, as the wire gave it; `null` when it named only a name. */
  kind: string | null;
  /** True when the paired server last saw that organizer STOPPED renewing its claim. */
  stopped: boolean;
}

export function phoneOrganizer(
  mailboxes: readonly { organizedBy: { kind: string | null; name: string | null } | null;
                       organizerState: "held" | "stopped" | null; organizerParkedAt?: string | null }[],
): PhoneOrganizer | null {
  // A mailbox the closed account paused names nobody who stopped (mail 0135): it resumes on its own.
  const named = mailboxes.filter((m) => (m.organizerParkedAt ?? null) === null && (m.organizedBy?.name ?? "") !== "");
  if (named.length === 0) return null;
  const distinct = new Set(named.map((m) => m.organizedBy!.name!));
  if (distinct.size !== 1) return null;
  const first = named[0]!;
  return {
    name: first.organizedBy!.name!,
    kind: first.organizedBy!.kind ?? null,
    /* STOPPED ONLY IF EVERY ROW SAYS SO, by the reader refusal's decider. With one holder across
       several mailboxes a mixed answer means the claim is still being renewed somewhere, and
       "stopped organizing" would be the more alarming sentence told on the weaker evidence. */
    stopped: named.every((m) => !holderIsLive({ by: m.organizedBy, state: m.organizerState })),
  };
}

/**
 * THE BANNER'S TWO LINES. A holder that stopped organizes nothing, so the head says that rather
 * than "Organized by" a machine that stopped, and the line under it names the machine and what
 * waits meanwhile.
 */
export function phoneBannerLines(o: PhoneOrganizer): { head: string; why: string } {
  return o.stopped
    ? { head: Copy.phoneStateNotOrganized, why: Copy.phoneBannerStopped(o.name) }
    : { head: Copy.phoneBanner(o.name), why: Copy.phoneBannerWhy };
}

/** The reply-all envelope: who stands on the To line, and who rides Cc. */
export interface ReplyAllRecipients {
  to: EmailAddress[];
  cc: EmailAddress[];
}

/**
 * Who a reply-to-all is addressed to — or `null` when "all" is nobody beyond the plain reply.
 * Mirrored from `apps/webapp/app/shell/compose-from.ts#replyAllRecipients` (the reference; the
 * webapp shell is not importable from React Native). The `null` is the visibility rule as well
 * as the degenerate case: the bar offers Reply all exactly when this returns an envelope, and
 * the send path asks the same call, so promise and send are one decision. With no own addresses
 * the envelope is offered from two listed people and withheld at one — a lone recipient is
 * almost always the reader. Counted across both lines, folded, one person once.
 */
export function replyAllRecipients(
  parent: { from: EmailAddress; to: readonly EmailAddress[]; cc?: readonly EmailAddress[] },
  ownAddresses: readonly string[],
): ReplyAllRecipients | null {
  const fold = (a: string): string => a.trim().toLowerCase();
  const mine = new Set(ownAddresses.map(fold));
  const sender = fold(parent.from.address);
  const cc = parent.cc ?? [];
  const seen = new Set<string>();
  const others = (list: readonly EmailAddress[]): EmailAddress[] =>
    list.filter((r) => {
      const a = fold(r.address);
      if (mine.has(a) || seen.has(a)) return false;
      seen.add(a);
      return true;
    });

  if (mine.size > 0 && mine.has(sender)) {
    const toOthers = others(parent.to);
    const ccOthers = others(cc);
    if (ccOthers.length === 0) return null;
    return { to: toOthers.length > 0 ? toOthers : [parent.from], cc: ccOthers };
  }

  seen.add(sender);
  const toOthers = others(parent.to);
  const ccOthers = others(cc);
  if (toOthers.length === 0 && ccOthers.length === 0) return null;
  const listed = new Set([...parent.to, ...cc].map((r) => fold(r.address)));
  if (mine.size === 0 && listed.size < 2) return null;
  return { to: [parent.from, ...toOthers], cc: ccOthers };
}

/**
 * WHERE A MESSAGE CAN BE MOVED — the webapp's `MOVE_TARGETS` (MessagePane.tsx), the same
 * vocabulary in the same order; `test/action-parity.test.ts` compares the two.
 */
export type MoveTarget = "ohbox" | "reads" | "receipts" | "screened" | "spam";
export const MOVE_TARGETS: readonly MoveTarget[] = ["ohbox", "reads", "receipts", "screened", "spam"];

/**
 * The destinations the move panel offers for a message — every target except the one it is
 * SHOWN in. A pile is the sender's routing: a newsletter ruled to Reads sits in the INBOX, so
 * filtering on the physical folder hid Ohbox from the very row the reported press was made on
 * and offered Reads, which it was already in. It takes the ROW and not a folder so that the
 * wrong one cannot be handed to it — both fields are `Folder` and a caller passing `m.folder`
 * type-checked. The webapp panel's filter reads the projection for the same reason.
 */
export function moveTargetsFor(row: Pick<WorldMail, "presentedFolder">): MoveTarget[] {
  return MOVE_TARGETS.filter((t) => FOLDER_OF_VIEW[t] !== row.presentedFolder);
}

/** The move panel's label for a destination — the webapp's `PLACE_LABEL`. */
export function moveTargetLabel(target: MoveTarget): string {
  switch (target) {
    case "ohbox": return Copy.placeOhbox;
    case "reads": return Copy.placeReads;
    case "receipts": return Copy.placeReceipts;
    case "screened": return Copy.placeScreened;
    case "spam": return Copy.placeSpam;
  }
}

/**
 * A reader with some messages taken out — what makes a HELD delete look like a delete (the
 * webapp `delete-undo.ts#hideMessages`, the phone's port). The row leaves every presented list
 * at the press while the MIRROR keeps it, which is what lets Undo restore it by forgetting an
 * id. Identity is preserved when nothing is held, so downstream memos keep their inputs.
 */
export function hiddenMessagesReader(base: EntityReader, hidden: ReadonlySet<string>): EntityReader {
  if (hidden.size === 0) return base;
  return {
    version: () => base.version(),
    stampOf: (type) => base.stampOf(type),
    stampExcept: (ignore) => base.stampExcept(ignore),
    get<T = unknown>(type: string, id: string): T | undefined {
      if (type === "message" && hidden.has(id)) return undefined;
      return base.get<T>(type, id);
    },
    list<T = unknown>(type: string): T[] {
      const rows = base.list<T>(type);
      if (type !== "message") return rows;
      return rows.filter((r) => !hidden.has((r as unknown as EngineMessage).id));
    },
    entries<T = unknown>(type: string): Array<{ id: string; entity: T; seq: number }> {
      const rows = base.entries<T>(type);
      if (type !== "message") return rows;
      return rows.filter((r) => !hidden.has(r.id));
    },
  };
}

/* ── Trash — mail this account deleted, and putting one back ────────────────────────────── */

/** How many rows one Trash page asks for — the webapp `trash-page.ts`'s own ask; the server clamps. */
export const TRASH_PAGE_LIMIT = 50;

/**
 * One deleted message as the Trash screen renders it. `mail` is the standard row shape so
 * `MailRow` draws it like every other list; its `time` slot carries WHEN IT WAS DELETED (the
 * webapp row's rule — a message date in the deletion slot would be read as a deletion time),
 * and the empty string where a server predates `trashedAt`: quiet, never a false stamp.
 */
export interface WorldTrashRow {
  mail: Mail;
  /** The deletion instant in the reader's clock, or `null` for a server too old to say. */
  deletedWhen: string | null;
  /** Where a restore would put it, as a word — the webapp's `placeLabel` rule, one namespace over. */
  restoreLabel: string;
}

export type WorldTrashPage =
  | { state: "unavailable" }
  | { state: "failed"; say: string | null }
  | { state: "ready"; items: WorldTrashRow[]; nextCursor: string | null };

/**
 * A restore target as a word: the view's label for one of the product's own folders, the leaf
 * for one of the mailbox's. The webapp's `placeLabel` is the same two-arm rule — a second
 * mapping is how two surfaces come to call one folder two things, so this one delegates to
 * `moveTargetLabel` for every place that IS a move target and names only the two that are not.
 */
export function trashRestoreLabel(folder: string): string {
  const view = VIEW_OF_FOLDER[folder as Folder];
  if (view === undefined) return folderLeafOf(folder);
  if (view === "screener") return Copy.screener;
  return moveTargetLabel(view);
}

/** The account's tags, from the mirror — the `tag` entity every mobile drain carries. */
export interface WorldTag {
  id: string;
  name: string;
  hue: string;
}

export function liveTags(reader: EntityReader): WorldTag[] {
  return reader
    .list<TagDTO>("tag")
    .map((t) => ({ id: t.id, name: t.name, hue: t.hue }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The tags a message carries, as drawn — the web's `tagsOfMessage`, in the tag list's order. */
export function tagMarksOf(
  labels: readonly string[] | undefined, tags: readonly WorldTag[] | undefined,
): MailTag[] {
  if (!labels || labels.length === 0 || !tags) return [];
  return tags.filter((t) => labels.includes(t.id)).map((t) => ({ id: t.id, name: t.name, hue: tagHueOf(t.hue) }));
}

/** One tag's mail as a list screen draws it: newest first, and how much of it is unread. */
export interface WorldTagItems {
  rows: WorldMail[];
  unread: number;
  total: number;
}

export interface WorldTagged {
  /** How many presented messages carry the tag — the count beside it in the places list. */
  count: (tagId: string) => number;
  items: (tagId: string) => WorldTagItems;
}

/**
 * THE TAG LISTS — the web's `tagsCrossView` over the same projection the other lists read. The
 * mirror holds every tagged message whatever the window: the engine pins them and the snapshot
 * serves them as its labeled tail, so this is the store's set. Derived once per projection, on
 * the first read; rows are mapped per tag when a screen asks.
 */
export function liveTagged(pres: EntityReader, v: WorldView): WorldTagged {
  let groups: Map<string, EngineMessage[]> | null = null;
  const rows = new Map<string, WorldTagItems>();
  const of = (id: string): EngineMessage[] => {
    groups ??= new Map(tagsCrossView(pres).map((g) => [g.tag.id, g.messages]));
    return groups.get(id) ?? [];
  };
  return {
    count: (id) => of(id).length,
    items: (id) => {
      const held = rows.get(id);
      if (held) return held;
      const list = of(id).map((m) => toListRow(pres, m, v));
      const made = { rows: list, unread: list.filter((m) => m.unread).length, total: list.length };
      rows.set(id, made);
      return made;
    },
  };
}

/**
 * ONE SCHEDULED SEND, as the phone's Scheduled screen renders it (Send later, mail 0077).
 *
 * The shape is deliberately narrow — this surface answers one question, "what will send, and
 * when" — and the reason there is a row type at all rather than a raw `EngineDraft` is the
 * module's own charter: the screens stay logic-free, so the appointment arrives already read
 * in the reader's clock and the failure sentence already unpacked.
 */
export interface WorldScheduled {
  id: string;
  /** "Fri 18:00" / "12 Sep, 18:00" in the reader's zone, or `null` — see {@link liveScheduled}. */
  when: string | null;
  /** The subject, or the empty-subject stand-in the mail lists already use. */
  subject: string;
  /** The recipients, as one readable line ("Alice, bob@example.org"). */
  to: string;
  /** The first line or so of the body — enough to tell two appointments apart. */
  preview: string;
  /**
   * The server's own sentence from a scheduled send that could NOT be kept, or `null`. Quoted
   * verbatim (the webapp Drafts row's treatment) — a refusal the reader can act on is worth
   * more than a sentence of ours that generalises it away.
   */
  failure: string | null;
  /**
   * Is there still an appointment to take off — `true` for a standing one, `false` for a row
   * whose send already failed and closed back to a draft. A Cancel on the second would be a
   * control for an act with nothing to act on.
   */
  cancellable: boolean;
}

/**
 * THE SCHEDULED SENDS — the shared selector's list (`scheduledSendsList`, soonest first),
 * mapped to rows. Read off the RAW mirror like {@link liveTags}: a draft is not presented mail
 * and never passes through the consent cutline.
 *
 * `when` is `null` for a row whose `sendAt` the mirror does not carry — an older server
 * mid-claim, or a row from before the field. The selector deliberately still LISTS such a row
 * (hiding a scheduled send because its time is unknown suppresses exactly the row the reader
 * most needs), and this surface says the honest "time unknown" rather than inventing one.
 */
export function liveScheduled(reader: EntityReader, v: WorldView): WorldScheduled[] {
  /**
   * A kept appointment that could not be sent is no longer `scheduled`, and this surface is the
   * only place on the phone that can say so. `runScheduledSendPass` closes such a row back to a
   * `draft` carrying the server's sentence in `sendError`; the shared selector lists `scheduled`
   * rows alone — correct for the webapp, where the row falls into Drafts underneath. This app
   * Drafts screen lists it too ({@link liveDrafts}), and it belongs on BOTH: filtered here the
   * message would vanish from the only screen that ever named its appointment, and "it
   * disappeared" reads as "it was sent". So failed rows are listed beside standing ones, marked
   * by `when: null` + a `failure` sentence, and sort last (no appointment, no time to order by).
   */
  const failed = reader.list<EngineDraft>("draft")
    .filter((d) => d.status === "draft" && (d.sendError ?? "") !== "")
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  return [...scheduledSendsList(reader), ...failed].map((d) => ({
    id: d.id,
    when: d.status === "scheduled" && d.sendAt ? scheduleLabel(d.sendAt, v.now, v.zone) : null,
    subject: d.subject.trim() === "" ? Copy.scheduledNoSubject : d.subject,
    to: d.to.map((a) => a.name ?? a.address).join(", "),
    /* A row whose text this mirror never received previews as nothing — see `EngineDraft.body`.
       The subject and recipients above still identify it, and inventing a preview from a body
       nobody sent would be the list asserting the draft is empty. */
    preview: (d.body ?? "").replace(/\s+/g, " ").trim().slice(0, 140),
    failure: d.sendError ?? null,
    /** A standing appointment can be cancelled; a failed one has nothing left to cancel. */
    cancellable: d.status === "scheduled",
  }));
}

/**
 * WHAT STATE A DRAFT ROW IS IN, as the phone's Drafts surface has to treat it — three, not one.
 *
 * `open` is an ordinary unsent message. `held` is a send whose verdict never came (`unverified`)
 * and `interrupted` is one still calling itself `sending` past every possible invocation
 * lifetime: both hold the only copy of a message that may never have been delivered.
 */
export type WorldDraftState = "open" | "held" | "interrupted";

/**
 * WHAT IS KNOWN ABOUT A HELD SEND — the webapp `DraftsView`'s `heldSentence`, one reading. The
 * server looks in Sent for `HELD_SEND_RECHECK_MS` after the row was left `unverified` (nothing
 * touches `updatedAt` while it waits): inside that window it is `checking`, past it `notInSent`.
 * An unparseable stamp reads as past the window, the sentence that claims less.
 */
export type DraftHeldSays = "checking" | "notInSent" | "interrupted";

/**
 * ONE DRAFT, as the phone's Drafts screen renders it — `WorldScheduled`'s charter exactly: the
 * screens stay logic-free, so the stamp arrives read in the reader's clock and the held state
 * arrives named.
 */
export interface WorldDraft {
  id: string;
  /** The subject, or the empty-subject stand-in the mail lists already use. */
  subject: string;
  /** To, Cc and Bcc as one readable line, or the empty string for a draft with no recipient yet. */
  to: string;
  /** The first line or so of the body — enough to tell two drafts apart. */
  preview: string;
  /** "Fri 09:00" / "12 Sep" in the reader's zone: when this row was last written. */
  when: string;
  state: WorldDraftState;
  /** What the row says about a held send ({@link DraftHeldSays}); `null` for an open draft. */
  heldSays: DraftHeldSays | null;
  /**
   * Does THIS mirror hold the draft's text ({@link draftBodyKnown})? `false` is a row that
   * arrived without a body, and the reader is told that rather than shown an empty message — the
   * one distinction a recovery surface may not collapse.
   */
  bodyKnown: boolean;
  /** The text, for the detail screen to render and a reader to copy out of. Empty where unknown. */
  body: string;
  /** Does this draft answer a message THIS mirror holds — the one thing an id cannot say. */
  repliesHere: boolean;
  /** The message it answers, where {@link repliesHere}; `null` otherwise. */
  inReplyToMessageId: string | null;
  /**
   * The server's own sentence from a scheduled send that could not be kept, or `null` — quoted
   * verbatim, `WorldScheduled.failure`'s treatment and for its reason.
   */
  failure: string | null;
  /** What the phone's composer opens this draft with ({@link draftEditOf}); `null` where it cannot. */
  edit: WorldDraftEdit | null;
}

/** An open draft the phone's composer can take whole: the row it writes into and what it seeds. */
export interface WorldDraftEdit {
  mailboxId: string;
  /** To, as the composer's field types it: `Name <address>` entries, comma-separated. */
  to: string;
  /** A new mail's copies, typed the same way; empty where it has none. */
  cc: string;
  bcc: string;
  /** The subject of record, empty where none — never the list's stand-in. */
  subject: string;
  /** The message a forward draft forwards; `null` for every other draft. */
  forwardOf: string | null;
}

/**
 * WHICH DRAFTS THE PHONE EDITS: a plain `draft` whose text this mirror holds, with no markup, and
 * copies only on a new mail (the composer shows Cc and Bcc there). A save or a send writes the row
 * whole, so opening any other draft here would drop part of it without a word.
 */
export function draftEditOf(d: EngineDraft): WorldDraftEdit | null {
  const markup = (d as { html?: unknown }).html;
  const copies = d.cc.length > 0 || d.bcc.length > 0;
  if (d.status !== "draft" || !draftBodyKnown(d)) return null;
  if (copies && (d.inReplyToMessageId !== null || (d.forwardOfMessageId ?? null) !== null)) return null;
  if (typeof markup === "string" && markup !== "") return null;
  if (typeof d.mailboxId !== "string" || d.mailboxId === "") return null;
  const typed = (list: readonly EmailAddress[]) => list.map((a) => {
    const name = a.name?.trim() ?? "";
    if (name === "" || name.includes('"')) return a.address;
    return /[,;<>@]/.test(name) ? `"${name}" <${a.address}>` : `${name} <${a.address}>`;
  }).join(", ");
  return {
    mailboxId: d.mailboxId, to: typed(d.to), cc: typed(d.cc), bcc: typed(d.bcc), subject: d.subject,
    forwardOf: d.forwardOfMessageId ?? null,
  };
}

/**
 * THE DRAFTS — the shared selector's list (`draftsList`: open drafts, held sends and stale
 * `sending` rows, most recently touched first), mapped to rows. Read off the RAW mirror like
 * {@link liveScheduled}: a draft is not presented mail and never passes through the consent
 * cutline.
 *
 * A FAILED APPOINTMENT IS ON TWO SCREENS, deliberately: listed here by the shared selector AND
 * on Scheduled, which absorbs it ({@link liveScheduled}'s own note). Both sentences are true, and
 * suppressing it on either would hide it from whoever came looking on that one.
 */
export function liveDrafts(reader: EntityReader, v: WorldView): WorldDraft[] {
  const staleBefore = v.now.getTime() - SENDING_STALE_AFTER_MS;
  return draftsList(reader, v.now).map((d) => {
    const parent = d.inReplyToMessageId;
    /* THE ROW'S OWN READING OF "can this device open what it answers" — the webapp asks its shell
       the same question (`repliesHere`) and for the same reason: the answer changes what the row
       SAYS, not only what a press does, and promising a conversation this mirror does not hold is
       worse than offering nothing. */
    const repliesHere = parent !== null && reader.get<EngineMessage>("message", parent) !== undefined;
    const leftAt = Date.parse(d.updatedAt);
    const state: WorldDraftState = d.status === "unverified"
      ? "held"
      : d.status === "sending" && (d.updatedAt ? Date.parse(d.updatedAt) : 0) < staleBefore
        ? "interrupted"
        : "open";
    return {
      id: d.id,
      subject: d.subject.trim() === "" ? Copy.scheduledNoSubject : d.subject,
      to: [...d.to, ...d.cc, ...d.bcc].map((a) => a.name ?? a.address).join(", "),
      preview: (d.body ?? "").replace(/\s+/g, " ").trim().slice(0, 140),
      when: messageDisplayTime({ date: d.updatedAt }, v.now, v.zone, v.locale ?? "en"),
      state,
      heldSays: state === "interrupted"
        ? "interrupted"
        : state === "held"
          ? (Number.isFinite(leftAt) && v.now.getTime() - leftAt < HELD_SEND_RECHECK_MS ? "checking" : "notInSent")
          : null,
      bodyKnown: draftBodyKnown(d),
      body: d.body ?? "",
      repliesHere,
      inReplyToMessageId: repliesHere ? parent : null,
      failure: d.sendError ?? null,
      edit: draftEditOf(d),
    };
  });
}

/**
 * THE MAILBOX'S OWN FOLDERS — `folder` entities off `/sync` (FOLDERS-SPEC.md §4), present in
 * the mirror only while the account's "Use folders" flag is on, and gated AGAIN on the consent
 * answer by the caller (the webapp shell's own double gate: the flag is the authority, the
 * entities are data — a mirror still holding entities after a disable renders none).
 */
export function liveFolders(reader: EntityReader): FolderEntity[] {
  return reader.list<FolderEntity>("folder");
}

/**
 * Per-folder unread over the PROJECTED mirror, keyed `mailboxId|name` — the webapp shell's
 * `folderUnreadCounts` feed (one pass, no stored counts; spec §4). Here rather than in the
 * world layer because reading the engine's message rows is this module's licence
 * (`test/privacy.test.ts` ENGINE_IMPORTERS), and `folders.ts` stays structural.
 */
export function liveFolderUnread(pres: EntityReader): Map<string, number> {
  return folderUnreadCounts(pres.list<EngineMessage>("message"));
}

/**
 * THE ONE MAILBOX THE MIRROR'S MAIL NAMES, or `null` — what lets a fresh account with ZERO
 * folder entities still offer its first `+ New folder` (a create must name WHICH mailbox; the
 * webapp grows the section from its `GET /mailboxes` facts, which this phone does not read).
 * Exactly one distinct `mailboxId` across the raw mirror's messages is an unambiguous answer;
 * none or several is `null`, and the affordance waits for a mailbox read — offered from one,
 * withheld at ambiguity, the same honest degradation `NO_OWN_ADDRESSES` documents.
 */
export function soleMessageMailbox(reader: EntityReader): string | null {
  let found: string | null = null;
  for (const m of reader.list<EngineMessage>("message")) {
    if (found === null) found = m.mailboxId;
    else if (found !== m.mailboxId) return null;
  }
  return found;
}

/**
 * ONE FOLDER'S MAIL, as the folder screen renders it — the webapp shell's `folderMessages`
 * derivation verbatim in intent: the PRESENTED mirror filtered on `(mailboxId, name)` (the
 * §16.5 lens keeps a folder-filed row placed at its folder when the caller's view carries
 * `foldersEnabled`), newest first, then flattened unread-before-read exactly as
 * `FolderView.tsx` orders its window. `unread` counts the fresh half so the screen's meta and
 * its group sizes cannot disagree.
 */
export function liveFolder(
  pres: EntityReader,
  folder: FolderEntity,
  v: WorldView,
): { fresh: WorldMail[]; seen: WorldMail[]; unread: number; total: number } {
  const rows = pres
    .list<EngineMessage>("message")
    .filter((m) => m.mailboxId === folder.mailboxId && m.folder === (folder.name as Folder))
    .sort((a, b) => {
      const at = a.date ? new Date(a.date).getTime() : 0;
      const bt = b.date ? new Date(b.date).getTime() : 0;
      return bt - at || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
    });
  const fresh = rows.filter((m) => m.unread).map((m) => toListRow(pres, m, v));
  const seen = rows.filter((m) => !m.unread).map((m) => toListRow(pres, m, v));
  return { fresh, seen, unread: fresh.length, total: rows.length };
}

/* ──────────────────────────────────────────────────────────── the surfaces */

export interface WorldOhbox {
  resurfaced: WorldMail[];
  fresh: WorldMail[];
  seen: WorldMail[];
  /** The mailbox's own unread among the presented rows — exactly what mark-all-read flips. */
  unreadIds: string[];
  unread: number;
  total: number;
}

/**
 * The Ohbox — the engine's rows (`ohboxRows`) over the projection, reshaped and nothing more.
 * `openHeld` is the row the reader is on (`OhmailEngine.holdOpenRow`, held by `openMessage`): it
 * keeps its conversation in New until it is left or answered.
 */
const ohboxRowMemo = new WeakMap<EngineMessage, {
  mail: WorldMail; face: WorldMail; subject: string; unread: boolean; newSince: number; members: string; key: string; row: WorldMail;
}>();

export function liveOhbox(pres: EntityReader, v: WorldView, openHeld: string | null = null): WorldOhbox {
  const box = ohboxView(pres, openHeld);
  /**
   * ONE ROW PER CONVERSATION ACROSS THE SECTIONS — the fold the web app draws. The row's id, verbs
   * and open are its open target's (the latest unread member, or a resurfaced row's focus); its
   * sender, snippet and time are its face's, and a conversation wears its stored name. Read state
   * and the counts below stay per message.
   */
  const rows = ohboxRows(pres, openHeld);
  const toRow = (r: OhboxRow): WorldMail => {
    const mail = toListRow(pres, r.openTarget, v);
    const face = r.face === r.openTarget ? mail : toListRow(pres, r.face, v);
    const subject = r.members.length > 1 ? threadSubject(pres, r.key) ?? face.subject : face.subject;
    const unread = r.members.some(presentsUnread);
    const newSince = r.resurfaced && r.resurfaced.newSince > 0 ? r.resurfaced.newSince : 0;
    const members = r.members.map((m) => m.id).join("\n");
    /* THE SAME ROW OBJECT while nothing it shows moved — see {@link toListRow}. */
    const hit = ohboxRowMemo.get(r.openTarget);
    if (hit !== undefined && hit.mail === mail && hit.face === face && hit.subject === subject
      && hit.unread === unread && hit.newSince === newSince && hit.members === members && hit.key === r.key) return hit.row;
    const { sentTo: _openTargetFace, ...open } = mail;
    const row: WorldMail = {
      ...open,
      /* The FACE's sender, and its own-sent face with it: a conversation answered last is faced
         by the reply, which is "Me → them". */
      from: face.from, ...(face.sentTo !== undefined ? { sentTo: face.sentTo } : {}),
      snippet: face.snippet, time: face.time, subject,
      unread,
      rowKey: r.key,
      memberIds: r.members.map((m) => m.id),
      ...(newSince > 0 ? { newSince } : {}),
    };
    ohboxRowMemo.set(r.openTarget, { mail, face, subject, unread, newSince, members, key: r.key, row });
    return row;
  };
  const resurfaced = rows.resurfaced.map(toRow);
  const fresh = rows.new.map(toRow);
  const seen = rows.earlier.map(toRow);
  /* THE COUNT IS ABOUT THE MAILBOX; THE BOLD IS ABOUT THE PIN. The rows above have been
     through `toMail`, whose `unread` is `presentsUnread` and therefore true for every pin —
     counting THEM would say "1 unread" over a message the mail server calls read. So the set
     is built from the engine's own facts: new-for-you rows plus every unread MEMBER of every
     pinned conversation (folding five unread replies into one row does not make them one
     message). Mark-all-read flips exactly these ids, and `unread` is this list's length, so
     the number a person presses on and the ids the press dispatches cannot disagree. */
  const unreadIds = [
    // The held open row stands in New and is read: the count follows the read, not the place.
    ...box.newForYou.filter((m) => m.unread).map((m) => m.id),
    ...rows.resurfaced.flatMap((r) => r.members.filter((m) => m.unread).map((m) => m.id)),
  ];
  // MESSAGES, like the web's meta and the copy ("{n} messages"): a row can stand for several.
  const total = [...rows.resurfaced, ...rows.new, ...rows.earlier]
    .reduce((n, r) => n + r.members.length, 0);
  return { resurfaced, fresh, seen, unreadIds, unread: unreadIds.length, total };
}

/** The Ohbox's offer: mail from senders nobody decided about, still in the Inbox on the server. */
export interface WorldUnscreened {
  /** Messages across every shown group — the server's own count. */
  total: number;
  /** Who wrote them, largest group first: what the press screens. */
  senders: readonly string[];
}

/**
 * THE WEB'S UNDECIDED-SENDER OFFER, off the store's answer (`GET /screener/unscreened`) that the
 * engine keeps in the mirror. `null` with nothing to offer or a door that has not answered: the
 * offer is absent either way, never "nothing undecided".
 */
export function liveUnscreened(reader: EntityReader): WorldUnscreened | null {
  const groups = unscreenedGroups(reader);
  const total = unscreenedTotalOf(reader);
  return total > 0 && groups.length > 0 ? { total, senders: groups.map((g) => g.id) } : null;
}

export interface WorldReads {
  items: WorldMail[];
  /** The waterline renders directly ABOVE this id — the anchor itself sits below the line. */
  waterlineAboveId: string | null;
  /** The stream's own `\Seen` unread — exactly what mark-all-read flips (pins never force it). */
  unreadIds: string[];
  newCount: number;
}

export function liveReads(pres: EntityReader, v: WorldView): WorldReads {
  const p = readsPartition(pres);
  const all = [...p.fresh, ...p.seen];
  const items = all.map((m) => toListRow(pres, m, v));
  return {
    items,
    waterlineAboveId: p.seen[0]?.id ?? null,
    // The engine rows' own flag, not the mapped rows': `toMail` presents a pinned row unread.
    unreadIds: all.filter((m) => m.unread).map((m) => m.id),
    // The SELECTOR's count, not a second one computed here. This used to be
    // `items.filter(unread)` — every unread row in the stream, above the line or below it —
    // while the shell's rail counted `fresh.length`; one badge, two derivations, two numbers.
    // See `FeedPartition.newCount`.
    newCount: p.newCount,
  };
}

export interface WorldReceipts {
  groups: { label: string; items: WorldMail[] }[];
  /**
   * The Receipts stream's OWN waterline anchor — the line renders directly above this row.
   * `feedPartition` walks the same date order the day-flatten preserves, so the anchor is a
   * junction into the grouped list, never a parallel ordering (the selector's own contract).
   * Without this the leave-commit wrote a line nothing ever rendered.
   */
  waterlineAboveId: string | null;
  newCount: number;
  total: number;
}

export function liveReceipts(pres: EntityReader, v: WorldView): WorldReceipts {
  // The phone's own word for today: Hermes has no Intl.RelativeTimeFormat to answer it.
  const groups = receiptsByDay(pres, v.now, v.locale ?? "en", v.zone, { today: Copy.today }).map((g) => ({
    label: g.label,
    items: g.items.map((m) => toListRow(pres, m, v)),
  }));
  const all = groups.flatMap((g) => g.items);
  // ONE partition read, for both facts it carries: the anchor the line renders above, and the
  // badge (`FeedPartition.newCount` — the shell's rail reads the same field, so the phone and
  // the browser cannot report different numbers for the same stream).
  const part = feedPartition(pres, "receipts");
  return {
    groups,
    waterlineAboveId: part.seen[0]?.id ?? null,
    newCount: part.newCount,
    total: all.length,
  };
}

/**
 * One held message on the sender screen — the row shape plus the body's HONEST state.
 * A derived row's held bodies start as snippets and hydrate; a consent decision taken
 * on a truncation is the risk the Screener exists to remove, so the preview has to say
 * which of the states it is in (`screenerSegments` carries it; dropping it here made every
 * first-contact decision a decision over one line).
 */
export type ScreenerHeld = Held & { bodyState?: BodyState; bodyWithheld?: WithheldMarker };

export interface ScreenerRow {
  /**
   * The REPRESENTATIVE MESSAGE id — what a gate-physical decide dispatches on. UNSTABLE by
   * construction on live rows: a newer message from the sender re-mints the row on a new
   * rep. Never route or key view state by it; that is {@link ScreenerRow.routeKey}'s job.
   */
  id: string;
  /**
   * The STABLE identity a screen may navigate and keep state by: the sender key (the
   * case-folded address). A detail screen looked up by `id` said "no longer in the
   * Screener" the moment a drain landed newer mail from the very sender on screen.
   */
  routeKey: string;
  name: string;
  address: string;
  initial: string;
  time: string;
  newestSubject: string;
  dull: boolean;
  scope: Scope;
  ai: { dest: Destination; confidence: number; rationale: string } | null;
  /**
   * THE IDENTITY FACT, the mirror selector's aggregate over the very bag this row lists
   * (`ScreenerSenderDTO.checked`): a held message names `brand` from an address `brand` does not
   * send from. Rendered as its own line, before and apart from the AI advice.
   */
  checked?: { brand: string; domainShared: boolean; domain: string };
  /** An allow rule for everyone at this sender's shared provider names them and admits nobody. */
  inertRule?: { domain: string };
  /** Every held message, oldest first — all of it, always, never a collapsed count. */
  held: ScreenerHeld[];
  /** screened rows only. */
  screenedOn: string;
  /** spam rows only; empty hides the badge (a derived row has no detection metadata). */
  detection: string;
  /**
   * Is the representative message PHYSICALLY at the gate? A `false` row's mail is only
   * PRESENTED here by the consent cutline, and a decide on it would 404 — the commit routes
   * it past the gate as a rule instead (see {@link LiveWorldActions.decide}).
   */
  gatePhysical: boolean;
}

export interface WorldScreener {
  waiting: ScreenerRow[];
  screened: ScreenerRow[];
  spam: ScreenerRow[];
  /**
   * WHERE THE WAITING LIST CAME FROM — `"server"` when `GET /screener` answered this session,
   * `"device"` when this phone had to work it out for itself (the standalone door, an unread
   * route, a refusal). Only the waiting shelf has two sources; the other two are the mirror's
   * alone. The surface states `"device"` rather than passing a count off as the mailbox's.
   */
  source: "server" | "device";
  /**
   * IS THIS SHELF WITHHELD? True only where the waiting list is this phone's own derivation AND
   * the account's cutline answer has not landed ({@link ScreeningPosture} `unanswered`). The
   * shelf is then EMPTY and the screen says so in words; the count line is silenced with it,
   * because a "0" beside a shelf nobody has worked out yet is an invented number.
   */
  waitingPending: boolean;
}

const AI_DESTS = new Set<string>(["ohbox", "reads", "receipts", "screened", "spam"]);

/**
 * A DTO's advice as the row's badge fact — ONE reading for both row builders. A `noAnswer` and a
 * `hold` render sentences, not a destination badge, so both map to null here; `AI_DESTS` keeps an
 * unknown destination from a newer server off the badge.
 */
function aiOfDto(ai: ScreenerSenderDTO["ai"]): ScreenerRow["ai"] {
  return ai && !ai.noAnswer && AI_DESTS.has(ai.dest)
    ? { dest: ai.dest as Destination, confidence: ai.confidence, rationale: ai.rationale }
    : null;
}

function rowOf(dto: ScreenerSenderDTO, scope: Scope | undefined): ScreenerRow {
  const held: ScreenerHeld[] = dto.held.map((h) => ({
    id: h.id,
    subject: h.subject,
    time: h.time,
    body: h.body,
    // The body's honest state travels with the text — absent means `full`, exactly the
    // DTO's own contract.
    ...(h.bodyState ? { bodyState: h.bodyState } : {}),
    ...(h.bodyWithheld ? { bodyWithheld: h.bodyWithheld } : {}),
    ...(h.trackerNote ? { trackerNote: h.trackerNote } : {}),
    seen: false,
  }));
  const ai = aiOfDto(dto.ai);
  return {
    id: dto.id,
    routeKey: senderKey(dto.from.address),
    name: dto.from.name || dto.from.address,
    address: dto.from.address,
    initial: dto.initial,
    time: dto.time,
    newestSubject: held[held.length - 1]?.subject ?? "",
    dull: dto.dull === true,
    scope: scope ?? dto.scope,
    ai,
    ...(dto.checked ? { checked: { brand: dto.checked.brand, domainShared: dto.checked.domainShared, domain: dto.checked.domain } } : {}),
    ...(dto.inertRule ? { inertRule: { domain: dto.inertRule.domain } } : {}),
    held,
    screenedOn: dto.screenedOn ?? "",
    detection: "",
    gatePhysical: dto.gatePhysical !== false,
  };
}

/**
 * A reader in which the server's waiting senders are at the gate. `screenerSegments` groups over
 * the PROJECTION, which re-homes a DENY-ruled sender's gate mail to the shelf
 * (`consent-cutline.ts`) — right for the lists, wrong for this queue: the mail is still physically
 * in `ohmail/Screener` and the server still asks about that sender, so the phone was answering a
 * question the server had not asked. So for the queue alone, a message whose PHYSICAL folder is the
 * gate and whose sender the route names is read at the gate. Nothing else moves — the same
 * projection still feeds the Ohbox, the piles and the folders, so only which senders the Screener
 * asks about changes.
 */
function gateReader(pres: EntityReader, waiting: ReadonlySet<string>): EntityReader {
  const atGate = (m: EngineMessage): EngineMessage => {
    const physical = physicalFolderOf(m);
    if (physical !== FOLDER_OF_VIEW.screener || m.folder === physical) return m;
    return waiting.has(senderKey(m.from.address)) ? { ...m, folder: physical as Folder } : m;
  };
  return {
    version: () => pres.version(),
    stampOf: (type) => pres.stampOf(type),
    stampExcept: (ignore) => pres.stampExcept(ignore),
    get<T = unknown>(type: string, id: string): T | undefined {
      const v = pres.get<T>(type, id);
      if (type !== "message" || v === undefined) return v;
      return atGate(v as unknown as EngineMessage) as unknown as T;
    },
    list<T = unknown>(type: string): T[] {
      const rows = pres.list<T>(type);
      return type === "message"
        ? rows.map((r) => atGate(r as unknown as EngineMessage) as unknown as T)
        : rows;
    },
    entries<T = unknown>(type: string): Array<{ id: string; entity: T; seq: number }> {
      const rows = pres.entries<T>(type);
      return type === "message"
        ? rows.map((r) => ({ id: r.id, seq: r.seq, entity: atGate(r.entity as unknown as EngineMessage) as unknown as T }))
        : rows;
    },
  };
}

/**
 * The three shelves — `screenerSegments` over the projection (the queue the webapp renders),
 * reshaped. `scopes` carries the reader's per-sender scope choice (this sender / whole domain),
 * view state rather than a mirror fact, keyed by the STABLE {@link ScreenerRow.routeKey}. On a
 * paired door the waiting shelf is the server's set exactly: `server` is `GET /screener`'s answer
 * ({@link readScreenerWaiting}), one row per sender it names, in its order — the mirror supplies
 * each row's held mail. `null` is "nobody answered": the standalone door, or a paired read not
 * landed; the derived list then stands and {@link WorldScreener.source} says so — unless the
 * CUTLINE answer is in flight too, when it is withheld ({@link WorldScreener.waitingPending}).
 */
export function liveScreener(
  pres: EntityReader, v: WorldView, scopes: Readonly<Record<string, Scope>> = {},
  server: readonly ServerWaitingSender[] | null = null,
): WorldScreener {
  const waitingKeys = new Set((server ?? []).map((s) => senderKey(s.address)));
  // `v.ownAddresses` rides in for the reason it rides into `presentedWorld`: the queue asks the
  // partition's own predicate, so a self-addressed message is never a waiting row here — the
  // projection presents one held at the gate in the INBOX.
  const queueReader = server === null ? pres : gateReader(pres, waitingKeys);
  const segments = screenerSegments(queueReader, v.now, v.locale ?? "en", v.zone, v.ownAddresses);
  const map = (rows: ScreenerSenderDTO[]) =>
    rows.map((dto) => rowOf(dto, scopes[senderKey(dto.from.address)]));
  if (server === null && segments.source === "store" && segments.waitingCursor === null) {
    // The engine's copy of the store's page IS the whole queue: the store's set, not a derivation.
    return {
      waiting: map(segments.waiting), screened: map(segments.screenedOut), spam: map(segments.spam),
      source: "server", waitingPending: false,
    };
  }
  if (server === null) {
    /* THE ANSWER IS NOT IN, SO THIS SHELF IS UNKNOWN — not wide. Without an answer the partition
       runs at `all_time` (`presentedWorld`), which retires nobody: every undecided sender queues
       here, which is a SUPERSET of what the account's own window will admit. Painting it put mail
       on the first screen that vanished a moment later. Empty plus the screen's marker instead,
       so membership can only grow. Only the DERIVED shelf: the route's set is the account's own
       cutline already, and the two shelves below are decided by rules, not by the window. */
    const pending = postureOf(v).state === "unanswered";
    return {
      waiting: pending ? [] : map(segments.waiting),
      screened: map(segments.screenedOut),
      spam: map(segments.spam),
      source: "device",
      waitingPending: pending,
    };
  }
  /* THE ROUTE'S SET, IN THE ROUTE'S ORDER — a join, never a union. The derived rows are matched
     in by sender key for their held mail; a derived sender the route does not name is dropped
     (decided on another door, or outside the server's own cutline), and a named sender the
     mirror cannot back is minted. So the count on screen is the number the route answered, and
     the two ends cannot disagree about who is waiting. */
  // The shared selector's join: the mirror's row where it presents the sender's held mail, a row
  // minted from the route's own words where the windowed mirror cannot back them.
  const waiting = screenerRowsOfStore(
    queueReader, server.map((s, order) => ({
      id: `sender:${senderKey(s.address)}`, kind: "sender" as const, order, messageId: s.messageId,
      address: s.address, name: s.name, receivedAt: s.receivedAt, subject: s.subject,
      snippet: s.snippet, mailboxId: null, total: server.length,
    })), v.now, v.locale ?? "en", v.zone, v.ownAddresses,
  ).map((dto) => rowOf(dto, scopes[senderKey(dto.from.address)]));
  return {
    waiting,
    screened: map(segments.screenedOut),
    spam: map(segments.spam),
    source: "server",
    /* Never withheld: `GET /screener` is the account's own cutline, answered by the server that
       holds the setting, so a shelf built from it has nothing outstanding behind it. */
    waitingPending: false,
  };
}

/**
 * ══ THE WAITING SHELF AFTER A DECIDE THE SERVER CONFIRMED ════════════════════════════════════
 * On a paired door the shelf IS the cached `GET /screener` answer ({@link liveScreener}), and
 * nothing moved it at the press: the sender stayed, the count stayed, and the NAME collapsed to
 * the address — the mirror's dto went with the filing, so the join fell through to `rowOfServer`,
 * whose name is `s.name || s.address`. One cause, both symptoms; only a manual sync healed it.
 * This states what the route's next page will hold: it filters DECIDED senders out of every page
 * (`net/screener.ts`), and a `domain` decide decides every sender at that domain, not only the one
 * pressed. `null` (nobody answered) stays `null`: it is not an empty shelf. */
export function waitingAfterDecide(
  server: readonly ServerWaitingSender[] | null,
  decided: { address: string; scope: Scope },
): readonly ServerWaitingSender[] | null {
  if (server === null) return server;
  const match = decided.address.trim().toLowerCase();
  const domain = domainOf(match).toLowerCase();
  /* A domain decide with no domain to match retires nothing rather than everything — the empty
     string is every address's suffix and would empty the shelf on a malformed row. */
  if (decided.scope === "domain" && domain === "") return server;
  return server.filter((s) => {
    const addr = s.address.trim().toLowerCase();
    return decided.scope === "domain"
      ? domainOf(addr).toLowerCase() !== domain
      : senderKey(addr) !== senderKey(match);
  });
}

/**
 * THE SHELF WHILE A PRESS IS IN THE AIR — the cached queue less every sender a decide on a
 * store-backed row is holding off it ({@link LiveDeps.leaveWaiting}), by the rule a landed decide
 * retires them with. A released hold that did not land puts the row back.
 */
export function waitingOnScreen(
  server: readonly ServerWaitingSender[] | null,
  leaving: ReadonlyArray<{ address: string; scope: Scope }>,
): readonly ServerWaitingSender[] | null {
  return leaving.reduce<readonly ServerWaitingSender[] | null>((s, d) => waitingAfterDecide(s, d), server);
}

export interface WorldPile {
  kind: PileKind;
  title: string;
  note: string;
  items: PileItem[];
}

/**
 * The pile blurbs, read from the copy deck at call time. A const held its own copies of the
 * titles and agreed with the deck in English — until a translated deck existed, at which point
 * the More screen followed it and the Piles screen did not, with no test able to see it. A
 * function, not a const: a module-level const would capture whatever the deck said at first
 * import — the same defect with a longer fuse. Reading inside the call means the row carries
 * what the deck says at the moment it is built. The `switch` is exhaustive over `PileKind`; a
 * new pile that forgets its wording will not compile.
 */
function pileCopy(kind: PileKind): { title: string; note: string } {
  switch (kind) {
    case "replyLater": return { title: Copy.replyLater, note: Copy.replyLaterNote };
    case "setAside": return { title: Copy.setAside, note: Copy.setAsideNote };
    case "resurface": return { title: Copy.resurface, note: Copy.resurfaceNote };
  }
}

/** The pile kinds, in the order the screen stacks them. */
const PILE_KINDS: readonly PileKind[] = ["replyLater", "setAside", "resurface"];

export function livePiles(pres: EntityReader, v: WorldView): WorldPile[] {
  const piles = triagePiles(pres);
  const toItem = (e: (typeof piles)["replyLater"][number]): PileItem => ({
    id: e.messageId ?? e.title,
    ...(e.messageId ? { messageId: e.messageId } : {}),
    title: e.title,
    ...(e.subtitle ? { subtitle: e.subtitle } : {}),
    ...(e.preview ? { preview: e.preview } : {}),
    ...(e.resurfaceAt
      ? { resurfaceAt: setTimeLabel(e.resurfaceAt, v.now, v.zone, v.locale ?? "en") }
      : {}),
  });
  return PILE_KINDS.map((kind) => ({
    kind,
    ...pileCopy(kind),
    items: piles[kind].map(toItem),
  }));
}

export interface WorldHistory {
  /** Newest first — the partition's own order, never re-sorted here. */
  items: WorldMail[];
  total: number;
  /**
   * IS HISTORY UNKNOWN RATHER THAN EMPTY? True in the `unanswered` posture, where the partition
   * runs at `all_time` and so retires nobody: the list is empty because nothing has been decided
   * yet, not because this mailbox has no old mail. The screen marks it — an empty History under
   * its ordinary empty state would be the product stating a fact it has not read.
   */
  pending: boolean;
}

/**
 * HISTORY — the retired arm of {@link presentedWorld}, as rows.
 *
 * It takes the RAW mirror's reader, not the projection: the projection deletes these messages
 * from its `message` list (that is what makes History a presentation rather than a folder), so a
 * body, a thread or a triage claim read through it would come back empty. Every row is stamped
 * `physicalFolder` before mapping — the webapp shell's own line — so `toMail` reports the server
 * folder as the row's `folder`, and `historyPlace` states it on the row: History shows mail
 * somewhere other than where it lives, and it has to say so.
 */
export function liveHistory(
  raw: EntityReader, history: readonly EngineMessage[], v: WorldView,
): WorldHistory {
  const items = history.map((m) => historyRow(raw, m, v));
  return { items, total: items.length, pending: postureOf(v).state === "unanswered" };
}

/** A History row: the message stamped with its own folder, the stamped copy kept per entity so the row memo hits. */
const historyCopies = new WeakMap<EngineMessage, EngineMessage>();
export function historyRow(raw: EntityReader, m: EngineMessage, v: WorldView): WorldMail {
  let stamped = historyCopies.get(m);
  if (stamped === undefined) {
    stamped = { ...m, physicalFolder: m.folder };
    historyCopies.set(m, stamped);
  }
  const row = toListRow(raw, stamped, v);
  row.historyPlace = physicalFolderOf(stamped);
  return row;
}

/**
 * WHAT A PRESS ON `id`'S OHBOX ROW OPENS — the engine's `rowOpenTarget`, asked over the reader and
 * the held row the Ohbox list itself folds with (`liveOhbox`), so the press and the row cannot
 * disagree. `undefined` for a message the reader does not hold.
 */
export function liveRowOpenTarget(rows: EntityReader, id: string, openHeld: string | null): string | undefined {
  const m = rows.get<EngineMessage>("message", id);
  return m ? rowOpenTarget(rows, m, openHeld).id : undefined;
}

/**
 * The reading view's row: the mirror's message with its body resolved (`bodyOf` — hydrated
 * text once `hydrateBody` lands, honest `bodyState` until then), its conversation as the
 * `earlier` shape (`threadOf`, every member rendered in full), and the attachment
 * strip from the engine's own items — whose nameless-ICS fallback (`invite.ics`) the engine
 * already mints, matching the webapp and the download names.
 */
export function liveMessage(
  engine: OhmailEngine, id: string, v: WorldView,
  /** The projection of the raw mirror under this same view, when the caller already holds it. */
  presented?: PresentedWorld,
): WorldMail | undefined {
  // The view's own folder flag rides into the projection — a folder-filed message opened from
  // the folder screen is otherwise a History drop (`placeOf` null ⇒ `get` answers undefined)
  // and the reader says "no longer here" over mail the list just showed. The CUTLINE answer
  // rides in for exactly the same reason and it is the same failure: a row a list showed under
  // the account's window must open under it too, never under this package's default. A caller
  // that holds that projection hands it in: a reader renders often, the partition is the cost.
  const world = presented ?? presentedWorld(
    engine.read(), v.now, v.foldersEnabled === true, postureOf(v), v.ownAddresses,
  );
  /* A HISTORY ROW OPENS FROM THE RAW MIRROR, the same answer the webapp's reader gives it
     (`AppShell`'s `setReaderFor`, not `openMessage`). The projection has no such message — that
     is History's whole definition — so reading the body and the thread through it would answer
     "no longer here" over mail the list is showing. Same partition, so the two cannot disagree
     about which rows take this arm. */
  const projected = world.reader.get<EngineMessage>("message", id);
  const retired = projected ? undefined : world.history.find((h) => h.id === id);
  const m = projected ?? (retired ? { ...retired, physicalFolder: retired.folder } : undefined);
  if (!m) return offMirrorMail(engine, id, v);
  const pres = projected ? world.reader : engine.read();
  const row = toMail(pres, m, v);
  // The place the reader arrived through, on the row that carries no other honest one: the
  // message screen titles itself History off this, where `place` would say Ohbox.
  if (retired) row.historyPlace = physicalFolderOf(m);
  row.earlier = threadOf(pres, id)
    .filter((member) => member.id !== id)
    .map((member) => {
      // The account's own forward wears where it went, not the account's name — the same face
      // the web panel gives it (`isForwardedByUs`), recipients named as every row names a person.
      const forwardedTo = isForwardedByUs(member)
        ? member.to.map((a) => a.name || a.address).filter((n) => n.length > 0).join(", ")
        : "";
      return {
        id: member.id,
        subject: member.subject,
        time: messageDisplayTime(member, v.now, v.zone, v.locale ?? "en"),
        body: bodyOf(pres, member).text,
        seen: !member.unread,
        ...(isResurfaced(member) ? { resurfaced: true as const } : {}),
        ...(forwardedTo ? { face: Copy.forwardedTo(forwardedTo) } : {}),
        ...filesField(engine, member.id),
      };
    });
  // The reading view's own facts, attached here and not in `toMail`: a list row never pays
  // for a document it will not draw. `EVERY_PART` is a variable on purpose — the engine's
  // option has two spellings (`includeInlineParts` widened from `includeInlineImages`), and a
  // variable, unlike a literal, compiles against either signature, so this call is correct
  // whichever the engine beside it carries.
  const hydrated = bodyOf(pres, m);
  row.html = hydrated.html;
  row.loadedRemoteContent = hydrated.loadedRemoteContent;
  row.inlineImages = engine.inlineImagesOf(id);
  Object.assign(row, filesField(engine, id));
  return row;
}

/** One message's files for a screen that draws them beside a row it holds (the Screener's held mail). */
export const liveFiles = (engine: OhmailEngine, id: string): WorldAttachment[] | undefined =>
  filesField(engine, id).attachments;

/**
 * One message's files, off the engine's own list, as the `attachments` field or nothing. The
 * opened row, the off-mirror row and every conversation member read them here.
 */
function filesField(engine: OhmailEngine, id: string): { attachments?: WorldAttachment[] } {
  const EVERY_PART = { includeInlineImages: true, includeInlineParts: true };
  const atts = engine.attachmentsOf(id, EVERY_PART);
  if (atts.state !== "ready" || atts.items.length === 0) return {};
  // Real files first, the body's own pictures after them — the web strip's partition.
  const items = [...atts.items].sort((a, b) => Number(a.inline) - Number(b.inline));
  return {
    attachments: items.map((item) => ({
      id: item.id,
      filename: item.filename,
      size: sizeLabel(item.sizeBytes),
      inline: item.inline,
      mime: item.mimeType,
      state: item.state,
    })),
  };
}


/* ──────────────────────────────────────────── the store's rows: History, Search */

/**
 * A STORE ROW — a History page's, a Search hit's — as a phone row. The mirror's live row wins
 * where it holds one (read state, tags, triage); a History row states the folder it sits in.
 */
export function storeRowOf(engine: OhmailEngine, m: EngineMessage, v: WorldView, inHistory: boolean): WorldMail {
  const src = engine.read().get<EngineMessage>("message", m.id) ?? m;
  const stamped: EngineMessage = inHistory ? { ...src, physicalFolder: physicalFolderOf(src) } : src;
  const row = toMail(engine.read(), stamped, v);
  if (inHistory) row.historyPlace = physicalFolderOf(stamped);
  return row;
}

export type { EngineMessage as StoreMessage, ServerSearchOpts, ServerSearchOutcome, StoreSearchWalker, StoreTimelineWalker };
/** The one re-ask rule the store reads bind (`store-views.ts`); the web binds the same one. */
export { createSessionReask, type SessionRenewalDoor, type StoreReadSource } from "@ohmail/client-engine";

/** The mirror's rows in the store's reading order — History's first paint. */
export function mirrorNewestFirst(engine: OhmailEngine): EngineMessage[] {
  const at = (m: EngineMessage): number => {
    const t = Date.parse(m.date ?? "");
    return Number.isFinite(t) ? t : Number.NEGATIVE_INFINITY;
  };
  return [...engine.read().list<EngineMessage>("message")]
    .sort((a, b) => at(b) - at(a) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
}

/** History's walker for this engine — the one the browser renders too. */
export function storeWalkerFor(engine: OhmailEngine): StoreTimelineWalker {
  return new StoreTimelineWalker(engine);
}

/** Search's walker for this engine — History's list mechanism, paged by the store's cursor. */
export function storeSearchWalkerFor(engine: OhmailEngine): StoreSearchWalker {
  return new StoreSearchWalker(engine);
}

/**
 * THE ONE ROW THE READER MAY OPEN WITHOUT A MIRROR ROW BEHIND IT — the webapp's
 * `readerOffMirror`: set by the list that opened it, with its body read on open through
 * `engine.readBodyOffMirror` (returned, never written). One entry; the mirror's row wins.
 */
let offMirror: {
  row: EngineMessage;
  body: { state: "loading" | "full" | "failed"; text: string; html: string | null } | null;
  /** The body read in flight or last settled — what a Forward press waits on (`forwardFetch`). */
  read: Promise<void> | null;
} | null = null;
let offMirrorRev = 0;
const offMirrorListeners = new Set<() => void>();
const offMirrorMoved = (): void => {
  offMirrorRev += 1;
  for (const fn of offMirrorListeners) fn();
};
export function openOffMirror(m: EngineMessage): void {
  if (offMirror?.row.id === m.id) return;
  offMirror = { row: m, body: null, read: null };
  offMirrorMoved();
}
export const subscribeOffMirror = (fn: () => void): (() => void) => {
  offMirrorListeners.add(fn);
  return () => offMirrorListeners.delete(fn);
};
export const offMirrorRevision = (): number => offMirrorRev;
/** The reader's off-mirror row when it is this id, else `undefined`. */
const offMirrorRowOf = (id: string): EngineMessage | undefined =>
  offMirror !== null && offMirror.row.id === id ? offMirror.row : undefined;

function offMirrorMail(engine: OhmailEngine, id: string, v: WorldView): WorldMail | undefined {
  if (offMirror === null || offMirror.row.id !== id) return undefined;
  const row = storeRowOf(engine, offMirror.row, v, true);
  const b = offMirror.body;
  if (b !== null) {
    row.bodyState = b.state;
    row.body = b.state === "full" ? b.text : offMirror.row.snippet;
    row.html = b.state === "full" ? b.html : null;
  }
  row.earlier = [];
  Object.assign(row, filesField(engine, id));
  return row;
}

/** The off-mirror row's body, read once per open (a failed read is asked again on the next). */
export function hydrateOffMirror(engine: OhmailEngine, id: string): boolean {
  if (offMirror === null || offMirror.row.id !== id || engine.read().get("message", id) !== undefined) return false;
  const held = offMirror;
  if (held.body !== null && held.body.state !== "failed") return true;
  held.body = { state: "loading", text: "", html: null };
  offMirrorMoved();
  held.read = engine.readBodyOffMirror(id).then((out) => {
    if (offMirror !== held) return;
    held.body = out.state === "ready"
      ? { state: "full", text: out.text, html: out.html }
      : { state: "failed", text: "", html: null };
    offMirrorMoved();
  });
  return true;
}

/**
 * The same read, awaited: joins one in flight, re-asks a failed one, and settles at once over a
 * body already read. `null` where the row is not the reader's off-mirror row. Never rejects.
 */
function offMirrorBodyRead(engine: OhmailEngine, id: string): Promise<void> | null {
  if (!hydrateOffMirror(engine, id)) return null;
  return offMirror?.row.id === id && offMirror.read !== null ? offMirror.read : Promise.resolve();
}

/* ─────────────────────────────────────────────────────────────────── search */

/**
 * Is this query one address? The door the search empty state offers hangs on it, so the rule
 * is the narrow one: a single token carrying an `@` with something on both sides. It admits
 * what a person pastes from a header and refuses anything the token search should answer.
 */
export function addressShaped(query: string): string | null {
  const t = query.trim();
  if (t.includes(" ") || t.includes(",")) return null;
  const at = t.indexOf("@");
  return at > 0 && at < t.length - 1 && !t.includes("@", at + 1) ? t : null;
}

/** One tier of the device answer, as the rows every list here renders. */
export interface WorldSearchAnswer {
  items: WorldMail[];
  /** Typo-tolerant hits, under their own heading — non-empty only when `items` is empty. */
  similar: WorldMail[];
  /** What the answer is an answer OVER — the mirror's message count when the index was built. */
  coverageMessages: number;
  /** A newer index is still building: an empty list is "not yet", never "nothing". */
  indexing: boolean;
}

/** The address view's device half — see {@link SearchIndex.messagesWith} in the engine. */
export interface WorldAddressAnswer {
  items: WorldMail[];
  counts: AddressCounts;
  indexing: boolean;
}

export interface WorldSearch {
  /** The instant device answer — the engine's mirror index, synchronous, no wire. */
  query(q: string, limit?: number): WorldSearchAnswer;
  /** Every message on this device involving one address, by direction, with all three counts. */
  address(addr: string, direction: AddressDirection): WorldAddressAnswer;
  /** Build the index off the keystroke path — called when the search surface opens. */
  warm(): void;
  /** Which index answered — the provider re-derives the world when a build settles. */
  revision: number;
}

/**
 * THE PHONE'S SEARCH FACE — the engine's own instant index (`OhmailEngine.search` /
 * `messagesWith`), projected to the rows every list renders. It reads the MIRROR, so it
 * answers offline; body text is not in the index and `coverageMessages` is what the surface
 * states its answer over. `base` is the same held-delete-hiding reader the lists derive from:
 * a hit whose row left every list at the press must not survive in search for the window.
 */
export function liveSearch(engine: OhmailEngine, base: EntityReader, v: WorldView): WorldSearch {
  const rows = (hits: readonly { message: EngineMessage }[]): WorldMail[] =>
    hits
      .filter((h) => base.get<EngineMessage>("message", h.message.id) !== undefined)
      .map((h) => toListRow(base, h.message, v));
  return {
    query(q, limit) {
      const r = engine.search(q, limit === undefined ? {} : { limit });
      return {
        items: rows(r.items),
        similar: rows(r.similar),
        coverageMessages: r.coverage.messages,
        indexing: r.indexing,
      };
    },
    address(addr, direction) {
      const r = engine.messagesWith(addr, direction);
      return { items: rows(r.items), counts: r.counts, indexing: r.indexing };
    },
    warm: () => void engine.warmSearchIndex(),
    revision: engine.searchIndexRevision(),
  };
}

export function sizeLabel(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes)) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/* ─────────────────────────────────────────────────────────────── mutations */

/**
 * NEWEST FIRST, by the sender's own `Date:` — the order every list on this phone shows, so a
 * slice taken with it is the mail the person is looking at. An undated row sorts last (`""`
 * compares below every stamp), which is where an undated row already renders.
 */
const newestFirst = (a: EngineMessage, b: EngineMessage): number =>
  (b.date ?? "").localeCompare(a.date ?? "");

/**
 * ONE PRESS, SEVERAL WRITES, ONE VERDICT: a refusal outranks a wait, a wait outranks success, so
 * the sentence never claims more than the least of them.
 */
const oneVerdict = (vs: readonly PressVerdict[]): PressVerdict =>
  vs.find((v) => v.kind === "refused") ?? vs.find((v) => v.kind === "queued")
    ?? vs.find((v) => v.kind === "applied") ?? vs[0] ?? { kind: "applied" };

/**
 * Does this rule match this sender, by the same test `core/src/rules.ts#matches` applies —
 * mirrored from `apps/webapp/app/shell/sender-audit.ts#ruleMatchesSender` (the reference).
 * Exact equality on the lower-cased address or its domain; never a suffix test; `header`
 * rules answer false.
 */
function ruleMatchesSender(rule: RuleDTO, address: string): boolean {
  const addr = address.trim().toLowerCase();
  if (rule.kind === "sender") return ruleMatchKey(rule.match) === addr;
  if (rule.kind === "domain") {
    const d = domainOf(addr).toLowerCase();
    return d !== "" && ruleMatchKey(rule.match) === d;
  }
  return false;
}

/**
 * The enabled rules HOLDING this sender in `folder`.
 * Mirrored from `apps/webapp/app/shell/sender-screening.ts#holdingRules` (the reference):
 * plain sender/domain rules only; a subject- or body-termed rule is a narrower claim a
 * release must not silently widen. Which of them a press may rewrite is {@link releaseRules}'.
 */
function holdingRules(reader: EntityReader, address: string, folder: Folder): RuleDTO[] {
  return rulesList(reader).filter(
    (r) =>
      r.enabled &&
      r.destination === canonicalDestination(folder) &&
      (r.subjectContains ?? "").trim() === "" &&
      (r.bodyContains ?? "").trim() === "" &&
      ruleMatchesSender(r, address),
  );
}

/**
 * What a press about ONE sender writes, and it never changes how anyone else is filed.
 * Mirrored from `apps/webapp/app/shell/sender-screening.ts#releaseRules` (the reference): the
 * sender's own holding rules are retargeted; a DOMAIN rule holding them stays and an address
 * rule at `wanted` outranks it by kind; `stands` is a domain rule it cannot outrank (a higher
 * priority), asked of the one order rather than restated.
 */
export type ReleaseRules =
  | { kind: "retarget" | "none"; mutations: EngineMutation[] }
  | { kind: "address" | "stands"; mutations: EngineMutation[]; domain: string };

export function releaseRules(reader: EntityReader, address: string, from: Folder, wanted: Folder): ReleaseRules {
  const holding = holdingRules(reader, address, from);
  const own = holding.filter((r) => r.kind === "sender");
  if (own.length > 0) {
    // One write per key (the web's reason): a PATCH per twin names a row the first one deleted.
    return { kind: "retarget", mutations: oneRowPerKey(own).map((r) => ({ kind: "rule_update", ruleId: r.id, destination: wanted })) };
  }
  const wide = holding.filter((r) => r.kind !== "sender");
  if (wide.length === 0) return { kind: "none", mutations: [] };
  const domain = ruleMatchKey(wide[0]!.match);
  const match = senderKey(address);
  const mine: RuleDTO = { ...wide[0]!, id: "", kind: "sender", match, destination: wanted, priority: 0, provenance: "manual" };
  // THE LOCAL RULES, by construction: the order asked of two rules this press would itself write.
  if (decidedDestination(consentIndex([...wide, mine]), match) !== wanted) {
    return { kind: "stands", mutations: [], domain };
  }
  // Already written (a re-plan, or the mirror behind the press): a second rule would decide nothing new.
  const standing = rulesList(reader).some((r) => r.enabled && r.kind === "sender" && r.destination === wanted
    && (r.subjectContains ?? "").trim() === "" && (r.bodyContains ?? "").trim() === "" && ruleMatchesSender(r, address));
  return {
    kind: "address",
    mutations: standing ? [] : [{ kind: "rule_create", ruleKind: "sender", match, destination: wanted, applyRetro: true }],
    domain,
  };
}

/**
 * THE ROUTING HALF OF A MOVE, RE-READ FROM THE MIRROR — what `held-routing.ts` commits when the
 * window closes, and never a plan replayed from the record. Re-planning is what makes the commit
 * idempotent: once those rules point at the destination they no longer hold the sender at the
 * place the press was made FROM, so a second run writes nothing. `from` is that place, which the
 * destination alone cannot give — this ladder is about the rules holding the mail where it was
 * SHOWN (`move`'s own note).
 */
export function planPhoneRouting(
  reader: EntityReader, intent: RoutingIntent,
): EngineMutation[] {
  const folder = FOLDER_OF_VIEW[intent.dest];
  if (!folder || intent.from === undefined) return [];
  const ruled = releaseRules(reader, intent.address, intent.from as Folder, folder).mutations;
  const rules = (intent as PhoneMoveIntent).retro === true ? [...ruled] : withoutBacklog(ruled);
  /* THE LETTER'S HALF, for a kill between the press's record and the letter's dispatch: a letter the
     press named, still in the folder the press found it in, moves with the rule. A dispatched move
     is in the outbox and the reader already shows the letter at the place, so nothing moves twice.
     A row from before `found` was recorded reads the shown place. */
  const found = foundOf(intent) ?? intent.from;
  const letters = intent.messageIds.flatMap((id): EngineMutation[] => {
    const m = reader.get<EngineMessage>("message", id);
    return m !== undefined && m.folder === found && m.folder !== folder ? [{ kind: "move", messageId: id, folder }] : [];
  });
  return [...rules, ...letters];
}

/**
 * THE PHONE'S MOVE INTENT: the engine's v1 row plus the folder the letter was IN at the press.
 * `from` is where it was SHOWN, which the rule ladder needs; a letter shown in the Screener or
 * Reads can sit in the Inbox, so only `found` says whether it is still where the press left it.
 * `holdsRule: false` marks a press that decides no rule: it shows no held place (`held-routing.ts`).
 */
export type PhoneMoveIntent = RoutingIntent & { found?: string; holdsRule?: false; retro?: true };

function foundOf(intent: RoutingIntent): string | undefined {
  const f = (intent as PhoneMoveIntent).found;
  return typeof f === "string" && f.length > 0 ? f : undefined;
}

/**
 * A MOVE'S RULES LEAVE THE BACKLOG WHERE IT IS — the web's Move (`planMoveToPlace`: sender scope,
 * no retro). The press is about the letter it was made on and the sender's future mail; a PATCH
 * without the flag re-arms the server's pass over everything the rule claims.
 */
function withoutBacklog(writes: readonly EngineMutation[]): EngineMutation[] {
  return writes.map((w) => (w.kind === "rule_update" || w.kind === "rule_create" ? { ...w, applyRetro: false } : w));
}

/**
 * THE WAY BACK FROM A COMMITTED MOVE'S RULES, read before they leave: each retargeted rule PATCHed
 * back to where it filed and at the priority it had, each created rule deleted once the mirror
 * holds it — none of them re-arming a backlog pass, so the way back moves no mail either.
 */
export function routingReversal(read: () => EntityReader, writes: readonly EngineMutation[]): () => EngineMutation[] {
  const prior = new Map(rulesList(read()).map((r) => [r.id, r] as const));
  const back: EngineMutation[] = writes.flatMap((w): EngineMutation[] => {
    const r = w.kind === "rule_update" ? prior.get(w.ruleId) : undefined;
    // An undo, not a press: the rule goes back as it was read, provenance included (the Move's own
    // PATCH made it the person's on the server; an inferred value is put back over that).
    return r ? [{
      kind: "rule_update", ruleId: r.id, destination: storedRuleDestination(r), priority: r.priority, applyRetro: false,
      keepProvenance: true, ...(r.provenance === "manual" ? {} : { restoreProvenance: r.provenance }),
    }] : [];
  });
  const made = writes.filter((w) => w.kind === "rule_create");
  return () => [...back, ...made.flatMap((c): EngineMutation[] => {
    const row = rulesList(read()).find((r) => !prior.has(r.id) && r.kind === c.ruleKind && r.match === c.match
      && canonicalDestination(r.destination) === canonicalDestination(c.destination)
      && (r.subjectContains ?? "").trim() === "" && (r.bodyContains ?? "").trim() === "");
    return row ? [{ kind: "rule_delete", ruleId: row.id }] : [];
  })];
}

/** The sheet step's answer over the rules that disagree, and the forecast it was asked over. */
export interface PhoneScreenPress {
  resolution: PressResolution;
  shown: readonly RuleDTO[];
  forecast: PressForecast;
}

/**
 * WHAT A HELD PRESS COMMITS — a sheet press through the one commit planner, its answers riding
 * the v2 intent; a Move through the phone's own ladder. A v2 row read as a Move would find no
 * `from` and write nothing, the sheet's press lost with its rule.
 */
export function planHeldRouting(
  reader: EntityReader, intent: AnyRoutingIntent, onChanged?: (changed: readonly string[]) => void,
): EngineMutation[] {
  if (intent.v === 3) return planDecideCommit(reader, intent);
  if (intent.v !== 2) return planPhoneRouting(reader, intent);
  const out = planScreenCommit(reader, intent);
  onChanged?.(out.changed);
  return out.writes;
}

/**
 * THE ONE DISPATCH A HELD PRESS COMMITS THROUGH — the world's session and the suites alike. A
 * Move's letter goes under the press id as its Idempotency-Key, and the press's own letter move
 * still QUEUED under that key (a kill before it was answered, restored at this launch) is taken
 * back and sent from here, unless the mirror already has the letter there: the server makes it
 * once and this commit answers for it. `"nothing"`: nothing was left to send.
 */
export async function dispatchHeldRouting(
  engine: OhmailEngine, mutations: readonly EngineMutation[], intent: AnyRoutingIntent,
  hooks: { answered: (answers: readonly (MutationResult | null)[]) => boolean; refused: () => void },
): Promise<boolean | "nothing"> {
  const own = intent.v === 1
    ? engine.pendingMutations().find((p) => p.key === intent.id && p.mutation.kind === "move")?.mutation
    : undefined;
  if (own) await engine.withdrawQueued(intent.id);
  const owed = own?.kind === "move" && !mutations.some((m) => m.kind === "move")
    && engine.read().get<EngineMessage>("message", own.messageId)?.folder !== own.folder;
  const sent = owed ? [...mutations, own] : [...mutations];
  const answers = await Promise.all(sent.map((mu) =>
    engine.mutate(mu, intent.v === 1 && mu.kind === "move" ? { key: intent.id } : {}).catch(() => null)));
  const refused = answers.some((r) => r === null || r?.status === "rolled_back");
  /* Every answer replaced by a newer press for the same thing: that press says the sentence. */
  const silent = answers.length > 0 && answers.every((r) => r?.status === "superseded");
  const made = sent.length === 0 || silent ? "nothing" as const : true;
  if (hooks.answered(answers)) return refused ? false : made;
  if (refused) { hooks.refused(); return false; }
  return made;
}

/** Screen out and Spam are the endpoint's `no`; the three places a sender may write to are `yes`. */
const decisionOf = (dest: ScreenDest): "yes" | "no" => (dest === "screened" || dest === "spam" ? "no" : "yes");

/**
 * WHAT A HELD SCREENER DECISION COMMITS, re-read at the close and never replayed from the record:
 * a representative still held at the gate, or one only the store holds, is decided with
 * `screener_decide`; one past the gate is ruled through the twins ladder with the past-mail answer
 * and moves nothing (THE-CLIENTS-FIFTY). A let-in's "&read" batch rides behind it.
 */
export function planDecideCommit(reader: EntityReader, intent: DecideIntent): EngineMutation[] {
  const rep = reader.get<EngineMessage>("message", intent.seedId);
  const decision = decisionOf(intent.dest);
  const address = intent.address.trim().toLowerCase();
  const out: EngineMutation[] = rep === undefined || physicalFolderOf(rep) === FOLDER_OF_VIEW.screener
    ? [{
      kind: "screener_decide", senderId: intent.seedId, decision, dest: intent.dest,
      ...(decision === "yes" ? { read: intent.read } : {}), scope: intent.scope,
    }]
    : pressOverTwins(
      rulesList(reader), intent.scope, intent.scope === "domain" ? domainOf(address).toLowerCase() : address,
      FOLDER_OF_VIEW[intent.dest], true,
    ).writes;
  if (intent.read && decision === "yes") {
    for (let i = 0; i < intent.messageIds.length; i += MARK_SEEN_CHUNK) {
      out.push({ kind: "mark_seen", messageIds: intent.messageIds.slice(i, i + MARK_SEEN_CHUNK), unread: false });
    }
  }
  return out;
}

/** What a launch says about its replay, and the one line a device run reads it from. */
export function sayRoutingReplay(r: RoutingReplay): Refusal[] {
  const says = routingReplaySay(r);
  logLaunchReplay(r.moved.length, r.refused.length, r.expired.length, says.length);
  return says;
}

/**
 * WHAT A LAUNCH SAYS about the presses a killed session left: the moves it finished, in one
 * sentence naming the place when there was one, and the ones past the horizon it did not make.
 * Nothing for a launch that found none.
 */
export function routingReplaySay(r: RoutingReplay): Refusal[] {
  const out: Refusal[] = [];
  const count = r.moved.reduce((n, i) => n + i.messageIds.length, 0);
  const places = [...new Set(r.moved.map((i) => i.dest))];
  if (count > 0) {
    out.push(places.length === 1
      ? refuse("routingReplayedTo", count, moveTargetLabel(places[0]!))
      : refuse("routingReplayed", count));
  }
  if (r.expired.length > 0) out.push(refuse("routingReplayExpired", r.expired.length));
  return out;
}


/** File lists a reader asks at once for a conversation — the web shell's own bound. */
const THREAD_LIST_CONCURRENCY = 4;


/**
 * How long the LEAVE COMMIT waits for in-flight sweeps before anchoring on the pool as it
 * stands. The leave now also fires on APP BACKGROUND, where the runtime may suspend at any
 * moment — an unbounded await there is a waterline that never dispatches, which loses the
 * whole visit; a bounded one dispatches into the engine's durable outbox while the process
 * is still allowed to run. See `leaveFeed` for the narrow rollback exposure this accepts.
 */
const LEAVE_SETTLE_DEADLINE_MS = 1_500;

/**
 * One watched dispatch, AS A VERDICT — `pressVerdict`'s three answers and never a boolean.
 *
 * This used to answer `status !== "rolled_back"`, which put both waits on the completion side:
 * a verb the SERVER recorded for the install that organizes the mailbox came back through the
 * same door as a verb that happened, and every sentence below said it was done. `queued` on this
 * client's own retry queue is still not a failure — the intent stands under its Idempotency-Key
 * — and that is why the two waits stay apart rather than both reading as a refusal.
 */
function watched(p: Promise<MutationResult>): Promise<PressVerdict> {
  return p.then(pressVerdict, () => PRESS_THREW);
}

/** A Screening press the server refused as being about the account's own address says so. */
function ownAddressOr(vs: readonly PressVerdict[], fallback: Refusal): Refusal {
  return vs.some((v) => v.kind === "refused" && v.refusal?.code === "own_address") ? refuse("liveOwnAddress") : fallback;
}

/**
 * The forward field's entries, parsed — or `null` when ANY entry refuses.
 *
 * Entries are comma/semicolon-delimited (a bare-space split broke `Alice <alice@x.org>` into
 * an "invalid" name and an address). A display-named entry sends the ADDRESS inside its
 * angle brackets, with the name carried on the envelope as typed. `null`, not a narrowed
 * list: one bad entry locks Send, because a send to fewer people than the field names is a
 * wrong delivery nobody is told about. Lives here, not in the sheet, so the node suite can
 * hold it — the screens stay logic-free (this module's own charter).
 */
export function parseRecipients(typed: string): { name: string | null; address: string }[] | null {
  const out: { name: string | null; address: string }[] = [];
  for (const entry of recipientEntries(typed)) {
    const one = recipientOf(entry);
    if (one === null) return null;
    out.push(one);
  }
  return out;
}

/**
 * THE ADDRESSES THAT PARSE, and only those — a draft is still being written, so an entry that
 * does not parse stays unsent rather than refusing the whole keep (the web's draft rule).
 */
export function keptRecipients(typed: string): { name: string | null; address: string }[] {
  return recipientEntries(typed).map(recipientOf).filter((r): r is { name: string | null; address: string } => r !== null);
}

/* Quote-aware split: `"Doe, Alice" <alice@x.org>` is ONE entry — a comma inside double quotes is
   part of the display name, not a delimiter. A naive split refused exactly the shape address
   books paste. */
function recipientEntries(typed: string): string[] {
  const entries: string[] = [];
  let held = "";
  let quoted = false;
  for (const ch of typed) {
    if (ch === '"') quoted = !quoted;
    if ((ch === "," || ch === ";") && !quoted) {
      entries.push(held);
      held = "";
    } else held = held + ch;
  }
  entries.push(held);
  return entries.map((e) => e.trim()).filter((e) => e !== "");
}

function recipientOf(entry: string): { name: string | null; address: string } | null {
  const angled = /^(.*)<([^<>\s]+@[^<>\s]+\.[^<>\s]+)>$/.exec(entry);
  if (angled) {
    const name = angled[1]!.trim().replace(/^"(.*)"$/, "$1");
    return { name: name === "" ? null : name, address: angled[2]! };
  }
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(entry) ? { name: null, address: entry } : null;
}

/**
 * What became of a send: `sent` closes the composer; `failed` re-arms it (the rollback took
 * the queued copy with it, so a re-send cannot double); `queued` LOCKS it — the intent
 * stands on the engine's queue under its key, and a second Send would be a second key.
 * `unverified` ALSO locks it, for the opposite reason: the server could not say whether the
 * message left (`send_unverified` — the 409 whose answer is "check your Sent folder"), so a
 * fresh-key retry is exactly the duplicate delivery the send contract forbids. The composer
 * shows the check-Sent sentence and offers no re-send; Cancel is the way out.
 */
/** `superseded`: this press was replaced on the wire by a newer press under its key, which says the sentence. */
export type SendOutcome = "sent" | "queued" | "failed" | "unverified" | "superseded";

/** One classifier for a send's MutationResult — the composer and the flush ledger agree by construction. */
export function sendOutcomeOfResult(r: MutationResult | null): SendOutcome {
  if (!r) return "failed";
  if (r.status === "confirmed") return "sent";
  if (r.status === "queued") return "queued";
  if (r.status === "superseded") return "superseded";
  return r.error?.code === "send_unverified" ? "unverified" : "failed";
}

/**
 * THE SENTENCE A FAILED SEND EARNS. A session that never secured its connection or had its login
 * refused offered nothing, and says which step stopped it; a mailbox with no sign-in here says so
 * with the file's own sentence; a forward whose original the server could not load says so,
 * because asking again cannot help; every other failure keeps the plain one.
 */
export type FailedSendCopy = "replyNotSecured" | "replyLoginRefused" | "replyUnreachable" | "replyNotSignedIn"
  | "replyForwardOriginalUnavailable" | "replyFailed";

export function failedSendCopy(r: MutationResult | null): FailedSendCopy {
  const code = r?.error?.code;
  return code === "send_not_secured" ? "replyNotSecured"
    : code === "send_login_refused" ? "replyLoginRefused"
      : code === "send_unreachable" ? "replyUnreachable"
        : code === "mailbox_not_signed_in" ? "replyNotSignedIn"
          : code === "forward_original_unavailable" ? "replyForwardOriginalUnavailable"
            : "replyFailed";
}

/** The refused send's sentence as a refusal, each key spelled out so the refusal census reads it. */
export function refusedSendSay(kind: FailedSendCopy | null | undefined): Refusal {
  return kind === "replyNotSecured" ? refuse("replyNotSecured")
    : kind === "replyLoginRefused" ? refuse("replyLoginRefused")
      : kind === "replyUnreachable" ? refuse("replyUnreachable")
        : kind === "replyNotSignedIn" ? refuse("replyNotSignedIn")
          : kind === "replyForwardOriginalUnavailable" ? refuse("replyForwardOriginalUnavailable")
            : refuse("replyFailed");
}

/**
 * THE SERVER HAS THIS SEND: a queued result whose code is the send route's own 202 (`send_queued`),
 * the reservation committed under its key. Every other queued result is the transport's and the
 * request may never have arrived. The web's `phaseFor` makes the same split.
 */
export function sendAccepted(r: MutationResult | null): boolean {
  return r !== null && r.status === "queued" && r.error?.code === "send_queued";
}

/**
 * A send's result: the outcome, plus — for `queued` alone — the Idempotency-Key the queued
 * mutation stands under, so the composer can follow ITS OWN send through later flushes
 * ({@link flushQueued}'s ledger) and settle when the background retry lands or dies.
 */
export interface SendResult {
  outcome: SendOutcome;
  key?: string;
  /**
   * `failed` only: the draft row the refused send left, an ordinary draft again. The composer
   * binds it, so its next press and its keep are that row and never a second copy of one letter.
   */
  draftId?: string;
  /** `failed` only: which sentence the refusal earned, said in the composer ({@link failedSendCopy}). */
  failure?: FailedSendCopy;
  /** `queued` only: the server accepted it ({@link sendAccepted}), so it is still sending, not waiting. */
  accepted?: true;
}

/**
 * WHAT A SEND IS ABOUT — the phone's half of the webapp lane rule (`mail-send.ts#sendKeyOf`).
 *
 * One intent, one Idempotency-Key: a reply and a forward each belong to the message they answer,
 * not to the composer that happened to be on screen. `null` is a send this app cannot name that
 * way, which mints a fresh key rather than guessing a shared one.
 */
export function sendIntentOf(m: EngineMutation): string | null {
  if (m.kind !== "mail_send") return null;
  if (m.forwardOf) return `fwd:${m.forwardOf}`;
  if (m.inReplyTo) return `reply:${m.inReplyTo}`;
  // A bound row is its own intent: a second Send again resumes the first key, never a second one.
  if (m.draftId) return `draft:${m.draftId}`;
  return null;
}

/**
 * DOES THIS PRESS SAY SOMETHING DIFFERENT FROM THE ONE STILL STANDING? Over the fields THIS
 * PRESS STATED, and no others: the queued mutation has been through the engine's enrichment and
 * the press has not, so a blanket comparison reads every derived field as a change and calls an
 * unaltered retry a different message. What that admits is a press DROPPING a field the standing
 * one stated, which reads as unchanged and gets the ordinary sentence — quiet, never false.
 */
export function sendTextDiffers(standing: EngineMutation, pressed: EngineMutation): boolean {
  if (standing.kind !== "mail_send" || pressed.kind !== "mail_send") return false;
  const a = standing, b = pressed;
  const stated: Array<[unknown, unknown]> = [
    [b.body, a.body], [b.html, a.html], [b.subject, a.subject],
    [b.to, a.to], [b.cc, a.cc], [b.bcc, a.bcc],
  ];
  return stated.some(([pressedValue, standingValue]) =>
    pressedValue !== undefined && JSON.stringify(pressedValue) !== JSON.stringify(standingValue));
}

/**
 * WAS THIS CONFIRMATION ABOUT AN EARLIER MESSAGE? Two facts, both the server's: this key was
 * already settled (`firstSend`), and this press's changed words were kept back (`earlierWordsKept`,
 * the resume's save refused over a row a send holds). One without the other is an ordinary send —
 * a plain retry of the same words, or a resume whose newer words landed first.
 */
/** A send still waiting whose newer words were kept back: the send under way carries the earlier ones. */
export function earlierVersionGoing(r: MutationResult | null): boolean {
  return r !== null && r.status === "queued" && (r.error?.details as { earlierWordsKept?: boolean } | undefined)?.earlierWordsKept === true;
}

export function earlierVersionWent(r: MutationResult | null): boolean {
  return r !== null && r.status === "confirmed" && r.earlierWordsKept === true && r.firstSend !== undefined;
}

/** One settled entry of {@link flushQueued}'s ledger: what happened, to which KIND of intent. */
export interface FlushedOutcome {
  status: "confirmed" | "rolled_back" | "unverified";
  kind: EngineMutation["kind"];
  /** mail_send only: whether the intent was a forward — the confirmation sentence differs. */
  forward: boolean;
  /**
   * mail_send only: the APPOINTMENT the queued intent carried (Send later, mail 0077), or
   * `null`. The sentence differs for the same reason `forward` does, and more sharply: an
   * offline Send-later confirmed by a background flush has DELIVERED NOTHING, so announcing it
   * as "Reply sent." would be a false claim about mail that is still sitting on the account
   * waiting for its time. Captured BEFORE the flush like the kind, because the entry is gone
   * from the queue by the time the result is read.
   */
  sendAt: string | null;
  /**
   * mail_send only: this confirmation is about an EARLIER press — see {@link earlierVersionWent}.
   * "Reply sent." over the newer words would name a message nobody sent.
   */
  earlierWent: boolean;
  /** A refused mail_send: the row the refusal left, which the composer binds so a press is that row. */
  draftId?: string;
  /** A refused mail_send: the sentence the refusal earned ({@link failedSendCopy}). */
  failure?: FailedSendCopy;
  /**
   * mail_send only: the Send + Done release this confirmation ran, as the sentence it earned
   * ({@link ReleaseConfirmed}) — said INSTEAD of the ordinary one, one sentence per press.
   */
  done: DoneSaid | null;
}

/**
 * WHAT A LOCKED COMPOSER READS OFF THE LEDGER beside the status: the server accepted the send
 * (still sending, not waiting), or it was refused, leaving this row and earning this sentence.
 */
export interface SendSettlement {
  accepted: boolean;
  draftId: string | null;
  failure: FailedSendCopy | null;
}
export const NO_SETTLEMENT: SendSettlement = { accepted: false, draftId: null, failure: null };

/** What a queued intent was, captured while the queue still holds it — see {@link sendsOffTheQueue}. */
interface QueuedMeta { kind: EngineMutation["kind"]; forward: boolean; sendAt: string | null }

function queuedMetaOf(m: EngineMutation): QueuedMeta {
  return {
    kind: m.kind,
    forward: m.kind === "mail_send" && !!m.forwardOf,
    sendAt: (m.kind === "mail_send" ? m.sendAt : undefined) ?? null,
  };
}

/**
 * SENDS WHOSE ANSWER MAY COME WHEN THE QUEUE NO LONGER HOLDS THEM. A dispatch that outlives the
 * engine's deadline leaves the queue and answers LATE, through a later flush, so a flush that
 * reads kinds off `pendingMutations()` alone called a late refused send a failed save. Keyed by
 * engine, written while the send is known, spent when its terminal answer is read.
 */
const sendsOffTheQueue = new WeakMap<OhmailEngine, Map<string, QueuedMeta>>();

function queuedSendsOf(engine: OhmailEngine): Map<string, QueuedMeta> {
  let known = sendsOffTheQueue.get(engine);
  if (known === undefined) sendsOffTheQueue.set(engine, (known = new Map()));
  return known;
}

/**
 * ANSWERS A PRESS'S OWN FLUSH TOOK FOR OTHER KEYS. `flushPending` hands each answer to exactly one
 * caller, and the press keeps only its own; the rest wait here for the ledger's next flush, each
 * with the Send + Done sentence its release earned there, which the press does not say.
 */
interface StrayAnswer { r: MutationResult; done: DoneSaid | null }
const strayAnswers = new WeakMap<OhmailEngine, StrayAnswer[]>();

function keepStrays(
  engine: OhmailEngine, results: readonly MutationResult[], own: string, done: ReadonlyMap<string, DoneSaid>,
): void {
  const others = results
    .filter((r) => r.key !== own && (r.status !== "queued" || sendAccepted(r)))
    .map((r) => ({ r, done: done.get(r.key) ?? null }));
  if (others.length > 0) strayAnswers.set(engine, [...(strayAnswers.get(engine) ?? []), ...others]);
}

/** Is any answer waiting for a flush — the engine's late ones, or strays a press's flush took? */
export function answersWaiting(engine: OhmailEngine): boolean {
  return engine.hasLateResults() || (strayAnswers.get(engine)?.length ?? 0) > 0;
}

/** Record a send answered `queued`, so its late answer is read as the send it is. */
export function noteQueuedSend(engine: OhmailEngine, r: MutationResult, m: EngineMutation): void {
  if (r.status === "queued" && m.kind === "mail_send") queuedSendsOf(engine).set(r.key, queuedMetaOf(m));
}

/**
 * IS A RECONNECT FLUSH OWED? An answer waiting with no caller always is (`hasLateResults`: a
 * dispatch that outlived its deadline answered after the queue let go of it); otherwise a pending
 * key not yet retried since the last drain. Measured on a phone: a 424 that arrived late was never
 * collected, and the composer said "still trying" for eight minutes.
 */
export function reconnectFlushDue(pendingKeys: readonly string[], tried: ReadonlySet<string>, hasLate: boolean): boolean {
  if (hasLate) return true;
  return pendingKeys.length > 0 && !pendingKeys.every((k) => tried.has(k));
}

/**
 * DRAIN THE RETRY QUEUE, remembering what became of each intent — the reconnect path's one
 * flush, called by the world layer after every successful sync. Terminal outcomes land in
 * the returned map (key → status + the mutation's kind, captured BEFORE the flush so a
 * confirmed background send can be announced as the send it was) so a composer holding a
 * queued key can settle, and the caller can say the one visible sentence for an intent that
 * will never send. `send_unverified` is kept apart from an ordinary rollback: it means
 * "maybe delivered — check Sent", never "try again". Failures that are still retryable
 * re-queue inside the engine and simply stay pending.
 */
export async function flushQueued(
  engine: OhmailEngine,
  /** REQUIRED: a flush that confirms a Send + Done and cannot release it files nothing. */
  release: ReleaseConfirmed,
  /** A send the server says it has (`send_queued`): not terminal, but the composer says so. */
  onAccepted?: (key: string) => void,
  /** A waiting send whose newer words were kept back: the send under way carries the earlier ones. */
  onEarlierGoing?: (key: string) => void,
): Promise<Map<string, FlushedOutcome>> {
  const kinds = new Map(engine.pendingMutations().map((p) => [p.key, queuedMetaOf(p.mutation)]));
  const offQueue = queuedSendsOf(engine);
  for (const [key, meta] of kinds) if (meta.kind === "mail_send") offQueue.set(key, meta);
  const outcomes = new Map<string, FlushedOutcome>();
  const strays = strayAnswers.get(engine) ?? [];
  strayAnswers.delete(engine);
  const results = [...strays.map((x) => x.r), ...await engine.flushPending().catch(() => [])];
  const released = await release(results);
  /* A stray was released by the press's flush, which kept its sentence for this road to say. */
  const done = new Map(released);
  for (const x of strays) if (x.done !== null && !done.has(x.r.key)) done.set(x.r.key, x.done);
  for (const r of results) {
    if (r.status === "queued") {
      if (sendAccepted(r)) onAccepted?.(r.key);
      if (earlierVersionGoing(r)) onEarlierGoing?.(r.key);
      continue;
    }
    // The newer press under this key owns its one sentence.
    if (r.status === "superseded") continue;
    /**
     * A WITHDRAWN INTENT OWES NO SENTENCE. Cancel took this verb off the queue, and the flush
     * that was already carrying it reports the rollback it made of it — "Reply failed." over a
     * send the person themselves cancelled is the wrong sentence, and there is no right one.
     */
    if (r.error?.code === OUTBOX_WITHDRAWN_CODE) { offQueue.delete(r.key); continue; }
    const meta = kinds.get(r.key) ?? offQueue.get(r.key) ?? { kind: "mark_seen" as const, forward: false, sendAt: null };
    offQueue.delete(r.key);
    const status =
      r.status === "confirmed" ? ("confirmed" as const)
        : r.error?.code === "send_unverified" ? ("unverified" as const)
          : ("rolled_back" as const);
    const earlierWent = earlierVersionWent(r);
    const refusedSend = status === "rolled_back" && meta.kind === "mail_send";
    outcomes.set(r.key, {
      status, kind: meta.kind, forward: meta.forward, sendAt: meta.sendAt, earlierWent,
      ...(refusedSend ? { failure: failedSendCopy(r), ...(r.entityId ? { draftId: r.entityId } : {}) } : {}),
      done: done.get(r.key) ?? null,
    });
  }
  return outcomes;
}

/**
 * How long an undo offer stands — the webapp's `UNDO_MS` (`screener-state.ts`), mirrored by
 * value: this app cannot import the webapp, and two windows for one gesture is how "Undo" comes
 * to mean two different promises on two surfaces.
 */
/**
 * HOW A DISCARD ENDED — four, because three of them are not failures. `discarded` is the
 * confirmed delete. `stillSending` is the server's `send_recorded` 409: a send still `pending`
 * holds its draft, and the card says so IN THE ROW (no toast). `queued` is a wire that could not
 * be reached — the row is still there and the request is still owed. `refused` is everything else.
 */
export type DraftDiscardOutcome = "discarded" | "stillSending" | "queued" | "refused";

/**
 * HOW A SEND AGAIN ENDED — `sent`, or why not. Every ending but `sent` and `superseded` (a newer
 * press of the row says it) is said by the card IN THE ROW and by nothing else: `stillRunning` / `notReached` are the resolve's two refusals,
 * `bodyUnknown` is a text this mirror never received, and the last three are the send's own.
 */
export type DraftSendAgainOutcome =
  | "sent" | "superseded" | "stillRunning" | "notReached" | "bodyUnknown" | "queued" | "unverified" | "failed";

/**
 * WHAT A CLOSING COMPOSER HANDS OVER TO BE KEPT — the text on screen and whose message it answers.
 * `messageId` is the parent of a reply or forward (`null` for a new mail); the envelope of a reply
 * is derived here as the send derives it. `files` counts attachments a draft row cannot hold.
 */
export interface DraftKeep {
  mode: "reply" | "replyAll" | "forward" | "new";
  messageId: string | null;
  mailboxId: string | null;
  to: EmailAddress[];
  /** A new mail's copies; absent is none. */
  cc?: EmailAddress[];
  bcc?: EmailAddress[];
  subject: string;
  body: string;
  files: number;
  /** The row this composer is bound to ({@link SendResult.draftId}): the keep updates it in place. */
  draftId?: string | null;
  /** A composer's own save as it goes: the row is written and nothing is said. */
  quiet?: boolean;
}

/** `kept` — the account holds it or the outbox does; `refused` — nothing was kept, and said. */
export type DraftKeepOutcome = "kept" | "refused";

export const UNDO_MS = 8000;

/**
 * The stand-in for `LiveDeps.painted` where no pill exists (the node suite): one TIMER task after
 * a sentence is spoken, before the act is dispatched. A timer rather than `setImmediate`, which is
 * a microtask shim in React Native. Measured on the 18 Pro (FIX-022, 2026-09-21): neither a
 * microtask nor a timer put the pill on screen before the mirror's re-derivation — only the
 * pill's own layout report does, which is why the provider supplies `painted` and this is the
 * fallback. `toast-before-the-mirror-moves.test.ts` holds the order for both.
 */
export const paintFirst = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * What rides beside a toast sentence: an undo the pill offers (bounded, consumed at most once —
 * the callback itself enforces both), and how long the pill holds. Absent members mean what
 * every toast meant before: a sentence, 3.2 s, no verb.
 */
export interface ToastOpts {
  undo?: () => void;
  holdMs?: number;
  /** The pill is on screen and its hold has started — where a held window starts counting too. */
  shown?: () => void;
}

/** The sentence a Send + Done release earned, with the Undo that puts the row back. */
export interface DoneSaid {
  say: RefusalArg;
  opts?: ToastOpts;
}

/**
 * SEND + DONE's release over the results a road was HANDED — see `releaseConfirmed` in
 * {@link liveActions}. Keyed by Idempotency-Key; a key absent from the answer earned no sentence
 * of its own (a plain send, a refused one, or a release the account would not make).
 */
export type ReleaseConfirmed = (results: readonly MutationResult[]) => Promise<ReadonlyMap<string, DoneSaid>>;

export interface LiveDeps {
  engine: OhmailEngine;
  /** One plain sentence to the reader — the screens' toast. */
  /**
   * A REFUSAL, not a sentence. A toast held in the queue used to be words chosen when it was
   * raised, so one already on screen kept the language it was raised in while everything around
   * it followed a switch. The screen writes it out with `sayArg`.
   */
  toast: (say: RefusalArg, opts?: ToastOpts) => void;
  /**
   * Resolves once the sentence just spoken is ON SCREEN, or after `PAINT_BOUND_MS` — the pill's
   * own layout report through `state/toast-one.ts#paintGate`. An optimistic door awaits it between
   * speaking and dispatching, so the sentence never rides the mirror's re-derivation to the screen.
   */
  painted?: () => Promise<void>;
  now?: () => Date;
  /**
   * RFC 4122 v4 — the id a NEW tag is minted under (`tag_assign.createName`: the server uses the
   * client's id as the row's id, so the optimistic chip and the stored row agree). The app hands
   * in expo-crypto's; the node suite hands in its counter. Absent ⇒ tag creation is refused
   * rather than minted weakly.
   */
  uuid?: () => string;
  /** The reader's zone for the resurface horizons — 09:00 where the reader is. Defaults to the device's. */
  zone?: string;
  /**
   * The reader's language for the one stamp this facade renders itself (the Trash rows'
   * deleted-when). A GETTER for `ownAddresses`' reason: the facade is identity-stable while
   * the language can switch mid-session. Absent ⇒ English, `messageDisplayTime`'s own default.
   */
  locale?: () => string;
  /**
   * THE READER'S OWN ADDRESSES, as a GETTER rather than a value — see
   * {@link WorldView.ownAddresses} for what they are and where they come from.
   *
   * A getter because this facade is identity-stable BY DESIGN (`World.worldKey`'s own note: so
   * mirror versions cannot re-fire effects), while the mailbox read lands asynchronously after
   * it is built. A value captured at construction would be the empty set for the life of the
   * session, and the reply-all a person sends would address a list derived from facts the rest
   * of the app already had.
   */
  ownAddresses?: () => readonly string[];
  /**
   * THE ACCOUNT'S RESURFACE TIME — `'HH:MM'`, or `null` for "never chosen" (mail 0110), as a
   * GETTER for `ownAddresses`' reason exactly: this facade is identity-stable by design while
   * the consent read that carries the time lands asynchronously after it is built, so a value
   * captured at construction would be `null` for the life of the session and the horizon-less
   * verbs would keep minting 09:00 over an account that chose 14:30. Absent ⇒ the product's
   * 09:00, which is what every build did before the setting existed.
   */
  resurfaceTime?: () => string | null;
  /**
   * THE READER THE LISTS ARE DRAWN FROM — `presentedWorld`'s projection, a GETTER for
   * `ownAddresses`' reason. Send + Done asks it and nothing else: the Ohbox its rule is about
   * is the one ON SCREEN, and a message a rule presents under Reads sits in INBOX in the raw
   * mirror. Absent ⇒ the raw mirror, right for a harness and wrong for a routed message; the
   * world always supplies it.
   */
  presented?: () => EntityReader;
  /** The options those lists are partitioned with ({@link presentedOptions}), for a press's forecast. */
  presentedOptions?: () => ConsentOptions;
  /**
   * A DECIDE THE SERVER CONFIRMED, HANDED BACK TO WHOEVER HOLDS THE CACHED QUEUE — the paired
   * door's waiting shelf is that cache, and without this it kept the decided sender until the
   * next drain (see {@link waitingAfterDecide}, which is the rule; this only carries the event).
   * Absent ⇒ nothing is reconciled, which is the standalone door's correct behaviour: there the
   * shelf is derived from the mirror and the mutation's own optimistic relocation already
   * retires the sender.
   */
  forgetWaiting?: (decided: { address: string; scope: Scope }) => void;
  /**
   * WILL A SCREEN-OUT HERE ALSO SEND THE ONE-CLICK UNSUBSCRIBE — the account's switch on a door
   * that sends it (`net/consent.ts#FoldersConsent.autoUnsubscribe`), false on the standalone door,
   * which sends nothing. A GETTER for `ownAddresses`' reason. It changes one sentence and gates
   * nothing: the server reads its own row at the seam. Absent ⇒ true, the webapp's resting value —
   * the failure to avoid is the silent unsubscribe.
   */
  autoUnsubscribe?: () => boolean;
  /** A decision SENT to the organizer: the sender keeps a mark until it answers (`state/relay.ts`). */
  relayedHere?: (decided: { address: string; scope: Scope }) => void;
  /**
   * A DECIDE ON A ROW ONLY THE STORE BACKS, FROM THE PRESS TO ITS ANSWER: the holder of the cached
   * queue keeps the sender off the shelf until the returned release, which the press calls once
   * the answer is in (after {@link forgetWaiting} on a landed one). The mirror-backed row needs no
   * hold — the decide's own overlay moves its mail. Absent ⇒ the row stays until the answer.
   */
  leaveWaiting?: (decided: { address: string; scope: Scope }) => () => void;
}

/**
 * The engine's abandoned-verb shape, re-exported so the phone's surfaces do not import the
 * engine package to name it. `privacy.test.ts#ENGINE_IMPORTERS` is a deliberately short
 * allow-list of files permitted to reach `@ohmail/client-engine` — the phone's licence to talk
 * to a server should be auditable by reading two directories. The chrome needs this type and
 * nothing else; this file is already the phone's one door to the engine's vocabulary
 * (`WorldActions`, `WorldMail`, `WorldPile` leave through here), so the type leaves the same way.
 */
/* …and the reader type, for the same reason: the world holds the projection the lists are
   drawn from and hands it back through {@link LiveDeps.presented}, so it has to name it. */
export type { AbandonedMutation, EntityReader, MutationResult, QueuedChange } from "@ohmail/client-engine";
/* The sheet's step reads the press's forecast and the rules in play by this door too. */
export type {
  ConflictGroup, ConsentOptions, PressForecast, RuleDTO as WorldRule, RuleLine, RulesInPlay,
} from "@ohmail/client-engine";

export interface LiveWorldActions {
  /** Opening a message marks it read and asks for its full text + conversation + files. */
  openMessage(id: string): Promise<boolean>;
  /** The reader left this message: its row, held in New while it was read, takes its place in Earlier. */
  leaveMessage(id: string): void;
  /**
   * Ask the engine for the embedded images the OPEN message's document references — the
   * renderer's own pass supplies the ids, the engine spends bounded connection fetches and
   * publishes the minted map through {@link WorldMail.inlineImages}. Fire-and-forget; a part
   * that cannot be minted stays a blank box, which is what every message showed before.
   */
  loadInlineImages(messageId: string, contentIds: string[]): void;
  /**
   * One attachment's BYTES for the share sheet — `openAttachment` (single-flight, the server's
   * ceiling respected) and the held Blob read back as base64. The refusals are the engine's
   * own states, returned rather than thrown: the tile renders each one a sentence.
   */
  openAttachmentBytes(messageId: string, attachmentId: string): Promise<WorldAttachmentBytes>;
  /**
   * DROP ONE MESSAGE'S HELD FILE BYTES — the reader's cleanup, the web seam's own rule. Nothing
   * else bounds them: the engine holds a list, its inline pictures and every opened Blob until
   * somebody releases, and the phone mints no object URL whose revocation could stand in for it,
   * so without this a session grows by every rich message it was shown.
   */
  releaseAttachments(messageId: string): void;
  /** An explicit re-ask for one message's full text (a card expand, a reopen). */
  hydrateMessage(id: string): void;
  /**
   * WHAT A FORWARD PRESS WAITS ON BEFORE IT OPENS — `forwardPress(m, held).fetch`: a row the mirror
   * does not hold has its body read through the reader's door, so the server can quote it. `null`
   * opens at once; the promise never rejects, and a failed read still opens (the send says why).
   */
  forwardFetch(messageId: string): Promise<void> | null;
  /**
   * PUT A GIVEN-UP CHANGE BACK IN THE QUEUE — under its ORIGINAL Idempotency-Key, so an attempt
   * that committed and only lost its answer replays that answer instead of sending a second copy.
   * Parity with the browser's "Try again"; the engine owns the rule, this is the phone's door to it.
   */
  retryAbandoned(id: string): Promise<MutationResult>;
  /** Throw a given-up change away for good. The optimistic row reverted when it was abandoned. */
  discardAbandoned(id: string): Promise<void>;
  /**
   * TRY AGAIN ON A QUEUED DISCARD — now, under its own key (`engine.retryQueued`). `null` is a
   * verb no longer waiting (the drain took it, or it settled): there is nothing to say.
   */
  retryQueued(id: string): Promise<MutationResult | null>;
  /** DISCARD A QUEUED DISCARD — withdrawn, so nothing sends it and the draft comes back. */
  discardQueued(key: string): Promise<WithdrawOutcome>;
  /** Send + Done's release over a road's results — the one caller of `applySendAndDone`. */
  releaseConfirmed: ReleaseConfirmed;
  /** The sender screen's open: fetch every held body so the decision is over real mail. */
  hydrateHeld(ids: string[]): void;
  /**
   * HOLD THE FILE LISTS OF THE MESSAGES A SCREEN SHOWS beside a row it already has (the
   * Screener's held mail, an open News card): each one that has files is asked, and stays until
   * {@link releaseFiles} is called with the same ids. The reader's open holds its own.
   */
  holdFiles(ids: string[]): void;
  /** Let go what {@link holdFiles} held for the same ids — the screen's leaving. */
  releaseFiles(ids: string[]): void;
  /** The scroll-seen sweep: mark what the reader scrolled past, in this stream only. */
  sweepFeed(view: FeedView, passedIds: string[]): Promise<boolean>;
  /** Leaving the stream commits the waterline above the newest swept row. */
  leaveFeed(view: FeedView): Promise<boolean>;
  /** A waiting sender's decision — the five destinations, "&read", sender/domain scope. */
  decide(row: ScreenerRow, dest: Destination, read: boolean, scope: Scope): Promise<boolean>;
  /** Allow / Not-spam: release the held bag to a place, REWRITING the holding rules. */
  release(row: ScreenerRow, dest: Place, segment: "screened" | "spam"): Promise<boolean>;
  /** The message screen's triage: Answer Later / Park / Resurface. */
  setPile(messageId: string, kind: PileKind): Promise<boolean>;

  /* ── the open message's verbs — the webapp action bar's arms (`AppShell.onMessageAction`) ── */

  /**
   * LATER / PARK AS TOGGLES: the verb that put a message in a pile takes it out again
   * (`triage_set: none`), exactly as the webapp's `later`/`aside` arms do.
   */
  pileToggle(messageId: string, kind: "replyLater" | "setAside", members?: readonly string[]): Promise<boolean>;
  /** The horizon-less Resurface — tomorrow 09:00, or CLEARS a booking that already stands. */
  resurfaceToggle(messageId: string): Promise<boolean>;
  /** Resurface AT a chosen instant (the chooser's Tomorrow / Next week / a picked day). */
  resurfaceAt(messageId: string, iso: string): Promise<boolean>;
  /** Resurface NOW — the `resurfaced` state, not a date; pinned by the time the request returns. */
  resurfaceNow(messageId: string): Promise<boolean>;
  /** DONE with a resurface: clear a standing booking, then the deliberate read that spends the pin. */
  resurfaceDone(messageId: string, members?: readonly string[]): Promise<boolean>;
  /** Mark read / Mark unread — the DELIBERATE `mark_seen` (no `via`), so a read spends a pin. */
  markSeen(messageId: string, unread: boolean, members?: readonly string[]): Promise<boolean>;
  /**
   * The reader's scroll-to-read over a conversation's members (`ui/reader-seen.ts`): a GLANCE
   * (`via: "glance"`), so a pin survives it, with no sentence — the panel's own ink is the answer.
   */
  markGlanced(ids: readonly string[]): Promise<boolean>;
  /**
   * MARK ALL READ — the webapp's `read-all.ts` on this surface: chunked deliberate
   * `mark_seen` at the `PATCH /messages` cap, one sentence naming the count, ONE undo for
   * exactly what the press flipped (pins a deliberate read spends are re-pinned). `feed` is
   * the streams' second half — the same press commits the waterline above the newest row,
   * and that anchor offers no undo (`feed_mark_seen` is undo-class "none").
   */
  markAllSeen(ids: string[], feed?: { place: FeedView; upToId: string }): Promise<boolean>;
  /**
   * Move THIS message to a view — the sender's routing first, `POST /messages/:id/move` only
   * where the mail really is filed elsewhere. The ROW and not an id: the presented place is the
   * one fact this module cannot re-derive (its reader is the raw mirror), and an id would let a
   * caller press without it. The webapp's `moveToPlace(m, view)` takes the message for the same
   * reason.
   */
  move(row: WorldMail, dest: MoveTarget, members?: readonly string[]): Promise<boolean>;
  /**
   * DELETE — `message_delete` (`DELETE /messages/:id`, mail 0065): the message rides to the
   * provider's native `\Trash` on the server, NEVER an expunge, and the optimistic tombstone
   * drops it from every living view at the press. A mailbox with no Trash folder is the
   * server's 422 refusal, which rolls the row back whole — the one honest screen for a delete
   * that cannot happen. The confirm ceremony is the sheet's job; this arm dispatches.
   * `quiet` is the held window's commit: the pill already said "Moved to Trash." at the press,
   * so only the confirmed sentence is withheld — refusal and queued speak whatever happens.
   */
  deleteMessage(messageId: string, opts?: { quiet?: boolean }): Promise<boolean>;
  /**
   * One page of mail this account deleted — `OhmailEngine.listTrash`, projected to rows the
   * Trash screen renders. OFF-MIRROR by construction (a delete tombstones the row in every
   * mirror), so the screen holds the page and the world never lists it. `say` on the failed
   * arm carries the server's sentence only where it is written for the person (the webapp
   * `trash-page.ts` allowlist: the spend gate's 402); everything else is withheld and the
   * screen says its own.
   */
  trashList(cursor: string | null): Promise<WorldTrashPage>;
  /**
   * Put one deleted message back where it was — the delete verb's inverse move
   * (`POST /messages/:id/restore`). Resolves `true` when the server accepted the restore
   * (still PENDING on the mail server — the toast says "Restoring to …", never "restored");
   * the rolled-back and unavailable arms speak their own sentence and answer `false`, so the
   * caller keeps the row.
   */
  trashRestore(messageId: string): Promise<boolean>;
  /**
   * Reply (or reply all) — `mail_send` with `inReplyTo`; the engine derives the envelope.
   * `sig` is the signature block's own derived text (`effectiveSignature`, computed once by
   * the sheet — what is shown is what ships); `null` leaves the mutation byte-identical to
   * one built before the block existed. `sendAt` (Send later, mail 0077) puts an appointment
   * on the message instead of sending: the adapter posts `/drafts/:id/schedule`, nothing
   * dials SMTP now. One send machine, deliberately — a second dispatch arm would be a second
   * place for the signature, empty-body refusal and Idempotency-Key rules to drift. Only the
   * confirmed sentence differs, and it must never say "sent" over a message still on the account.
   */
  sendReply(
    messageId: string,
    body: string,
    all: boolean,
    sig?: string | null,
    sendAt?: string | null,
    attachments?: ComposeAttachment[],
    /**
     * SEND + DONE — the composer's second send action. The send is this one, unchanged; the
     * message being answered is filed only once the engine has ACCEPTED it, through the same
     * release {@link LiveWorldActions.resurfaceDone} performs and the one rule the webapp
     * composer reads (`@ohmail/client-engine`'s `sendAndDone`). The pill then says so once,
     * with the Undo that puts the row back in the section it left.
     */
    andDone?: boolean,
    /** The row a refused press left ({@link SendResult.draftId}) — this press sends that row. */
    draftId?: string | null,
  ): Promise<SendResult>;
  /**
   * IS THE SECOND SEND ACTION OFFERED for a reply or forward of this message? The engine's one
   * rule (`sendAndDonePlanFor`): a source that sits in the Ohbox now and is not already done.
   * `false` is the plain Send — a message in a bottom pile, filed elsewhere, or finished.
   */
  sendAndDoneOffered(messageId: string): boolean;
  /**
   * Forward — `mail_send` with `forwardOf`, recipients the USER typed, the user's note as
   * body. The signature seals into the NOTE; the server appends the quoted original after
   * the body it is handed, so the block sits above the quoted history (`signature.ts`).
   * `attachments` on either verb ride the same mutation the webapp composer sends —
   * base64 on `POST /drafts/:id/send`, nothing stored (`ComposeAttachment`'s own contract).
   */
  sendForward(messageId: string, to: EmailAddress[], body: string, sig?: string | null, attachments?: ComposeAttachment[], andDone?: boolean, confirmed?: boolean, draftId?: string | null): Promise<SendResult>;
  /**
   * A MAIL THAT ANSWERS NOTHING — the same `mail_send` with no parent: `inReplyTo` null,
   * no `forwardOf`, the sending mailbox named explicitly because there is no parent to derive
   * it from. Everything after the envelope is the reply arm's — one signature derivation, one
   * empty-content refusal, one Idempotency-Key, Send later on the same clock.
   */
  sendNew(
    mailboxId: string | null,
    to: EmailAddress[],
    subject: string,
    body: string,
    sig?: string | null,
    sendAt?: string | null,
    attachments?: ComposeAttachment[],
    draftId?: string | null,
    /** Cc and Bcc, as the composer parsed them; absent is none. */
    copies?: { cc: EmailAddress[]; bcc: EmailAddress[] },
  ): Promise<SendResult>;
  /**
   * WITHDRAW A QUEUED SEND — Cancel, on the intent. `withdrawn` is the cancellation;
   * `on_the_wire` withdrew nothing and the surface says so; `gone` is a key the queue no longer
   * holds. See {@link OhmailEngine.withdrawQueued}.
   */
  withdrawSend(key: string): Promise<WithdrawOutcome>;
  /**
   * TAKE THE APPOINTMENT OFF A SCHEDULED SEND — `draft_schedule_cancel`, the Scheduled
   * screen's one verb. See {@link LiveWorldActions.cancelSchedule}'s implementation for why
   * only `confirmed` may say "cancelled".
   */
  cancelSchedule(draftId: string): Promise<boolean>;
  /**
   * DISCARD A DRAFT — `draft_discard` (`DELETE /drafts/:id`), the Drafts screen's destructive
   * verb. The ceremony (the in-place confirm) is the card's; this arm dispatches and reports.
   * The server admits the discard of an `unverified` row and refuses a send still running
   * (`stillSending`), which the card renders in the row; every other ending is toasted.
   */
  draftDiscard(draftId: string): Promise<DraftDiscardOutcome>;
  /**
   * A PERSON ACTS FOR A SEND THIS SERVER COULD NOT CONFIRM — `draft_resolve`
   * (`POST /drafts/:id/resolve`). `arrived` is "It was sent — dismiss": the ledger records the
   * delivery and the row leaves Drafts. `not_arrived` frees it to an ordinary draft.
   */
  draftResolve(draftId: string, outcome: "arrived" | "not_arrived"): Promise<boolean>;
  /**
   * SEND A HELD MESSAGE AGAIN — the web's two steps without an editor: `not_arrived` frees the
   * row, then the row is sent AS IT STANDS through the bound send (`draftId`). `sent` closes the
   * card; every other ending is the card's to say, in the row.
   */
  draftSendAgain(draftId: string): Promise<DraftSendAgainOutcome>;
  /**
   * KEEP WHAT WAS TYPED — one `draft_save` (create) as the composer closes, so no road out of it
   * throws text away. `kept` once the account or the outbox holds the row, with an Undo that
   * discards it; `refused` names nothing and the sheet stays open to say so.
   */
  draftKeep(keep: DraftKeep): Promise<DraftKeepOutcome>;
  /** Put a tag on / take it off — `tag_assign`. */
  tagToggle(messageId: string, tag: WorldTag, assigned: boolean): Promise<boolean>;
  /** Tag-or-create: a name that does not exist yet, minted and put on this message in one act. */
  tagCreate(messageId: string, name: string): Promise<boolean>;
  /**
   * SCREENING from the open message: where THIS SENDER's mail goes — the webapp sender sheet's
   * rule ladder (`sender-screening.ts#planScreeningChange`), in the phone's idiom.
   */
  screenSender(messageId: string, dest: Destination, scope: Scope, applyRetro?: boolean, press?: PhoneScreenPress): Promise<boolean>;
  /** The press before it is made — where the lists would show the sender's mail afterwards. */
  screeningForecast(messageId: string, dest: Destination, scope: Scope, applyRetro: boolean): PressForecast | null;
  /** "Their rules": every rule deciding the sender's mail today, as the lists place it. */
  screeningRules(messageId: string, scope: Scope): RulesInPlay | null;
  /** The rows a finished rule pass left elsewhere, to ask the server why (`sender-stayed.ts`). */
  screeningStayed(messageId: string, scope: Scope): StayedAsk | null;
  /** The server's reason per row (`GET /screener/stayed`); a door that cannot answer names none. */
  stayedWhy(ids: readonly string[]): Promise<ReadonlyMap<string, StayedWhy>>;
  /** "Move it too": the named rows to the rule's place, through the one move door. */
  moveStayed(ids: readonly string[], dest: Destination): Promise<boolean>;
  /**
   * THE OHBOX'S OFFER, PRESSED — the web's screening action on the same route: every shown group
   * goes to the Screener, and the sentence names what the server moved. `false` on a refusal.
   */
  screenUnscreened(): Promise<boolean>;

  /* The folder verbs (FOLDERS-SPEC.md stage 2) — the webapp `useFolderVerbs` arms.
   * User-commanded real IMAP operations in the user's own mailbox, on the same engine
   * mutations every client uses (`folder_create` / `folder_rename` / `folder_delete` /
   * `folder_op_dismiss`). The optimism model is the family's: the mutation paints a pending
   * marker (`FolderEntity.op`), the mailbox's `name` stays the truth until the worker lands
   * the change, the wake channel settles it. Success says nothing — the pending row is the
   * feedback — and only `rolled_back` speaks (`folder-verbs.ts`'s `speakIfRolledBack`, in
   * intent). `queued` is not a failure: the command stands on the retry queue under its key.
   */

  /** Create a folder — `name` is the FULL canonical path. Refused without a uuid source. */
  folderCreate(mailboxId: string, name: string): Promise<boolean>;
  /** Rename — `name` is the new FULL canonical path (rename and move are one act). */
  folderRename(folderId: string, name: string): Promise<boolean>;
  /** Delete — the caller has already confirmed (the sheet's ask-first ceremony). */
  folderDelete(folderId: string): Promise<boolean>;
  /** Dismiss a FAILED command — the refusal was read. Fire-and-forget, the webapp's own shape. */
  folderDismiss(folderId: string): void;
}

export function liveActions(deps: LiveDeps): LiveWorldActions {
  const { engine, toast } = deps;
  /** The sentence-on-screen gate the provider supplies; the timer stands in where there is none (tests). */
  const painted = deps.painted ?? paintFirst;
  const now = deps.now ?? (() => new Date());
  /** Read at every use, never captured — see {@link LiveDeps.resurfaceTime}. */
  const resurfaceAtClock = (): string | null => deps.resurfaceTime?.() ?? null;
  /**
   * DOES THIS PRESS SEND THE SENDER'S UNSUBSCRIBE — the decide route (`screener_decide`) with a
   * `no`, on a door whose switch is on. Exactly the server's trigger: a rule written past the gate
   * and a plain move arm nothing, so they say nothing (UD-R4-03 keeps the pass to the same set).
   */
  const decidedUnsubscribes = (decideRoute: boolean, decision: "yes" | "no"): boolean =>
    decideRoute && decision === "no" && (deps.autoUnsubscribe?.() ?? true);
  /**
   * Everything swept per stream DURING THE CURRENT VISIT — the leave commit's anchor pool.
   * CONSUMED by {@link leaveFeed}: a visit's sweep may not leak into the next one, or a
   * stale anchor recommits on every later leave and a row another client marked unread
   * again is skip-listed for the session.
   */
  const swept = new Map<FeedView, Set<string>>();
  /**
   * The sweep dispatches still in the air, per stream. The LEAVE COMMIT AWAITS THEM: the
   * screens fire sweeps without awaiting (a scroll handler cannot), so a tab switch can
   * reach {@link leaveFeed} while a flip is still optimistic — consumed unawaited, a sweep
   * that then ROLLS BACK had already anchored the line on a row that is still unread.
   * Settling first lets the rollback pull its ids out of the pool
   * before the anchor is chosen.
   */
  const inflight = new Map<FeedView, Set<Promise<boolean>>>();

  /**
   * ORDER IS A CONTRACT PER MESSAGE (FIX-022, twice on the iPhone 18 Pro 2026-09-21, closing
   * `MOBILE-UNDO-CAN-BE-SENT-BEFORE-THE-VERB-IT-UNDOES`): a verb speaks, waits for its pill and
   * only then dispatches, so on a busy thread its request left 3-8 s after the tap and an Undo
   * pressed in that window reached the server FIRST — inverse then verb, message still filed.
   * The engine orders every dispatch it has been HANDED (`engine.ts#outboxGate`); this window is
   * the one before `mutate` is called at all, which only this facade can see, so the slot is
   * taken at the PRESS. Keyed per message: one global chain would put every other message's
   * press behind one pill.
   */
  const chains = new Map<string, Promise<void>>();
  const quiet = (): void => undefined;

  /**
   * Enqueue on one message's chain. `run` may NOT enqueue again for the same id — it would
   * await its own tail — so the verbs that write twice for one message dispatch inside their
   * single slot rather than through {@link dispatch}.
   */
  const inOrder = <T>(messageId: string, run: () => Promise<T>): Promise<T> => {
    const prior = chains.get(messageId);
    /* NOTHING IN THE AIR FOR THIS MESSAGE ⇒ RUN IN THE PRESS'S OWN TURN. `mutate` applies
       optimistically before its first await and the screens read the mirror straight after a
       press, so a microtask's delay here would move the mirror out of the turn it happened in. */
    const mine = prior === undefined ? run() : prior.then(run, run);
    const tail: Promise<void> = mine.then(quiet, quiet).then(() => {
      if (chains.get(messageId) === tail) chains.delete(messageId);
    });
    chains.set(messageId, tail);
    return mine;
  };

  /** The one message a mutation names, or `null` where it names none or many — the chain's key. */
  const chainKeyOf = (m: EngineMutation): string | null => {
    switch (m.kind) {
      case "move": case "message_delete": case "triage_set": case "tag_assign": return m.messageId;
      case "mark_seen": return m.messageIds.length === 1 ? (m.messageIds[0] ?? null) : null;
      default: return null;
    }
  };

  /** A dispatch in its message's order; a mutation naming no one message passes straight through. */
  const inMessageOrder = <T>(m: EngineMutation, run: () => Promise<T>): Promise<T> => {
    const key = chainKeyOf(m);
    return key === null ? run() : inOrder(key, run);
  };

  /** `watched(engine.mutate(m))`, in its message's order — the ordinary door for one write. */
  const dispatch = (m: EngineMutation): Promise<PressVerdict> =>
    inMessageOrder(m, () => watched(engine.mutate(m)));

  /**
   * THE LATCH A VERB AND ITS UNDO RACE FOR. An optimistic verb holds its chain slot from the
   * press, through the pill's paint gate, to the instant it dispatches; whoever claims the latch
   * first decides whether anything leaves the device. The verb claims it and sends; an Undo
   * claims it and the verb is CANCELLED — `mutate` was never called, so the mirror never moved
   * and there is nothing to roll back and nothing for the server to take back.
   */
  const oneShot = (): (() => boolean) => {
    let open = true;
    return () => { const mine = open; open = false; return mine; };
  };

  /**
   * THE ONE DOOR EVERY OPTIMISTIC VERB DISPATCHES THROUGH — the sentence is already spoken, so
   * this is where the order and the take-back live: the slot is taken at the press, the pill's
   * paint gate is awaited INSIDE it, and a verb whose latch an Undo claimed first answers `null`
   * with nothing sent. The writes of one press go in their given order, in the one slot: this
   * run may not re-enter its own chain.
   */
  const gatedWrite = (
    messageId: string,
    ms: readonly EngineMutation[],
    onScreen: Promise<void>,
    leaving: () => boolean,
  ): Promise<PressVerdict[] | null> =>
    inOrder(messageId, async (): Promise<PressVerdict[] | null> => {
      await onScreen;
      if (!leaving()) return null;
      const out: PressVerdict[] = [];
      for (const m of ms) out.push(await watched(engine.mutate(m)));
      return out;
    });

  /** The same, answered: a cancelled verb is `true` — nothing was sent, so nothing failed. */
  const gatedSaid = async (
    messageId: string,
    ms: readonly EngineMutation[],
    onScreen: Promise<void>,
    leaving: () => boolean,
  ): Promise<boolean> => {
    const vs = await gatedWrite(messageId, ms, onScreen, leaving);
    return vs === null ? true : saidAll(vs, null, refuse("liveSaveFailed"));
  };

  /**
   * WHAT A PRESS IS TOLD — the one place a verdict becomes a sentence on this surface.
   *
   * `done` is the caller's own completion sentence, or `null` where it already raised an
   * optimistic one. A press the SERVER recorded for the organizing install gets the queued
   * sentence instead and answers `false`: nothing happened, so no caller may treat it as having.
   * A press on this client's own retry queue answers `true` — the intent stands under its key.
   */
  const said = (v: PressVerdict, done: RefusalArg | null, failed: RefusalArg, opts?: ToastOpts): boolean => {
    // A newer press for the same field replaced this one: it owns the sentence.
    if (v.kind === "silent") return true;
    if (v.kind === "refused") { toast(failed); return false; }
    if (v.kind === "queued" && v.wait === "organizer") {
      toast(v.holder ? refuse("pressQueuedForOrganizer", v.holder) : refuse("pressQueuedForOrganizerUnknown"));
      return false;
    }
    if (done !== null) toast(done, opts);
    return true;
  };

  /** The same, over a SET: one sentence for the run, and a queued press is never counted landed. */
  const saidAll = (vs: readonly PressVerdict[], done: RefusalArg | null, failed: RefusalArg, opts?: ToastOpts): boolean => {
    const t = tallyVerdicts(vs);
    if (t.refused > 0) { toast(failed); return false; }
    if (vs.length > 0 && t.silent === vs.length) return true;
    if (t.queued > 0 && vs.some((v) => v.kind === "queued" && v.wait === "organizer")) {
      const holder = t.holder;
      toast(holder ? refuse("pressQueuedForOrganizer", holder) : refuse("pressQueuedForOrganizerUnknown"));
      return false;
    }
    if (done !== null) toast(done, opts);
    return true;
  };

  /**
   * One body ask, with the engine's retry gate honoured rather than fought: a record the
   * engine has marked `failed` is only re-asked when the caller says a human asked again
   * (`retry: true`), and every call here IS a human act — an open, a reopen, an expand.
   * Without the flag, "Reopen to try again" could never recover in the same session:
   * the default path deliberately skips a failed record.
   */
  const hydrateSmart = (id: string): void => {
    if (hydrateOffMirror(engine, id)) return;
    const rec = engine.read().get<{ state?: string }>("message_body", id);
    void engine
      .hydrateBody(id, rec?.state === "failed" ? { retry: true } : {})
      .catch(() => undefined);
  };

  const hydrateMessage = (id: string): void => hydrateSmart(id);

  const forwardFetch = (messageId: string): Promise<void> | null => {
    const m = messageOf(messageId);
    if (!m) return null;
    const held = engine.read().get<EngineMessage>("message", messageId) !== undefined;
    return forwardPress(m, held).fetch ? offMirrorBodyRead(engine, messageId) : null;
  };

  /*
   * THE LISTS A SCREEN SHOWS: the opened message's, each conversation member's, each held
   * message's, whichever has files, held while the screen stands. Counted per id, because one
   * message can stand on two screens and only its last release lets its list go. Asked four at a
   * time (the web's bound); a list that lands after its last release is let go again.
   */
  const listHolds = new Map<string, number>();
  const readerHolds = new Map<string, string[][]>();
  const listQueue: string[] = [];
  let listCrew = 0;
  const pumpLists = (): void => {
    while (listCrew < THREAD_LIST_CONCURRENCY && listQueue.length > 0) {
      listCrew += 1;
      void (async () => {
        try {
          for (let next = listQueue.shift(); next !== undefined; next = listQueue.shift()) {
            if (!listHolds.has(next)) continue;
            await engine.loadAttachments(next).catch(() => undefined);
            if (!listHolds.has(next)) engine.releaseAttachments(next);
          }
        } finally {
          listCrew -= 1;
        }
      })();
    }
  };
  const withFiles = (ids: readonly string[]): string[] =>
    ids.filter((lid) => engine.read().get<EngineMessage>("message", lid)?.hasAttachments === true);
  const holdLists = (readerId: string, ids: readonly string[]): void => {
    const held = [...new Set(ids)];
    for (const lid of held) {
      const n = listHolds.get(lid) ?? 0;
      listHolds.set(lid, n + 1);
      if (n === 0) listQueue.push(lid);
    }
    readerHolds.set(readerId, [...(readerHolds.get(readerId) ?? []), held]);
    pumpLists();
  };

  /** The lists one screen held, let go; answers the ids whose last hold that was. */
  const letGo = (readerId: string): string[] => {
    const opens = readerHolds.get(readerId);
    const held = opens?.pop() ?? [];
    if (opens?.length === 0) readerHolds.delete(readerId);
    const gone: string[] = [];
    for (const lid of held) {
      const left = (listHolds.get(lid) ?? 1) - 1;
      if (left > 0) listHolds.set(lid, left);
      else { listHolds.delete(lid); gone.push(lid); }
    }
    return gone;
  };

  /** A screen's holds, keyed by the ids it shows; a reader's are keyed by the opened id. */
  const filesKeyOf = (ids: readonly string[]): string => JSON.stringify(["files", ...ids]);
  /* One message on screen (an open News card) is asked whatever its flag says, as the opened
     message is; a bag of several (the sender screen) keeps the flag as its budget. */
  const holdFiles = (ids: string[]): void => holdLists(filesKeyOf(ids), ids.length === 1 ? ids : withFiles(ids));
  const releaseFiles = (ids: string[]): void => {
    for (const lid of letGo(filesKeyOf(ids))) engine.releaseAttachments(lid);
  };

  /**
   * The held bag's bodies, batched (`hydrateThread` → `GET /messages/bodies`), with the
   * failed ones re-asked individually under the retry flag — the batch path has no retry
   * option and would skip them.
   */
  const hydrateHeld = (ids: string[]): void => {
    const reader = engine.read();
    const failed: string[] = [];
    const fresh: string[] = [];
    for (const id of ids) {
      const rec = reader.get<{ state?: string }>("message_body", id);
      (rec?.state === "failed" ? failed : fresh).push(id);
    }
    for (const id of failed) void engine.hydrateBody(id, { retry: true }).catch(() => undefined);
    if (fresh.length > 0) void engine.hydrateThread(fresh).catch(() => undefined);
  };

  const openMessage = async (id: string): Promise<boolean> => {
    const m = engine.read().get<EngineMessage>("message", id);
    if (!m) {
      // A row the mirror does not hold (a History or Search hit) lists its files too: the list is
      // the server's, asked by id, and the reader's cleanup releases it as it does any other.
      holdLists(id, offMirrorRowOf(id) ? [id] : []);
      return false;
    }
    // The full text, the conversation's members, and the file lists — all render-side asks;
    // failures degrade to the snippet with its honest bodyState, never to an error screen.
    hydrateSmart(id);
    const members = threadOf(engine.read(), id);
    if (members.length > 0) void engine.hydrateThread(members.map((t) => t.id)).catch(() => undefined);
    // THE OPENED MESSAGE IS ASKED WHATEVER ITS FLAG SAYS, as the web asks: a PDF the html names
    // by `cid:` is inline and clears `hasAttachments`. The flag budgets the members only, and the
    // members are the panel's — the PRESENTED conversation where it holds the message
    // (`liveMessage`), so a member the presentation holds back costs no list nobody is shown.
    const presented = presentedReader();
    const shown = presented.get<EngineMessage>("message", id) ? threadOf(presented, id) : members;
    holdLists(id, [id, ...withFiles(shown.map((t) => t.id))]);
    // THE ROW KEEPS ITS PLACE WHILE IT IS READ, held BEFORE the read is saved so both reach the
    // list in one snapshot; a read row holds nothing. `leaveMessage` lets it go.
    engine.holdOpenRow(id);
    if (!m.unread) return true;
    // A RESURFACED PIN IS NOT SPENT BY OPENING — but the READ LANDS (owner ruling 2026-08-26:
    // reading a resurfaced message sticks like anywhere else). This used to skip pinned rows
    // entirely because the engine pruned their ids from a glance and a one-id glance pruned to
    // nothing was `mutate`'s not-found rollback; that pruning is gone — the glance travels
    // labelled and the SERVER keeps the pin while marking read. The deliberate reads — the
    // sheet's Done, Mark as read — remain the acts that spend the pin.
    // `via: "glance"` — the involuntary read, so the server's pin semantics see it as such.
    return said(
      await dispatch({ kind: "mark_seen", messageIds: [id], unread: false, via: "glance" }),
      null, refuse("liveSaveFailed"),
    );
  };

  const leaveMessage = (id: string): void => {
    engine.releaseOpenRow(id);
  };

  const releaseAttachments = (messageId: string): void => {
    // The opened message's pictures and bytes go with its reader, unless another still shows it.
    for (const lid of new Set([messageId, ...letGo(messageId)])) {
      if (!listHolds.has(lid)) engine.releaseAttachments(lid);
    }
  };

  const loadInlineImages = (messageId: string, contentIds: string[]): void => {
    if (contentIds.length === 0) return;
    // `loadInlineImages` never rejects, so a `catch` here could not fire; what a blank box needs
    // stated is that the pass minted NOTHING for a document that asked for pictures.
    void engine.loadInlineImages(messageId, contentIds).then(() => {
      if (engine.inlineImagesOf(messageId).size === 0) logAttachmentRefusal("inline_images_none");
    });
  };

  const openAttachmentBytes = async (messageId: string, attachmentId: string): Promise<WorldAttachmentBytes> => {
    // A variable, not a literal — correct against either option spelling (see `liveMessage`).
    const EVERY_PART = { includeInlineImages: true, includeInlineParts: true };
    const itemNow = () => {
      const list = engine.attachmentsOf(messageId, EVERY_PART);
      return list.state === "ready" ? list.items.find((i) => i.id === attachmentId) : undefined;
    };
    // A held failure is asked again only where the refusal said asking again can help: a refused
    // sign-in answers the same way every tap, and each tap is a connection to the person's server.
    const before = itemNow();
    if (!(before?.state === "failed" && before.retryable === false)) {
      await engine.openAttachment(messageId, attachmentId, before?.state === "failed" ? { retry: true } : {})
        .catch(() => undefined);
    }
    const item = itemNow();
    if (!item) {
      logAttachmentRefusal("bytes_unavailable");
      return { state: "unavailable" };
    }
    // `too_large` is an ANSWER, not a refusal: the sentence names the ceiling and no retry helps.
    if (item.state === "too_large") return { state: "too_large" };
    const blob = engine.attachmentBlobOf(messageId, attachmentId);
    if (item.state !== "ready" || !blob) {
      logAttachmentRefusal("bytes_failed");
      return { state: "failed", code: item.code ?? null, retryable: item.retryable !== false, status: item.status ?? null };
    }
    try {
      return { state: "ready", base64: await blobToBase64(blob), mime: item.mimeType, filename: item.filename };
    } catch {
      // The one non-engine failure: the byte read itself, ours and worth a second tap — the
      // tile's retry re-asks `openAttachment`, which short-circuits on the held Blob.
      logAttachmentRefusal("bytes_unreadable");
      return { state: "failed", code: "bytes_unreadable", retryable: true, status: null };
    }
  };

  const sweepFeed = async (view: FeedView, passedIds: string[]): Promise<boolean> => {
    const seen = swept.get(view) ?? new Set<string>();
    swept.set(view, seen);
    const reader = engine.read();
    const folder = FOLDER_OF_VIEW[view];
    const fresh: string[] = [];
    for (const id of passedIds) {
      if (seen.has(id)) continue;
      const m = reader.get<EngineMessage>("message", id);
      if (!m || m.folder !== folder) continue;
      seen.add(id); // read rows still anchor the leave commit; only unread ones are flipped
      if (m.unread) fresh.push(id);
    }
    if (fresh.length === 0) return true;
    // The registered promise is the WHOLE continuation, cache-prune included — so anything
    // that awaits the in-flight set (the leave commit) is guaranteed to observe the pool
    // AFTER a rollback has pulled its ids out, by structure rather than microtask order.
    const run = (async (): Promise<boolean> => {
      const ok = said(await watched(engine.mutate({ kind: "feed_mark_seen", view, messageIds: fresh })), null, refuse("liveSaveFailed"));
      if (!ok) {
        // The engine rolled the rows back to unread; the CACHE has to roll back with it, or
        // the ids are skip-listed (the flip never retried) and the leave commit can anchor
        // on a row that is still unread. The rows stay sweepable: the
        // next scroll event re-attempts them.
        for (const id of fresh) seen.delete(id);
      }
      return ok;
    })();
    let pending = inflight.get(view);
    if (!pending) {
      pending = new Set();
      inflight.set(view, pending);
    }
    pending.add(run);
    return run.finally(() => pending.delete(run));
  };

  const leaveFeed = async (view: FeedView): Promise<boolean> => {
    // CONSUME THE POOL FIRST, SYNCHRONOUSLY — the visit ends the moment leave is declared.
    // This call now also fires when the APP BACKGROUNDS (the feed tabs' AppState listener),
    // and a reader who returns seconds later starts a NEW visit; consuming after the await
    // below let that next visit's sweeps land in the pool this commit was about to anchor
    // from. Rollback reachability is unharmed: each in-flight sweep holds
    // THIS Set through its own closure (`sweepFeed`'s `seen`), so a failed flip still pulls
    // its ids out of the pool we are holding, whether or not the map still names it.
    const seen = swept.get(view);
    swept.delete(view);
    // THEN let the in-flight sweeps settle — their rollbacks edit the pool this commit is
    // about to anchor from, and anchoring earlier re-creates the failed-anchor defect one race
    // over. BOUNDED, because on the background path the runtime may be about to suspend: a
    // hung request awaited here forever is a waterline that never commits at all, and the
    // verb's own durability (the engine's outbox) only begins once it is dispatched. Past the
    // bound the commit anchors on the pool as it stands — the narrow rollback-after-anchor
    // exposure this trades for is the pre-await behaviour, taken only when the network has
    // already gone quiet for a second and a half.
    const pending = inflight.get(view);
    if (pending && pending.size > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.allSettled([...pending]),
        new Promise<void>((resolve) => { timer = setTimeout(resolve, LEAVE_SETTLE_DEADLINE_MS); }),
      ]);
      if (timer !== undefined) clearTimeout(timer);
    }
    if (!seen || seen.size === 0) return true; // nothing was on screen; the line holds still
    const reader = engine.read();
    // The anchor: the NEWEST swept row — "the newest message that was on screen when the
    // reader last left", the same waterline semantic every other client writes through.
    let anchor: EngineMessage | null = null;
    for (const id of seen) {
      const m = reader.get<EngineMessage>("message", id);
      if (!m) continue;
      const ms = m.date ? Date.parse(m.date) : 0;
      const held = anchor?.date ? Date.parse(anchor.date) : -1;
      if (anchor === null || ms > held) anchor = m;
    }
    if (anchor === null) return true;
    return said(
      await watched(engine.mutate({ kind: "feed_mark_seen", view, messageIds: [], upToId: anchor.id })),
      null, refuse("liveSaveFailed"),
    );
  };

  /**
   * A SCREENER DECISION IS HELD, WITH UNDO — the web Screener's delayed commit, on the phone's one
   * routing window: neither a decide nor a rule has a wire inverse, so the way back is not to send
   * it yet. The press says what it does, as the web's does, and the row leaves the shelf; the close
   * sends the decision re-read from the mirror ({@link planDecideCommit}), and its answer speaks
   * only where it differs — refused, sent to the organizer, or recorded for another install.
   * Nothing to hold it by (no session, a record that did not land): {@link decideNow}.
   */
  const decide = async (row: ScreenerRow, dest: Destination, read: boolean, scope: Scope): Promise<boolean> => {
    const rep = engine.read().get<EngineMessage>("message", row.id);
    const decision = decisionOf(dest as ScreenDest);
    const target = scope === "domain" ? `@${domainOf(row.address)}` : row.address;
    const intent: DecideIntent = {
      v: 3, verb: "decide", id: deps.uuid ? deps.uuid() : `${row.id}:${now().getTime()}`, seedId: row.id,
      address: row.address, scope, dest: dest as ScreenDest, read: read && decision === "yes",
      messageIds: row.held.map((h) => h.id), at: now().getTime(),
    };
    const decidedSaid = refuse("liveDecided", destDone(dest), target);
    const atGate = rep === undefined || physicalFolderOf(rep) === FOLDER_OF_VIEW.screener;
    const pressSaid = decidedUnsubscribes(atGate, decision) ? refuse("liveAlsoUnsubscribing", decidedSaid) : decidedSaid;
    let spoke = false;
    const hold = deps.leaveWaiting?.({ address: row.address, scope });
    const opened = await holdScreenRouting(intent, (a) => {
      // The read batch stays unwatched, as it always was: only the decision's own writes answer.
      const own = a.mutations.flatMap((m, i) => (m.kind === "mark_seen" ? [] : [a.answers[i] ?? null]));
      const v = oneVerdict(own.map((r) => (r ? pressVerdict(r) : PRESS_THREW)));
      if (v.kind === "applied") deps.forgetWaiting?.({ address: row.address, scope });
      hold?.();
      // A newer press about this sender replaced the decision: it owns the sentence.
      if (v.kind === "silent") return;
      if (v.kind === "refused") { toast(refuse("liveDecideFailed", row.address)); return; }
      if (v.kind === "queued" && v.wait === "organizer") {
        deps.relayedHere?.({ address: row.address, scope });
        toast(v.holder ? refuse("liveDecideSent", v.holder, target) : refuse("liveDecideSentUnknown", target));
        return;
      }
      const elsewhere = own.find((r) => r?.pendingWith)?.pendingWith ?? null;
      if (v.kind === "applied" && elsewhere) {
        toast(elsewhere.name ? refuse("liveDecidedElsewhere", elsewhere.name, target) : refuse("liveDecidedElsewhereUnknown", target));
        return;
      }
      if (!spoke) toast(pressSaid);
    });
    // Sent by the window itself (its record refused): the answer above speaks for the press.
    if (opened.sent) return true;
    if (!opened.held) { hold?.(); return decideNow(row, dest, read, scope); }
    spoke = true;
    const subject = routingSubject(intent);
    toast(pressSaid, {
      holdMs: UNDO_MS,
      /* ONE CLOCK: the pill's hold starts at its first layout, and so does the window's. */
      shown: () => { restartRouting(subject); },
      undo: () => {
        // Nothing held is not an undo: past the close the decision has gone and has no inverse.
        if (!undoRouting(subject)) { toast(refuse("liveDecideUndoLate")); return; }
        hold?.();
        toast(refuse("toastUndone"));
      },
    });
    return true;
  };

  /** The same decision with no window to hold it: sent now, and the sentence waits for the answer. */
  const decideNow = async (row: ScreenerRow, dest: Destination, read: boolean, scope: Scope): Promise<boolean> => {
    const raw = engine.read();
    const rep = raw.get<EngineMessage>("message", row.id);
    // Demote-stays-unread: filing to Screen out or Spam never carries a read verb.
    const readFlag = read && dest !== "screened" && dest !== "spam";
    // A derived row's spam verdict rides the NO branch — `yes` is the verb that ADMITS a
    // sender, and the server refuses `{decision:"yes", dest:spam}` outright (400).
    const decision: "yes" | "no" = dest === "screened" || dest === "spam" ? "no" : "yes";
    const target = scope === "domain" ? `@${domainOf(row.address)}` : row.address;

    /**
     * THE QUEUED ANSWER, kept rather than collapsed — see `liveDecidedElsewhere`.
     *
     * `watched` reduces a result to landed-or-not, which is right for every other verb here and
     * loses the one fact this one needs: on a mailbox another install organizes the server
     * RECORDS the decision and files nothing, and the toast has to say so. Resolved before the
     * sentence is chosen, so the optimistic toast below is the truthful one from the start rather
     * than a correction a second later.
     */
    let queuedWith: { name: string | null } | null = null;
    let landed: Promise<PressVerdict>;
    const decideRoute = rep === undefined || physicalFolderOf(rep) === FOLDER_OF_VIEW.screener;
    /** Releases a row the store backs from the shelf's hold once the answer is in. */
    let held: (() => void) | undefined;
    if (decideRoute) {
      /* A ROW THIS MIRROR DOES NOT BACK IS THE STORE'S: the queue is not windowed and the mirror
         is, so the decide goes to the store on the door the engine sends the representatives it
         served through, and only the engine may refuse one it never served. Such a row leaves
         the shelf at the press and comes back if the press does not land. */
      if (rep === undefined) held = deps.leaveWaiting?.({ address: row.address, scope });
      landed = engine.mutate({
        kind: "screener_decide",
        senderId: row.id,
        decision,
        dest: dest as ScreenDest,
        ...(decision === "yes" ? { read: readFlag } : {}),
        scope,
      }).then(
        (r) => {
          queuedWith = r.pendingWith ?? null;
          return pressVerdict(r);
        },
        () => PRESS_THREW,
      );
    } else {
      /* PAST THE GATE — the web's ladder (`screener-state.ts` → `planScreeningChange`) and this
         file's own sender sheet: the twins decide through `pressOverTwins`, which always leaves a
         rule in force with the past-mail answer, so the backlog is the server pass's and this
         press moves none of it (THE-CLIENTS-FIFTY): only the pass sees a reply or a hand filing. */
      const match = scope === "domain" ? domainOf(row.address).toLowerCase() : row.address.trim().toLowerCase();
      const { writes } = pressOverTwins(rulesList(raw), scope, match, FOLDER_OF_VIEW[dest as ScreenDest], true);
      landed = Promise.all(writes.map((w) => watched(engine.mutate(w)))).then(oneVerdict);
    }
    // "&read" stays a separate batch, exactly as the wire has it: `POST /screener/:id`
    // carries no read field, so the seen half is the same `PATCH /messages` everyone uses.
    // Deliberately unwatched (the webapp's one deliberate `void mutate`): the DECISION has
    // landed; only the seen flag on now-filed mail can be lost, which is visible where it
    // happened and undone by reading.
    if (decision === "yes" && readFlag && row.held.length > 0) {
      const ids = row.held.map((h) => h.id);
      for (let i = 0; i < ids.length; i += MARK_SEEN_CHUNK) {
        void engine.mutate({ kind: "mark_seen", messageIds: ids.slice(i, i + MARK_SEEN_CHUNK), unread: false });
      }
    }
    /* THE SENTENCE WAITS FOR THE ANSWER, and only this verb's does. Everywhere else the
       optimistic toast is raised first because the act is this machine's and the only question is
       whether the wire took it. Here the answer decides WHICH TRUE SENTENCE to say — filed, or
       recorded for another machine — and saying the wrong one first and correcting it is the
       shape of the defect rather than a smaller version of it. The wait is one round trip on a
       press that already blocks on nothing else. */
    const v = await landed;
    /* ══ AND THE SHELF FOLLOWS THE DECIDE, NOT THE NEXT DRAIN ══════════════════════════════
       Confirmed only — a queued press has not occurred and a refused one changed nothing, and
       retiring a row for either would be the same false state pointing the other way. Before
       the sentences below because both of them are true of a landed decide, including the one
       recorded for another install: the route filters a DECIDED sender out whoever files it. */
    if (v.kind === "applied") deps.forgetWaiting?.({ address: row.address, scope });
    held?.();
    /* THE DECIDE'S OWN QUEUED SENTENCE COMES FIRST, because it is the more specific one: a
       CONFIRMED decide against a mailbox somebody else organizes carries the holder on
       `pendingWith`, and that names the install as well as the wait. Everything else goes
       through the one speaker, which covers the rule_create arm this branch shares. */
    /* SENT, NOT DONE: the organizer applies it on its next pass, and the sender keeps a mark
       until it answers — so the sentence names the machine and the wait. */
    if (v.kind === "queued" && v.wait === "organizer") {
      deps.relayedHere?.({ address: row.address, scope });
      toast(v.holder ? refuse("liveDecideSent", v.holder, target) : refuse("liveDecideSentUnknown", target));
      return false;
    }
    const queued = queuedWith as { name: string | null } | null;
    if (v.kind === "applied" && queued !== null) {
      toast(queued.name ? refuse("liveDecidedElsewhere", queued.name, target) : refuse("liveDecidedElsewhereUnknown", target));
      return true;
    }
    const decidedSaid = refuse("liveDecided", destDone(dest), target);
    return said(
      v,
      decidedUnsubscribes(decideRoute, decision) ? refuse("liveAlsoUnsubscribing", decidedSaid) : decidedSaid,
      refuse("liveDecideFailed", row.address),
    );
  };

  const release = async (row: ScreenerRow, dest: Place, segment: "screened" | "spam"): Promise<boolean> => {
    // The RAW mirror on both reads: rules and physical folders are locations, and the
    // projected reader answers presentations (`presentationReader`'s own contract).
    const raw = engine.read();
    const segFolder = segment === "spam" ? FOLDER_OF_VIEW.spam : FOLDER_OF_VIEW.screened;
    const wanted = FOLDER_OF_VIEW[dest];
    const rules = releaseRules(raw, row.address, segFolder, wanted);
    if (rules.kind === "stands") {
      toast(refuse("liveReleaseRuleStands", row.address, rules.domain));
      return false;
    }
    const retargets = rules.mutations;
    // Moves cover ONLY mail physically in the segment's folder. Everything else is where the
    // rule change alone re-presents; a move for mail already at its destination is the
    // engine's local 404 with nothing sent — the deterministic half of the bare-move bug.
    const moveIds = row.held
      .map((h) => h.id)
      .filter((id) => raw.get<EngineMessage>("message", id)?.folder === segFolder);
    if (retargets.length === 0 && moveIds.length === 0) {
      // Nothing to dispatch cannot change what the reader is looking at; saying "released"
      // over it would drop the row under a toast about a release that never happened.
      toast(refuse("liveReleaseFailed", row.address));
      return false;
    }
    // One sentence per write, one true at a time: no rule, their own rule, or an address rule.
    const sentence = rules.kind === "address" ? refuse("liveReleasedAddress", row.held.length, destDone(dest), rules.domain)
      : rules.kind === "retarget" ? refuse("liveReleasedRuled", row.held.length, destDone(dest))
        : refuse("liveReleased", row.held.length, destDone(dest));
    /* THE LETTERS MOVE NOW and THE RULES ARE HELD for the undo window, as a Move's are: a rule
       mutation has no wire inverse, so the way back is to not send it yet (`held-routing.ts`).
       `retro`: a release's rule keeps the backlog pass the release has always made. */
    const letters: EngineMutation[] = moveIds.map((id) => ({ kind: "move", messageId: id, folder: wanted }));
    const inv = letters.flatMap((w) => inverseMutations(engine.verbRead(), w));
    const pressId = deps.uuid ? deps.uuid() : `${row.id}:${now().getTime()}`;
    const intent: PhoneMoveIntent = {
      v: 1, id: pressId, seedId: row.id, address: row.address, scope: "sender", dest: dest as ScreenDest,
      messageIds: moveIds, from: segFolder, found: segFolder, retro: true, at: now().getTime(),
    };
    const opened = retargets.length > 0 ? await holdRouting(intent) : { held: false, superseded: false, sent: false };
    const parts = letters.map((m) => dispatch(m));
    if (!opened.held) {
      if (!opened.sent) parts.push(...retargets.map((m) => dispatch(m)));
      toast(sentence, retargets.length === 0 ? undoable(inv) : undefined);
      return saidAll(await Promise.all(parts), null, refuse("liveReleaseFailed", row.address));
    }
    const subject = routingSubject(intent);
    toast(sentence, {
      holdMs: UNDO_MS,
      shown: () => { restartRouting(subject); },
      undo: () => {
        /* Replaced by a later press: nothing was sent, said so. Past the close: the rule has gone. */
        const outcome = undoRoutingPress(subject, pressId);
        if (outcome === "superseded") { undoReplaced(inv, wanted); return; }
        if (outcome !== "undone") { toast(refuse("liveDecideUndoLate")); return; }
        toast(refuse("toastRoutingUndone"));
        void Promise.all(inv.map((mu) => watched(engine.mutate(mu))));
      },
    });
    return saidAll(await Promise.all(parts), null, refuse("liveReleaseFailed", row.address));
  };

  const setPile = async (messageId: string, kind: PileKind): Promise<boolean> => {
    const state = kind === "replyLater" ? "reply_later" : kind === "setAside" ? "set_aside" : "bubbled_up";
    const m: EngineMutation = {
      kind: "triage_set",
      messageId,
      state,
      ...(kind === "resurface"
        ? { bubbleUpAt: tomorrowAt(now(), resurfaceAtClock(), zone).at.toISOString() }
        : {}),
    };
    // The inverse off the pre-press mirror; this arm speaks on the ANSWER, so the offer rides
    // the success sentence rather than an optimistic one.
    const opts = undoable(inverseMutations(engine.verbRead(), m));
    const ok = await dispatch(m);
    return said(ok, refuse("livePileAdded", pileTitle(kind)), refuse("livePileFailed", pileTitle(kind)), opts);
  };

  /* ── the open message's verbs ──────────────────────────────────────────────────────────── */

  const zone = deps.zone ?? readerZone();
  /* THE VERB READER — the mirror, a History or Search page — and the row the reader opened past
     its page: a verb on a store row goes through the one door exactly as on a mirror row. */
  const messageOf = (id: string): EngineMessage | undefined =>
    engine.verbRead().get<EngineMessage>("message", id) ?? (offMirror?.row.id === id ? offMirror.row : undefined);

  /**
   * ONE UNDO FOR EVERY VERB (the 0.20 review, the phone half) — the pill carries Undo wherever the
   * engine can build the wire's own reversal (`inverseMutations`, read BEFORE the dispatch).
   * Undo dispatches the inverses through the ordinary seam, so the overlay, the outbox and the
   * refusal vocabulary all apply — never a local state hack. Bounded by {@link UNDO_MS} and
   * consumed at most once: a late press takes nothing back and claims nothing (the Screener's
   * own rule). `[]` — no wire inverse, or a press that changes nothing — offers no verb.
   */
  const undoable = (inv: readonly EngineMutation[], leaving?: () => boolean): ToastOpts | undefined => {
    if (inv.length === 0) return undefined;
    const at = now().getTime();
    let fired = false;
    return {
      holdMs: UNDO_MS,
      undo: () => {
        if (fired || now().getTime() - at > UNDO_MS) return;
        fired = true;
        /* The cheapest and truest undo: the verb has not left the device, so claiming its latch
           cancels it and NOTHING is sent — see {@link oneShot}. Past that, the inverse rides the
           same chain and can no longer pass the verb it undoes. */
        if (leaving?.() === true) { toast(refuse("toastUndone")); return; }
        /* SAID AT THE PRESS, as the verbs say theirs: the overlay has already put the row back,
           and a refused or organizer-queued inverse overrides the sentence when it answers. */
        toast(refuse("toastUndone"));
        void Promise.all(inv.map((mu) => dispatch(mu))).then((vs) => {
          saidAll(vs, null, refuse("liveSaveFailed"));
        });
      },
    };
  };

  /**
   * A PRESS A LATER ONE REPLACED (PHONE-RULE-BRANCH-UNDO-SAYS-NOTHING-TO-UNDO): only its rule half was
   * replaced, so Undo moves back each letter still where this press put it and says so. A letter a
   * later press moved on is left where it is; with none left, there is nothing to undo.
   */
  const undoReplaced = (inv: readonly EngineMutation[], movedTo: string): void => {
    const stayed = (id: string) => engine.read().get<EngineMessage>("message", id)?.folder === movedTo;
    const back = inv.filter((mu) => "messageId" in mu && stayed(mu.messageId));
    if (back.length === 0) { toast(refuse("undoReplaced")); return; }
    toast(refuse("undoReplacedLetterBack"));
    /* In each letter's order, as every Undo: a press on it still in its slot goes first. */
    void Promise.all(back.map((mu) => dispatch(mu))).then((vs) => {
      saidAll(vs, null, refuse("liveSaveFailed"));
    });
  };

  /**
   * One triage write, stated in the webapp's own sentence. The toast is spoken on the
   * OPTIMISTIC apply (the webapp's shape — the sentence is the act), and a rollback overrides
   * it with the one failure sentence. The pill carries the way back: the inverse is read off
   * the PRE-PRESS mirror, the state this press is about to leave.
   */
  /** The person's OWN mail — the Sent role, or a sender among the account's own addresses. */
  const isOwn = (id: string): boolean => {
    const m = messageOf(id);
    if (!m) return false;
    if (isOwnSent(m)) return true;
    const from = m.from.address.trim().toLowerCase();
    return (deps.ownAddresses?.() ?? []).some((a) => a.trim().toLowerCase() === from);
  };
  /**
   * The messages a folded row's verb acts on: the open target first, then the rest, each once.
   * Junk, Later and Done never touch mail the person sent (a conversation answered from here
   * holds the reply), so `own: false` drops it; the read slot marks every member, as the web's
   * pick of a row does (OhboxView's `runBulk`, read over the whole pick by shell-verbs'
   * `onBulkAction`). A row that is all own mail acts on its target.
   */
  const membersOf = (id: string, members?: readonly string[], opts: { own?: boolean } = {}): string[] => {
    const all = [...new Set([id, ...(members ?? [])])];
    if (members === undefined || opts.own === true) return all;
    const theirs = all.filter((x) => !isOwn(x));
    return theirs.length > 0 ? theirs : [id];
  };

  const triage = async (
    messageId: string,
    state: "none" | "reply_later" | "set_aside" | "bubbled_up" | "resurfaced",
    say: RefusalArg,
    bubbleUpAt?: string,
    members?: readonly string[],
  ): Promise<boolean> => {
    const ms: EngineMutation[] = membersOf(messageId, members)
      .map((id) => ({ kind: "triage_set", messageId: id, state, ...(bubbleUpAt ? { bubbleUpAt } : {}) }));
    /* THE SENTENCE IS PAINTED BEFORE THE MIRROR MOVES. `mutate()` publishes before its first
       await, so spoken in the same turn the pill's state and the mirror's change land in ONE
       React pass — and every mirror reader re-renders in that pass. Measured on the 18 Pro
       (FIX-022, 2026-09-21): a Park in the reader showed its pill 3–5 s after the tap, the same
       moment the triage POST left the device, over a 2 157-row list. One turn lets React commit
       the pill alone first; the act is read off the pre-press mirror above and lands unchanged.
       The wait now happens INSIDE the message's chain slot, taken at the press: that is the
       window an Undo cancels, and the window nothing else for this message may overtake. */
    const pre = engine.verbRead();
    const inv = ms.flatMap((m) => inverseMutations(pre, m));
    const leaving = oneShot();
    toast(say, undoable(inv, leaving));
    return gatedSaid(messageId, ms, painted(), leaving);
  };

  /**
   * THE TOGGLE IS READ OFF THE MEMBERS IT WRITES (PHONE-OWN-FACED-ROW-TOGGLE-READS-THE-OWN-REPLY):
   * it switches off only where every one already holds the state, else on for those that do not,
   * so the sentence names the change made. A row faced by the person's own reply never reads it,
   * and the press holds the slot of the first letter it writes, never the reply's.
   */
  const pileToggle = async (
    messageId: string, kind: "replyLater" | "setAside", members?: readonly string[],
  ): Promise<boolean> => {
    const state = kind === "replyLater" ? "reply_later" : "set_aside";
    const reader = engine.read();
    const targets = membersOf(messageId, members).filter((id) => messageOf(id) !== undefined);
    if (targets.length === 0) return false;
    const holds = (id: string) => triageStateOf(reader, messageOf(id)!) === state;
    const off = targets.every(holds);
    const changed = off ? targets : targets.filter((id) => !holds(id));
    const say = refuse(kind === "replyLater" ? (off ? "toastUnqueued" : "toastQueued") : (off ? "toastUnparked" : "toastAside"));
    return triage(changed[0]!, off ? "none" : state, say, undefined, changed);
  };

  const resurfaceAt = (messageId: string, iso: string): Promise<boolean> =>
    triage(messageId, "bubbled_up", refuse("toastResurface", setTimeLabel(iso, now(), zone)), iso);

  const resurfaceToggle = async (messageId: string): Promise<boolean> => {
    const m = messageOf(messageId);
    if (!m) return false;
    // A message already scheduled: the horizon-less verb CLEARS the booking rather than
    // silently re-dating it — the webapp's `resurface` arm, verbatim in intent.
    if (triageStateOf(engine.read(), m) === "bubbled_up") return triage(messageId, "none", refuse("toastResurfaceCleared"));
    return resurfaceAt(messageId, tomorrowAt(now(), resurfaceAtClock(), zone).at.toISOString());
  };

  const resurfaceNow = (messageId: string): Promise<boolean> =>
    triage(messageId, "resurfaced", refuse("toastResurfaceNow"));

  const markSeen = async (messageId: string, unread: boolean, members?: readonly string[]): Promise<boolean> => {
    // No `via`: this is the deliberate read, the one that spends a resurface pin on both sides
    // of the wire — the opposite of the open's glance and the streams' sweep. The sentence is
    // new with the undo (the 0.20 review): the flip is visible, but the pill is where the way back
    // lives, and a verb whose undo has no surface is a verb with no undo.
    // Chunked at the route's cap both ways, the press and its Undo (a conversation's set can be wide).
    const ids = membersOf(messageId, members, { own: true });
    const m: EngineMutation = { kind: "mark_seen", messageIds: ids, unread };
    const inv = chunkMarkSeen(inverseMutations(engine.verbRead(), m));
    if (ids.length <= MARK_SEEN_CHUNK) {
      return said(
        await dispatch(m),
        refuse(unread ? "toastUnread" : "toastRead"), refuse("liveSaveFailed"),
        undoable(inv),
      );
    }
    // Over the cap: each chunk's inverse read before the first dispatch, so a press that partly
    // lands offers an Undo for exactly the chunks that landed and says how many.
    const pre = engine.verbRead();
    const chunks: string[][] = [];
    for (let i = 0; i < ids.length; i += MARK_SEEN_CHUNK) chunks.push(ids.slice(i, i + MARK_SEEN_CHUNK));
    const invs = chunks.map((c) => chunkMarkSeen(inverseMutations(pre, { kind: "mark_seen", messageIds: c, unread })));
    const vs = await Promise.all(chunks.map((c) => dispatch({ kind: "mark_seen", messageIds: c, unread })));
    const landed = vs.map((v) => v.kind !== "refused");
    const done = chunks.filter((_, i) => landed[i]).reduce((n, c) => n + c.length, 0);
    if (done > 0 && done < ids.length && !unread) {
      toast(refuse("toastReadPartial", done, ids.length), undoable(invs.filter((_, i) => landed[i]).flat()));
      return false;
    }
    return saidAll(vs, refuse(unread ? "toastUnread" : "toastRead"), refuse("liveSaveFailed"), undoable(inv));
  };

  const markGlanced = async (ids: readonly string[]): Promise<boolean> => {
    if (ids.length === 0) return true;
    const parts: Promise<PressVerdict>[] = [];
    for (let i = 0; i < ids.length; i += MARK_SEEN_CHUNK) {
      parts.push(dispatch({ kind: "mark_seen", messageIds: ids.slice(i, i + MARK_SEEN_CHUNK), unread: false, via: "glance" }));
    }
    return saidAll(await Promise.all(parts), null, refuse("liveSaveFailed"));
  };

  /**
   * MARK ALL READ — see {@link LiveWorldActions.markAllSeen}. The inverse is read BEFORE the
   * dispatch, off the pre-press mirror, and chunked like the press itself: `inverseMutations`
   * answers only the ids this press actually flips (mail already read stays read under Undo)
   * plus the re-pin for every resurfaced pin the deliberate read spends. The sentence is
   * optimistic (the webapp raises its toast at the press), and only the count it names rides
   * it — never an id, never an address.
   */
  const markAllSeen = async (ids: string[], feed?: { place: FeedView; upToId: string }): Promise<boolean> => {
    const inv = chunkMarkSeen(inverseMutations(engine.verbRead(), { kind: "mark_seen", messageIds: ids, unread: false }));
    const parts: Promise<PressVerdict>[] = [];
    for (let i = 0; i < ids.length; i += MARK_SEEN_CHUNK) {
      parts.push(watched(engine.mutate({ kind: "mark_seen", messageIds: ids.slice(i, i + MARK_SEEN_CHUNK), unread: false })));
    }
    /* The waterline commit rides the SAME press (the webapp's ReadsView shape): an empty
       `messageIds` with the anchor alone, so a fresh-only stream ("2 new", nothing unread)
       still has a control that clears its line. No undo on this half — the line moves once. */
    if (feed !== undefined) {
      parts.push(watched(engine.mutate({ kind: "feed_mark_seen", view: feed.place, messageIds: [], upToId: feed.upToId })));
    }
    if (ids.length > 0) toast(refuse("markAllDone", ids.length), undoable(inv));
    if (parts.length === 0) return true;
    return saidAll(await Promise.all(parts), null, refuse("liveSaveFailed"));
  };

  const resurfaceDone = async (messageId: string, members?: readonly string[]): Promise<boolean> => {
    const m = messageOf(messageId);
    if (!m) return false;
    const ids = membersOf(messageId, members);
    // A SCHEDULED message's release has an extra half: the booking is cleared first (the same
    // un-triage the toggles use), then the same deliberate read files it under Earlier.
    /* Both halves' inverses, off the pre-press mirror — the webapp release's own composition:
       the deliberate read's (re-pin a spent pin, unread back) and the booking clear's (re-book
       at its own date). A row is pinned OR booked, never both, so the reads cannot overlap. */
    const pre = engine.verbRead();
    const bookedIds = ids.filter((id) => { const x = messageOf(id); return x !== undefined && triageStateOf(pre, x) === "bubbled_up"; });
    const inv = [
      ...inverseMutations(pre, { kind: "mark_seen", messageIds: ids, unread: false }),
      ...bookedIds.flatMap((id) => inverseMutations(pre, { kind: "triage_set", messageId: id, state: "none" })),
    ];
    // Spoken FIRST and mounted alone (`paintFirst`), like every optimistic verb; the inverses
    // above were read off the pre-press mirror, so the order of the two changes nothing they say.
    const leaving = oneShot();
    toast(refuse("toastResurfaceDone"), undoable(inv, leaving));
    // Both halves in the ONE slot and in order: the booking clears before the read lands.
    const read: EngineMutation = { kind: "mark_seen", messageIds: ids, unread: false };
    const clears: EngineMutation[] = bookedIds.map((id) => ({ kind: "triage_set", messageId: id, state: "none" }));
    return gatedSaid(messageId, [...clears, read], painted(), leaving);
  };

  /** The reader the Ohbox is drawn from — see {@link LiveDeps.presented}. */
  const presentedReader = (): EntityReader => deps.presented?.() ?? engine.read();

  /** Is the second send action offered for this source? The ENGINE's rule, nothing local. */
  const sendAndDoneOffered = (messageId: string): boolean =>
    sendAndDonePlanFor(presentedReader(), messageId) !== null;

  /**
   * SEND + DONE — the INTENT, read at the press and carried by the send's own outbox row: the
   * source and the members the press saw. The release and its Undo are read when the send is
   * confirmed (`releaseConfirmed`). An appointment finishes nothing (`sendAt` is mail still on
   * the account).
   */
  const donePlan = (messageId: string, andDone: boolean): SendAndDonePlan | null => {
    const offered = andDone ? sendAndDonePlanFor(presentedReader(), messageId) : null;
    return offered === null ? null : intentOf(offered, messageId);
  };

  /**
   * THE RELEASE, ON EVERY ROAD THAT CONFIRMS A SEND — the press, its own flush, the reconnect
   * flush and Try again on the strip each pass the results the engine HANDED them. A confirmed
   * `mail_send` carrying an intent is released as the Ohbox on screen reads NOW (`releasePlanAt`);
   * nothing to release is no sentence and no Undo. `released` holds the one case where two
   * callers share a result — Try again pressed twice joins the first retry.
   */
  const released = new WeakSet<MutationResult>();
  const releaseConfirmed: ReleaseConfirmed = async (results) => {
    const said = new Map<string, DoneSaid>();
    for (const r of results) {
      if (r.status !== "confirmed" || r.andDone === undefined || released.has(r)) continue;
      released.add(r);
      const release = releasePlanAt(presentedReader(), r.andDone);
      if (release === null) continue;
      /* The row's own Done door — `engine.mutate` through the watched seam, exactly as
         `resurfaceDone` dispatches it. A refused step files nothing more and earns no sentence. */
      const filed = await applySendAndDone(release, async (m) => (await watched(engine.mutate(m))).kind === "applied");
      if (filed) said.set(r.key, { say: refuse("toastSentAndDone"), opts: undoable(release.undo) });
    }
    return said;
  };

  /**
   * ALREADY ASKED FOR? The sentence for a message whose press is still waiting on the install
   * that organizes the mailbox, or `null` when nothing of ours is waiting on it. Pressing again
   * is answered rather than dispatched: a second request would change nothing and the first is
   * still the truth. Past the engine's stated bound the wait gets its own words — the request is
   * no less pending for being slow, which is why the sentence changes and nothing else does.
   */
  const stillWaitingFor = (messageId: string): Refusal | null => {
    // The merged list (the server's record and this session's), so a relaunch still answers it.
    const waiting = engine.waitingOnOrganizer().find((r) => r.messageId === messageId && r.state !== "refused");
    if (!waiting) return null;
    const holder = waiting.holder.name;
    if (!waiting.slow) return null;
    return holder ? refuse("organizerStillWaiting", holder) : refuse("organizerStillWaitingUnknown");
  };

  /**
   * MOVE — the place a pile shows is the sender's ROUTING, and the sentence comes from the ANSWER.
   *
   * A newsletter presented in Reads sits in the INBOX, so a bare INBOX→INBOX move is a local 404
   * with nothing sent: what gets retargeted is the rules holding this sender at the PRESENTED
   * place, which rides in on the row — this module's reader is the raw mirror and cannot tell it
   * from the filed folder. Where this phone only READS the server answers 202 and nothing has
   * moved, so "Moved" would be false; `watched` loses that fact, so the answers are awaited raw,
   * as `liveDecidedElsewhere` already does.
   */
  const move = async (pressed: WorldMail, dest: MoveTarget, members?: readonly string[]): Promise<boolean> => {
    /* A FOLDED ROW FACED BY THE PERSON'S OWN REPLY moves the conversation's other mail and decides
       that sender's rule, never a rule for the person's own address (`membersOf`). */
    const seat = membersOf(pressed.id, members)[0]!;
    const row: WorldMail = seat === pressed.id ? pressed : {
      ...pressed, id: seat,
      presentedFolder: presentedReader().get<EngineMessage>("message", seat)?.folder ?? pressed.presentedFolder,
    };
    const messageId = row.id;
    // The RAW mirror for the LOCATION, exactly as `release` reads it: a move is about where the
    // mail actually is. The PRESENTED place is the caller's, because only the projection knows
    // it — `messageOf` reads raw rows too (the mirror's, or a page's), so reading it for both made the two values
    // one and the retarget landed on the filed folder (measured at the K32 landing).
    const raw = engine.read();
    const m = messageOf(messageId);
    const folder = FOLDER_OF_VIEW[dest];
    if (!m || !folder) {
      toast(refuse("liveSaveFailed"));
      return false;
    }
    /* The plan as DATA first: nothing reaches `engine.mutate` until the list is known non-empty
       and no request of ours is still waiting on the organizer for this message. The move goes
       LAST so that, reading back, it is the first queued answer found and names its own holder. */
    const routing = row.presentedFolder === folder ? null : releaseRules(raw, m.from.address, row.presentedFolder, folder);
    // A DOMAIN rule this sender cannot be moved out from under: said, and nothing is sent.
    if (routing?.kind === "stands") {
      toast(refuse("liveReleaseRuleStands", m.from.address, routing.domain));
      return false;
    }
    const writes: EngineMutation[] = routing ? withoutBacklog(routing.mutations) : [];
    if (m.folder !== folder) writes.push({ kind: "move", messageId, folder });
    /* A FOLDED ROW MOVES ITS WHOLE CONVERSATION; the rule is the open letter's sender's. */
    for (const id of membersOf(messageId, members)) {
      if (id === messageId) continue;
      const other = raw.get<EngineMessage>("message", id);
      if (other !== undefined && other.folder !== folder) writes.push({ kind: "move", messageId: id, folder });
    }
    // Nothing to dispatch means the mail is already in the place it was asked for, rules and all.
    // Said rather than swallowed: a press that returns in silence is the defect this arm had.
    if (writes.length === 0) {
      toast(refuse("toastMoveAlready", moveTargetLabel(dest)));
      return false;
    }
    const waiting = stillWaitingFor(messageId);
    if (waiting) { toast(waiting); return true; }
    /* THE TWO HALVES. The mail moves now and the engine builds its reversal; the rules that
       decide where this sender's mail goes from here are HELD for the undo window — no rule
       mutation has a wire inverse, so the way back is to not send it yet (`held-routing.ts`).
       Junk rides this arm, so a spam filing is undone exactly like any other Move. */
    const rules = writes.filter((w) => w.kind !== "move");
    const mail = writes.filter((w) => w.kind === "move");
    const inv = mail.flatMap((w) => inverseMutations(engine.verbRead(), w));
    const pressId = deps.uuid ? deps.uuid() : `${messageId}:${now().getTime()}`;
    const subject = routingSubject({ scope: "sender", address: m.from.address });
    /* THE PRESS IS ON DISK BEFORE ANYTHING SHOWS OR LEAVES, rule or none: its place is drawn once
       the record has landed, and the letter's move carries the press id as its Idempotency-Key.
       A letter's move alone was only an outbox row, written through the mirror's one lane after
       the letter was already drawn at its place, so a kill before that row lost a Move the
       screen had shown. Held first, the launch finishes both halves once and says so. */
    const intent: PhoneMoveIntent = {
      v: 1,
      id: pressId,
      seedId: messageId,
      address: m.from.address,
      scope: "sender",
      dest: dest as ScreenDest,
      messageIds: membersOf(messageId, mail.map((w) => (w as { messageId: string }).messageId)),
      from: row.presentedFolder,
      found: m.folder,
      ...(rules.length === 0 ? { holdsRule: false as const } : {}),
      at: now().getTime(),
    };
    /* A Move that decides no rule never replaces a held press about the same sender: the window
       keeps one press per sender, and dropping a held rule for a letter's move would lose it. */
    const opened = rules.length === 0 && heldOn(subject)
      ? { held: false, superseded: false, sent: false }
      : await holdRouting(intent);
    /* RAW answers, never `watched`: it folds `awaiting_organizer` into landed-or-not, and on a
       mailbox this phone only reads EVERY write here comes back that way (`move` is named in the
       202 census). Folding them would say "Moved" over a move nobody made. */
    /* A flush while the record landed (the app leaving) has already sent the letter from the
       window under this key; a second send would read as a refusal of a Move that was made. */
    const unsent = mail.filter((w) => w.kind !== "move" || engine.read().get<EngineMessage>("message", w.messageId)?.folder !== w.folder);
    const answers = await Promise.all(
      unsent.map((w) => inMessageOrder(w, () => engine.mutate(w, { key: pressId }).catch((): MutationResult | null => null))),
    );
    /* A letter that did not move takes its rule with it: the press is one decision. */
    const dropHeld = (): void => { if (opened?.held) undoRouting(subject); };
    if (answers.some((r) => r === null || r.status === "rolled_back")) {
      dropHeld();
      toast(refuse("liveSaveFailed"));
      return false;
    }
    /* A NEWER PRESS FOR THESE LETTERS REPLACED THIS ONE (on the wire, or refused stale behind a
       newer decision): the newer press owns the sentence, so this one says nothing. */
    if (answers.length > 0 && answers.every((r) => r?.status === "superseded")) return true;
    /* THE PRESS ASKS FOR THE WIRE: the organizer in this process drains now rather than at its
       next poll (`withPullKick`). Once per press, never awaited by the sentence; never throws. */
    if (unsent.length > 0) void engine.requestPull({ mailboxIds: [m.mailboxId] });
    const queued = [...answers].reverse().find((r) => r?.status === "awaiting_organizer");
    const holder = queued?.queuedWith?.name ?? null;
    /* THE LETTER WAITS ON THE ORGANIZER AND, WHERE THE PRESS DECIDES THE SENDER, ITS RULE GOES TOO
       (the web's shape): the held routing commits at the window's close and travels as a rule
       request, below, like any Move's. A press that decides no rule says the letter alone. */
    if (queued && rules.length === 0) {
      /* Two calls rather than one with a spread: each sentence is passed exactly its own
         arguments, which is what `refusal.test.ts` reads out of this file's source. */
      toast(holder
        ? refuse("toastMoveQueued", moveTargetLabel(dest), holder)
        : refuse("toastMoveQueuedUnknown", moveTargetLabel(dest)));
      return true;
    }
    if (rules.length === 0) {
      /* Its Undo takes the record back with the letter: a window left open would find the letter
         where the press found it and move it again. One clock, as below. */
      const back = undoable(inv);
      toast(refuse("toastMoved", moveTargetLabel(dest)), back && opened?.held ? {
        ...back,
        shown: () => { restartRouting(subject); },
        undo: () => {
          /* A later press about this sender holds the window now; this press decided no rule, so
             its Undo is the letter's own way back and leaves the later press alone. */
          undoRoutingPress(subject, pressId);
          back.undo?.();
        },
      } : back);
      return true;
    }
    /* A PRESS THAT DECIDES THE SENDER SAYS SO, in the web's words (`screeningToast`): the letter
       moved and their future mail follows, or — the letter already filed there — the rule alone. */
    const who = m.from.name?.trim() || m.from.address;
    const queuedSaid = holder
      ? refuse("toastMoveQueuedWithRule", moveTargetLabel(dest), holder)
      : refuse("toastMoveQueuedWithRuleUnknown", moveTargetLabel(dest));
    const decides = queued ? queuedSaid
      : mail.length > 0
        ? refuse("toastRuledMoved", moveTargetLabel(dest), mail.length, who)
        : refuse("toastRuledFuture", moveTargetLabel(dest), who);
    if (!opened?.held) {
      /* NO SESSION OR NO RECORD TO HOLD IT BY — the rules go now unless the window already sent
         them, and the sentence does not offer an undo it cannot honour. */
      if (!opened?.sent) await Promise.all(rules.map((w) => engine.mutate(w).catch(() => null)));
      toast(decides);
      return true;
    }
    toast(decides, {
      holdMs: UNDO_MS,
      /* ONE CLOCK: the pill's hold starts at its first layout, and so does the window's. */
      shown: () => { restartRouting(subject); },
      undo: () => {
        /* BOTH HALVES, ONE DECISION, made synchronously: a window still holding the press cancels
           the rule before it is sent; a press already committed (a flush on leaving) is taken
           back by its rules' inverse, sent once the commit has answered. `cancelled` also picks
           the sentence, so a late press cannot say no rule was made over a rule that was. */
        const outcome = undoRoutingPress(subject, pressId);
        /* A later press about this sender replaced this one: the latest rule wins, and says so. A
           letter queued for the organizer has no way back from here (below). */
        if (outcome === "superseded") {
          if (queued) toast(refuse("undoReplaced"));
          else undoReplaced(inv, folder);
          return;
        }
        const cancelled = outcome === "undone";
        const ruleBack = cancelled ? null : takeRoutingReversal(pressId);
        /* A LETTER QUEUED FOR THE ORGANIZER has no way back from here: its request stands, and
           only the rule is taken back. Said so, and no reversal of the letter is sent. */
        if (queued && cancelled) {
          toast(holder ? refuse("toastQueuedRuleUndone", holder) : refuse("toastQueuedRuleUndoneUnknown"));
          return;
        }
        // At the press, as `undoable` says it; a refusal overrides it when the inverse answers.
        toast(refuse(cancelled ? "toastRoutingUndone" : "toastUndone"));
        void Promise.all(inv.map((mu) => watched(engine.mutate(mu)))).then(async (vs) => {
          const back = ruleBack ? await ruleBack : [];
          const rs = await Promise.all(back.map((mu) => watched(engine.mutate(mu))));
          saidAll([...vs, ...rs], null, refuse("liveSaveFailed"));
        });
      },
    });
    return true;
  };

  /**
   * DELETE. The tombstone drops the row at the press (the engine's optimistic effect); the
   * SENTENCE waits for the answer, because there are three of them — deleted, recorded for the
   * organizer, refused — and only the first is "In den Papierkorb verschoben." A rejection (422
   * `no_trash_folder`, a 404) restores the row and says so. No `via`, no read verb: a delete is
   * not a read, and the pin arithmetic is the engine's (`spentResurface` rides the same mutation
   * effects).
   */
  const deleteMessage = async (messageId: string, opts?: { quiet?: boolean }): Promise<boolean> => {
    const m = messageOf(messageId);
    if (!m) return false;
    const waiting = stillWaitingFor(messageId);
    if (waiting) { toast(waiting); return true; }
    // The same door as `move`: a reader's delete is a REQUEST, and "In den Papierkorb
    // verschoben." over a message still in place is the sentence this arm exists to stop.
    const gone: EngineMutation = { kind: "message_delete", messageId };
    const res = await inMessageOrder(gone, () => engine.mutate(gone).catch(() => null));
    if (res?.status === "awaiting_organizer") {
      const holder = res.queuedWith?.name ?? null;
      toast(holder ? refuse("toastDeleteQueued", holder) : refuse("toastDeleteQueuedUnknown"));
      return true;
    }
    if (!res || res.status === "rolled_back") { toast(refuse("deleteFailed")); return false; }
    // A newer press for this message replaced the delete: that press owns the sentence.
    if (res.status === "superseded") return true;
    // `quiet` is the held window's commit (the pill said "Moved to Trash." at the press) — it
    // suppresses ONLY the confirmed sentence; refusal and queued speak above whatever happens.
    if (!opts?.quiet) toast(refuse("toastDeleted"));
    return true;
  };

  /**
   * TRASH — the off-mirror page, projected HERE so the screen stays logic-free: the deletion
   * stamp in the reader's clock and language, the restore target as the word the move panel
   * would use. `place` is the row shape's obligation, not a claim — no list groups by it here.
   */
  const toTrashRow = (r: TrashRowWire): WorldTrashRow => {
    const deletedWhen = r.trashedAt
      ? messageDisplayTime({ date: r.trashedAt }, now(), zone, deps.locale?.() ?? "en")
      : null;
    return {
      mail: {
        id: r.id,
        place: "ohbox",
        from: { name: r.from.name || r.from.address, address: r.from.address },
        subject: r.subject,
        time: deletedWhen ?? "",
        body: "",
        snippet: r.snippet,
        unread: presentsUnread(r),
        ...(r.amount ? { amount: r.amount } : {}),
        ...(r.protected ? { protected: r.protected as Mail["protected"] } : {}),
        earlier: [],
      },
      deletedWhen,
      restoreLabel: trashRestoreLabel(r.restoreTo && r.restoreTo !== "" ? r.restoreTo : "INBOX"),
    };
  };

  const trashList = async (cursor: string | null): Promise<WorldTrashPage> => {
    const out = await engine.listTrash({ limit: TRASH_PAGE_LIMIT, ...(cursor ? { cursor } : {}) });
    if (out.state === "unavailable") return { state: "unavailable" };
    if (out.state === "failed") {
      /* THE CODE, NOT THE REASON. This read `"payment_required"`, which is the 402's `details.reason`
         — the gate's ENVELOPE code has always been `subscription_required`, so the arm matched
         nothing and the one server sentence written for the person holding the mailbox was
         withheld on every refusal. The wall owns this fact now (`net/access-lock.ts` raises it from
         the same answer), so this is the sentence in the frame before the wall paints; every other
         server message is still a log line and withheld. */
      return { state: "failed", say: out.code === ACCESS_REFUSED_CODE ? out.error : null };
    }
    return { state: "ready", items: out.items.map(toTrashRow), nextCursor: out.nextCursor };
  };

  /**
   * The restore stays PENDING on the mail server (the engine's own contract), so the sentence
   * is "Restoring to …" — the webapp's exact toast — never "restored". The intent id makes a
   * double press one request end to end (the engine builds `restore:<intent>:<id>` as the
   * Idempotency-Key); without a uuid source the request simply carries no key, as the engine
   * documents.
   */
  const trashRestore = async (messageId: string): Promise<boolean> => {
    const intent = deps.uuid?.();
    const res = await engine.restoreFromTrash(messageId, intent ? { intentId: intent } : {});
    if (res.state === "restored") {
      toast(refuse("trashToastRestoring", trashRestoreLabel(res.restoreTo)));
      return true;
    }
    toast(refuse(res.state === "rolled_back" ? "trashToastRestoreFailed" : "trashUnavailable"));
    return false;
  };

  /**
   * A send's three honest outcomes — narrower than {@link watched}, deliberately. For triage
   * and moves a standing `queued` view is truthful; for a send, "Reply sent." on a queued send
   * claims a delivery that has not happened. So `confirmed` alone says sent. `queued` first
   * retries once, right here (`flushPending` re-dispatches under the same Idempotency-Key, so
   * the retry cannot double-deliver); still queued, the caller keeps its composer open in a
   * locked queued state — the engine's queue is memory-only, so the text on screen and the
   * queued intent die together (an app kill sends nothing the reader was not shown), and the
   * locked Send keeps a fresh-key duplicate impossible while the reconnect flush retries.
   */
  const sent = async (
    p: Promise<MutationResult>,
    sentToast: RefusalArg,
    earlierWentToast: RefusalArg,
    /** `false` for a caller that says a refused send in its own place (the Drafts card). */
    sayRefusals = true,
  ): Promise<SendResult> => {
    const first = await p.then((r) => r, () => null);
    let settled: MutationResult | null = first;
    /* SEND + DONE's release OWNS the sentence when it files: one press says one thing, rather
       than "Reply sent." replaced a beat later. A send still queued leaves it to the road that
       confirms it (the reconnect flush), which says it there. */
    let done: ReadonlyMap<string, DoneSaid> = new Map();
    if (first && first.status === "queued") {
      // The flush replays the WHOLE queue; only THIS send's own result — matched by the
      // Idempotency-Key the first dispatch minted — may settle this send. An unrelated
      // mutation confirming is not this message delivering.
      const flushed = await engine.flushPending().catch(() => []);
      done = await releaseConfirmed(flushed);
      keepStrays(engine, flushed, first.key, done);
      settled = flushed.find((r) => r.key === first.key) ?? first;
    } else if (first && first.status === "confirmed") {
      done = await releaseConfirmed([first]);
    }
    const outcome = sendOutcomeOfResult(settled);
    // Replaced on the wire by a newer press under this key: that press says the one sentence.
    if (outcome === "superseded") return { outcome };
    /* The 202 is said once, then later answers for the key are `in_flight`: either one counts. */
    const accepted = outcome === "queued" && (sendAccepted(first) || sendAccepted(settled));
    /**
     * WHICH MESSAGE THIS CONFIRMATION IS ABOUT. A press that resumed a standing key is answered
     * from the first reservation when there is one — never two copies — and when its changed words
     * were kept back the words that left are the earlier ones: the server's answer says so.
     */
    const earlierWent = outcome !== "queued" && earlierVersionWent(settled);
    const said = first ? done.get(first.key) : undefined;
    if (said) toast(said.say, said.opts);
    // A waiting send that will not carry these words says so, never "goes when it is back".
    else if (outcome === "queued" && earlierVersionGoing(settled)) toast(refuse("earlierGoing"));
    else if (outcome === "sent" || sayRefusals) {
      toast(
        outcome === "sent" ? (earlierWent ? earlierWentToast : sentToast)
          : outcome === "queued"
            ? refuse(accepted ? "replySendingLong" : networkNow() === "offline" ? "replyQueuedOffline" : "replyQueued")
            : outcome === "unverified" ? refuse("replyUnverified")
              : refusedSendSay(failedSendCopy(settled)),
      );
    }
    return {
      outcome,
      ...(outcome === "queued" && first ? { key: first.key } : {}),
      ...(outcome === "failed" && settled?.entityId ? { draftId: settled.entityId } : {}),
      ...(outcome === "failed" ? { failure: failedSendCopy(settled) } : {}),
      ...(accepted ? { accepted: true as const } : {}),
    };
  };

  /** Two Send + Done intents are one when they name the same source and members; two plain Sends are one. */
  const sameIntent = (a: SendAndDonePlan | null, b: SendAndDonePlan | null): boolean => {
    if (a === null || b === null) return a === b;
    const ids = (x: SendAndDonePlan): string => [...x.messageIds].sort().join("\n");
    return a.source === b.source && ids(a) === ids(b);
  };

  /**
   * ONE INTENT, ONE KEY, FOR AS LONG AS IT IS RETRYABLE. A send still standing on the queue for
   * this intent — a tunnel, or a killed app whose durable row this session restored — already
   * carries the key it was expressed under, so a second press RESUMES it instead of minting a
   * fresh one: same key, same request, and the server's own same-key branch decides whether that
   * mail has gone. A fresh key there is a second copy in somebody's inbox, which is the whole
   * defect. Standing means queued OR on the wire: a send in the air resumes its key too, the queue
   * read first because a queued twin holds the newest words. Nothing standing ⇒ `mutate` mints.
   */
  const dispatchSend = (m: EngineMutation, andDone: SendAndDonePlan | null = null): Promise<MutationResult> => {
    const intent = sendIntentOf(m);
    // Queued or on the wire, and not a send already confirmed and kept for its echo.
    const standing = intent === null
      ? undefined
      : [...engine.pendingMutations(), ...engine.inFlightMutations()]
        .find((p) => joinableStandingSend(p) && sendIntentOf(p.mutation) === intent);
    /* WITH NO NETWORK, THE SAME WORDS PRESSED AGAIN ARE THE SEND THAT WAITS. A second row under
       the key would be replayed on the return after the first had gone, and each replay writes a
       draft of its own (`send-waits.ts`). Different words, or Send + Done pressed over a plain
       Send (or back), take the resume below: the latest press decides, under the same key. */
    if (standing !== undefined && networkNow() === "offline" && !sendTextDiffers(standing.mutation, m)
      && sameIntent(standing.andDone ?? null, andDone)) {
      return Promise.resolve({ id: standing.id, key: standing.key, status: "queued", seq: null });
    }
    return engine.mutate(m, {
      ...(standing === undefined ? {} : { key: standing.key }),
      // Send + Done's intent rides the send's own outbox row, so whichever road confirms it releases.
      ...(andDone !== null ? { andDone } : {}),
    }).then((r) => {
      noteQueuedSend(engine, r, m);
      return r;
    });
  };

  /**
   * CANCEL CANCELS — the composer's press, on the intent rather than on the screen. The engine
   * marks the queued row withdrawn (durably, and by the key at the moment of sending), so
   * neither the reconnect flush nor a later boot delivers it. `on_the_wire` withdraws nothing
   * and the caller says so; this arm says no sentence of its own, because the surface that
   * pressed Cancel is the one that knows what to render.
   */
  const withdrawSend = (key: string): Promise<WithdrawOutcome> => engine.withdrawQueued(key);

  const sendReply = async (
    messageId: string,
    body: string,
    all: boolean,
    sig: string | null = null,
    sendAt: string | null = null,
    attachments: ComposeAttachment[] = [],
    andDone = false,
    draftId: string | null = null,
  ): Promise<SendResult> => {
    const m = messageOf(messageId);
    const text = body.trim();
    // The empty refusal is judged BEFORE the signature joins: a signature must never light
    // Send up over an empty message (the webapp composer's own rule). An attachment IS
    // content — `sendNeedsContent`'s rule, mirrored. TOLD, both arms: these return before
    // `sent()` (the one toast site), and a refusal that renders nothing is a silent no-op,
    // measured on a device. The sheet's own lock makes them belts; a belt still speaks.
    if (!m) {
      toast(refuse("replyFailed"));
      return { outcome: "failed" };
    }
    if (text === "" && attachments.length === 0) {
      toast(refuse("composeNeedContent"));
      return { outcome: "failed" };
    }
    // A plain reply leaves the envelope to `Engine.enrich` (to = the sender, the parent's
    // mailbox, thread and subject); reply-all carries the SAME envelope the sheet offered.
    /* THE SAME ADDRESSES THE SHEET WAS DRAWN FROM. Read through the getter at SEND time, not at
       construction — see {@link LiveDeps.ownAddresses}. */
    const env = all ? replyAllRecipients(m, deps.ownAddresses?.() ?? NO_OWN_ADDRESSES) : null;
    /* SEND + DONE, read BEFORE the dispatch — the plan the release inverts is the state the
       reader is looking at, not the state the send leaves behind. An appointment finishes
       nothing: `sendAt` is a message still on the account, and filing its source would say it
       had been answered. */
    const plan = donePlan(messageId, andDone && sendAt === null);
    return sent(
      dispatchSend(withSignature({
        kind: "mail_send" as const,
        inReplyTo: messageId,
        body: text,
        ...(env ? { to: env.to, cc: env.cc } : {}),
        // Present ⇒ an appointment, absent ⇒ a delivery. Spread rather than written as
        // `sendAt: sendAt ?? undefined` so an ordinary reply's mutation is byte-identical to
        // the one this arm built before Send later existed. Attachments spread for the same
        // reason — an unattached reply's wire is the wire it always was.
        ...(sendAt ? { sendAt } : {}),
        ...(attachments.length > 0 ? { attachments } : {}),
        // The row a refused press left (`SendResult.draftId`): this press sends THAT row.
        ...(draftId ? { draftId } : {}),
      }, sig), plan),
      // THE CONFIRMED SENTENCE IS THE WHOLE DIFFERENCE, and it is honest rather than
      // convenient: nothing was sent, an appointment was made, and "Reply sent." over a
      // message still sitting on the account is exactly the false claim the four-outcome
      // classifier exists to prevent. The time is read back in the reader's own clock, so the
      // toast names the wall clock the preset fixed.
      sendAt ? Copy.scheduledFor(scheduleLabel(sendAt, now(), zone)) : Copy.replySent,
      // AHEAD OF THE APPOINTMENT SENTENCE, deliberately: what the server answered from is the
      // EARLIER press's reservation, so naming a time this press asked for would promise an
      // arrangement nobody made.
      Copy.replyEarlierWent,
    );
  };

  /**
   * Cancel a scheduled send — `draft_schedule_cancel`, three outcomes, not two. Only
   * `confirmed` is a cancellation (the webapp `AppShell`'s `cancelOutcomeToast`, in intent).
   * `queued` means the wire refused retryably: the appointment still exists server-side with
   * its clock running, so saying "cancelled" would promise something the server has not done —
   * on the one surface whose whole content is a promise about time. `rolled_back` is the
   * server's own refusal: the scheduled-send pass claimed the row (409 "already being sent")
   * and the mail is leaving; the overlay rollback puts it back as still-scheduled. A queued
   * mutation keeps its effect — the row reads un-scheduled while the words carry the doubt.
   */
  const cancelSchedule = async (draftId: string): Promise<boolean> => {
    const r = await engine
      .mutate({ kind: "draft_schedule_cancel", draftId })
      .then((res) => res, () => null);
    const status = r?.status ?? "rolled_back";
    // A newer press about this draft replaced the cancel: it owns the sentence.
    if (status === "superseded") return false;
    /**
     * The too-late sentence is reserved for the server's own conflict — narrower than the
     * webapp twin. "This message is already being sent" is a claim about what the server is
     * doing right now; three outcomes reach this branch and only the 409 from the
     * scheduled-send pass ({@link ScheduleService}'s `conflict`) supports it. The other two —
     * a local `not_found` (a concurrent drain already took the row, so the appointment is
     * gone rather than in flight) and a non-retryable transport refusal (nothing known) —
     * get the ordinary save-failed sentence, which is true of all three.
     */
    const conflict = r?.error?.code === "conflict" || r?.error?.status === 409;
    toast(
      status === "confirmed" ? refuse("scheduleCancelled") : status === "queued" ? refuse("scheduleCancelQueued") : conflict ? refuse("scheduleCancelTooLate") : refuse("liveSaveFailed"),
    );
    return status === "confirmed";
  };

  /**
   * DISCARD A DRAFT — `draft_discard`, and four endings rather than two. The server refuses the
   * delete by name only while a send is still `pending` (`send_recorded`); that sentence is the
   * card's, rendered in the row, so this arm says nothing for it. A `queued` mutation is reported
   * as still owed — the row is on screen either way, so silence would read as a delete that happened.
   */
  const draftDiscard = async (draftId: string): Promise<DraftDiscardOutcome> => {
    const r = await engine
      .mutate({ kind: "draft_discard", draftId })
      .then((res) => pressVerdict(res), () => PRESS_THREW);
    switch (r.kind) {
      case "applied":
        return "discarded";
      case "queued":
        /* `organizer` is the SERVER's record — the optimistic paint went back and the row is on
           screen while the install that organizes this mailbox does the delete; `retry` is this
           phone's own outbox. "Not yet" either way, never as done. */
        toast(r.wait === "organizer" ? refuse("draftsDiscardAwaitingOrganizer") : refuse("draftsDiscardQueued"));
        return "queued";
      case "refused": {
        /* A SEND STILL RUNNING, said by the server under its row lock. The row comes back and
           the card says why in the row — never a toast pointing somewhere else. */
        if (r.refusal?.code === "send_recorded") return "stillSending";
        const reason = r.refusal?.message?.trim();
        toast(reason ? refuse("draftsDiscardRefused", reason) : refuse("draftsDiscardRefusedUnnamed"));
        return "refused";
      }
      case "silent":
        /* A newer press about this draft owns the sentence; nothing is said, the row is left. */
        return "queued";
      default: {
        /* The gate is the BINDING, evaluated by `tsc` — the webapp's own rule at this seam: a
           fourth verdict makes this line a type error rather than a silent fall-through. */
        const unhandled: never = r;
        void unhandled;
        toast(refuse("draftsDiscardRefusedUnnamed"));
        return "refused";
      }
    }
  };

  /**
   * ACT FOR A HELD SEND — `draft_resolve`. Only a CONFIRMED answer is one: the row is the only
   * record that a message may be undelivered, so a queued or rolled-back attempt leaves it held
   * and says so. The server refuses a send that may STILL BE RUNNING by name, and that gets its
   * own sentence (the webapp's `resolveHeldSend`): "it failed" and "not yet" are different things.
   */
  const draftResolve = async (draftId: string, outcome: "arrived" | "not_arrived"): Promise<boolean> => {
    const r = await engine
      .mutate({ kind: "draft_resolve", draftId, outcome })
      .then((res) => res, () => null);
    if (r?.status === "confirmed") return true;
    // A newer answer about this row replaced this one: it owns the sentence.
    if (r?.status === "superseded") return false;
    toast(refuse(r?.error?.code === "send_still_running" ? "draftsResolveStillRunning" : "draftsResolveFailed"));
    return false;
  };

  /**
   * SEND AGAIN — the resend door. The row's OWN stored fields ride the bound send, so the PUT the
   * adapter makes before `POST /drafts/:id/send` writes back what the server holds (html included:
   * a plain PUT over formatted text is refused) and the message that leaves is the one on the card.
   * A body this mirror never received is refused before anything moves: sending it would write an
   * empty message over the only copy. No refusal is toasted — the card says it in the row.
   */
  const draftSendAgain = async (draftId: string): Promise<DraftSendAgainOutcome> => {
    const d = engine.read().get<EngineDraft & { html?: string | null }>("draft", draftId);
    if (!d || !draftBodyKnown(d)) return "bodyUnknown";
    const freed = await engine
      .mutate({ kind: "draft_resolve", draftId, outcome: "not_arrived" })
      .then((res) => res, () => null);
    if (freed?.status === "superseded") return "superseded";
    if (freed?.status !== "confirmed") {
      return freed?.error?.code === "send_still_running" ? "stillRunning" : "notReached";
    }
    const html = typeof d.html === "string" && d.html !== "" ? d.html : null;
    const r = await sent(
      dispatchSend({
        kind: "mail_send" as const,
        inReplyTo: null,
        draftId,
        mailboxId: d.mailboxId,
        threadId: null,
        subject: d.subject,
        body: d.body ?? "",
        ...(html !== null ? { html } : {}),
        to: d.to,
        cc: d.cc,
        bcc: d.bcc,
      }),
      Copy.composeSent,
      Copy.composeEarlierWent,
      false,
    );
    return r.outcome;
  };

  /**
   * KEEP WHAT WAS TYPED — see {@link LiveWorldActions.draftKeep}. The envelope is the send's: a
   * reply goes to the parent's sender (reply all to the sheet's own envelope) under `Re:`, a
   * forward keeps its typed recipients under `Fwd:` and names its original, and a new
   * mail is what was typed. The Undo is the Drafts card's own discard.
   */
  const draftKeep = async (k: DraftKeep): Promise<DraftKeepOutcome> => {
    const parent = k.messageId === null ? undefined : messageOf(k.messageId);
    const mailboxId = k.mailboxId ?? parent?.mailboxId ?? null;
    if (mailboxId === null || (k.messageId !== null && !parent)) return "refused";
    const reply = k.mode === "reply" || k.mode === "replyAll";
    const env = k.mode === "replyAll" && parent
      ? replyAllRecipients(parent, deps.ownAddresses?.() ?? NO_OWN_ADDRESSES)
      : null;
    const to = reply && parent ? (env ? env.to : [parent.from]) : k.to;
    const subject = reply && parent
      ? replySubject(parent.subject)
      : k.mode === "forward" && parent ? forwardSubject(parent.subject) : k.subject.trim();
    /* ONE LETTER, ONE ROW. A composer bound to the row its refused send left keeps INTO that row;
       the row is a moment old, so a mirror that has not drained it yet is asked to first — an
       update names a target the engine must already hold. */
    const bound = k.draftId ?? null;
    if (bound !== null && !engine.read().get("draft", bound)) await engine.syncOnce().catch(() => undefined);
    const r = await engine
      .mutate({
        kind: "draft_save", draftId: bound, mailboxId,
        ...(reply && parent ? { inReplyToMessageId: parent.id, threadId: parent.threadId ?? null } : {}),
        ...(k.mode === "forward" && parent ? { forwardOfMessageId: parent.id } : {}),
        subject, body: k.body, to, cc: env ? env.cc : (k.cc ?? []), bcc: env ? [] : (k.bcc ?? []),
      })
      .then((res) => res, () => null);
    if (r === null || r.status === "rolled_back") return "refused";
    // A newer save of this row replaced this one: it owns the sentence.
    if (k.quiet === true || r.status === "superseded") return "kept";
    const without = k.files > 0;
    if (r.status === "queued") {
      toast(refuse(without ? "composeKeptQueuedWithoutFiles" : "composeKeptQueued"));
      return "kept";
    }
    const id = r.entityId ?? bound;
    toast(
      refuse(without ? "composeKeptWithoutFiles" : "composeKept"),
      id ? { undo: () => { void draftDiscard(id); } } : undefined,
    );
    return "kept";
  };

  const sendForward = async (messageId: string, to: EmailAddress[], body: string, sig: string | null = null, attachments: ComposeAttachment[] = [], andDone = false, confirmed = false, draftId: string | null = null): Promise<SendResult> => {
    const m = messageOf(messageId);
    // A `no_forward` original leaves only after the sheet's ask was answered (`forwardPress`);
    // the server refuses it without `forwardConfirmed` too. Told, for the reply belt's reason: a
    // return before `sent()` renders nothing.
    const sensitive = m?.sensitivity?.no_forward === true;
    if (!m || to.length === 0 || (sensitive && !confirmed)) {
      toast(refuse("replyFailed"));
      return { outcome: "failed" };
    }
    /* SEND + DONE — read before the dispatch, for the reply arm's reason. */
    const plan = donePlan(messageId, andDone);
    return sent(
      dispatchSend(withSignature({
        kind: "mail_send" as const,
        inReplyTo: null,
        forwardOf: messageId,
        ...(sensitive && confirmed ? { forwardConfirmed: true } : {}),
        // The quoted header names the original's date on this phone's clock and in its language.
        forwardClock: { zone: readerZone(), locale: activeLocale() },
        subject: forwardSubject(m.subject),
        // The mailbox the original arrived in — the same sender a reply gets from `enrich`.
        // A forward has no parent-derived From of its own, and the send refuses without one.
        mailboxId: m.mailboxId,
        body,
        to,
        ...(attachments.length > 0 ? { attachments } : {}),
        ...(draftId ? { draftId } : {}),
      }, sig), plan),
      Copy.forwarded,
      Copy.forwardEarlierWent,
    );
  };

  const sendNew = async (
    mailboxId: string | null,
    to: EmailAddress[],
    subject: string,
    body: string,
    sig: string | null = null,
    sendAt: string | null = null,
    attachments: ComposeAttachment[] = [],
    draftId: string | null = null,
    copies: { cc: EmailAddress[]; bcc: EmailAddress[] } = { cc: [], bcc: [] },
  ): Promise<SendResult> => {
    const text = body.trim();
    // TOLD, all three arms — a return before `sent()` renders nothing, and a fresh mail has
    // one more way to be unsendable than a reply: nothing to send it FROM. The empty-content
    // rule is the reply arm's, judged before the signature joins; a subject alone is not
    // content (the webapp's `sendNeedsContent`, which never reads the subject).
    if (mailboxId === null) {
      toast(refuse("composeNoMailbox"));
      return { outcome: "failed" };
    }
    if (to.length === 0) {
      toast(refuse("composeNeedRecipient"));
      return { outcome: "failed" };
    }
    if (text === "" && attachments.length === 0) {
      toast(refuse("composeNeedContent"));
      return { outcome: "failed" };
    }
    return sent(
      dispatchSend(withSignature({
        kind: "mail_send" as const,
        inReplyTo: null,
        mailboxId,
        subject: subject.trim(),
        body: text,
        to,
        ...(copies.cc.length > 0 ? { cc: copies.cc } : {}),
        ...(copies.bcc.length > 0 ? { bcc: copies.bcc } : {}),
        ...(sendAt ? { sendAt } : {}),
        ...(attachments.length > 0 ? { attachments } : {}),
        ...(draftId ? { draftId } : {}),
      }, sig)),
      sendAt ? Copy.scheduledFor(scheduleLabel(sendAt, now(), zone)) : Copy.composeSent,
      Copy.composeEarlierWent,
    );
  };

  const tagToggle = async (messageId: string, tag: WorldTag, assigned: boolean): Promise<boolean> => {
    const m: EngineMutation = { kind: "tag_assign", messageId, tagId: tag.id, assigned };
    const inv = inverseMutations(engine.verbRead(), m);
    const leaving = oneShot();
    toast(
      assigned ? refuse("tagTagged", tag.name) : refuse("tagUntagged", tag.name),
      undoable(inv, leaving),
    );
    return gatedSaid(messageId, [m], painted(), leaving);
  };

  const tagCreate = async (messageId: string, name: string): Promise<boolean> => {
    const typed = name.trim();
    if (typed === "" || !deps.uuid) return false;
    // Case-insensitive against the whole tag set — the unique index is on `lower(name)`, so
    // "Invoices" beside "invoices" is the existing tag, toggled on, not a 409.
    const existing = liveTags(engine.read()).find((t) => t.name.toLowerCase() === typed.toLowerCase());
    if (existing) return tagToggle(messageId, existing, true);
    // The undo UNASSIGNS; the minted tag row stands — deleting it is a different act with its
    // own verb and its own confirm (`inverseMutations`' tag arm states the same boundary).
    const m: EngineMutation = { kind: "tag_assign", messageId, tagId: deps.uuid(), assigned: true, createName: typed };
    const inv = inverseMutations(engine.verbRead(), m);
    const leaving = oneShot();
    toast(refuse("tagTagged", typed), undoable(inv, leaving));
    return gatedSaid(messageId, [m], painted(), leaving);
  };

  /**
   * Screening from the open message — the rule ladder, mirrored from
   * `apps/webapp/app/shell/sender-screening.ts#planScreeningChange`: (1) a subject still waiting
   * at the gate is decided with `screener_decide`, which carries the past-mail answer; (2) past
   * the gate the twins decide through the one shared `pressOverTwins`. Every branch writes a rule
   * or a decide, so the backlog is the server pass's and this press moves none of it
   * (THE-CLIENTS-FIFTY): only the pass sees a reply or a hand filing. Raw mirror reads.
   */
  /** The press's forecast over the raw mirror and the lists' own options (`presentedOptions`). */
  const forecastOf = (
    raw: EntityReader, subject: readonly EngineMessage[], scope: Scope, match: string, wanted: Folder,
    applyRetro: boolean, decide?: Extract<EngineMutation, { kind: "screener_decide" }>,
  ): PressForecast => pressForecast({
    reader: raw, options: deps.presentedOptions?.() ?? presentedOptions(now(), false, SCREENING_UNSUPPLIED, deps.ownAddresses?.()),
    subject, scope, match, wanted, makeRule: true, applyRetro, now: now(), ...(decide ? { decide } : {}),
  });

  /** The subject a press is about, read as `screenSender` reads it. */
  const subjectFor = (messageId: string, scope: Scope) => {
    const m = messageOf(messageId);
    if (!m) return null;
    const address = m.from.address.trim().toLowerCase();
    const domain = domainOf(address).toLowerCase();
    // A shared provider's domain is never a scope: a decision about everyone there admits nobody.
    if (scope === "domain" && (domain === "" || !address.includes("@") || isSharedProviderDomain(domain))) return null;
    const match = scope === "domain" ? domain : address;
    const ofSubject = (x: EngineMessage): boolean =>
      scope === "domain"
        ? domainOf(x.from.address.trim().toLowerCase()).toLowerCase() === match
        : x.from.address.trim().toLowerCase() === match;
    return { m, match, ofSubject, subject: engine.read().list<EngineMessage>("message").filter(ofSubject) };
  };

  const screeningForecast = (messageId: string, dest: Destination, scope: Scope, applyRetro: boolean): PressForecast | null => {
    const at = subjectFor(messageId, scope);
    if (!at) return null;
    const wanted = FOLDER_OF_VIEW[dest as ScreenDest];
    const waiting = at.subject.filter((x) => physicalFolderOf(x) === FOLDER_OF_VIEW.screener).sort(newestFirst)[0];
    const decision: "yes" | "no" = dest === "screened" || dest === "spam" ? "no" : "yes";
    return forecastOf(engine.read(), at.subject, scope, at.match, wanted, applyRetro, waiting
      ? { kind: "screener_decide", senderId: waiting.id, decision, dest: dest as ScreenDest, scope, applyRetro }
      : undefined);
  };

  const screeningRules = (messageId: string, scope: Scope): RulesInPlay | null => {
    const at = subjectFor(messageId, scope);
    if (!at) return null;
    const raw = engine.read();
    const options = deps.presentedOptions?.() ?? presentedOptions(now(), false, SCREENING_UNSUPPLIED, deps.ownAddresses?.());
    return rulesInPlay({ reader: raw, placeOf: consentPartition(raw, options).placeOf, subject: at.subject, scope, match: at.match });
  };

  /* WHY SOME OF THE SENDER'S MAIL STAYED — the web sheet's ask, over the same placement the lists
     use, newest first; the reasons are the server's (`engine.whyStayed`). */
  const screeningStayed = (messageId: string, scope: Scope): StayedAsk | null => {
    const at = subjectFor(messageId, scope);
    if (!at) return null;
    const raw = engine.read();
    const options = deps.presentedOptions?.() ?? presentedOptions(now(), false, SCREENING_UNSUPPLIED, deps.ownAddresses?.());
    return stayedAsk({
      reader: raw, placeOf: consentPartition(raw, options).placeOf, subject: [...at.subject].sort(newestFirst),
      scope, match: at.match, mailboxId: at.m.mailboxId,
    });
  };
  const stayedWhy = (ids: readonly string[]): Promise<ReadonlyMap<string, StayedWhy>> => engine.whyStayed(ids);
  /* "MOVE IT TOO" — the web's door: a `move` per row, in its message's order, a batch at a time,
     and the sentence from the answers (`screening.verdictMoved` and the press's partial pair). */
  const moveStayed = async (ids: readonly string[], dest: Destination): Promise<boolean> => {
    const folder = FOLDER_OF_VIEW[dest as ScreenDest];
    const r = await moveStayedInBatches(ids, folder, (m) =>
      inMessageOrder(m, () => engine.mutate(m).catch((): MutationResult | null => null)));
    if (r.moved > 0) toast(refuse("verdictMoved", destDone(dest), r.moved));
    if (r.refused > 0) toast(refuse("pressPartlyRefused", r.refused));
    else if (r.waiting > 0) toast(refuse("pressPartlyQueued", r.waiting));
    return r.refused === 0;
  };

  /* The web's press (`screener-state.ts#pressUnscreened`): the count said is the one the SERVER
     moved, since another door may have decided a sender since the offer was drawn. */
  const screenUnscreened = async (): Promise<boolean> => {
    try {
      const count = await engine.screenUnscreenedSenders();
      toast(count > 0 ? refuse("unscreenedMoved", count) : refuse("unscreenedMovedNone"));
      return true;
    } catch {
      toast(refuse("unscreenedFailed"));
      return false;
    }
  };

  /**
   * THE WINDOW PRESS (the web's `holdScreenPress`): the press says what it does, with Undo; the
   * commit re-plans through `planScreenCommit` and the list is read back once the rules are answered
   * and the moves settled. No session to hold it: the rules go now and the same reading follows.
   */
  const screenThroughWindow = async (p: {
    m: EngineMessage; dest: Destination; wanted: Folder; target: string; match: string;
    ofSubject: (x: EngineMessage) => boolean; subject: readonly EngineMessage[];
    applyRetro: boolean; press: PhoneScreenPress | undefined;
  }): Promise<boolean> => {
    const raw = engine.read();
    const resolution = p.press?.resolution ?? "keep";
    const forecast = p.press?.forecast ?? forecastOf(raw, p.subject, "sender", p.match, p.wanted, p.applyRetro);
    const landing = new Set(forecast[resolution].landing);
    const shown = p.press?.shown ?? [];
    const intent: ScreenIntent = {
      v: 2, verb: "screen", id: deps.uuid ? deps.uuid() : `${p.m.id}:${now().getTime()}`, seedId: p.m.id,
      address: p.m.from.address, scope: "sender", dest: p.dest as ScreenDest, messageIds: [...landing],
      makeRule: true, applyRetro: p.applyRetro, resolution,
      shown: shown.slice(0, 20).map((r) => ({ id: r.id, fp: ruleFingerprint(r) })), at: now().getTime(),
    };
    // A RULE'S PAST MAIL IS THE SERVER PASS'S (THE-CLIENTS-FIFTY): the intent always writes the
    // rule with the past-mail answer, so this press moves none of it; the held window presents the
    // `landing` rows at the place meanwhile, and the pass moves them.
    const moves: EngineMutation[] = [];
    const inv = moves.flatMap((mu) => inverseMutations(engine.verbRead(), mu));
    const settled = moves.map((mu) => engine.mutate(mu).catch(() => null));
    const place = destDone(p.dest);
    const termOf = (r: RuleDTO) => (r.subjectContains ?? r.bodyContains ?? "").trim();

    /* A PRESS TOLD "ohmail is applying the rule" IS TOLD ONCE WHEN IT HAS BEEN, while the app is
       open (the web's `press-watch.ts`): the first engine change that reads the pass done says every
       message is at the place, or what still stays. A pass that becomes unknown (the rule gone) is
       forgotten, said nothing. */
    const watchPass = (a: ScreenCommitAnswer): void => {
      if (retroStateOf(engine.read(), a.mutations, a.answers) !== "applying") return;
      const off = engine.subscribe(() => {
        const state = retroStateOf(engine.read(), a.mutations, a.answers);
        if (state === "applying") return;
        off();
        if (state !== "done") return;
        const lists = deps.presented?.() ?? presentedOf(engine.read(), now(), false, SCREENING_UNSUPPLIED, deps.ownAddresses?.());
        const outcome = pressOutcome({
          presented: lists, subject: engine.read().list<EngineMessage>("message").filter(p.ofSubject),
          rules: rulesList(engine.read()), profiles: mailboxProfiles(engine.read()), wanted: p.wanted, retro: false,
        });
        const v = stayVerdict(outcome, engine.read());
        if (v.key === "none") toast(refuse("screeningVerdictAll", outcome.at, p.target, place));
        else if (v.key === "still" || v.key === "stillLegacy" || v.key === "undecided") {
          const stay = pressReadBack(engine.read(), lists, p.ofSubject, p.wanted, place, false);
          if (stay) toast(stay);
        }
      });
    };

    const readBack = (a: ScreenCommitAnswer): boolean => {
      for (const id of a.changed) {
        const r = shown.find((x) => x.id === id);
        if (r && termOf(r) !== "") toast(refuse("screeningVerdictChanged", termOf(r)));
      }
      const verdicts = a.answers.map((x) => (x ? pressVerdict(x) : PRESS_THREW));
      const back = tallyVerdicts(verdicts);
      // Every write replaced by a newer press: that press reads its own list back.
      if (verdicts.length > 0 && back.silent === verdicts.length) return true;
      if (back.refused > 0 || back.queued > 0) {
        return saidAll(verdicts, refuse("liveDecided", place, p.target),
          ownAddressOr(verdicts, refuse("liveDecideFailed", p.m.from.address)));
      }
      const lists = deps.presented?.() ?? presentedOf(engine.read(), now(), false, SCREENING_UNSUPPLIED, deps.ownAddresses?.());
      const stay = pressReadBack(engine.read(), lists, p.ofSubject, p.wanted, place, p.applyRetro);
      if (stay) {
        toast(stay);
        // The read-back's own "applying" sentence waits on the same pass.
        if (p.applyRetro) watchPass(a);
        return true;
      }
      const at = pressOutcome({
        presented: lists, subject: engine.read().list<EngineMessage>("message").filter(p.ofSubject),
        rules: rulesList(engine.read()), profiles: mailboxProfiles(engine.read()), wanted: p.wanted, retro: false,
      }).at;
      // "All" only when no backlog pass is still applying the rule; an unknown pass never reads done.
      const applying = p.applyRetro && !retroFinished(engine.read(), a.mutations, a.answers);
      toast(applying
        ? refuse("liveVerdictApplying", at, place)
        : refuse("screeningVerdictAll", at, p.target, place));
      if (applying) watchPass(a);
      return true;
    };

    const opened = await holdScreenRouting(intent, (a) => { void Promise.allSettled(settled).then(() => readBack(a)); });
    // Already sent by the window (its record refused after a flush): the follow-up reads it back.
    if (opened.sent) return true;
    if (!opened.held) {
      const writes = planScreenCommit(raw, intent).writes;
      const answers = await Promise.all(writes.map((w) => engine.mutate(w).catch((): MutationResult | null => null)));
      await Promise.allSettled(settled);
      return readBack({ mutations: writes, answers, changed: [] });
    }
    const subjectKey = routingSubject({ scope: "sender", address: p.m.from.address });
    toast(pressSentence(forecast, resolution, shown, place, p.target, p.applyRetro), {
      holdMs: UNDO_MS,
      shown: () => { restartRouting(subjectKey); },
      undo: () => {
        const cancelled = undoRouting(subjectKey);
        // At the press, as `undoable` says it; a refusal overrides it when the inverse answers.
        toast(refuse(cancelled ? "screeningRoutingUndoneRules" : "toastUndone"));
        void Promise.all(inv.map((mu) => watched(engine.mutate(mu)))).then((vs) => {
          saidAll(vs, null, refuse("liveSaveFailed"));
        });
      },
    });
    return true;
  };

  /** The press's own sentence on the phone — the web's `pressSentence`, in the phone's copy. */
  const pressSentence = (
    f: PressForecast, resolution: PressResolution, shown: readonly RuleDTO[], place: string, target: string, applyRetro: boolean,
  ): Refusal => {
    if (!applyRetro) return refuse("liveDecided", place, target);
    const term = (r: RuleDTO | undefined) => (r?.subjectContains ?? r?.bodyContains ?? "").trim();
    const terms = f.groups.filter((g) => g.cause === "term-subject" || g.cause === "term-body").map((g) => g.rule);
    const named = terms.filter((r) => shown.some((x) => x.id === r.id));
    if (named.length > 0 && resolution === "remove") return refuse("screeningPressRemoved", place, target, named.length, term(named[0]));
    if (terms.length === 1 && resolution === "keep") {
      return refuse("screeningPressKeptOne", place, target, term(terms[0]), folderName(terms[0]!.destination));
    }
    if (terms.length > 1 && resolution === "keep") return refuse("screeningPressKeptMany", place, target, terms.length);
    if (f.exception) {
      return refuse("screeningPressException", place, target, f.exception.rule.match, folderName(f.exception.rule.destination));
    }
    return refuse("screeningPressRuled", place, target);
  };

  const screenSender = async (
    messageId: string, dest: Destination, scope: Scope, applyRetro = true, press?: PhoneScreenPress,
  ): Promise<boolean> => {
    const raw = engine.read();
    const m = messageOf(messageId);
    if (!m) return false;
    // Never a rule about the account itself: the server refuses it (`own_address`), and so does this.
    if (isOwn(messageId)) { toast(refuse("liveOwnAddress")); return false; }
    const address = m.from.address.trim().toLowerCase();
    const domain = domainOf(address).toLowerCase();
    if (scope === "domain" && (domain === "" || !address.includes("@"))) return false;
    // Everyone at a shared provider let through admits nobody, and the server refuses it: said, not sent.
    if (scope === "domain" && isSharedProviderDomain(domain)) {
      toast(refuse("screeningScopeShared", domain));
      return false;
    }
    const match = scope === "domain" ? domain : address;
    const wanted = FOLDER_OF_VIEW[dest as ScreenDest];
    const target = scope === "domain" ? `@${domain}` : m.from.address;
    const ofSubject = (x: EngineMessage): boolean =>
      scope === "domain"
        ? domainOf(x.from.address.trim().toLowerCase()).toLowerCase() === match
        : x.from.address.trim().toLowerCase() === match;
    const subject = raw.list<EngineMessage>("message").filter(ofSubject);

    const waiting = subject
      .filter((x) => physicalFolderOf(x) === FOLDER_OF_VIEW.screener)
      .sort(newestFirst)[0];
    const decision: "yes" | "no" = dest === "screened" || dest === "spam" ? "no" : "yes";

    /* AN ADDRESS PRESS PAST THE GATE IS HELD, like a Move (`held-routing.ts`): the mail the list
       will show at the place moves now, the rules are a v2 intent committed when the window
       closes, and the list is read back once they are answered. */
    if (!waiting && scope === "sender") {
      return screenThroughWindow({ m, dest, wanted, target, ofSubject, subject, applyRetro, press, match });
    }
    const removals = press && press.resolution === "remove"
      ? press.forecast.remove.writes.filter((w) => !press.forecast.keep.writes.includes(w))
      : [];

    let ruled: Promise<PressVerdict[]>;
    if (waiting) {
      // The step's removals go ahead of the decide, each answered with it.
      const removed = removals.map((w) => watched(engine.mutate(w)));
      ruled = Promise.all([...removed, watched(
        engine.mutate({
          kind: "screener_decide", senderId: waiting.id, decision, dest: dest as ScreenDest, scope,
          // The past-mail answer rides the decision, because the rule it promotes is the only rule
          // this press writes — the webapp's ruling, on the same wire.
          applyRetro,
        }),
      )]);
    } else {
      /* THE WEB SHEET'S LADDER, ONE FUNCTION: every twin elsewhere is retargeted, each one already
         at the destination re-armed when the past-mail answer is yes (off, a habit-click writes
         nothing), and one rule written when there is none. */
      const { writes } = pressOverTwins(rulesList(raw), scope, match, wanted, applyRetro);
      ruled = Promise.all([...writes, ...removals].map((w) => watched(engine.mutate(w))));
    }
    /* THE SENTENCE FOLLOWS THE ANSWER, not the press: the optimistic "Screened" stood over a
       rule the server had only RECORDED for the organizing install, which is the same claim the
       Screener's own decide stopped making. `saidAll` raises it, or the wait, or the refusal. */
    const verdicts = await ruled;
    /* THE SAME RECONCILIATION AS THE SCREENER'S OWN PRESS, because this is the same mutation by
       another door: a sender screened from the open message is decided, and the paired shelf's
       cached answer would have gone on naming them. Only the branch that DECIDED one — the rule
       ladder's other branch writes rules about mail already past the gate. */
    if (waiting && verdicts.every((x) => x.kind === "applied")) {
      deps.forgetWaiting?.({ address: m.from.address, scope });
    }
    /* THE LIST IS READ AGAIN BEFORE SUCCESS IS SAID — the web sheet's reading: a pressed row the
       list shows elsewhere is named with its count and cause. Only a press whose every write
       applied reads back; a wait or a refusal keeps its own sentence. */
    const back = tallyVerdicts(verdicts);
    // The lists' own reader; a harness without one reads the same projection with its defaults.
    const lists = deps.presented?.() ?? presentedOf(engine.read(), deps.now?.() ?? new Date(), false, SCREENING_UNSUPPLIED, deps.ownAddresses?.());
    const stay = back.refused === 0 && back.queued === 0
      ? pressReadBack(engine.read(), lists, ofSubject, wanted, destDone(dest), applyRetro) : null;
    const pressSaid = stay ?? refuse("liveDecided", destDone(dest), target);
    return saidAll(
      verdicts,
      decidedUnsubscribes(waiting !== undefined, decision) ? refuse("liveAlsoUnsubscribing", pressSaid) : pressSaid,
      ownAddressOr(verdicts, refuse("liveDecideFailed", m.from.address)),
    );
  };

/* ── the folder verbs — see the interface's header for the whole optimism model ─────────── */

  /** One folder command, spoken about ONLY on rollback — success's feedback is the pending row. */
  const folderVerb = async (m: EngineMutation): Promise<boolean> =>
    said(await watched(engine.mutate(m)), null, refuse("folderVerbFailed"));

  const folderCreate = (mailboxId: string, name: string): Promise<boolean> =>
    // The client-local row id, replaced by the server's echo (`tag_create`'s two-ids rule).
    // No uuid source ⇒ refused rather than minted weakly — `tagCreate`'s own posture.
    deps.uuid
      ? folderVerb({ kind: "folder_create", folderId: deps.uuid(), mailboxId, name })
      : Promise.resolve(false);

  const folderRename = (folderId: string, name: string): Promise<boolean> =>
    folderVerb({ kind: "folder_rename", folderId, name });

  const folderDelete = (folderId: string): Promise<boolean> =>
    folderVerb({ kind: "folder_delete", folderId });

  const folderDismiss = (folderId: string): void => {
    // Fire-and-forget like the webapp's: dismissing a refusal that fails to dismiss leaves
    // the refusal on screen, which is its own honest report.
    void engine.mutate({ kind: "folder_op_dismiss", folderId });
  };

  return {
    async retryAbandoned(id) {
      // The RESULT is returned, not swallowed: on the phone the sheet row is the only owner of an
      // owner-settled verb, so a `send_unverified` answer said nowhere is said to nobody.
      const res = await engine.retryAbandoned(id);
      // A Send + Done tried again from the strip files its source once it is confirmed.
      const said = (await releaseConfirmed([res])).get(res.key);
      if (said) toast(said.say, said.opts);
      return res;
    },
    async discardAbandoned(id) {
      await engine.discardAbandoned(id);
    },
    retryQueued: (id) => engine.retryQueued(id),
    discardQueued: (key) => engine.withdrawQueued(key),
    releaseConfirmed,
    openMessage, leaveMessage, hydrateMessage, forwardFetch, hydrateHeld, holdFiles, releaseFiles, loadInlineImages,
    openAttachmentBytes,
    releaseAttachments,
    sweepFeed, leaveFeed, decide, release, setPile,
    pileToggle, resurfaceToggle, resurfaceAt, resurfaceNow, resurfaceDone, markSeen, markGlanced, markAllSeen, move,
    deleteMessage, trashList, trashRestore,
    sendReply, sendForward, sendNew, sendAndDoneOffered, withdrawSend, cancelSchedule, tagToggle, tagCreate, screenSender,
    screeningForecast, screeningRules, screeningStayed, stayedWhy, moveStayed, screenUnscreened,
    draftDiscard, draftResolve, draftSendAgain, draftKeep,
    folderCreate, folderRename, folderDelete, folderDismiss,
  };
}

/* ─────────────────────────────────────────────────────── the stable facade */

/** What every mail screen may DO — one vocabulary, delegating to the engine. */
export interface WorldActions {
  /** The scroll-seen sweep (Reads/Receipts), riding the wire's `feed_mark_seen`. */
  markSeenThrough(place: "reads" | "receipts", ids: string[]): void;
  /** Leaving a stream commits the waterline. */
  leaveFeed(place: "reads" | "receipts"): void;
  /** Opening a message marks it read and hydrates its text, thread and files. */
  openMessage(id: string): void;
  /** The reader left the message — see {@link LiveWorldActions.leaveMessage}. */
  leaveMessage(id: string): void;
  /** The renderer's ask for the embedded images the open document references. */
  loadInlineImages(messageId: string, contentIds: string[]): void;
  /** One attachment's bytes for the share sheet — awaited; the tile renders each refusal. */
  openAttachmentBytes(messageId: string, attachmentId: string): Promise<WorldAttachmentBytes>;
  /** The reader's cleanup — see {@link LiveWorldActions.releaseAttachments}. */
  releaseAttachments(messageId: string): void;
  /** An explicit re-ask for one message's full text (a card expand, a reopen). */
  hydrateMessage(id: string): void;
  /** A Forward press's read first — see {@link LiveWorldActions.forwardFetch}. */
  forwardFetch(messageId: string): Promise<void> | null;
  /**
   * The two verbs on a change the engine gave up on — see {@link LiveWorldActions.retryAbandoned}.
   * Awaited by the caller (the chrome disables the row while one is in flight), so unlike most of
   * this facade they return their promise rather than firing and forgetting.
   */
  retryAbandoned(id: string): Promise<MutationResult>;
  discardAbandoned(id: string): Promise<void>;
  /** The two answers on a queued discard — see {@link LiveWorldActions.retryQueued}. Awaited too. */
  retryQueued(id: string): Promise<MutationResult | null>;
  discardQueued(key: string): Promise<WithdrawOutcome>;
  /** The sender screen's open: fetch every held body. */
  hydrateHeld(ids: string[]): void;
  /** A screen's hold on the file lists it shows — see {@link LiveWorldActions.holdFiles}. */
  holdFiles(ids: string[]): void;
  releaseFiles(ids: string[]): void;
  decide(row: ScreenerRow, dest: Destination, read: boolean): void;
  setScope(row: ScreenerRow, scope: Scope): void;
  /** Allow (screened) / Not spam (spam): release the whole held bag to a place. */
  allow(row: ScreenerRow, dest: Place): void;
  notSpam(row: ScreenerRow, dest: Place): void;
  addToPile(kind: PileKind, item: PileItem): void;
  /* The open message's verbs — see {@link LiveWorldActions} for each arm's contract. */
  /** `members`: a folded Ohbox row's whole conversation (`WorldMail.memberIds`); one sentence. */
  pileToggle(messageId: string, kind: "replyLater" | "setAside", members?: readonly string[]): void;
  resurfaceToggle(messageId: string): void;
  resurfaceAt(messageId: string, iso: string): void;
  resurfaceNow(messageId: string): void;
  resurfaceDone(messageId: string, members?: readonly string[]): void;
  markSeen(messageId: string, unread: boolean, members?: readonly string[]): void;
  /** Scroll-to-read's glance — see {@link LiveWorldActions.markGlanced}. */
  markGlanced(ids: readonly string[]): void;
  /** Mark all read — see {@link LiveWorldActions.markAllSeen}. */
  markAllSeen(ids: string[], feed?: { place: "reads" | "receipts"; upToId: string }): void;
  /** The row, not an id — see {@link LiveWorldActions.move}. */
  move(row: WorldMail, dest: MoveTarget, members?: readonly string[]): void;
  /**
   * Delete — the delayed-commit window, not the wire. `onCommitted` leaves the reader when the
   * delete COMMITS (the window's close), never at the press: navigating away in the same tick
   * kills the pill's surface (the device defect the 0.20 review found). See {@link LiveWorldActions.deleteMessage}.
   */
  deleteMessage(messageId: string, opts?: { onCommitted?: () => void }): void;
  /**
   * The Trash page and the restore verb — awaited by their screen (the page is the render,
   * the `true` is the row leaving), so like `retryAbandoned` they return their promise.
   */
  trashList(cursor: string | null): Promise<WorldTrashPage>;
  trashRestore(messageId: string): Promise<boolean>;
  /**
   * Resolves to the send's result: `sent` closes, `failed` re-arms, `queued` locks the composer.
   * `sendAt` makes it a Send-later appointment instead of a delivery — see
   * {@link LiveWorldActions.sendReply}; `sent` then means "scheduled", and the toast says so.
   */
  sendReply(
    messageId: string,
    body: string,
    all: boolean,
    sig?: string | null,
    sendAt?: string | null,
    attachments?: ComposeAttachment[],
    andDone?: boolean,
    draftId?: string | null,
  ): Promise<SendResult>;
  /** Is Send + Done offered for this source? See {@link LiveWorldActions.sendAndDoneOffered}. */
  sendAndDoneOffered(messageId: string): boolean;
  sendForward(messageId: string, to: EmailAddress[], body: string, sig?: string | null, attachments?: ComposeAttachment[], andDone?: boolean, confirmed?: boolean, draftId?: string | null): Promise<SendResult>;
  /** A mail with no parent — see {@link LiveWorldActions.sendNew}. */
  sendNew(
    mailboxId: string | null,
    to: EmailAddress[],
    subject: string,
    body: string,
    sig?: string | null,
    sendAt?: string | null,
    attachments?: ComposeAttachment[],
    draftId?: string | null,
    copies?: { cc: EmailAddress[]; bcc: EmailAddress[] },
  ): Promise<SendResult>;
  /** Withdraw a queued send — Cancel. See {@link LiveWorldActions.withdrawSend}. */
  withdrawSend(key: string): Promise<WithdrawOutcome>;
  /** Cancel a scheduled send — resolves `true` only on the server's CONFIRMED cancellation. */
  cancelSchedule(draftId: string): Promise<boolean>;
  /** Discard a draft — see {@link LiveWorldActions.draftDiscard} for the four endings. */
  draftDiscard(draftId: string): Promise<DraftDiscardOutcome>;
  /** Answer for a held send — see {@link LiveWorldActions.draftResolve}. */
  draftResolve(draftId: string, outcome: "arrived" | "not_arrived"): Promise<boolean>;
  /** Send a held message again — see {@link LiveWorldActions.draftSendAgain}. */
  draftSendAgain(draftId: string): Promise<DraftSendAgainOutcome>;
  /** Keep what a closing composer holds — see {@link LiveWorldActions.draftKeep}. */
  draftKeep(keep: DraftKeep): Promise<DraftKeepOutcome>;
  /** What became of a queued send's key — how a locked composer settles. See `World.sendOutcome`. */
  sendOutcome(key: string): "pending" | "confirmed" | "rolled_back" | "unverified" | "unknown";
  tagToggle(messageId: string, tag: WorldTag, assigned: boolean): void;
  tagCreate(messageId: string, name: string): void;
  screenSender(messageId: string, dest: Destination, scope: Scope, applyRetro?: boolean, press?: PhoneScreenPress): void;
  screeningForecast(messageId: string, dest: Destination, scope: Scope, applyRetro: boolean): PressForecast | null;
  screeningRules(messageId: string, scope: Scope): RulesInPlay | null;
  screeningStayed(messageId: string, scope: Scope): StayedAsk | null;
  stayedWhy(ids: readonly string[]): Promise<ReadonlyMap<string, StayedWhy>>;
  moveStayed(ids: readonly string[], dest: Destination): void;
  /** The Ohbox's undecided-sender offer, pressed — awaited by its card. See {@link LiveWorldActions.screenUnscreened}. */
  screenUnscreened(): Promise<boolean>;
  /* The folder verbs — see {@link LiveWorldActions} for each arm's contract. */
  folderCreate(mailboxId: string, name: string): void;
  folderRename(folderId: string, name: string): void;
  folderDelete(folderId: string): void;
  folderDismiss(folderId: string): void;
}

/**
 * One actions object for the app's whole life, delegating to whichever backend is current at
 * call time. World data is legitimately a new object per mirror version — that re-renders the
 * screens — but an `actions` object minted in the same memo made every effect depending on an
 * action re-fire per version: `useFocusEffect`'s cleanup ran mid-visit (committing the
 * waterline the visit semantics say must hold still) and a rejected mark-read re-asked in a
 * loop. Identity here is constant by construction; only the delegate moves, per call, never
 * per render.
 */
export function stableActions(current: () => WorldActions): WorldActions {
  return {
    markSeenThrough: (place, ids) => current().markSeenThrough(place, ids),
    leaveFeed: (place) => current().leaveFeed(place),
    openMessage: (id) => current().openMessage(id),
    leaveMessage: (id) => current().leaveMessage(id),
    loadInlineImages: (id, contentIds) => current().loadInlineImages(id, contentIds),
    releaseAttachments: (id) => current().releaseAttachments(id),
    openAttachmentBytes: (id, attachmentId) => current().openAttachmentBytes(id, attachmentId),
    hydrateMessage: (id) => current().hydrateMessage(id),
    forwardFetch: (id) => current().forwardFetch(id),
    retryAbandoned: (id) => current().retryAbandoned(id),
    discardAbandoned: (id) => current().discardAbandoned(id),
    retryQueued: (id) => current().retryQueued(id),
    discardQueued: (key) => current().discardQueued(key),
    hydrateHeld: (ids) => current().hydrateHeld(ids),
    holdFiles: (ids) => current().holdFiles(ids),
    releaseFiles: (ids) => current().releaseFiles(ids),
    decide: (row, dest, read) => current().decide(row, dest, read),
    setScope: (row, scope) => current().setScope(row, scope),
    allow: (row, dest) => current().allow(row, dest),
    notSpam: (row, dest) => current().notSpam(row, dest),
    addToPile: (kind, item) => current().addToPile(kind, item),
    pileToggle: (id, kind, members) => void current().pileToggle(id, kind, members),
    resurfaceToggle: (id) => void current().resurfaceToggle(id),
    resurfaceAt: (id, iso) => void current().resurfaceAt(id, iso),
    resurfaceNow: (id) => void current().resurfaceNow(id),
    resurfaceDone: (id, members) => void current().resurfaceDone(id, members),
    markSeen: (id, unread, members) => void current().markSeen(id, unread, members),
    markGlanced: (ids) => void current().markGlanced(ids),
    markAllSeen: (ids, feed) => void current().markAllSeen(ids, feed),
    move: (row, dest, members) => void current().move(row, dest, members),
    deleteMessage: (id, opts) => void current().deleteMessage(id, opts),
    trashList: (cursor) => current().trashList(cursor),
    trashRestore: (id) => current().trashRestore(id),
    sendReply: (id, body, all, sig, sendAt, attachments, andDone, draftId) =>
      current().sendReply(id, body, all, sig, sendAt, attachments, andDone, draftId),
    sendForward: (id, to, body, sig, attachments, andDone, confirmed, draftId) =>
      current().sendForward(id, to, body, sig, attachments, andDone, confirmed, draftId),
    sendNew: (mailboxId, to, subject, body, sig, sendAt, attachments, draftId, copies) =>
      current().sendNew(mailboxId, to, subject, body, sig, sendAt, attachments, draftId, copies),
    sendAndDoneOffered: (id) => current().sendAndDoneOffered(id),
    withdrawSend: (key) => current().withdrawSend(key),
    cancelSchedule: (draftId) => current().cancelSchedule(draftId),
    draftDiscard: (draftId) => current().draftDiscard(draftId),
    draftResolve: (draftId, outcome) => current().draftResolve(draftId, outcome),
    draftSendAgain: (draftId) => current().draftSendAgain(draftId),
    draftKeep: (keep) => current().draftKeep(keep),
    sendOutcome: (key) => current().sendOutcome(key),
    tagToggle: (id, tag, assigned) => void current().tagToggle(id, tag, assigned),
    tagCreate: (id, name) => void current().tagCreate(id, name),
    screenSender: (id, dest, scope, applyRetro, press) => void current().screenSender(id, dest, scope, applyRetro, press),
    screeningForecast: (id, dest, scope, applyRetro) => current().screeningForecast(id, dest, scope, applyRetro),
    screeningRules: (id, scope) => current().screeningRules(id, scope),
    screeningStayed: (id, scope) => current().screeningStayed(id, scope),
    stayedWhy: (ids) => current().stayedWhy(ids),
    moveStayed: (ids, dest) => void current().moveStayed(ids, dest),
    screenUnscreened: () => current().screenUnscreened(),
    folderCreate: (mailboxId, name) => void current().folderCreate(mailboxId, name),
    folderRename: (id, name) => void current().folderRename(id, name),
    folderDelete: (id) => void current().folderDelete(id),
    folderDismiss: (id) => void current().folderDismiss(id),
  };
}

/**
 * THE PRODUCT'S HOUR when nobody has chosen one — 09:00, the hour every horizon below minted
 * before the setting existed. Mirrors the server's `DEFAULT_RESURFACE_TIME` by value: this app
 * cannot import the services package, and the webapp's `format.ts` carries the same constant.
 */
export const DEFAULT_RESURFACE_TIME = "09:00";

/** `'HH:MM'`, 24-hour — the server's shape (`RESURFACE_TIME_RE`), shared by value. */
const RESURFACE_TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * A stored `'HH:MM'` as hour and minute, falling back to 09:00 for anything else — `null`
 * ("never chosen"), a server too old to carry the field, or a value a hand-run UPDATE left in
 * the column. ONE fallback, here, so the sheet's first row and the horizons under it cannot
 * disagree about what an unreadable preference means.
 */
export function resurfaceClock(hhmm: string | null | undefined): { hour: number; minute: number } {
  const use = hhmm != null && RESURFACE_TIME_RE.test(hhmm) ? hhmm : DEFAULT_RESURFACE_TIME;
  return { hour: Number(use.slice(0, 2)), minute: Number(use.slice(3, 5)) };
}

/** `'HH:MM'` from hour and minute — the sheet's rows and the value it writes back. */
export function resurfaceTimeLabel(hour: number, minute: number): string {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

/**
 * THE HOURS THE SHEET OFFERS — every half hour from 06:00 to 22:00, 33 rows. A list rather than
 * a wheel because this app installs no datetime-picker native module (the patch and prebuild
 * traps), and the 90-day list beside it is already the phone's idiom for the webapp's inputs.
 * Half hours rather than whole ones because "half past two" is a thing people say; outside
 * 06:00–22:00 a resurface is a notification in the night, and the row list stays readable.
 * A stored value OUTSIDE this list still shows and still applies — the sheet reads the account's
 * hour, never this array, and only the ROWS are bounded.
 */
export const RESURFACE_HOURS: readonly string[] = Array.from({ length: 33 }, (_, i) =>
  resurfaceTimeLabel(6 + Math.floor(i / 2), (i % 2) * 30));

/*
 * ═══ THE RESURFACE HORIZONS ═══════════════════════════════════════════════════════════════
 *
 * The chosen wall clock is fixed; the instant varies. Two nights a year that clock cannot simply
 * be written onto the day — it is skipped, or it happens twice — and `Date`'s local setters
 * answer both without saying so, which is how a sheet showing 02:30 booked 03:30. Every horizon
 * here is `composeZonedWallClock`, the SAME function the webapp's `format.ts` uses, and carries
 * the clock it booked. The zone is the device's, injectable for the suite — and send later's
 * presets below are the same composition, for the same reason, on the same zone.
 */

/** A HORIZON: the instant booked, the wall clock it READS as, and which rule produced it. */
export interface ResurfaceHorizon {
  at: Date;
  /** `'HH:MM'` where the reader is, read back off `at` — never the digits that were chosen. */
  time: string;
  verdict: WallClockVerdict;
}

/** A calendar day `daysAhead` from `from`, at a chosen wall clock — the phone's one composition. */
function horizonOn(
  from: Date, daysAhead: number, at: string | null | undefined, zone: string,
): ResurfaceHorizon {
  const f = zonedFields(from, zone);
  const { hour, minute } = resurfaceClock(at);
  const booked = composeZonedWallClock(
    { year: f.year, month: f.month, day: f.day + daysAhead, hour, minute }, zone,
  );
  return {
    at: booked.instant,
    time: resurfaceTimeLabel(booked.hour, booked.minute),
    verdict: booked.verdict,
  };
}

/** Tomorrow, at the account's resurface time where the reader is — the chooser's first preset. */
export function tomorrowAt(
  from: Date, at: string | null | undefined, zone: string = readerZone(),
): ResurfaceHorizon {
  return horizonOn(from, 1, at, zone);
}

/** The coming Monday at that time — and never "later today": a Monday resolves to the next one. */
export function nextWeekAt(
  from: Date, at: string | null | undefined, zone: string = readerZone(),
): ResurfaceHorizon {
  return horizonOn(from, (1 - zonedWeekday(from, zone) + 7) % 7 || 7, at, zone);
}

/** A calendar day `n` days ahead at that time — the phone's "Pick a date" rows. */
export function dayAt(
  from: Date, daysAhead: number, at: string | null | undefined, zone: string = readerZone(),
): ResurfaceHorizon {
  return horizonOn(from, daysAhead, at, zone);
}

/** Tomorrow, 09:00 where the reader is — {@link tomorrowAt} at the product's hour. */
export function tomorrowNine(from: Date): Date {
  return tomorrowAt(from, null).at;
}

/** The coming Monday, 09:00 — {@link nextWeekAt} at the product's hour. */
export function nextWeekNine(from: Date): Date {
  return nextWeekAt(from, null).at;
}

/** A calendar day `n` days ahead, 09:00 local — {@link dayAt} at the product's hour. */
export function dayNine(from: Date, daysAhead: number): Date {
  return dayAt(from, daysAhead, null).at;
}

/*
 * Send later's horizons. The resurface presets are reused where the meaning coincides —
 * "tomorrow morning" and "Monday morning" are `tomorrowNine`/`nextWeekNine`, the product's one
 * 09:00-where-the-reader-is convention (the webapp's `format.ts` says the same sentence over
 * the same two functions). Sending adds exactly two things resurfacing never needed: an
 * evening preset (nobody resurfaces mail at dinner; plenty send it then), and a label that can
 * name a day further out than a week, because an appointment may be months away.
 */

/**
 * Today at 18:00 where the reader is — the "this evening" send preset. MAY BE IN THE PAST late
 * in the day; the caller offers it only while it is meaningfully ahead of now
 * ({@link SEND_LATER_MIN_LEAD_MS}), which is the webapp `ComposeView`'s own rule.
 *
 * The composition, not a bare instant: 18:00 is only ever exact because no zone moves its clocks
 * at dinner, and the verdict is what says so rather than the list's shape being trusted for it.
 */
export function todayEvening(from: Date, zone: string = readerZone()): ZonedComposition {
  const f = zonedFields(from, zone);
  return composeZonedWallClock({ year: f.year, month: f.month, day: f.day, hour: 18 }, zone);
}

/**
 * HOW FAR AHEAD AN APPOINTMENT MUST SIT to be offered at all — the webapp's floor, shared by
 * value rather than by import (this app cannot import the webapp shell). Three minutes: the
 * shortest schedule anyone plausibly wants is still expressible, and "this evening at 18:00"
 * pressed at 17:59 is a promise measured in seconds, which the honest menu simply omits.
 *
 * The floor is a COURTESY, not the authority: the server refuses a past `sendAt` against ITS
 * clock (the one the due scan runs on), and this only keeps the phone from offering a pick it
 * knows will be refused.
 */
export const SEND_LATER_MIN_LEAD_MS = 3 * 60 * 1000;

/**
 * THE HOURS a picked day may be scheduled at. The product already fixes two of them — 09:00 is
 * the resurface horizons' hour, 18:00 is the evening send preset's — and this list is those two
 * plus the four ordinary hours around them. A free-text time on a phone is a keyboard over a
 * sheet for a value with six plausible answers; the honest list is shorter than the input.
 */
export const SEND_LATER_HOURS = [8, 9, 12, 15, 18, 21] as const;

/**
 * NINETY-ONE DAYS from the picker's frozen "now", today included — the resurface chooser's own
 * quarter-ahead span (a fortnight did not cover the horizons people actually book, and was an
 * exclusion nothing on screen admitted). Today survives the list only while {@link usableHours}
 * leaves it an hour; the picker's days step applies that filter.
 */
export const DAY_OFFSETS: number[] = Array.from({ length: 91 }, (_, i) => i);

/**
 * A calendar day `offset` days from `from`, at `hour` where the reader is — the picker's one
 * appointment maker, and the same composition the horizons above use.
 *
 * `setDate`/`setHours` counted the day and wrote the hour in the PROCESS's zone and answered both
 * of the two nights without saying which rule it had applied. The hours offered today cross no
 * transition; `hour` is the parameter, not the list, so the rule holds for whatever the list
 * becomes.
 */
export function dayAtHour(
  from: Date, offset: number, hour: number, zone: string = readerZone(),
): ZonedComposition {
  const f = zonedFields(from, zone);
  return composeZonedWallClock({ year: f.year, month: f.month, day: f.day + offset, hour }, zone);
}

/**
 * The hours on that day still worth offering — everything at least {@link SEND_LATER_MIN_LEAD_MS}
 * ahead of the picker's frozen "now". This is what makes a past pick STRUCTURALLY impossible
 * from the rows (the press re-checks against the REAL clock for the sheet that sat open across
 * one of them), and what decides whether "today" is offered as a day at all.
 *
 * It lives here rather than in the sheet because a lead filter is logic, and this module's
 * charter is that the screens hold none: the suite drives the rule without a renderer.
 */
export function usableHours(from: Date, offset: number, zone: string = readerZone()): number[] {
  return SEND_LATER_HOURS.filter(
    (hour) =>
      dayAtHour(from, offset, hour, zone).instant.getTime() - from.getTime() >= SEND_LATER_MIN_LEAD_MS,
  );
}

/**
 * AN INSTANT IN A SENTENCE — a set time (a resurface, a send-later, the away end date) or a past
 * one (the stale mirror's "as of", an outage's "since") — read where the reader is: `10:00` today,
 * `Fri 10:00` inside the week, `25 Dec, 10:00` past it. The engine's `appointmentStamp`, the one
 * the webapp's `resurfaceLabel`, `scheduleLabel` and `waterlineStamp` read, so the phone and the
 * web name an instant alike. Not-ISO input echoes through; an unknown zone throws there and
 * echoes here.
 */
export function setTimeLabel(iso: string, now: Date, zone: string, locale = "en"): string {
  if (!/^\d{4}-\d{2}-\d{2}T/.test(iso)) return iso;
  try {
    return appointmentStamp(new Date(iso), now, zone, locale);
  } catch {
    return iso;
  }
}

/** The send-later appointment — {@link setTimeLabel}, under the name its callers already use. */
export function scheduleLabel(iso: string, now: Date, zone: string): string {
  return setTimeLabel(iso, now, zone);
}

/**
 * A CALENDAR DAY'S NAME, as this language shortens it — "Tue 22 Sept". `Intl` decides how a
 * language abbreviates a weekday and a month and that is not ours to invent (German writes "Di."
 * and "Sept." with stops, which a hand-written table gets wrong in a way nobody reviews). The
 * failure arm is the platform's last resort on a runtime with no ICU data: an unlocalised date
 * beats no date. Here rather than in a screen because two surfaces name days — the resurface
 * chooser and the away responder's end date — and one spelling of this is the point.
 */
export function calendarDayLabel(day: Date, locale: string): string {
  try {
    let fmt = DAY_LABELERS.get(locale);
    if (fmt === undefined) {
      fmt = new Intl.DateTimeFormat(locale, { weekday: "short", day: "numeric", month: "short" });
      DAY_LABELERS.set(locale, fmt);
    }
    return fmt.format(day);
  } catch {
    return day.toDateString();
  }
}
/** One day-name formatter per language: constructing one is the expensive part of a label. */
const DAY_LABELERS = new Map<string, Intl.DateTimeFormat>();

/**
 * THE END OF A CALENDAR DAY WHERE THE READER IS — the instant an end date resolves to.
 *
 * The webapp's `dayEnd`, and the direction matters: a date is a DAY to the person choosing it and
 * an INSTANT to the server, so "off on the 24th" has to mean the 24th's last second in their own
 * zone. Resolved at 23:59:59 rather than the next midnight so the stored instant reads back as
 * the day that was picked, whichever way a reader formats it.
 */
export function dayEndIso(from: Date, daysAhead: number, zone: string = readerZone()): string {
  const base = new Date(from.getTime() + daysAhead * 86_400_000);
  const f = zonedFields(base, zone);
  return zonedInstant(
    { year: f.year, month: f.month, day: f.day, hour: 23, minute: 59, second: 59 }, zone,
  ).toISOString();
}

/**
 * Has this mirror ever completed a drain — the boot-from-local question, answered from the
 * engine's own completion stamp ({@link LAST_DRAIN_AT_META}). It separates the two states a
 * zero-row list can be in, which must never be conflated: settled — a drain finished, so zero
 * rows is a genuinely empty mailbox and the empty state may speak; unsettled — no drain ever
 * completed (first launch, or a bootstrap killed early), so zero rows is unknown and the
 * screen owes the reader `listSurface`, never "Nothing here". The stamp persists in the
 * mirror, so a warm relaunch renders in its first frame with the network unasked
 * (`boot-surface.test.ts` pins it). Typed against the one method it reads, not the store class.
 */
export function mirrorSettled(store: { getMeta<T>(key: string): T | undefined }): boolean {
  return store.getMeta<string>(LAST_DRAIN_AT_META) !== undefined;
}

/**
 * The stale label's time, or `null` when no label is owed — the Freshness Contract's middle
 * state (INSTANT-ARCH §6.6) on this surface. `mirrorSettled` separates unknown from settled;
 * this separates settled-and-current from settled-and-stale: a mirror whose last drain is
 * older than the engine's threshold renders instantly — local rows are renderable truth — and
 * the chrome says how old ("As of Fri 09:00 · catching up") until a drain settles. The engine
 * is the one derivation (`engine.freshness()`, the same stamp `freshenStaleResume` reads), so
 * this surface cannot disagree with the webapp's strip about what stale means. Formatted here
 * through {@link setTimeLabel} — the chrome gets a sentence-ready time in the reader's own zone.
 */
export function staleAsOf(
  engine: { freshness(): { state: "unknown" | "stale" | "current"; asOf: string | null } },
  zone: string,
  now: Date,
): string | null {
  const f = engine.freshness();
  return f.state === "stale" && f.asOf !== null ? setTimeLabel(f.asOf, now, zone) : null;
}

/**
 * THE STALE LABEL'S SENTENCE. "Catching up" is an activity, so it is said only while a round is in
 * flight; otherwise the age alone — "As of Fri 09:00". It used to follow the AGE: five minutes after
 * the one drain an open phone said "catching up" with nothing running, for as long as it stayed open.
 */
export function staleSaid(stale: string, draining: boolean): string {
  return draining ? Copy.staleAsOf(stale) : Copy.staleAsOfIdle(stale);
}

/**
 * HOW LONG AN OUTAGE RUNS BEFORE THE SENTENCE STOPS PROMISING A RECONNECT (ruled, 2026-09-11).
 *
 * Under it the app says it is re-dialling, which is true: the phone profile's ladder is
 * 5/15/30/60 s and its last step REPEATS, so it never runs out — "the ladder is exhausted" is a
 * condition that cannot arrive on a phone, and the wall clock is the only honest trigger. Past
 * it, five minutes of failed dials is no longer a reconnect somebody should keep waiting for.
 */
export const RECONNECT_PROMISE_MS = 5 * 60_000;

/**
 * What the connection is doing, as one of three answers a surface can render. `null` is the fourth
 * and the important one: nothing has said yet — a paired session, a phone with no engine, or a door
 * whose first cycle has not run — and a surface renders no sentence for it rather than "Connection
 * lost" a second after the mailbox opened. The discriminant is `kind`, not `say`: `say` is a
 * rendered name on this app's copy census (`refusal.ts`), so a union keyed on it would read as
 * English words outside the deck. `refused` is separated from `lost` because the remedies are
 * opposite — an unreachable server is re-dialled and heals, a rejected sign-in is not retried and
 * needs a person — so this keeps the freshness line from claiming a reconnect nothing attempts.
 */
export type ConnectionSay =
  | { readonly kind: "reachable" }
  | { readonly kind: "refused" }
  /** This phone refused the server's certificate — no password sent, nothing re-dialling. */
  | { readonly kind: "certificate" }
  /** No password on this phone for this mailbox — nothing was dialled and nothing is retrying. */
  | { readonly kind: "needsCredential" }
  /** The server answers and this phone's store refuses the mail, so the engine holds it back. */
  | { readonly kind: "writeOffsHeld" }
  | { readonly kind: "lost" }
  | { readonly kind: "gone"; readonly since: string };

/**
 * THE ENGINE'S CONNECTION FACTS, READ AS ONE VERDICT — the door answers, this ranks.
 *
 * Only `gone` carries a time, and only because only its sentence names one. It is
 * sentence-ready in the reader's zone, on {@link staleAsOf}'s rule that the world layer hands
 * the chrome words and not instants. An outage with NO stamped instant stays `lost` however
 * long it runs — the second sentence is "since <time>", and there is no time to name.
 */
/**
 * THE SENTENCE FOR A VERDICT, or `null` where a surface says nothing — ONE ranking, two surfaces.
 *
 * The top bar and Settings → This phone both render it, and they must not disagree: two copies of
 * this `if` is how one of them ends up still promising a reconnect. `reachable` is the healthy
 * state and says nothing; `refused` is the door's own refusal — an answered no that nothing is
 * re-dialling — and it is said in its own words rather than dressed as an outage.
 */
export function connectionSaid(verdict: ConnectionSay | null): string | null {
  if (verdict === null || verdict.kind === "reachable") return null;
  /* SAID NOW, AND IT WAS SILENT BEFORE. A refused sign-in is not an outage and must never be
     dressed as one — but it was silent because nothing on this phone could be done about it, and
     a state with no remedy said nothing rather than saying a thing somebody could not act on.
     The remedy is beside it now, so the fact is said in the same words every other surface uses. */
  if (verdict.kind === "refused") return Copy.connectionSignInRefused;
  if (verdict.kind === "certificate") return Copy.connectionCertificateRefused;
  if (verdict.kind === "needsCredential") return Copy.connectionNeedsPassword;
  if (verdict.kind === "writeOffsHeld") return Copy.connectionMailHeld;
  return verdict.kind === "lost" ? Copy.connectionLost : Copy.connectionGoneSince(verdict.since);
}

/**
 * THE TOP LINE'S ONE SENTENCE, RANKED — the TopBar renders exactly this. No network outranks
 * everything: it is WHY the link is gone and the mirror stale, and it is read from
 * the platform's door, so a paired phone — which has no connection verdict — says it too.
 */
export function topLineSaid(o: {
  network: NetworkState;
  connection: ConnectionSay | null;
  stale: string | null;
  draining: boolean;
  continuing: string | null;
}): { text: string; alert: boolean } | null {
  if (o.network === "offline") return { text: Copy.networkOffline, alert: true };
  const outage = connectionSaid(o.connection);
  if (outage !== null) return { text: outage, alert: true };
  if (o.stale !== null) return { text: staleSaid(o.stale, o.draining), alert: false };
  return o.continuing !== null ? { text: o.continuing, alert: false } : null;
}

/** A read the server did not answer, said about its cause: the phone's own network first. */
export function unansweredSaid(network: NetworkState, surface: "search" | "history"): string {
  if (network === "offline") return Copy.networkOfflineHeld;
  return surface === "search" ? Copy.searchUnanswered : Copy.historyStoreUnavailable;
}

export function connectionSay(
  here: {
    reachable: boolean | null;
    unreachableSince: string | null;
    signInRefused: boolean;
    certificateRefused?: boolean;
    needsCredential?: boolean;
    dialled?: boolean;
    writeOffsHeld?: boolean;
  } | null,
  now: Date,
  zone: string,
): ConnectionSay | null {
  if (here === null || here.reachable === null) return null;
  /* RANKED ABOVE `reachable`, because a refused sign-in leaves the connection dead AND
     un-retried: both flags are set, and the arm that says "Reconnecting…" would be a promise
     nothing is keeping. */
  if (here.signInRefused) return { kind: "refused" };
  /* ABOVE the outage arms for the refusal's reason: "Reconnecting…" would be a promise nothing
     keeps, and the remedy is the server's certificate, not the network. */
  if (here.certificateRefused === true) return { kind: "certificate" };
  /* ABOVE `reachable` AND ABOVE THE OUTAGE ARMS BELOW, for the reason `refused` is above both:
     nothing was dialled, so "Connection lost. Reconnecting…" is a promise nothing is keeping and
     an outage clock is a duration there is no start for. The remedy is a password. */
  if (here.needsCredential === true) return { kind: "needsCredential" };
  /* NOTHING HAS DIALLED IT YET — a password sealed onto a skipped launch is dialled by the next
     one. Nothing was tried and nothing failed, so no verdict: "Reconnecting…" would promise a
     re-dial nothing is making, and the freshness stamp speaks meanwhile. */
  if (here.dialled === false) return null;
  /* BELOW THE OUTAGE ARMS' PREMISE: only over a link that is up. The server answers and the mail
     still does not arrive, so "reachable" — which says nothing — would be the healthy-looking strip
     over a mailbox that has stopped. */
  if (here.reachable) return here.writeOffsHeld === true ? { kind: "writeOffsHeld" } : { kind: "reachable" };
  const stamp = here.unreachableSince;
  if (stamp === null) return { kind: "lost" };
  const since = Date.parse(stamp);
  if (Number.isNaN(since)) return { kind: "lost" };
  return now.getTime() - since < RECONNECT_PROMISE_MS
    ? { kind: "lost" }
    : { kind: "gone", since: setTimeLabel(stamp, now, zone) };
}

/**
 * WHAT THE FIRST SYNC OF THIS MAILBOX PRODUCED, as one verdict — the engine answers, this ranks.
 *
 * BESIDE {@link connectionSay} and deliberately not folded into it: two surfaces need both at
 * once, and a single ranking would have to drop one. Measured against a server that signs you in
 * and refuses to hand over the mail, the link reads dead AND the first sync has produced nothing
 * — "Reconnecting…" alone sends somebody to look at a network that is fine. `null` is "nothing
 * has said" (a paired session, no engine, a first drain not back) and is its own state, for
 * `connectionSay`'s reason.
 */
export type FirstSyncSay = "pending" | "finished" | "nothingReadable";

export function firstSyncSay(here: { firstSync: string | null } | null): FirstSyncSay | null {
  if (here === null || here.firstSync === null) return null;
  if (here.firstSync === "produced_nothing_readable") return "nothingReadable";
  if (here.firstSync === "finished") return "finished";
  if (here.firstSync === "pending") return "pending";
  /* A SPELLING THIS BUILD HAS NEVER HEARD OF is "nothing has said", never a guess. The engine is
     a pre-bundled artifact and may be newer than this app; inventing a verdict for an unknown
     value is how a surface ends up asserting something no engine ever claimed. */
  return null;
}

/**
 * THE SENTENCE FOR A VERDICT, or `null` where a surface says nothing — ONE ranking, two surfaces,
 * on {@link connectionSaid}'s rule. `pending` and `finished` are silent: a first sync still
 * working is what the skeleton and the freshness label already say, and a finished one is the
 * ordinary state.
 */
export function firstSyncSaid(verdict: FirstSyncSay | null): string | null {
  return verdict === "nothingReadable" ? Copy.firstSyncNothingReadable : null;
}

/**
 * MESSAGES THIS PHONE SET ASIDE, said — or `null`. Its own line below the connection verdicts and
 * never an alert: the link may be fine and the rest of the mail here, and the sentence names a
 * count only. `null` where nothing has said (a paired session) and at zero.
 */
export function setAsideSaid(here: { setAside?: number } | null): string | null {
  const n = here?.setAside ?? 0;
  return Number.isInteger(n) && n > 0 ? Copy.connectionSetAside(n) : null;
}

/**
 * WHERE A BUDGETED FIRST SYNC IS CONTINUING, said — `MailboxDTO.firstSyncStopFolder` off the
 * mailbox rows, the browser strip's twin (`mail-state.ts#continuesAtFolder`, rendered as
 * `sync.importingContinuesAt`). ONE rule, and it is the reason this is a derivation rather than
 * a field a screen reads: exactly one mailbox may name a folder, because the sentence has no room
 * to say whose it is and a folder name against the wrong mailbox is a lie. `null` everywhere else,
 * and every one of those cases is silence.
 */
export function firstSyncContinuesSaid(
  mailboxes: readonly { firstSyncStopFolder?: string | null }[],
): string | null {
  const named = mailboxes
    .map((m) => m.firstSyncStopFolder)
    .filter((f): f is string => typeof f === "string" && f !== "");
  return named.length === 1 ? Copy.firstSyncContinuesAt(named[0]!) : null;
}


/* Re-exported so the world layer and the suite spell the vocabulary identically. `FolderEntity`
 * rides through here because `live.ts` is the one state module on the engine's import
 * allow-list (`test/privacy.test.ts`) — the world layer and the screens take the type from
 * this seam, never from the package. `SIG_FOLLOWING`/`effectiveSignature` (the composer's
 * signature block) and `folderNameError` (the folder verbs' pre-wire honest sentence — the
 * SERVER's own rules, shared through the engine) ride through on the same terms. */
/* `sendingMailboxId` passes through UNCHANGED: the compose-from fallback is the engine's,
   and a second derivation here would be a second answer to one question. */
export { destDone, isPlace, SIG_FOLLOWING, effectiveSignature, folderNameError, sendingMailboxId };
export type {
  AddressDirection, Destination, FolderEntity, FolderNameError, Held, Mail, PileItem, PileKind,
  Place, Scope, SignatureState,
};

/** The derived stamp's deny list and the reader's day number, through this seam. */
export { NOT_DERIVED_FROM, zonedDayNumber, beginDerive, takeClientEngineVitals };
/* The world clock's inputs (`world-clock.ts`): the zone arithmetic and the send thresholds. */
export { zonedFields, zonedInstant, HELD_SEND_RECHECK_MS, SENDING_STALE_AFTER_MS };
export type { EngineDraft };

/**
 * ONE MESSAGE'S BODY, read at the moment a surface draws it — the list rows carry none (see
 * {@link toListRow}). The surface subscribes to the body stamp (`useBodyStamp`) so a body that lands
 * redraws it. `null` for a message the mirror does not hold.
 */
export function liveBody(engine: OhmailEngine, id: string): Pick<WorldMail, "body" | "bodyState" | "bodyWithheld"> | null {
  const reader = engine.read();
  const m = reader.get<EngineMessage>("message", id);
  if (m === undefined) return null;
  const b = bodyOf(reader, m);
  return { body: b.text, bodyState: b.state, ...(b.state === "withheld" && b.withheld ? { bodyWithheld: b.withheld } : {}) };
}

/**
 * THE QUIET COMMIT A KILLED SESSION'S DELETE IS REPLAYED THROUGH (`held-delete.ts`, opened by
 * `world.tsx`): the delete as pressed where the mirror holds the message; `true` where it does not
 * because the engine's outbox already carries this delete (a kill after the commit reached the outbox
 * and before its record was forgotten: the tombstone hid it); `"nothing"`, said lost, otherwise.
 */
export function deleteReplayDispatch(
  engine: Pick<OhmailEngine, "read" | "pendingMutations" | "inFlightMutations">,
  del: (id: string) => Promise<boolean>,
): (id: string) => Promise<boolean | "nothing"> {
  return (id) => {
    if (engine.read().get("message", id) !== undefined) return del(id);
    const carried = [...engine.pendingMutations(), ...engine.inFlightMutations()]
      .some((p) => p.mutation.kind === "message_delete" && p.mutation.messageId === id);
    return Promise.resolve(carried ? true : ("nothing" as const));
  };
}
