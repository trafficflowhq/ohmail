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
  isResurfaced,
  dateClock,
  messageDisplayTime,
  weekdayClock,
  feedPartition,
  ohboxView,
  physicalFolderOf,
  presentationReader,
  presentsUnread,
  readsPartition,
  receiptsByDay,
  rulesList,
  scheduledSendsList,
  screenerSegments,
  senderKey,
  threadOf,
  triagePiles,
  winningStates,
  withSignature,
  SIG_FOLLOWING,
  effectiveSignature,
  folderNameError,
  type FolderNameError,
  type SignatureState,
  type BodyState,
  type EmailAddress,
  type EngineDraft,
  type EngineMessage,
  type EngineMutation,
  type EntityReader,
  type FeedView,
  type Folder,
  type FolderEntity,
  type MutationResult,
  type OhmailEngine,
  type RuleDTO,
  type ScreenDest,
  type ScreenerSenderDTO,
  type TagDTO,
} from "@ohmail/client-engine";
import { Copy } from "../copy";
import { refuse, type RefusalArg } from "../refusal";
import { folderLeafOf, folderUnreadCounts } from "./folders";
import type { ScreeningAnswer } from "../net/consent";
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
   * THE ACCOUNT'S CUTLINE ANSWER (`GET /consent`), read by the world layer on the folders flag's
   * own cadence, or `null` until a read succeeds this session. It decides WHICH SENDERS ARE STILL
   * WORTH A DECISION, and the server answers that from `account_settings` while this client used
   * to answer it from the engine's default — six waiting senders listed, two shown. Absent ⇒
   * `null` ⇒ the unanswered posture in {@link presentedOf}.
   */
  screening?: ScreeningAnswer | null;
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
 * `GET /consent`'s three fields, `ownAddresses` is `GET /mailboxes`'. `null` is not-answered
 * and files nobody into History: every undecided sender stays at the gate until the account's
 * answer lands, so a boot shows a superset rather than a drop. (Residual: an undated message
 * cannot make its sender active even under `all_time`. Unchanged here, never a new drop.)
 */
export interface PresentedWorld {
  /** The projection the pile selectors read — History's rows are absent from its `message` list. */
  reader: EntityReader;
  /** History's own contents, newest first — the SAME partition's other arm. */
  history: readonly EngineMessage[];
}

/**
 * ONE PARTITION, TWO ARMS — the Screener's waiting senders and History's retired mail are the
 * two sides of a single `consentPartition` call, so the two lists cannot disagree about a
 * sender. Partitioning twice (once for the projection, once for History) would be one rule read
 * at two clocks, which is a sender in both lists or in neither.
 */
export function presentedWorld(
  reader: EntityReader, now: Date, foldersEnabled = false,
  screening?: ScreeningAnswer | null,
  ownAddresses?: readonly string[],
): PresentedWorld {
  const answered = screening ?? null;
  const partition = consentPartition(reader, {
    now,
    foldersEnabled,
    ...(answered === null
      ? { screeningScope: "all_time" as const }
      : {
          ...(answered.dormancyDays === null ? {} : { dormancyDays: answered.dormancyDays }),
          baselineAt: answered.baselineAt,
          screeningScope: answered.scope,
        }),
    /* Absent ⇒ `consentPartition` falls back to the mirror's `mailbox` entities, and this
       client's sync vocabulary carries none — so an empty set, which is what let the reader
       appear in their own queue. Passed whenever the mailbox read has landed. */
    ...(ownAddresses === undefined ? {} : { ownAddresses }),
  });
  return { reader: presentationReader(reader, partition), history: partition.history };
}

/** The projection alone — {@link presentedWorld}'s first arm, for a caller with no History list. */
export function presentedOf(
  reader: EntityReader, now: Date, foldersEnabled = false,
  screening?: ScreeningAnswer | null,
  ownAddresses?: readonly string[],
): EntityReader {
  return presentedWorld(reader, now, foldersEnabled, screening, ownAddresses).reader;
}

/* ───────────────────────────────────────────────────────────── row mapping */

/** One attachment tile: the engine's item (fallback name applied), size as words. */
export interface WorldAttachment {
  id: string;
  filename: string;
  size: string;
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
  /** Where the message physically is — what the move panel leaves out of its list. */
  folder: Folder;
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
 * THE MESSAGE'S CURRENT TRIAGE CLAIM — the winning `message_state` row, falling back to the
 * DTO's own `triage`. Reading `m.triage` alone was measured to miss a just-dispatched
 * `triage_set` entirely (the optimistic effect and the live server both write `message_state`
 * records, not the message row), which turned every toggle into a re-file: press Later twice
 * and the wire carried `reply_later` twice, never `none`. `winningStates` is the same
 * dedup-by-newest-claim the pile lister and the Ohbox hold-out derive from, so the bar's
 * pressed face, the toggles and the piles cannot disagree about where a message stands.
 */
function triageStateOf(reader: EntityReader, m: EngineMessage): string | null {
  return winningStates(reader).get(m.id)?.state ?? m.triage?.state ?? null;
}

function pileOf(reader: EntityReader, m: EngineMessage): WorldPileState {
  const s = triageStateOf(reader, m);
  if (s === "resurfaced" || isResurfaced(m)) return "resurfaced";
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
    id: m.id,
    place: placeOfFolder(m.folder),
    // The PHYSICAL folder, not the presented one: this reader is the projection, which
    // re-homes a decided sender's mail for display while `physicalFolder` keeps the real
    // location. The move panel excludes where the message actually IS, and `move()` reads
    // the raw mirror — a presented folder here offered a destination the move then refused.
    // (`physicalFolderOf` answers `physicalFolder ?? folder`, both `Folder` values on the
    // wire; its `string` return is the DTO's optional field being untyped, not a new shape.)
    folder: physical as Folder,
    mailboxId: m.mailboxId,
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
 * The destinations the move panel offers for a message — every target except where the
 * message already is (the webapp panel's own filter: `FOLDER_OF_VIEW[v] !== message.folder`).
 */
export function moveTargetsFor(folder: Folder): MoveTarget[] {
  return MOVE_TARGETS.filter((t) => FOLDER_OF_VIEW[t] !== folder);
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
  unread: number;
  total: number;
}

/** The Ohbox — `ohboxView` over the projection, reshaped and nothing more. */
export function liveOhbox(pres: EntityReader, v: WorldView): WorldOhbox {
  const box = ohboxView(pres);
  const map = (list: EngineMessage[]) => list.map((m) => toMail(pres, m, v));
  const fresh = map(box.newForYou);
  const seen = map(box.previouslySeen);
  const resurfaced = map(box.resurfaced);
  return {
    resurfaced,
    fresh,
    seen,
    /* THE COUNT IS ABOUT THE MAILBOX; THE BOLD IS ABOUT THE PIN — and they are allowed to
       differ, on both surfaces, in the same direction.
       `box.resurfaced`, not the mapped rows above: those have been through `toMail`, whose
       `unread` is `presentsUnread` and therefore true for every pin. Counting them would make
       this line say "1 unread" over a message the mail server calls read — and the shell's own
       Ohbox meta counts genuine unread for exactly that reason, so the phone would also be the
       one surface reporting a different number for the same mailbox. A pinned row is drawn
       unread because it is pinned; it is not NEW mail, and neither list claims it is. */
    unread: fresh.length + box.resurfaced.filter((m) => m.unread).length,
    total: resurfaced.length + fresh.length + seen.length,
  };
}

export interface WorldReads {
  items: WorldMail[];
  /** The waterline renders directly ABOVE this id — the anchor itself sits below the line. */
  waterlineAboveId: string | null;
  newCount: number;
}

export function liveReads(pres: EntityReader, v: WorldView): WorldReads {
  const p = readsPartition(pres);
  const items = [...p.fresh, ...p.seen].map((m) => toMail(pres, m, v));
  return {
    items,
    waterlineAboveId: p.seen[0]?.id ?? null,
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
}

const AI_DESTS = new Set<string>(["ohbox", "reads", "receipts", "screened", "spam"]);

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
  const ai =
    dto.ai && !dto.ai.noAnswer && AI_DESTS.has(dto.ai.dest)
      ? { dest: dto.ai.dest as Destination, confidence: dto.ai.confidence, rationale: dto.ai.rationale }
      : null;
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
 * The three shelves — `screenerSegments` over the projection (the queue the webapp renders),
 * reshaped. `scopes` carries the reader's per-sender scope choice (this sender / whole
 * domain), which is view state on a live account rather than a mirror fact — keyed by the
 * STABLE {@link ScreenerRow.routeKey}, never the representative id a drain re-mints.
 */
export function liveScreener(
  pres: EntityReader, v: WorldView, scopes: Readonly<Record<string, Scope>> = {},
): WorldScreener {
  // `v.ownAddresses` rides in for the reason it rides into `presentedWorld`: the projection keeps
  // an own-address row in its own place, so without it a self-addressed message in the Screener
  // folder is a waiting row and the reader queues in their own queue.
  const segments = screenerSegments(pres, v.now, v.locale ?? "en", v.zone, v.ownAddresses);
  const map = (rows: ScreenerSenderDTO[]) =>
    rows.map((dto) => rowOf(dto, scopes[senderKey(dto.from.address)]));
  return {
    waiting: map(segments.waiting),
    screened: map(segments.screenedOut),
    spam: map(segments.spam),
  };
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
  return { items, total: items.length };
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
    engine.read(), v.now, v.foldersEnabled === true, v.screening ?? null, v.ownAddresses,
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
  const atts = engine.attachmentsOf(id);
  if (atts.state === "ready" && atts.items.length > 0) {
    row.attachments = atts.items.map((item) => ({
      id: item.id,
      filename: item.filename,
      size: sizeLabel(item.sizeBytes),
    }));
  }
  return row;
}

function sizeLabel(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes)) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/* ─────────────────────────────────────────────────────────────── mutations */

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

/** `PATCH /messages` id cap per request — the webapp's own batch size. */
const MARK_SEEN_MAX = 200;

/**
 * How long the LEAVE COMMIT waits for in-flight sweeps before anchoring on the pool as it
 * stands. The leave now also fires on APP BACKGROUND, where the runtime may suspend at any
 * moment — an unbounded await there is a waterline that never dispatches, which loses the
 * whole visit; a bounded one dispatches into the engine's durable outbox while the process
 * is still allowed to run. See `leaveFeed` for the narrow rollback exposure this accepts.
 */
const LEAVE_SETTLE_DEADLINE_MS = 1_500;

/**
 * One watched dispatch: `rolled_back` or a rejection is a refusal; `queued` is NOT — the
 * mutation is on the retry queue with its Idempotency-Key and the intent stands (the one
 * status where the optimistic view staying applied is truthful).
 */
function watched(p: Promise<MutationResult>): Promise<boolean> {
  return p.then((r) => r.status !== "rolled_back", () => false);
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
    const meta = kinds.get(r.key) ?? { kind: "mark_seen" as const, forward: false, sendAt: null };
    const status =
      r.status === "confirmed" ? ("confirmed" as const)
        : r.error?.code === "send_unverified" ? ("unverified" as const)
          : ("rolled_back" as const);
    outcomes.set(r.key, { status, kind: meta.kind, forward: meta.forward, sendAt: meta.sendAt });
  }
  return outcomes;
}

export interface LiveDeps {
  engine: OhmailEngine;
  /** One plain sentence to the reader — the screens' toast. */
  /**
   * A REFUSAL, not a sentence. A toast held in the queue used to be words chosen when it was
   * raised, so one already on screen kept the language it was raised in while everything around
   * it followed a switch. The screen writes it out with `sayArg`.
   */
  toast: (say: RefusalArg) => void;
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
  /** Move THIS message to a view — `POST /messages/:id/move`, the same verb every list uses. */
  move(messageId: string, dest: MoveTarget): Promise<boolean>;
  /**
   * DELETE — `message_delete` (`DELETE /messages/:id`, mail 0065): the message rides to the
   * provider's native `\Trash` on the server, NEVER an expunge, and the optimistic tombstone
   * drops it from every living view at the press. A mailbox with no Trash folder is the
   * server's 422 refusal, which rolls the row back whole — the one honest screen for a delete
   * that cannot happen. The confirm ceremony is the sheet's job; this arm dispatches.
   */
  deleteMessage(messageId: string): Promise<boolean>;
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
  ): Promise<SendResult>;
  /**
   * Forward — `mail_send` with `forwardOf`, recipients the USER typed, the user's note as
   * body. The signature seals into the NOTE; the server appends the quoted original after
   * the body it is handed, so the block sits above the quoted history (`signature.ts`).
   */
  sendForward(messageId: string, to: EmailAddress[], body: string, sig?: string | null): Promise<SendResult>;
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
  screenSender(messageId: string, dest: Destination, scope: Scope): Promise<boolean>;

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
    const ok = await watched(engine.mutate({ kind: "mark_seen", messageIds: [id], unread: false, via: "glance" }));
    if (!ok) toast(refuse("liveSaveFailed"));
    return ok;
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
      const ok = await watched(engine.mutate({ kind: "feed_mark_seen", view, messageIds: fresh }));
      if (!ok) {
        // The engine rolled the rows back to unread; the CACHE has to roll back with it, or
        // the ids are skip-listed (the flip never retried) and the leave commit can anchor
        // on a row that is still unread. The rows stay sweepable: the
        // next scroll event re-attempts them.
        for (const id of fresh) seen.delete(id);
        toast(refuse("liveSaveFailed"));
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
    const ok = await watched(
      engine.mutate({ kind: "feed_mark_seen", view, messageIds: [], upToId: anchor.id }),
    );
    if (!ok) toast(refuse("liveSaveFailed"));
    return ok;
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
    let landed: Promise<boolean>;
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
          return r.status !== "rolled_back";
        },
        () => false,
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
    const ok = await landed;
    if (!ok) {
      toast(refuse("liveDecideFailed", row.address));
      return ok;
    }
    const queued = queuedWith as { name: string | null } | null;
    toast(
      queued === null ? refuse("liveDecided", destDone(dest), target) : queued.name ? refuse("liveDecidedElsewhere", queued.name, target) : refuse("liveDecidedElsewhereUnknown", target),
    );
    return ok;
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
    const ok = (await Promise.all(parts)).every(Boolean);
    if (!ok) toast(refuse("liveReleaseFailed", row.address));
    return ok;
  };

  const setPile = async (messageId: string, kind: PileKind): Promise<boolean> => {
    const state = kind === "replyLater" ? "reply_later" : kind === "setAside" ? "set_aside" : "bubbled_up";
    const ok = await watched(
      engine.mutate({
        kind: "triage_set",
        messageId,
        state,
        ...(kind === "resurface" ? { bubbleUpAt: nextMorning(now()).toISOString() } : {}),
      }),
    );
    toast(ok ? refuse("livePileAdded", pileTitle(kind)) : refuse("livePileFailed", pileTitle(kind)));
    return ok;
  };

  /* ── the open message's verbs ──────────────────────────────────────────────────────────── */

  const zone = deps.zone ?? readerZone();
  const messageOf = (id: string): EngineMessage | undefined =>
    engine.read().get<EngineMessage>("message", id);

  /**
   * One triage write, stated in the webapp's own sentence. The toast is spoken on the
   * OPTIMISTIC apply (the webapp's shape — the sentence is the act), and a rollback overrides
   * it with the one failure sentence.
   */
  const triage = async (
    messageId: string,
    state: "none" | "reply_later" | "set_aside" | "bubbled_up" | "resurfaced",
    say: RefusalArg,
    bubbleUpAt?: string,
  ): Promise<boolean> => {
    toast(say);
    const ok = await watched(
      engine.mutate({ kind: "triage_set", messageId, state, ...(bubbleUpAt ? { bubbleUpAt } : {}) }),
    );
    if (!ok) toast(refuse("liveSaveFailed"));
    return ok;
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
    return resurfaceAt(messageId, tomorrowNine(now()).toISOString());
  };

  const resurfaceNow = (messageId: string): Promise<boolean> =>
    triage(messageId, "resurfaced", refuse("toastResurfaceNow"));

  const markSeen = async (messageId: string, unread: boolean): Promise<boolean> => {
    // No `via`: this is the deliberate read, the one that spends a resurface pin on both sides
    // of the wire — the opposite of the open's glance and the streams' sweep.
    const ok = await watched(engine.mutate({ kind: "mark_seen", messageIds: [messageId], unread }));
    if (!ok) toast(refuse("liveSaveFailed"));
    return ok;
  };

  const resurfaceDone = async (messageId: string): Promise<boolean> => {
    const m = messageOf(messageId);
    if (!m) return false;
    // A SCHEDULED message's release has an extra half: the booking is cleared first (the same
    // un-triage the toggles use), then the same deliberate read files it under Earlier.
    const parts: Promise<boolean>[] = [];
    if (triageStateOf(engine.read(), m) === "bubbled_up") {
      parts.push(watched(engine.mutate({ kind: "triage_set", messageId, state: "none" })));
    }
    parts.push(watched(engine.mutate({ kind: "mark_seen", messageIds: [messageId], unread: false })));
    toast(refuse("toastResurfaceDone"));
    const ok = (await Promise.all(parts)).every(Boolean);
    if (!ok) toast(refuse("liveSaveFailed"));
    return ok;
  };

  const move = async (messageId: string, dest: MoveTarget): Promise<boolean> => {
    const m = messageOf(messageId);
    const folder = FOLDER_OF_VIEW[dest];
    if (!m || !folder || folder === m.folder) return false;
    toast(refuse("toastMoved", moveTargetLabel(dest)));
    const ok = await watched(engine.mutate({ kind: "move", messageId, folder }));
    if (!ok) toast(refuse("liveSaveFailed"));
    return ok;
  };

  /**
   * DELETE, stated on the optimistic apply like every triage verb — the tombstone drops the
   * row the instant the sentence is spoken, and a rejection (422 `no_trash_folder`, a 404)
   * overrides it with the failure sentence over the restored row. No `via`, no read verb: a
   * delete is not a read, and the pin arithmetic is the engine's (`spentResurface` rides the
   * same mutation effects).
   */
  const deleteMessage = async (messageId: string): Promise<boolean> => {
    const m = messageOf(messageId);
    if (!m) return false;
    toast(refuse("toastDeleted"));
    const ok = await watched(engine.mutate({ kind: "message_delete", messageId }));
    if (!ok) toast(refuse("deleteFailed"));
    return ok;
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
  const sent = async (p: Promise<MutationResult>, sentToast: RefusalArg): Promise<SendResult> => {
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
    toast(
      outcome === "sent" ? sentToast
        : outcome === "queued" ? refuse("replyQueued")
          : outcome === "unverified" ? refuse("replyUnverified")
            : refuse("replyFailed"),
    );
    return { outcome, ...(outcome === "queued" && first ? { key: first.key } : {}) };
  };

  const sendReply = async (
    messageId: string,
    body: string,
    all: boolean,
    sig: string | null = null,
    sendAt: string | null = null,
  ): Promise<SendResult> => {
    const m = messageOf(messageId);
    const text = body.trim();
    // The empty-body refusal is judged BEFORE the signature joins: a signature must never
    // light Send up over an empty message (the webapp composer's own rule).
    if (!m || text === "") return { outcome: "failed" };
    // A plain reply leaves the envelope to `Engine.enrich` (to = the sender, the parent's
    // mailbox, thread and subject); reply-all carries the SAME envelope the sheet offered.
    /* THE SAME ADDRESSES THE SHEET WAS DRAWN FROM. Read through the getter at SEND time, not at
       construction — see {@link LiveDeps.ownAddresses}. */
    const env = all ? replyAllRecipients(m, deps.ownAddresses?.() ?? NO_OWN_ADDRESSES) : null;
    return sent(
      engine.mutate(withSignature({
        kind: "mail_send" as const,
        inReplyTo: messageId,
        body: text,
        ...(env ? { to: env.to, cc: env.cc } : {}),
        // Present ⇒ an appointment, absent ⇒ a delivery. Spread rather than written as
        // `sendAt: sendAt ?? undefined` so an ordinary reply's mutation is byte-identical to
        // the one this arm built before Send later existed.
        ...(sendAt ? { sendAt } : {}),
      }, sig)),
      // THE CONFIRMED SENTENCE IS THE WHOLE DIFFERENCE, and it is honest rather than
      // convenient: nothing was sent, an appointment was made, and "Reply sent." over a
      // message still sitting on the account is exactly the false claim the four-outcome
      // classifier exists to prevent. The time is read back in the reader's own clock, so the
      // toast names the wall clock the preset fixed.
      sendAt ? Copy.scheduledFor(scheduleLabel(sendAt, now(), zone)) : Copy.replySent,
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

  const sendForward = async (messageId: string, to: EmailAddress[], body: string, sig: string | null = null): Promise<SendResult> => {
    const m = messageOf(messageId);
    // The `no_forward` refusal is client-side courtesy AND server-side law — the sheet never
    // offers the verb on such a message, and this arm refuses it too rather than trusting the UI.
    if (!m || to.length === 0 || m.sensitivity?.no_forward) return { outcome: "failed" };
    return sent(
      engine.mutate(withSignature({
        kind: "mail_send" as const,
        inReplyTo: null,
        forwardOf: messageId,
        subject: forwardSubject(m.subject),
        // The mailbox the original arrived in — the same sender a reply gets from `enrich`.
        // A forward has no parent-derived From of its own, and the send refuses without one.
        mailboxId: m.mailboxId,
        body,
        to,
      }, sig)),
      Copy.forwarded,
    );
  };

  const tagToggle = async (messageId: string, tag: WorldTag, assigned: boolean): Promise<boolean> => {
    toast(assigned ? refuse("tagTagged", tag.name) : refuse("tagUntagged", tag.name));
    const ok = await watched(engine.mutate({ kind: "tag_assign", messageId, tagId: tag.id, assigned }));
    if (!ok) toast(refuse("liveSaveFailed"));
    return ok;
  };

  const tagCreate = async (messageId: string, name: string): Promise<boolean> => {
    const typed = name.trim();
    if (typed === "" || !deps.uuid) return false;
    // Case-insensitive against the whole tag set — the unique index is on `lower(name)`, so
    // "Invoices" beside "invoices" is the existing tag, toggled on, not a 409.
    const existing = liveTags(engine.read()).find((t) => t.name.toLowerCase() === typed.toLowerCase());
    if (existing) return tagToggle(messageId, existing, true);
    toast(refuse("tagTagged", typed));
    const ok = await watched(
      engine.mutate({ kind: "tag_assign", messageId, tagId: deps.uuid(), assigned: true, createName: typed }),
    );
    if (!ok) toast(refuse("liveSaveFailed"));
    return ok;
  };

  /**
   * Screening from the open message — the rule ladder, mirrored from
   * `apps/webapp/app/shell/sender-screening.ts#planScreeningChange`: (1) a subject still waiting
   * at the gate is decided with `screener_decide` on its newest held message — the server
   * promotes the rule in the decision's own transaction; (2) an enabled term-free rule of the
   * same kind already at the destination writes nothing; (3) rules pointing elsewhere — every
   * one, never just the first — are retargeted with `rule_update`; (4) otherwise one is written,
   * with `applyRetro`. The moves are the optimistic half, capped at `RETRO_VISIBLE_MOVES` (50);
   * the rule is awaited and reported, the moves roll their own rows back. Raw mirror reads.
   */
  const screenSender = async (messageId: string, dest: Destination, scope: Scope): Promise<boolean> => {
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

    const waiting = subject
      .filter((x) => physicalFolderOf(x) === FOLDER_OF_VIEW.screener)
      .sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""))[0];
    const decision: "yes" | "no" = dest === "screened" || dest === "spam" ? "no" : "yes";

    let ruled: Promise<boolean>;
    if (waiting) {
      ruled = watched(
        engine.mutate({ kind: "screener_decide", senderId: waiting.id, decision, dest: dest as ScreenDest, scope }),
      );
      // The decide relocates the HELD rows and promotes the rule — it does not touch the
      // subject's mail that already left the gate. Those rows move beside it (the webapp's
      // `planScreeningChange` shape: moves cover what the decide does not), capped and
      // unawaited like every optimistic move.
      subject
        .filter((x) => physicalFolderOf(x) !== FOLDER_OF_VIEW.screener && x.folder !== wanted)
        .slice(0, 50)
        .forEach((x) => void engine.mutate({ kind: "move", messageId: x.id, folder: wanted }));
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
        .map((r) => ({ kind: "rule_update", ruleId: r.id, destination: wanted }));
      const writes: EngineMutation[] =
        standing.length === 0
          ? [{ kind: "rule_create", ruleKind: scope, match, destination: wanted, applyRetro: true }]
          : retargets;
      ruled = Promise.all(writes.map((w) => watched(engine.mutate(w)))).then((rs) => rs.every(Boolean));
      // The optimistic half: what the reader can see moves now; the server's pass does the rest.
      subject
        .filter((x) => x.folder !== wanted)
        .slice(0, 50)
        .forEach((x) => void engine.mutate({ kind: "move", messageId: x.id, folder: wanted }));
    }
    toast(refuse("liveDecided", destDone(dest), target));
    const ok = await ruled;
    if (!ok) toast(refuse("liveDecideFailed", m.from.address));
    return ok;
  };

  /* ── the folder verbs — see the interface's header for the whole optimism model ─────────── */

  /** One folder command, spoken about ONLY on rollback — success's feedback is the pending row. */
  const folderVerb = async (m: EngineMutation): Promise<boolean> => {
    const ok = await watched(engine.mutate(m));
    if (!ok) toast(refuse("folderVerbFailed"));
    return ok;
  };

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
    openMessage, hydrateMessage, hydrateHeld, sweepFeed, leaveFeed, decide, release, setPile,
    pileToggle, resurfaceToggle, resurfaceAt, resurfaceNow, resurfaceDone, markSeen, move,
    deleteMessage, sendReply, sendForward, cancelSchedule, tagToggle, tagCreate, screenSender,
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
  move(messageId: string, dest: MoveTarget): void;
  /** Delete — to the provider's native Trash, never an expunge. See {@link LiveWorldActions.deleteMessage}. */
  deleteMessage(messageId: string): void;
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
  ): Promise<SendResult>;
  sendForward(messageId: string, to: EmailAddress[], body: string, sig?: string | null): Promise<SendResult>;
  /** Cancel a scheduled send — resolves `true` only on the server's CONFIRMED cancellation. */
  cancelSchedule(draftId: string): Promise<boolean>;
  /** What became of a queued send's key — how a locked composer settles. See `World.sendOutcome`. */
  sendOutcome(key: string): "pending" | "confirmed" | "rolled_back" | "unverified" | "unknown";
  tagToggle(messageId: string, tag: WorldTag, assigned: boolean): void;
  tagCreate(messageId: string, name: string): void;
  screenSender(messageId: string, dest: Destination, scope: Scope): void;
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
    move: (id, dest) => void current().move(id, dest),
    deleteMessage: (id) => void current().deleteMessage(id),
    sendReply: (id, body, all, sig, sendAt) => current().sendReply(id, body, all, sig, sendAt),
    sendForward: (id, to, body, sig) => current().sendForward(id, to, body, sig),
    cancelSchedule: (draftId) => current().cancelSchedule(draftId),
    sendOutcome: (key) => current().sendOutcome(key),
    tagToggle: (id, tag, assigned) => void current().tagToggle(id, tag, assigned),
    tagCreate: (id, name) => void current().tagCreate(id, name),
    screenSender: (id, dest, scope) => void current().screenSender(id, dest, scope),
    folderCreate: (mailboxId, name) => void current().folderCreate(mailboxId, name),
    folderRename: (id, name) => void current().folderRename(id, name),
    folderDelete: (id) => void current().folderDelete(id),
    folderDismiss: (id) => void current().folderDismiss(id),
  };
}

/** Resurface's one offered horizon on the phone: tomorrow, 09:00 local. */
function nextMorning(from: Date): Date {
  const d = new Date(from);
  d.setDate(d.getDate() + 1);
  d.setHours(9, 0, 0, 0);
  return d;
}

/*
 * ═══ THE RESURFACE HORIZONS ═══════════════════════════════════════════════════════════════
 *
 * The webapp's presets (format.ts): all land at 09:00 IN THE READER'S ZONE — the wall clock is
 * what is fixed, the instant is what varies. On the phone the reader's zone IS the device's
 * zone, so `Date`'s local setters are that arithmetic without a zone library: `setHours(9)`
 * asks the platform what 09:00 local means on that calendar day, DST included.
 */

/** Tomorrow, 09:00 where the reader is — the chooser's first dated preset and the `b`-key default. */
export function tomorrowNine(from: Date): Date {
  return nextMorning(from);
}

/** The coming Monday, 09:00 — and never "later today": a Monday resolves to the next one. */
export function nextWeekNine(from: Date): Date {
  const d = new Date(from);
  const diff = (1 - d.getDay() + 7) % 7 || 7;
  d.setDate(d.getDate() + diff);
  d.setHours(9, 0, 0, 0);
  return d;
}

/** A calendar day `n` days ahead, 09:00 local — the phone's "Pick a date" rows. */
export function dayNine(from: Date, daysAhead: number): Date {
  const d = new Date(from);
  d.setDate(d.getDate() + daysAhead);
  d.setHours(9, 0, 0, 0);
  return d;
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
 */
export function todayEvening(from: Date): Date {
  const d = new Date(from);
  d.setHours(18, 0, 0, 0);
  return d;
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

/** A calendar day `offset` days from `from`, at `hour` local — the picker's one instant maker. */
export function dayAtHour(from: Date, offset: number, hour: number): Date {
  const d = new Date(from);
  d.setDate(d.getDate() + offset);
  d.setHours(hour, 0, 0, 0);
  return d;
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
export function usableHours(from: Date, offset: number): number[] {
  return SEND_LATER_HOURS.filter(
    (hour) => dayAtHour(from, offset, hour).getTime() - from.getTime() >= SEND_LATER_MIN_LEAD_MS,
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
 * WHAT THE CONNECTION IS DOING, as one of three answers a surface can render.
 *
 * `null` is the fourth and it is the important one: nothing has said yet — a paired session, a
 * phone with no engine, or a door whose first cycle has not run. A surface renders no sentence
 * for it, rather than "Connection lost" a second after the mailbox opened.
 *
 * `refused` is separated from `lost` because the remedies are opposite: an unreachable server is
 * being re-dialled and heals on its own, a rejected sign-in is not retried at all and needs a
 * person. The door's own refusal owns that sentence, so this answer exists to keep the freshness
 * line from claiming a reconnect nothing is attempting.
 */
export type ConnectionSay =
  | { readonly say: "reachable" }
  | { readonly say: "refused" }
  | { readonly say: "lost" }
  | { readonly say: "gone"; readonly since: string };

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
 * state and `refused` is the door's own refusal — an answered no that nothing is re-dialling — so
 * both are silent here rather than dressed as an outage.
 */
export function connectionSaid(verdict: ConnectionSay | null): string | null {
  if (verdict === null || verdict.say === "reachable" || verdict.say === "refused") return null;
  return verdict.say === "lost" ? Copy.connectionLost : Copy.connectionGoneSince(verdict.since);
}

export function connectionSay(
  here: {
    reachable: boolean | null;
    unreachableSince: string | null;
    signInRefused: boolean;
  } | null,
  now: Date,
  zone: string,
): ConnectionSay | null {
  if (here === null || here.reachable === null) return null;
  /* RANKED ABOVE `reachable`, because a refused sign-in leaves the connection dead AND
     un-retried: both flags are set, and the arm that says "Reconnecting…" would be a promise
     nothing is keeping. */
  if (here.signInRefused) return { say: "refused" };
  if (here.reachable) return { say: "reachable" };
  const stamp = here.unreachableSince;
  if (stamp === null) return { say: "lost" };
  const since = Date.parse(stamp);
  if (Number.isNaN(since)) return { say: "lost" };
  return now.getTime() - since < RECONNECT_PROMISE_MS
    ? { say: "lost" }
    : { say: "gone", since: whenLabel(stamp, zone) };
}


/* Re-exported so the world layer and the suite spell the vocabulary identically. `FolderEntity`
 * rides through here because `live.ts` is the one state module on the engine's import
 * allow-list (`test/privacy.test.ts`) — the world layer and the screens take the type from
 * this seam, never from the package. `SIG_FOLLOWING`/`effectiveSignature` (the composer's
 * signature block) and `folderNameError` (the folder verbs' pre-wire honest sentence — the
 * SERVER's own rules, shared through the engine) ride through on the same terms. */
export { destDone, isPlace, SIG_FOLLOWING, effectiveSignature, folderNameError };
export type {
  Destination, FolderEntity, FolderNameError, Held, Mail, PileItem, PileKind, Place, Scope,
  SignatureState,
};
