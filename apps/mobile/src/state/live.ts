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
 *    their DTOs into the row shapes the prototype screens already render (the screens stay
 *    logic-free, which is the fixtures world's own contract).
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
  CALENDAR_FALLBACK_FILENAME,
  FOLDER_OF_VIEW,
  VIEW_OF_FOLDER,
  bodyOf,
  isCalendarMime,
  consentPartition,
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
  type BodyState,
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
} from "@ohmail/client-engine";
import type { TagId } from "@ohmail/fixtures";
import { Copy } from "../copy";
import type { ConnectionState } from "../net/connection";
import type { ConnectedSession } from "../net/pairing";
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

/* ─────────────────────────────────────────────────────── attachment naming */

/**
 * THE NAME AN ATTACHMENT TILE RENDERS — never an empty label.
 *
 * A calendar invite commonly arrives as a NAMELESS `text/calendar` part (the big providers
 * nest it unnamed under `multipart/alternative`), and the meeting-invite fixtures carry
 * exactly that wire shape (`filename: ""`). Rendering `filename` raw put an empty label on
 * the tile. The fallbacks are the server's own stems for a nameless part
 * (`attachments-service.ts#uniqueName`, mirrored by the engine's `toAttachmentItem`):
 * `CALENDAR_FALLBACK_FILENAME` for a calendar part, `attachment-<id>.bin` for anything else
 * — so the name on the tile is the same name a download or a zip entry would carry, on
 * every client. The live strip's items arrive named already (the engine applies this rule
 * at the wire); this covers the demo world's fixture tiles with the same words.
 */
export function attachmentDisplayName(filename: string, contentType: string | undefined, id: string): string {
  const named = filename.trim();
  if (named) return named;
  return isCalendarMime(contentType ?? "") ? CALENDAR_FALLBACK_FILENAME : `attachment-${id}.bin`;
}

/** The demo world's tile label: the fixture's name, through the same fallback. */
export function attachmentLabelOf(m: Mail): string | null {
  if (!m.attachment) return null;
  return attachmentDisplayName(m.attachment.filename, m.attachment.contentType, m.id);
}

/* ─────────────────────────────────────────────────────────────── the switch */

export type WorldSource = { mode: "demo" } | { mode: "live"; session: ConnectedSession };

/**
 * Which world the screens render. LIVE means exactly `state.k === "live"` — a boot in
 * progress, a refusal and an ended session all render the demo world (the fixtures machine),
 * with the connection's own screens carrying the status sentences. The demo is a MODE,
 * never a fallback that quietly stands in for an account.
 */
export function sourceOf(state: ConnectionState): WorldSource {
  return state.k === "live" ? { mode: "live", session: state.session } : { mode: "demo" };
}

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
 * The screens' row type, unchanged from the demo world, plus the live-only extras:
 * a many-attachments strip (the fixture world carries at most one), and the body's
 * honest state so the reading pane never presents a snippet as the whole mail.
 */
export type WorldMail = Mail & {
  attachments?: WorldAttachment[];
  bodyState?: BodyState;
};

function placeOfFolder(folder: Folder): Place {
  const view = VIEW_OF_FOLDER[folder];
  return view === "reads" || view === "receipts" ? view : "ohbox";
}

function toMail(reader: EntityReader, m: EngineMessage, v: WorldView): WorldMail {
  const body = bodyOf(reader, m);
  return {
    id: m.id,
    place: placeOfFolder(m.folder),
    // The wire's `name` is nullable; the row shape's is not — a nameless sender reads as
    // their address, exactly as every list row already renders one.
    from: { name: m.from.name || m.from.address, address: m.from.address },
    subject: m.subject,
    time: messageDisplayTime(m, v.now, v.zone, v.locale ?? "en"),
    body: body.text,
    bodyState: body.state,
    snippet: m.snippet,
    unread: m.unread,
    ...(m.rationale ? { rationale: m.rationale } : {}),
    ...(m.trackerNote ? { trackerNote: m.trackerNote } : {}),
    ...(m.amount ? { amount: m.amount } : {}),
    ...(m.protected ? { protected: m.protected as Mail["protected"] } : {}),
    earlier: [],
  };
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
 * One Screener row, whichever world minted it. The demo's richer fields (an AI suggestion,
 * spam detection metadata) are OPTIONAL because a derived live row honestly has neither —
 * no classifier runs client-side and `/sync` carries no suggestion (`screenerSegments`).
 */
/**
 * One held message on the sender screen — the demo's shape plus the body's HONEST state.
 * A live derived row's held bodies start as snippets and hydrate; a consent decision taken
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
   * case-folded address) on live rows, the fixture row's own id in the demo (stable there).
   * A detail screen looked up by `id` said "no longer in the Screener" the moment a drain
   * landed newer mail from the very sender on screen.
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

const DEMO_AI_DESTS = new Set<string>(["ohbox", "reads", "receipts", "screened", "spam"]);

function rowOf(dto: ScreenerSenderDTO, scope: Scope | undefined): ScreenerRow {
  const held: ScreenerHeld[] = dto.held.map((h) => ({
    id: h.id,
    subject: h.subject,
    time: h.time,
    body: h.body,
    // The body's honest state travels with the text — absent means `full` (a fixture row
    // carries its bodies verbatim), exactly the DTO's own contract.
    ...(h.bodyState ? { bodyState: h.bodyState } : {}),
    ...(h.trackerNote ? { trackerNote: h.trackerNote } : {}),
    seen: false,
  }));
  const ai =
    dto.ai && !dto.ai.noAnswer && DEMO_AI_DESTS.has(dto.ai.dest)
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

/** The pile blurbs, verbatim from the demo world (`model.ts#initialState`) — one wording. */
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
 * demo's `earlier` shape (`threadOf`, every member rendered in full), and the attachment
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

  return { openMessage, hydrateMessage, hydrateHeld, sweepFeed, leaveFeed, decide, release, setPile };
}

/* ─────────────────────────────────────────────────────── the stable facade */

/** What every mail screen may DO — one vocabulary for both worlds. */
export interface WorldActions {
  /** The scroll-seen sweep (Reads/Receipts). Demo: the model's waterline; live: the wire. */
  markSeenThrough(place: "reads" | "receipts", ids: string[]): void;
  /** Leaving a stream commits the live waterline; the demo world has nothing to commit. */
  leaveFeed(place: "reads" | "receipts"): void;
  /** Opening a message: live marks it read + hydrates; the demo's Ohbox read is non-destructive. */
  openMessage(id: string): void;
  /** An explicit re-ask for one message's full text (a card expand, a reopen). Demo no-op. */
  hydrateMessage(id: string): void;
  /** The sender screen's open: fetch every held body. Demo no-op (fixtures carry theirs). */
  hydrateHeld(ids: string[]): void;
  decide(row: ScreenerRow, dest: Destination, read: boolean): void;
  setScope(row: ScreenerRow, scope: Scope): void;
  /** Allow (screened) / Not spam (spam): release the whole held bag to a place. */
  allow(row: ScreenerRow, dest: Place): void;
  notSpam(row: ScreenerRow, dest: Place): void;
  /** Demo-only: files every waiting sender where the AI suggests. No-op live (no AI rows). */
  applyAllSuggestions(): void;
  addToPile(kind: PileKind, item: PileItem): void;
  /** Demo-only: tags are not yet shown on live accounts. */
  toggleTag(messageId: string, tag: TagId): void;
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
    applyAllSuggestions: () => current().applyAllSuggestions(),
    addToPile: (kind, item) => current().addToPile(kind, item),
    toggleTag: (messageId, tag) => current().toggleTag(messageId, tag),
  };
}

/** Resurface's one offered horizon on the phone: tomorrow, 09:00 local. */
function nextMorning(from: Date): Date {
  const d = new Date(from);
  d.setDate(d.getDate() + 1);
  d.setHours(9, 0, 0, 0);
  return d;
}

/* Re-exported so the world layer and the suite spell the demo/live split identically. */
export { destDone, isPlace };
export type { Destination, Held, Mail, PileItem, PileKind, Place, Scope };
