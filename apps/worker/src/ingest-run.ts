import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import {
  accountStorage, attachments, bodyBytesOf, folderState, lockAccountStorage, messageBodies, type Tx,
} from "@trafficflow/db";
import type { Dialect } from "@trafficflow/db/dialect";
import {
  foldThreads, messageSearchUpsert, newBodyWriteOf, newFolderStateOf, newMoveDeltaOf, newThreadInputOf,
  threadKeyOf, UNMETERED_STORAGE_CAP, type FoldThread, type RepoChangeInput,
} from "@trafficflow/core/mail";
import type { EmailAddress } from "@trafficflow/core";
import {
  attachmentRowsOf, DrizzleRepo, folderStateRowOf, insertMessageRows, insertNewThreads, instanceTupleOf,
  type IngestRunContext, type IngestRunMember, type IngestRunResult, type WorkerRepo,
} from "@trafficflow/core/adapters/drizzle-repo";

/**
 * THE IMPORT'S BATCHED COMMIT — a run of new letters stored in ONE transaction, as `commitChange`
 * would store them one transaction each. Worker-only: the phone and the desktop bundle `sync.ts`,
 * never this file, and store every letter alone.
 *
 * One letter alone costs about twenty statements, each a round trip to a hosted store; a run costs
 * about twenty in all. What it writes, in `commitChange`'s lock order (mailbox, messages, storage,
 * threads, list addresses, the change-log counter last): the rows, their primary instances, the
 * attachments, the storage counter, the bodies with their search documents, the threads, the
 * folder rows, the last letter's list addresses, and every letter's deltas in letter order.
 *
 * The caller keeps the run sound (`sync.ts`): only letters `commitChange` would write nothing else
 * for, and a run ends before a letter whose plan could read a member's rows. Anything this cannot
 * store exactly as the per-letter path would throws {@link RunConflictError}; the transaction rolls
 * back and the caller commits each letter alone.
 */
export class RunConflictError extends Error {
  readonly name = "RunConflictError";
}

/** The most letters one statement carries. */
const ROWS_PER_STATEMENT = 100;
/** The most body text one statement carries. */
const TEXT_PER_STATEMENT = 8 * 1024 * 1024;
/** The most message ids one parent read names. */
const IDS_PER_STATEMENT = 5_000;

/** How many letters, from the first, fit under the cap: `reserveBodyBytes`' test, before adding. */
export function fittingUnderCap(start: number, bytes: ReadonlyArray<number | null>, cap: number | null): number {
  if (cap === null) return bytes.length;
  let used = start;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b === null || b === undefined) continue;
    if (!(used < cap)) return i;
    used += b;
  }
  return bytes.length;
}

function chunks<T>(rows: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

/** {@link WorkerRepo.persistNewRun}, over the transaction's own handle. */
export async function persistNewRun(
  db: Tx, d: Dialect, repo: WorkerRepo, all: readonly IngestRunMember[], ctx: IngestRunContext,
): Promise<IngestRunResult> {
  if (all.length === 0) return { persisted: 0, messageIds: [] };
  const { accountId, mailboxId } = ctx;
  const capBytes = ctx.storageCap === UNMETERED_STORAGE_CAP ? null : ctx.storageCap;
  const writesAll = all.map((m) => newBodyWriteOf(m.plan, accountId));
  // A husk the plan decided (`too_large`) reserves nothing.
  const bytesAll = writesAll.map((w, i) => (all[i]!.plan.bodyWithheld !== undefined ? null : bodyBytesOf(w.body)));

  // AT THE CAP the letter that would not fit, and every one after it, commit alone (the rolling
  // window evicts per letter). Predicted here without a lock; proved under it below.
  let n = all.length;
  if (capBytes !== null && bytesAll.some((b) => b !== null)) {
    const [row] = await db.select({ bytes: accountStorage.bytes }).from(accountStorage)
      .where(eq(accountStorage.accountId, accountId));
    n = fittingUnderCap(row?.bytes ?? 0, bytesAll, capBytes);
    if (n === 0) return { persisted: 0, messageIds: [] };
  }
  const members = all.slice(0, n);
  const writes = writesAll.slice(0, n);
  const bytes = bytesAll.slice(0, n);

  // ── messages, through `insertMessage`'s own door: the erasure stamp asked once for the run ──
  // (unfenced, the change-log allocation below asks it), and a conflict is a letter stored since
  // it was planned.
  const idByKey = new Map<string, string>();
  const rows = await insertMessageRows(db, d, mailboxId, members.map((m) => m.insert), { mustBeLive: ctx.mailboxMustBeLive, inStoreOrder: true });
  for (const r of rows) idByKey.set(r.dedupKey, r.id);
  const ids = members.map((m) => idByKey.get(m.insert.dedupKey));
  if (ids.some((id) => id === undefined)) throw new RunConflictError("a letter of the run was stored since it was planned");
  const messageIds = ids as string[];

  // ── primary instances: account and mailbox from the message row, never from the caller ──
  for (const chunk of chunks(members.map((m, i) => ({ id: messageIds[i]!, ...instanceTupleOf(m.insert.nativeLocator) })), ROWS_PER_STATEMENT)) {
    const values = sql.join(chunk.map((t) => sql`(${t.id}::uuid, ${t.folder}, ${t.uidvalidity.toString()}::bigint, ${t.uid}::bigint)`), sql`, `);
    const made = await d.exec(db, sql`insert into message_instances (account_id, mailbox_id, message_id, folder, uidvalidity, uid, is_primary)
      select m.account_id, m.mailbox_id, m.id, v.folder, v.uidvalidity, v.uid, true
        from (values ${values}) as v(message_id, folder, uidvalidity, uid)
        join messages m on m.id = v.message_id
      on conflict do nothing returning message_id`);
    if (made.length !== chunk.length) throw new RunConflictError("a locator of the run belongs to another message");
  }

  // ── attachment metadata ──
  const files = members.flatMap((m, i) => attachmentRowsOf(messageIds[i]!, accountId, m.plan.normalized.attachments));
  for (const chunk of chunks(files, ROWS_PER_STATEMENT)) await db.insert(attachments).values(chunk);

  // ── the storage counter: made to exist, locked, decided as `reserveBodyBytes` decides, moved once ──
  const total = bytes.reduce<number>((sum, b) => sum + (b ?? 0), 0);
  if (bytes.some((b) => b !== null)) {
    const held = await lockAccountStorage(db, d, accountId);
    if (fittingUnderCap(held, bytes, capBytes) !== bytes.length) {
      throw new RunConflictError("the storage counter moved past the cap since the run was sized");
    }
    await db.update(accountStorage)
      .set({ bytes: sql`${accountStorage.bytes} + ${total}`, updatedAt: d.now() })
      .where(eq(accountStorage.accountId, accountId));
  }

  // ── bodies, each with its search document in the same statement (mail 0125) ──
  const now = new Date();
  let batch: number[] = [];
  let batchText = 0;
  const flushBodies = async (): Promise<void> => {
    if (batch.length === 0) return;
    const bodyInsert = db.insert(messageBodies).values(batch.map((i) => {
      const w = writes[i]!;
      return {
        messageId: messageIds[i]!,
        text: w.body.withheld !== undefined ? "" : w.body.text,
        html: w.body.withheld !== undefined ? null : w.body.html,
        withheldReason: w.body.withheld ?? null,
        // A copy: the parser's null-prototype map refuses the driver (see `insertMessageBody`).
        headers: { ...w.body.headers },
      };
    })).onConflictDoNothing({ target: messageBodies.messageId }).returning({ id: messageBodies.id });
    const document = messageSearchUpsert(db, batch.map((i) => ({ messageId: messageIds[i]!, input: writes[i]!.search })), now);
    const combined = d.search.withDocument(bodyInsert.getSQL(), document.getSQL());
    if (combined === null) throw new RunConflictError("this store cannot write a body and its document in one statement");
    const [row] = await d.exec(db, combined);
    if (Number(row?.[0] ?? 0) !== batch.length) throw new RunConflictError("a body of the run was stored since it was planned");
    batch = [];
    batchText = 0;
  };
  for (let i = 0; i < members.length; i++) {
    const w = writes[i]!;
    const text = w.body.text.length + (w.body.html?.length ?? 0) + w.search.bodyText.length;
    if (batch.length > 0 && (batch.length >= ROWS_PER_STATEMENT || batchText + text > TEXT_PER_STATEMENT)) await flushBodies();
    batch.push(i);
    batchText += text;
  }
  await flushBodies();

  // ── threads: `resolveThread`'s rules, folded over the run (`foldThreads`) ──
  const letters = members.map((m, i) => newThreadInputOf(m.plan, accountId, messageIds[i]!));
  const keys = letters.map((l) => threadKeyOf(l.messageIdHeader, l.headers));
  const candidates = [...new Set(keys.flatMap((k) => k.candidates))];
  // A letter of the run is nobody's parent here: one before it is cited by none (the caller ends
  // a run first), and one after it was not stored yet when the letter would have been alone.
  const own = new Set(messageIds);
  const parents: Array<{ id: string; header: string | null; threadId: string | null }> = [];
  for (const chunk of chunks(candidates, IDS_PER_STATEMENT)) {
    const rows = await d.exec(db, sql`select id, message_id_header, thread_id from messages
      where account_id = ${accountId}::uuid and message_id_header in (${sql.join(chunk.map((c) => sql`${c}`), sql`, `)})`);
    for (const r of rows) {
      if (!own.has(String(r[0]))) parents.push({ id: String(r[0]), header: (r[1] as string | null) ?? null, threadId: (r[2] as string | null) ?? null });
    }
  }
  const hit = new Set(parents.map((p) => p.header));
  const parentThreads = new Set<string>();
  const roots = new Set<string>();
  keys.forEach((k) => {
    const first = k.candidates.find((c) => hit.has(c));
    const threaded = first === undefined ? undefined : parents.find((p) => p.header === first && p.threadId !== null);
    if (threaded?.threadId) parentThreads.add(threaded.threadId);
    else if (k.rootMessageIdHeader !== null) roots.add(k.rootMessageIdHeader);
  });
  const stored: FoldThread[] = [];
  if (parentThreads.size > 0 || roots.size > 0) {
    const byId = parentThreads.size === 0 ? sql`false` : sql`id in (${sql.join([...parentThreads].map((t) => sql`${t}::uuid`), sql`, `)})`;
    const byRoot = roots.size === 0 ? sql`false` : sql`root_message_id_header in (${sql.join([...roots].map((r) => sql`${r}`), sql`, `)})`;
    const rows = await d.exec(db, sql`select id, root_message_id_header, subject, participants, last_message_at from threads
      where account_id = ${accountId}::uuid and (${byId} or ${byRoot}) order by id for update`);
    for (const r of rows) {
      stored.push({
        id: String(r[0]), rootMessageIdHeader: (r[1] as string | null) ?? null, subject: String(r[2] ?? ""),
        participants: participantsOf(r[3]), lastMessageAt: r[4] === null || r[4] === undefined ? null : new Date(r[4] as string),
      });
    }
  }
  const fold = foldThreads({ letters, parents, threads: stored, newId: randomUUID });
  if (fold.created.length > 0) {
    const made = await insertNewThreads(db, accountId, fold.created);
    if (made !== fold.created.length) throw new RunConflictError("a conversation of the run was started elsewhere since it was read");
  }
  if (fold.updated.length > 0) {
    const values = sql.join(fold.updated.map((t) =>
      sql`(${t.id}::uuid, ${JSON.stringify(t.participants)}::jsonb, ${t.lastMessageAt?.toISOString() ?? null}::timestamptz)`), sql`, `);
    await d.exec(db, sql`update threads set participants = v.participants, last_message_at = v.last_message_at, updated_at = now()
      from (values ${values}) as v(id, participants, last_message_at)
      where threads.id = v.id and threads.account_id = ${accountId}::uuid`);
  }
  const attach = sql.join(messageIds.map((id, i) => sql`(${id}::uuid, ${fold.threadOf[i]!}::uuid)`), sql`, `);
  const attached = await d.exec(db, sql`update messages set thread_id = v.thread_id, updated_at = now()
    from (values ${attach}) as v(id, thread_id)
    where messages.id = v.id and messages.thread_id is null returning messages.id`);
  if (attached.length !== messageIds.length) throw new RunConflictError("a letter of the run was threaded since it was stored");

  // ── folder rows ──
  const states = [];
  for (let i = 0; i < members.length; i++) {
    states.push(folderStateRowOf(messageIds[i]!, await newFolderStateOf(members[i]!.plan, { repo, mailboxId, observedSince: ctx.observedSince })));
  }
  for (const chunk of chunks(states, ROWS_PER_STATEMENT)) {
    const made = await db.insert(folderState).values(chunk).onConflictDoNothing({ target: folderState.messageId })
      .returning({ id: folderState.messageId });
    if (made.length !== chunk.length) throw new RunConflictError("a letter of the run has a folder row already");
  }

  // ── the last letter's list addresses, before the counter (only the last may carry them) ──
  const listed = members.flatMap((m) => m.plan.listAddresses);
  if (listed.length > 0) await repo.recordListAddresses(accountId, listed);

  // ── every letter's deltas, in letter order, in one allocation: the counter lock last ──
  const deltas: RepoChangeInput[] = [];
  members.forEach((m, i) => {
    for (const c of fold.changesOf[i]!) deltas.push({ accountId, entityType: c.entityType, entityId: c.entityId, op: c.op, meta: null });
    deltas.push({ accountId, entityType: "message", entityId: messageIds[i]!, op: "create", meta: null });
    const move = newMoveDeltaOf(m.plan, accountId, messageIds[i]!);
    if (move !== null) deltas.push(move);
  });
  await repo.recordChanges(deltas, ctx.mailboxMustBeLive);
  return { persisted: members.length, messageIds };
}

function participantsOf(v: unknown): EmailAddress[] {
  const parsed = typeof v === "string" ? JSON.parse(v) as unknown : v;
  return Array.isArray(parsed) ? parsed as EmailAddress[] : [];
}

/** `repo` with {@link persistNewRun} on it, over the handle `repo` speaks: the fence's transaction. */
export function withIngestRuns<T extends DrizzleRepo>(repo: T): T {
  return new Proxy(repo, {
    get(obj, prop): unknown {
      if (prop === "persistNewRun") {
        return (members: readonly IngestRunMember[], ctx: IngestRunContext): Promise<IngestRunResult> => {
          const { db, d } = DrizzleRepo.handleOf(obj);
          if (d.name !== "pg") throw new RunConflictError("runs are written on the server's store only");
          return persistNewRun(db as unknown as Tx, d, obj, members, ctx);
        };
      }
      const value = (obj as unknown as Record<string | symbol, unknown>)[prop];
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(obj) : value;
    },
  });
}

/** A repository whose transactions carry {@link persistNewRun}, for a cycle with no fence. */
export function ingestRunRepository<T extends DrizzleRepo>(repo: T): T {
  return new Proxy(repo, {
    get(obj, prop): unknown {
      if (prop === "transaction") {
        return <R>(fn: (r: DrizzleRepo) => Promise<R>): Promise<R> => obj.transaction((inner) => fn(withIngestRuns(inner)));
      }
      const value = (obj as unknown as Record<string | symbol, unknown>)[prop];
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(obj) : value;
    },
  });
}
