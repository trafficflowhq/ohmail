import { isSentFolderPath } from "@trafficflow/core/folder-name";
import { mayGroupByMessageId } from "@trafficflow/core/sender-headers";
import type { EntityReader } from "./store.js";
/* The address fold and the own-address predicate, from the leaf that owns both — never
   re-spelled here. A LEAF and not `consent-cutline.ts`: the partition imports this module, so
   taking the predicate from it would close an import cycle. */
import { ownAddressKeys, senderKey } from "./own-address.js";
import { zonedFields } from "./zone.js";
import { daysAgo, messageStamp, named } from "./stamp.js";
import {
  FOLDER_OF_VIEW,
  VIEW_OF_FOLDER,
  waterlineIdOf,
  type EmailAddress,
  type EngineDraft,
  type EngineMessage,
  type FeedView,
  type Folder,
  type MessageBody,
  type MessageBodyRecord,
  type MessageStateDTO,
  type OhmailView,
  type RuleDTO,
  type ScreenerHeldMail,
  type ScreenerSegment,
  type ScreenerSenderDTO,
  type TagDTO,
  type TriageItemDTO,
  type WaterlineMeta,
} from "./types.js";

/**
 * Typed selectors over the mirror — every list, count, and partition the UI
 * renders computes HERE, from local state, with zero network (brief §6).
 * Selectors take an `EntityReader` so they see the engine's optimistic overlay
 * when called through `engine.read()`.
 */

/**
 * THE ROW STAMP, UNDER THE NAME EVERY IMPORTER ALREADY USES.
 *
 * The rule itself moved to `stamp.ts`, which owns every time of day in the product — the bands, the
 * clock and the reason the clock is not `Intl`-formatted are written out there. This alias is what
 * keeps the move invisible to the web app, the phone and the Screener's own DTO minting, all of
 * which import this name from this module.
 */
export const messageDisplayTime = messageStamp;

/** Server list order (contract §5.2): date desc, id desc. */
/**
 * A message's parsed date, cached per ENTITY OBJECT. `Date.parse` per comparison made the
 * comparator itself the cost at scale (a whole-mirror pass is tens of thousands of
 * comparisons, two parses each). Entities are replaced-on-change, never mutated, so object
 * identity is exactly the lifetime a parsed date is valid for — and the WeakMap dies with
 * the entities it keyed.
 */
const parsedDate = new WeakMap<EngineMessage, number>();
function tsOf(m: EngineMessage): number {
  let t = parsedDate.get(m);
  if (t === undefined) {
    t = m.date ? Date.parse(m.date) : 0;
    parsedDate.set(m, t);
  }
  return t;
}

function byDateDesc(a: EngineMessage, b: EngineMessage): number {
  const ta = tsOf(a);
  const tb = tsOf(b);
  if (ta !== tb) return tb - ta;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/** Reading order for a conversation — the exact reverse of `byDateDesc`, undated rows first. */
function byDateAsc(a: EngineMessage, b: EngineMessage): number {
  return -byDateDesc(a, b);
}

// ── Bodies ─────────────────────────────────────────────────────────────────

/**
 * The text a surface renders, and what it actually is — answered once, as a {@link BodyState}
 * (`m.body ?? m.snippet` rendered one line of every Cloud message as though it were the whole
 * thing). A read-time merge, not a write: hydrated text lives in a separate `message_body`
 * record so a `/sync` delta cannot replace it. `m.body` is checked first so the demo never
 * consults a record. Protected mail is not special-cased here (the surface routes
 * `message.protected` through `ProtectedBlock`). `ready` with empty text is still `full` —
 * except `withheld: "storage_cap"`, which reports `state: "withheld"` with the snippet: no
 * Retry, no completeness claim.
 */
export function bodyOf(
  reader: EntityReader,
  m: Pick<EngineMessage, "id" | "snippet"> & { body?: string },
): MessageBody {
  // `html` IS NULL ON EVERY BRANCH BUT ONE, and that is the contract rather than an
  // omission ({@link MessageBody}). The demo's rows carry text and no html; a snippet is not
  // html; and `loading`/`failed` have no body to describe. Only `ready` has a document, so
  // only `ready` may report one — otherwise a surface could render a stale frame underneath
  // a "still loading" line.
  // `unsubscribe`/`unsubscribeUrl` follow the same contract as `html` ({@link MessageBody}): a
  // posture only exists on a hydrated `ready` body, so every other branch reports the honest
  // absence — `"no_header"` (offers no route) and `null` (no link). The demo's rows carry no
  // headers, a snippet has not been fetched, and loading/failed have no body to describe.
  if (m.body !== undefined) {
    return { text: m.body, state: "full", html: null, loadedRemoteContent: false, unsubscribe: "no_header", unsubscribeUrl: null };
  }
  const rec = reader.get<MessageBodyRecord>("message_body", m.id);
  if (!rec) return { text: m.snippet, state: "snippet", html: null, loadedRemoteContent: false, unsubscribe: "no_header", unsubscribeUrl: null };
  if (rec.state === "ready" && rec.withheld != null) {
    // The server answered and the answer is "not holding it" — see the header block. The
    // snippet is the text because it is the only text there is, exactly as loading/failed
    // below; what differs is that this state is TERMINAL and no Retry can change it.
    return {
      text: m.snippet,
      state: "withheld",
      // WHICH policy emptied it (mail 0065 widened the set) — the surface owes each member its
      // own sentence, and a selector that flattened them would make that sentence unwritable.
      withheld: rec.withheld,
      html: null,
      loadedRemoteContent: false,
      unsubscribe: rec.unsubscribe ?? "no_header",
      unsubscribeUrl: rec.unsubscribeUrl ?? null,
    };
  }
  if (rec.state === "ready") {
    return {
      text: rec.text,
      state: "full",
      html: rec.html ?? null,
      loadedRemoteContent: rec.loadedRemoteContent === true,
      unsubscribe: rec.unsubscribe ?? "no_header",
      unsubscribeUrl: rec.unsubscribeUrl ?? null,
    };
  }
  // Loading and failed both keep the snippet on screen — it is the only text there is — and
  // differ in what the surface says about it. Neither may read as "this is the whole mail".
  return {
    text: m.snippet,
    state: rec.state === "loading" ? "loading" : "failed",
    html: null,
    loadedRemoteContent: false,
    unsubscribe: "no_header",
    unsubscribeUrl: null,
  };
}

// ── Conversations ──────────────────────────────────────────────────────────

/**
 * One spelling for a Message-ID — strip one pair of RFC 5322 angle
 * brackets, trim, KEEP the case. The send confirmation's
 * `providerMessageId` is `<id@domain>` while the ingested row's
 * `messageIdHeader` is bracket-stripped, so raw comparison never matched
 * and the optimistic copy was only retired by its TTL. Both sides pass
 * through here first. Case is preserved: `id-left` is a case-sensitive
 * atom. Defined here (re-exported by `mutations.ts`) because `threadOf`'s
 * twin collapse consumes it and the dependency points this way.
 */
export function messageIdKey(raw: string): string {
  const m = raw.match(/<([^>]+)>/);
  return (m ? m[1]! : raw).trim();
}

/**
 * WHICH OF TWO TWINS STANDS — one panel per logical message, and this is the whole ranking.
 *
 * `openId` first: the message the reader actually opened may never be collapsed out of its own
 * pane, whatever else is known about it. Then a REAL row beats a `local: true` one — the
 * optimistic Sent copy is provisional by definition, and it is the twin that renders without an
 * attachment tile (its client-minted id can serve no attachment fetch). Between two real rows
 * the FIRST in reading order stands ({@link byDateAsc}, id tie-break), which is deterministic
 * across renders and devices.
 */
function preferTwin(a: EngineMessage, b: EngineMessage, openId: string): EngineMessage {
  if (a.id === openId) return a;
  if (b.id === openId) return b;
  const aLocal = a.local === true;
  if (aLocal !== (b.local === true)) return aLocal ? b : a;
  return a;
}

/**
 * Collapse the self-send twins — members sharing a `messageIdKey` are one message, one panel. A
 * self-send legitimately doubles: the optimistic Sent copy stands beside the ingested row until
 * the reconcile, and Exchange re-files its own copy of every SMTP submission. The Message-ID is
 * the collapse key; a row with NO header never collapses (absence is not an identity two
 * strangers can share). Reading order is preserved. Only OUR outbound copies collapse ({@link
 * mayGroupByMessageId}): a stranger reusing a known Message-ID must not take the survivor's
 * place — two inbound rows sharing one are two messages and both stand.
 */
/** This row's collapse key, or `null` where its Message-ID may not stand for identity. */
function twinKeyOf(m: EngineMessage): string | null {
  // The engine's own send record, or the server's Sent locator. Neither is a sender's claim.
  const row = { messageIdHeader: m.messageIdHeader, ownOutbound: m.local === true || isOwnSent(m) };
  return mayGroupByMessageId(row) ? messageIdKey(row.messageIdHeader) : null;
}

function collapseTwins(members: EngineMessage[], openId: string): EngineMessage[] {
  const keeper = new Map<string, EngineMessage>();
  for (const m of members) {
    const key = twinKeyOf(m);
    if (key === null) continue;
    const held = keeper.get(key);
    keeper.set(key, held ? preferTwin(held, m, openId) : m);
  }
  return members.filter((m) => {
    const key = twinKeyOf(m);
    return key === null || keeper.get(key) === m;
  });
}

/**
 * The conversation a message belongs to, oldest first — the one place the grouping is computed.
 * The empty array is a contract: no `threadId` and sole-member threads both answer `[]`, so a
 * caller cannot render "1 message" chrome around a message with no conversation (every consumer
 * checks `length > 0`). No folder filter: a conversation legitimately spans folders — a
 * stranger's first mail in `ohmail/Screener`, accepted follow-ups in the Ohbox, and the user's
 * own replies under the server's Sent name (the worker watches Sent now). O(n) over the mirror;
 * never call per row for list badges — that is O(n²).
 */
export function threadOf(reader: EntityReader, messageId: string): EngineMessage[] {
  const self = reader.get<EngineMessage>("message", messageId);
  if (!self?.threadId) return [];
  const members = collapseTwins(
    reader
      .list<EngineMessage>("message")
      .filter((m) => m.threadId === self.threadId)
      .sort(byDateAsc),
    messageId,
  );
  // The >1 contract is judged AFTER the collapse: a thread reduced to one logical message has
  // no conversation, so the pane renders the single open message — one panel, never a twin.
  return members.length > 1 ? members : [];
}

/**
 * One date-desc sort of the whole mirror per (reader, version) — the order
 * every whole-mirror selector shares. Selectors used to each end in their
 * own `.sort(byDateDesc)`, so one mutation's bump paid the same sort about
 * eight times — the dominant term of a scroll-time long task. A `filter` of
 * a sorted array is sorted and {@link byDateDesc} is total, so deriving
 * each slice from one shared order is byte-identical. Keyed weakly on the
 * reader, invalidated by `version()`; callers filter the cached array,
 * never mutate it.
 */
const dateOrderCache = new WeakMap<EntityReader, { v: number; all: EngineMessage[] }>();
export function messagesByDateDesc(reader: EntityReader): readonly EngineMessage[] {
  // A hand-rolled partial reader (several test harnesses build one) may not implement
  // `version()`; without an invalidation key there is nothing safe to cache on, so such a
  // reader gets the plain sort — correct, merely uncached.
  if (typeof reader.version !== "function") {
    return reader.list<EngineMessage>("message").sort(byDateDesc);
  }
  const v = reader.version();
  const hit = dateOrderCache.get(reader);
  if (hit && hit.v === v) return hit.all;
  // `list()` builds a fresh array per call (both stores and the projection), so the in-place
  // sort below touches nothing shared.
  const rows = reader.list<EngineMessage>("message");
  /**
   * The repair path — most bumps do not move the order, so do not pay the
   * sort for them. Read-marks, arriving bodies and label flips change
   * fields on rows whose ids and dates stand, so when membership and every
   * date survive, the new order IS the old order with fresh entities
   * substituted — one pass and a Map. Anything else (arrival, prune, edited
   * date) falls through to the honest sort. Correctness does not depend on
   * classifying the mutation: the repair verifies membership and dates
   * itself, and `date-order-cache.test.ts` pins both fallthroughs.
   */
  let all: EngineMessage[] | null = null;
  if (hit && hit.all.length === rows.length) {
    const byId = new Map<string, EngineMessage>();
    for (const m of rows) byId.set(m.id, m);
    if (byId.size === rows.length) {
      const repaired: EngineMessage[] = new Array(rows.length);
      let ok = true;
      for (let i = 0; i < hit.all.length; i++) {
        const prev = hit.all[i]!;
        const cur = byId.get(prev.id);
        if (cur === undefined || cur.date !== prev.date) {
          ok = false;
          break;
        }
        repaired[i] = cur;
      }
      if (ok) all = repaired;
    }
  }
  all ??= rows.sort(byDateDesc);
  dateOrderCache.set(reader, { v, all });
  return all;
}

export function messagesIn(reader: EntityReader, folder: Folder): EngineMessage[] {
  return messagesByDateDesc(reader).filter((m) => m.folder === folder);
}

/**
 * Which mailbox a fresh compose sends from — the LAST RESORT, not the answer: `compose-from.ts`
 * owns the rule over the account's real mailboxes (fresh compose → oldest connected; reply →
 * the message's own), fed from `GET /mailboxes` through `MailStateProvider`. This is reached
 * only where nothing can name the mailboxes — the Desktop, and a Cloud tab before its first
 * poll — and `Engine.enrich` still falls back to it for a `mail_send` carrying no `mailboxId`.
 * Derived from mail because `/sync` emits no mailbox entity: a seeded `mailbox` row when there
 * is one, else the mailbox of the newest message. `null` ⇒ nothing to send from; refuse.
 */
export function sendingMailboxId(reader: EntityReader): string | null {
  const seeded = reader.list<{ id?: string }>("mailbox")[0]?.id;
  if (typeof seeded === "string" && seeded.length > 0) return seeded;
  const newest = messagesByDateDesc(reader)[0];
  return newest?.mailboxId ?? null;
}

// ── Ohbox: the read-state split (new_for_you / previously_seen, brief §4) ──

export interface OhboxView {
  /**
   * RESURFACED MAIL, PINNED ABOVE EVERYTHING.
   *
   * Bubbled-up mail whose time has come: the worker's {@link bubbleUpPass} flips a due
   * `bubbled_up` state to `resurfaced` (never straight back to `none`), and that is the whole of
   * how a set-aside message earns the top of the Ohbox again. It is a group of its own — not
   * folded into "New for you" — because it is a different claim: not "this arrived", but "you
   * asked to see this again now". Excluded from the two groups below so a resurfaced row is
   * counted and rendered exactly once.
   */
  resurfaced: EngineMessage[];
  newForYou: EngineMessage[];
  previouslySeen: EngineMessage[];
}

/**
 * A message the account itself wrote. Sent mail keeps its arrival folder, so the question is which
 * folder is the Sent folder, asked POSITIVELY of the path: {@link isSentFolderPath} recognises
 * every canonical form the worker's Sent resolver produces — one regex, one home
 * (`@trafficflow/core/types`), the same value the folders inventory excludes. Not
 * `!VIEW_OF_FOLDER[m.folder]`: the passive read mirrors the WHOLE folder tree, so the negative
 * test claimed every filed folder as own-sent and lifted blocks of filed mail into "Earlier".
 * Residual: an unrecognised SPECIAL-USE Sent name is absent from "Earlier" until the resolved path
 * is persisted. These rows land `\Seen` — never "New for you".
 */
export function isOwnSent(m: Pick<EngineMessage, "folder">): boolean {
  return isSentFolderPath(m.folder);
}

/**
 * IS THIS A RESURFACED ROW.
 *
 * A plain-string compare because `resurfaced` is deliberately NOT a member of {@link TriageState}:
 * a resurfaced message belongs to NO bottom pile (it is back at the top of the Ohbox), so
 * {@link triagePiles} must go on ignoring it, and widening the union would invite a `pileOf` arm
 * that files it somewhere. The state exists only on the wire and in the mirror; here it is a fact
 * a row either has or does not.
 */
export function isResurfaced(m: Pick<EngineMessage, "triage">): boolean {
  return (m.triage?.state as string | undefined) === "resurfaced";
}

/**
 * Read state as every surface draws it — a resurfaced message presents UNREAD until done or
 * replied (owner ruling 2026-08-31). A DERIVATION, not a stamp: the stamp was tried
 * (`bubbleUpPass` forced `unread`, queued `\Seen` removals, fought the reader; removed
 * 2026-08-26). Reading the row's placement instead means no pass fights the user, no `\Seen`
 * intent touches other clients (the mailbox stays the master), and a glance still lands its
 * read without visibly flipping the row. Released by anything clearing `triage.state` off
 * `resurfaced`. PRESENTATION ONLY: writes and counts (`markRead`, mark-all-read, "N new",
 * badges) keep reading `m.unread`.
 */
export function presentsUnread(m: Pick<EngineMessage, "unread" | "triage">): boolean {
  return isResurfaced(m) || m.unread;
}

/**
 * Which bottom pile a triage state files into — the ONE answer for the
 * lister and the filter. {@link triagePiles} files rows with it and
 * {@link parkedMessageIds} holds rows out with it; while those were two
 * expressions they gave two answers, and a `bubbled_up` message stood in
 * Resurface AND the Ohbox at once. `resurfaced` answers `null`
 * deliberately: a resurfaced row belongs to no bottom pile — it is back at
 * the top of the Ohbox — so it is not parked; `muted` and `none` answer
 * `null` because no pile renders them.
 */
export function pileOfState(
  state: string,
): "replyLater" | "setAside" | "resurface" | null {
  return state === "reply_later" ? "replyLater"
    : state === "set_aside" ? "setAside"
      : state === "bubbled_up" ? "resurface"
        : null;
}

/**
 * The winning `message_state` claim per message. The mirror can briefly
 * hold TWO records for one message under different record ids: the server
 * keys by the `message_states` row uuid while an optimistic effect keys by
 * the message id — a drain landing the settled row beside the overlay made
 * a pile count one message twice (6-vs-1 measured live). The message is the
 * unit a pile is about, so it is the dedup key; the newest `updatedAt`
 * wins, ties keep the later-listed record (user-always-wins). Extracted so
 * {@link triagePiles} and {@link parkedMessageIds} cannot disagree.
 */
export function winningStates(reader: EntityReader): Map<string, MessageStateDTO> {
  const claimOf = new Map<string, MessageStateDTO>();
  for (const st of reader.list<MessageStateDTO>("message_state")) {
    const held = claimOf.get(st.messageId);
    if (held && Date.parse(held.updatedAt) > Date.parse(st.updatedAt)) continue;
    claimOf.set(st.messageId, st);
  }
  return claimOf;
}

/**
 * Every message parked in a bottom pile — the set the Ohbox holds out of all three groups. It
 * used to hold out only resurfaced rows: `triagePiles` files from the `message_state` record,
 * `ohboxView` grouped by folder and knew nothing of it, and nothing moves a parked message's
 * folder — so every parked row stood in a pile AND the Ohbox (deferring an already-resurfaced
 * row put it bold at the top of "New for you" while listed under Resurface). Derived via {@link
 * winningStates} → {@link pileOfState}, the same two steps the lister takes, so filter and
 * lister are one derivation and cannot drift.
 */
export function parkedMessageIds(reader: EntityReader): Set<string> {
  const parked = new Set<string>();
  for (const [messageId, st] of winningStates(reader)) {
    if (pileOfState(st.state)) parked.add(messageId);
  }
  return parked;
}

/**
 * "Earlier" is a history of reading, so it is ordered by reading — a date
 * sort files the message you finished with a minute ago under mail finished
 * days ago. Every unstamped row sorts below every stamped one: `lastReadAt`
 * is absent on mail read before the field existed or dated by nothing, and
 * interleaving those BY DATE would make a claim about reading order out of
 * a send time. Two blocks: known, most recently finished first; then
 * unknown, newest first — the boundary moves down on its own as mail is
 * re-read. `id` breaks remaining ties so equal-instant batches cannot reorder per render.
 */
/**
 * The reading instant as a number, or `null` for "not known". Absent, explicitly `null`, and
 * unparseable all mean the same thing to a reader, so they must mean the same thing to the sort
 * — normalising here stops an unparseable stamp ranking as real or reading as the epoch.
 * Own-sent mail is stamped by its SEND time, and that is a reading time: writing a message is
 * finishing with it — without this every sent message was unstamped and sorted below everything
 * ever opened, so a just-sent message was hundreds of rows down. A real stamp still wins over
 * the date, or re-reading your own sent mail could not move it.
 */
function readTimeOf(m: EngineMessage): number | null {
  const raw = m.lastReadAt ?? null;
  if (raw === null) {
    if (!isOwnSent(m) || m.date === null) return null;
    const sent = Date.parse(m.date);
    return Number.isNaN(sent) ? null : sent;
  }
  const t = Date.parse(raw);
  return Number.isNaN(t) ? null : t;
}

function byLastReadDesc(a: EngineMessage, b: EngineMessage): number {
  const ta = readTimeOf(a);
  const tb = readTimeOf(b);
  if (ta === null || tb === null) {
    // Not both known: a stamped row always outranks an unstamped one. Both unstamped falls
    // through to the date order they had before this field existed.
    if (ta !== tb) return ta === null ? 1 : -1;
    return byDateDesc(a, b);
  }
  if (ta !== tb) return tb - ta;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/**
 * A mail is in exactly one pile — these three groups plus the three bottom
 * piles are the six. Every group holds out {@link parkedMessageIds}, so
 * filed mail is absent from all of them: putting a message away takes it
 * out of the Ohbox, "Earlier" included; the pile it went to is the only
 * place it is. Scope: this is the only surface that holds parked rows out —
 * Reads and Receipts are streams and still list a parked issue;
 * `openTargetFor` depends on that asymmetry and `search-locate.test.ts`
 * pins it.
 */
export function ohboxView(reader: EntityReader): OhboxView {
  // The shared date-desc order (`messagesByDateDesc`): a filter of it is newest-first by
  // construction, so the groups below carry no sorts of their own any more.
  const all = messagesByDateDesc(reader);
  const inbox = messagesIn(reader, FOLDER_OF_VIEW.ohbox);
  /**
   * The account's own sent mail, folder-agnostic ({@link isOwnSent}), newest first — MINUS the
   * replies the away responder sent on the person's behalf. Writing a message is finishing with
   * it, which is why own-sent mail joins this block at all; an automatic reply is the case
   * where that reasoning fails — nobody finished with anything — and the send-date fallback put
   * one "Re: …" row per answered message at the top. `!== true`, never `=== false`: the field
   * is absent on older mirrors/servers and absent must mean "the person's". Nothing is hidden;
   * the replies stay in the Sent folder view.
   */
  const sent = all.filter((m) => isOwnSent(m) && m.autoReplyByUs !== true);

  /**
   * The pin is state-driven and folder-agnostic — the whole mirror is
   * scanned, not just the INBOX slice above. `resurfaced` is a claim the
   * user made, and this group is its only home in the product
   * (`triagePiles` ignores it), so a resurfaced row this group declines is
   * a row NO view files — a real orphan, measured: a snooze come due left
   * the Resurface pile and a folder-filtered pin never picked it up,
   * reachable only by search. Newest bubble first — the order the groups
   * below use for anything with no reading time.
   */
  const resurfaced = all.filter(isResurfaced);
  const pinned = new Set(resurfaced.map((m) => m.id));

  /**
   * Mail the user put away is not in the Ohbox — the whole of
   * {@link parkedMessageIds}, applied to all three groups, the pin group
   * included. That is not redundancy: `pileOfState("resurfaced")` is null,
   * so a genuine resurface is never in the set — but a row carrying a stale
   * `resurfaced` projection while its winning record says `bubbled_up`
   * would otherwise stand in the pile AND at the pin. Holding the parked
   * set out of every group makes the bottom piles authoritative wherever
   * the two sources could disagree.
   */
  const parked = parkedMessageIds(reader);
  const held = (m: EngineMessage): boolean => !pinned.has(m.id) && !parked.has(m.id);

  return {
    resurfaced: resurfaced.filter((m) => !parked.has(m.id)),
    // Unread mail is ordered by ARRIVAL, unchanged: nothing has been read, so there is no reading
    // order to use and the question the group answers is what came in. Resurfaced rows are held
    // out — they sit pinned above, never doubled here.
    newForYou: inbox.filter((m) => m.unread && held(m)),
    // "Earlier" is read INBOX mail joined by the account's own sent mail,
    // ordered by when the reader finished with each — for a sent row that
    // is its SEND time (`readTimeOf`), so a just-sent message is first.
    // Pinned ids are held out of BOTH inputs. Collapsed by Message-ID for
    // the reading pane's reason ({@link collapseTwins}): the optimistic
    // Sent copy stands beside the ingested row until the END of a drain,
    // and Exchange re-files its own SMTP copies — the pane collapsed this,
    // the pile did not. No `openId`: a pile has no open message; a real row
    // beats a `local: true` one, then reading order.
    previouslySeen: collapseTwins(
      [
        ...inbox.filter((m) => !m.unread && held(m)),
        ...sent.filter(held),
      ],
      "",
    ).sort(byLastReadDesc),
  };
}

/** How many participant circles a row shows at most — three overlapping avatars. */
export const THREAD_PARTICIPANTS_MAX = 3;

/**
 * The people in a conversation, newest voice first. Distinct from
 * {@link threadOf} (the messages): this returns the SENDERS, deduplicated
 * by address, so a ten-mail exchange between two people yields two circles,
 * and the account holder is a voice wherever they have written. Capped at
 * {@link THREAD_PARTICIPANTS_MAX} — the row holds a constant-width slot.
 * `[]` for no thread or a sole member, the same "no conversation here"
 * contract as {@link threadOf}. O(mirror) per call; the Ohbox asks only
 * for mounted rows carrying a `threadId`.
 */
export function threadParticipants(reader: EntityReader, threadId: string): EmailAddress[] {
  return participantsOfMembers(
    reader.list<EngineMessage>("message").filter((m) => m.threadId === threadId),
  );
}

/**
 * Every thread's people in one pass — the same answer as
 * {@link threadParticipants}, for callers that need many: per-row calls are
 * O(mirror × rows), this walks the messages once and answers every thread
 * at the cost of one; memoize on the engine version and read the map.
 * Threads with no conversation of people are ABSENT rather than `[]`, so a
 * missing key and an empty answer are the same thing. Both forms share
 * {@link participantsOfMembers} — two implementations would be two answers,
 * and the one drawn would depend on which surface asked.
 */
export function threadParticipantsIndex(reader: EntityReader): Map<string, EmailAddress[]> {
  const byThread = new Map<string, EngineMessage[]>();
  for (const m of reader.list<EngineMessage>("message")) {
    if (!m.threadId) continue;
    const members = byThread.get(m.threadId);
    if (members) members.push(m);
    else byThread.set(m.threadId, [m]);
  }
  const out = new Map<string, EmailAddress[]>();
  for (const [threadId, members] of byThread) {
    const people = participantsOfMembers(members);
    if (people.length > 0) out.set(threadId, people);
  }
  return out;
}

/** The shared core of both forms above: a thread's members in, its distinct senders out. */
function participantsOfMembers(members: EngineMessage[]): EmailAddress[] {
  if (members.length <= 1) return [];
  const sorted = members.slice().sort(byDateDesc);
  const seen = new Set<string>();
  const out: EmailAddress[] = [];
  for (const m of sorted) {
    const key = senderKey(m.from.address);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(m.from);
    if (out.length >= THREAD_PARTICIPANTS_MAX) break;
  }
  // A single distinct sender is not a conversation of people — the numeric badge says more than
  // one lone circle would, so leave that to the caller by answering "no participants".
  return out.length > 1 ? out : [];
}

/**
 * The conversation's name — the mirror's thread row's stored subject, or
 * `null` while no thread row for this id has synced. The server names a
 * thread at CREATE with localized reply/forward prefixes stripped
 * (`baseSubject`, `packages/core`) and healed the earlier rows, so the
 * stored name is clean and the client does NOT re-derive it — a second
 * prefix table would drift. `null` is a real state: snapshot pages carry
 * their own messages' threads, so a thread row can be a page behind; the
 * caller falls back to a member's subject.
 */
export function threadSubject(reader: EntityReader, threadId: string): string | null {
  const t = reader.get<{ subject?: unknown }>("thread", threadId);
  const s = t?.subject;
  return typeof s === "string" && s.trim() !== "" ? s : null;
}

// ── The streams: the waterline partition ───────────────────────────────────

export interface FeedPartition {
  waterline: WaterlineMeta | null;
  /** Arrived since the last visit — everything strictly ABOVE the waterline anchor. */
  fresh: EngineMessage[];
  /** At and below the anchor — the anchor was on screen when the reader last left. */
  seen: EngineMessage[];
  /**
   * The stream's badge — one number, one derivation, every surface: `fresh` that is STILL
   * UNREAD. Not `fresh.length`: the anchor is per-device client state, and two devices with
   * different lines reported "Reads 13" beside a silent desktop over a pile the server held
   * zero unread in. The mailbox is the master: the badge is the intersection — above this
   * device's line AND unread on the server — and the LINE itself stays put (R10-5: a committed
   * waterline outranks `\Seen`). Not "every unread row in the pile" either — that was the
   * phone's answer, and old unread mail below the line was on screen when you left; the count
   * respects it.
   */
  newCount: number;
}

/**
 * One partition for both reading streams, around the view's own waterline row (`waterlineIdOf` — the
 * same mapping the `feed_mark_seen` effect writes through). The cut is EXCLUSIVE: `newestSeenId` was
 * on screen at the last leave, so it belongs below the line; a leave at the top yields `fresh: []`.
 * Without a usable anchor, `\Seen` from the mailbox is the line: both absences (no first commit yet;
 * a deleted anchor row) used to degrade to everything-fresh, presenting years of read mail as new.
 * The fallback junction is the newest already-read message; a pile with no read mail stays
 * everything-fresh. The cut is positional, so `[...fresh, ...seen]` is always display order —
 * receipts arithmetic counts on it.
 */
export function feedPartition(reader: EntityReader, view: FeedView): FeedPartition {
  const all = messagesIn(reader, FOLDER_OF_VIEW[view]);
  const waterline = reader.get<WaterlineMeta>("view_meta", waterlineIdOf(view)) ?? null;
  const anchor = waterline ? all.findIndex((m) => m.id === waterline.newestSeenId) : -1;
  const idx = anchor >= 0 ? anchor : all.findIndex((m) => !m.unread);
  const cut = idx < 0
    ? { fresh: all, seen: [] as EngineMessage[] }
    : { fresh: all.slice(0, idx), seen: all.slice(idx) };
  return { waterline, ...cut, newCount: cut.fresh.filter((m) => m.unread).length };
}

export function readsPartition(reader: EntityReader): FeedPartition {
  return feedPartition(reader, "reads");
}

// ── Receipts: grouped by day ───────────────────────────────────────────────

export interface ReceiptsDayGroup {
  label: string;
  items: EngineMessage[];
}

/**
 * "Today" / "Thursday" / "2 Aug" — and their equivalents in the caller's language.
 *
 * `Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(0, "day")` is what gives the first
 * of the three: it is the platform's own word for the current day ("today", "heute"), which is
 * better than a catalogue entry here for the reason the whole of {@link named} is — this package
 * has no catalogue, and inventing one for one word would give it an i18n dependency. It answers
 * lower case in both languages, so the first letter is raised to match the weekday and date labels
 * beside it, which `Intl` capitalises itself.
 */
function dayLabel(date: Date, now: Date, locale: string, zone: string): string {
  const ageDays = daysAgo(date, now, zone);
  if (ageDays === 0) {
    const today = new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(0, "day");
    return today.charAt(0).toUpperCase() + today.slice(1);
  }
  if (ageDays <= 6) return named(locale, { weekday: "long" }, date, zone);
  return `${zonedFields(date, zone).day} ${named(locale, { month: "short" }, date, zone)}`;
}

/**
 * `zone` and `locale` both default, and unlike {@link messageDisplayTime} that is deliberate: the
 * grouping this returns is the ORDER Receipts renders in, and the flattening call site discards the
 * labels (`AppShell` — "the selector's `label` is no longer rendered anywhere"). Ordering is a
 * property of the sort, not of the zone. The defaults keep this package's own tests asserting the
 * UTC groupings they were written against; a caller that puts these labels on screen passes the
 * reader's zone, exactly as `screener-state.ts` does for the Screener's stamps.
 */
export function receiptsByDay(
  reader: EntityReader, now: Date,
  /** Which language the day headings are named in. English by default — see {@link named}. */
  locale = "en",
  /** Which zone the day boundaries fall in. */
  zone = "UTC",
): ReceiptsDayGroup[] {
  const groups: ReceiptsDayGroup[] = [];
  for (const m of messagesIn(reader, FOLDER_OF_VIEW.receipts)) {
    const label = dayLabel(m.date ? new Date(m.date) : now, now, locale, zone);
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.items.push(m);
    else groups.push({ label, items: [m] });
  }
  return groups;
}

// ── Screener segments ──────────────────────────────────────────────────────

export interface ScreenerSegments {
  waiting: ScreenerSenderDTO[];
  screenedOut: ScreenerSenderDTO[];
  spam: ScreenerSenderDTO[];
}

/**
 * The three Screener segments, as VIEWS over folders (brief §4) — never as folders.
 * `VIEW_OF_FOLDER` turns a message's folder into a view; this turns the three
 * Screener-ish views into the segment the UI renders them in.
 */
const SEGMENT_OF_VIEW: Partial<Record<OhmailView, ScreenerSegment>> = {
  screener: "waiting",
  screened: "screened_out",
  spam: "spam",
};

/* DEFINED in `own-address.ts`, re-exported here under the name every importer already uses
   (`mutations.ts`, `consent-cutline.ts`, the barrel, the web app, the phone). */
export { senderKey };

/**
 * One held message, with its body RESOLVED rather than degraded.
 *
 * This used to be `body: m.body ?? m.snippet` with a comment calling the snippet a stated
 * degradation. It was stated, and it was also the thing that made `ScreenerSenderDTO.held`'s
 * own promise — "every held message, in full" — false on every live account: the preview a
 * consent decision is taken on showed one line. `bodyOf` returns the hydrated text once
 * `hydrateBody` has run for this id, and `bodyState` tells the preview which of the four
 * situations it is in so it can never present a truncation as the mail.
 */
function heldOf(
  reader: EntityReader, m: EngineMessage, now: Date, locale: string, zone: string,
): ScreenerHeldMail {
  const body = bodyOf(reader, m);
  return {
    id: m.id,
    subject: m.subject,
    time: messageDisplayTime(m, now, zone, locale),
    body: body.text,
    bodyState: body.state,
    // Carried so the preview can render the mail the way the reading pane does. `bodyOf`
    // reports `html` only on a hydrated `ready` body, so this is null until `hydrateBody`
    // has run — a consent decision is never rendered against a stale frame under a snippet.
    html: body.html,
    loadedRemoteContent: body.loadedRemoteContent,
    // The unsubscribe posture rides the body the preview already hydrates on selection — so the
    // screened-out / spam previews can offer a way out with zero extra requests. `no_header`
    // until the body is `full`, exactly like `html`.
    unsubscribe: body.unsubscribe,
    unsubscribeUrl: body.unsubscribeUrl,
    ...(m.trackerNote ? { trackerNote: m.trackerNote } : {}),
  };
}

/**
 * THE SCREENER, DERIVED FROM THE MESSAGE MIRROR.
 *
 * `screener_sender` is a client-local entity: `/sync`'s vocabulary never carried it
 * (`change-log.ts`), so before this the Screener was structurally empty on every Cloud
 * account while its mail sat in `ohmail/Screener`. It is not promoted onto the wire,
 * because the server's own queue is ALREADY a derivation — "DERIVED (no separate
 * table)", `screener-service.ts:88-92`: one entry per distinct sender, the latest
 * message representing it. Grouping the mirror the same way reproduces that queue with
 * no new wire entity to keep in lockstep with every folder move.
 *
 * The row `id` is therefore the REPRESENTATIVE MESSAGE id, which is precisely what
 * `POST /screener/:id` resolves (`screener-service.ts:144` — `rows.find(r =>
 * r.messageId === id)`). A derived row speaks the existing protocol unchanged.
 *
 * FIXTURE PRECEDENCE: `screener_sender` rows win per sender key. A Cloud account has
 * none, so it sees pure derivation; the demo world keeps its richer DTOs (AI
 * suggestions, full bodies, spam detection metadata) exactly as before.
 *
 * NO-COLLAPSE: `held` enumerates EVERY message the sender has in that
 * folder — there is no count standing in for mail nobody can open.
 *
 * ── A WAITING ROW'S REPRESENTATIVE, AND THE FLAG THAT SAYS WHERE IT REALLY IS ─────────────
 *
 * When this runs over a PROJECTED reader (`presentationReader`), the waiting bucket also holds
 * mail that is physically in the INBOX: `consentPartition` presents an active undecided sender's
 * INBOX mail in the Screener, because a decision about that sender is genuinely wanted. Grouping
 * is right to include it, and the ROW MUST STILL BE MINTED — but where its id comes from decides
 * how the decision is carried out.
 *
 * The id is the message `POST /screener/:id` resolves, and both ends of that call require the
 * message to be physically at the gate. `heldRowById` inherits `desired_folder = 'ohmail/Screener'`,
 * so an INBOX message id is a 404 on the wire; and `derivedScreenerEffects` refuses locally for
 * the same reason (`mutations.ts` — `rep.folder !== FOLDER_OF_VIEW.screener` ⇒ no effects). So the
 * rep is the newest GATE-PHYSICAL message when the sender has any; otherwise `newestFirst[0]`, an
 * INBOX message, and the row is marked `gatePhysical:false`.
 *
 * That flag is what keeps the row from "renders every control and performs none": the commit path
 * (`screener-state.ts`) reads it — actually, re-reads the raw mirror — and routes a `gatePhysical:false`
 * decision PAST THE GATE as a `rule_create` (destination INBOX for a screen-in) with `applyRetro`,
 * so once the rule lands the sender's whole bag presents in the Ohbox with zero server moves. This
 * is why the earlier gap — "a sender whose mail is ONLY in the INBOX is reachable only by search" —
 * is now closed on the client, with no change to the gate's `desired_folder` predicate at the server.
 *
 * `held` still carries the sender's whole bag including their INBOX mail — those ids feed
 * `mark_seen` and `move`, which resolve against the engine's own store by id and never read a
 * folder off this reader.
 *
 * Inert over a raw mirror, which is why `screener-derived.test.ts` is untouched: without a
 * projection every waiting-bucket message already has `folder === 'ohmail/Screener'` and
 * `physicalFolder` is unset, so the gate-physical rep IS `newestFirst[0]` and `gatePhysical` is
 * true — the rep does not move and no past-the-gate branch is reached.
 */
export function screenerSegments(
  reader: EntityReader, now: Date = new Date(),
  /** Which language the derived rows' stamps are named in. English by default — see {@link named}. */
  locale = "en",
  /**
   * Which zone those stamps are read in. Defaults to UTC for the reason {@link receiptsByDay}'s
   * does — this package's own tests assert UTC stamps and there is no reader here to ask. The web
   * app passes the reader's zone at the one call site that renders these rows
   * (`app/shell/screener-state.ts`); `unreadCounts` below does not, and does not need to, because
   * it reads `.length` and never a stamp.
   */
  zone = "UTC",
  /**
   * THE ACCOUNT'S OWN ADDRESSES — the same list the partition was given
   * ({@link ConsentOptions.ownAddresses}), read through the same predicate.
   *
   * Own mail is never a WAITING row wherever it sits. `consentPartition` keeps such a row in its
   * own place, so a message physically in `ohmail/Screener` used to group into the queue and ask
   * the account to screen itself while the partition counted no undecided sender behind it.
   * Absent ⇒ the mirror's `mailbox` rows, the partition's own fallback; `[]` ⇒ nobody.
   */
  ownAddresses?: Iterable<string>,
): ScreenerSegments {
  const own = ownAddressKeys(reader, ownAddresses === undefined ? {} : { ownAddresses });
  const grouped: Record<ScreenerSegment, Map<string, EngineMessage[]>> = {
    waiting: new Map(),
    screened_out: new Map(),
    spam: new Map(),
  };

  for (const m of reader.list<EngineMessage>("message")) {
    const view = VIEW_OF_FOLDER[m.folder] as OhmailView | undefined;
    const segment = view ? SEGMENT_OF_VIEW[view] : undefined;
    if (!segment) continue;
    const key = senderKey(m.from.address);
    // The account is not one of its own correspondents, so own mail mints no waiting row — the
    // guard the partition applies to its reckoning, applied to the grouping that renders it.
    // Screened and Quarantine are explicit placements somebody made and keep their rows.
    if (segment === "waiting" && own.has(key)) continue;
    const bucket = grouped[segment].get(key);
    if (bucket) bucket.push(m);
    else grouped[segment].set(key, [m]);
  }

  const out: Record<ScreenerSegment, Map<string, ScreenerSenderDTO>> = {
    waiting: new Map(),
    screened_out: new Map(),
    spam: new Map(),
  };

  for (const segment of ["waiting", "screened_out", "spam"] as const) {
    const rows: Array<{ key: string; rep: EngineMessage; dto: ScreenerSenderDTO }> = [];
    for (const [key, bucket] of grouped[segment]) {
      const newestFirst = [...bucket].sort(byDateDesc);
      // See the header. A WAITING row's id should be a message the gate can resolve, so the rep
      // is the sender's newest GATE-PHYSICAL mail when they have any. When they have none — an
      // active-undecided sender whose mail is all in the INBOX, PRESENTED here by the cutline —
      // the row is STILL minted, on `newestFirst[0]`, and marked `gatePhysical:false` so the
      // commit path routes it past the gate (a rule) rather than a decide that 404s. No longer
      // suppressed: the sender is decidable rather than findable only by search.
      const gateRep = newestFirst.find((m) => (m.physicalFolder ?? m.folder) === FOLDER_OF_VIEW.screener);
      const rep = segment === "waiting" ? (gateRep ?? newestFirst[0]) : newestFirst[0];
      if (!rep) continue;
      const gatePhysical = (rep.physicalFolder ?? rep.folder) === FOLDER_OF_VIEW.screener;
      const name = rep.from.name || rep.from.address;
      const repDate = rep.date ? new Date(rep.date) : null;
      rows.push({
        key,
        rep,
        dto: {
          id: rep.id,
          segment,
          from: rep.from,
          initial: (name.trim()[0] ?? "?").toUpperCase(),
          time: messageDisplayTime(rep, now, zone, locale),
          scope: "sender",
          // DEGRADATION: no classifier runs client-side and `/sync` carries no
          // suggestion, so a derived row has none. `GET /screener` still returns
          // `aiSuggestion` for desktop/native and for enrichment later.
          ai: null,
          // Oldest first — the order every preview renders, and ALL of them.
          held: [...newestFirst].reverse().map((m) => heldOf(reader, m, now, locale, zone)),
          ...(segment === "screened_out" && repDate
            ? {
                screenedOn:
                  `${zonedFields(repDate, zone).day} ` +
                  `${named(locale, { month: "short" }, repDate, zone)}`,
              }
            : {}),
          derived: true,
          gatePhysical,
          updatedAt: rep.updatedAt,
        },
      });
    }
    // Newest sender first — the same order `messagesIn` gives every other list.
    rows.sort((a, b) => byDateDesc(a.rep, b.rep));
    for (const r of rows) out[segment].set(r.key, r.dto);
  }

  // Fixtures win per sender key. `Map.set` on an existing key keeps its position, so a
  // demo row substitutes in place rather than jumping to the end of the segment.
  for (const s of reader.list<ScreenerSenderDTO>("screener_sender")) {
    const bucket = out[s.segment];
    if (!bucket) continue;
    bucket.set(senderKey(s.from.address), s);
  }

  return {
    waiting: [...out.waiting.values()],
    screenedOut: [...out.screened_out.values()],
    spam: [...out.spam.values()],
  };
}

// ── Triage piles ───────────────────────────────────────────────────────────

export interface TriagePileEntry {
  messageId?: string;
  title: string;
  subtitle?: string;
  preview?: string;
  resurfaceAt?: string;
}

export interface TriagePiles {
  replyLater: TriagePileEntry[];
  setAside: TriagePileEntry[];
  resurface: TriagePileEntry[];
}

/**
 * The bottom piles: `message_state` entities joined to their messages, merged
 * with fixture-only `triage_item` entries (demo entries with no backing message).
 *
 * ONE MESSAGE, ONE CLAIM — the records are deduped by MESSAGE id first, in
 * {@link winningStates}, which states why (two record-id spellings of one fact, and a rail badge
 * measured at 6-vs-1 against the pile beside it).
 *
 * WHICH PILE a claim joins is {@link pileOfState}, and that indirection is load-bearing:
 * {@link parkedMessageIds} asks the same function which rows the Ohbox must hold out, so a
 * message this lists in a bottom pile cannot also be listed in an Ohbox group.
 */
export function triagePiles(reader: EntityReader): TriagePiles {
  const piles: TriagePiles = { replyLater: [], setAside: [], resurface: [] };
  // THE SAME TWO STEPS `parkedMessageIds` TAKES — `winningStates` then `pileOfState`. A row this
  // files into a pile is a row `ohboxView` holds out, because both read this one derivation
  // rather than each spelling it themselves. See `pileOfState` for what the two spellings cost.
  const pileOf = (state: string): TriagePileEntry[] | null => {
    const name = pileOfState(state);
    return name ? piles[name] : null;
  };

  for (const st of winningStates(reader).values()) {
    const pile = pileOf(st.state);
    if (!pile) continue;
    const msg = reader.get<EngineMessage>("message", st.messageId);
    pile.push({
      messageId: st.messageId,
      title: msg?.from.name || msg?.from.address || st.messageId,
      ...(msg?.subject ? { subtitle: msg.subject } : {}),
      ...(msg?.snippet ? { preview: msg.snippet } : {}),
      ...(st.bubbleUpAt ? { resurfaceAt: st.bubbleUpAt } : {}),
    });
  }
  for (const item of reader.list<TriageItemDTO>("triage_item")) {
    const pile = pileOf(item.pile);
    if (!pile) continue;
    pile.push({
      title: item.title,
      ...(item.subtitle ? { subtitle: item.subtitle } : {}),
      ...(item.preview ? { preview: item.preview } : {}),
      ...(item.resurfaceAt ? { resurfaceAt: item.resurfaceAt } : {}),
    });
  }
  return piles;
}

// ── Tags cross-view ────────────────────────────────────────────────────────

export interface TagGroup {
  tag: TagDTO;
  messages: EngineMessage[];
}

/** Tags cut ACROSS folders: one group per tag, with every labeled message — newest first via
 *  the shared order (`messagesByDateDesc`), where this used to sort once PER TAG. */
export function tagsCrossView(reader: EntityReader): TagGroup[] {
  const messages = messagesByDateDesc(reader);
  return reader.list<TagDTO>("tag").map((tag) => ({
    tag,
    messages: messages.filter((m) => m.labels.includes(tag.id)),
  }));
}

// ── Rules: the consent gate's memory ───────────────────────────────────────

/**
 * EVERY ROUTING RULE THIS ACCOUNT HAS, NEWEST FIRST.
 *
 * The Screener writes a `rules` row on every decision — `POST /screener/:id` creates one
 * per yes/no (`screener-service.ts:364`), and the DecisionBar, "apply to all", "mark all
 * spam" and the sender menu all reach that endpoint — so a product whose thesis is a
 * consent gate accumulates these faster than any other entity the user did not ask for.
 * Until this selector existed nothing in any client read them: `rule` has been an entity type
 * in the change log since the first release and a
 * `SyncEntityType` here, the mirror has been storing them all along, and `/rules` had zero
 * references across the whole web app.
 *
 * ── WHY THE MIRROR AND NOT `GET /rules` ────────────────────────────────────────────────
 *
 * The same argument `sendingMailboxId` makes about mailboxes, with the opposite outcome,
 * and the difference is worth stating because it is the reason this one is a selector at
 * all. A mailbox is NOT an entity type in the change log, so `/sync` can never send one and
 * a Cloud surface has to reach the Cloud client's API layer — which the shared shell may not
 * import, because that layer is not part of the Desktop bundle. A rule IS one. The server
 * replays it from `change_log` like any other entity, the webapp passes no
 * `types` filter so the drain carries every type, and nothing prunes `change_log` —
 * `minRetainedSeq` only READS the minimum — so a bootstrap re-materializes rules created
 * long before this client existed. Reading the mirror therefore costs no request, works
 * offline, and shows the optimistic overlay: a rule the user has just revoked is gone from
 * this list before the wire has answered.
 *
 * ── NEWEST FIRST, AND WHY THAT IS THE ORDER ────────────────────────────────────────────
 *
 * `RulesService.list` orders by `id` — a random uuid, i.e. no order at all to a reader.
 * The rule a user wants to inspect or undo is overwhelmingly the one they just caused, and
 * on this surface every row was caused by an act they may not have realised was a rule. So
 * recency, with the id as a deterministic tie-break for rules minted inside the same
 * `createdAt` resolution (a bulk "apply to all" mints several at once).
 *
 * ── WHAT IS DELIBERATELY NOT COMPUTED HERE ─────────────────────────────────────────────
 *
 * "How many messages has this rule filed?" `RuleDTO.stats` carries `hits`, `lastHitAt` and
 * `demotions`, and NOTHING ANYWHERE EVER WRITES THEM — the columns exist, the server
 * faithfully reports them, and every one of them is still the `default(0)` / `null` it was
 * inserted with. Surfacing that as a count would put "0 messages" beside a rule that has
 * silently filed three thousand. The surface says the count is not recorded instead; see
 * `RulesView`.
 *
 * A count of mirror messages CURRENTLY sitting in the rule's destination would be
 * computable and is also refused, for a second reason: it reads as "these will move back",
 * which is exactly the false promise revocation must not make.
 */
export function rulesList(reader: EntityReader): RuleDTO[] {
  return reader.list<RuleDTO>("rule").sort((a, b) => {
    const ta = a.createdAt ? Date.parse(a.createdAt) : 0;
    const tb = b.createdAt ? Date.parse(b.createdAt) : 0;
    if (ta !== tb) return tb - ta;
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  });
}

/**
 * How old a `sending` row must be before this list treats it as STRANDED rather than in flight.
 *
 * The server's send path has the same ten-minute constant (`SEND_STALE_AFTER_MS`) for treating a
 * `pending` reservation as orphaned, and this value matches it on purpose: past this age no
 * invocation can still be alive, so a row still
 * `sending` is the wreckage of a send that died mid-flight — the same silent loss as `unverified`,
 * reached without the server ever getting to say so. Younger `sending` rows stay OFF the list:
 * they are the two seconds of an ordinary delivery, and a Drafts list that flashed every send
 * through itself would be noise wearing a warning's clothes.
 */
export const SENDING_STALE_AFTER_MS = 10 * 60 * 1000;

/**
 * EVERY DRAFT THE USER CAN STILL ACT ON, newest first — the Drafts list.
 *
 * ── WHICH STATUSES, AND WHY EACH ─────────────────────────────────────────────────────────
 *
 * `drafts` rows do not disappear when they are sent: `SendService` moves the row to `sent`, and
 * `sending` / `unverified` are the two states in between. All four are the same entity in the
 * mirror.
 *
 *  · `draft` — the ordinary case: a message being written.
 *  · `unverified` — SMTP threw AND the Sent probe found nothing: the mail may never have been
 *    delivered, and the row holds THE ONLY COPY of its text. This used to be filtered out, on
 *    the reasoning that listing it invites a second delivery of a mail that may have gone —
 *    which is right about a plain re-send and wrong about the listing: hiding the row made an
 *    undelivered message invisible on every surface, and the user, told to "check your Sent
 *    folder", found nothing anywhere and concluded the mail was lost (it was — measured on a
 *    real account). The row is listed; what the surface OFFERS on it is the surface's rule
 *    (recover into a fresh compose, or discard — never a blind re-send of the same row).
 *  · `sending`, once STALE — see {@link SENDING_STALE_AFTER_MS}: past every possible invocation
 *    lifetime this is a send that died without a verdict, stranded exactly like `unverified`
 *    except the server never got to write the word. Fresh `sending` rows are not listed.
 *  · `sent` — never listed: that message left, and a list whose rows invite editing must not
 *    hold it.
 *
 * `accepted` is not filtered on. It is a client-local flag meaning "the user took an AI draft
 * into the editor", and a draft somebody has started editing is exactly a draft.
 *
 * Sorted by `updatedAt` and not `createdAt`, because the question a Drafts list answers is "what
 * was I last writing" — a reply started a week ago and touched this morning belongs at the top.
 * The id breaks ties so the order is stable across renders rather than dependent on insertion.
 *
 * @param now injected for the staleness cut, defaulting to the wall clock. A memoized caller
 * re-evaluates on its ordinary version bumps, so a row crossing the ten-minute line surfaces on
 * the next drain rather than the very second — a deliberate trade, not a defect.
 */
export function draftsList(reader: EntityReader, now: Date = new Date()): EngineDraft[] {
  const staleBefore = now.getTime() - SENDING_STALE_AFTER_MS;
  return reader.list<EngineDraft>("draft")
    .filter((d) =>
      d.status === "draft" ||
      d.status === "unverified" ||
      (d.status === "sending" && (d.updatedAt ? Date.parse(d.updatedAt) : 0) < staleBefore))
    .sort((a, b) => {
      const ta = a.updatedAt ? Date.parse(a.updatedAt) : 0;
      const tb = b.updatedAt ? Date.parse(b.updatedAt) : 0;
      if (ta !== tb) return tb - ta;
      return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
    });
}

/**
 * DOES THIS MIRROR HOLD THE DRAFT'S TEXT — the one rule, so no surface writes a second one.
 *
 * `false` for `null` and for a row from a page that carried no `body` key at all, which is the
 * same fact and reaches a reader as `undefined` past a type that promises otherwise
 * (`applyToRecords` stores the DTO verbatim). `true` for the empty string: a draft with nothing
 * typed in it is a known body, and treating it as unknown would refuse to save the one edit that
 * empties a message.
 *
 * Consulted before the text is seeded into an editor and before autosave writes it back. A row
 * whose body is unknown must not become a PUT — that PUT would replace what the person wrote
 * with the blank this client happens to be holding.
 */
export function draftBodyKnown(draft: { body?: string | null }): boolean {
  return typeof draft.body === "string";
}

/**
 * THE SCHEDULED SENDS (Send later, mail 0077) — every draft wearing an appointment, soonest
 * first. Its own list rather than a branch of {@link draftsList}, because the two surfaces make
 * different promises: Drafts is "what you have not sent", ordered by recency of touch;
 * Scheduled is "what WILL send, and when", and the only ordering that answers that question is
 * the appointment's own. A row with no `sendAt` (an older server mid-claim, a mirror row from
 * before the field) still lists — hiding a scheduled send because its time is unknown would be
 * the surface suppressing exactly the row the user most needs to see — and sorts last.
 */
export function scheduledSendsList(reader: EntityReader): EngineDraft[] {
  return reader.list<EngineDraft>("draft")
    .filter((d) => d.status === "scheduled")
    .sort((a, b) => {
      const ta = a.sendAt ? Date.parse(a.sendAt) : Number.MAX_SAFE_INTEGER;
      const tb = b.sendAt ? Date.parse(b.sendAt) : Number.MAX_SAFE_INTEGER;
      if (ta !== tb) return ta - tb;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
}

// ── Counts ─────────────────────────────────────────────────────────────────

export interface EngineCounts {
  ohboxUnread: number;
  ohboxTotal: number;
  /** Unread Reads issues (the rail badge). */
  reads: number;
  /** Unread receipts. */
  receipts: number;
  screenerWaiting: number;
  replyLater: number;
  setAside: number;
  resurface: number;
}

/**
 * GIVE THIS THE PRESENTED READER, NOT THE MIRROR — it has no production caller today, and that is
 * the only reason it is a note rather than a defect.
 *
 * Every count here groups by folder, so over a raw mirror `screenerWaiting` answers "how much mail
 * is filed in `ohmail/Screener`" rather than "how many senders owe a decision". Those two numbers
 * differed by 1,500 on a real backfilled mailbox, which is the whole subject of the header on
 * {@link screenerSegments}. The shell's own badge comes from `useScreenerState`, which is fed
 * `presentationReader`'s output; a second badge derived from here would silently disagree with it.
 */
export function unreadCounts(reader: EntityReader, now: Date = new Date()): EngineCounts {
  const ohbox = messagesIn(reader, FOLDER_OF_VIEW.ohbox);
  const piles = triagePiles(reader);
  return {
    ohboxUnread: ohbox.filter((m) => m.unread).length,
    ohboxTotal: ohbox.length,
    reads: messagesIn(reader, FOLDER_OF_VIEW.reads).filter((m) => m.unread).length,
    receipts: messagesIn(reader, FOLDER_OF_VIEW.receipts).filter((m) => m.unread).length,
    screenerWaiting: screenerSegments(reader, now).waiting.length,
    replyLater: piles.replyLater.length,
    setAside: piles.setAside.length,
    resurface: piles.resurface.length,
  };
}
