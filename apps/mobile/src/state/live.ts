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
  type BodyState,
  type EmailAddress,
  type EngineMessage,
  type EngineMutation,
  type EntityReader,
  type FeedView,
  type Folder,
  type MutationResult,
  type OhmailEngine,
  type RuleDTO,
  type ScreenDest,
  type ScreenerSenderDTO,
  type TagDTO,
} from "@ohmail/client-engine";
import { Copy } from "../copy";
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
export function presentedOf(reader: EntityReader, now: Date): EntityReader {
  return presentationReader(reader, consentPartition(reader, { now }));
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
  /** The pile the bar shows as pressed, or the resurface pin the Done slot answers to. */
  pile: WorldPileState;
  /**
   * Whether "Reply all" is offered — `replyAllRecipients(m, ownAddresses) !== null`, the same
   * predicate the webapp bar and its send path resolve, so a 1:1 message offers no second reply.
   */
  canReplyAll: boolean;
  /** `sensitivity.no_forward` — the forward entry is ABSENT on such a message, never dead. */
  noForward: boolean;
  /** The tag ids on this message — what the tag sheet shows as checked. */
  labels: string[];
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

function toMail(reader: EntityReader, m: EngineMessage, v: WorldView): WorldMail {
  const body = bodyOf(reader, m);
  return {
    id: m.id,
    place: placeOfFolder(m.folder),
    folder: m.folder,
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
    canReplyAll: replyAllRecipients(m, NO_OWN_ADDRESSES) !== null,
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
  const pres = presentedOf(engine.read(), v.now);
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
 * One watched dispatch: `rolled_back` or a rejection is a refusal; `queued` is NOT — the
 * mutation is on the retry queue with its Idempotency-Key and the intent stands (the one
 * status where the optimistic view staying applied is truthful).
 */
function watched(p: Promise<MutationResult>): Promise<boolean> {
  return p.then((r) => r.status !== "rolled_back", () => false);
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
  /** Reply (or reply all) — `mail_send` with `inReplyTo`; the engine derives the envelope. */
  sendReply(messageId: string, body: string, all: boolean): Promise<boolean>;
  /** Forward — `mail_send` with `forwardOf`, recipients the USER typed, the user's note as body. */
  sendForward(messageId: string, to: EmailAddress[], body: string): Promise<boolean>;
  /** Put a tag on / take it off — `tag_assign`. */
  tagToggle(messageId: string, tag: WorldTag, assigned: boolean): Promise<boolean>;
  /** Tag-or-create: a name that does not exist yet, minted and put on this message in one act. */
  tagCreate(messageId: string, name: string): Promise<boolean>;
  /**
   * SCREENING from the open message: where THIS SENDER's mail goes — the webapp sender sheet's
   * rule ladder (`sender-screening.ts#planScreeningChange`), in the phone's idiom.
   */
  screenSender(messageId: string, dest: Destination, scope: Scope): Promise<boolean>;
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
    const ok = await watched(engine.mutate({ kind: "mark_seen", messageIds: [id], unread: false }));
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
    // FIRST let the in-flight sweeps settle — their rollbacks edit the pool this commit is
    // about to anchor from, and consuming it earlier re-creates the failed-anchor defect one
    // race over. The pool stays IN the map while we wait, so a
    // rollback's `seen.delete` still reaches it.
    const pending = inflight.get(view);
    if (pending && pending.size > 0) await Promise.allSettled([...pending]);
    const seen = swept.get(view);
    // The visit is over either way: CONSUME the pool so the next visit starts its own.
    swept.delete(view);
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

  const sendReply = async (messageId: string, body: string, all: boolean): Promise<boolean> => {
    const m = messageOf(messageId);
    const text = body.trim();
    if (!m || text === "") return false;
    // A plain reply leaves the envelope to `Engine.enrich` (to = the sender, the parent's
    // mailbox, thread and subject); reply-all carries the SAME envelope the sheet offered.
    const env = all ? replyAllRecipients(m, NO_OWN_ADDRESSES) : null;
    const ok = await watched(
      engine.mutate({
        kind: "mail_send",
        inReplyTo: messageId,
        body: text,
        ...(env ? { to: env.to, cc: env.cc } : {}),
      }),
    );
    toast(ok ? Copy.replySent : Copy.replyFailed);
    return ok;
  };

  const sendForward = async (messageId: string, to: EmailAddress[], body: string): Promise<boolean> => {
    const m = messageOf(messageId);
    // The `no_forward` refusal is client-side courtesy AND server-side law — the sheet never
    // offers the verb on such a message, and this arm refuses it too rather than trusting the UI.
    if (!m || to.length === 0 || m.sensitivity?.no_forward) return false;
    const ok = await watched(
      engine.mutate({
        kind: "mail_send",
        inReplyTo: null,
        forwardOf: messageId,
        subject: forwardSubject(m.subject),
        // The mailbox the original arrived in — the same sender a reply gets from `enrich`.
        // A forward has no parent-derived From of its own, and the send refuses without one.
        mailboxId: m.mailboxId,
        body,
        to,
      }),
    );
    toast(ok ? Copy.forwarded : Copy.replyFailed);
    return ok;
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

  return {
    openMessage, hydrateMessage, hydrateHeld, sweepFeed, leaveFeed, decide, release, setPile,
    pileToggle, resurfaceToggle, resurfaceAt, resurfaceNow, resurfaceDone, markSeen, move,
    sendReply, sendForward, tagToggle, tagCreate, screenSender,
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
  /** Resolves to the send's outcome so the composer can close on success and stay on a refusal. */
  sendReply(messageId: string, body: string, all: boolean): Promise<boolean>;
  sendForward(messageId: string, to: EmailAddress[], body: string): Promise<boolean>;
  tagToggle(messageId: string, tag: WorldTag, assigned: boolean): void;
  tagCreate(messageId: string, name: string): void;
  screenSender(messageId: string, dest: Destination, scope: Scope): void;
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
    sendReply: (id, body, all) => current().sendReply(id, body, all),
    sendForward: (id, to, body) => current().sendForward(id, to, body),
    tagToggle: (id, tag, assigned) => void current().tagToggle(id, tag, assigned),
    tagCreate: (id, name) => void current().tagCreate(id, name),
    screenSender: (id, dest, scope) => void current().screenSender(id, dest, scope),
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

/* Re-exported so the world layer and the suite spell the vocabulary identically. */
export { destDone, isPlace };
export type { Destination, Held, Mail, PileItem, PileKind, Place, Scope };
