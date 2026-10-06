import { canonicalDestination, isSentFolderPath } from "@trafficflow/core/folder-name";
import { opensWithForwardPrefix } from "@trafficflow/core/reply-subject";
import { isAcknowledgementSubject } from "@trafficflow/core/ics";
import { mayGroupByMessageId } from "@trafficflow/core/sender-headers";
import { ruleMatchKey } from "@trafficflow/core/rule-order";
import { resurfacedFolds } from "@trafficflow/core/conversation-fold";
import { isHeldFolder } from "@trafficflow/core/destinations";
import type { EntityReader } from "./store.js";
/* The address fold and the own-address predicate, from the leaf that owns both — never
   re-spelled here. A LEAF and not `consent-cutline.ts`: the partition imports this module, so
   taking the predicate from it would close an import cycle. */
import { ownAddressKeys, senderKey } from "./own-address.js";
import { zonedDayNumber, zonedFields } from "./zone.js";
import { daysAgo, messageStamp, named } from "./stamp.js";
import { storeInstantOf } from "./store-pages.js";
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
  type HeldReleaseGroupDTO,
  type UnscreenedGroupDTO,
  HELD_RELEASE_TYPE,
  RETIRED_DECIDED_TYPE,
  UNSCREENED_TYPE,
  SCREENER_WAITING_TYPE,
  SCREENER_WAITING_PAGE_ID,
  type ScreenerWaitingDTO,
  type ScreenerWaitingPageDTO,
  type ScreenerWaitingSenderDTO,
  type ScreenerHeldMail,
  type ScreenerSegment,
  type ScreenerSenderDTO,
  type ScreenerSuggestionEntity,
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
 * THE ROW STAMP, UNDER THE NAME EVERY IMPORTER ALREADY USES — the rule is `stamp.ts`'s; this adds a
 * memo per ENTITY OBJECT beside {@link parsedDate}. A stamp depends on the message's own date and on
 * the reader's day, zone and language, and the mirror replaces a record rather than editing it, so
 * the entity's identity is the memo's lifetime and the key is `(reader's day, zone, locale)`: a list
 * re-derived within a day stamps each row once. A plain `{ date }` object is stamped and forgotten.
 */
const stampMemo = new WeakMap<object, { key: string; out: string }>();

export function messageDisplayTime(
  m: Pick<EngineMessage, "time" | "date">, now: Date, zone: string, locale = "en",
): string {
  if (m.time) return m.time;
  const key = `${zonedDayNumber(now, zone)}|${zone}|${locale}`;
  const hit = stampMemo.get(m);
  if (hit !== undefined && hit.key === key) return hit.out;
  const out = messageStamp(m, now, zone, locale);
  stampMemo.set(m, { key, out });
  return out;
}

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
    // The store's own arrival key (`store-pages.ts` `storeInstantOf`): ONE derivation for every
    // date comparator and for the server's keyset, so a list and the pages below it agree.
    t = storeInstantOf(m);
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
/**
 * A spam verdict's husk on a message that is no longer in the spam pile — moved out, its text
 * being refilled from the mail server. The one decision every reader makes before choosing a
 * sentence: the verdict's is false here, "loading" is true for {@link JUNK_REFILL_BOUND_MS}.
 */
export function isJunkHuskLeaving(
  body: Pick<MessageBody, "state" | "withheld">, folder: string | null | undefined,
): boolean {
  if (body.state !== "withheld" || body.withheld !== "junk_filed") return false;
  return folder == null || (VIEW_OF_FOLDER as Record<string, string | undefined>)[folder] !== "spam";
}

/** How long a reader may say "loading from your mail server" over such a husk before it says it could not. */
export const JUNK_REFILL_BOUND_MS = 15_000;

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
 * checks `length > 0`). A conversation spans folders (the Ohbox, Sent under the server's name, a
 * pinned gate row) but a HELD member stands in it by a header another sender wrote, so it is left
 * out ({@link standsHeld}) of the conversation a placed message opens. Opened at a held message
 * (the Screener's reader) it is the whole thread, held siblings included. O(n) over the mirror;
 * never call per row for list badges — that is O(n²).
 */
export function threadOf(reader: EntityReader, messageId: string): EngineMessage[] {
  const self = reader.get<EngineMessage>("message", messageId);
  if (!self?.threadId) return [];
  const claims = winningStates(reader);
  const all = standsHeld(self, claims);
  const members = collapseTwins(
    reader
      .list<EngineMessage>("message")
      .filter((m) => m.threadId === self.threadId && (all || !standsHeld(m, claims)))
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
  /**
   * KEYED ON THE MESSAGE STAMP, NOT THE GLOBAL VERSION — and the note below already said why
   * without acting on it: "arriving bodies change fields on rows whose ids and dates stand". A
   * body is not a field on a message row at all; it is a `message_body` record. Keyed on
   * `version()` every body publish MISSED here, and a miss is not free — it is a fresh
   * whole-mirror `list()`, a Map of every id and a walk of every row, to arrive back at the
   * order it already held. An open writes three bodies and the eager pass one per message.
   * The message stamp moves for every arrival, prune, edit and optimistic overlay, which is
   * every way the order can actually change; `date-order-cache.test.ts` pins both fallthroughs.
   */
  const v = typeof reader.stampOf === "function" ? reader.stampOf("message") : reader.version();
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
        // BOTH halves of the sort key ({@link tsOf}): a delta that brings or moves `sortAt`
        // while `date` stands is an order change the date test alone would repair over.
        if (cur === undefined || cur.date !== prev.date || cur.sortAt !== prev.sortAt) {
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
  /* BOTH SPELLINGS OF THE NEWS FOLDER ANSWER HERE. `pileFolder` keeps filing to the pre-0.22
     `ohmail/Reads` for as long as that folder exists, so on a mailbox the organizer has not
     renamed yet every row in the pile carries the legacy name — and a `===` on the canonical
     one emptied the News view while the mail was sitting there. `VIEW_OF_FOLDER` already reads
     both ways; this is the same question asked in the other direction. */
  const want = canonicalDestination(folder);
  return messagesByDateDesc(reader).filter((m) => canonicalDestination(m.folder) === want);
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
 * IS THIS THE ACCOUNT'S OWN FORWARD — an own-sent row (the ingested Sent copy, or the
 * confirm-time overlay, which is `local: true` under the Sent folder) whose subject opens with an
 * unambiguous forward prefix in any of the languages ONE table knows (`opensWithForwardPrefix`,
 * core). A received "Fwd:" is somebody else's forward and answers false. DISPLAY ONLY, like
 * {@link isItipAcknowledgement}: a conversation panel faces such a row "Forwarded to …" instead of
 * its sender's name; nothing here reaches threading, naming or a merge, and the worst error is an
 * own forward wearing its sender's name.
 */
export function isForwardedByUs(m: Pick<EngineMessage, "folder" | "subject" | "local">): boolean {
  return (m.local === true || isOwnSent(m)) && opensWithForwardPrefix(m.subject);
}

/**
 * IS THIS A CALENDAR CLIENT'S ACKNOWLEDGEMENT RATHER THAN SOMETHING A PERSON SAID — the
 * "Accepted:" the account's own Calendar app sends back.
 *
 * Two arms: the stored `method=REPLY`, on the top-level header or a calendar part's stored type
 * ({@link EngineMessage.itipReplyHeader}), and the subject, trusted OWN-SENT only — a
 * received "Accepted: …" is a person telling you something. DISPLAY ONLY: nothing here reaches
 * threading, naming or a merge, and the worst error is own mail that genuinely opens "Accepted:"
 * losing its conversation's FACE while staying a member of it.
 */
export function isItipAcknowledgement(m: Pick<EngineMessage, "folder" | "subject" | "itipReplyHeader">): boolean {
  if (m.itipReplyHeader === true) return true;
  return isOwnSent(m) && isAcknowledgementSubject(m.subject ?? "");
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
 * THE ONE CLAIM PER MESSAGE — both wire homes of "comes back later", folded.
 * The fact crosses the wire twice — embedded on the message, and as its own `message_state` — and
 * a windowed bootstrap can deliver either without the other, which is how one client stood a
 * parked message in the main list wearing its chip while another had it under Triage. This is the
 * only place either is read: the message's own row is the CARRIER, the record is offered LAST so a
 * tie goes to it, and an absent `triage` offers nothing (a release crosses as a `none` row with a
 * fresh stamp). Dedup is by MESSAGE id, newest `updatedAt` winning, ties keeping the later claim —
 * two record-id spellings of one fact counted a pile 6-vs-1 live, and the user always wins.
 */
const claimCache = new WeakMap<EntityReader, { v: number; claims: Map<string, MessageStateDTO> }>();

export function winningStates(reader: EntityReader): Map<string, MessageStateDTO> {
  // A hand-rolled reader with no `version()` gets the uncached answer (see `messagesByDateDesc`).
  const v = typeof reader.version === "function" ? reader.version() : null;
  const hit = v === null ? undefined : claimCache.get(reader);
  if (hit && hit.v === v) return hit.claims;

  const claimOf = new Map<string, MessageStateDTO>();
  const offer = (st: MessageStateDTO): void => {
    const held = claimOf.get(st.messageId);
    if (held && Date.parse(held.updatedAt) > Date.parse(st.updatedAt)) return;
    claimOf.set(st.messageId, st);
  };
  for (const st of reader.list<MessageStateDTO>("message_state")) offer(st);
  // `messageId` is re-stated from the row: the carrier IS this message, whatever the copy says.
  for (const m of reader.list<EngineMessage>("message")) {
    if (m.triage) offer({ ...m.triage, messageId: m.id });
  }
  if (v !== null) claimCache.set(reader, { v, claims: claimOf });
  return claimOf;
}

/**
 * HELD AND NOT PINNED: at the gate, screened out or quarantined ({@link isHeldFolder} over the
 * folder this reader shows), with no `resurfaced`/`bubbled_up` claim the person put on it. Such a
 * message is in no conversation another sender's header threaded it into — not its panel, not its
 * participants, not its Resurfaced row. On a raw reader a pinned gate row reads its physical
 * folder, which is why the claim is asked and not the folder alone.
 */
function standsHeld(m: Pick<EngineMessage, "id" | "folder">, claims: ReadonlyMap<string, MessageStateDTO>): boolean {
  return heldUnpinned(m.folder, claims.get(m.id)?.state);
}

/** The rule {@link standsHeld} applies, over a folder and the claim a surface already holds. */
export function heldUnpinned(folder: string | null | undefined, state: string | null | undefined): boolean {
  if (!isHeldFolder(folder)) return false;
  return state !== "resurfaced" && state !== "bubbled_up";
}

/** Two claims a surface cannot tell apart — used to keep a row's identity when nothing moved. */
function sameClaim(a: MessageStateDTO | null, b: MessageStateDTO | null): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  return a.state === b.state && a.bubbleUpAt === b.bubbleUpAt
    && a.setAt === b.setAt && a.updatedAt === b.updatedAt;
}

/**
 * THE CARRIER, STAMPED — the reader every surface reads the mirror through.
 *
 * {@link OhmailEngine.read} returns this, so no client can forget it: every message already
 * carries {@link winningStates}' one claim on its own `triage`, and the chip, the Ohbox hold-out,
 * the piles and the reading pane are one derivation. A PROJECTION rather than a heal written into
 * the mirror — no second stored copy to go stale, and a record arriving before its message still
 * lands on the row the moment it does. Rows whose homes agree come back by identity.
 */
export function oneSourceReader(inner: EntityReader): EntityReader {
  const projector = (): ((m: EngineMessage) => EngineMessage) => {
    const claims = winningStates(inner);
    return (m) => {
      const claim = claims.get(m.id) ?? null;
      return sameClaim(claim, m.triage) ? m : { ...m, triage: claim };
    };
  };

  return {
    version: () => inner.version(),
    /* THE STAMP A PROJECTION MOVES UNDER. `winningStates` folds `message_state` into a message's
       `triage`, so a message row here moves when EITHER type does — a stamp naming only `message`
       would hold a window over a park the mirror has already recorded. */
    stampOf(type: string): number {
      if (type !== "message") return inner.stampOf(type);
      return Math.max(inner.stampOf("message"), inner.stampOf("message_state"));
    },
    /* Same fold, from the deny side: a caller that ignores `message_state` while still reading
       messages would get the stale screen the deny list exists to prevent, so that one name is
       dropped from its ignore set. A caller ignoring `message` reads no projection and keeps its
       list whole — the failure mode stays a needless rebuild, never a stale one. */
    stampExcept(ignore: readonly string[]): number {
      if (ignore.includes("message")) return inner.stampExcept(ignore);
      return inner.stampExcept(ignore.filter((t) => t !== "message_state"));
    },
    // Inline rather than through `projector()`: this is the per-row read every reading surface
    // makes, and the claim map is already cached — no closure need be built to answer one row.
    get<T = unknown>(type: string, id: string): T | undefined {
      const v = inner.get<T>(type, id);
      if (type !== "message" || v === undefined) return v;
      const m = v as unknown as EngineMessage;
      const claim = winningStates(inner).get(m.id) ?? null;
      return (sameClaim(claim, m.triage) ? m : { ...m, triage: claim }) as unknown as T;
    },
    list<T = unknown>(type: string): T[] {
      if (type !== "message") return inner.list<T>(type);
      return inner.list<EngineMessage>("message").map(projector()) as unknown as T[];
    },
    entries<T = unknown>(type: string): Array<{ id: string; entity: T; seq: number }> {
      const rows = inner.entries<T>(type);
      if (type !== "message") return rows;
      const project = projector();
      return rows.map((r) => ({
        id: r.id,
        entity: project(r.entity as unknown as EngineMessage) as unknown as T,
        seq: r.seq,
      }));
    },
  };
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

const ohboxCache = new WeakMap<EntityReader, { v: number; openHeld: string | null; view: OhboxView }>();

/**
 * A mail is in exactly one pile — these three groups plus the three bottom piles are the six.
 * Every group holds out {@link parkedMessageIds}, so filed mail is absent from all of them:
 * putting a message away takes it out of the Ohbox, "Earlier" included; the pile it went to is
 * the only place it is. Scope: this is the only surface that holds parked rows out — Reads and
 * Receipts are streams and still list a parked issue; `openTargetFor` depends on that asymmetry
 * and `search-locate.test.ts` pins it. `openHeld` is the row being read
 * ({@link OhmailEngine.holdOpenRow}): it keeps its conversation in "New for you" until the reader
 * moves on or answers it — a read never moves a row. A conversation stands in ONE group.
 */
export function ohboxView(reader: EntityReader, openHeld: string | null = null): OhboxView {
  // Memoized on the reader's version like its siblings (`resurfacedThreads`, `screenerSegments`,
  // `threadSizeIndex`): every uncached call re-filters the whole mirror — measured 2.0 ms at
  // 10 k rows on an UNCHANGED version — and AppShell's `useMemo` shields only the shell, so any
  // second caller paid it per render. Same version ⇒ the identical object.
  const v = reader.version();
  const hit = ohboxCache.get(reader);
  if (hit && hit.v === v && hit.openHeld === openHeld) return hit.view;
  // The shared date-desc order (`messagesByDateDesc`): a filter of it is newest-first by
  // construction, so the groups below carry no sorts of their own any more.
  const all = messagesByDateDesc(reader);
  const inbox = messagesIn(reader, FOLDER_OF_VIEW.ohbox);
  /**
   * The account's own sent mail, folder-agnostic ({@link isOwnSent}), newest first — MINUS the
   * replies the away responder sent on the person's behalf. Writing a message is taking part in
   * its conversation, which is why own-sent mail stands in the Ohbox at all; an automatic reply is
   * the case where that reasoning fails — nobody wrote anything — and the send-date fallback put
   * one "Re: …" row per answered message at the top. A calendar acknowledgement
   * ({@link isItipAcknowledgement}) is the same class and is held out for the same reason.
   * `!== true`, never `=== false`: the field is absent on older mirrors/servers and absent must
   * mean "the person's". Nothing is hidden; both stay in the Sent folder view.
   */
  const sent = all.filter(
    (m) => isOwnSent(m) && m.autoReplyByUs !== true && !isItipAcknowledgement(m),
  );

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
  /**
   * EVERY MEMBER OF A RESURFACED CONVERSATION LEAVES THE TWO GROUPS BELOW. The pin is per message,
   * the ROW is per conversation ({@link resurfacedThreads}), and exactly-once is judged on what is
   * rendered: the reply that pulled a thread forward stands in that row, so it may not also stand
   * in "New for you". Widened from `pinned.has(m.id)` alone — which held out only the pinned member
   * and let its conversation double.
   */
  const inRow = new Set<string>();
  for (const row of resurfacedThreads(reader)) for (const m of row.members) inRow.add(m.id);
  const held = (m: EngineMessage): boolean =>
    !pinned.has(m.id) && !inRow.has(m.id) && !parked.has(m.id);
  // THE CONVERSATION IS THE UNIT OF PLACE (owner 2026-09-28): one fresh member — unread INBOX
  // mail, or the row being read until it is left or answered — files every Ohbox member of its
  // conversation in New; otherwise all of them are Earlier. ONE chronology in both, by arrival
  // (owner 2026-09-18): `all` is date-desc, so the filters below need no sort. Read state stays
  // per message; the parked and resurfaced hold-outs above are per message and unchanged.
  // Collapsed by Message-ID first ({@link collapseTwins}): the optimistic Sent copy stands beside
  // its ingested twin until the end of a drain, and the pair always shares one conversation.
  const inboxIds = new Set(inbox.map((m) => m.id));
  const sentIds = new Set(sent.map((m) => m.id));
  const members = collapseTwins(
    all.filter((m) => (inboxIds.has(m.id) || sentIds.has(m.id)) && held(m)),
    "",
  );
  const freshKeys = new Set<string>();
  for (const m of members) {
    if ((inboxIds.has(m.id) && m.unread) || m.id === openHeld) freshKeys.add(conversationKeyOf(m));
  }
  const inNew = (m: EngineMessage): boolean => freshKeys.has(conversationKeyOf(m));

  const view: OhboxView = {
    resurfaced: resurfaced.filter((m) => !parked.has(m.id)),
    newForYou: members.filter(inNew),
    previouslySeen: members.filter((m) => !inNew(m)),
  };
  ohboxCache.set(reader, { v, openHeld, view });
  return view;
}

/**
 * ONE ROW PER CONVERSATION UNDER RESURFACED.
 *
 * The pin stays PER MESSAGE on the wire (one carrier — `resurface-one-source`); this folds it, so a
 * conversation parked as five messages comes back as one row instead of five. Two ways in: a member
 * whose WINNING state is `resurfaced`, or PULL-FORWARD — a `bubbled_up` member whose conversation
 * has been written to since its pin went up, which brings the thread back NOW and writes nothing.
 * {@link OhboxView.resurfaced} is untouched and still per message: this is ADDITIVE, and the two
 * answer different questions ("which messages carry the pin" vs "which conversations are back").
 */
export interface ResurfacedThreadRow {
  /** Stable row identity: the thread, or the lone message for a row with no conversation. */
  key: string;
  threadId: string | null;
  /** Every mirror message of the conversation but a held one ({@link standsHeld}), newest first. */
  members: EngineMessage[];
  /** The members carrying the claim — `resurfaced` and `bubbled_up` alike. */
  pinned: EngineMessage[];
  /**
   * What opening the row lands on, and whose words it shows: the newest member somebody else
   * wrote ({@link resurfacedFocus}) — never the account's own reply or the away responder's.
   */
  openTarget: EngineMessage;
  count: number;
  /** Whether {@link count} is the server's thread length or the windowed mirror's. */
  countFromThread: boolean;
  /** When the pin was raised — the newest `setAt` among {@link pinned}. */
  resurfacedAt: string | null;
  /** Unread members that arrived after {@link resurfacedAt} — what the badge counts. */
  newSince: EngineMessage[];
  badge: boolean;
  /** True when a `bubbled_up` conversation is standing here because new mail arrived in it. */
  pulledForward: boolean;
}

/**
 * THE INSTANT A ROW DATES A MESSAGE BY — the sort instant, else the `Date:` header, else the
 * arrival. `sortAt` first for {@link tsOf}'s reason (mail 0119): it is the header already clamped
 * against the mailbox's recorded arrival, so a months-off header cannot decide a pull-forward, a
 * badge or an open target either. Then the cutline's rule, under one name: `Date:` is
 * sender-written and nullable, so a row with no header would sort as the epoch.
 * {@link EngineMessage.arrivedAt} is when the mirror recorded it. `null` only when the row
 * carries none of the three, which no server this engine talks to produces.
 */
export function arrivalMs(m: Pick<EngineMessage, "sortAt" | "date" | "arrivedAt">): number | null {
  const sorted = m.sortAt == null ? Number.NaN : new Date(m.sortAt).getTime();
  if (Number.isFinite(sorted)) return sorted;
  const header = m.date == null ? Number.NaN : new Date(m.date).getTime();
  if (Number.isFinite(header)) return header;
  const arrived = m.arrivedAt == null ? Number.NaN : new Date(m.arrivedAt).getTime();
  return Number.isFinite(arrived) ? arrived : null;
}

/**
 * Mail that says a person wrote — the exclusions both the pull-forward and the badge apply. The
 * account's own reply, an away responder's answer and a calendar client's acknowledgement are all
 * things the conversation did to itself; counting them would pull a thread forward on the strength
 * of the user having just dealt with it, which is the pass fighting the spend.
 */
function isFromSomeone(m: EngineMessage): boolean {
  return !isOwnSent(m) && m.autoReplyByUs !== true && !isItipAcknowledgement(m);
}

/**
 * WHAT A RESURFACED ROW SHOWS AND OPENS — the newest member somebody ELSE wrote. A person brings
 * a conversation back to see what came in or what they parked, never their own reply or the away
 * responder's answer; keyed on the newest member by arrival, a row whose last word was an
 * out-of-office wore "Me → …: I'm out of the office" as its face and opened on the Sent copy
 * (desktop and web, 2026-09-21). Newest by {@link arrivalMs} among {@link isFromSomeone}, then
 * the newest PINNED member for a conversation of the account's own mail alone (what was parked),
 * then the newest of all — a row with no focus is not a row. Ties break on the larger id.
 */
export function resurfacedFocus(
  members: readonly EngineMessage[],
  pinned: readonly EngineMessage[] = [],
): EngineMessage {
  const newest = (of: readonly EngineMessage[]): EngineMessage | null => {
    let best: EngineMessage | null = null;
    let bestMs: number | null = null;
    for (const m of of) {
      const t = arrivalMs(m);
      if (best === null || (t !== null && (bestMs === null || t > bestMs || (t === bestMs && m.id > best.id)))) {
        best = m;
        bestMs = t;
      }
    }
    return best;
  };
  return newest(members.filter(isFromSomeone)) ?? newest(pinned) ?? newest(members) ?? members[0]!;
}

const msOf = (iso: string | null): number | null => {
  if (iso === null) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
};

/** How long one conversation is, and whether the server said so or the mirror was counted. */
export interface ThreadSize {
  /** The members an Ohbox row opens: placed ones, or every one where none is placed. */
  count: number;
  /** Every member, held ones included: what a held row (the gate's, Quarantine's) opens. */
  whole: number;
  /** True where the mirror holds the thread row and {@link count} is read off its `messageIds`. */
  fromThread: boolean;
}

const sizeCache = new WeakMap<EntityReader, { v: number; sizes: Map<string, ThreadSize> }>();

/**
 * HOW MANY MESSAGES EVERY CONVERSATION HOLDS — the server's own length where the mirror holds the
 * thread row (a windowed mirror holding three of nine would say "3"), the members in hand where it
 * does not. `count` leaves out a held member the mirror holds ({@link standsHeld}): it is not in
 * the conversation an Ohbox row opens. `whole` counts it, which is what a held row opens.
 *
 * One pass, memoized per version: a per-row {@link threadOf} is O(mirror x rows) for a badge. The
 * web row reads it through {@link resurfacedThreads}, the phone through its own projection.
 */
export function threadSizeIndex(reader: EntityReader): ReadonlyMap<string, ThreadSize> {
  const v = typeof reader.version === "function" ? reader.version() : null;
  if (v !== null) {
    const hit = sizeCache.get(reader);
    if (hit && hit.v === v) return hit.sizes;
  }
  const claims = winningStates(reader);
  const heldIds = new Set<string>();
  const tallies = new Map<string, { placed: number; all: number }>();
  for (const m of reader.list<EngineMessage>("message")) {
    if (!m.threadId) continue;
    const held = standsHeld(m, claims);
    if (held) heldIds.add(m.id);
    const t = tallies.get(m.threadId) ?? { placed: 0, all: 0 };
    t.all += 1;
    if (!held) t.placed += 1;
    tallies.set(m.threadId, t);
  }
  const sizes = new Map<string, ThreadSize>();
  for (const [threadId, t] of tallies) {
    const allHeld = t.placed === 0;
    const inHand = allHeld ? t.all : t.placed;
    const thread = reader.get<{ messageIds?: unknown }>("thread", threadId);
    if (!Array.isArray(thread?.messageIds)) {
      sizes.set(threadId, { count: inHand, whole: t.all, fromThread: false });
      continue;
    }
    // Held ids counted, never filtered: nothing is allocated per thread, and nothing is walked
    // when the mirror holds no held member at all.
    let heldListed = 0;
    if (!allHeld && heldIds.size > 0) for (const id of thread.messageIds) if (heldIds.has(id as string)) heldListed += 1;
    const whole = Math.max(thread.messageIds.length, t.all);
    sizes.set(threadId, { count: Math.max(thread.messageIds.length - heldListed, inHand), whole, fromThread: true });
  }
  if (v !== null) sizeCache.set(reader, { v, sizes });
  return sizes;
}

/**
 * The conversation this row stands for, or 0 where it stands for one — the same "no conversation
 * here" contract {@link threadOf} and {@link threadParticipants} answer with, so a surface can
 * draw and speak the count off one read.
 */
export function conversationSize(
  reader: EntityReader, m: Pick<EngineMessage, "id" | "threadId" | "folder">,
): number {
  if (!m.threadId) return 0;
  const size = threadSizeIndex(reader).get(m.threadId);
  // A held row opens the whole thread (`threadOf`), so it says the whole length.
  const n = (standsHeld(m, winningStates(reader)) ? size?.whole : size?.count) ?? 0;
  return n > 1 ? n : 0;
}

/**
 * WHICH CONVERSATION A MESSAGE BELONGS TO, as the Ohbox places and draws it: its thread, or the
 * message alone. The `msg:` prefix keeps a thread id from ever colliding with a message id.
 */
export function conversationKeyOf(m: Pick<EngineMessage, "id" | "threadId">): string {
  return m.threadId ?? `msg:${m.id}`;
}

const rowsCache = new WeakMap<EntityReader, { v: number; rows: ResurfacedThreadRow[] }>();

/**
 * The Resurfaced block, one row per conversation. One pass builds the by-thread map (per-row
 * {@link threadOf} would be O(mirror × rows)); the result is memoized on the reader's version,
 * because both this list and {@link ohboxView}'s hold-out read it.
 */
export function resurfacedThreads(reader: EntityReader): ResurfacedThreadRow[] {
  const v = reader.version();
  const hit = rowsCache.get(reader);
  if (hit && hit.v === v) return hit.rows;

  const claims = winningStates(reader);
  /* THE MEMBERSHIP IS THE FOLD'S (`@trafficflow/core/conversation-fold`), which the server's
     "New for you" holds out by too: one rule for which conversation a pin brings back. */
  const members = messagesByDateDesc(reader).map((m) => {
    const claim = claims.get(m.id);
    return {
      id: m.id, threadId: m.threadId, arrivedMs: arrivalMs(m), fromSomeone: isFromSomeone(m), unread: m.unread,
      state: (claim?.state as string | undefined) ?? null, setAtMs: msOf(claim?.setAt ?? null), msg: m,
      // The PRESENTED folder: a pinned gate row presents INBOX; the fold keeps a pin wherever it is.
      placed: !isHeldFolder(m.folder),
    };
  });
  const rows: ResurfacedThreadRow[] = [];
  for (const fold of resurfacedFolds(members)) {
    const group = fold.members.map((x) => x.msg);
    const pinned = fold.pinned.map((x) => x.msg);
    // The newest pin decides the row's "since": a conversation asked about twice is asked about
    // from the later ask, so re-parking a thread clears a badge the first pin had earned.
    const newest = fold.pinned.find((m) => m.setAtMs !== null && m.setAtMs === fold.sinceMs);
    const resurfacedAt = newest === undefined ? null : claims.get(newest.id)?.setAt ?? null;
    const key = fold.key;
    // The newest member somebody ELSE wrote — see {@link resurfacedFocus}; a row keyed on the
    // account's own answer opened on the Sent copy (2026-09-21).
    const openTarget = resurfacedFocus(group, pinned);

    // THE SAME COUNT THE PHONE'S ROWS CARRY — {@link threadSizeIndex}, not a second walk here: two
    // derivations of one number drift, and this row's badge and a list row's badge are the same
    // claim about the same conversation. A threadless pin ("msg:" key) stands for itself.
    const size = key.startsWith("msg:") ? undefined : threadSizeIndex(reader).get(key);
    const newSince = fold.newSince.map((x) => x.msg);

    rows.push({
      key,
      threadId: key.startsWith("msg:") ? null : key,
      members: group,
      pinned,
      openTarget,
      count: size?.count ?? group.length,
      countFromThread: size?.fromThread === true,
      resurfacedAt,
      newSince,
      badge: newSince.length > 0,
      pulledForward: fold.pulledForward,
    });
  }

  // Newest claim on attention first, and that is either ask ({@link resurfacedAt}) or arrival —
  // which is what makes the pull-forward visible: a thread written to a minute ago outranks a pin
  // raised this morning.
  const rankOf = (r: ResurfacedThreadRow): number => {
    let best = msOf(r.resurfacedAt) ?? 0;
    for (const m of r.members) {
      const t = arrivalMs(m);
      if (t !== null && t > best) best = t;
    }
    return best;
  };
  rows.sort((a, b) => {
    const d = rankOf(b) - rankOf(a);
    return d !== 0 ? d : (a.key < b.key ? 1 : a.key > b.key ? -1 : 0);
  });

  rowsCache.set(reader, { v, rows });
  return rows;
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
  const claims = winningStates(reader);
  return participantsOfMembers(
    reader.list<EngineMessage>("message").filter((m) => m.threadId === threadId && !standsHeld(m, claims)),
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
  const claims = winningStates(reader);
  for (const m of reader.list<EngineMessage>("message")) {
    // A held stranger is no voice of the conversation a header threaded them into.
    if (!m.threadId || standsHeld(m, claims)) continue;
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

/** The one word this package has no catalogue for — a caller with one passes it. */
export interface ReceiptsWords {
  /** "today" in the reader's language; capitalised here to sit beside the weekday labels. */
  today?: string;
}

/**
 * "Today" / "Thursday" / "2 Aug" — and their equivalents in the caller's language.
 *
 * The first comes from the caller's word where it has one, else from the platform's own
 * (`Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(0, "day")`, "today" / "heute")
 * — this package has no catalogue. Hermes ships NO `Intl.RelativeTimeFormat`: on the phone the
 * constructor is `undefined`, and a receipt dated today took the whole app down at its first live
 * render (measured on the iPhone Duo and 18 Pro simulators, 2026-09-21). Without the API and
 * without a word the weekday stands in. Lower-case answers get their first letter raised.
 */
function dayLabel(date: Date, now: Date, locale: string, zone: string, words: ReceiptsWords = {}): string {
  const ageDays = daysAgo(date, now, zone);
  if (ageDays === 0) {
    const today = words.today ?? platformToday(locale);
    if (today !== null) return today.charAt(0).toUpperCase() + today.slice(1);
  }
  if (ageDays <= 6) return named(locale, { weekday: "long" }, date, zone);
  return `${zonedFields(date, zone).day} ${named(locale, { month: "short" }, date, zone)}`;
}

/** The platform's word for the current day, or null where the runtime has no relative formatter. */
function platformToday(locale: string): string | null {
  const Rtf = (Intl as { RelativeTimeFormat?: typeof Intl.RelativeTimeFormat }).RelativeTimeFormat;
  if (typeof Rtf !== "function") return null;
  let word = TODAY_WORDS.get(locale);
  if (word === undefined) {
    word = new Rtf(locale, { numeric: "auto" }).format(0, "day");
    TODAY_WORDS.set(locale, word);
  }
  return word;
}
/** The platform's "today", per locale — one formatter per language, like `stamp.ts`'s namers. */
const TODAY_WORDS = new Map<string, string>();

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
  /** The caller's own word for today, where it has one (the phone's catalogue). */
  words: ReceiptsWords = {},
): ReceiptsDayGroup[] {
  const groups: ReceiptsDayGroup[] = [];
  for (const m of messagesIn(reader, FOLDER_OF_VIEW.receipts)) {
    const label = dayLabel(m.date ? new Date(m.date) : now, now, locale, zone, words);
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
  /**
   * WHICH SET `waiting` IS. `store`: the first page of the store's queue, joined to the mirror's
   * rows for their held mail. `mirror`: this device's own derivation over a windowed mirror —
   * the store has not answered, or this door cannot ask.
   */
  source: "store" | "mirror";
  /** How many senders are waiting: the store's own count, or `waiting.length` from the mirror. */
  waitingTotal: number;
  /** Where the store's next page starts; null when `waiting` is the whole queue. */
  waitingCursor: string | null;
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
 * ONE HELD ROW PER MESSAGE ENTITY, not per derivation. A row is a pure function of the message,
 * the body record it reads, the zone and locale, and the CALENDAR DAY the stamp is banded against
 * — {@link messageStamp} reads `now` through nothing else. The mirror replaces records and never
 * mutates one (the invariant {@link tsOf}'s cache already rests on) and the consent projection
 * hands a row through unchanged wherever its place equals its folder, so object identity is
 * exactly the lifetime this row is valid for. A bump that touched k messages re-derives k rows
 * and not the whole queue, which is what stops the Screener costing a frame on every bump — the
 * per-row stamp is most of that cost, and the shell asks for this whether or not it is on screen.
 */
interface HeldEntry {
  day: number;
  zone: string;
  locale: string;
  /** The body RECORD, by identity — an arriving body must re-derive the row it fills in. */
  body: MessageBodyRecord | undefined;
  row: ScreenerHeldMail;
}
const heldCache = new WeakMap<EngineMessage, HeldEntry>();

/**
 * THE PER-SENDER AGGREGATE, KEPT ACROSS BUMPS — a bump re-derives the senders whose mail it
 * touched and nobody else. The grouping pass in {@link screenerSegments} stays O(mailbox) and has
 * to: the consent cutline re-homes rows whose own record never moved, so the store's dirty set
 * does not describe the PROJECTION. What this removes is everything after the grouping — the
 * sort, the copies, the rep search and the DTO — for every sender the bump left alone.
 *
 * KEYED ON THE FIRST MESSAGE IN THE BAG by identity, then verified element by element: same
 * length, same objects in order, same body RECORD behind each. Anything else derives in full.
 */
interface SenderEntry {
  segment: ScreenerSegment;
  day: number;
  zone: string;
  locale: string;
  bag: readonly EngineMessage[];
  bodies: ReadonlyArray<MessageBodyRecord | undefined>;
  rep: EngineMessage;
  dto: ScreenerSenderDTO;
  /**
   * WHICH bought suggestion the cached row's `ai` was derived from (`null` = none). Without it a
   * purchase arriving on `/sync` left the chip invisible for every sender whose BAG had not
   * moved — the suggestion is not in the bag, so `sameBag` alone read the row as unchanged.
   */
  suggestionId: string | null;
  /**
   * AND WHICH VERSION of it: a refused act, and its clear, arrive as an `update` on the
   * SAME entity, so the id alone read the row as unchanged and the sentence never appeared.
   */
  suggestionVersion: string | null;
}
const senderCache = new WeakMap<EngineMessage, SenderEntry>();

/** The suggestion's version as the row reads it — joined with `JSON.stringify`, never a control byte. */
const adviceVersion = (s: ScreenerSuggestionEntity | undefined): string | null =>
  s ? JSON.stringify([s.updatedAt, s.actRefusal ?? null]) : null;

/** The bag as the last derivation saw it — messages by identity, and the body each one read. */
function sameBag(
  reader: EntityReader, entry: SenderEntry, bucket: readonly EngineMessage[],
): boolean {
  if (entry.bag.length !== bucket.length) return false;
  for (let i = 0; i < bucket.length; i++) {
    const m = bucket[i]!;
    if (entry.bag[i] !== m) return false;
    if (entry.bodies[i] !== reader.get<MessageBodyRecord>("message_body", m.id)) return false;
  }
  return true;
}

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
  /** The stamp's day number, or `NaN` — see {@link screenerSegments}. `NaN` never matches, so a
   *  zone `Intl` refuses simply goes uncached and throws where it throws today. */
  day: number,
): ScreenerHeldMail {
  const rec = reader.get<MessageBodyRecord>("message_body", m.id);
  const hit = heldCache.get(m);
  if (hit && hit.day === day && hit.zone === zone && hit.locale === locale && hit.body === rec) {
    return hit.row;
  }
  const body = bodyOf(reader, m);
  const row: ScreenerHeldMail = {
    id: m.id,
    subject: m.subject,
    time: messageDisplayTime(m, now, zone, locale),
    body: body.text,
    snippet: m.snippet,
    unread: m.unread,
    bodyState: body.state,
    ...(body.state === "withheld" && body.withheld ? { bodyWithheld: body.withheld } : {}),
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
  heldCache.set(m, { day, zone, locale, body: rec, row });
  return row;
}

/**
 * ONE QUEUE DERIVATION PER (READER, VERSION, DAY, LOCALE, ZONE, OWN SET) — the shape and the
 * reason {@link messagesByDateDesc}'s order cache one screen up already has. The phone's world
 * memo re-derives on twenty-two dependencies of which the mirror version is one, and the shell
 * keeps one projection across renders that move no version, so a single bump can ask for this
 * several times over. Keyed on the reader WEAKLY and invalidated by the engine's own `version()`
 * stamp, never a deep compare. Locale and zone are IN the key: a caller that only counts rows
 * takes the defaults — a different question and therefore a different key.
 */
const segmentsCache = new WeakMap<EntityReader, { v: number; key: string; out: ScreenerSegments }>();

/**
 * The Screener, derived from the message mirror. `screener_sender` is a client-local entity: `/sync`'s vocabulary
 * never carried it (`change-log.ts`), so before this the Screener was structurally empty on every Cloud account while
 * its mail sat in `ohmail/Screener`. It is not promoted onto the wire because the server's own queue is ALREADY a
 * derivation ("DERIVED (no separate table)", `screener-service.ts:88-92`): one entry per distinct sender, the latest
 * message representing it. The row `id` is the REPRESENTATIVE MESSAGE id — precisely what `POST /screener/:id`
 * resolves (`screener-service.ts:144`), so a derived row speaks the existing protocol unchanged. Fixture precedence:
 * `screener_sender` rows win per sender key — a Cloud account has none and sees pure derivation; the demo keeps its
 * richer DTOs.
 */

/**
 * And no-collapse: `held` enumerates EVERY message the sender has in that folder — no count standing in for mail
 * nobody can open.
 */

/**
 * A waiting row's representative, and the flag that says where it really is. Over a PROJECTED reader
 * (`presentationReader`) the waiting bucket also holds mail physically in the INBOX — `consentPartition` presents an
 * active undecided sender's INBOX mail in the Screener. The row must still be minted, but both ends of `POST
 * /screener/:id` require the message to be at the gate: `heldRowById` inherits `desired_folder = 'ohmail/Screener'`
 * (an INBOX id is a 404), and `derivedScreenerEffects` refuses locally for the same reason (`mutations.ts` —
 * `rep.folder !== FOLDER_OF_VIEW.screener` ⇒ no effects). So the rep is the newest GATE-PHYSICAL message when the
 * sender has any; otherwise `newestFirst[0]`, an INBOX message, and the row is marked `gatePhysical:false`.
 */

/**
 * That flag keeps the row from rendering every control and performing none: the commit path (`screener-state.ts`)
 * re-reads the raw mirror and routes a `gatePhysical:false` decision PAST THE GATE as a `rule_create` (destination
 * INBOX for a screen-in) with `applyRetro`, so once the rule lands the sender's whole bag presents in the Ohbox with
 * zero server moves — closing the old gap where a sender whose mail is only in the INBOX was reachable only by
 * search, with no change to the gate's `desired_folder` predicate. `held` still carries the whole bag including INBOX
 * mail: those ids feed `mark_seen` and `move`, which resolve against the engine's own store by id.
 */

/**
 * SENDERS THIS ACCOUNT HAS ALREADY ANSWERED FOR, read off the held-release rows the server sent.
 *
 * FOLDER IS STILL THE RENDERING RULE — a waiting row is mail in `ohmail/Screener` — and this is
 * the one fact a folder cannot carry: the mail is at the gate because a rule's backlog has not
 * been released, not because nobody decided. Without it the same sender was listed as first-time
 * waiting and as already decided on one screen. The rows are the SERVER's derivation and nothing
 * is recomputed here, so what the queue subtracts is what a press would release; an empty mirror
 * subtracts nothing, the honest answer for a door that has not replied.
 */
/**
 * One bought suggestion, read as a row's `ai`. `hold` renders as the gate whatever folder rides
 * beside it — the same reading `toSuggestion` gives the wire in the shell. An unknown destination
 * from a newer server falls to the decision's own side rather than a guessed pile. The wire
 * carries no model text by design, so `rationale` is empty: the badge renders the verdict, and
 * the page read (`GET /screener`) stays the richer reader.
 */
function suggestionAi(s: ScreenerSuggestionEntity | undefined): ScreenerSenderDTO["ai"] {
  if (!s) return null;
  const named = (VIEW_OF_FOLDER as Record<string, OhmailView | undefined>)[s.destination];
  const dest = s.decision === "hold"
    ? ("screener" as const)
    : named ?? (s.decision === "yes" ? ("ohbox" as const) : ("screened" as const));
  const code = s.reasonCode === "impersonation" || s.reasonCode === "campaign"
    || s.reasonCode === "auth_fail" || s.reasonCode === "brand_mismatch"
    || s.reasonCode === "correspondent" ? s.reasonCode : undefined;
  return {
    dest,
    confidence: s.confidence,
    rationale: "",
    id: s.id,
    ...(typeof s.actRefusal === "string" && s.actRefusal !== "" ? { actRefused: true as const } : {}),
    ...(code
      ? {
        reasonCode: code,
        ...(s.reasonBrand ? { reasonBrand: s.reasonBrand } : {}),
        ...(typeof s.reasonCount === "number" ? { reasonCount: s.reasonCount } : {}),
      }
      : {}),
  };
}

/**
 * THE NEWEST BOUGHT ADVICE PER SENDER, off the mirror's `screener_suggestion` rows — the
 * narrow `/sync` entity (owner decision 2026-09-18). A re-buy arrives as a delete + create
 * pair, so ordinarily there is one row per sender; `boughtAt` breaks the tie inside the one
 * page where both are momentarily present.
 */
function newestAdviceBySender(reader: EntityReader): Map<string, ScreenerSuggestionEntity> {
  const advice = new Map<string, ScreenerSuggestionEntity>();
  for (const s of reader.list<ScreenerSuggestionEntity>("screener_suggestion")) {
    const prev = advice.get(s.senderKey);
    if (!prev || s.boughtAt > prev.boughtAt) advice.set(s.senderKey, s);
  }
  return advice;
}

/**
 * The mirror's advice as a row's `ai`, keyed by sender — for a surface whose waiting rows do
 * not come through `screenerSegments` (the phone's paired-door server list, whose parse carries
 * no advice). The SAME `suggestionAi` reading the segments give their own rows; a caller never
 * re-derives a verdict from `destination` alone.
 */
/** The mirror's newest suggestion for this sender, by entity id, or `null` — what an overlay entry is written over. */
export function mirrorSuggestionIdOf(reader: EntityReader, address: string): string | null {
  return newestAdviceBySender(reader).get(senderKey(address))?.id ?? null;
}

export function screenerAdviceAi(reader: EntityReader): Map<string, ScreenerSenderDTO["ai"]> {
  const out = new Map<string, ScreenerSenderDTO["ai"]>();
  for (const [key, s] of newestAdviceBySender(reader)) out.set(key, suggestionAi(s));
  return out;
}

/** The store's queue page off the mirror, in the page's order, or null when it has not answered. */
export function screenerWaitingOf(
  reader: EntityReader,
): { page: ScreenerWaitingPageDTO; senders: ScreenerWaitingSenderDTO[] } | null {
  const rows = reader.list<ScreenerWaitingDTO>(SCREENER_WAITING_TYPE);
  const page = rows.find((r): r is ScreenerWaitingPageDTO => r.kind === "page" && r.id === SCREENER_WAITING_PAGE_ID);
  if (page === undefined) return null;
  const senders = rows.filter((r): r is ScreenerWaitingSenderDTO => r.kind === "sender")
    .sort((a, b) => a.order - b.order);
  return { page, senders };
}

/**
 * WHAT THE STORE'S PAGES SPEAK FOR — the first page and any walk past it. `listed`: the senders
 * they named. `boundary`: an unlisted sender whose gate mail is newer than this instant is not
 * waiting (the route orders by the representative's date); `-Infinity` once a page ended the
 * queue, `Infinity` when no row states an instant. The partition and the segments both read it.
 */
export function queueCoverage(
  store: { page: ScreenerWaitingPageDTO; senders: readonly ScreenerWaitingSenderDTO[] },
): { listed: Set<string>; boundary: number } {
  const listed = new Set(store.senders.map((s) => senderKey(s.address)));
  const walked = store.page.walked;
  for (const key of walked?.listed ?? []) listed.add(key);
  if (store.page.nextCursor === null || (walked !== undefined && walked.nextCursor === null)) {
    return { listed, boundary: -Infinity };
  }
  const instant = (at: string | undefined): number => (at === undefined || at === "" ? Number.NaN : Date.parse(at));
  const walkedAt = instant(walked?.edge);
  const pageAt = instant(store.senders[store.senders.length - 1]?.receivedAt);
  const at = Number.isNaN(walkedAt) ? pageAt : walkedAt;
  return { listed, boundary: Number.isNaN(at) ? Infinity : at };
}

/**
 * THE INSTANT THE SERVER'S QUEUE SORTS A HELD LETTER BY (`heldSortKey`): the `Date:` header, else
 * the arrival. `null` when the row carries neither.
 */
export function heldSortMs(m: EngineMessage): number | null {
  const header = m.date == null ? Number.NaN : Date.parse(m.date);
  if (Number.isFinite(header)) return header;
  const arrived = m.arrivedAt == null ? Number.NaN : Date.parse(m.arrivedAt);
  return Number.isFinite(arrived) ? arrived : null;
}

/**
 * EACH SENDER'S NEWEST HELD LETTER, by {@link heldSortMs} — the representative the queue pages by.
 * A page speaks for a sender by THAT letter, never letter by letter: two letters straddling the
 * page's boundary are one sender the page has or has not reached.
 */
export function newestHeldBySender(messages: readonly EngineMessage[]): ReadonlyMap<string, number> {
  const out = new Map<string, number>();
  for (const m of messages) {
    if (m.folder !== "ohmail/Screener") continue;
    const ms = heldSortMs(m);
    if (ms === null) continue;
    const key = senderKey(m.from.address);
    if (ms > (out.get(key) ?? Number.NEGATIVE_INFINITY)) out.set(key, ms);
  }
  return out;
}

/** Does the store's queue page name this message as a sender's representative? */
export function screenerWaitingNames(reader: EntityReader, messageId: string): boolean {
  return reader.list<ScreenerWaitingDTO>(SCREENER_WAITING_TYPE)
    .some((r) => r.kind === "sender" && r.messageId === messageId);
}

/** A waiting row for a sender the store lists and the mirror holds none of the held mail of. */
function storeRow(
  s: ScreenerWaitingSenderDTO, now: Date, locale: string, zone: string, ai: ScreenerSenderDTO["ai"],
): ScreenerSenderDTO {
  const name = s.name || s.address;
  const time = messageDisplayTime({ date: s.receivedAt === "" ? null : s.receivedAt } as EngineMessage, now, zone, locale);
  return {
    id: s.messageId, segment: "waiting", from: { name: s.name, address: s.address },
    ...(s.mailboxId ? { mailboxId: s.mailboxId } : {}),
    initial: (name.trim()[0] ?? "?").toUpperCase(), time, scope: "sender", ai,
    held: [{ id: s.messageId, subject: s.subject, time, body: s.snippet, snippet: s.snippet, bodyState: "snippet" }],
    derived: true, gatePhysical: true, stored: true,
    updatedAt: s.receivedAt === "" ? now.toISOString() : s.receivedAt,
  };
}

/**
 * THE STORE'S SENDERS, IN THE STORE'S ORDER — a join, never a union. A sender whose held mail the
 * mirror presents gets the mirror's row; one whose named message the mirror holds elsewhere is
 * one the mirror has seen decided since the page was read, and is left out; the rest are minted.
 */
function joinStore(
  reader: EntityReader, senders: readonly ScreenerWaitingSenderDTO[],
  derived: ReadonlyMap<string, ScreenerSenderDTO>, own: ReadonlySet<string>,
  now: Date, locale: string, zone: string,
): ScreenerSenderDTO[] {
  const advice = newestAdviceBySender(reader);
  const out: ScreenerSenderDTO[] = [];
  for (const s of senders) {
    const key = senderKey(s.address);
    if (own.has(key)) continue;
    const dto = derived.get(key);
    if (dto) { out.push(dto); continue; }
    if (reader.get<EngineMessage>("message", s.messageId) !== undefined) continue;
    out.push(storeRow(s, now, locale, zone, suggestionAi(advice.get(key))));
  }
  return out;
}

/**
 * THE MIRROR'S HELD SENDERS THE PAGE CANNOT SPEAK FOR — older than the last row the pages read
 * ({@link queueCoverage}), while the queue goes on past it. They may be on a later page, so they
 * stay on screen after the page's own rows rather than vanish; one the page lists is the page's,
 * and an unlisted one newer than that row is not waiting. A sender a later page listed stays.
 */
function pastThePage(
  reader: EntityReader, store: { page: ScreenerWaitingPageDTO; senders: ScreenerWaitingSenderDTO[] },
  derived: ReadonlyMap<string, ScreenerSenderDTO>,
): ScreenerSenderDTO[] {
  const { listed, boundary } = queueCoverage(store);
  const onPage = new Set(store.senders.map((s) => senderKey(s.address)));
  const newest = newestHeldBySender(reader.list<EngineMessage>("message"));
  const out: ScreenerSenderDTO[] = [];
  for (const [key, dto] of derived) {
    if (onPage.has(key) || dto.gatePhysical === false) continue;
    if (listed.has(key)) { out.push(dto); continue; }
    // The sender's newest held letter, header else arrival, is what the page sorted them by.
    const seed = reader.get<EngineMessage>("message", dto.id);
    const ms = newest.get(key) ?? (seed ? heldSortMs(seed) : null);
    if (ms === null || ms <= boundary) out.push(dto);
  }
  return out;
}

/** The derived waiting rows behind one segments answer, for {@link screenerRowsOfStore}. */
const derivedWaitingOf = new WeakMap<ScreenerSegments, ReadonlyMap<string, ScreenerSenderDTO>>();

/**
 * ROWS FOR A PAGE OF THE QUEUE PAST THE FIRST — the same join the first page gets, so a sender the
 * mirror holds shows its held mail wherever in the queue it sits. The arguments are
 * {@link screenerSegments}' own, so the derivation is the memoised one.
 */
export function screenerRowsOfStore(
  reader: EntityReader, senders: readonly ScreenerWaitingSenderDTO[], now: Date = new Date(),
  locale = "en", zone = "UTC", ownAddresses?: Iterable<string>,
): ScreenerSenderDTO[] {
  const segments = screenerSegments(reader, now, locale, zone, ownAddresses);
  const own = ownAddressKeys(reader, ownAddresses === undefined ? {} : { ownAddresses });
  return joinStore(reader, senders, derivedWaitingOf.get(segments) ?? new Map(), own, now, locale, zone);
}

function heldReleaseClaim(reader: EntityReader): (key: string) => boolean {
  const senders = new Set<string>();
  const domains = new Set<string>();
  for (const g of reader.list<HeldReleaseGroupDTO>(HELD_RELEASE_TYPE)) {
    // A contact-only sender is UNDECIDED: the offer is a shortcut beside their waiting row, not
    // an answer that retires it — a person may still screen one contact out.
    if (g.sender !== undefined) continue;
    const match = ruleMatchKey(g.match);
    if (match === "") continue;
    (g.kind === "domain" ? domains : senders).add(match);
  }
  // …and a decided sender the cutline retired — standing, not placement (`RETIRED_DECIDED_TYPE`).
  for (const r of reader.list<{ key: string }>(RETIRED_DECIDED_TYPE)) senders.add(r.key);
  if (senders.size === 0 && domains.size === 0) return () => false;
  return (key: string): boolean => {
    if (senders.has(key)) return true;
    const at = key.lastIndexOf("@");
    return at >= 0 && domains.has(key.slice(at + 1));
  };
}

/**
 * Inert over a raw mirror, which is why `screener-derived.test.ts` is untouched: without a projection every
 * waiting-bucket message already has `folder === 'ohmail/Screener'` and `physicalFolder` unset, so the gate-physical
 * rep IS `newestFirst[0]` and no past-the-gate branch is reached.
 */
export function screenerSegments(
  reader: EntityReader, now: Date = new Date(),
  /** Which language the derived rows' stamps are named in. English by default — see {@link named}. */
  locale = "en",
  /**
   * Which zone those stamps are read in. Defaults to UTC for the reason {@link receiptsByDay}'s
   * does — this package's own tests assert UTC stamps and there is no reader here to ask. The web
   * app passes the reader's zone at the one call site that renders these rows
   * (`app/shell/screener-state.ts`); a caller that reads only `.waiting.length` need not,
   * because a count never reads a stamp.
   */
  zone = "UTC",
  /**
   * THE ACCOUNT'S OWN ADDRESSES — the same list the partition was given
   * ({@link ConsentOptions.ownAddresses}), read through the same predicate.
   *
   * Own mail is never a WAITING row wherever it sits. Over the projection the partition already
   * presents own mail held at the gate in the INBOX; this guard is the answer for a RAW reader
   * (no partition yet), where that message still reads `ohmail/Screener` and would ask the
   * account to screen itself. Absent ⇒ the mirror's `mailbox` rows, the partition's own
   * fallback; `[]` ⇒ nobody.
   */
  ownAddresses?: Iterable<string>,
): ScreenerSegments {
  const own = ownAddressKeys(reader, ownAddresses === undefined ? {} : { ownAddresses });
  /**
   * THE CLOCK ENTERS AS A DAY NUMBER, WHICH IS ALL OF IT A STAMP READS. Every band in
   * {@link messageStamp} is a difference of {@link zonedDayNumber}, and the dated band's year
   * follows from it — so two callers milliseconds apart are asking one question, and a caller on
   * the next day is not. `NaN` for a zone `Intl` refuses: the memo is then off in both halves and
   * the refusal surfaces where it surfaces today, at the first stamp, rather than being moved
   * earlier by a line that exists to make this faster.
   */
  let day: number;
  try {
    day = zonedDayNumber(now, zone);
  } catch {
    day = Number.NaN;
  }
  /* A hand-rolled partial reader (several harnesses build one) may not implement `version()`;
     with no invalidation key there is nothing safe to cache on, so such a reader derives
     uncached — correct, merely unmemoised. `messagesByDateDesc` takes the same out. */
  const memoable = Number.isFinite(day) && typeof reader.version === "function";
  const key = memoable ? JSON.stringify([day, zone, locale, [...own].sort()]) : "";
  if (memoable) {
    const hit = segmentsCache.get(reader);
    if (hit && hit.v === reader.version() && hit.key === key) return hit.out;
  }
  const grouped: Record<ScreenerSegment, Map<string, EngineMessage[]>> = {
    waiting: new Map(),
    screened_out: new Map(),
    spam: new Map(),
  };

  const alreadyDecided = heldReleaseClaim(reader);

  // The newest bought advice per sender — see {@link newestAdviceBySender}. This is what fills
  // a WAITING row's `ai` on every surface that renders these rows — the phone's badge included —
  // the second the delta lands.
  const advice = newestAdviceBySender(reader);

  for (const m of reader.list<EngineMessage>("message")) {
    const view = VIEW_OF_FOLDER[m.folder] as OhmailView | undefined;
    const segment = view ? SEGMENT_OF_VIEW[view] : undefined;
    if (!segment) continue;
    const key = senderKey(m.from.address);
    // The account is not one of its own correspondents, so own mail mints no waiting row — the
    // guard the partition applies to its reckoning, applied to the grouping that renders it.
    // Screened and Quarantine are explicit placements somebody made and keep their rows.
    if (segment === "waiting" && own.has(key)) continue;
    // …nor a sender this account has ALREADY ANSWERED FOR, whose mail is at the gate only because
    // the rule's backlog has not been released — see {@link heldReleaseClaim}.
    if (segment === "waiting" && alreadyDecided(key)) continue;
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
      /* THE BUMP'S OWN DELTA, read off the entities — see `senderCache`. A sender whose bag and
         bodies are the objects the last derivation saw has the same row, so nothing below runs
         for them. */
      const anchor = bucket[0];
      const kept = anchor === undefined ? undefined : senderCache.get(anchor);
      const sug = segment === "waiting" ? advice.get(key) : undefined;
      if (kept !== undefined && kept.segment === segment && kept.day === day
          && kept.zone === zone && kept.locale === locale
          && kept.suggestionId === (sug?.id ?? null) && kept.suggestionVersion === adviceVersion(sug)
          && sameBag(reader, kept, bucket)) {
        rows.push({ key, rep: kept.rep, dto: kept.dto });
        continue;
      }
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
      const dto: ScreenerSenderDTO = {
        id: rep.id,
        segment,
        from: rep.from,
        /* WHICH OF THE ACCOUNT'S MAILBOXES THE STRANGER WROTE TO — the representative's own, the
           same fact `ScreenerItem.mailboxId` puts on the wire. Off the message and never its
           To/Cc: a header answer is absent on a Bcc, names the list on list mail, and misses a
           plus or catch-all address (`shell/mailbox-label.ts`, which resolves it). */
        mailboxId: rep.mailboxId,
        initial: (name.trim()[0] ?? "?").toUpperCase(),
        time: messageDisplayTime(rep, now, zone, locale),
        scope: "sender",
        // The advice on record, off the mirror's `screener_suggestion` rows — `/sync` carries
        // the narrow verdict since the 2026-09-18 reversal of "no model output in /sync".
        // No classifier runs client-side: this is the server's own purchase, delivered. `GET
        // /screener` still returns the richer `aiSuggestion` (rationale included) on the page.
        ai: suggestionAi(sug),
        /* WHY THERE WILL NEVER BE ONE, when that is the answer. `no_ai` mail is kept away from
           every model, so this sender’s row is not waiting for a run to reach it. Read off the
           representative, which is the message a suggestion would have been about. */
        ...(rep.sensitivity?.no_ai ? { noAi: true as const } : {}),
        // Oldest first — the order every preview renders, and ALL of them.
        held: [...newestFirst].reverse().map((m) => heldOf(reader, m, now, locale, zone, day)),
        /* THROUGH {@link messageStamp}, like every row stamp on this screen. It used to mint
           `${day} ${month}` of its own, which is a FOURTH band: no clock for today, no weekday
           inside this week, and no year for a sender screened out last year — so one Screener
           could show two stamp vocabularies, and a shape change to the row stamp reached the
           messages and not the senders. Same inputs, same function, one vocabulary. */
        ...(segment === "screened_out" && repDate
          ? { screenedOn: messageDisplayTime(rep, now, zone, locale) }
          : {}),
        derived: true,
        gatePhysical,
        updatedAt: rep.updatedAt,
      };
      if (anchor !== undefined) {
        senderCache.set(anchor, {
          segment, day, zone, locale, rep, dto,
          suggestionId: sug?.id ?? null,
          suggestionVersion: adviceVersion(sug),
          // The bucket is built in this call and never mutated afterwards, so it is kept rather
          // than copied — one array per sender, the same one the row was derived from.
          bag: bucket,
          bodies: bucket.map((m) => reader.get<MessageBodyRecord>("message_body", m.id)),
        });
      }
      rows.push({ key, rep, dto });
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

  // THE STORE'S QUEUE, when it has answered: the waiting set and its count are the store's.
  const store = screenerWaitingOf(reader);
  const waiting = store === null
    ? [...out.waiting.values()]
    : [
      ...joinStore(reader, store.senders, out.waiting, own, now, locale, zone),
      ...pastThePage(reader, store, out.waiting),
    ];
  const segments: ScreenerSegments = {
    waiting,
    screenedOut: [...out.screened_out.values()],
    spam: [...out.spam.values()],
    source: store === null ? "mirror" : "store",
    // A row a decision's overlay hides is a sender no longer waiting, before the next answer.
    waitingTotal: store === null ? waiting.length
      : Math.max(0, store.page.total - Math.max(0, store.page.rows - store.senders.length)),
    waitingCursor: store === null ? null : store.page.nextCursor,
  };
  derivedWaitingOf.set(segments, out.waiting);
  if (memoable) segmentsCache.set(reader, { v: reader.version(), key, out: segments });
  return segments;
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

type Filed = { entry: TriagePileEntry; msg: EngineMessage | undefined };

/** Arrival, the Ohbox's own comparator; an entry whose message this mirror lacks goes after. */
function byPileArrival(a: Filed, b: Filed): number {
  if (a.msg && b.msg) return byDateDesc(a.msg, b.msg);
  return a.msg ? -1 : b.msg ? 1 : 0;
}

/** When a Resurface row comes back — the stamp it shows; none reads as "never", after every dated row. */
function returnAt(f: Filed): number {
  const t = f.entry.resurfaceAt ? Date.parse(f.entry.resurfaceAt) : NaN;
  return Number.isNaN(t) ? Infinity : t;
}

/**
 * ONE ORDER PER PILE, and every surface renders it as returned. No pile used to be sorted, so each
 * device showed its mirror's insertion order and Reply Run began on a different message per device.
 * Answer Later and Parked follow arrival, newest first; Resurface follows the time its rows show,
 * soonest first, arrival breaking a tie. `triage-pile-order.census.test.ts` refuses a second sort.
 */
const PILE_ORDER: Record<keyof TriagePiles, (a: Filed, b: Filed) => number> = {
  replyLater: byPileArrival,
  setAside: byPileArrival,
  resurface: (a, b) => (returnAt(a) - returnAt(b)) || byPileArrival(a, b),
};

/**
 * The bottom piles: `message_state` entities joined to their messages, merged with fixture-only `triage_item` entries
 * (demo entries with no backing message). ONE MESSAGE, ONE CLAIM — the records are deduped by MESSAGE id first, in
 * {@link winningStates}, which states why (two record-id spellings of one fact, and a rail badge measured at 6-vs-1
 * against the pile beside it). WHICH PILE a claim joins is {@link pileOfState}, and that indirection is load-bearing:
 * {@link parkedMessageIds} asks the same function which rows the Ohbox must hold out, so a message this lists in a
 * bottom pile cannot also be listed in an Ohbox group.
 */
export function triagePiles(reader: EntityReader): TriagePiles {
  const filed: Record<keyof TriagePiles, Filed[]> = { replyLater: [], setAside: [], resurface: [] };
  // THE SAME TWO STEPS `parkedMessageIds` TAKES — `winningStates` then `pileOfState`. A row this
  // files into a pile is a row `ohboxView` holds out, because both read this one derivation
  // rather than each spelling it themselves. See `pileOfState` for what the two spellings cost.
  const pileOf = (state: string): Filed[] | null => {
    const name = pileOfState(state);
    return name ? filed[name] : null;
  };

  for (const st of winningStates(reader).values()) {
    const pile = pileOf(st.state);
    if (!pile) continue;
    const msg = reader.get<EngineMessage>("message", st.messageId);
    pile.push({ msg, entry: {
      messageId: st.messageId,
      title: msg?.from.name || msg?.from.address || st.messageId,
      ...(msg?.subject ? { subtitle: msg.subject } : {}),
      ...(msg?.snippet ? { preview: msg.snippet } : {}),
      ...(st.bubbleUpAt ? { resurfaceAt: st.bubbleUpAt } : {}),
    } });
  }
  for (const item of reader.list<TriageItemDTO>("triage_item")) {
    const pile = pileOf(item.pile);
    if (!pile) continue;
    pile.push({ msg: undefined, entry: {
      title: item.title,
      ...(item.subtitle ? { subtitle: item.subtitle } : {}),
      ...(item.preview ? { preview: item.preview } : {}),
      ...(item.resurfaceAt ? { resurfaceAt: item.resurfaceAt } : {}),
    } });
  }
  const sorted = (name: keyof TriagePiles): TriagePileEntry[] =>
    filed[name].sort(PILE_ORDER[name]).map((f) => f.entry);
  return { replyLater: sorted("replyLater"), setAside: sorted("setAside"), resurface: sorted("resurface") };
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
 * Every routing rule this account has, newest first. The Screener writes a `rules` row on every
 * decision (`POST /screener/:id` creates one per yes/no, `screener-service.ts:364`), so a
 * consent-gate product accumulates these faster than any other entity the user did not ask
 * for — and until this selector existed nothing in any client read them: `rule` has been in the
 * change log since the first release, the mirror stored them all along, and `/rules` had zero
 * references across the web app.
 */

/**
 * Why the mirror and not `GET /rules`: the `sendingMailboxId` argument with the opposite outcome. A mailbox is NOT a
 * change-log entity type, so a Cloud surface must reach the Cloud client's API layer, which the shared shell may not
 * import. A rule IS one: the server replays it from `change_log`, the webapp passes no `types` filter, and nothing
 * prunes `change_log` (`minRetainedSeq` only reads the minimum), so a bootstrap re-materializes rules created long
 * before this client existed. The mirror costs no request, works offline, and shows the optimistic overlay — a rule
 * just revoked is gone from this list before the wire answers. Newest first because `RulesService.list` orders by
 * `id`, a random uuid — no order to a reader — and the rule a user wants to undo is overwhelmingly the one they just
 * caused; the id tie-breaks rules minted inside one `createdAt` resolution (a bulk "apply to all").
 */

/**
 * Deliberately not computed here: "how many messages has this rule filed?" `RuleDTO.stats`
 * carries `hits`, `lastHitAt` and `demotions`, and nothing anywhere writes them — every value
 * is still its inserted `default(0)` / `null` — so a count would put "0 messages" beside a rule
 * that has silently filed three thousand; the surface says the count is not recorded instead
 * (see `RulesView`). A count of mirror messages currently in the rule's destination is also
 * refused: it reads as "these will move back", exactly the false promise revocation must not
 * make.
 */
/**
 * MAIL HELD AT THE GATE BEHIND A RULE ITS OWNER ALREADY WROTE — the release screen's rows,
 * largest group first. The rows are a SERVER derivation kept in the mirror
 * ({@link HELD_RELEASE_TYPE}); this selector does not recompute the predicate and must not —
 * the deciding fact is WHO placed the message at the gate, which `/sync` does not carry, so a
 * client-side derivation would show one number and release another. Empty means the door has
 * not answered or has nothing to offer; both render as no release row, and "zero held
 * messages" is a claim this selector never makes.
 */
export function heldReleaseGroups(reader: EntityReader): HeldReleaseGroupDTO[] {
  return [...reader.list<HeldReleaseGroupDTO>(HELD_RELEASE_TYPE)]
    .sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));
}

/**
 * THE NUMBER ON THE SCREEN — distinct messages across every group, read off the rows rather than
 * summed over them.
 *
 * One message can sit in two groups: a domain rule and a sender rule inside that domain both claim
 * it, and both counts are honest. Adding them up would tell somebody they hold more mail than they
 * do, so the server sends the distinct figure and every row carries it. Zero with no rows.
 */
export function heldReleaseTotalOf(reader: EntityReader): number {
  const [first] = reader.list<HeldReleaseGroupDTO>(HELD_RELEASE_TYPE);
  return first?.total ?? 0;
}

/**
 * WHETHER THE ACCOUNT SAID "NOT NOW" TO THIS EXACT SET — read off the rows for `total`'s reason.
 * True hides the offer everywhere; a changed set arrives with `dismissed: false` from the server,
 * because the stored fingerprint no longer matches. False with no rows: no offer, nothing to hide.
 */
export function heldReleaseDismissedOf(reader: EntityReader): boolean {
  const [first] = reader.list<HeldReleaseGroupDTO>(HELD_RELEASE_TYPE);
  return first?.dismissed === true;
}

/** This set's identity — "" with no rows or an older server, which reads "not dismissable here". */
export function heldReleaseFingerprintOf(reader: EntityReader): string {
  const [first] = reader.list<HeldReleaseGroupDTO>(HELD_RELEASE_TYPE);
  return first?.fingerprint ?? "";
}

/**
 * OHBOX MAIL FROM SENDERS NOBODY EVER DECIDED ABOUT — the screen's rows, largest group first.
 *
 * The rows are a SERVER derivation kept in the mirror ({@link UNSCREENED_TYPE}); this selector
 * does not recompute the predicate and must not — the deciding fact is what the ARRIVAL GATE
 * would answer over rules and contacts `/sync` carries only part of, so a client-side derivation
 * would show one number and move another. Empty means the door has not answered or has nothing
 * to offer; both render as no row, and "nothing undecided" is a claim this never makes.
 */
export function unscreenedGroups(reader: EntityReader): UnscreenedGroupDTO[] {
  return [...reader.list<UnscreenedGroupDTO>(UNSCREENED_TYPE)]
    .sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));
}

/**
 * THE NUMBER ON THE SCREEN — messages across every shown group, read off the rows rather than
 * summed over them, so the figure is the SERVER's own and one arithmetic. Zero with no rows.
 */
export function unscreenedTotalOf(reader: EntityReader): number {
  const [first] = reader.list<UnscreenedGroupDTO>(UNSCREENED_TYPE);
  return first?.total ?? 0;
}

/**
 * Every rule, newest first, each at the PLACE it files into. A rule stored before the 0.22 rename says
 * `ohmail/Reads` and the organizer files it into the one News folder, so every reader compares the canonical
 * name (`canonicalDestination`, the rename's one alias table) and one pile never reads as two. For
 * read and comparison only: the mirror row keeps its spelling, and a write that keeps a rule's destination sends
 * {@link storedRuleDestination} back, so reading never rewrites a rule.
 */
export function rulesList(reader: EntityReader): RuleDTO[] {
  return reader.list<RuleDTO>("rule").map(atItsPlace).sort((a, b) => {
    const ta = a.createdAt ? Date.parse(a.createdAt) : 0;
    const tb = b.createdAt ? Date.parse(b.createdAt) : 0;
    if (ta !== tb) return tb - ta;
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  });
}

/** The stored spelling of each copy {@link rulesList} re-spelled; a rule already canonical is handed out as itself. */
const STORED_DESTINATION = new WeakMap<RuleDTO, Folder>();

function atItsPlace(rule: RuleDTO): RuleDTO {
  const place = canonicalDestination(rule.destination) as Folder;
  if (place === rule.destination) return rule;
  const read = { ...rule, destination: place };
  STORED_DESTINATION.set(read, rule.destination);
  return read;
}

/** Where a rule from {@link rulesList} is STORED — what a write that keeps its destination sends back. */
export function storedRuleDestination(rule: RuleDTO): Folder {
  return STORED_DESTINATION.get(rule) ?? rule.destination;
}

/**
 * How old a `sending` row must be before this list treats it as STRANDED rather than in flight. The server's send
 * path has the same ten-minute constant (`SEND_STALE_AFTER_MS`) for treating a `pending` reservation as orphaned, and
 * this value matches it on purpose: past this age no invocation can still be alive, so a row still `sending` is the
 * wreckage of a send that died mid-flight — the same silent loss as `unverified`, reached without the server ever
 * getting to say so. Younger `sending` rows stay OFF the list: they are the two seconds of an ordinary delivery, and
 * a Drafts list that flashed every send through itself would be noise wearing a warning's clothes.
 */
export const SENDING_STALE_AFTER_MS = 10 * 60 * 1000;

/**
 * HOW LONG THE ENGINE KEEPS LOOKING FOR A SEND IT COULD NOT CONFIRM. Mirrors the server's
 * `SEND_UNVERIFIED_RECHECK_MS`: inside it a held row says the Sent folder is being checked; past
 * it, that the message is not there. `test/held-send-recheck-window.test.ts` pins the two equal.
 */
export const HELD_SEND_RECHECK_MS = 24 * 60 * 60 * 1000;

/**
 * Every draft the user can still act on, newest first — the Drafts list. `drafts` rows do not disappear when sent:
 * `SendService` moves the row to `sent`, with `sending` / `unverified` in between, all four the same entity in the
 * mirror. Listed: `draft` (a message being written); `unverified` (SMTP threw AND the Sent probe found nothing — the
 * row holds the ONLY copy of its text; it used to be filtered out to avoid inviting a second delivery, which made an
 * undelivered message invisible on every surface and the mail lost, measured in live use; what the surface
 * OFFERS is its own rule — recover into a fresh compose or discard, never a blind re-send); and `sending` once STALE
 * ({@link SENDING_STALE_AFTER_MS}) — past every possible invocation lifetime the send died without a verdict,
 * stranded like `unverified` except the server never wrote the word.
 */

/**
 * Fresh `sending` rows and `sent` are never listed.
 */

/**
 * `accepted` is not filtered on — a client-local flag meaning "the user took an AI draft into
 * the editor", and a draft being edited is exactly a draft. Sorted by `updatedAt`, not
 * `createdAt`: the question a Drafts list answers is "what was I last writing", so a week-old
 * reply touched this morning belongs at the top; the id breaks ties for a stable order.
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
 * DOES THIS MIRROR HOLD THE DRAFT'S TEXT — the one rule, so no surface writes a second one. `false` for `null` and
 * for a row from a page that carried no `body` key at all, which is the same fact and reaches a reader as `undefined`
 * past a type that promises otherwise (`applyToRecords` stores the DTO verbatim). `true` for the empty string: a
 * draft with nothing typed in it is a known body, and treating it as unknown would refuse to save the one edit that
 * empties a message. Consulted before the text is seeded into an editor and before autosave writes it back. A row
 * whose body is unknown must not become a PUT — that PUT would replace what the person wrote with the blank this
 * client happens to be holding.
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

/*
 * There is deliberately NO bundled counts selector here. `unreadCounts` grouped every badge by
 * FOLDER, so over a raw mirror its `screenerWaiting` answered "how much mail is filed in
 * `ohmail/Screener`" rather than "how many senders owe a decision" — a figure the presented
 * reader contradicts by thousands — and it had no production caller to keep it honest.
 * Badges come from the presented projections: `useScreenerState` over `presentationReader` for
 * the Screener, {@link messagesIn}/{@link triagePiles}/{@link screenerSegments} for the rest.
 */
