import { normalizeMessageId } from "./identity.js";
import { isCorroboratedCounterparty, type CounterpartyEvidence } from "./sender-headers.js";
import type { RepoPort } from "./ports.js";
import type { EmailAddress } from "./types.js";

/**
 * Threading: at ingest, thread identity is the header chain and ONLY the header chain —
 * `In-Reply-To` first, then `References` right to left, ACCOUNT-SCOPED; a hit adopts that thread.
 * No subject fallback, ever: "Re: invoice" from two unrelated senders is common and a false merge
 * is not undoable — `threading.test.ts` guards this and mutation-tests the account predicate.
 * Scoping is a security boundary: a Message-ID is sender-chosen, so an unscoped lookup would let
 * a stranger's `In-Reply-To` adopt another account's thread. The anchor is the LEFTMOST reference
 * (else `In-Reply-To`, else own id), so out-of-order ingest converges on one `threads` row via
 * the `(account_id, root_message_id_header)` unique index.
 */

/**
 * The longest message-id this code will look up or store, in bytes. A wedge guard: the two btree
 * indexes cap a tuple at roughly 2704 bytes and Postgres raises `54000` on the INSERT —
 * `References` tokens are sender-chosen, so without a cap ONE hostile 3 KB reference aborts the
 * persist transaction, the sync cursor never advances, and the worker re-plans the same message
 * for ever: the mailbox stops syncing because of a header. 998 is RFC 5322's line-length limit,
 * so no legitimately authored `msg-id` exceeds it; an over-long token is DROPPED, not truncated —
 * a truncated id is a DIFFERENT id that could collide.
 */
export const MAX_MESSAGE_ID_BYTES = 998;

/** Under the btree ceiling, so it can be looked up and stored without wedging ingest. */
export function isStorableMessageId(id: string): boolean {
  return Buffer.byteLength(id, "utf8") <= MAX_MESSAGE_ID_BYTES;
}

/**
 * Every message-id (RFC 5322) in a header's raw values, normalized the way
 * `messages.message_id_header` is stored: bracket-free, lowercased, in order, deduped, capped at
 * {@link MAX_MESSAGE_ID_BYTES}. Angle-bracketed tokens are extracted FIRST when present — the
 * only form that survives a value containing whitespace, and `References` is a
 * whitespace-separated list that may be folded across lines (hence `string[]`: `normalizeMime`
 * keeps every occurrence). A value with no brackets (some senders emit a bare `In-Reply-To:
 * id@host`) falls back to splitting on whitespace and commas, since {@link normalizeMessageId}
 * accepts the bare form.
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
   * The CALLER decides because the two callers know different things: ingest has the parsed
   * message and passes sender + recipients; the backfill has only what was persisted, and rows
   * predating the recipients slice carry `to_addresses`' `'[]'` default, so it passes the sender
   * alone. A conversation resolved by the backfill over OLD rows therefore lists fewer
   * participants than the same conversation ingested today; newly ingested mail has the
   * recipients, so the gap stops growing — closing it retroactively would need the raw bytes.
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
   * The delta rows this resolution OWES, in the order they must be appended — deliberately NOT
   * written by {@link resolveThread} itself. A lock-order fix: `recordChange` → `allocateSeq`
   * takes the account's `account_sync_state` row lock and holds it to COMMIT. A resolver that
   * recorded as it went would take the seq lock on its first row and a NEW `threads` row lock on
   * its second, while a concurrent ingest holds that `threads` row and waits for the seq lock — a
   * genuine cycle Postgres aborts with 40P01. Handing the rows back moves every `recordChange` to
   * the END of the caller's transaction, so ingest and backfill both acquire ALL `threads` locks
   * BEFORE the seq lock: one order, no cycle.
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
 * Resolve, persist and announce the thread for ONE message. Pure DB, only ever inside the
 * caller's transaction: its writes and `change_log` rows commit together. Three outcomes: (1) a
 * candidate message HAS a thread — adopt it; (2) a candidate exists with NO thread — fall through
 * to the anchor, parent left alone; (3) no candidate — find-or-create from the anchor (a MISS —
 * an out-of-order sibling may have created the row). Outcome 2 does not file the parent: a
 * lock-order inversion against the backfill's `FOR UPDATE` page, and unnecessary — the parent
 * derives the same `rootMessageIdHeader` its child derived, so `ON CONFLICT` converges without a
 * write.
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
 * The reply and forward subject prefixes localized mail clients emit — ONE table: a German
 * Outlook forward once kept its "WG:" prefix in the thread name while the same client's "AW:"
 * replies were stripped. The set is the documented Outlook/Thunderbird localization table.
 * Longest token first, so the alternation never stops at a prefix of a longer token. The short
 * entries ("R:", "I:", "PD:") are safe because the token must be the ENTIRE word before the colon
 * — "Item:" and "Password:" survive; the test table pins them. "WG:" is ambiguous in German
 * (Wohngemeinschaft) and the forward reading still wins: this only NAMES a thread at create, so
 * the worst case is a flat-share ad losing two letters, never a merge.
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

/**
 * The conversation-join rule — merge-time evidence, NOT ingest identity. For the conversation the
 * header chain STRUCTURALLY cannot join: the user FORWARDS a reply that landed in another of
 * their mailboxes — a forward carries no `In-Reply-To`/`References`, so one human conversation is
 * two disjoint chains. The join is a DEFERRED MERGE taken by the worker's thread-join heal, on
 * evidence: same base subject, the same non-self correspondent on both sides, close in time, the
 * later chain claiming reply/forward. "Re: invoice" from strangers fails the counterparty guard
 * (own addresses subtracted; a sender's To/Cc is a claim, not evidence — `sender-headers.ts`).
 * Every guard must pass; a split is recoverable, a false merge has no undo.
 */

/**
 * The subset of {@link SUBJECT_PREFIX_TOKENS} precise enough to be MERGE EVIDENCE. Two tables,
 * deliberately: the NAMING table is tuned for recall — "WG:" stays there because its worst case
 * is a flat-share ad losing two letters. Here a false positive IS a merge, irreversible, so every
 * token that reads as an ordinary word with a colon ("WG: Zimmer", "VS: proposal", "RES: table
 * for two", "TR: …", the one-letter Italian pair) is excluded; what stays is unmistakably
 * mail-client output. The recall given up is the recoverable direction: a Finnish or Portuguese
 * continuation stays split until a header or an unambiguous prefix joins it.
 */
const CONTINUATION_PREFIX_TOKENS = [
  "doorst",           // nl forward
  "antw",             // nl reply
  "fwd", "fw",        // en forward
  "odp",              // pl reply
  "ynt",              // tr reply
  "re",               // reply, international
  "aw",               // de reply
  "sv",               // sv/da/no/is reply
  "vá",               // hu reply
  "回复", "回覆",      // zh-Hans / zh-Hant reply
  "转发", "轉寄",      // zh-Hans / zh-Hant forward
] as const;

const CONTINUATION_PREFIX_RE = new RegExp(
  `^(?:${CONTINUATION_PREFIX_TOKENS.join("|")})\\.?\\s*(?:\\[\\d+\\])?\\s*[:：]`, "i",
);

/** True when the subject, as the sender wrote it, opens with an UNAMBIGUOUS reply/forward
 * prefix — the only kind {@link conversationJoinVerdict} accepts as a continuation claim. */
export function claimsContinuation(subject: string): boolean {
  return CONTINUATION_PREFIX_RE.test(subject.trim());
}

/**
 * Guard 5's window: the later chain's first message must land within this of the earlier
 * chain's latest activity. The observed production split was 1.8 days; Gmail's subject-join
 * window is 7. Fourteen days admits a slow correspondent without leaving the door open for a
 * subject line coincidentally reused a season later.
 */
export const CONVERSATION_JOIN_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

/** The per-thread facts the join verdict is decided on — derived from MESSAGES, not thread rows,
 * because a user rename changes a thread's NAME and must neither force nor forge identity. */
export interface ConversationJoinFacts {
  /** Earliest message's `Date`, the thread's position in time. `null` ⇒ ineligible (guard 1). */
  firstMessageAt: Date | null;
  /** Latest message's `Date` — what guard 5 measures the gap from. */
  lastMessageAt: Date | null;
  /** Earliest message's subject AS SENT — prefixes intact, they are guard 3's evidence. */
  firstMessageSubject: string;
  /**
   * Every address the thread's messages mention, lowercased and self included, WITH who put it
   * there ({@link counterpartyEvidence}).
   *
   * A Map and not a Set, so a producer cannot hand this verdict a `To`/`Cc` a stranger wrote
   * without saying so: guard 4 admits only the corroborated classes, and the shape is what makes
   * the omission a compile error in every producer rather than a silent readmission.
   */
  correspondents: ReadonlyMap<string, CounterpartyEvidence>;
}

export type ConversationJoinVerdict =
  | { join: true; /** The non-self addresses both threads share — the evidence, for the log. */ overlap: string[] }
  | { join: false; reason: "undated" | "order" | "no-base-subject" | "subject-differs" | "later-not-a-continuation" | "outside-window" | "no-counterparty-overlap" | "uncorroborated-overlap" };

/**
 * Decide whether two threads of ONE account are the same conversation. Pure — the heal derives
 * the facts, this decides; `earlier`/`later` are by first-message date, and a reversed pair gets
 * `"order"`, not a silently inverted decision. `selfAddresses` are the account's own lowercased
 * addresses: subtracting them turns "both threads mention the account holder" — true of every
 * pair — into "both threads involve the same OTHER party". The heal passes MORE than the mailbox
 * rows (an imported history carries former identities, plus measured-ubiquitous authors);
 * widening the set only ever starves a join — the recoverable direction — never forges one.
 */
export function conversationJoinVerdict(
  earlier: ConversationJoinFacts,
  later: ConversationJoinFacts,
  selfAddresses: ReadonlySet<string>,
): ConversationJoinVerdict {
  // 1 — both threads must be dated: the window is load-bearing, so no date means no verdict.
  if (!earlier.firstMessageAt || !later.firstMessageAt || !earlier.lastMessageAt) {
    return { join: false, reason: "undated" };
  }
  if (earlier.firstMessageAt.getTime() > later.firstMessageAt.getTime()) {
    return { join: false, reason: "order" };
  }

  // 2 — identical, non-empty base subject, case-folded the way subjects are humanly compared.
  //     A bare "Re:" reduces to "" and must anchor nothing.
  const base = baseSubject(earlier.firstMessageSubject).toLowerCase();
  if (base === "") return { join: false, reason: "no-base-subject" };
  if (baseSubject(later.firstMessageSubject).toLowerCase() !== base) {
    return { join: false, reason: "subject-differs" };
  }

  // 3 — the later chain's FIRST message must claim continuation ("Fwd:", "AW:", …) through a
  //     prefix precise enough to bet a merge on — see CONTINUATION_PREFIX_TOKENS. Two
  //     conversation-starters sharing a subject are two conversations, full stop.
  if (!claimsContinuation(later.firstMessageSubject)) {
    return { join: false, reason: "later-not-a-continuation" };
  }

  // 5 — proximity. Interleaved threads (earlier still active past the later one's start) gap 0.
  const gap = later.firstMessageAt.getTime() - earlier.lastMessageAt.getTime();
  if (gap > CONVERSATION_JOIN_WINDOW_MS) return { join: false, reason: "outside-window" };

  // 4 — the same non-self correspondent on both sides, CORROBORATED on both sides. Tested LAST
  //     only because it is the one guard with output worth logging; the numbering above matches
  //     the module comment. A shared address that only ever appeared in a To/Cc somebody else
  //     wrote is refused under its own reason, so the heal can count what it turned away.
  const overlap: string[] = [];
  let uncorroborated = 0;
  for (const [addr, mine] of earlier.correspondents) {
    const theirs = later.correspondents.get(addr);
    if (theirs === undefined || selfAddresses.has(addr)) continue;
    if (isCorroboratedCounterparty(mine) && isCorroboratedCounterparty(theirs)) overlap.push(addr);
    else uncorroborated += 1;
  }
  if (overlap.length === 0) {
    return {
      join: false,
      reason: uncorroborated > 0 ? "uncorroborated-overlap" : "no-counterparty-overlap",
    };
  }

  return { join: true, overlap: overlap.sort() };
}
