/**
 * THE LIVE WORLD — what the mail screens render and dispatch when the connection is live.
 *
 * This is the one seam between the screens and the engine, and it holds both halves:
 *
 *  · **Reads** are the SHARED selectors, never re-derived: `ohboxView`, `readsPartition`,
 *    `receiptsByDay`, `screenerSegments`, `triagePiles`, `bodyOf`, `threadOf` — the exact
 *    functions the webapp and desktop shells render from — over the consent-cutline
 *    projection (`presentationReader` ∘ `consentPartition`), so the piles this phone shows
 *    are the piles a second client shows for the same mirror. The mapping here only reshapes
 *    their DTOs into the row shapes the screens render (the screens stay logic-free).
 *
 *  · **Writes** go through `engine.mutate({kind: …})` — the SAME contract every other client
 *    uses, with the optimistic overlay and the server-rejection rollback owned by the engine.
 *    Every dispatch is WATCHED: `rolled_back` (or a rejection) raises one plain sentence
 *    through the injected toast; `queued` is not a failure — the intent stands on the retry
 *    queue with its Idempotency-Key (the webapp's `moveAll` doctrine, verbatim).
 *
 * ── THE RELEASE FAMILY REWRITES THE HOLDING RULE — never bare moves ─────────────────────────
 *
 * "Allow" on a screened-out sender and "Not spam" both mirror the webapp's shape
 * (`screener-state.ts#release`): the rules that HOLD the sender in the
 * segment are retargeted (`rule_update`) beside `move`s that cover ONLY mail physically in the
 * segment's folder. A release made of bare moves fails twice — a move for mail already at the
 * destination is the engine's local 404 with nothing sent, and the moves that land are
 * re-presented straight back by the standing rule. `holdingRules`/`ruleMatchesSender` are
 * mirrored from `apps/webapp/app/shell/sender-screening.ts` / `sender-audit.ts` (the webapp
 * shell is not an importable package from RN); the webapp files remain the reference.
 *
 * ── MUTATIONS READ THE RAW MIRROR, READS RENDER THE PROJECTION ──────────────────────────────
 *
 * `presentationReader`'s own contract: a projected reader answers with a presentation, and a
 * move needs a location. Every action below reads `engine.read()` (raw); every selector call
 * a screen renders goes through {@link presentedOf}.
 *
 * No React, no I/O of its own, and NO network: the engine is handed in, which is what lets this
 * module be driven against a real loopback server without a renderer.
 */
import {
  FOLDER_OF_VIEW,
  LAST_DRAIN_AT_META,
  VIEW_OF_FOLDER,
  bodyOf,
  consentPartition,
  forwardSubject,
  isResurfaced,
  messageDisplayTime,
  feedPartition,
  ohboxView,
  physicalFolderOf,
  presentationReader,
  readsPartition,
  receiptsByDay,
  rulesList,
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
import { folderLeafOf, folderUnreadCounts } from "./folders";
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
 * The mirror with every message sitting where it is PRESENTED — the same projection the
 * webapp shell feeds its pile selectors (`AppShell` → `consentPartition` → `presentationReader`).
 * Default options: the phone has no `GET /consent` read yet, so the cutline runs on
 * `DEFAULT_DORMANCY_DAYS` with no baseline — the standalone desktop's own posture.
 */
export function presentedOf(reader: EntityReader, now: Date, foldersEnabled = false): EntityReader {
  return presentationReader(reader, consentPartition(reader, { now, foldersEnabled }));
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
  const env = replyAllRecipients(m, NO_OWN_ADDRESSES);
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
    unread: m.unread,
    pile: pileOf(reader, m),
    // The phone holds no `GET /mailboxes` facts, so the reader cannot be told apart — the
    // predicate's documented degradation: offered from two listed people, withheld at one.
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
 * THE PHONE KNOWS NONE OF THE READER'S OWN ADDRESSES. The webapp resolves them from
 * `GET /mailboxes` once in `AppShell`; this client has no mailbox read yet, and the honest
 * posture is the one the webapp documents for a surface without the facts (`message-chrome.tsx`
 * `ownAddresses`): recognise the reader nowhere. Every predicate below takes this constant so
 * the day a mailbox read lands there is one place to feed it.
 */
const NO_OWN_ADDRESSES: readonly string[] = [];

/** The reply-all envelope: who stands on the To line, and who rides Cc. */
export interface ReplyAllRecipients {
  to: EmailAddress[];
  cc: EmailAddress[];
}

/**
 * WHO A REPLY TO ALL IS ADDRESSED TO — or `null` when "all" is nobody beyond the plain reply.
 *
 * Mirrored from `apps/webapp/app/shell/compose-from.ts#replyAllRecipients` (the reference; the
 * webapp shell is not an importable package from React Native). The `null` is the visibility
 * rule as well as the degenerate case: the bar offers Reply all exactly when this returns an
 * envelope, and the send path asks the SAME call, so what the sheet promised and what leaves
 * the account are one decision. With no own addresses the self-filter has nothing to filter
 * with, so the envelope is offered from two listed people and withheld at one — a lone
 * recipient is almost always the reader. Counted across BOTH lines, folded, one person once.
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
    unread: fresh.length + resurfaced.filter((m) => m.unread).length,
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
    newCount: items.filter((m) => m.unread).length,
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
  return {
    groups,
    waterlineAboveId: feedPartition(pres, "receipts").seen[0]?.id ?? null,
    newCount: all.filter((m) => m.unread).length,
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
  const segments = screenerSegments(pres, v.now, v.locale ?? "en", v.zone);
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

/** The pile blurbs — one wording, shared with the desktop client's. */
export const PILE_META: Record<PileKind, { title: string; note: string }> = {
  replyLater: { title: "Answer Later", note: "Answers you owe. A Reply Run walks them one screen at a time." },
  setAside: { title: "Parked", note: "Kept in view without keeping the Ohbox busy." },
  resurface: { title: "Resurface", note: "Comes back on its own, at the time you chose." },
};

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
  return (Object.keys(PILE_META) as PileKind[]).map((kind) => ({
    kind,
    ...PILE_META[kind],
    items: piles[kind].map(toItem),
  }));
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
  // and the reader says "no longer here" over mail the list just showed.
  const pres = presentedOf(engine.read(), v.now, v.foldersEnabled === true);
  const m = pres.get<EngineMessage>("message", id);
  if (!m) return undefined;
  const row = toMail(pres, m, v);
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
      { kind: p.mutation.kind, forward: p.mutation.kind === "mail_send" && !!p.mutation.forwardOf },
    ]),
  );
  const outcomes = new Map<string, FlushedOutcome>();
  const results = await engine.flushPending().catch(() => []);
  for (const r of results) {
    if (r.status === "queued") continue;
    const meta = kinds.get(r.key) ?? { kind: "mark_seen" as const, forward: false };
    const status =
      r.status === "confirmed" ? ("confirmed" as const)
        : r.error?.code === "send_unverified" ? ("unverified" as const)
          : ("rolled_back" as const);
    outcomes.set(r.key, { status, kind: meta.kind, forward: meta.forward });
  }
  return outcomes;
}

export interface LiveDeps {
  engine: OhmailEngine;
  /** One plain sentence to the reader — the screens' toast. */
  toast: (sentence: string) => void;
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
}

export interface LiveWorldActions {
  /** Opening a message marks it read and asks for its full text + conversation + files. */
  openMessage(id: string): Promise<boolean>;
  /** An explicit re-ask for one message's full text (a card expand, a reopen). */
  hydrateMessage(id: string): void;
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
   * `sig` is the signature block's OWN derived text (`effectiveSignature`, computed once by
   * the sheet for display and handed here verbatim — what is shown is what ships); `null`
   * leaves the mutation byte-identical to one built before the block existed.
   */
  sendReply(messageId: string, body: string, all: boolean, sig?: string | null): Promise<SendResult>;
  /**
   * Forward — `mail_send` with `forwardOf`, recipients the USER typed, the user's note as
   * body. The signature seals into the NOTE; the server appends the quoted original after
   * the body it is handed, so the block sits above the quoted history (`signature.ts`).
   */
  sendForward(messageId: string, to: EmailAddress[], body: string, sig?: string | null): Promise<SendResult>;
  /** Put a tag on / take it off — `tag_assign`. */
  tagToggle(messageId: string, tag: WorldTag, assigned: boolean): Promise<boolean>;
  /** Tag-or-create: a name that does not exist yet, minted and put on this message in one act. */
  tagCreate(messageId: string, name: string): Promise<boolean>;
  /**
   * SCREENING from the open message: where THIS SENDER's mail goes — the webapp sender sheet's
   * rule ladder (`sender-screening.ts#planScreeningChange`), in the phone's idiom.
   */
  screenSender(messageId: string, dest: Destination, scope: Scope): Promise<boolean>;

  /* ── the folder verbs (FOLDERS-SPEC.md stage 2) — the webapp `useFolderVerbs` arms ────────
   *
   * USER-COMMANDED REAL IMAP OPERATIONS in the user's own mailbox, dispatched on the same
   * engine mutations every client uses (`folder_create` / `folder_rename` / `folder_delete` /
   * `folder_op_dismiss`). The optimism model is the family's: the mutation paints a PENDING
   * MARKER (`FolderEntity.op`), the mailbox's `name` stays the truth until the worker lands
   * the change, and the wake channel settles it in seconds. Success says NOTHING — the
   * pending row itself is the feedback — and only `rolled_back` speaks, with the one failure
   * sentence (`folder-verbs.ts`'s `speakIfRolledBack`, verbatim in intent). `queued` is not a
   * failure: the command stands on the retry queue under its key, and the marker staying
   * painted is truthful.
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
    if (!ok) toast(Copy.liveSaveFailed);
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
        toast(Copy.liveSaveFailed);
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
    if (!ok) toast(Copy.liveSaveFailed);
    return ok;
  };

  const decide = async (row: ScreenerRow, dest: Destination, read: boolean, scope: Scope): Promise<boolean> => {
    const raw = engine.read();
    const rep = raw.get<EngineMessage>("message", row.id);
    if (!rep) {
      // The representative left the mirror between the render and the press (a drain, an
      // eviction). The one silent branch the webapp's commit named — never dispatch nothing.
      toast(Copy.liveDecideFailed(row.address));
      return false;
    }
    // Demote-stays-unread: filing to Screen out or Spam never carries a read verb.
    const readFlag = read && dest !== "screened" && dest !== "spam";
    // A derived row's spam verdict rides the NO branch — `yes` is the verb that ADMITS a
    // sender, and the server refuses `{decision:"yes", dest:spam}` outright (400).
    const decision: "yes" | "no" = dest === "screened" || dest === "spam" ? "no" : "yes";
    const target = scope === "domain" ? `@${domainOf(row.address)}` : row.address;

    let landed: Promise<boolean>;
    if (physicalFolderOf(rep) === FOLDER_OF_VIEW.screener) {
      landed = watched(
        engine.mutate({
          kind: "screener_decide",
          senderId: row.id,
          decision,
          dest: dest as ScreenDest,
          ...(decision === "yes" ? { read: readFlag } : {}),
          scope,
        }),
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
    toast(Copy.liveDecided(destDone(dest), target));
    const ok = await landed;
    if (!ok) toast(Copy.liveDecideFailed(row.address));
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
      toast(Copy.liveReleaseFailed(row.address));
      return false;
    }
    const parts = [
      ...retargets.map((m) => watched(engine.mutate(m))),
      ...moveIds.map((id) => watched(engine.mutate({ kind: "move", messageId: id, folder: wanted }))),
    ];
    // Two sentences, one true at a time: the retarget IS a statement about future mail.
    toast(
      retargets.length > 0
        ? Copy.liveReleasedRuled(row.held.length, destDone(dest))
        : Copy.liveReleased(row.held.length, destDone(dest)),
    );
    const ok = (await Promise.all(parts)).every(Boolean);
    if (!ok) toast(Copy.liveReleaseFailed(row.address));
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
    toast(ok ? Copy.livePileAdded(pileTitle(kind)) : Copy.livePileFailed(pileTitle(kind)));
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
    sentence: string,
    bubbleUpAt?: string,
  ): Promise<boolean> => {
    toast(sentence);
    const ok = await watched(
      engine.mutate({ kind: "triage_set", messageId, state, ...(bubbleUpAt ? { bubbleUpAt } : {}) }),
    );
    if (!ok) toast(Copy.liveSaveFailed);
    return ok;
  };

  const pileToggle = async (messageId: string, kind: "replyLater" | "setAside"): Promise<boolean> => {
    const m = messageOf(messageId);
    if (!m) return false;
    const held = triageStateOf(engine.read(), m);
    if (kind === "replyLater") {
      return held === "reply_later"
        ? triage(messageId, "none", Copy.toastUnqueued)
        : triage(messageId, "reply_later", Copy.toastQueued);
    }
    return held === "set_aside"
      ? triage(messageId, "none", Copy.toastUnparked)
      : triage(messageId, "set_aside", Copy.toastAside);
  };

  const resurfaceAt = (messageId: string, iso: string): Promise<boolean> =>
    triage(messageId, "bubbled_up", Copy.toastResurface(whenLabel(iso, zone)), iso);

  const resurfaceToggle = async (messageId: string): Promise<boolean> => {
    const m = messageOf(messageId);
    if (!m) return false;
    // A message already scheduled: the horizon-less verb CLEARS the booking rather than
    // silently re-dating it — the webapp's `resurface` arm, verbatim in intent.
    if (triageStateOf(engine.read(), m) === "bubbled_up") return triage(messageId, "none", Copy.toastResurfaceCleared);
    return resurfaceAt(messageId, tomorrowNine(now()).toISOString());
  };

  const resurfaceNow = (messageId: string): Promise<boolean> =>
    triage(messageId, "resurfaced", Copy.toastResurfaceNow);

  const markSeen = async (messageId: string, unread: boolean): Promise<boolean> => {
    // No `via`: this is the deliberate read, the one that spends a resurface pin on both sides
    // of the wire — the opposite of the open's glance and the streams' sweep.
    const ok = await watched(engine.mutate({ kind: "mark_seen", messageIds: [messageId], unread }));
    if (!ok) toast(Copy.liveSaveFailed);
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
    toast(Copy.toastResurfaceDone);
    const ok = (await Promise.all(parts)).every(Boolean);
    if (!ok) toast(Copy.liveSaveFailed);
    return ok;
  };

  const move = async (messageId: string, dest: MoveTarget): Promise<boolean> => {
    const m = messageOf(messageId);
    const folder = FOLDER_OF_VIEW[dest];
    if (!m || !folder || folder === m.folder) return false;
    toast(Copy.toastMoved(moveTargetLabel(dest)));
    const ok = await watched(engine.mutate({ kind: "move", messageId, folder }));
    if (!ok) toast(Copy.liveSaveFailed);
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
    toast(Copy.toastDeleted);
    const ok = await watched(engine.mutate({ kind: "message_delete", messageId }));
    if (!ok) toast(Copy.deleteFailed);
    return ok;
  };

  /**
   * A SEND'S THREE HONEST OUTCOMES — narrower than {@link watched}, deliberately.
   *
   * For triage and moves, `queued` leaving the optimistic view standing is truthful. For a
   * SEND it is not: "Reply sent." on a queued send claims a delivery that has not happened.
   * So `confirmed` alone says sent. `queued` first retries ONCE, right here (a transport
   * blip is the common case, and `flushPending` re-dispatches under the SAME
   * Idempotency-Key, so the retry cannot double-deliver); still queued after that, the
   * caller keeps its composer OPEN in a locked queued state — the engine's queue is
   * memory-only, so the text on screen and the queued intent live and die together (an app
   * kill loses both halves at once: nothing sends that the reader was not shown), and the
   * locked Send is what keeps a fresh-key duplicate impossible while the reconnect flush
   * (`connection.tsx`'s drain) keeps retrying the original.
   */
  const sent = async (p: Promise<MutationResult>, sentToast: string): Promise<SendResult> => {
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
        : outcome === "queued" ? Copy.replyQueued
          : outcome === "unverified" ? Copy.replyUnverified
            : Copy.replyFailed,
    );
    return { outcome, ...(outcome === "queued" && first ? { key: first.key } : {}) };
  };

  const sendReply = async (messageId: string, body: string, all: boolean, sig: string | null = null): Promise<SendResult> => {
    const m = messageOf(messageId);
    const text = body.trim();
    // The empty-body refusal is judged BEFORE the signature joins: a signature must never
    // light Send up over an empty message (the webapp composer's own rule).
    if (!m || text === "") return { outcome: "failed" };
    // A plain reply leaves the envelope to `Engine.enrich` (to = the sender, the parent's
    // mailbox, thread and subject); reply-all carries the SAME envelope the sheet offered.
    const env = all ? replyAllRecipients(m, NO_OWN_ADDRESSES) : null;
    return sent(
      engine.mutate(withSignature({
        kind: "mail_send" as const,
        inReplyTo: messageId,
        body: text,
        ...(env ? { to: env.to, cc: env.cc } : {}),
      }, sig)),
      Copy.replySent,
    );
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
    toast(assigned ? Copy.tagTagged(tag.name) : Copy.tagUntagged(tag.name));
    const ok = await watched(engine.mutate({ kind: "tag_assign", messageId, tagId: tag.id, assigned }));
    if (!ok) toast(Copy.liveSaveFailed);
    return ok;
  };

  const tagCreate = async (messageId: string, name: string): Promise<boolean> => {
    const typed = name.trim();
    if (typed === "" || !deps.uuid) return false;
    // Case-insensitive against the whole tag set — the unique index is on `lower(name)`, so
    // "Invoices" beside "invoices" is the existing tag, toggled on, not a 409.
    const existing = liveTags(engine.read()).find((t) => t.name.toLowerCase() === typed.toLowerCase());
    if (existing) return tagToggle(messageId, existing, true);
    toast(Copy.tagTagged(typed));
    const ok = await watched(
      engine.mutate({ kind: "tag_assign", messageId, tagId: deps.uuid(), assigned: true, createName: typed }),
    );
    if (!ok) toast(Copy.liveSaveFailed);
    return ok;
  };

  /**
   * SCREENING FROM THE OPEN MESSAGE — the rule ladder, mirrored from
   * `apps/webapp/app/shell/sender-screening.ts#planScreeningChange` (the reference):
   *
   *   1. a subject still WAITING at the gate is decided with `screener_decide` on its newest
   *      held message — the server promotes the rule inside the decision's own transaction, so
   *      no `rule_create` is written beside it;
   *   2. past the gate, an enabled term-free rule of the SAME kind for exactly this subject that
   *      already points at the destination means nothing to write;
   *   3. one (or several — every one of them, never just the first) pointing somewhere else is
   *      RETARGETED with `rule_update`, not duplicated;
   *   4. otherwise one is written, with `applyRetro` so the server's pass files the whole bag.
   *
   * The moves are the optimistic half — the rows the reader can see move at once, capped at the
   * webapp's `RETRO_VISIBLE_MOVES` (50); the server's pass does the rest. The rule is awaited and
   * reported; the moves are not — they are `move`s, the verb every list uses, and each rolls its
   * own row back. The mutations read the RAW mirror: rules and physical folders are locations.
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
    toast(Copy.liveDecided(destDone(dest), target));
    const ok = await ruled;
    if (!ok) toast(Copy.liveDecideFailed(m.from.address));
    return ok;
  };

  /* ── the folder verbs — see the interface's header for the whole optimism model ─────────── */

  /** One folder command, spoken about ONLY on rollback — success's feedback is the pending row. */
  const folderVerb = async (m: EngineMutation): Promise<boolean> => {
    const ok = await watched(engine.mutate(m));
    if (!ok) toast(Copy.folderVerbFailed);
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
    openMessage, hydrateMessage, hydrateHeld, sweepFeed, leaveFeed, decide, release, setPile,
    pileToggle, resurfaceToggle, resurfaceAt, resurfaceNow, resurfaceDone, markSeen, move,
    deleteMessage, sendReply, sendForward, tagToggle, tagCreate, screenSender,
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
  /** Resolves to the send's result: `sent` closes, `failed` re-arms, `queued` locks the composer. */
  sendReply(messageId: string, body: string, all: boolean, sig?: string | null): Promise<SendResult>;
  sendForward(messageId: string, to: EmailAddress[], body: string, sig?: string | null): Promise<SendResult>;
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
 * ONE actions object for the app's whole life, delegating to whichever backend is CURRENT
 * at call time.
 *
 * The world data is legitimately a new object on every mirror version — that is what makes
 * the screens re-render — but an `actions` object minted inside the same memo made every
 * effect that depends on an action re-fire per version: `useFocusEffect`'s cleanup ran
 * mid-visit (committing the waterline the visit semantics say must hold still) and the
 * message screen's open effect re-dispatched after its own mutation's version bump — a
 * rejected mark-read re-asked in a loop. Identity here is constant by
 * construction; only the delegate moves, and it moves per CALL, never per render.
 */
export function stableActions(current: () => WorldActions): WorldActions {
  return {
    markSeenThrough: (place, ids) => current().markSeenThrough(place, ids),
    leaveFeed: (place) => current().leaveFeed(place),
    openMessage: (id) => current().openMessage(id),
    hydrateMessage: (id) => current().hydrateMessage(id),
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
    sendReply: (id, body, all, sig) => current().sendReply(id, body, all, sig),
    sendForward: (id, to, body, sig) => current().sendForward(id, to, body, sig),
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

/**
 * "Fri 09:00" from an ISO instant, read where the reader is — the webapp's `resurfaceLabel`,
 * so the toast reads back the same wall clock the preset fixed. Not-ISO input echoes through,
 * exactly as the reference does.
 */
export function whenLabel(iso: string, zone: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T/.test(iso)) return iso;
  const d = new Date(iso);
  try {
    const parts = new Intl.DateTimeFormat("en", {
      weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: zone,
    }).formatToParts(d);
    const get = (t: string) => parts.find((x) => x.type === t)?.value ?? "";
    // `hour12:false` may render midnight as "24" on some ICU builds; normalise like the webapp's pad.
    const hour = get("hour") === "24" ? "00" : get("hour");
    return `${get("weekday")} ${hour}:${get("minute")}`;
  } catch {
    return iso;
  }
}

/**
 * HAS THIS MIRROR EVER COMPLETED A DRAIN — the boot-from-local question, answered from the
 * engine's own completion stamp ({@link LAST_DRAIN_AT_META}, written when a drain settles and
 * read back after the store hydrates). This is what separates the two states a zero-row list
 * can be in, which the sync interim-state rule says must never be conflated:
 *
 *  · **settled** — some session finished a drain over this mirror, so zero rows means the
 *    mailbox (or this pile of it) is genuinely empty: the empty state may speak;
 *  · **unsettled** — no drain has ever completed here (a first-ever launch, or a bootstrap
 *    killed before its final page), so zero rows means UNKNOWN: the screen owes the reader
 *    the shape of what is coming (`listSurface`), never "Nothing here".
 *
 * The stamp persists in the mirror, which is exactly why a warm relaunch renders content in
 * its first frame with the network still unasked — `boot-surface.test.ts` pins that the
 * reopened store still answers `true` with no adapter attached. Typed against the one method
 * it reads rather than the store class, so the suite can drive it without a store.
 */
export function mirrorSettled(store: { getMeta<T>(key: string): T | undefined }): boolean {
  return store.getMeta<string>(LAST_DRAIN_AT_META) !== undefined;
}

/**
 * THE STALE LABEL'S TIME, or `null` when no label is owed — the Freshness Contract's middle
 * state (INSTANT-ARCH §6.6), on this surface.
 *
 * `mirrorSettled` above separates unknown from settled (the skeleton rule); this separates
 * settled-and-CURRENT from settled-and-STALE: a mirror whose last completed drain is older
 * than the engine's own threshold renders instantly — the local rows are renderable truth —
 * and the chrome says how old, quietly ("As of Fri 09:00 · catching up"), until a drain
 * settles and the engine's verdict flips back to current. The engine is the ONE derivation
 * (`engine.freshness()`, the same stamp and threshold `freshenStaleResume` reads), so this
 * surface can never disagree with the webapp's strip about what stale means.
 *
 * Formatted HERE, through {@link whenLabel} — the world layer hands the chrome a
 * sentence-ready time in the reader's own zone, never a raw instant to re-derive. Typed
 * against the one method it reads, `mirrorSettled`'s own rule, so the suite drives it with
 * no engine.
 */
export function staleAsOf(
  engine: { freshness(): { state: "unknown" | "stale" | "current"; asOf: string | null } },
  zone: string,
): string | null {
  const f = engine.freshness();
  return f.state === "stale" && f.asOf !== null ? whenLabel(f.asOf, zone) : null;
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
