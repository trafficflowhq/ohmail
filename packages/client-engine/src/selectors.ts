import { isSentFolderPath } from "@trafficflow/core/folder-name";
import type { EntityReader } from "./store.js";
import { zonedDayNumber, zonedFields } from "./zone.js";
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
 * THE DAY AND MONTH NAMES THIS FILE MINTS, FROM `Intl`, IN THE CALLER'S LOCALE AND THE READER'S ZONE.
 *
 * Three hardcoded English arrays stood here and they are the most-repeated words in the product:
 * every message row that is not from today renders one ({@link messageDisplayTime}), every Receipts
 * day heading renders one ({@link receiptsByDay}), and every screened-out sender carries one. A
 * German reader saw "Tue", "Thursday" and "2 Aug".
 *
 * THE LOCALE IS A PARAMETER AND DEFAULTS TO ENGLISH, which is what keeps this package free of an
 * i18n dependency: `@ohmail/client-engine` has no catalogue, no provider and no opinion about
 * language, and every one of its own tests keeps asserting the English strings it always did. The
 * web app is the caller that passes a reader's locale (`app/shell/format.ts`, `AppShell`,
 * `screener-state.ts`).
 *
 * THE ZONE IS A PARAMETER TOO, and unlike the locale it has no default here. It used to be the
 * literal `"UTC"`, matched by `getUTC*` everywhere below, and that was wrong on screen: a reader in
 * Zurich saw a message that arrived at 16:32 stamped "14:32", and a message that arrived after
 * their midnight named as the previous weekday. Which day a message is named on is a property of
 * where the reader is standing, not of the server that stored it. Storage is untouched — every
 * instant in the mirror is still UTC.
 *
 * Cached by locale-and-zone-and-shape: constructing a formatter is the expensive part and these are
 * called once per visible row.
 */
const NAMERS = new Map<string, Intl.DateTimeFormat>();

function named(locale: string, opts: Intl.DateTimeFormatOptions, d: Date, zone: string): string {
  const key = `${locale}|${zone}|${opts.weekday ?? ""}|${opts.month ?? ""}`;
  let fmt = NAMERS.get(key);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat(locale, { ...opts, timeZone: zone });
    NAMERS.set(key, fmt);
  }
  return fmt.format(d);
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * Midnights apart IN THE READER'S ZONE. Positive = in the past; negative = dated in the future.
 *
 * The reader's midnights and not UTC's, because that is what "today" and "yesterday" mean to the
 * person reading. Banded on UTC, every message a Zurich reader received between their midnight and
 * 01:00 (02:00 in summer) was stamped with yesterday's weekday, and a message from 01:30 on the 1st
 * of a month was dated to the last day of the previous one.
 */
function daysAgo(d: Date, now: Date, zone: string): number {
  return zonedDayNumber(now, zone) - zonedDayNumber(d, zone);
}

/**
 * The prototype's row stamp for a message: "09:12" today, "Mon" this week, "2 Aug" beyond it.
 *
 * Fixture rows carry the prototype's own string in `time`; server-fed rows carry only
 * `date`, so every surface that shows a stamp has to derive one. It lives here — beside
 * the selectors that build display DTOs — rather than in the web app, because
 * `screenerSegments()` mints `ScreenerSenderDTO.time` and `ScreenerHeldMail.time` for
 * senders that have no fixture row at all.
 *
 * ── A WEEKDAY NAME ONLY MEANS SOMETHING FOR SIX DAYS ────────────────────────────────────
 *
 * This used to answer `WEEKDAY_SHORT[d.getUTCDay()]` for EVERY message that was not from
 * today, so a message from March rendered as "Tue" — indistinguishable from one sent
 * yesterday, in a list sorted by date, which is the one place the reader is relying on the
 * stamp to tell things apart. Owner-reported.
 *
 * Seven bands would be over-thinking it; the rule is just that a label may not be reused
 * before it has stopped being unambiguous. "Tue" is unique within a six-day window and
 * repeats on the seventh, so that is exactly where it stops. Past that, the day-and-month
 * carries the year implicitly for the current year and explicitly outside it — a bare
 * "2 Aug" on a message from 2025 would be the same lie in a slower form.
 *
 * A FUTURE date (a resurfaced or scheduled row) takes the dated branch too: `daysAgo` goes
 * negative, and "Fri" for something that has not happened yet reads as the past.
 *
 * ── THE ZONE IS REQUIRED, AND THAT IS THE POINT OF IT ───────────────────────────────────
 *
 * Every band here is a statement about the reader's calendar, so it cannot be computed without
 * knowing which calendar that is. A DEFAULT would make the wrong answer the quiet one: a call site
 * that forgot would render a stamp — a plausible, well-formatted, two-hours-wrong stamp — and
 * nothing in the type system, the suite or the screen would say so. That is precisely how the UTC
 * version survived as long as it did. So there is no default, and a call site without a zone does
 * not compile; the engine's own tests pass `"UTC"` explicitly, which is what makes their UTC
 * expectations a choice rather than an accident.
 */
export function messageDisplayTime(
  m: Pick<EngineMessage, "time" | "date">,
  now: Date,
  /** The IANA zone the reader is in. REQUIRED — see above. */
  zone: string,
  /** Which language to name the day and month in. English by default — see {@link named}. */
  locale = "en",
): string {
  if (m.time) return m.time;
  if (!m.date) return "";
  const d = new Date(m.date);
  if (Number.isNaN(d.getTime())) return "";

  const f = zonedFields(d, zone);
  const ago = daysAgo(d, now, zone);
  if (ago === 0) return `${pad2(f.hour)}:${pad2(f.minute)}`;
  if (ago >= 1 && ago <= 6) return named(locale, { weekday: "short" }, d, zone);

  const stamp = `${f.day} ${named(locale, { month: "short" }, d, zone)}`;
  return f.year === zonedFields(now, zone).year ? stamp : `${stamp} ${f.year}`;
}

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
 * THE TEXT A SURFACE RENDERS, AND WHAT THAT TEXT ACTUALLY IS.
 *
 * Every reading surface used to write `m.body ?? m.snippet`, and on a live account that
 * expression has exactly one branch: `body` is a fixture-only extra, so a Cloud message
 * always fell through to the snippet and every pile rendered one line of every message as
 * though it were the whole thing. This is the one place that question is answered, and it
 * answers it with a {@link BodyState} so no caller has to guess.
 *
 * ── READ-TIME MERGE, NOT A WRITE ───────────────────────────────────────────────────────
 *
 * The hydrated text lives in a separate `message_body` record precisely so that a `/sync`
 * delta for the message cannot replace it (see {@link MessageBodyRecord}). The cost of that
 * is one join, here, and it is the reason a body survives the `mark_seen` echo that opening
 * the message emits.
 *
 * ── PRECEDENCE, AND WHY `m.body` IS FIRST ──────────────────────────────────────────────
 *
 * The fixture world's rows carry their full text already. Checking the message first means
 * the demo never consults a record, never has one, and `hydrateBody` short-circuits on the
 * same field — so "the demo performs zero requests" is one fact in two places that read the
 * same source, rather than two rules that have to be kept in agreement.
 *
 * ── PROTECTED MAIL IS NOT SPECIAL-CASED HERE, DELIBERATELY ─────────────────────────────
 *
 * A sensitive message's stored body is redacted server-side, so the text
 * this returns for one is already safe — and `message.protected` is routed through
 * `ProtectedBlock` by the SURFACE, unchanged, which is where that decision has always
 * lived. Moving it in here would mean two places deciding what a protected message shows,
 * and the surface would still need its branch for the fixture case.
 *
 * ── `ready` WITH EMPTY TEXT IS STILL `full` — unless the server SAID why it is empty ────
 *
 * `getBody` answers `text: ""` for a message whose body row was never ingested. That is
 * reported as `full` rather than falling back to the snippet, because the snippet is
 * DERIVED from the body at ingest — the two arrive together — so "an empty body next to a
 * populated snippet" is not a state the pipeline produces, and inventing a fallback for it
 * would mean rendering a preview while claiming it is the whole message. The empty case
 * renders empty, which is what the server has.
 *
 * The storage cap created exactly the state that argument said could not exist — an empty
 * body BESIDE a populated snippet (the snippet is on the message row; the body content was
 * declined) — and the server now says so on the wire (`withheld: "storage_cap"`). That
 * record reports `state: "withheld"` with the SNIPPET as its text: a real preview exists,
 * and rendering nothing while a preview is in hand would waste the one thing the cap kept.
 * Terminal like `full`, honest like `failed`, and neither: no Retry, no claim of
 * completeness.
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
 * ONE SPELLING FOR A MESSAGE-ID — strip one pair of RFC 5322 angle brackets, trim, KEEP the case.
 *
 * The two sides of the optimistic-sent reconcile spell the same id differently: the send
 * confirmation's `providerMessageId` is the minted header, `<id@domain>`, while the ingested
 * row's `messageIdHeader` comes back bracket-stripped (server ingest normalises it exactly this
 * way). Comparing the raw strings therefore NEVER matched, and the optimistic copy was only ever
 * retired by its ten-minute TTL — the just-sent message stood twice in its conversation and in
 * Earlier until then. Both sides go through this before any comparison.
 *
 * Case is preserved for the same reason ingest preserves it: `id-left` is a case-sensitive atom,
 * and folding it would equate ids a sender chose to distinguish.
 *
 * DEFINED HERE (it lived in `mutations.ts`, which re-exports it) because {@link threadOf}'s twin
 * collapse is a consumer and `mutations.ts` imports from this file — the one direction the
 * dependency may point.
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
 * COLLAPSE THE SELF-SEND TWINS — members sharing a `messageIdKey` are ONE message, one panel.
 *
 * A self-send legitimately puts one logical message in the mirror twice: the optimistic Sent
 * copy stands beside the ingested row until the reconcile retires it (and for up to a drain
 * after the row lands), and a provider that re-renders its Sent filing (Exchange files its own
 * copy of every SMTP submission) can defeat the server-side collapse outright — two REAL rows,
 * one Message-ID, one thread. Rendered plainly, that is twin identical panels in the reading
 * pane. The Message-ID is the one identity both copies carry, so it is the collapse key; a row
 * with NO header never collapses, because absence is not an identity two strangers can share.
 *
 * `members` arrives in reading order and leaves in reading order — the survivor keeps its
 * place; nothing is re-sorted.
 */
function collapseTwins(members: EngineMessage[], openId: string): EngineMessage[] {
  const keeper = new Map<string, EngineMessage>();
  for (const m of members) {
    if (!m.messageIdHeader) continue;
    const key = messageIdKey(m.messageIdHeader);
    const held = keeper.get(key);
    keeper.set(key, held ? preferTwin(held, m, openId) : m);
  }
  return members.filter(
    (m) => !m.messageIdHeader || keeper.get(messageIdKey(m.messageIdHeader)) === m,
  );
}

/**
 * THE CONVERSATION a message belongs to, oldest first.
 *
 * `threadId` is populated at ingest, and until this selector existed nothing rendered it.
 * This is the one place the grouping is computed.
 *
 * ── THE EMPTY ARRAY IS A CONTRACT, NOT A DEGENERATE CASE ────────────────────────────────
 *
 * A message with no `threadId`, and a message that is the SOLE member of its thread, both
 * answer `[]`. They are the same fact to a reader — there is no conversation here — and
 * collapsing them means a caller cannot accidentally render "1 message" chrome around a
 * message that has no conversation. Every consumer's condition is `length > 0`; none of
 * them has to know that a thread of one exists in the mirror.
 *
 * NO FOLDER FILTER. A conversation legitimately spans folders: a stranger's first mail sits
 * in `ohmail/Screener` while their accepted follow-ups land in the Ohbox, and hiding the
 * held one would be the reader lying about what it has. The Sent folder is the other side of
 * that coin: the worker watches it now, so the user's own replies ride the mirror under the
 * SERVER'S own folder name — `Sent Items`, `Sent Messages`, `INBOX/Sent`, `[Gmail]/Sent Mail` —
 * and the absence of a folder filter is what keeps them in the conversation they belong to.
 * (This paragraph used to say Sent was not watched; the Sent-folder watch made that false.)
 *
 * O(n) over the mirror, like every selector here. Do NOT call it per row to build list
 * badges — that is O(n²) over a mailbox of any size and wants a one-pass count selector instead.
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
 * ONE date-desc sort of the whole mirror per (reader, version) — the order every whole-mirror
 * selector shares.
 *
 * Every selector here is called once per version bump, and most of them used to end in their
 * own `.sort(byDateDesc)` over the whole mirror — so a single mutation's bump paid for the
 * same sort roughly eight times, which on a mailbox tens of thousands deep was the dominant
 * term of the long task a scroll-time read-mark produced. A `filter` of a sorted array is
 * sorted, and {@link byDateDesc} is total (its own header carries the argument), so deriving
 * each selector's slice from one shared order is byte-identical to sorting each slice.
 *
 * Keyed WEAKLY on the reader object and invalidated by `version()`: `engine.read()` returns
 * one stable view for the life of the engine, and a projection (`presentationReader`) is
 * memoized by its consumer per version, so entries die with their readers and a stale version
 * can never serve. The cached array is FROZEN in spirit — callers filter it, never mutate it;
 * `.filter`/spread copies are what leave this function.
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
   * THE REPAIR PATH — most bumps do not move the order, so do not pay the sort for them.
   *
   * A read-mark, a body arriving, a label flip: the common mutations change FIELDS on rows
   * whose ids and dates stay exactly what they were, and the date order is invariant under
   * every one of them. When the previous order's membership (same ids, same count) and every
   * row's date survive, the new order IS the old order with fresh entities substituted in —
   * one pass and a Map, instead of a whole-mirror sort per bump. Anything else — an arrival,
   * a prune, an edited date — falls through to the honest sort. Correctness does not depend
   * on classifying the mutation: the repair VERIFIES membership and dates itself, and
   * `date-order-cache.test.ts` pins both fallthroughs.
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
 * WHICH MAILBOX A FRESH COMPOSE SENDS FROM.
 *
 * A reply inherits its mailbox from the message it answers. A compose has no parent, and the
 * server will not guess: `POST /drafts` requires a `mailboxId` that belongs to the account
 * (`drafts-service.ts` → `validMailbox`), and `SendService` uses that mailbox's own address as
 * the `From`. So the client has to name one.
 *
 * ── WHY IT IS DERIVED FROM MAIL AND NOT FROM A MAILBOX LIST ─────────────────────────────
 *
 * There is no mailbox list to read on a Cloud account. `"mailbox"` is not an entity type in
 * the change log, so `/sync` never emits one and the mirror
 * holds `mailbox` rows ONLY where the FixturesAdapter seeded them — the demo and Desktop.
 * `GET /mailboxes` exists but lives behind the Cloud client's API layer, which the shared shell
 * may not import (it is not part of the Desktop bundle). What every account DOES have is mail, and
 * every message carries the `mailboxId` it arrived in.
 *
 * So: a seeded `mailbox` entity when there is one, else the mailbox holding the account's
 * NEWEST message. Newest rather than "the first one `list()` happens to return", because the
 * order of a mirror scan is not a fact about the user and this answer decides whose address a
 * stranger sees in their From line.
 *
 * ── THE LIMIT THAT USED TO BE STATED HERE IS NOW CLOSED ────────────────────────────────
 *
 * This paragraph said "with two mailboxes connected this picks one of them and offers no way to
 * choose", filed as owed. It was worse than owed: nothing on the compose surface said WHICH one,
 * so the From flipped with whichever address last received mail and no screen mentioned it.
 *
 * The picker exists. `apps/webapp/app/shell/compose-from.ts` owns the rule — a fresh compose
 * defaults to the OLDEST CONNECTED mailbox, a reply keeps the one the message arrived in, and
 * the value is a mailbox id — over the account's real mailboxes, which the Cloud shell reads
 * from `GET /mailboxes` and hands to the shared shell through `MailStateProvider` (the prop
 * threaded from the Cloud shell this note called for; no new `/sync` entity type was needed).
 *
 * SO THIS FUNCTION IS NOW THE LAST RESORT AND NOT THE ANSWER. It is reached only where nothing
 * can name the account's mailboxes at all — the Desktop, and a Cloud tab in the moment before
 * its first mailbox poll lands — and in exactly those cases there is no From line on screen for
 * it to contradict. `Engine.enrich` still falls back to it for a `mail_send` that carries no
 * `mailboxId`, which is what keeps a send possible there rather than refused.
 *
 * `null` ⇒ this account has nothing to send from yet (a mailbox that has not finished its
 * first sync). The compose surface refuses rather than posting a draft the server will 400.
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
 * A MESSAGE THE ACCOUNT ITSELF WROTE.
 *
 * The worker watches the Sent folder, so the account holder's own mail rides the mirror like any
 * other row — but it keeps its ARRIVAL folder (the pipeline never refiles Sent). So the question
 * is which mirrored folder is the mailbox's Sent folder, and it is asked POSITIVELY, of the path:
 * {@link isSentFolderPath} recognises every canonical form the worker's own Sent resolver can
 * produce, and it is the SAME value the server's folders inventory excludes from the user-folder
 * class (`packages/services/src/folders.ts`) — one regex, one home (`@trafficflow/core/types`).
 *
 * ── WHY IT IS NOT `!VIEW_OF_FOLDER[m.folder]` ANY MORE ──────────────────────────────────────
 *
 * That is what it was, on the premise — written out here — that "the Sent folder is the only one
 * the worker observes that is NOT one of the six organised ohmail views". The premise is false:
 * the passive read mirrors the mailbox's WHOLE folder tree, and it does so whether or not the
 * account has "Use folders" on (the flag gates the `folder` ENTITY, never the mail). So the
 * negative test answered "the account wrote this" for every folder a mailbox happens to have —
 * a provider's `Promotions`, a project folder, an archive tree — and {@link ohboxView} unions
 * own-sent mail into "Earlier", so all of it landed in the Ohbox.
 *
 * The shape that produces, on any mailbox with folders in it: a QUARTER of "Earlier" can be mail
 * the reader filed rather than mail they wrote. And because {@link readTimeOf} hands an own-sent
 * row its own DATE as a reading time, those rows rank against real read stamps — so one pass that
 * adopts a batch of externally observed `\Seen` flags stamps them all at the same instant and
 * lifts a block of months-old filed mail to the TOP of the Ohbox, above everything that has
 * arrived since. `apps/webapp/app/shell/format.ts#sentRowRecipient` labels them "Me → …" for good
 * measure. Both halves were observed on a real mailbox before this changed.
 *
 * ── WHAT THIS SHARES WITH THE SERVER, INCLUDING THE RESIDUAL ────────────────────────────────
 *
 * A Sent folder advertising SPECIAL-USE under a name neither belt knows is not recognised here
 * either, and that account's sent mail is absent from "Earlier" until the resolved Sent path is
 * persisted (the hand-off `packages/services/src/folders.ts` already names). That is the same
 * residual the folders inventory carries, in the same direction — a row missing from one list —
 * and it is bounded by the mailbox's own naming, where the old rule was unbounded by anything.
 *
 * These rows land already `\Seen` (the pipeline forces it — nothing you wrote is new to you), so
 * they never belong in "New for you"; {@link ohboxView} files every one of them under "Earlier".
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
 * ═══ READ STATE AS EVERY SURFACE DRAWS IT — RESURFACE IS UNREAD, DERIVED ═════════════════
 *
 * Owner ruling, 2026-08-31: "resurfaced messages should always be marked as unread, until they
 * are done / replied to." This is the ONE place that rule lives, and it is a DERIVATION rather
 * than a stamp — which is the whole of why it can be true on two screens at once.
 *
 * ── WHY NOT A STAMP: THE HISTORY THIS CORRECTS ──────────────────────────────────────────
 *
 * The product has now tried both stamps. The FIRST was the worker's: `bubbleUpPass` forced
 * `messages.unread = true`, cleared `lastReadAt` and queued a `\Seen` removal against the real
 * mailbox, with a rescue pass re-applying the mark to rows it judged had missed it. That is the
 * flip-flopping this was reported for — the pass and the reader argued, cycle after cycle, over a
 * row the reader had just read. It was removed on 2026-08-26 (`bubbleUpPass`,
 * `TriageService.setState`, `mutations.ts` triage_set), and the reading now sticks.
 *
 * What was ALSO removed with it was the attention signal the pin is FOR, and the
 * ruling above puts it back — WITHOUT the stamp. Nothing writes read state to say a row is
 * resurfaced; the row's placement already says it, and this reads that placement. So:
 *
 *   · no pass can fight the user, because no pass writes anything;
 *   · no `\Seen` intent is queued, so the user's other mail clients are left alone — the
 *     mailbox stays the master, and a resurface is a fact about OUR triage, not about theirs;
 *   · the presentation cannot race the mirror, because it is computed from the mirror;
 *   · a GLANCE (the Ohbox's two-second dwell) still lands its read and still does not spend the
 *     pin, and the row does not visibly change under the reader — which is exactly the
 *     flip-flop the 2026-08-26 change was reported for. The genuine read is recorded; it simply
 *     is not what this row is drawn from while it is pinned.
 *
 * ── WHAT RELEASES IT ────────────────────────────────────────────────────────────────────
 *
 * Anything that clears `triage.state` away from `resurfaced`: Done (`resurface_done`), a reply
 * settling, and every other DELIBERATE verb that already spends the pin (the read pill, `⇧I`,
 * bulk read, read-all, move, delete). After the release the row's GENUINE read state applies,
 * unchanged — which is the second half of the ruling, and it needs no code of its own because
 * this function stops answering `true` the moment the state is gone.
 *
 * ── PRESENTATION ONLY. IT MUST NEVER REACH A WRITE OR A COUNT OF REAL MAIL ──────────────
 *
 * Every caller here is drawing something. The things that ACT on read state — `commitPendingRead`
 * re-judging the debt, `markRead`, mark-all-read's id list, the Ohbox header's "N new", the
 * per-folder unread badges — keep reading `m.unread`, the stored flag. Feeding this into any of
 * them would mark a message read that was never read (mark-all-read), or claim mail is new that
 * is not (the header), which is the same class of lie the stamp was.
 */
export function presentsUnread(m: Pick<EngineMessage, "unread" | "triage">): boolean {
  return isResurfaced(m) || m.unread;
}

/**
 * WHICH BOTTOM PILE A TRIAGE STATE FILES INTO — the ONE answer, for the lister and the filter.
 *
 * {@link triagePiles} calls this to decide which pile a record joins, and {@link parkedMessageIds}
 * calls it to decide which rows the Ohbox holds out. That is the whole reason it is a named
 * function rather than the ternary it used to be inside `triagePiles`: those two questions are the
 * same question asked from opposite ends, and while they were two expressions they gave two
 * answers. A message with a `bubbled_up` record was filed under Resurface by the lister and left
 * standing in the Ohbox by the filter — one mail in two piles, which is the state the product
 * exists to make impossible. See {@link ohboxView} for what that looked like on screen.
 *
 * `resurfaced` is deliberately NOT here and answers `null`: a resurfaced row belongs to no bottom
 * pile — it is back at the TOP of the Ohbox, in {@link OhboxView.resurfaced} — so it is not parked
 * and the Ohbox must not hold it out. `muted` and `none` answer `null` for the plainer reason that
 * no pile renders them.
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
 * THE WINNING `message_state` CLAIM PER MESSAGE — one record per message, newest claim first.
 *
 * ── ONE MESSAGE, ONE CLAIM ────────────────────────────────────────────────────────────────
 *
 * The mirror can briefly hold TWO `message_state` records for one message under different
 * record ids: the live server keys the entity by the `message_states` ROW's uuid
 * (`TriageService.setState` emits `entityId: row.id`), while an optimistic effect that found
 * no settled record yet keys by the only id it has — the message's. A poll drain landing the
 * settled row while that overlay still stands is therefore two records saying "this message
 * is parked", and a pile that renders records verbatim counts the message twice — the rail
 * badge inflating past the pile it renders beside (a drag-park was measured at 6-vs-1 on a
 * live account, corrected only by reload). The message is the unit a pile is ABOUT, so the
 * message is the dedup key; when two records disagree, the NEWEST `updatedAt` is the latest
 * claim and ties keep the later-listed record (the overlay reads after the store, so the
 * user's own in-flight intent wins a tie — user-always-wins).
 *
 * EXTRACTED so {@link triagePiles} and {@link parkedMessageIds} cannot disagree about which
 * claim is current. Two copies of this loop would be two answers to "is this message parked",
 * and the one the reader saw would depend on which surface asked.
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
 * EVERY MESSAGE PARKED IN A BOTTOM PILE — the set the Ohbox holds out of all three of its groups.
 *
 * ── A MAIL IS IN EXACTLY ONE PILE, AND THIS IS WHAT MAKES THAT STRUCTURAL ──────────────────
 *
 * The Ohbox used to hold out only {@link isResurfaced} rows, which closed one case of a general
 * hole: `triagePiles` files a row under a bottom pile from its `message_state` record, and
 * `ohboxView` grouped by FOLDER and knew nothing about that record. So ANY parked row still
 * sitting in the Ohbox folder — every `reply_later`, every `set_aside`, every not-yet-due
 * `bubbled_up` — was listed in a bottom pile AND in the Ohbox at the same time. Nothing moves a
 * parked message's folder (`TriageService.setState` writes state and never `folder_state`), so
 * this was not an edge case: it was every parked message the product has ever had.
 *
 * The way it was reported is the sharpest form of it. Deferring an ALREADY-RESURFACED row —
 * "resurface tomorrow" on a row sitting in the pin group — writes `bubbled_up` while the row
 * still carries the forced `unread: true` its resurface put there (`mutations.ts` re-unreads for
 * `resurfaced` only, so nothing takes it back). The row left the pin group, was filed under
 * Resurface by the pile lister, and reappeared at the TOP OF THE OHBOX under "New for you" —
 * bold, as if it had just arrived — then sank into "Earlier" when its read state settled, still
 * listed under Resurface the whole time. The user put it away and the product handed it back.
 *
 * Derived from {@link winningStates} through {@link pileOfState} — the SAME two steps
 * {@link triagePiles} takes to build its rows — so the filter and the lister are one derivation
 * and cannot drift. A row this set contains is in a bottom pile by construction, and a row it
 * does not is in none.
 */
export function parkedMessageIds(reader: EntityReader): Set<string> {
  const parked = new Set<string>();
  for (const [messageId, st] of winningStates(reader)) {
    if (pileOfState(st.state)) parked.add(messageId);
  }
  return parked;
}

/**
 * "EARLIER" IS A HISTORY OF READING, SO IT IS ORDERED BY READING.
 *
 * `messagesIn` sorts date-descending, which is right for mail that has not been read — the
 * question there is what arrived — and wrong for mail that has. Someone who reads a message from
 * last week and then one from this morning has most recently finished with the older one, and a
 * date sort files it seven days down, under mail they finished with days ago.
 *
 * ── EVERY UNSTAMPED ROW SORTS BELOW EVERY STAMPED ONE ─────────────────────────────────────
 *
 * `lastReadAt` is absent or null on two kinds of row: mail read before the field existed, and mail
 * whose read state came from somewhere that could not date it. Neither has an honest position
 * among the stamped rows, and interleaving them BY DATE would put a message with no recorded
 * reading time above one with a real one purely because it is newer — a claim about reading order
 * made out of a send time. So the list is two blocks: what is known, most recently finished first;
 * then, below it, what is not, newest first. The boundary moves down on its own as mail is
 * re-read, and it needs no backfill to do it.
 *
 * `id` breaks the remaining ties, because a batch marked read in one gesture shares one instant
 * and a comparator that returned 0 there would leave the browser's sort free to reorder equal rows
 * differently on each render.
 */
/**
 * The reading instant as a number, or `null` for "not known".
 *
 * THREE INPUTS COLLAPSE TO ONE ANSWER and that is the reason this is a function rather than a
 * `Date.parse` inline in the comparator: the field can be absent (a mirror written before it
 * existed), explicitly `null` (never read, or read where nothing could date it), or a string that
 * does not parse. All three mean the same thing to a reader, so they have to mean the same thing
 * to the sort. Normalising here — instead of handling `null` in the comparator and NaN separately
 * — is what stops an unparseable stamp from being ranked as a real one against a `null` row, and
 * keeps it from being read as the epoch, which is a position that looks deliberate and is not.
 *
 * ── OWN-SENT MAIL IS STAMPED BY WHEN IT WAS SENT, AND THAT IS A READING TIME ──────────────
 *
 * Nothing anywhere stamps `lastReadAt` on outbound mail, and nothing should: the ingest creates
 * a Sent row already read — nothing you wrote is new to you — but with no reading INSTANT, since
 * there was never a moment somebody opened it; and the optimistic copy the engine mints on a
 * confirmed send has none either. So EVERY sent message an account has ever had was unstamped,
 * and the rule above — an unstamped row sorts below every stamped one — put the message the
 * reader had pressed Send on ten seconds ago underneath everything they had ever opened. On a
 * live account that is hundreds of rows down, outside the mounted window: in the list, and not
 * findable, which a reader cannot tell apart from not being there.
 *
 * The fix is not an exemption from the reading order — it is the observation that WRITING a
 * message is finishing with it. The send time is the instant the reader last dealt with that
 * mail, exactly as a read time is for mail somebody else wrote, so it belongs in the same block
 * and ranks against the same numbers: a message sent five minutes ago sits above one read an
 * hour ago, and below one read a minute ago. That is a claim about the reader's own activity,
 * derived from something they did, which is what separates it from the fallback this comment's
 * first paragraph refuses — an inbound row's date says when a STRANGER acted.
 *
 * A stamp, when there is one, still wins: the date stands in for the missing value and never
 * overrides a present one, or re-reading your own sent mail could not move it.
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
 * A MAIL IS IN EXACTLY ONE PILE, and these three groups plus the three bottom piles are the six.
 *
 * Every group here holds out {@link parkedMessageIds}, so mail the reader filed under Answer Later,
 * Set aside or Resurface is absent from all of them — see that function for the double presentation
 * this closes and how it was reported. The consequence is deliberate and worth stating plainly:
 * parked mail leaves "Earlier" as well as "New for you". Putting a message away takes it out of the
 * Ohbox; the pile you put it in is where it is, and the only place it is.
 *
 * SCOPE: this is the only surface that holds parked rows out. Reads and Receipts are STREAMS rather
 * than piles and still list a parked issue — `openTargetFor` (`apps/webapp`) depends on that
 * asymmetry, and `search-locate.test.ts` pins it.
 */
export function ohboxView(reader: EntityReader): OhboxView {
  // The shared date-desc order (`messagesByDateDesc`): a filter of it is newest-first by
  // construction, so the groups below carry no sorts of their own any more.
  const all = messagesByDateDesc(reader);
  const inbox = messagesIn(reader, FOLDER_OF_VIEW.ohbox);
  // the account's own sent mail, folder-agnostic (see `isOwnSent`), newest first.
  const sent = all.filter(isOwnSent);

  /**
   * THE PIN IS STATE-DRIVEN AND FOLDER-AGNOSTIC, and the whole mirror is scanned for it —
   * not just the INBOX slice above. `resurfaced` is a claim the USER made about a message
   * ("show me this again now"), and its ONLY home in the product is this group: the state
   * belongs to no bottom pile by construction (`triagePiles` ignores it), so a resurfaced row
   * this group declines is a row NO view files. That was a real orphan, measured on a live
   * mailbox: a message snoozed for yesterday came due, left the Resurface pile with the flip,
   * and its folder-filtered pin never picked it up — reachable by search and by nothing else.
   * Filtering `inbox` here would keep exactly that bug for every row whose folder — physical
   * or presented (the consent cutline re-homes undecided senders' mail) — is not the Ohbox's.
   * Newest bubble first — the order the two groups below use for anything that has no reading
   * time to sort by.
   */
  const resurfaced = all.filter(isResurfaced);
  const pinned = new Set(resurfaced.map((m) => m.id));

  /**
   * MAIL THE USER PUT AWAY IS NOT IN THE OHBOX — the whole of {@link parkedMessageIds}, applied
   * to all three groups.
   *
   * Held out of the PIN group as well, and that is not redundancy: it is what makes "one pile"
   * a property of this function rather than a property of two states happening not to overlap.
   * `pileOfState("resurfaced")` is null, so a genuinely resurfaced row is never in this set and
   * the pin is untouched; but if a row ever carried a stale `resurfaced` projection on
   * `message.triage` while its winning `message_state` record said `bubbled_up`, the pile lister
   * would file it under Resurface and the pin would show it at the top — the same double
   * presentation, one entity over. Holding the parked set out of every group makes the bottom
   * piles authoritative wherever the two sources could disagree, which is the only way the
   * disjointness guard can be a statement about the derivation instead of about the fixtures.
   */
  const parked = parkedMessageIds(reader);
  const held = (m: EngineMessage): boolean => !pinned.has(m.id) && !parked.has(m.id);

  return {
    resurfaced: resurfaced.filter((m) => !parked.has(m.id)),
    // Unread mail is ordered by ARRIVAL, unchanged: nothing has been read, so there is no reading
    // order to use and the question the group answers is what came in. Resurfaced rows are held
    // out — they sit pinned above, never doubled here.
    newForYou: inbox.filter((m) => m.unread && held(m)),
    // "Earlier" is read INBOX mail joined by the account's own sent mail, ordered by when the
    // reader finished with each — for a sent row that is when it was SENT (see `readTimeOf`), so
    // the message somebody just pressed Send on is the first row here.
    // Pinned ids are held out of BOTH inputs, so a resurfaced row is never doubled below its pin.
    //
    // COLLAPSED BY Message-ID, for the same reason the reading pane is ({@link collapseTwins}).
    // A just-sent message legitimately stands in the mirror twice — the optimistic Sent copy
    // beside the ingested row the worker's Sent-folder watch delivers minutes later — and
    // `reconcileOptimisticSent` retires the copy only at the END of a drain. A backfill drain is
    // many pages and notifies after every one of them, so between the page carrying the real row
    // and the end of the drain the list rendered the same message twice; the same doubling is
    // reachable outright from a provider that files its own re-rendered copy of an SMTP
    // submission (Exchange). The reading pane has collapsed this ever since; the pile had no
    // such rule. No `openId` here: a pile has no open message, and the ranking's remaining terms
    // — a real row beats a `local: true` one, then reading order — are exactly what this wants.
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
 * THE PEOPLE IN A CONVERSATION, newest voice first.
 *
 * Distinct from {@link threadOf}, which returns the counterpart's MESSAGES for the reading pane.
 * This returns the SENDERS, de-duplicated by address, so a ten-mail exchange between two people
 * yields two circles rather than a "10" badge. Own-sent mail rides the mirror now (the Sent-folder
 * watch), so the account holder is one of the voices wherever they have written in the thread.
 *
 * Capped at {@link THREAD_PARTICIPANTS_MAX}: the row shows three circles and no more, and the
 * fourth would widen a slot the row holds at a constant width.
 *
 * `[]` for a message with no thread, or the sole member of one — the same "there is no
 * conversation here" contract {@link threadOf} keeps, so the caller renders circles only on a real
 * multi-message thread and never a lone circle standing in for a thread of one.
 *
 * O(mirror) per call, like every selector here. The Ohbox calls it only for the handful of rows
 * its window has mounted, and only for rows that carry a `threadId` — bounded by the window, not
 * the mailbox.
 */
export function threadParticipants(reader: EntityReader, threadId: string): EmailAddress[] {
  return participantsOfMembers(
    reader.list<EngineMessage>("message").filter((m) => m.threadId === threadId),
  );
}

/**
 * EVERY THREAD'S PEOPLE IN ONE PASS — the same answer as {@link threadParticipants}, for callers
 * that need MANY of them.
 *
 * {@link threadParticipants} scans the whole mirror to answer about one thread, which is the right
 * shape for a handful of rows and the wrong one for a list: five list surfaces asking per row is
 * O(mirror × rows) on every render, and the mirror is the largest thing the client holds. This
 * walks the messages ONCE, buckets them by thread and answers every thread at the same cost as
 * answering one. A caller memoizes it on the engine version and then reads rows out of the map in
 * constant time.
 *
 * Threads with no conversation of people in them — one member, or several from one sender — are
 * ABSENT from the map rather than present with `[]`, so a missing key and an empty answer are the
 * same thing and a lookup needs no second check.
 *
 * Both forms share {@link participantsOfMembers}, which is the point: two implementations of
 * "who is in this conversation" would be two answers, and the one the row draws would depend on
 * which surface drew it.
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
 * THE CONVERSATION'S NAME — the mirror's thread row's stored subject, or `null` while no
 * thread row for this id has synced.
 *
 * The server names a thread at CREATE with the localized reply/forward prefixes stripped
 * (`baseSubject`, `packages/core`), and a heal pass renamed the rows stored before that table
 * was complete — so the stored name is already clean, and the client deliberately does NOT
 * re-derive it: a second copy of the prefix table here would be a second definition to drift.
 *
 * `null` is a real state, not an error: snapshot pages carry the threads their OWN messages
 * name, so a mirror can briefly hold a message whose thread row is a page behind. The caller
 * falls back to a member message's subject until the row lands.
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
   * ═══ THE STREAM'S BADGE — ONE NUMBER, ONE DERIVATION, EVERY SURFACE ══════════════════════
   *
   * `fresh` that is STILL UNREAD. Not `fresh.length`, and not "every unread row in the pile" —
   * both of those shipped, on different surfaces, for the same badge.
   *
   * ── WHY THE COUNT MAY NOT BE `fresh.length` ────────────────────────────────────────────
   *
   * The anchor is CLIENT state and says so ({@link MessageMutation} `feed_mark_seen` — `/sync`
   * has no `view_meta` entity type), so each device carries its own "last visit". For the LINE
   * that is correct and load-bearing: it must hold still for the whole visit and move exactly
   * once, on the way out, or the list re-sorts under the reader. For a COUNT it is a lie the
   * moment two devices disagree — and it was reported as exactly that: one account open on a
   * desktop and in a browser, side by side, the browser's rail saying "Reads 13" and the
   * desktop's saying nothing, while the mail server held ZERO unread messages in that pile.
   * Both numbers were `fresh.length`. Only the anchors differed, and one was thirteen visits
   * stale.
   *
   * The mailbox is the master and it answers the question the badge is actually asking. A
   * message the server reports `\Seen` has been read — here, on the phone, in whatever client
   * the reader used — and read mail does not demand attention. So the badge is the intersection:
   * above this device's line AND unread on the server. Two devices with different lines agree
   * whenever the mail is read, which is the case that produced the report; where they still
   * differ, the mail really is unread and the smaller line is the honest one.
   *
   * It also keeps the LINE exactly where it was — nothing here moves `fresh`/`seen`, so
   * "a committed waterline outranks `\Seen`" (R10-5) is untouched and reading a row mid-visit
   * still does not re-partition the list under the cursor. Only the number drops, which is what
   * a badge is for.
   *
   * ── AND WHY IT MAY NOT BE "EVERY UNREAD ROW IN THE PILE" ────────────────────────────────
   *
   * That was the phone's answer (`liveReads`/`liveReceipts` counted `items.filter(unread)` over
   * the whole stream) while the shell's was `fresh.length`. Two surfaces, two derivations, one
   * badge: on a stream holding old unread mail below the line the phone demanded attention the
   * shell did not. The line means something — mail below it was on screen when you left — so the
   * count respects it.
   */
  newCount: number;
}

/**
 * One partition for both reading streams, around the view's own waterline row
 * (`waterlineIdOf` — the same mapping the `feed_mark_seen` effect writes through).
 *
 * The cut is EXCLUSIVE: `newestSeenId` was on screen at the end of the last visit, so it
 * belongs BELOW the line — a leave at the top of the pile yields `fresh: []`, the line above
 * everything, which is the honest "nothing new since you were here".
 *
 * WITHOUT A USABLE ANCHOR, `\Seen` FROM THE MAILBOX IS THE LINE. A live mirror holds no
 * waterline row until the first leave-commit writes one (`/sync` has no `view_meta` entity
 * type), and the committed anchor can vanish — it is usually a READ message, and deleting
 * read mail is ordinary. Both absences used to degrade to everything-fresh, which over a
 * mirror built from an EXISTING mailbox presented years of already-read mail as "new since
 * last visit". The IMAP mailbox is the master: the fallback junction is the newest
 * already-read message — the R10-5 anchor semantic ("the newest message that was on screen
 * when the reader last left") extended to the visit that happened in the user's previous
 * client. A pile with no read mail in it stays everything-fresh, which is now a statement
 * about the mail rather than about a row that was never written. Either way the cut is
 * positional, so `[...fresh, ...seen]` is always the pile's display order — the receipts
 * junction arithmetic counts on that.
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

/**
 * The grouping key for a Screener sender — the address, case-folded.
 *
 * Shared with `mutationEffects`' `screener_decide` branch so the set of messages a
 * decision moves is exactly the set the row said it was holding, and with the server,
 * which lower-cases the same way (`screener-service.ts:118`, `:147`).
 */
export function senderKey(address: string): string {
  return address.trim().toLowerCase();
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
): ScreenerSegments {
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
