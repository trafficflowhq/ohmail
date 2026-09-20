/**
 * The live world — what the mail screens render and dispatch when the connection is live; the
 * one seam between screens and engine. Reads are the shared selectors, never re-derived
 * (`ohboxView`, `readsPartition`, `receiptsByDay`, `screenerSegments`, `triagePiles`, `bodyOf`,
 * `threadOf`) over the consent-cutline projection (`presentationReader` ∘ `consentPartition`),
 * so this phone shows the piles any other client shows. Writes go through `engine.mutate`,
 * watched: `rolled_back` raises one sentence, `queued` is not a failure (the webapp's `moveAll`
 * doctrine); the release family rewrites the holding rule (`rule_update` beside physical
 * `move`s). Mutations read the raw mirror ({@link presentedOf} is for renders); no React, no I/O, no network.
 */
import {
  FOLDER_OF_VIEW,
  LAST_DRAIN_AT_META,
  VIEW_OF_FOLDER,
  bodyOf,
  consentPartition,
  forwardSubject,
  dateClock,
  messageDisplayTime,
  weekdayClock,
  composeZonedWallClock,
  zonedFields,
  zonedWeekday,
  feedPartition,
  ohboxView,
  physicalFolderOf,
  presentationReader,
  presentsUnread,
  retroPassWouldMove,
  readsPartition,
  receiptsByDay,
  rulesList,
  scheduledSendsList,
  screenerAdviceAi,
  screenerSegments,
  senderKey,
  threadOf,
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
  type BodyState,
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
  type PressVerdict,
  type RuleDTO,
  type ScreenDest,
  type ScreenerSenderDTO,
  inverseMutations,
  routingSubject,
  type RoutingIntent,
  type TagDTO,
  type TrashRowWire,
  type WallClockVerdict,
  type WithdrawOutcome,
  type ZonedComposition,
  resurfacedThreads,
  conversationSize,
} from "@ohmail/client-engine";
import { Copy } from "../copy";
import { blobToBase64 } from "../mail/blob-base64";
import { logAttachmentRefusal } from "../engine/engine-log";
import { refuse, type Refusal, type RefusalArg } from "../refusal";
import { ACCESS_REFUSED_CODE } from "../net/access-lock";
import { folderLeafOf, folderUnreadCounts } from "./folders";
/* Move/Junk: the mail now, the sender's routing after the window. See the module. */
import { holdRouting, undoRouting } from "./held-routing";
import type { ScreeningAnswer } from "../net/consent";
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
  const partition = consentPartition(reader, {
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
  });
  return {
    reader: presentationReader(reader, partition),
    history: partition.history,
    cutlinePending: screening.state === "unanswered",
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
  | { state: "too_large" | "failed" | "unavailable" };

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
export type WorldMail = Mail & {
  attachments?: WorldAttachment[];
  bodyState?: BodyState;
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
  /** `sensitivity.no_forward` — the forward entry is ABSENT on such a message, never dead. */
  noForward: boolean;
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
  const body = bodyOf(reader, m);
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
    subject: m.subject,
    time: messageDisplayTime(m, v.now, v.zone, v.locale ?? "en"),
    body: body.text,
    bodyState: body.state,
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
    labels: [...(m.labels ?? [])],
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
                       organizerState: "held" | "stopped" | null }[],
): PhoneOrganizer | null {
  const named = mailboxes.filter((m) => (m.organizedBy?.name ?? "") !== "");
  if (named.length === 0) return null;
  const distinct = new Set(named.map((m) => m.organizedBy!.name!));
  if (distinct.size !== 1) return null;
  const first = named[0]!;
  return {
    name: first.organizedBy!.name!,
    kind: first.organizedBy!.kind ?? null,
    /* STOPPED ONLY IF EVERY ROW SAYS SO. With one holder across several mailboxes a mixed
       answer means the claim is still being renewed somewhere, and "stopped organizing" would
       be the more alarming of the two sentences told on the weaker evidence. */
    stopped: named.every((m) => m.organizerState === "stopped"),
  };
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
   * has no Drafts screen: filtered the same way the message would vanish entirely, and "it
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
  const fresh = rows.filter((m) => m.unread).map((m) => toMail(pres, m, v));
  const seen = rows.filter((m) => !m.unread).map((m) => toMail(pres, m, v));
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

/** The Ohbox — `ohboxView` over the projection, reshaped and nothing more. */
export function liveOhbox(pres: EntityReader, v: WorldView): WorldOhbox {
  const box = ohboxView(pres);
  const map = (list: EngineMessage[]) => list.map((m) => toMail(pres, m, v));
  const fresh = map(box.newForYou);
  const seen = map(box.previouslySeen);
  /**
   * ONE ROW PER CONVERSATION, from the engine's own `resurfacedThreads` — the same rows the web
   * app draws. The pin is per message, so `box.resurfaced` lists a conversation parked as five
   * messages five times; the row is what the reader asked to see again. The row opens on its
   * newest member and carries the badge for what arrived since.
   */
  const rows = resurfacedThreads(pres);
  const resurfaced = rows.map((r) => {
    const mail = toMail(pres, r.openTarget, v);
    return r.newSince.length > 0 ? { ...mail, newSince: r.newSince.length } : mail;
  });
  /* THE COUNT IS ABOUT THE MAILBOX; THE BOLD IS ABOUT THE PIN. The rows above have been
     through `toMail`, whose `unread` is `presentsUnread` and therefore true for every pin —
     counting THEM would say "1 unread" over a message the mail server calls read. So the set
     is built from the engine's own facts: new-for-you rows plus every unread MEMBER of every
     pinned conversation (folding five unread replies into one row does not make them one
     message). Mark-all-read flips exactly these ids, and `unread` is this list's length, so
     the number a person presses on and the ids the press dispatches cannot disagree. */
  const unreadIds = [
    ...box.newForYou.map((m) => m.id),
    ...rows.flatMap((r) => r.members.filter((m) => m.unread).map((m) => m.id)),
  ];
  return {
    resurfaced,
    fresh,
    seen,
    unreadIds,
    unread: unreadIds.length,
    total: resurfaced.length + fresh.length + seen.length,
  };
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
  const items = all.map((m) => toMail(pres, m, v));
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
  const groups = receiptsByDay(pres, v.now, v.locale ?? "en", v.zone).map((g) => ({
    label: g.label,
    items: g.items.map((m) => toMail(pres, m, v)),
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
export type ScreenerHeld = Held & { bodyState?: BodyState };

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
    held,
    screenedOn: dto.screenedOn ?? "",
    detection: "",
    gatePhysical: dto.gatePhysical !== false,
  };
}

/**
 * A reader in which the server's waiting senders are at the gate. `screenerSegments` groups over
 * the PROJECTION, which re-homes a DECIDED sender's gate mail to the rule's destination
 * (`consent-cutline.ts`) — right for the Ohbox, wrong for this queue: the mail is still physically
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
 * A ROW FOR A SENDER THE ROUTE NAMES AND THIS MIRROR CANNOT BACK.
 *
 * The mirror is WINDOWED (90 days, a floor of rows) while the queue is not, so the route can
 * name a sender whose mail this phone does not hold. Such a sender still gets a row — dropping
 * them would put the phone back to showing fewer senders than the server, which is the whole
 * defect — built from what the route itself states. `held` carries the one message the route
 * named, at its own stamp; the sender screen hydrates nothing further, because there is nothing
 * on this device to hydrate from.
 */
function rowOfServer(
  s: ServerWaitingSender, v: WorldView, scope: Scope | undefined,
  /**
   * The mirror's advice for this sender, joined in by the caller ({@link screenerAdviceAi} by
   * `senderKey`) — the route's parse carries none, and the suggestion entity is NOT bounded by
   * the message window (its cascade follows a removal, never an absence), so a sender this
   * mirror cannot back can still have a live verdict to badge.
   */
  ai: ScreenerRow["ai"] = null,
): ScreenerRow {
  const name = s.name || s.address;
  const time = messageDisplayTime({ date: s.receivedAt }, v.now, v.zone, v.locale ?? "en");
  return {
    id: s.messageId,
    routeKey: senderKey(s.address),
    name,
    address: s.address,
    initial: (name.trim()[0] ?? "?").toUpperCase(),
    time,
    newestSubject: s.subject,
    dull: false,
    scope: scope ?? "sender",
    ai,
    held: [{ id: s.messageId, subject: s.subject, time, body: s.snippet, bodyState: "snippet", seen: false }],
    screenedOn: "",
    detection: "",
    // The route only ever names mail it is holding at the gate.
    gatePhysical: true,
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
  // `v.ownAddresses` rides in for the reason it rides into `presentedWorld`: the projection keeps
  // an own-address row in its own place, so without it a self-addressed message in the Screener
  // folder is a waiting row and the reader queues in their own queue.
  const queueReader = server === null ? pres : gateReader(pres, waitingKeys);
  const segments = screenerSegments(queueReader, v.now, v.locale ?? "en", v.zone, v.ownAddresses);
  const map = (rows: ScreenerSenderDTO[]) =>
    rows.map((dto) => rowOf(dto, scopes[senderKey(dto.from.address)]));
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
  const derived = new Map(segments.waiting.map((dto) => [senderKey(dto.from.address), dto]));
  // The mirror's advice, joined onto the rows the derivation cannot back — a minted row's badge
  // is the same verdict a derived row's is, read through the same selector.
  const advice = screenerAdviceAi(pres);
  const waiting = server.map((s) => {
    const key = senderKey(s.address);
    const dto = derived.get(key);
    return dto ? rowOf(dto, scopes[key]) : rowOfServer(s, v, scopes[key], aiOfDto(advice.get(key) ?? null));
  });
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
      ? { resurfaceAt: messageDisplayTime({ date: e.resurfaceAt }, v.now, v.zone, v.locale ?? "en") }
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
  const items = history.map((m) => {
    const stamped: EngineMessage = { ...m, physicalFolder: m.folder };
    const row = toMail(raw, stamped, v);
    row.historyPlace = physicalFolderOf(stamped);
    return row;
  });
  return { items, total: items.length, pending: postureOf(v).state === "unanswered" };
}

/**
 * The reading view's row: the mirror's message with its body resolved (`bodyOf` — hydrated
 * text once `hydrateBody` lands, honest `bodyState` until then), its conversation as the
 * `earlier` shape (`threadOf`, every member rendered in full), and the attachment
 * strip from the engine's own items — whose nameless-ICS fallback (`invite.ics`) the engine
 * already mints, matching the webapp and the download names.
 */
export function liveMessage(engine: OhmailEngine, id: string, v: WorldView): WorldMail | undefined {
  // The view's own folder flag rides into the projection — a folder-filed message opened from
  // the folder screen is otherwise a History drop (`placeOf` null ⇒ `get` answers undefined)
  // and the reader says "no longer here" over mail the list just showed. The CUTLINE answer
  // rides in for exactly the same reason and it is the same failure: a row a list showed under
  // the account's window must open under it too, never under this package's default.
  const world = presentedWorld(
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
  if (!m) return undefined;
  const pres = projected ? world.reader : engine.read();
  const row = toMail(pres, m, v);
  // The place the reader arrived through, on the row that carries no other honest one: the
  // message screen titles itself History off this, where `place` would say Ohbox.
  if (retired) row.historyPlace = physicalFolderOf(m);
  row.earlier = threadOf(pres, id)
    .filter((member) => member.id !== id)
    .map((member) => ({
      id: member.id,
      subject: member.subject,
      time: messageDisplayTime(member, v.now, v.zone, v.locale ?? "en"),
      body: bodyOf(pres, member).text,
      seen: !member.unread,
    }));
  // The reading view's own facts, attached here and not in `toMail`: a list row never pays
  // for a document it will not draw. `EVERY_PART` is a variable on purpose — the engine's
  // option has two spellings (`includeInlineParts` widened from `includeInlineImages`), and a
  // variable, unlike a literal, compiles against either signature, so this call is correct
  // whichever the engine beside it carries.
  const hydrated = bodyOf(pres, m);
  row.html = hydrated.html;
  row.loadedRemoteContent = hydrated.loadedRemoteContent;
  row.inlineImages = engine.inlineImagesOf(id);
  const EVERY_PART = { includeInlineImages: true, includeInlineParts: true };
  const atts = engine.attachmentsOf(id, EVERY_PART);
  if (atts.state === "ready" && atts.items.length > 0) {
    // Real files first, the body's own pictures after them — the web strip's partition.
    const items = [...atts.items].sort((a, b) => Number(a.inline) - Number(b.inline));
    row.attachments = items.map((item) => ({
      id: item.id,
      filename: item.filename,
      size: sizeLabel(item.sizeBytes),
      inline: item.inline,
      mime: item.mimeType,
      state: item.state,
    }));
  }
  return row;
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
      .map((h) => toMail(base, h.message, v));
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
 * Does this rule match this sender, by the same test `core/src/rules.ts#matches` applies —
 * mirrored from `apps/webapp/app/shell/sender-audit.ts#ruleMatchesSender` (the reference).
 * Exact equality on the lower-cased address or its domain; never a suffix test; `header`
 * rules answer false.
 */
function ruleMatchesSender(rule: RuleDTO, address: string): boolean {
  const addr = address.trim().toLowerCase();
  if (rule.kind === "sender") return rule.match.trim().toLowerCase() === addr;
  if (rule.kind === "domain") {
    const d = domainOf(addr).toLowerCase();
    return d !== "" && rule.match.trim().toLowerCase() === d;
  }
  return false;
}

/**
 * The enabled rules HOLDING this sender in `folder` — the rows a release must rewrite.
 * Mirrored from `apps/webapp/app/shell/sender-screening.ts#holdingRules` (the reference):
 * plain sender/domain rules only; a subject- or body-termed rule is a narrower claim a
 * release must not silently widen.
 */
function holdingRules(reader: EntityReader, address: string, folder: Folder): RuleDTO[] {
  return rulesList(reader).filter(
    (r) =>
      r.enabled &&
      r.destination === folder &&
      (r.subjectContains ?? "").trim() === "" &&
      (r.bodyContains ?? "").trim() === "" &&
      ruleMatchesSender(r, address),
  );
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
  return holdingRules(reader, intent.address, intent.from as Folder)
    .map((r) => ({ kind: "rule_update", ruleId: r.id, destination: folder }));
}


/** `PATCH /messages` id cap per request — the webapp's own batch size. */
const MARK_SEEN_MAX = 200;

/**
 * A `mark_seen` wider than the PATCH cap, split — mark-all-read's inverse can carry more ids
 * than one request may, and an oversized inverse would be one refused request taking nothing back.
 */
function chunkMarkSeen(list: EngineMutation[]): EngineMutation[] {
  return list.flatMap((mu) => {
    if (mu.kind !== "mark_seen" || mu.messageIds.length <= MARK_SEEN_MAX) return [mu];
    const out: EngineMutation[] = [];
    for (let i = 0; i < mu.messageIds.length; i += MARK_SEEN_MAX) {
      out.push({ ...mu, messageIds: mu.messageIds.slice(i, i + MARK_SEEN_MAX) });
    }
    return out;
  });
}

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
  // Quote-aware split: `"Doe, Alice" <alice@x.org>` is ONE entry — a comma inside double
  // quotes is part of the display name, not a delimiter. A naive split refused exactly the
  // shape address books paste.
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
  const trimmed = entries.map((e) => e.trim()).filter((e) => e !== "");
  const out: { name: string | null; address: string }[] = [];
  for (const entry of trimmed) {
    const angled = /^(.*)<([^<>\s]+@[^<>\s]+\.[^<>\s]+)>$/.exec(entry);
    if (angled) {
      const name = angled[1]!.trim().replace(/^"(.*)"$/, "$1");
      out.push({ name: name === "" ? null : name, address: angled[2]! });
      continue;
    }
    if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(entry)) {
      out.push({ name: null, address: entry });
      continue;
    }
    return null;
  }
  return out;
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
export type SendOutcome = "sent" | "queued" | "failed" | "unverified";

/** One classifier for a send's MutationResult — the composer and the flush ledger agree by construction. */
export function sendOutcomeOfResult(r: MutationResult | null): SendOutcome {
  if (!r) return "failed";
  if (r.status === "confirmed") return "sent";
  if (r.status === "queued") return "queued";
  return r.error?.code === "send_unverified" ? "unverified" : "failed";
}

/**
 * A send's result: the outcome, plus — for `queued` alone — the Idempotency-Key the queued
 * mutation stands under, so the composer can follow ITS OWN send through later flushes
 * ({@link flushQueued}'s ledger) and settle when the background retry lands or dies.
 */
export interface SendResult {
  outcome: SendOutcome;
  key?: string;
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
 * KEYS WHOSE SEND WAS RESUMED OVER DIFFERENT WORDS — half of the two facts the sentence needs.
 * A second press supersedes the queued mutation, so by the time anything settles the earlier
 * text is nowhere left to read; only the moment of the resume sees both versions. The other half
 * is the server's `firstSend`: without it this press's own words are what went, and this mark
 * alone would name the wrong message. Keyed by ENGINE so a session swap takes its marks with
 * it rather than answering for the next account's keys.
 */
const resumedOverOtherText = new WeakMap<OhmailEngine, Set<string>>();

/** Mark this key as resumed over other words. */
export function noteResumedOverOtherText(engine: OhmailEngine, key: string): void {
  const marks = resumedOverOtherText.get(engine) ?? new Set<string>();
  marks.add(key);
  resumedOverOtherText.set(engine, marks);
}

/** Read the mark. */
export function wasResumedOverOtherText(engine: OhmailEngine, key: string): boolean {
  return resumedOverOtherText.get(engine)?.has(key) === true;
}

/** Spend the mark — only where the send settled and its sentence has been said. */
export function forgetResumedOverOtherText(engine: OhmailEngine, key: string): void {
  resumedOverOtherText.get(engine)?.delete(key);
}

/**
 * WAS THIS CONFIRMATION ABOUT AN EARLIER MESSAGE? Both facts, asked together, which is the only
 * way either is worth anything: the server says this key was already settled (so this press
 * delivered nothing), and this device says the press carried different words (so what went is
 * not what is on screen). One without the other is an ordinary send — a plain retry of the same
 * words, or a resume the server had never heard of — and says the ordinary sentence.
 */
export function earlierVersionWent(engine: OhmailEngine, r: MutationResult | null): boolean {
  if (r === null || r.status !== "confirmed" || r.firstSend === undefined) return false;
  return wasResumedOverOtherText(engine, r.key);
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
export async function flushQueued(engine: OhmailEngine): Promise<Map<string, FlushedOutcome>> {
  const kinds = new Map(
    engine.pendingMutations().map((p) => [
      p.key,
      {
        kind: p.mutation.kind,
        forward: p.mutation.kind === "mail_send" && !!p.mutation.forwardOf,
        sendAt: (p.mutation.kind === "mail_send" ? p.mutation.sendAt : undefined) ?? null,
      },
    ]),
  );
  const outcomes = new Map<string, FlushedOutcome>();
  const results = await engine.flushPending().catch(() => []);
  for (const r of results) {
    if (r.status === "queued") continue;
    /**
     * A WITHDRAWN INTENT OWES NO SENTENCE. Cancel took this verb off the queue, and the flush
     * that was already carrying it reports the rollback it made of it — "Reply failed." over a
     * send the person themselves cancelled is the wrong sentence, and there is no right one.
     */
    if (r.error?.code === OUTBOX_WITHDRAWN_CODE) continue;
    const meta = kinds.get(r.key) ?? { kind: "mark_seen" as const, forward: false, sendAt: null };
    const status =
      r.status === "confirmed" ? ("confirmed" as const)
        : r.error?.code === "send_unverified" ? ("unverified" as const)
          : ("rolled_back" as const);
    const earlierWent = earlierVersionWent(engine, r);
    // Terminal: the sentence is about to be said, so the mark is spent here rather than kept
    // for a second announcement of the same send.
    forgetResumedOverOtherText(engine, r.key);
    outcomes.set(r.key, {
      status, kind: meta.kind, forward: meta.forward, sendAt: meta.sendAt, earlierWent,
    });
  }
  return outcomes;
}

/**
 * How long an undo offer stands — the webapp's `UNDO_MS` (`screener-state.ts`), mirrored by
 * value: this app cannot import the webapp, and two windows for one gesture is how "Undo" comes
 * to mean two different promises on two surfaces.
 */
export const UNDO_MS = 8000;

/**
 * What rides beside a toast sentence: an undo the pill offers (bounded, consumed at most once —
 * the callback itself enforces both), and how long the pill holds. Absent members mean what
 * every toast meant before: a sentence, 3.2 s, no verb.
 */
export interface ToastOpts {
  undo?: () => void;
  holdMs?: number;
}

export interface LiveDeps {
  engine: OhmailEngine;
  /** One plain sentence to the reader — the screens' toast. */
  /**
   * A REFUSAL, not a sentence. A toast held in the queue used to be words chosen when it was
   * raised, so one already on screen kept the language it was raised in while everything around
   * it followed a switch. The screen writes it out with `sayArg`.
   */
  toast: (say: RefusalArg, opts?: ToastOpts) => void;
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
   * A DECIDE THE SERVER CONFIRMED, HANDED BACK TO WHOEVER HOLDS THE CACHED QUEUE — the paired
   * door's waiting shelf is that cache, and without this it kept the decided sender until the
   * next drain (see {@link waitingAfterDecide}, which is the rule; this only carries the event).
   * Absent ⇒ nothing is reconciled, which is the standalone door's correct behaviour: there the
   * shelf is derived from the mirror and the mutation's own optimistic relocation already
   * retires the sender.
   */
  forgetWaiting?: (decided: { address: string; scope: Scope }) => void;
}

/**
 * The engine's abandoned-verb shape, re-exported so the phone's surfaces do not import the
 * engine package to name it. `privacy.test.ts#ENGINE_IMPORTERS` is a deliberately short
 * allow-list of files permitted to reach `@ohmail/client-engine` — the phone's licence to talk
 * to a server should be auditable by reading two directories. The chrome needs this type and
 * nothing else; this file is already the phone's one door to the engine's vocabulary
 * (`WorldActions`, `WorldMail`, `WorldPile` leave through here), so the type leaves the same way.
 */
export type { AbandonedMutation, MutationResult } from "@ohmail/client-engine";

export interface LiveWorldActions {
  /** Opening a message marks it read and asks for its full text + conversation + files. */
  openMessage(id: string): Promise<boolean>;
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
   * PUT A GIVEN-UP CHANGE BACK IN THE QUEUE — under its ORIGINAL Idempotency-Key, so an attempt
   * that committed and only lost its answer replays that answer instead of sending a second copy.
   * Parity with the browser's "Try again"; the engine owns the rule, this is the phone's door to it.
   */
  retryAbandoned(id: string): Promise<MutationResult>;
  /** Throw a given-up change away for good. The optimistic row reverted when it was abandoned. */
  discardAbandoned(id: string): Promise<void>;
  /** The sender screen's open: fetch every held body so the decision is over real mail. */
  hydrateHeld(ids: string[]): void;
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
  pileToggle(messageId: string, kind: "replyLater" | "setAside"): Promise<boolean>;
  /** The horizon-less Resurface — tomorrow 09:00, or CLEARS a booking that already stands. */
  resurfaceToggle(messageId: string): Promise<boolean>;
  /** Resurface AT a chosen instant (the chooser's Tomorrow / Next week / a picked day). */
  resurfaceAt(messageId: string, iso: string): Promise<boolean>;
  /** Resurface NOW — the `resurfaced` state, not a date; pinned by the time the request returns. */
  resurfaceNow(messageId: string): Promise<boolean>;
  /** DONE with a resurface: clear a standing booking, then the deliberate read that spends the pin. */
  resurfaceDone(messageId: string): Promise<boolean>;
  /** Mark read / Mark unread — the DELIBERATE `mark_seen` (no `via`), so a read spends a pin. */
  markSeen(messageId: string, unread: boolean): Promise<boolean>;
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
  move(row: WorldMail, dest: MoveTarget): Promise<boolean>;
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
  ): Promise<SendResult>;
  /**
   * Forward — `mail_send` with `forwardOf`, recipients the USER typed, the user's note as
   * body. The signature seals into the NOTE; the server appends the quoted original after
   * the body it is handed, so the block sits above the quoted history (`signature.ts`).
   * `attachments` on either verb ride the same mutation the webapp composer sends —
   * base64 on `POST /drafts/:id/send`, nothing stored (`ComposeAttachment`'s own contract).
   */
  sendForward(messageId: string, to: EmailAddress[], body: string, sig?: string | null, attachments?: ComposeAttachment[]): Promise<SendResult>;
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
  /** Put a tag on / take it off — `tag_assign`. */
  tagToggle(messageId: string, tag: WorldTag, assigned: boolean): Promise<boolean>;
  /** Tag-or-create: a name that does not exist yet, minted and put on this message in one act. */
  tagCreate(messageId: string, name: string): Promise<boolean>;
  /**
   * SCREENING from the open message: where THIS SENDER's mail goes — the webapp sender sheet's
   * rule ladder (`sender-screening.ts#planScreeningChange`), in the phone's idiom.
   */
  screenSender(messageId: string, dest: Destination, scope: Scope, applyRetro?: boolean): Promise<boolean>;

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
  const now = deps.now ?? (() => new Date());
  /** Read at every use, never captured — see {@link LiveDeps.resurfaceTime}. */
  const resurfaceAtClock = (): string | null => deps.resurfaceTime?.() ?? null;
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
   * WHAT A PRESS IS TOLD — the one place a verdict becomes a sentence on this surface.
   *
   * `done` is the caller's own completion sentence, or `null` where it already raised an
   * optimistic one. A press the SERVER recorded for the organizing install gets the queued
   * sentence instead and answers `false`: nothing happened, so no caller may treat it as having.
   * A press on this client's own retry queue answers `true` — the intent stands under its key.
   */
  const said = (v: PressVerdict, done: RefusalArg | null, failed: RefusalArg, opts?: ToastOpts): boolean => {
    if (v.kind === "refused") { toast(failed); return false; }
    if (v.kind === "queued" && v.wait === "organizer") {
      toast(v.holder ? refuse("pressQueuedForOrganizer", v.holder) : refuse("pressQueuedForOrganizerUnknown"));
      return false;
    }
    if (done !== null) toast(done, opts);
    return true;
  };

  /** The same, over a SET: one sentence for the run, and a queued press is never counted landed. */
  const saidAll = (vs: readonly PressVerdict[], done: RefusalArg | null, failed: RefusalArg): boolean => {
    const t = tallyVerdicts(vs);
    if (t.refused > 0) { toast(failed); return false; }
    if (t.queued > 0 && vs.some((v) => v.kind === "queued" && v.wait === "organizer")) {
      const holder = t.holder;
      toast(holder ? refuse("pressQueuedForOrganizer", holder) : refuse("pressQueuedForOrganizerUnknown"));
      return false;
    }
    if (done !== null) toast(done);
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
    const rec = engine.read().get<{ state?: string }>("message_body", id);
    void engine
      .hydrateBody(id, rec?.state === "failed" ? { retry: true } : {})
      .catch(() => undefined);
  };

  const hydrateMessage = (id: string): void => hydrateSmart(id);

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
    if (!m) return false;
    // The full text, the conversation's members, and the file list — all render-side asks;
    // failures degrade to the snippet with its honest bodyState, never to an error screen.
    hydrateSmart(id);
    const members = threadOf(engine.read(), id);
    if (members.length > 0) void engine.hydrateThread(members.map((t) => t.id)).catch(() => undefined);
    if (m.hasAttachments) void engine.loadAttachments(id).catch(() => undefined);
    if (!m.unread) return true;
    // A RESURFACED PIN IS NOT SPENT BY OPENING — but the READ LANDS (owner ruling 2026-08-26:
    // reading a resurfaced message sticks like anywhere else). This used to skip pinned rows
    // entirely because the engine pruned their ids from a glance and a one-id glance pruned to
    // nothing was `mutate`'s not-found rollback; that pruning is gone — the glance travels
    // labelled and the SERVER keeps the pin while marking read. The deliberate reads — the
    // sheet's Done, Mark as read — remain the acts that spend the pin.
    // `via: "glance"` — the involuntary read, so the server's pin semantics see it as such.
    return said(
      await watched(engine.mutate({ kind: "mark_seen", messageIds: [id], unread: false, via: "glance" })),
      null, refuse("liveSaveFailed"),
    );
  };

  const releaseAttachments = (messageId: string): void => {
    engine.releaseAttachments(messageId);
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
    await engine.openAttachment(messageId, attachmentId, { retry: true }).catch(() => undefined);
    // A variable, not a literal — correct against either option spelling (see `liveMessage`).
    const EVERY_PART = { includeInlineImages: true, includeInlineParts: true };
    const list = engine.attachmentsOf(messageId, EVERY_PART);
    const item = list.state === "ready" ? list.items.find((i) => i.id === attachmentId) : undefined;
    if (!item) {
      logAttachmentRefusal("bytes_unavailable");
      return { state: "unavailable" };
    }
    // `too_large` is an ANSWER, not a refusal: the sentence names the ceiling and no retry helps.
    if (item.state === "too_large") return { state: "too_large" };
    const blob = engine.attachmentBlobOf(messageId, attachmentId);
    if (item.state !== "ready" || !blob) {
      logAttachmentRefusal("bytes_failed");
      return { state: "failed" };
    }
    try {
      return { state: "ready", base64: await blobToBase64(blob), mime: item.mimeType, filename: item.filename };
    } catch {
      // The one non-engine failure: the byte read itself. Same sentence as a failed fetch —
      // the tile's retry re-asks `openAttachment`, which short-circuits on the held Blob.
      logAttachmentRefusal("bytes_unreadable");
      return { state: "failed" };
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

  const decide = async (row: ScreenerRow, dest: Destination, read: boolean, scope: Scope): Promise<boolean> => {
    const raw = engine.read();
    const rep = raw.get<EngineMessage>("message", row.id);
    if (!rep) {
      // The representative left the mirror between the render and the press (a drain, an
      // eviction). The one silent branch the webapp's commit named — never dispatch nothing.
      toast(refuse("liveDecideFailed", row.address));
      return false;
    }
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
    if (physicalFolderOf(rep) === FOLDER_OF_VIEW.screener) {
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
      // PAST THE GATE (mirrored from the webapp's shape): this sender's mail is only
      // PRESENTED at the gate — a decide would 404 on both ends. A rule with `applyRetro`
      // re-presents the whole bag the moment it lands, and the server's retro pass makes the
      // filing physical; no move is composed here because nothing is physically at the gate.
      const match = scope === "domain" ? domainOf(row.address).toLowerCase() : row.address.trim().toLowerCase();
      landed = watched(
        engine.mutate({
          kind: "rule_create",
          ruleKind: scope,
          match,
          destination: FOLDER_OF_VIEW[dest as ScreenDest],
          applyRetro: true,
        }),
      );
    }
    // "&read" stays a separate batch, exactly as the wire has it: `POST /screener/:id`
    // carries no read field, so the seen half is the same `PATCH /messages` everyone uses.
    // Deliberately unwatched (the webapp's one deliberate `void mutate`): the DECISION has
    // landed; only the seen flag on now-filed mail can be lost, which is visible where it
    // happened and undone by reading.
    if (decision === "yes" && readFlag && row.held.length > 0) {
      const ids = row.held.map((h) => h.id);
      for (let i = 0; i < ids.length; i += MARK_SEEN_MAX) {
        void engine.mutate({ kind: "mark_seen", messageIds: ids.slice(i, i + MARK_SEEN_MAX), unread: false });
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
    /* THE DECIDE'S OWN QUEUED SENTENCE COMES FIRST, because it is the more specific one: a
       CONFIRMED decide against a mailbox somebody else organizes carries the holder on
       `pendingWith`, and that names the install as well as the wait. Everything else goes
       through the one speaker, which covers the rule_create arm this branch shares. */
    const queued = queuedWith as { name: string | null } | null;
    if (v.kind === "applied" && queued !== null) {
      toast(queued.name ? refuse("liveDecidedElsewhere", queued.name, target) : refuse("liveDecidedElsewhereUnknown", target));
      return true;
    }
    return said(v, refuse("liveDecided", destDone(dest), target), refuse("liveDecideFailed", row.address));
  };

  const release = async (row: ScreenerRow, dest: Place, segment: "screened" | "spam"): Promise<boolean> => {
    // The RAW mirror on both reads: rules and physical folders are locations, and the
    // projected reader answers presentations (`presentationReader`'s own contract).
    const raw = engine.read();
    const segFolder = segment === "spam" ? FOLDER_OF_VIEW.spam : FOLDER_OF_VIEW.screened;
    const wanted = FOLDER_OF_VIEW[dest];
    const retargets: EngineMutation[] = holdingRules(raw, row.address, segFolder).map((r) => ({
      kind: "rule_update",
      ruleId: r.id,
      destination: wanted,
    }));
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
    const parts = [
      ...retargets.map((m) => watched(engine.mutate(m))),
      ...moveIds.map((id) => watched(engine.mutate({ kind: "move", messageId: id, folder: wanted }))),
    ];
    // Two sentences, one true at a time: the retarget IS a statement about future mail.
    toast(
      retargets.length > 0 ? refuse("liveReleasedRuled", row.held.length, destDone(dest)) : refuse("liveReleased", row.held.length, destDone(dest)),
    );
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
    const opts = undoable(inverseMutations(engine.read(), m));
    const ok = await watched(engine.mutate(m));
    return said(ok, refuse("livePileAdded", pileTitle(kind)), refuse("livePileFailed", pileTitle(kind)), opts);
  };

  /* ── the open message's verbs ──────────────────────────────────────────────────────────── */

  const zone = deps.zone ?? readerZone();
  const messageOf = (id: string): EngineMessage | undefined =>
    engine.read().get<EngineMessage>("message", id);

  /**
   * ONE UNDO FOR EVERY VERB (the 0.20 review, the phone half) — the pill carries Undo wherever the
   * engine can build the wire's own reversal (`inverseMutations`, read BEFORE the dispatch).
   * Undo dispatches the inverses through the ordinary seam, so the overlay, the outbox and the
   * refusal vocabulary all apply — never a local state hack. Bounded by {@link UNDO_MS} and
   * consumed at most once: a late press takes nothing back and claims nothing (the Screener's
   * own rule). `[]` — no wire inverse, or a press that changes nothing — offers no verb.
   */
  const undoable = (inv: readonly EngineMutation[]): ToastOpts | undefined => {
    if (inv.length === 0) return undefined;
    const at = now().getTime();
    let fired = false;
    return {
      holdMs: UNDO_MS,
      undo: () => {
        if (fired || now().getTime() - at > UNDO_MS) return;
        fired = true;
        void Promise.all(inv.map((mu) => watched(engine.mutate(mu)))).then((vs) => {
          saidAll(vs, refuse("toastUndone"), refuse("liveSaveFailed"));
        });
      },
    };
  };

  /**
   * One triage write, stated in the webapp's own sentence. The toast is spoken on the
   * OPTIMISTIC apply (the webapp's shape — the sentence is the act), and a rollback overrides
   * it with the one failure sentence. The pill carries the way back: the inverse is read off
   * the PRE-PRESS mirror, the state this press is about to leave.
   */
  const triage = async (
    messageId: string,
    state: "none" | "reply_later" | "set_aside" | "bubbled_up" | "resurfaced",
    say: RefusalArg,
    bubbleUpAt?: string,
  ): Promise<boolean> => {
    const m: EngineMutation = { kind: "triage_set", messageId, state, ...(bubbleUpAt ? { bubbleUpAt } : {}) };
    toast(say, undoable(inverseMutations(engine.read(), m)));
    return said(await watched(engine.mutate(m)), null, refuse("liveSaveFailed"));
  };

  const pileToggle = async (messageId: string, kind: "replyLater" | "setAside"): Promise<boolean> => {
    const m = messageOf(messageId);
    if (!m) return false;
    const held = triageStateOf(engine.read(), m);
    if (kind === "replyLater") {
      return held === "reply_later"
        ? triage(messageId, "none", refuse("toastUnqueued"))
        : triage(messageId, "reply_later", refuse("toastQueued"));
    }
    return held === "set_aside"
      ? triage(messageId, "none", refuse("toastUnparked"))
      : triage(messageId, "set_aside", refuse("toastAside"));
  };

  const resurfaceAt = (messageId: string, iso: string): Promise<boolean> =>
    triage(messageId, "bubbled_up", refuse("toastResurface", whenLabel(iso, zone)), iso);

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

  const markSeen = async (messageId: string, unread: boolean): Promise<boolean> => {
    // No `via`: this is the deliberate read, the one that spends a resurface pin on both sides
    // of the wire — the opposite of the open's glance and the streams' sweep. The sentence is
    // new with the undo (the 0.20 review): the flip is visible, but the pill is where the way back
    // lives, and a verb whose undo has no surface is a verb with no undo.
    const m: EngineMutation = { kind: "mark_seen", messageIds: [messageId], unread };
    const inv = inverseMutations(engine.read(), m);
    return said(
      await watched(engine.mutate(m)),
      refuse(unread ? "toastUnread" : "toastRead"), refuse("liveSaveFailed"),
      undoable(inv),
    );
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
    const inv = chunkMarkSeen(inverseMutations(engine.read(), { kind: "mark_seen", messageIds: ids, unread: false }));
    const parts: Promise<PressVerdict>[] = [];
    for (let i = 0; i < ids.length; i += MARK_SEEN_MAX) {
      parts.push(watched(engine.mutate({ kind: "mark_seen", messageIds: ids.slice(i, i + MARK_SEEN_MAX), unread: false })));
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

  const resurfaceDone = async (messageId: string): Promise<boolean> => {
    const m = messageOf(messageId);
    if (!m) return false;
    // A SCHEDULED message's release has an extra half: the booking is cleared first (the same
    // un-triage the toggles use), then the same deliberate read files it under Earlier.
    /* Both halves' inverses, off the pre-press mirror — the webapp release's own composition:
       the deliberate read's (re-pin a spent pin, unread back) and the booking clear's (re-book
       at its own date). A row is pinned OR booked, never both, so the reads cannot overlap. */
    const pre = engine.read();
    const booked = triageStateOf(pre, m) === "bubbled_up";
    const inv = [
      ...inverseMutations(pre, { kind: "mark_seen", messageIds: [messageId], unread: false }),
      ...(booked ? inverseMutations(pre, { kind: "triage_set", messageId, state: "none" }) : []),
    ];
    const parts: Promise<PressVerdict>[] = [];
    if (booked) {
      parts.push(watched(engine.mutate({ kind: "triage_set", messageId, state: "none" })));
    }
    parts.push(watched(engine.mutate({ kind: "mark_seen", messageIds: [messageId], unread: false })));
    toast(refuse("toastResurfaceDone"), undoable(inv));
    return saidAll(await Promise.all(parts), null, refuse("liveSaveFailed"));
  };

  /**
   * ALREADY ASKED FOR? The sentence for a message whose press is still waiting on the install
   * that organizes the mailbox, or `null` when nothing of ours is waiting on it. Pressing again
   * is answered rather than dispatched: a second request would change nothing and the first is
   * still the truth. Past the engine's stated bound the wait gets its own words — the request is
   * no less pending for being slow, which is why the sentence changes and nothing else does.
   */
  const stillWaitingFor = (messageId: string): Refusal | null => {
    const waiting = engine.organizerRequests().find((r) => r.messageId === messageId);
    if (!waiting) return null;
    const holder = waiting.queuedWith.name;
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
  const move = async (row: WorldMail, dest: MoveTarget): Promise<boolean> => {
    const messageId = row.id;
    // The RAW mirror for the LOCATION, exactly as `release` reads it: a move is about where the
    // mail actually is. The PRESENTED place is the caller's, because only the projection knows
    // it — `messageOf` here is the raw mirror too, so reading it for both made the two values
    // one and the retarget landed on the filed folder (measured at the K32 landing).
    const raw = engine.read();
    const m = raw.get<EngineMessage>("message", messageId);
    const folder = FOLDER_OF_VIEW[dest];
    if (!m || !folder) {
      toast(refuse("liveSaveFailed"));
      return false;
    }
    /* The plan as DATA first: nothing reaches `engine.mutate` until the list is known non-empty
       and no request of ours is still waiting on the organizer for this message. The move goes
       LAST so that, reading back, it is the first queued answer found and names its own holder. */
    const writes: EngineMutation[] = row.presentedFolder === folder
      ? []
      : holdingRules(raw, m.from.address, row.presentedFolder).map((r) => ({
        kind: "rule_update",
        ruleId: r.id,
        destination: folder,
      }));
    if (m.folder !== folder) writes.push({ kind: "move", messageId, folder });
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
    const rules = writes.filter((w) => w.kind === "rule_update");
    const mail = writes.filter((w) => w.kind !== "rule_update");
    const inv = mail.flatMap((w) => inverseMutations(raw, w));
    /* RAW answers, never `watched`: it folds `awaiting_organizer` into landed-or-not, and on a
       mailbox this phone only reads EVERY write here comes back that way (`move` is named in the
       202 census). Folding them would say "Moved" over a move nobody made. */
    const answers = await Promise.all(
      mail.map((w) => engine.mutate(w).catch((): MutationResult | null => null)),
    );
    if (answers.some((r) => r === null || r.status === "rolled_back")) {
      toast(refuse("liveSaveFailed"));
      return false;
    }
    const queued = [...answers].reverse().find((r) => r?.status === "awaiting_organizer");
    if (queued) {
      const holder = queued.queuedWith?.name ?? null;
      /* Two calls rather than one with a spread: each sentence is passed exactly its own
         arguments, which is what `refusal.test.ts` reads out of this file's source. */
      toast(holder
        ? refuse("toastMoveQueued", moveTargetLabel(dest), holder)
        : refuse("toastMoveQueuedUnknown", moveTargetLabel(dest)));
      return true;
    }
    if (rules.length === 0) {
      toast(refuse("toastMoved", moveTargetLabel(dest)), undoable(inv));
      return true;
    }
    const opened = holdRouting({
      v: 1,
      id: deps.uuid ? deps.uuid() : `${messageId}:${now().getTime()}`,
      seedId: messageId,
      address: m.from.address,
      scope: "sender",
      dest: dest as ScreenDest,
      messageIds: [messageId],
      from: row.presentedFolder,
      at: now().getTime(),
    });
    if (!opened.held) {
      /* NO SESSION TO HOLD IT — the rules go now, and the sentence does not offer an undo it
         cannot honour. `held-delete.ts`'s own degradation. */
      await Promise.all(rules.map((w) => engine.mutate(w).catch(() => null)));
      toast(refuse("toastMoved", moveTargetLabel(dest)));
      return true;
    }
    const subject = routingSubject({ scope: "sender", address: m.from.address });
    toast(refuse("toastMoved", moveTargetLabel(dest)), {
      holdMs: UNDO_MS,
      undo: () => {
        /* BOTH HALVES, ONE PRESS: the rule is cancelled before it is sent and the mail is put
           back through the engine's own inverse. `undoRouting` answers whether it TOOK, so a
           late press cannot say no rule was made over a rule that was. */
        const cancelled = undoRouting(subject);
        void Promise.all(inv.map((mu) => watched(engine.mutate(mu)))).then((vs) => {
          saidAll(vs, refuse(cancelled ? "toastRoutingUndone" : "toastUndone"), refuse("liveSaveFailed"));
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
    const res = await engine.mutate({ kind: "message_delete", messageId }).catch(() => null);
    if (res?.status === "awaiting_organizer") {
      const holder = res.queuedWith?.name ?? null;
      toast(holder ? refuse("toastDeleteQueued", holder) : refuse("toastDeleteQueuedUnknown"));
      return true;
    }
    if (!res || res.status === "rolled_back") { toast(refuse("deleteFailed")); return false; }
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
  ): Promise<SendResult> => {
    const first = await p.then((r) => r, () => null);
    let settled: MutationResult | null = first;
    if (first && first.status === "queued") {
      // The flush replays the WHOLE queue; only THIS send's own result — matched by the
      // Idempotency-Key the first dispatch minted — may settle this send. An unrelated
      // mutation confirming is not this message delivering.
      const flushed = await engine.flushPending().catch(() => []);
      settled = flushed.find((r) => r.key === first.key) ?? first;
    }
    const outcome = sendOutcomeOfResult(settled);
    /**
     * WHICH MESSAGE THIS CONFIRMATION IS ABOUT. A press that resumed a standing key is answered
     * from the first reservation when there is one — never two copies, never a silent second
     * delivery, but the words that left are the earlier ones, and the ordinary sentence would
     * name a message nobody sent. The mark is spent only when this press SETTLED; a still-queued
     * send leaves it for the reconnect flush, which is the surface that will announce it.
     */
    const earlierWent = outcome !== "queued" && earlierVersionWent(engine, settled);
    if (outcome !== "queued" && first !== null) forgetResumedOverOtherText(engine, first.key);
    toast(
      outcome === "sent" ? (earlierWent ? earlierWentToast : sentToast)
        : outcome === "queued" ? refuse("replyQueued")
          : outcome === "unverified" ? refuse("replyUnverified")
            : refuse("replyFailed"),
    );
    return { outcome, ...(outcome === "queued" && first ? { key: first.key } : {}) };
  };

  /**
   * ONE INTENT, ONE KEY, FOR AS LONG AS IT IS RETRYABLE. A send still standing on the queue for
   * this intent — a tunnel, or a killed app whose durable row this session restored — already
   * carries the key it was expressed under, so a second press RESUMES it instead of minting a
   * fresh one: same key, same request, and the server's own same-key branch decides whether that
   * mail has gone. A fresh key there is a second copy in somebody's inbox, which is the whole
   * defect. Nothing standing ⇒ `mutate` mints, and persists it with the outbox row.
   */
  const dispatchSend = (m: EngineMutation): Promise<MutationResult> => {
    const intent = sendIntentOf(m);
    const standing = intent === null
      ? undefined
      : engine.pendingMutations().find((p) => sendIntentOf(p.mutation) === intent);
    // WHAT THE RESUME MAY COST, WRITTEN DOWN WHILE BOTH VERSIONS EXIST. The key that stops a
    // second copy also lets the server answer from the first reservation, and only this moment
    // can see that the words changed — see `resumedOverOtherText`. Whether it cost anything is
    // the server's half of the question, asked when the answer comes back.
    if (standing !== undefined && sendTextDiffers(standing.mutation, m)) {
      noteResumedOverOtherText(engine, standing.key);
    }
    return engine.mutate(m, standing === undefined ? {} : { key: standing.key });
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
      }, sig)),
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

  const sendForward = async (messageId: string, to: EmailAddress[], body: string, sig: string | null = null, attachments: ComposeAttachment[] = []): Promise<SendResult> => {
    const m = messageOf(messageId);
    // The `no_forward` refusal is client-side courtesy AND server-side law — the sheet never
    // offers the verb on such a message, and this arm refuses it too rather than trusting the
    // UI. Told, for the reply belt's reason: a return before `sent()` renders nothing.
    if (!m || to.length === 0 || m.sensitivity?.no_forward) {
      toast(refuse("replyFailed"));
      return { outcome: "failed" };
    }
    return sent(
      dispatchSend(withSignature({
        kind: "mail_send" as const,
        inReplyTo: null,
        forwardOf: messageId,
        subject: forwardSubject(m.subject),
        // The mailbox the original arrived in — the same sender a reply gets from `enrich`.
        // A forward has no parent-derived From of its own, and the send refuses without one.
        mailboxId: m.mailboxId,
        body,
        to,
        ...(attachments.length > 0 ? { attachments } : {}),
      }, sig)),
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
        ...(sendAt ? { sendAt } : {}),
        ...(attachments.length > 0 ? { attachments } : {}),
      }, sig)),
      sendAt ? Copy.scheduledFor(scheduleLabel(sendAt, now(), zone)) : Copy.composeSent,
      Copy.composeEarlierWent,
    );
  };

  const tagToggle = async (messageId: string, tag: WorldTag, assigned: boolean): Promise<boolean> => {
    const m: EngineMutation = { kind: "tag_assign", messageId, tagId: tag.id, assigned };
    toast(
      assigned ? refuse("tagTagged", tag.name) : refuse("tagUntagged", tag.name),
      undoable(inverseMutations(engine.read(), m)),
    );
    return said(await watched(engine.mutate(m)), null, refuse("liveSaveFailed"));
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
    toast(refuse("tagTagged", typed), undoable(inverseMutations(engine.read(), m)));
    return said(await watched(engine.mutate(m)), null, refuse("liveSaveFailed"));
  };

  /**
   * Screening from the open message — the rule ladder, mirrored from
   * `apps/webapp/app/shell/sender-screening.ts#planScreeningChange`: (1) a subject still waiting
   * at the gate is decided with `screener_decide`, which carries the past-mail answer; (2) a
   * term-free rule of the same kind already at the destination writes no new rule and is re-armed
   * for the backlog when that answer is yes; (3) rules pointing elsewhere — every one — are
   * retargeted; (4) otherwise one is written. The moves are the optimistic half, capped at 50,
   * gated on `applyRetro` and narrowed by `retroPassWouldMove` — see {@link movePastMail}; the
   * rule is awaited and reported, the moves roll their own rows back. Raw mirror reads.
   */
  const screenSender = async (
    messageId: string, dest: Destination, scope: Scope, applyRetro = true,
  ): Promise<boolean> => {
    const raw = engine.read();
    const m = raw.get<EngineMessage>("message", messageId);
    if (!m) return false;
    const address = m.from.address.trim().toLowerCase();
    const domain = domainOf(address).toLowerCase();
    if (scope === "domain" && (domain === "" || !address.includes("@"))) return false;
    const match = scope === "domain" ? domain : address;
    const wanted = FOLDER_OF_VIEW[dest as ScreenDest];
    const target = scope === "domain" ? `@${domain}` : m.from.address;
    const ofSubject = (x: EngineMessage): boolean =>
      scope === "domain"
        ? domainOf(x.from.address.trim().toLowerCase()).toLowerCase() === match
        : x.from.address.trim().toLowerCase() === match;
    const subject = raw.list<EngineMessage>("message").filter(ofSubject);

    /**
     * THE PAST-MAIL HALF, AND THE SWITCH IS ITS GATE. "Also move the mail already in your
     * mailbox" off used to change only the sentence while BOTH branches below still dispatched
     * up to 50 moves — a person's own filing undone by a control that said not to. The answer is
     * read HERE, in the one place both branches move through, so the gate cannot be half-applied.
     * Off: the rule is written and nothing already here is touched. On: the bound stays (the
     * server's resumable pass owns the rest) and the moves are unawaited, each rolling its own
     * row back. WHICH mail is `retroPassWouldMove`'s at both call sites: these are the head of
     * the server's own set, newest first, never a set of this file's own.
     */
    const movePastMail = (already: (x: EngineMessage) => boolean): void => {
      if (!applyRetro) return;
      subject
        .filter(already)
        // NEWEST FIRST, because the fifty are the mail the person is looking at — the webapp's
        // `sender-screening.ts` sorts for the same reason. Sliced out of the mirror's list order
        // the fifty were arbitrary, so the messages that moved were not the ones on screen.
        .sort(newestFirst)
        .slice(0, 50)
        .forEach((x) => void engine.mutate({ kind: "move", messageId: x.id, folder: wanted }));
    };

    const waiting = subject
      .filter((x) => physicalFolderOf(x) === FOLDER_OF_VIEW.screener)
      .sort(newestFirst)[0];
    const decision: "yes" | "no" = dest === "screened" || dest === "spam" ? "no" : "yes";

    let ruled: Promise<PressVerdict[]>;
    if (waiting) {
      ruled = watched(
        engine.mutate({
          kind: "screener_decide", senderId: waiting.id, decision, dest: dest as ScreenDest, scope,
          // The past-mail answer rides the decision, because the rule it promotes is the only rule
          // this press writes — the webapp's ruling, on the same wire.
          applyRetro,
        }),
      ).then((v) => [v]);
      // The decide relocates the HELD rows and promotes the rule — it does not touch the
      // subject's mail that already left the gate. Those rows are the past-mail half (the
      // webapp's `planScreeningChange` shape: moves cover what the decide does not), so they
      // move only when the person asked for it.
      movePastMail((x) => physicalFolderOf(x) !== FOLDER_OF_VIEW.screener && retroPassWouldMove(x, wanted));
    } else {
      const standing = rulesList(raw).filter(
        (r) =>
          r.enabled &&
          r.kind === scope &&
          (r.subjectContains ?? "").trim() === "" &&
          (r.bodyContains ?? "").trim() === "" &&
          r.match.trim().toLowerCase() === match,
      );
      const retargets: EngineMutation[] = standing
        .filter((r) => r.destination !== wanted)
        .map((r) => ({ kind: "rule_update", ruleId: r.id, destination: wanted, applyRetro }));
      /* A standing rule ALREADY at the destination writes nothing about the future — and, with the
         past-mail option on, re-arms that rule for the backlog: an explicit `applyRetro: true` on a
         PATCH whose destination did not move is the server's re-arm. Off, it writes nothing at all
         and a habit-click stays free. The webapp's `planScreeningChange` ladder, verbatim. */
      const rearms: EngineMutation[] = applyRetro
        ? standing
            .filter((r) => r.destination === wanted)
            .map((r) => ({ kind: "rule_update", ruleId: r.id, destination: wanted, applyRetro: true }))
        : [];
      const writes: EngineMutation[] =
        standing.length === 0
          ? [{ kind: "rule_create", ruleKind: scope, match, destination: wanted, applyRetro }]
          : [...retargets, ...rearms];
      ruled = Promise.all(writes.map((w) => watched(engine.mutate(w))));
      // The optimistic half: what the reader can see moves now; the server's pass does the rest.
      movePastMail((x) => retroPassWouldMove(x, wanted));
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
    return saidAll(verdicts, refuse("liveDecided", destDone(dest), target), refuse("liveDecideFailed", m.from.address));
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
      return engine.retryAbandoned(id);
    },
    async discardAbandoned(id) {
      await engine.discardAbandoned(id);
    },
    openMessage, hydrateMessage, hydrateHeld, loadInlineImages, openAttachmentBytes,
    releaseAttachments,
    sweepFeed, leaveFeed, decide, release, setPile,
    pileToggle, resurfaceToggle, resurfaceAt, resurfaceNow, resurfaceDone, markSeen, markAllSeen, move,
    deleteMessage, trashList, trashRestore,
    sendReply, sendForward, sendNew, withdrawSend, cancelSchedule, tagToggle, tagCreate, screenSender,
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
  /** The renderer's ask for the embedded images the open document references. */
  loadInlineImages(messageId: string, contentIds: string[]): void;
  /** One attachment's bytes for the share sheet — awaited; the tile renders each refusal. */
  openAttachmentBytes(messageId: string, attachmentId: string): Promise<WorldAttachmentBytes>;
  /** The reader's cleanup — see {@link LiveWorldActions.releaseAttachments}. */
  releaseAttachments(messageId: string): void;
  /** An explicit re-ask for one message's full text (a card expand, a reopen). */
  hydrateMessage(id: string): void;
  /**
   * The two verbs on a change the engine gave up on — see {@link LiveWorldActions.retryAbandoned}.
   * Awaited by the caller (the chrome disables the row while one is in flight), so unlike most of
   * this facade they return their promise rather than firing and forgetting.
   */
  retryAbandoned(id: string): Promise<MutationResult>;
  discardAbandoned(id: string): Promise<void>;
  /** The sender screen's open: fetch every held body. */
  hydrateHeld(ids: string[]): void;
  decide(row: ScreenerRow, dest: Destination, read: boolean): void;
  setScope(row: ScreenerRow, scope: Scope): void;
  /** Allow (screened) / Not spam (spam): release the whole held bag to a place. */
  allow(row: ScreenerRow, dest: Place): void;
  notSpam(row: ScreenerRow, dest: Place): void;
  addToPile(kind: PileKind, item: PileItem): void;
  /* The open message's verbs — see {@link LiveWorldActions} for each arm's contract. */
  pileToggle(messageId: string, kind: "replyLater" | "setAside"): void;
  resurfaceToggle(messageId: string): void;
  resurfaceAt(messageId: string, iso: string): void;
  resurfaceNow(messageId: string): void;
  resurfaceDone(messageId: string): void;
  markSeen(messageId: string, unread: boolean): void;
  /** Mark all read — see {@link LiveWorldActions.markAllSeen}. */
  markAllSeen(ids: string[], feed?: { place: "reads" | "receipts"; upToId: string }): void;
  /** The row, not an id — see {@link LiveWorldActions.move}. */
  move(row: WorldMail, dest: MoveTarget): void;
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
  ): Promise<SendResult>;
  sendForward(messageId: string, to: EmailAddress[], body: string, sig?: string | null, attachments?: ComposeAttachment[]): Promise<SendResult>;
  /** A mail with no parent — see {@link LiveWorldActions.sendNew}. */
  sendNew(
    mailboxId: string | null,
    to: EmailAddress[],
    subject: string,
    body: string,
    sig?: string | null,
    sendAt?: string | null,
    attachments?: ComposeAttachment[],
  ): Promise<SendResult>;
  /** Withdraw a queued send — Cancel. See {@link LiveWorldActions.withdrawSend}. */
  withdrawSend(key: string): Promise<WithdrawOutcome>;
  /** Cancel a scheduled send — resolves `true` only on the server's CONFIRMED cancellation. */
  cancelSchedule(draftId: string): Promise<boolean>;
  /** What became of a queued send's key — how a locked composer settles. See `World.sendOutcome`. */
  sendOutcome(key: string): "pending" | "confirmed" | "rolled_back" | "unverified" | "unknown";
  tagToggle(messageId: string, tag: WorldTag, assigned: boolean): void;
  tagCreate(messageId: string, name: string): void;
  screenSender(messageId: string, dest: Destination, scope: Scope, applyRetro?: boolean): void;
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
    loadInlineImages: (id, contentIds) => current().loadInlineImages(id, contentIds),
    releaseAttachments: (id) => current().releaseAttachments(id),
    openAttachmentBytes: (id, attachmentId) => current().openAttachmentBytes(id, attachmentId),
    hydrateMessage: (id) => current().hydrateMessage(id),
    retryAbandoned: (id) => current().retryAbandoned(id),
    discardAbandoned: (id) => current().discardAbandoned(id),
    hydrateHeld: (ids) => current().hydrateHeld(ids),
    decide: (row, dest, read) => current().decide(row, dest, read),
    setScope: (row, scope) => current().setScope(row, scope),
    allow: (row, dest) => current().allow(row, dest),
    notSpam: (row, dest) => current().notSpam(row, dest),
    addToPile: (kind, item) => current().addToPile(kind, item),
    pileToggle: (id, kind) => void current().pileToggle(id, kind),
    resurfaceToggle: (id) => void current().resurfaceToggle(id),
    resurfaceAt: (id, iso) => void current().resurfaceAt(id, iso),
    resurfaceNow: (id) => void current().resurfaceNow(id),
    resurfaceDone: (id) => void current().resurfaceDone(id),
    markSeen: (id, unread) => void current().markSeen(id, unread),
    markAllSeen: (ids, feed) => void current().markAllSeen(ids, feed),
    move: (row, dest) => void current().move(row, dest),
    deleteMessage: (id, opts) => void current().deleteMessage(id, opts),
    trashList: (cursor) => current().trashList(cursor),
    trashRestore: (id) => current().trashRestore(id),
    sendReply: (id, body, all, sig, sendAt, attachments) => current().sendReply(id, body, all, sig, sendAt, attachments),
    sendForward: (id, to, body, sig, attachments) => current().sendForward(id, to, body, sig, attachments),
    sendNew: (mailboxId, to, subject, body, sig, sendAt, attachments) => current().sendNew(mailboxId, to, subject, body, sig, sendAt, attachments),
    withdrawSend: (key) => current().withdrawSend(key),
    cancelSchedule: (draftId) => current().cancelSchedule(draftId),
    sendOutcome: (key) => current().sendOutcome(key),
    tagToggle: (id, tag, assigned) => void current().tagToggle(id, tag, assigned),
    tagCreate: (id, name) => void current().tagCreate(id, name),
    screenSender: (id, dest, scope, applyRetro) => void current().screenSender(id, dest, scope, applyRetro),
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
 * "Fri 18:00" inside the coming week, "12 Sep, 18:00" beyond it — the appointment, read where
 * the reader is. The webapp's `scheduleLabel`, mirrored: the week band matches {@link whenLabel}'s
 * so the phone's two future-time vocabularies agree, and past a week a bare weekday is
 * ambiguous (which Friday?) — an appointment is exactly the value that ambiguity misleads
 * about. Not-ISO input echoes through, as both references do.
 */
export function scheduleLabel(iso: string, now: Date, zone: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T/.test(iso)) return iso;
  const d = new Date(iso);
  // Inside the week the weekday IS the clearest name, and it is the one `whenLabel` already
  // speaks — so the near band is literally the same derivation, not a second copy of it.
  if (d.getTime() - now.getTime() < 6 * 24 * 60 * 60 * 1000) return whenLabel(iso, zone);
  try {
    return dateClock(d, zone);
  } catch {
    // An unknown zone throws rather than falling back to UTC, and this label survives it — the
    // engine's own rule, with the caller that can carry on saying so.
    return iso;
  }
}

/**
 * "Fri 09:00" from an ISO instant, read where the reader is — the webapp's `resurfaceLabel`,
 * so the toast reads back the same wall clock the preset fixed. Not-ISO input echoes through,
 * exactly as the reference does.
 */
export function whenLabel(iso: string, zone: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T/.test(iso)) return iso;
  const d = new Date(iso);
  try {
    return weekdayClock(d, zone);
  } catch {
    return iso;
  }
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
 * through {@link whenLabel} — the chrome gets a sentence-ready time in the reader's own zone.
 */
export function staleAsOf(
  engine: { freshness(): { state: "unknown" | "stale" | "current"; asOf: string | null } },
  zone: string,
): string | null {
  const f = engine.freshness();
  return f.state === "stale" && f.asOf !== null ? whenLabel(f.asOf, zone) : null;
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
  /** No password on this phone for this mailbox — nothing was dialled and nothing is retrying. */
  | { readonly kind: "needsCredential" }
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
  if (verdict.kind === "needsCredential") return Copy.connectionNeedsPassword;
  return verdict.kind === "lost" ? Copy.connectionLost : Copy.connectionGoneSince(verdict.since);
}

export function connectionSay(
  here: {
    reachable: boolean | null;
    unreachableSince: string | null;
    signInRefused: boolean;
    needsCredential?: boolean;
  } | null,
  now: Date,
  zone: string,
): ConnectionSay | null {
  if (here === null || here.reachable === null) return null;
  /* RANKED ABOVE `reachable`, because a refused sign-in leaves the connection dead AND
     un-retried: both flags are set, and the arm that says "Reconnecting…" would be a promise
     nothing is keeping. */
  if (here.signInRefused) return { kind: "refused" };
  /* ABOVE `reachable` AND ABOVE THE OUTAGE ARMS BELOW, for the reason `refused` is above both:
     nothing was dialled, so "Connection lost. Reconnecting…" is a promise nothing is keeping and
     an outage clock is a duration there is no start for. The remedy is a password. */
  if (here.needsCredential === true) return { kind: "needsCredential" };
  if (here.reachable) return { kind: "reachable" };
  const stamp = here.unreachableSince;
  if (stamp === null) return { kind: "lost" };
  const since = Date.parse(stamp);
  if (Number.isNaN(since)) return { kind: "lost" };
  return now.getTime() - since < RECONNECT_PROMISE_MS
    ? { kind: "lost" }
    : { kind: "gone", since: whenLabel(stamp, zone) };
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
