import { normalizeMessageId } from "./identity.js";
import type { RepoPort } from "./ports.js";
import type { EmailAddress } from "./types.js";

/* ══════════════════════════════════════════════════════════════════════════════════════════
   THREADING
   ══════════════════════════════════════════════════════════════════════════════════════════

   ── WHAT WAS WRONG ─────────────────────────────────────────────────────────────────────────

   `messages.thread_id` was NULL on every row of the seeded test world and the `threads`
   table was empty. `ThreadService` can rename, mute and merge a thread and `materializeThread`
   can render one, but NOTHING in the product had ever created one — the column and the table
   were declared early and never written. So the threaded-conversation journey failed by
   construction: no conversation was reachable from any message, and the inline reply rendered
   a one-entry conversation list.

   ── THE KEY IS THE HEADER CHAIN, AND ONLY THE HEADER CHAIN ─────────────────────────────────

   `In-Reply-To` first, then `References` RIGHT TO LEFT — nearest ancestor first — matched
   against `messages.message_id_header`, ACCOUNT-SCOPED. A hit adopts that message's thread.

   **There is no subject fallback and there must never be one.** A false merge is worse than an
   unmerged singleton: "Re: invoice" from two unrelated senders is one of the most common
   subjects in any real mailbox, and merging them puts one correspondent's mail inside another
   conversation — visible, wrong, and not undoable by the user without a thread split we do not
   have. An unmerged singleton is merely a conversation that reads as two. `threading.test.ts`
   carries a guard for this that exists to fail a future "improvement", not to describe a bug.

   ── ACCOUNT SCOPING IS A SECURITY BOUNDARY HERE, NOT A TIDINESS RULE ───────────────────────

   A Message-ID is chosen by whoever sends the mail. Anyone can send you a message carrying
   `In-Reply-To: <a-header-they-guessed>`; if the lookup were not scoped to the account, a
   stranger could name another account's Message-ID and have their mail adopt that account's
   thread — which `materializeThread` then renders as one conversation. Account isolation is
   absolute, so the account predicate is in every statement and in the leading column
   of `messages_account_message_id_header_idx`, and `threading.test.ts` mutation-tests it.

   ── THE ANCHOR IS THE LEFTMOST REFERENCE, WHICH IS WHY OUT-OF-ORDER INGEST CONVERGES ───────

   IMAP hands messages over in UID order, which is arrival order at the server, which is not
   conversation order: a reply can be ingested before the mail it replies to (a backfill of a
   folder the user filed by hand, a re-sync after UIDVALIDITY changed, two mailboxes of one
   account draining in parallel). So a parent lookup MISS cannot mean "start a new
   conversation" — it has to mean "find or create the conversation this message belongs to".

   That is what `rootMessageIdHeader` is: the leftmost (oldest) entry of `References`, else
   `In-Reply-To`, else the message's own Message-ID. For a chain A <- B <- C <- D arriving as
   D, B, A, C every single message derives `a` — D's References are [A,B,C], B's are [A], A is
   its own root, C hits B directly — so all four converge on one `threads` row through the
   `(account_id, root_message_id_header)` unique index. Anchored on the RIGHTMOST reference the
   same four would derive `c`, `a`, `a`, `b` and split one conversation into three.
   ══════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * The longest message-id this code will look up or store, in bytes.
 *
 * **This is a wedge guard, not tidiness.** `threads_account_root_header_uq` and
 * `messages_account_message_id_header_idx` are btree indexes, and a btree index tuple cannot
 * exceed roughly 2704 bytes — Postgres raises `54000 index row size … exceeds maximum` on the
 * INSERT. `References` tokens are chosen by whoever sent the mail, so without a cap ONE hostile
 * message carrying a 3 KB reference aborts the persist transaction, the sync cursor never
 * advances (that is the pipeline's crash-safe design), and the worker re-plans the same message
 * for ever. The mailbox stops syncing and the cause is a header.
 *
 * 998 is RFC 5322's line-length limit, so no legitimately authored `msg-id` can exceed it, and
 * an over-long token is dropped rather than truncated — a truncated id would be a DIFFERENT id
 * that could collide with someone else's.
 */
export const MAX_MESSAGE_ID_BYTES = 998;

/** Under the btree ceiling, so it can be looked up and stored without wedging ingest. */
export function isStorableMessageId(id: string): boolean {
  return Buffer.byteLength(id, "utf8") <= MAX_MESSAGE_ID_BYTES;
}

/**
 * Every message-id (RFC 5322) in a header's raw values, normalized the way
 * `messages.message_id_header` is stored: bracket-free, lowercased, in order, deduped, and
 * capped at {@link MAX_MESSAGE_ID_BYTES}.
 *
 * Angle-bracketed tokens are extracted FIRST when any are present, because that is the only
 * form that survives a value containing whitespace, and `References` is by definition a
 * whitespace-separated list that may be folded across several header lines (hence
 * `string[]`, not `string` — `normalizeMime` keeps every occurrence).
 *
 * A value with no brackets at all — some senders emit a bare `In-Reply-To: id@host` — falls
 * back to splitting on whitespace and commas rather than being dropped, since
 * {@link normalizeMessageId} already accepts the bare form.
 */
export function parseMessageIds(values: readonly string[] | undefined): string[] {
  if (!values || values.length === 0) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string): void => {
    const id = normalizeMessageId(raw);
    // `normalizeMessageId` strips ONE bracket pair and otherwise returns what it was given, so a
    // degenerate `<>` comes back as the literal `<>`. A normalized id never contains a bracket.
    if (!id || id.includes("<") || id.includes(">")) return;
    if (isStorableMessageId(id) && !seen.has(id)) { seen.add(id); out.push(id); }
  };
  for (const raw of values) {
    const bracketed = raw.match(/<[^<>]+>/g);
    if (bracketed) { for (const b of bracketed) push(b); continue; }
    for (const token of raw.split(/[\s,]+/)) if (token) push(token);
  }
  return out;
}

/** The two facts the resolver derives from one message's headers. */
export interface ThreadKey {
  /**
   * Parent candidates in PRIORITY order: `In-Reply-To`, then `References` right-to-left
   * (nearest ancestor first). The first one that names an already-ingested message of this
   * account wins.
   */
  candidates: string[];
  /**
   * The conversation's anchor — leftmost `References`, else `In-Reply-To`, else the message's
   * own Message-ID. `null` only for a message carrying no Message-ID header at all, which
   * anchors nothing and is therefore always its own singleton.
   */
  rootMessageIdHeader: string | null;
}

/**
 * Derive {@link ThreadKey} from a message's own id and its raw headers.
 *
 * The message's OWN id is excluded from the candidate list. A sender that puts its own
 * Message-ID into `References` (malformed, but it happens) would otherwise find itself as its
 * own parent — harmless in this implementation, but only by accident, and an accident is not
 * a property.
 */
export function threadKeyOf(
  messageIdHeader: string | null,
  headers: Record<string, string[]> | null | undefined,
): ThreadKey {
  const h = headers ?? {};
  const inReplyTo = parseMessageIds(h["in-reply-to"]);
  const references = parseMessageIds(h["references"]);

  const ordered = [...inReplyTo, ...[...references].reverse()];
  const seen = new Set<string>();
  const candidates: string[] = [];
  for (const id of ordered) {
    if (id === messageIdHeader || seen.has(id)) continue;
    seen.add(id);
    candidates.push(id);
  }

  // `parseMessageIds` has already dropped over-long tokens, so falling through to the next
  // fallback is automatic. The message's OWN id is capped here for the same reason — an ingest
  // that would wedge the anchor index is better off with a NULL anchor and a singleton thread.
  const own = messageIdHeader && isStorableMessageId(messageIdHeader) ? messageIdHeader : null;
  const rootMessageIdHeader = references[0] ?? inReplyTo[0] ?? own;
  return { candidates, rootMessageIdHeader };
}

/** Everything {@link resolveThread} needs about one message. No IMAP, no MIME re-parse. */
export interface ThreadResolutionInput {
  accountId: string;
  messageId: string;
  messageIdHeader: string | null;
  headers: Record<string, string[]> | null | undefined;
  subject: string;
  /**
   * The addresses this message contributes to the conversation, unioned by lowercased address.
   *
   * The CALLER decides, because the two callers genuinely know different things. Ingest has the
   * parsed message and passes sender + recipients. The backfill has only what was persisted, and
   * `insertMessage` writes `messages.to_addresses` only from the recipients slice onward — every
   * row that predates it carries the column's `'[]'` default — so it passes the sender alone. That
   * asymmetry is real and is recorded here rather than hidden: a conversation resolved by the
   * backfill over OLD rows lists fewer participants than the same conversation would have if it
   * were ingested today. Newly ingested mail has the recipients on the row, so the gap stops
   * growing; it is not retroactively closed, and closing it would need the raw bytes.
   */
  participants: EmailAddress[];
  date: Date | null;
  /**
   * Emit a `message` update for THIS message when it gains a `thread_id`.
   *
   * False at ingest: `commitChange` records the `message` create immediately afterwards, in the
   * same transaction, and a client materializing that create reads the committed row — which
   * already carries the thread. True in the backfill, where the client's mirror holds the
   * message from a previous sync and has no other way to learn it joined a conversation.
   */
  emitMessageUpdate: boolean;
}

/** What the resolver did — the shape the callers log and the tests assert on. */
export interface ThreadResolution {
  threadId: string;
  /** A `threads` row was INSERTED (⇒ the `changes` list carries a `thread` create). */
  created: boolean;
  /** A header candidate named an already-ingested message of this account. */
  parentFound: boolean;
  /**
   * The delta rows this resolution OWES, in the order they must be appended — and deliberately
   * NOT written by {@link resolveThread} itself.
   *
   * ── THIS IS A LOCK-ORDER FIX, NOT AN API PREFERENCE ────────────────────────────────────
   *
   * `recordChange` → `allocateSeq` takes the account's `account_sync_state` ROW LOCK and holds
   * it to COMMIT. So a transaction that records one change excludes every other
   * change-recording transaction for that account for the rest of its life. If the resolver
   * recorded as it went, a 100-row backfill batch would take the seq lock on its first row and
   * then go on to lock a NEW `threads` row on its second — while a concurrent ingest holds that
   * `threads` row and waits for the seq lock. That is a genuine cycle, and Postgres resolves it
   * by aborting one side with 40P01.
   *
   * Handing the rows back moves every `recordChange` to the END of the caller's transaction, so
   * ingest and backfill both acquire ALL of their `threads` locks BEFORE the seq lock. One
   * order, no cycle, and the batch size stays where the ruling put it.
   */
  changes: ThreadChange[];
}

/** One delta row owed by a resolution. Mirrors `RepoChangeInput` minus the account. */
export interface ThreadChange {
  entityType: "thread" | "message";
  entityId: string;
  op: "create" | "update";
}

/**
 * Resolve, persist and announce the thread for ONE message. Pure DB — no network — and it must
 * only ever be called inside the caller's transaction: every write here and every
 * `change_log` row it records commit together or not at all.
 *
 * ── THE THREE OUTCOMES ─────────────────────────────────────────────────────────────────────
 *
 *  1. A candidate names an ingested message WITH a thread ⇒ adopt it. Nothing is created.
 *  2. A candidate names an ingested message with NO thread ⇒ there is nothing to adopt, so fall
 *     through to the anchor. The parent is left alone — see below.
 *  3. No candidate hits ⇒ find-or-create from the anchor. This is a MISS, not a new
 *     conversation: an out-of-order sibling may already have created the row. See the header.
 *
 * ── WHY OUTCOME 2 DOES NOT REACH OVER AND FILE THE PARENT ──────────────────────────────────
 *
 * It is tempting, and it would be the only place ingest writes to a `messages` row it did not
 * just insert — which is a lock-order inversion against the backfill's `FOR UPDATE` page and
 * therefore a deadlock. It is also unnecessary, because the anchor is DETERMINISTIC: the parent
 * derives the same `rootMessageIdHeader` its child just derived (leftmost References, else
 * In-Reply-To, else its own id — a prefix relationship along one chain), so when the backfill
 * reaches it, `ON CONFLICT` puts it in the thread the child already created. Convergence
 * without a write, which is the whole reason the anchor exists.
 */
export async function resolveThread(
  repo: RepoPort,
  input: ThreadResolutionInput,
): Promise<ThreadResolution> {
  const { accountId, messageId } = input;
  const key = threadKeyOf(input.messageIdHeader, input.headers);

  const parent = key.candidates.length > 0
    ? await repo.findThreadParent(accountId, key.candidates)
    : null;

  const participants = input.participants.filter((p) => p.address);
  const changes: ThreadChange[] = [];

  let threadId: string;
  let created = false;

  if (parent?.threadId) {
    threadId = parent.threadId;
  } else {
    const upserted = await repo.upsertThread({
      accountId,
      rootMessageIdHeader: key.rootMessageIdHeader,
      subject: baseSubject(input.subject),
      participants,
      lastMessageAt: input.date,
    });
    threadId = upserted.id;
    created = upserted.created;
    if (created) changes.push({ entityType: "thread", entityId: threadId, op: "create" });
  }

  // A thread this message JOINED still has to learn about it: `last_message_at` orders every
  // conversation list, so a thread whose newest reply never moved it sorts as though the reply
  // had not arrived. Skipped when we just created the row — the insert already carried both
  // fields, and `mergeThreadMessage` would be a locked read that changes nothing.
  if (!created && await repo.mergeThreadMessage(threadId, { participants, lastMessageAt: input.date })) {
    changes.push({ entityType: "thread", entityId: threadId, op: "update" });
  }

  const attached = await repo.setMessageThread(messageId, threadId);
  if (attached && input.emitMessageUpdate) {
    changes.push({ entityType: "message", entityId: messageId, op: "update" });
  }

  return { threadId, created, parentFound: parent !== null, changes };
}

/**
 * The reply and forward subject prefixes the localized mail clients emit — ONE table, because
 * the cost of a per-incident list was measured in production: a thread created from a German
 * Outlook forward was named "WG: Webshop" while the same client's replies ("AW:") were
 * stripped, so one conversation's name kept a prefix its siblings lost. The set below is the
 * documented Outlook/Thunderbird localization table, not the languages we have happened to see.
 *
 * Longest token first, so the regex alternation never stops at a prefix of a longer token.
 * The one- and two-letter entries ("R:" it-reply, "I:" it-forward, "PD:" pl-forward) look like
 * false-positive bait, but the anchor requires the token to be the ENTIRE word before the
 * colon — "Item:", "Reserve:", "Password:" and an "R" followed by a digit all survive, and
 * the test table pins them. "WG:" is genuinely ambiguous in German (Wohngemeinschaft), and the forward reading
 * still wins: this function only NAMES a thread at create, so the worst case is a flat-share
 * ad losing two letters, never a merge.
 */
const SUBJECT_PREFIX_TOKENS = [
  "doorst",           // nl forward (kept with its reply sibling "antw" for reviewability)
  "antw",             // nl reply ("Antw.:")
  "fwd", "fw",        // en forward
  "res",              // pt reply
  "enc",              // pt forward
  "odp",              // pl reply
  "ynt",              // tr reply
  "ilt",              // tr forward ("İlt:" with the dotted İ does not case-fold to this; the
                      //             ASCII form is what crosses locale boundaries)
  "atb",              // cy reply
  "yml",              // cy forward
  "bls",              // id reply
  "re",               // reply, international
  "aw",               // de reply
  "wg",               // de forward
  "sv",               // sv/da/no/is reply
  "vb",               // sv forward
  "vs",               // fi reply; no/da forward
  "vl",               // fi forward
  "fs",               // is forward
  "tr",               // fr forward
  "rv",               // es forward
  "pd",               // pl forward
  "vá",               // hu reply
  "r",                // it reply
  "i",                // it forward
  "回复", "回覆",      // zh-Hans / zh-Hant reply
  "转发", "轉寄",      // zh-Hans / zh-Hant forward
] as const;

/**
 * One prefix occurrence: the token, an optional abbreviating dot ("Antw.:"), an optional
 * bracketed count ("RE[2]:"), optional space before the colon ("RE :" — fr Outlook), and
 * either the ASCII or the fullwidth colon (zh clients emit "：").
 *
 * EXPORTED AS A STRING because the anatomy has a second, non-JS consumer: the thread-name
 * heal pre-filters candidate rows in SQL (`subject ~* …`), and Postgres AREs understand this
 * exact syntax — `(?:…)`, `\s`, `\d` and the bracket expression included. One definition, two
 * engines; the JS regex below and the SQL predicate can never drift apart.
 */
export const SUBJECT_PREFIX_PATTERN =
  `^(?:${SUBJECT_PREFIX_TOKENS.join("|")})\\.?\\s*(?:\\[\\d+\\])?\\s*[:：]`;

const SUBJECT_PREFIX_RE = new RegExp(`${SUBJECT_PREFIX_PATTERN}\\s*`, "i");

/**
 * A conversation's subject without the reply/forward prefixes, for naming a thread whose first
 * ingested message happens to be a reply or a forward — which out-of-order arrival makes
 * ordinary. NAMING ONLY: thread identity is the header chain and nothing else (see the module
 * header), so an over- or under-stripped subject can never merge or split a conversation.
 *
 * Only ever used at CREATE. A thread's subject is never overwritten afterwards, because
 * `POST /threads/:id/rename` is a user write and ingest may not silently undo one.
 */
export function baseSubject(subject: string): string {
  let s = subject.trim();
  // Iterated rather than a single greedy regex: real mail carries stacks like
  // "Re: AW: AW: …", and the languages MIX — a Gmail "Re:" lands on top of Outlook's "AW:".
  for (;;) {
    const next = s.replace(SUBJECT_PREFIX_RE, "");
    if (next === s) return s;
    s = next;
  }
}
