import { and, desc, eq, inArray, isNull, lt, or, sql, type SQL, type SQLWrapper } from "drizzle-orm";
import {
  accounts, accountSettings, attachments, messageBodies, messages, messageSearch, type Tx,
} from "@trafficflow/db";
import { dialect, type SearchDocumentParts } from "@trafficflow/db/dialect";
import { htmlToPlainText } from "./html-text.js";
import type { EmailAddress } from "./types.js";

/**
 * THE SEARCH DOCUMENT (mail 0125) — what a message is found by, built from the STORE or the parsed
 * message and never from a mailbox connection. One writer ({@link upsertMessageSearch}) for every
 * path that stores body text; the backfill ({@link searchIndexBackfillPass}) fills rows ingested
 * before the table existed, newest first. Unmetered: the storage cap withholds a body's bytes,
 * never its findability. Never read by a model or the knowledge base (a census holds it).
 */

/** The body text a document indexes, in characters — the head of a long body is its words. */
export const SEARCH_BODY_MAX_CHARS = 65_536;
/** The substring corpus's ceiling, in characters: subject, people and file names fit easily. */
export const SEARCH_TERMS_MAX_CHARS = 2_048;
/**
 * Each header part's ceiling in `head_tsv`, in characters. The display names and file names are
 * sender-written and unbounded, and a tsvector refuses over 1 MiB (`54000`), which failed the
 * ingest transaction this document is written in. Real names and file names fit many times over.
 */
export const SEARCH_HEAD_PART_MAX_CHARS = 16_384;
/** Rows one backfill round builds, in one transaction. */
export const SEARCH_INDEX_BATCH = 500;
/** Rounds one backfill run takes before it yields the cycle back. */
export const SEARCH_INDEX_ROUNDS_PER_CYCLE = 4;
/** Rows one INSERT statement carries — under every store's bound-parameter ceiling. */
const INSERT_CHUNK = 100;
/**
 * The stored html a round reads per message, in characters: `message_bodies_html_cap`'s own
 * ceiling, so only a row written before the cap is cut. The text is read to the document's own
 * {@link SEARCH_BODY_MAX_CHARS}, which is all of it the document keeps.
 */
export const SEARCH_HTML_READ_MAX_CHARS = 262_144;
/** Accounts one cycle tail's backfill section visits, at most. */
export const SEARCH_INDEX_ACCOUNTS_PER_TAIL = 16;
/**
 * When the document's present shape took effect (file names' parts are words of the text vector).
 * A document built before it has an older shape, and the backfill builds it again. The writer dates
 * no document earlier, so its own are never taken for older ones and every older writer's are,
 * wherever one still ran until then. A later shape takes a later instant.
 */
export const SEARCH_DOCUMENT_SHAPE_AT = new Date("2026-11-09T00:00:00Z");

/** Where a document's body words came from. `headers_only`: the stored body had no words. */
export type { SearchSource } from "@trafficflow/db";
import type { SearchSource } from "@trafficflow/db";

export interface MessageSearchInput {
  readonly accountId: string;
  readonly subject: string;
  readonly from: EmailAddress | null;
  readonly to: readonly EmailAddress[];
  readonly cc: readonly EmailAddress[];
  readonly attachmentNames: readonly string[];
  readonly bodyText: string;
  readonly source: SearchSource;
}

/**
 * The body words for a document: the stored text when it has any, else the text rendering of the
 * stored html (HTML-only mail, which stores no text part), else none. A rendering that
 * throws is `headers_only`, never a failed ingest.
 */
export function searchBodyOf(
  text: string | null | undefined, html: string | null | undefined,
): { bodyText: string; source: SearchSource } {
  if (typeof text === "string" && text.trim() !== "") return { bodyText: text, source: "text" };
  if (typeof html === "string" && html.trim() !== "") {
    try {
      const derived = htmlToPlainText(html);
      if (derived.trim() !== "") return { bodyText: derived, source: "html" };
    } catch {
      // A body nobody can render still has a subject and senders to be found by.
    }
  }
  return { bodyText: "", source: "headers_only" };
}

/** An address as words: the display name, the address, and its local and domain parts. */
function personWords(a: EmailAddress | null): string {
  if (a === null) return "";
  const address = a.address ?? "";
  return [a.name ?? "", address, address.replace(/[@.+_-]+/g, " ")].join(" ").trim();
}

/**
 * The parts of the file names as words: Postgres reads `harbour-ledger-7731.pdf` as one token. Each
 * name's runs between marks that are not letters or digits, and inside a run its camel humps and its
 * letter or digit runs of two characters or more (`harbour ledger 7731 pdf`). Only the names inside
 * the head part's `max` characters are split, and the words written stop there too: the work is
 * bounded however many names a letter carries, even the same name over and over.
 */
function fileNameWords(names: readonly string[], max: number): string {
  // Keyed lower-cased: `pdf` and `PDF` are one word to the index, written once.
  const words = new Map<string, string>();
  let size = 0;
  let at = 0;
  for (const name of names) {
    if (at >= max) break;
    const inside = name.slice(0, max - at);
    at += name.length + 1;
    for (const run of inside.split(/[^\p{L}\p{M}\p{N}]+/u)) {
      if (run === "") continue;
      const pieces = run.replace(/(\p{Ll}\p{M}*)(?=\p{Lu})/gu, "$1 ").replace(/(\p{Lu}\p{M}*)(?=\p{Lu}\p{M}*\p{Ll})/gu, "$1 ")
        .replace(/([\p{L}\p{M}])(?=\p{N})|(\p{N})(?=\p{L})/gu, "$1$2 ").split(" ");
      for (const w of [run, ...(pieces.length > 1 ? pieces.filter((p) => [...p].length > 1) : [])]) {
        const key = w.toLowerCase();
        if (words.has(key)) continue;
        if (size + w.length + 1 > max) return [...words.values()].join(" ");
        words.set(key, w);
        size += w.length + 1;
      }
    }
  }
  return [...words.values()].join(" ");
}

/** The document's parts and substring corpus, each bounded. Pure; the writer's only input. */
export function searchDocumentOf(input: MessageSearchInput): { parts: SearchDocumentParts; terms: string } {
  const people = [input.from, ...input.to, ...input.cc].map(personWords).filter((w) => w !== "").join(" ");
  const names = input.attachmentNames.filter((n) => n.trim() !== "");
  const attachmentsText = names.join(" ");
  const files = fileNameWords(names, SEARCH_HEAD_PART_MAX_CHARS);
  const body = input.bodyText.slice(0, SEARCH_BODY_MAX_CHARS);
  const parts: SearchDocumentParts = {
    subject: input.subject.slice(0, SEARCH_HEAD_PART_MAX_CHARS),
    people: people.slice(0, SEARCH_HEAD_PART_MAX_CHARS),
    attachments: attachmentsText.slice(0, SEARCH_HEAD_PART_MAX_CHARS),
    // The parts are words of the TEXT vector, after the body: its arm reads newest first and ranks
    // nothing, so a part in many letters (pdf, image001) costs no ranking. The head keeps the names whole.
    body: files === "" ? body : `${body}\n${files}`,
  };
  const addresses = [input.from, ...input.to, ...input.cc]
    .map((a) => (a === null ? "" : `${a.name ?? ""} ${a.address ?? ""}`.trim()));
  const terms = [input.subject, ...addresses, attachmentsText]
    .filter((t) => t.trim() !== "")
    .join(" ")
    .replace(/\s+/g, " ")
    .toLowerCase()
    .slice(0, SEARCH_TERMS_MAX_CHARS);
  return { parts, terms };
}

const NO_PARTS: SearchDocumentParts = { subject: "", people: "", attachments: "", body: "" };

/** An instant no earlier than {@link SEARCH_DOCUMENT_SHAPE_AT}: what this writer dates its documents and markers with. */
function shapeFloor(at: Date): Date {
  return at < SEARCH_DOCUMENT_SHAPE_AT ? SEARCH_DOCUMENT_SHAPE_AT : at;
}

/** Does this store's document have a shape to be current in? A store without vectors keeps the substring corpus alone. */
function shaped(db: unknown): boolean {
  return dialect(db).search.document(NO_PARTS) !== null;
}

/** One document's row values on the store the handle belongs to. */
function rowOf(db: unknown, messageId: string, input: MessageSearchInput, builtAt: Date): Record<string, unknown> {
  const { parts, terms } = searchDocumentOf(input);
  const vectors = dialect(db).search.document(parts);
  return {
    messageId, accountId: input.accountId, terms, source: input.source, builtAt,
    ...(vectors === null ? {} : { headTsv: vectors.head, textTsv: vectors.text }),
  };
}

/** The upsert of these documents, as one statement the caller runs or composes. */
export function messageSearchUpsert(
  db: Tx, rows: ReadonlyArray<{ messageId: string; input: MessageSearchInput }>, now: Date = new Date(),
): SQLWrapper & PromiseLike<unknown> {
  // A store with no vector columns answers `null` for the document, and so writes none back.
  const vectors = dialect(db).search.document(NO_PARTS) === null ? {} : {
    headTsv: sql`excluded.head_tsv`, textTsv: sql`excluded.text_tsv`,
  };
  const values = rows.map((r) => rowOf(db, r.messageId, r.input, shapeFloor(now)));
  return db.insert(messageSearch).values(values as never).onConflictDoUpdate({
    target: messageSearch.messageId,
    set: { terms: sql`excluded.terms`, source: sql`excluded.source`, builtAt: sql`excluded.built_at`, ...vectors } as never,
  });
}

/**
 * Write the documents for these messages — an upsert, so a restore that replaced a body
 * replaces its words. Runs in the caller's transaction; chunked under every store's
 * parameter ceiling.
 */
export async function upsertMessageSearchRows(
  db: Tx, rows: ReadonlyArray<{ messageId: string; input: MessageSearchInput }>, now: Date = new Date(),
): Promise<void> {
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    await messageSearchUpsert(db, rows.slice(i, i + INSERT_CHUNK), now);
  }
}

/** The one-row form: every writer of `message_bodies.text` calls this in its own transaction. */
export async function upsertMessageSearch(db: Tx, messageId: string, input: MessageSearchInput): Promise<void> {
  await upsertMessageSearchRows(db, [{ messageId, input }]);
}

/**
 * Build the inputs from what the STORE holds for these messages — headers from `messages`,
 * file names from `attachments`, body words from `message_bodies` (text, else html). Rows the
 * account does not own are absent. The backfill's read and the restore writers' re-index.
 */
export async function searchInputsFromStore(
  db: Tx, accountId: string, messageIds: readonly string[],
): Promise<Array<{ messageId: string; input: MessageSearchInput }>> {
  if (messageIds.length === 0) return [];
  const ids = [...messageIds];
  const rows = await db.select({
    id: messages.id, subject: messages.subject, fromAddress: messages.fromAddress,
    fromName: messages.fromName, to: messages.toAddresses, cc: messages.ccAddresses,
    text: sql<string | null>`substr(${messageBodies.text}, 1, ${SEARCH_BODY_MAX_CHARS})`,
    html: sql<string | null>`substr(${messageBodies.html}, 1, ${SEARCH_HTML_READ_MAX_CHARS})`,
  }).from(messages)
    .leftJoin(messageBodies, eq(messageBodies.messageId, messages.id))
    .where(and(eq(messages.accountId, accountId), inArray(messages.id, ids)));
  const files = await db.select({ messageId: attachments.messageId, filename: attachments.filename })
    .from(attachments)
    .where(and(eq(attachments.accountId, accountId), inArray(attachments.messageId, ids)));
  const namesOf = new Map<string, string[]>();
  for (const f of files) {
    if (!f.filename) continue;
    const list = namesOf.get(f.messageId) ?? [];
    list.push(f.filename);
    namesOf.set(f.messageId, list);
  }
  return rows.map((r) => {
    const body = searchBodyOf(r.text, r.html);
    return {
      messageId: r.id,
      input: {
        accountId,
        subject: r.subject ?? "",
        from: r.fromAddress ? { name: r.fromName ?? null, address: r.fromAddress } : null,
        to: addressList(r.to),
        cc: addressList(r.cc),
        attachmentNames: namesOf.get(r.id) ?? [],
        bodyText: body.bodyText,
        source: body.source,
      },
    };
  });
}

/** A stored recipient list, read defensively: jsonb written by older code may hold anything. */
function addressList(v: unknown): EmailAddress[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((a) => (a && typeof a === "object" && typeof (a as EmailAddress).address === "string")
    ? [{ name: typeof (a as EmailAddress).name === "string" ? (a as EmailAddress).name : null, address: (a as EmailAddress).address }]
    : []);
}

/** Re-index one stored message from what the store now holds — the restore writers' call. */
export async function reindexMessageSearch(db: Tx, accountId: string, messageId: string): Promise<void> {
  const rows = await searchInputsFromStore(db, accountId, [messageId]);
  await upsertMessageSearchRows(db, rows);
}

/** Living messages with and without a document — the backfill's progress, derived, never stored. */
export async function searchIndexProgress(db: Tx, accountId: string): Promise<{ done: number; total: number }> {
  const d = dialect(db);
  const rows = await d.exec(db, sql`
    select ${d.castInt(sql`count(*)`)} as total, ${d.castInt(sql`count(s.message_id)`)} as done
    from messages m left join message_search s on s.message_id = m.id
    where m.account_id = ${accountId} and m.deleted_at is null`);
  return { total: Number(rows[0]?.[0] ?? 0), done: Number(rows[0]?.[1] ?? 0) };
}

/** The marker is absent, or older than the document's shape: documents are owed or owed again. */
function markerOwed(db: unknown): SQL {
  return shaped(db)
    ? or(isNull(accountSettings.searchIndexBuiltAt), lt(accountSettings.searchIndexBuiltAt, SEARCH_DOCUMENT_SHAPE_AT))!
    : isNull(accountSettings.searchIndexBuiltAt);
}

/**
 * The accounts the backfill still owes: living mail and no marker, or a marker older than the
 * document's shape. The tail walks this list, not its snapshot of enabled mailboxes, so an account
 * whose only mailbox is disabled, or whose account is parked, is still indexed from the store.
 * `shard` is the caller's predicate over `accounts.id`.
 */
export async function searchIndexOwedAccounts(
  db: Tx, opts: { limit: number; shard?: SQL },
): Promise<string[]> {
  const rows = await db.select({ id: accounts.id }).from(accounts)
    .leftJoin(accountSettings, eq(accountSettings.accountId, accounts.id))
    .where(and(
      markerOwed(db),
      sql`exists (select 1 from ${messages} where ${messages.accountId} = ${accounts.id} and ${messages.deletedAt} is null)`,
      opts.shard,
    ))
    .orderBy(accounts.id)
    .limit(opts.limit);
  return rows.map((r) => r.id);
}

/** Has this account's backfill finished? `false` for no settings row or a failed read. */
export async function searchIndexBuilt(db: Tx, accountId: string): Promise<boolean> {
  try {
    const [row] = await db.select({ at: accountSettings.searchIndexBuiltAt }).from(accountSettings)
      .where(eq(accountSettings.accountId, accountId)).limit(1);
    return row?.at != null;
  } catch {
    return false;
  }
}

/** Are this account's documents all built, in the present shape? `false` for no settings row or a failed read. */
async function searchIndexCurrent(db: Tx, accountId: string): Promise<boolean> {
  try {
    const [row] = await db.select({ at: accountSettings.searchIndexBuiltAt }).from(accountSettings)
      .where(eq(accountSettings.accountId, accountId)).limit(1);
    const at = row?.at;
    return at != null && (!shaped(db) || new Date(at).getTime() >= SEARCH_DOCUMENT_SHAPE_AT.getTime());
  } catch {
    return false;
  }
}

export interface SearchIndexBackfillResult {
  /** False when the marker was already written in the present shape — nothing was read. */
  readonly ran: boolean;
  readonly written: number;
  readonly rounds: number;
  /** The completion marker was written by this run. */
  readonly marked: boolean;
}

/**
 * THE STORE-ONLY BACKFILL — `search_index_backfill` in the worker's pass registry. Newest first,
 * one transaction per round, the same bound per round whatever it writes: a letter with no document,
 * or with a file name and a document older than the document's shape (the refill: the store's
 * letters gain their file names' parts). What is left owed is the resume point. No mailbox, no
 * adapter: every word it writes is already in the store. Writes the completion marker once the
 * account's living messages all have a document in the present shape.
 */
export async function searchIndexBackfillPass(args: {
  db: Tx; accountId: string; now?: () => Date;
  batch?: number; rounds?: number;
}): Promise<SearchIndexBackfillResult> {
  const { db, accountId } = args;
  const batch = args.batch ?? SEARCH_INDEX_BATCH;
  const maxRounds = args.rounds ?? SEARCH_INDEX_ROUNDS_PER_CYCLE;
  const now = args.now ?? (() => new Date());
  if (await searchIndexCurrent(db, accountId)) return { ran: false, written: 0, rounds: 0, marked: false };
  // A document older than the shape is owed again only where the shape changed it: a file name.
  const older = shaped(db) ? and(lt(messageSearch.builtAt, SEARCH_DOCUMENT_SHAPE_AT), sql`exists (select 1 from ${attachments}
    where ${attachments.accountId} = ${accountId} and ${attachments.messageId} = ${messages.id} and ${attachments.filename} is not null)`) : undefined;
  let written = 0;
  let rounds = 0;
  let after: { date: Date | null; id: string } | null = null;
  let drained = false;
  while (rounds < maxRounds) {
    rounds += 1;
    const page = await db.transaction(async (tx) => {
      const ids = await tx.select({ id: messages.id, date: messages.date }).from(messages)
        .leftJoin(messageSearch, eq(messageSearch.messageId, messages.id))
        .where(and(
          eq(messages.accountId, accountId), isNull(messages.deletedAt),
          older === undefined ? isNull(messageSearch.messageId) : or(isNull(messageSearch.messageId), older),
          ...(after === null ? [] : [olderThan(after)]),
        ))
        .orderBy(sql`${messages.date} desc nulls last`, desc(messages.id))
        .limit(batch);
      const inputs = await searchInputsFromStore(tx as unknown as Tx, accountId, ids.map((r) => r.id));
      await upsertMessageSearchRows(tx as unknown as Tx, inputs, now());
      return ids;
    });
    written += page.length;
    const last = page[page.length - 1];
    if (page.length < batch || !last) { drained = true; break; }
    after = { date: last.date, id: last.id };
  }
  let marked = false;
  if (drained) {
    const p = await searchIndexProgress(db, accountId);
    if (p.total > 0 && p.done >= p.total) marked = await stampSearchIndexBuilt(db, accountId, now());
  }
  return { ran: true, written, rounds, marked };
}

/** Strictly after `(date, id)` under `date desc nulls last, id desc` — the History keyset. */
function olderThan(pos: { date: Date | null; id: string }): SQL {
  return pos.date === null
    ? and(isNull(messages.date), lt(messages.id, pos.id))!
    : or(lt(messages.date, pos.date), and(eq(messages.date, pos.date), lt(messages.id, pos.id)), isNull(messages.date))!;
}

/**
 * Write the completion marker once, and again over one older than the document's shape. An account
 * with no settings row gains one, but only while it still has living mail — an erased account's
 * empty store must not grow a settings row back.
 */
async function stampSearchIndexBuilt(db: Tx, accountId: string, at: Date): Promise<boolean> {
  const d = dialect(db);
  await d.exec(db, sql`
    insert into account_settings (account_id, search_index_built_at)
    select ${accountId}, ${d.ts(shapeFloor(at))}
    where exists (select 1 from messages where account_id = ${accountId} and deleted_at is null)
    on conflict (account_id) do update
      set search_index_built_at = case when account_settings.search_index_built_at < ${d.ts(SEARCH_DOCUMENT_SHAPE_AT)}
        then excluded.search_index_built_at else coalesce(account_settings.search_index_built_at, excluded.search_index_built_at) end`);
  return searchIndexCurrent(db, accountId);
}
