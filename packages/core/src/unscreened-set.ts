import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lte, ne, sql, type SQL } from "drizzle-orm";
import {
  accountOfMessage, accountSettings, approvals, auditAction, auditLog, cutlineInstant, drafts, folderState, mailboxes,
  messageBodies, messageStates, messageTags, messages, readOwnAddresses, recordChanges,
  weAnsweredThisSenderWhere, type LedgerTx, type Tx,
} from "@trafficflow/db";
import { carryDialect, dialect } from "@trafficflow/db/dialect";
import {
  DEFAULT_OHBOX_POLICY, evaluateRules, resolveScreeningCutoff, screenerAdmits, senderIsDecided,
  type KnownSenders, type Rule, type ScreeningScope,
} from "./rules.js";
import { correspondentAtGate } from "./pipeline.js";
import { ROWS_PER_TURN, turnsEvery, type LoopTurn } from "./loop-turns.js";
import type { RepoPort } from "./ports.js";
import { LEGACY_NEWS_FOLDER, NEWS_FOLDER, type Destination, type NormalizedMessage } from "./types.js";

/* OHBOX MAIL FROM SENDERS NOBODY EVER DECIDED ABOUT — the set named ONCE, for its doors. The
   Screener's offer ("Screen N") reads and presses it account-wide; the organize decision reads it
   for one mailbox inside the window before the press and the organizer moves exactly that set after
   it, in slices; asked of News or Receipts with no window, it is the note on those piles. Membership
   is one rule for all ({@link gateHoldsSender}): the arrival gate's own
   `evaluateRules` answer, `screenerAdmits` on the server's receive clock (`messages.arrived_at`),
   with a letter that has no recorded arrival outside the window, and the gate's reply arm. A bulk
   move also needs the date the person sees (the queue's `cutlineInstant`) inside the window, so
   migrated mail with a fresh arrival stays. Writes are intents only: the organizer's reconciler
   performs every move.

   THE OFFER AND A PILE'S NOTE WALK SENDERS, THEN THEIR MAIL. Most of a large Ohbox is mail from
   people the account decided about, and no index holds one account's letters in the order a letter
   walk reads them: read letter by letter, a page cost the whole account and 25 pages found a tenth
   of the answer. So the walk reads the account's senders off the sender index, drops every sender
   already decided ({@link senderIsDecided}, the gate's own reading), and reads candidate letters
   only for the rest, in that index's order. Its work follows the senders and the answer, never the
   size of the Ohbox. The agree scope keeps its letter walk: its order, newest first, is the sweep's. */

const OHBOX: Destination = "INBOX";
const SCREENER: Destination = "ohmail/Screener";

/** How many sender groups one read shows and one press may act on. */
export const OHBOX_UNSCREENED_GROUPS_MAX = 200;
/** Messages one read offers and one press moves. */
export const OHBOX_UNSCREENED_MESSAGES_MAX = 1000;
/** Rows one page of the walk reads. */
const BATCH = 200;
/** Letters one intent upsert carries: a few binds each, well under either store's bind ceiling. */
const INTENT_SLICE = 200;
/** Pages one walk may read: a bound on rows READ, so a large Ohbox answers with what it has. */
const MAX_PAGES = 25;
/** Senders one read of the sender index lists, and so the most one candidate page names. */
const SENDER_PAGE = 1000;
/** The id behind every other: a cursor at `(sender, LAST_ID)` stands past all of that sender's mail. */
const LAST_ID = "ffffffff-ffff-ffff-ffff-ffffffffffff";
/** Before every sender and every letter: where a walk nobody handed a cursor starts. */
export const UNSCREENED_FIRST_CURSOR: UnscreenedCursor = { sender: "", id: "00000000-0000-0000-0000-000000000000" };
/** The longest cursor text a door reads back ({@link unscreenedCursorOf}): an address, an id, the brackets. */
export const UNSCREENED_CURSOR_MAX_CHARS = 1000;
/** How much wider than the window the SQL prefilter reads; the window itself is `screenerAdmits`. */
const PREFILTER_SLACK_MS = 86_400_000;

/** The audit row a press writes per screened sender group, with its inverse. */
export const OHBOX_UNSCREENED_AUDIT_ACTION = auditAction("screener.unscreened_sweep");
/**
 * The record of a person's FIRST agree press made on a screen that stated the rule, written in
 * the consent's own transaction at the stamp's instant. The organizer that spends that stamp
 * sweeps; no other promotion finds one.
 */
export const AGREE_SCREENS_BACKLOG_ACTION = auditAction("organizer.agree_screens_backlog");

export interface UnscreenedSenderGroup {
  /** The sender's address, lower-cased as the gate reads it. */
  address: string;
  count: number;
  /** The newest of those messages, ISO. */
  newestAt: string;
}

/** A pile whose letters can come from senders nobody let in: News, Receipts. */
export type UnscreenedPile = "news" | "receipts";

/** Is this a pile the note asks about? */
export function isUnscreenedPile(v: unknown): v is UnscreenedPile {
  return v === "news" || v === "receipts";
}

/** Where a pile's letters are desired (News in both spellings), and the folder a press names. */
const PILE_FOLDERS: Readonly<Record<UnscreenedPile, readonly string[]>> = {
  news: [NEWS_FOLDER, LEGACY_NEWS_FOLDER],
  receipts: ["ohmail/Receipts"],
};
const PILE_FOLDER: Readonly<Record<UnscreenedPile, Destination>> = { news: NEWS_FOLDER, receipts: "ohmail/Receipts" };

/** The folder a scope's letters are moved out of: the Ohbox, or the pile's own. */
export function unscreenedSourceFolder(scope: UnscreenedScope): Destination {
  return scope.kind === "pile" ? PILE_FOLDER[scope.pile] : OHBOX;
}

/**
 * Which set: the account-wide offer, or one mailbox (the organize decision); both inside the
 * account's window. `storedBy` is the sweep's start: it moves only what the store held then.
 * `after` is the last letter a previous slice read; a letter gone since restarts from the top.
 * `pile`: News or Receipts account-wide, with no window — an old letter there is offered too.
 */
export type UnscreenedScope =
  | { kind: "offer"; cutoff: Date | undefined; from?: UnscreenedCursor | null }
  | { kind: "agree"; mailboxId: string; cutoff: Date | undefined; storedBy?: Date; after?: string | null }
  | { kind: "pile"; pile: UnscreenedPile; from?: UnscreenedCursor | null };

/**
 * WHERE A SENDER WALK STANDS: every letter up to this one, by sender address and then id, is read.
 * A walk its budget stopped answers it ({@link UnscreenedWalk.next}) and the next call's scope
 * carries it back (`from`), so a large account is read over several calls, never by a longer one.
 */
export interface UnscreenedCursor { sender: string; id: string }

/** The cursor as a door sends it. */
export function unscreenedCursorText(c: UnscreenedCursor): string {
  return JSON.stringify([c.sender, c.id]);
}

/** A letter's id as the store holds it: any other 36 characters fail its cast a statement later. */
const CURSOR_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The cursor a door was handed back, or null for anything that is not one. */
export function unscreenedCursorOf(text: string): UnscreenedCursor | null {
  if (text.length > UNSCREENED_CURSOR_MAX_CHARS) return null;
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return null; }
  if (!Array.isArray(raw) || raw.length !== 2) return null;
  const [sender, id] = raw as unknown[];
  if (typeof sender !== "string" || typeof id !== "string" || !CURSOR_ID.test(id)) return null;
  return { sender, id };
}

/** The scope's window; a pile has none. */
const cutoffOf = (scope: UnscreenedScope): Date | undefined => (scope.kind === "pile" ? undefined : scope.cutoff);

/** The gate's knowledge, read by the caller inside the transaction the walk runs in. */
export interface UnscreenedKnowledge extends Pick<RepoPort, "isCorrespondent"> {
  listRules(accountId: string): Promise<Rule[]>;
  knownSenders(accountId: string): Promise<KnownSenders>;
}

export interface UnscreenedRow {
  messageId: string;
  fromAddress: string;
  subject: string;
  bodyText: string;
  headers: Record<string, string[]>;
  observedFolder: string;
  /** The letter's own Message-ID, for the gate's reply arm (`threadKeyOf` leaves it out). */
  messageIdHeader: string | null;
  /** For the group's "newest": the header date where present, else the ingest stamp. */
  at: Date;
  /** The server's receive clock, the window's only input. */
  arrivedAt: Date | null;
}

export interface UnscreenedWalk {
  /** The members a press would move — at most {@link OHBOX_UNSCREENED_MESSAGES_MAX}. */
  rows: UnscreenedRow[];
  /** Members seen in all, past the move bound too when the walk has no `stopAt`. */
  matched: number;
  /** Distinct senders among every member seen. */
  senders: number;
  /** False when `stopAt`, the page bound or the time budget stopped the walk, so `matched` is a floor. */
  complete: boolean;
  /** The last letter the walk read, where a next slice goes on from. */
  last: string | null;
  /**
   * Where a sender walk goes on, when its page bound or its budget stopped it with senders unread.
   * Null when it read to the end, when `stopAt` filled it (there is nothing to go on to), and for
   * the agree scope, whose slices carry `last`.
   */
  next: UnscreenedCursor | null;
}

function asRuleInput(row: UnscreenedRow): NormalizedMessage {
  return {
    canonical: { messageIdHeader: row.messageIdHeader, bodyHash: "" },
    subject: row.subject,
    from: { name: null, address: row.fromAddress.toLowerCase() },
    to: [], cc: [], date: null,
    headers: row.headers,
    textBody: row.bodyText,
    htmlBody: null,
    hasAttachments: false,
    attachments: [],
  };
}

/**
 * WHETHER THE GATE HOLDS THIS STORED LETTER'S SENDER — the one definition of a stranger, read by
 * the organize decision and the gap pass. The gate's own answer with `auth` unavailable and no
 * identity fact must be the Screener; the letter needs a recorded arrival inside the window
 * (`screenerAdmits` admits a missing one for a new delivery, never for stored history); and the
 * gate's reply arm ({@link correspondentAtGate}) must not admit it as an answer to the person.
 * `window: false` (a pile's note) asks only the gate's answer and the reply arm.
 */
export async function gateHoldsSender(
  row: UnscreenedRow,
  { rules, known, own, cutoff, ask, accountId, window = true }: {
    rules: readonly Rule[]; known: KnownSenders; own: ReadonlySet<string>; cutoff: Date | undefined;
    ask: Pick<RepoPort, "isCorrespondent">; accountId: string; window?: boolean;
  },
): Promise<boolean> {
  const msg = asRuleInput(row);
  const decision = evaluateRules({
    msg, rules: rules as Rule[], knownSenders: known, ownAddresses: own,
    auth: "unavailable", ohboxPolicy: DEFAULT_OHBOX_POLICY, identity: null,
  });
  if (decision.source !== "screener") return false;
  if (window) {
    if (row.arrivedAt === null) return false;
    if (!screenerAdmits({ arrivedAt: row.arrivedAt, cutoff, source: decision.source, authFailed: false })) {
      return false;
    }
  }
  return (await correspondentAtGate(ask, accountId, msg, decision, "unavailable", known)) === null;
}

/**
 * THE WALK — the one place the set is produced; a read, a press and a sweep slice all call it.
 * `lock` takes `FOR UPDATE OF folder_state` inside a press (two presses move a message once). A
 * press and a slice stop at `stopAt` members; a count reads on to its page bound.
 */
export async function unscreenedWalk(
  t: Tx, knowledge: UnscreenedKnowledge, accountId: string,
  opts: {
    lock: boolean; scope: UnscreenedScope; stopAt?: number;
    /** Pages this walk may read, {@link MAX_PAGES} unless a host says less. */
    maxPages?: number;
    /** The host's loop turn, awaited once per {@link ROWS_PER_TURN} rows checked. */
    turn?: LoopTurn;
    /**
     * How long this walk may run, read before every statement: out of time it answers what it has,
     * `complete: false`. Absent, only its bounds stop it (the organizer's slices).
     */
    budgetMs?: number;
    /** The clock the budget is read on; `Date.now` unless a caller brings its own. */
    clock?: () => number;
  },
): Promise<UnscreenedWalk> {
  const clock = opts.clock ?? Date.now;
  const started = clock();
  const spent = (): boolean => opts.budgetMs !== undefined && clock() - started >= opts.budgetMs;
  // The walk starts on a turn of its own, apart from the request or slice before it.
  if (opts.turn) await opts.turn();
  const rules = await knowledge.listRules(accountId);
  const known = await knowledge.knownSenders(accountId);
  const ownRows = await t.select({ address: mailboxes.address }).from(mailboxes)
    .where(eq(mailboxes.accountId, accountId));
  const ownAddresses = ownRows.map((r) => r.address.toLowerCase());
  const ownSet = await readOwnAddresses(t, accountId);
  const enabled = rules.filter((r) => r.enabled);
  const needsBody = enabled.some((r) => (r.bodyContains ?? "") !== "");

  const out: UnscreenedRow[] = [];
  const senders = new Set<string>();
  let matched = 0;
  let last: string | null = null;
  const checked = turnsEvery(ROWS_PER_TURN, opts.turn);
  /** Where a sender walk stands: every letter up to here, by sender address and then id, is asked. */
  let stood = opts.scope.kind === "agree" ? UNSCREENED_FIRST_CURSOR : opts.scope.from ?? UNSCREENED_FIRST_CURSOR;
  /**
   * The gate, asked of one page's letters. `"full"` once `stopAt` members are held; `"spent"` when
   * the budget ended first: the gate's reply arm may cost a statement a letter, so the budget is
   * read before each one, and the letters not asked are the next call's.
   */
  const take = async (rows: readonly PageRow[]): Promise<"full" | "spent" | null> => {
    for (const { letter: row, at } of rows) {
      if (spent()) return "spent";
      last = row.messageId;
      stood = at;
      const holds = await gateHoldsSender(row, {
        rules, known, own: ownSet, cutoff: cutoffOf(opts.scope), ask: knowledge, accountId,
        window: opts.scope.kind !== "pile",
      });
      await checked();
      if (!holds) continue;
      matched++;
      senders.add(row.fromAddress.toLowerCase());
      if (out.length < OHBOX_UNSCREENED_MESSAGES_MAX) out.push(row);
      if (opts.stopAt !== undefined && out.length >= opts.stopAt) return "full";
    }
    return null;
  };
  const answer = (complete: boolean, next: UnscreenedCursor | null): UnscreenedWalk =>
    ({ rows: out, matched, senders: senders.size, complete, last, next });
  const maxPages = opts.maxPages ?? MAX_PAGES;
  const page = { accountId, ownAddresses, needsBody, lock: opts.lock, scope: opts.scope };

  if (opts.scope.kind === "agree") {
    let afterId = opts.scope.after ?? null;
    if (afterId !== null) {
      // A cursor letter gone from the store restarts the walk from the top.
      const [still] = await t.select({ id: messages.id }).from(messages)
        .where(eq(messages.id, dialect(t).castUuid(sql`${afterId}`))).limit(1);
      if (!still) afterId = null;
    }
    last = afterId;
    for (let n = 0; n < maxPages && !spent(); n++) {
      const read = await selectCandidates(t, { ...page, afterId });
      // A page read is its own stretch, apart from the reads before it and the checks after it.
      if (opts.turn) await opts.turn();
      // Full, or out of time: `last` is the last letter asked, where a next slice goes on.
      if (await take(read.rows) !== null) break;
      if (read.end === null) return answer(true, null);
      // The page is read to its end: a next slice goes on behind it, the answered letters at its end too.
      afterId = read.end.id;
      last = afterId;
    }
    return answer(false, null);
  }

  // SENDERS FIRST: a page of the account's senders, then the mail of those nobody decided about.
  let pages = 0;
  for (;;) {
    if (spent()) return answer(false, stood);
    const listed = await selectSenders(t, accountId, stood);
    if (opts.turn) await opts.turn();
    const open = listed.filter((s) => !senderIsDecided(s.toLowerCase(), rules, known, ownSet));
    while (open.length > 0) {
      if (pages >= maxPages || spent()) return answer(false, stood);
      const read = await selectCandidates(t, { ...page, senders: open, from: stood });
      pages++;
      if (opts.turn) await opts.turn();
      const stop = await take(read.rows);
      // `stopAt` members: the set is full, and there is nothing to go on to.
      if (stop === "full") return answer(false, null);
      if (stop === "spent") return answer(false, stood);
      if (read.end === null) break;
      stood = read.end;
    }
    if (listed.length < SENDER_PAGE) return answer(true, null);
    stood = { sender: listed[listed.length - 1]!, id: LAST_ID };
  }
}

/**
 * A PLACEMENT NOBODY DECIDED, the per-row question both scopes ask: `folder_state.decided_at` is
 * unset — neither a person's filing (here, or adopted from another client) nor an answer the gate
 * admitted for itself alone. A decided letter is never offered, counted or swept.
 */
export function placementUndecided(): SQL {
  return isNull(folderState.decidedAt);
}

/**
 * THE ACCOUNT'S NEXT SENDERS in address order from the cursor on, at most {@link SENDER_PAGE}: the
 * distinct addresses of the sender index (`messages_account_from_addr_idx`). Every sender of any
 * letter the account holds: whose mail is a candidate is {@link selectCandidates}' question. A
 * plain distinct read on purpose: one index descent per sender is ten times cheaper while the
 * planner knows the account, and re-reads the whole account for every sender when it does not
 * (measured: 14.6 s for one page of senders on 80,000 letters the statistics had not seen). No plan
 * of this one reads the account more than once.
 */
async function selectSenders(t: Tx, accountId: string, from: UnscreenedCursor): Promise<string[]> {
  const sender = sql<string>`lower(${messages.fromAddress})`;
  const rows = await t.selectDistinct({ sender }).from(messages)
    .where(and(
      eq(messages.accountId, accountId),
      // A cursor behind all of a sender's mail starts after them; one inside their mail, with them.
      from.id === LAST_ID ? sql`${sender} > ${from.sender}` : sql`${sender} >= ${from.sender}`,
    ))
    .orderBy(asc(sender))
    .limit(SENDER_PAGE);
  return rows.map((r) => r.sender);
}

/** One letter of a page, and where a sender walk stands once the gate is asked about it. */
interface PageRow { letter: UnscreenedRow; at: UnscreenedCursor }

/**
 * ONE PAGE. Candidates are desired `INBOX`. The offer reads every mailbox this install organizes,
 * and only the mail of `senders` (the ones nobody decided about), by sender address and then id
 * from `from` on: the sender index's own order, so a page costs its own rows. The agree scope reads
 * one mailbox whatever its role (the count is read before the press), newest arrival first.
 * Exclusions: a decided placement ({@link placementUndecided}), a triage pile, a reply draft, a
 * decided approval, an answered sender, the account's own mail, a tag, a letter with no recorded
 * arrival, one whose shown date is older than the window and, for the sweep, one stored after its
 * start — with the arrival window as a prefilter {@link gateHoldsSender} re-asks. A pile's
 * candidates are desired in that pile on a mailbox this install organizes, placed by ohmail (never
 * `'external'`: a hand filing, or a letter an open import question kept for the travelling
 * document), the offer's exclusions but the window's. `end` is where the next page goes on, null
 * when this one was the last.
 *
 * WHO THE PERSON ANSWERED IS ASKED OF THE PAGE, NOT INSIDE IT. Inside, the planner knows the
 * account as a constant and, on an account its statistics under-count, reads the account's whole
 * index for every candidate instead of the candidate's thread (measured: 7.3 s for a page of 200 on
 * 80,000 letters). Asked of the page's own rows it can only be a lookup by thread.
 */
async function selectCandidates(
  t: Tx,
  opts: {
    accountId: string; ownAddresses: readonly string[]; needsBody: boolean; lock: boolean; scope: UnscreenedScope;
  } & ({ afterId: string | null } | { senders: readonly string[]; from: UnscreenedCursor }),
): Promise<{ rows: PageRow[]; end: UnscreenedCursor | null }> {
  const d = dialect(t);
  const pile = opts.scope.kind === "pile" ? opts.scope.pile : null;
  const filters: SQL[] = [
    eq(messages.accountId, opts.accountId),
    pile === null ? eq(folderState.desiredFolder, OHBOX) : inArray(folderState.desiredFolder, [...PILE_FOLDERS[pile]]),
    placementUndecided(),
    // A letter gone from the server is no candidate: offering it screens a ghost.
    isNull(messages.deletedAt),
    isNull(messages.serverMissingAt),
    sql`not exists (
      select 1 from ${messageStates} ms
       where ms.message_id = ${messages.id} and ms.state <> 'none'
    )`,
    sql`not exists (
      select 1 from ${drafts} dr where dr.in_reply_to_message_id = ${messages.id}
    )`,
    sql`not exists (
      select 1 from ${approvals} a
       where a.message_id = ${messages.id} and a.status <> 'pending'
    )`,
    sql`not exists (
      select 1 from ${messageTags} mt where mt.message_id = ${messages.id}
    )`,
  ];
  if (pile === null) {
    filters.push(isNotNull(messages.arrivedAt));
  } else {
    // Only ohmail's own placements: an open import question keeps the travelling document's letters 'external'.
    filters.push(ne(folderState.lastSetBy, "external"));
  }
  const cutoff = cutoffOf(opts.scope);
  if (cutoff !== undefined) {
    // The arrival prefilter only bounds what the walk reads, a day wider: the gate decides.
    filters.push(gte(messages.arrivedAt, new Date(cutoff.getTime() - PREFILTER_SLACK_MS)));
    // The date the queue and History show must be inside too: an import's fresh arrival is not new mail.
    filters.push(sql`${cutlineInstant({ date: sql`${messages.date}`, arrivedAt: sql`${messages.createdAt}` })} >= ${d.ts(cutoff)}`);
  }
  if (opts.scope.kind !== "agree") {
    filters.push(sql`exists (
      select 1 from ${mailboxes} mb
       where mb.id = ${messages.mailboxId}
         and mb.status <> 'disabled'
         and mb.organizer_role = 'organizer'
    )`);
  } else {
    filters.push(eq(messages.mailboxId, opts.scope.mailboxId));
    if (opts.scope.storedBy !== undefined) filters.push(lte(messages.createdAt, opts.scope.storedBy));
  }
  if (opts.ownAddresses.length > 0) {
    const own = sql`(${sql.join(opts.ownAddresses.map((a) => sql`${a}`), sql`, `)})`;
    filters.push(sql`lower(${messages.fromAddress}) not in ${own}`);
  }
  const bySender = "senders" in opts;
  if (bySender) {
    filters.push(sql`lower(${messages.fromAddress}) in (${sql.join(opts.senders.map((s) => sql`${s}`), sql`, `)})`);
    filters.push(sql`(lower(${messages.fromAddress}), ${messages.id}) > (${opts.from.sender}, ${d.castUuid(sql`${opts.from.id}`)})`);
  } else if (opts.afterId) {
    // Past the last row read, by the stored values themselves: no timestamp crosses into JS and back.
    filters.push(sql`(${messages.arrivedAt}, ${messages.id}) < (
      select m2.arrived_at, m2.id from ${messages} m2 where m2.id = ${d.castUuid(sql`${opts.afterId}`)}
    )`);
  }

  // Each placeholder its own expression: on the device store two identical ones collapse.
  const q = t.select({
    messageId: messages.id,
    fromAddress: messages.fromAddress,
    subject: messages.subject,
    observedFolder: folderState.observedFolder,
    headers: messageBodies.headers,
    bodyText: opts.needsBody ? messageBodies.text : sql<string>`''`,
    messageIdHeader: messages.messageIdHeader,
    at: sql<string>`coalesce(${messages.date}, ${messages.createdAt})`,
    arrivedAt: messages.arrivedAt,
    // The address as the store orders it: the next page's key, never re-derived here.
    sender: sql<string>`lower(${messages.fromAddress})`,
    threadId: messages.threadId,
  }).from(folderState)
    .innerJoin(messages, eq(messages.id, folderState.messageId))
    .leftJoin(messageBodies, eq(messageBodies.messageId, messages.id))
    .where(and(...filters))
    .orderBy(...(bySender
      ? [asc(sql`lower(${messages.fromAddress})`), asc(messages.id)]
      : [desc(messages.arrivedAt), desc(messages.id)]))
    .limit(BATCH)
    .$dynamic();
  const rows = await (opts.lock ? d.forUpdate(q, { of: folderState }) : q);

  // A letter with no thread answers nobody, so only the threaded ones are asked; null: none was.
  const threaded = opts.ownAddresses.length === 0 ? [] : rows.filter((r) => r.threadId !== null).map((r) => r.messageId);
  const unanswered = threaded.length === 0 ? null : new Set((
    await t.select({ id: messages.id }).from(messages).where(and(
      inArray(messages.id, threaded),
      sql`not ${weAnsweredThisSenderWhere(d, {
        accountId: sql`${messages.accountId}`,
        threadId: sql`${messages.threadId}`,
        fromAddress: sql`${messages.fromAddress}`,
        ownAddresses: opts.ownAddresses,
      })}`,
    ))
  ).map((r) => r.id));

  const tail = rows.length < BATCH ? undefined : rows[rows.length - 1];
  return {
    rows: rows.filter((r) => unanswered === null || r.threadId === null || unanswered.has(r.messageId)).map((r) => ({
      letter: {
        messageId: r.messageId,
        fromAddress: r.fromAddress,
        subject: r.subject,
        bodyText: (r.bodyText as string | null) ?? "",
        headers: (r.headers as Record<string, string[]> | null) ?? {},
        observedFolder: r.observedFolder,
        messageIdHeader: r.messageIdHeader ?? null,
        at: new Date(r.at),
        arrivedAt: r.arrivedAt === null || r.arrivedAt === undefined ? null : new Date(r.arrivedAt),
      },
      at: { sender: r.sender, id: r.messageId },
    })),
    end: tail === undefined ? null : { sender: tail.sender, id: tail.messageId },
  };
}

/** Sender groups, largest first, bounded by {@link OHBOX_UNSCREENED_GROUPS_MAX}; ties by address. */
export function unscreenedGroups(
  rows: readonly UnscreenedRow[], max: number = OHBOX_UNSCREENED_GROUPS_MAX,
): UnscreenedSenderGroup[] {
  const by = new Map<string, { count: number; newest: number }>();
  for (const row of rows) {
    const key = row.fromAddress.toLowerCase();
    const at = row.at.getTime();
    const hit = by.get(key);
    if (hit) { hit.count++; if (at > hit.newest) hit.newest = at; }
    else by.set(key, { count: 1, newest: at });
  }
  return [...by.entries()]
    .map(([address, g]) => ({ address, count: g.count, newestAt: new Date(g.newest).toISOString() }))
    .sort((a, b) => b.count - a.count || a.address.localeCompare(b.address))
    .slice(0, max);
}

/**
 * THE PRESS'S WRITES: desired `ohmail/Screener`, observed untouched (so `reconcile_status`
 * derives `pending` and the reconciler moves it), a change row per letter and one audit row per
 * sender group carrying its inverse. A press moves only the shown groups (`"shown"`), so what it
 * reports and what it wrote are one measurement; the agree's sweep moves every group (`"all"`).
 * `from` is the folder the letters leave: the Ohbox, or a pile's for its note's press.
 */
export async function writeScreenerIntents(
  t: Tx, ledger: LedgerTx,
  input: {
    accountId: string; rows: readonly UnscreenedRow[]; now: Date; via: "offer" | "agree" | "gap" | "pile";
    groups: "shown" | "all"; from?: Destination;
    /** The host's loop turn, awaited after each statement that writes the rows. */
    turn?: LoopTurn;
  },
): Promise<{ screened: UnscreenedSenderGroup[]; total: number }> {
  const from = input.from ?? OHBOX;
  const screened = unscreenedGroups(input.rows, input.groups === "all" ? Infinity : OHBOX_UNSCREENED_GROUPS_MAX);
  const moving = new Set(screened.map((g) => g.address));
  const seen = new Set<string>();
  const rows: UnscreenedRow[] = [];
  for (const row of input.rows) {
    if (!moving.has(row.fromAddress.toLowerCase()) || seen.has(row.messageId)) continue;
    seen.add(row.messageId);
    rows.push(row);
  }
  /* SET-BASED, in the caller's one transaction: a row-at-a-time press spent ~4 statements per letter
     and held the phone store's only transaction slot for minutes on a slow device. */
  for (let i = 0; i < rows.length; i += INTENT_SLICE) {
    await t.insert(folderState).values(rows.slice(i, i + INTENT_SLICE).map((row) => ({
      messageId: row.messageId, accountId: accountOfMessage(row.messageId), desiredFolder: SCREENER, observedFolder: row.observedFolder,
      lastSetBy: "us" as const, reconcileStatus: SCREENER === row.observedFolder ? "reconciled" as const : "pending" as const,
      conflict: false,
    }))).onConflictDoUpdate({
      target: folderState.messageId,
      set: {
        desiredFolder: SCREENER, observedFolder: sql`excluded.observed_folder`, lastSetBy: "us",
        reconcileStatus: sql`excluded.reconcile_status`, conflict: false, updatedAt: input.now,
      },
    });
    if (input.turn) await input.turn();
  }
  await recordChanges(ledger, rows.map((row) => ({
    accountId: input.accountId, entityType: "message" as const, entityId: row.messageId, op: "move" as const,
    meta: { from, to: SCREENER },
  })));
  if (input.turn && rows.length > 0) await input.turn();
  if (screened.length > 0) {
    await t.insert(auditLog).values(screened.map((g) => ({
      accountId: input.accountId,
      action: auditAction("screener.unscreened_sweep"),
      payload: { address: g.address, count: g.count, from, to: SCREENER, via: input.via },
      inverse: { address: g.address, from: SCREENER, to: from },
    })));
  }
  return { screened, total: rows.length };
}

/** A screening answer as the consent writes it: absent dials keep what the account stored. */
export interface ScreeningAnswer {
  dormancyDays?: number;
  scope?: ScreeningScope;
}

/**
 * THE WINDOW the organize decision is about, resolved as the consent will store it: the baseline
 * an account already has (consent `coalesce`s it) or `now`, the answer's dials over the stored
 * ones. No answer is the window already in force — what the organizer reads after the press.
 */
export async function agreeWindowCutoff(
  t: Tx, accountId: string, now: Date, answer?: ScreeningAnswer,
): Promise<Date | undefined> {
  const [row] = await t.select({
    baseline: accountSettings.screeningBaselineAt,
    days: accountSettings.dormancyDays,
    scope: accountSettings.screeningScope,
  }).from(accountSettings).where(eq(accountSettings.accountId, accountId)).limit(1);
  const baseline = row?.baseline ?? now;
  const days = answer?.dormancyDays ?? (answer?.scope !== undefined ? undefined : row?.days ?? undefined);
  const scope = answer?.scope ?? row?.scope ?? "window";
  return resolveScreeningCutoff(baseline, days, scope);
}

/** The agree record's payload: the mailbox, and the window agreed to (ISO, null for all time). */
export async function agreeRecordPayload(
  t: Tx, accountId: string, mailboxId: string, now: Date,
): Promise<{ mailboxId: string; cutoff: string | null }> {
  const cutoff = await agreeWindowCutoff(t, accountId, now);
  return { mailboxId, cutoff: cutoff === undefined ? null : cutoff.toISOString() };
}

/**
 * THE AGREE RECORD A PROMOTION SPENT, or null: the agree press recorded
 * {@link AGREE_SCREENS_BACKLOG_ACTION} for this mailbox at the stamp's own instant, which it writes
 * only beside a first consent. A claim-back, a takeover and a later promotion carry no such row.
 * `agreed` is the window it names (null all time), undefined for a record written before it did.
 */
export async function agreeRecordAt(
  t: Tx, input: { accountId: string; mailboxId: string; stamp: Date },
): Promise<{ agreed: Date | null | undefined } | null> {
  const rows = await t.select({ payload: auditLog.payload, at: auditLog.createdAt }).from(auditLog)
    .where(and(eq(auditLog.accountId, input.accountId), eq(auditLog.action, AGREE_SCREENS_BACKLOG_ACTION)));
  for (const r of rows) {
    const p = r.payload as { mailboxId?: unknown; cutoff?: unknown } | null;
    if (new Date(r.at).getTime() !== input.stamp.getTime() || p?.mailboxId !== input.mailboxId) continue;
    if (p.cutoff === null) return { agreed: null };
    const at = typeof p.cutoff === "string" ? new Date(p.cutoff) : null;
    return { agreed: at !== null && Number.isFinite(at.getTime()) ? at : undefined };
  }
  return null;
}

/** WHETHER A PROMOTION SPENT THE STAMP OF A PERSON'S AGREE ({@link agreeRecordAt}). */
export async function agreeRecordedAt(
  t: Tx, input: { accountId: string; mailboxId: string; stamp: Date },
): Promise<boolean> {
  return (await agreeRecordAt(t, input)) !== null;
}

/** The narrower of two windows: the later cutoff; all time (undefined) only when both are. */
function narrowerWindow(a: Date | undefined, b: Date | undefined): Date | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return a.getTime() >= b.getTime() ? a : b;
}

/**
 * Where the agree's sweep goes on: the store it was fixed on, the last letter a slice read, and the
 * window agreed to (null all time) — a later widening of the dials never extends the sweep.
 */
export interface AgreeSweepCursor {
  storedBy: Date;
  after: string | null;
  agreed: Date | null;
}

/** What one slice of the organizer's sweep after a promotion did. */
export type AgreeSweepOutcome =
  /** `next` is where the following slice goes on, or null when the window is done. */
  | { kind: "swept"; total: number; senders: number; next: AgreeSweepCursor | null }
  /** No agree record at this stamp: a claim-back, a takeover or any other press. Nothing moved. */
  | { kind: "not_an_agree" }
  /** A travelling profile document holds this mailbox's history: somebody sorted it. Nothing moved. */
  | { kind: "held" }
  /** The shared settings folder could not be read, or held a garbled document: fails CLOSED. Nothing moved. */
  | { kind: "unread" }
  /** The row is no longer this install's to organize. Nothing moved. */
  | { kind: "not_organizer" };

export interface AgreeSweepInput {
  accountId: string; mailboxId: string; stamp: Date; held: boolean | "unread"; now: Date;
  /** The gate's knowledge bound to the sweep's transaction (`makeDrizzleRepo` over it). */
  knowledgeFor: (tx: Tx) => UnscreenedKnowledge;
  /** The sweep's ledger handle for `recordChange` — the transaction itself. */
  ledgerOf: (tx: Tx) => LedgerTx;
  /** Where the previous slice stopped; absent or null for the first. */
  cursor?: AgreeSweepCursor | null;
  /** Letters one slice moves, {@link OHBOX_UNSCREENED_MESSAGES_MAX} unless a host says less. */
  slice?: number;
  /** Pages one slice's walk reads, the walk's own bound unless a host says less. */
  pages?: number;
  /** The host's loop turn, passed to the walk. */
  turn?: LoopTurn;
}

/**
 * ONE SLICE OF THE AGREE'S SWEEP, run by the organizer after the promotion that spent `stamp`: if
 * that stamp was written with a person's first agree on a screen that stated the rule, up to one
 * slice of the in-window mail of never-decided senders gets its Screener intents. The set is what
 * the store held when the sweep started (the first slice's `now`), newest arrival first. One
 * transaction per slice: the mailbox row first (the writers' lock order), then every check again,
 * then the walk. `held` is the caller's FRESH read of the settings folder: `"unread"` (a fault or a
 * garbled document) moves nothing, like a hold.
 */
export async function agreeSweepSlice(db: Tx, input: AgreeSweepInput): Promise<AgreeSweepOutcome> {
  return db.transaction(async (raw) => {
    const t = carryDialect(db, raw as object) as unknown as Tx;
    const q = t.select({ role: mailboxes.organizerRole, status: mailboxes.status }).from(mailboxes)
      .where(and(eq(mailboxes.id, input.mailboxId), eq(mailboxes.accountId, input.accountId))).$dynamic();
    const [mb] = await dialect(t).forUpdate(q, { of: mailboxes });
    if (!mb || mb.status === "disabled" || mb.role !== "organizer") return { kind: "not_organizer" } as const;
    const record = await agreeRecordAt(t, input);
    if (record === null) return { kind: "not_an_agree" } as const;
    if (input.held === "unread") return { kind: "unread" } as const;
    if (input.held) return { kind: "held" } as const;
    const storedBy = input.cursor?.storedBy ?? input.now;
    const current = await agreeWindowCutoff(t, input.accountId, input.now);
    // The record's window; an older record without one takes the first slice's, carried in the cursor.
    const agreed = input.cursor ? input.cursor.agreed : record.agreed === undefined ? current ?? null : record.agreed;
    const cutoff = narrowerWindow(agreed ?? undefined, current);
    const walk = await unscreenedWalk(t, input.knowledgeFor(t), input.accountId, {
      lock: true, stopAt: input.slice ?? OHBOX_UNSCREENED_MESSAGES_MAX,
      ...(input.pages !== undefined ? { maxPages: input.pages } : {}),
      ...(input.turn !== undefined ? { turn: input.turn } : {}),
      scope: { kind: "agree", mailboxId: input.mailboxId, cutoff, storedBy, after: input.cursor?.after ?? null },
    });
    const next = walk.complete ? null : { storedBy, after: walk.last, agreed };
    if (walk.rows.length === 0) return { kind: "swept", total: 0, senders: 0, next } as const;
    const res = await writeScreenerIntents(t, input.ledgerOf(t), {
      accountId: input.accountId, rows: walk.rows, now: input.now, via: "agree", groups: "all",
      ...(input.turn !== undefined ? { turn: input.turn } : {}),
    });
    return { kind: "swept", total: res.total, senders: res.screened.length, next } as const;
  });
}

/** Slices one drain may run before it hands the cursor to the next. */
export const AGREE_SWEEP_SLICES_PER_DRAIN = 10;

/** What one drain's run of the sweep did: the last slice's verdict, summed counts, the cursor left. */
export interface AgreeSweepRun {
  verdict: AgreeSweepOutcome["kind"];
  total: number;
  /** Undo rows written: a sender spanning two slices counts in each. */
  senders: number;
  slices: number;
  next: AgreeSweepCursor | null;
}

/**
 * THE SWEEP BOTH HOSTS CALL, once per organizing drain: slices back to back, each its own
 * transaction, yielding between them so the store serves other writers, at most
 * {@link AGREE_SWEEP_SLICES_PER_DRAIN}. A non-null `next` is the host's to carry to its next drain.
 */
export async function agreeSweepRun(db: Tx, input: AgreeSweepInput & { maxSlices?: number }): Promise<AgreeSweepRun> {
  const max = input.maxSlices ?? AGREE_SWEEP_SLICES_PER_DRAIN;
  let cursor = input.cursor ?? null;
  let total = 0;
  let senders = 0;
  let slices = 0;
  for (;;) {
    if (slices > 0) await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const out = await agreeSweepSlice(db, { ...input, cursor });
    slices++;
    if (out.kind !== "swept") return { verdict: out.kind, total, senders, slices, next: null };
    total += out.total;
    senders += out.senders;
    cursor = out.next;
    if (cursor === null || slices >= max) return { verdict: "swept", total, senders, slices, next: cursor };
  }
}
