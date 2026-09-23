import { and, desc, eq, inArray, isNull, lt, or, sql, type SQL, type SQLWrapper } from "drizzle-orm";
import {
  accountSettings, attachments, messageBodies, messages, messageSearch, type Tx,
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
/** Rows one backfill round builds, in one transaction. */
export const SEARCH_INDEX_BATCH = 500;
/** Rounds one backfill run takes before it yields the cycle back. */
export const SEARCH_INDEX_ROUNDS_PER_CYCLE = 4;
/** Rows one INSERT statement carries — under every store's bound-parameter ceiling. */
const INSERT_CHUNK = 100;

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

/** The document's parts and substring corpus, each bounded. Pure; the writer's only input. */
export function searchDocumentOf(input: MessageSearchInput): { parts: SearchDocumentParts; terms: string } {
  const people = [input.from, ...input.to, ...input.cc].map(personWords).filter((w) => w !== "").join(" ");
  const attachmentsText = input.attachmentNames.filter((n) => n.trim() !== "").join(" ");
  const parts: SearchDocumentParts = {
    subject: input.subject,
    people,
    attachments: attachmentsText,
    body: input.bodyText.slice(0, SEARCH_BODY_MAX_CHARS),
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
  const values = rows.map((r) => rowOf(db, r.messageId, r.input, now));
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
    text: messageBodies.text, html: messageBodies.html,
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

export interface SearchIndexBackfillResult {
  /** False when the marker was already written — nothing was read. */
  readonly ran: boolean;
  readonly written: number;
  readonly rounds: number;
  /** The completion marker was written by this run. */
  readonly marked: boolean;
}

/**
 * THE STORE-ONLY BACKFILL — `search_index_backfill` in the worker's pass registry. Newest first,
 * the absence of a document is the resume point, one transaction per round. No mailbox, no
 * adapter: every word it writes is already in the store. Writes the completion marker once the
 * account's living messages all have a document.
 */
export async function searchIndexBackfillPass(args: {
  db: Tx; accountId: string; now?: () => Date;
  batch?: number; rounds?: number;
}): Promise<SearchIndexBackfillResult> {
  const { db, accountId } = args;
  const batch = args.batch ?? SEARCH_INDEX_BATCH;
  const maxRounds = args.rounds ?? SEARCH_INDEX_ROUNDS_PER_CYCLE;
  const now = args.now ?? (() => new Date());
  if (await searchIndexBuilt(db, accountId)) return { ran: false, written: 0, rounds: 0, marked: false };
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
          eq(messages.accountId, accountId), isNull(messages.deletedAt), isNull(messageSearch.messageId),
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
 * Write the completion marker once. An account with no settings row gains one, but only while it
 * still has living mail — an erased account's empty store must not grow a settings row back.
 */
async function stampSearchIndexBuilt(db: Tx, accountId: string, at: Date): Promise<boolean> {
  const d = dialect(db);
  await d.exec(db, sql`
    insert into account_settings (account_id, search_index_built_at)
    select ${accountId}, ${d.ts(at)}
    where exists (select 1 from messages where account_id = ${accountId} and deleted_at is null)
    on conflict (account_id) do update
      set search_index_built_at = coalesce(account_settings.search_index_built_at, excluded.search_index_built_at)`);
  return searchIndexBuilt(db, accountId);
}
