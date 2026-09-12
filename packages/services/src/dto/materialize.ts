import { and, asc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { foldersEnabled, userFolderById, type UserFolderRow } from "../folders.js";
import type { EmailAddress } from "@trafficflow/core/mail";
import {
  accountSettings, autoReplyByUsWhere, awayReplies, mailboxes,
  messages, folderState, messageStates, threads, routingDecisions, approvals, rules, drafts,
  tags, messageTags,
  type EntityType,
} from "@trafficflow/db";
import { dialect } from "@trafficflow/db/dialect";
import type { Db } from "../context.js";
import type {
  FolderDTO, SettingsDTO,
  Folder, MessageDTO, MessageStateDTO, ThreadDTO, RoutingDecisionDTO, ApprovalDTO, RuleDTO,
  DraftDTO, DraftStatus, SensitivityFlags, TriageState, TagDTO,
} from "./types.js";

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

/**
 * The row → DTO projections are EXPORTED, and that is the point. Every `materializeX` below is
 * "one `select` by id, then project". `SyncService.getChanges` needs the by-id half (it starts
 * from a `change_log` row); `getSnapshot` reads a whole table at once and must not pay one round
 * trip per row — a seeded account holds one rule per correspondent, thousands of them, the same
 * N+1 shape as the outage `materializeMessages` ended. So the projection is a separate, pure
 * function per type and the by-id reader calls it: both callers produce the identical DTO by
 * construction. A snapshot projecting its own rules would be a second definition of the wire
 * shape, drifting on the first field either side added.
 */
export function messageStateRowToDTO(r: typeof messageStates.$inferSelect): MessageStateDTO {
  return {
    messageId: r.messageId,
    state: r.state as TriageState,
    bubbleUpAt: iso(r.bubbleUpAt),
    setAt: r.setAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

export function routingDecisionRowToDTO(r: typeof routingDecisions.$inferSelect): RoutingDecisionDTO {
  return {
    id: r.id,
    accountId: r.accountId,
    messageId: r.messageId,
    inputProvenance: r.inputProvenance as RoutingDecisionDTO["inputProvenance"],
    matchedRuleId: r.matchedRuleId ?? null,
    destination: r.destination as Folder,
    confidence: r.confidence ?? null,
    rationale: r.rationale ?? null,
    spam: r.spam,
    status: r.status as RoutingDecisionDTO["status"],
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

export function approvalRowToDTO(a: typeof approvals.$inferSelect): ApprovalDTO {
  return {
    id: a.id,
    kind: a.kind as ApprovalDTO["kind"],
    messageId: a.messageId ?? null,
    proposed: { action: a.action, summary: a.summary, payload: a.payload ?? null },
    routingDecisionId: a.routingDecisionId ?? null,
    confidence: a.confidence ?? null,
    expiresAt: (iso(a.expiresAt) ?? a.createdAt.toISOString()),
    status: a.status as ApprovalDTO["status"],
    createdAt: a.createdAt.toISOString(),
    updatedAt: a.updatedAt.toISOString(),
  };
}

export function ruleRowToDTO(r: typeof rules.$inferSelect): RuleDTO {
  return {
    id: r.id,
    kind: r.kind as RuleDTO["kind"],
    match: r.match,
    destination: r.destination as Folder,
    priority: r.priority,
    provenance: r.provenance as RuleDTO["provenance"],
    enabled: r.enabled,
    subjectContains: r.subjectContains ?? null,
    bodyContains: r.bodyContains ?? null,
    stats: { hits: r.hits, lastHitAt: iso(r.lastHitAt), demotions: r.demotions },
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

export function draftRowToDTO(d: typeof drafts.$inferSelect): DraftDTO {
  return {
    id: d.id,
    mailboxId: d.mailboxId,
    threadId: d.threadId ?? null,
    inReplyToMessageId: d.inReplyToMessageId ?? null,
    subject: d.subject,
    body: d.body,
    html: d.html ?? null,
    to: (d.to as EmailAddress[]) ?? [],
    cc: (d.cc as EmailAddress[]) ?? [],
    bcc: (d.bcc as EmailAddress[]) ?? [],
    rationale: d.rationale ?? null,
    status: d.status as DraftStatus,
    // The appointment (mail 0077). `send_key` deliberately stays OFF the DTO: it is the send's
    // Idempotency-Key, and handing it to clients would let one replay a reservation it never made.
    sendAt: d.sendAt ? d.sendAt.toISOString() : null,
    sendError: d.sendError ?? null,
    createdAt: d.createdAt.toISOString(),
    updatedAt: d.updatedAt.toISOString(),
  };
}

export function tagRowToDTO(t: typeof tags.$inferSelect): TagDTO {
  return {
    id: t.id,
    name: t.name,
    hue: t.hue,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
  };
}

/**
 * ONE message row → its DTO. Pure: every read has already happened. Extracted so the single-id
 * path and the batch path cannot drift — they used to be one function, and the cost hid in
 * `SyncService`, which called it once per `change_log` row: three sequential round trips per
 * message, 1 500 for a 500-row page, pushing the first page past the function timeout so the
 * client received NOTHING — on a large mailbox every view rendered empty. EXPORTED so the
 * sensitivity projection can be watched directly rather than only through a database round trip:
 * `sensitive` decides whether a client renders a message's text AT ALL, too consequential to be
 * reachable only through a fixture.
 */
export function messageRowToDTO(
  m: typeof messages.$inferSelect,
  fs: typeof folderState.$inferSelect | undefined,
  st: typeof messageStates.$inferSelect | undefined,
  labels: readonly string[] | undefined,
  /**
   * TRUE ⇒ the away responder sent this, decided by `autoReplyByUsWhere` in the batch below.
   *
   * A FIFTH PARAMETER rather than a field derived here, because the fact is not on the row: it
   * needs the `away_replies` ledger and the message's stored headers, and this function is pure
   * so that the snapshot and the delta cannot project a message differently. Omitted (the
   * direct-projection tests, and any caller that has not asked) ⇒ the key is ABSENT from the DTO,
   * which the wire contract reads as "not known" — see `MessageDTO.autoReplyByUs`.
   */
  autoReplyByUs?: boolean,
  /**
   * WHEN THE AWAY RESPONDER ANSWERED THIS MESSAGE, or `null` — the ORIGINAL's stamp, decided by
   * the `away_replies` read in the batch below.
   *
   * A SIXTH PARAMETER for the fifth's reason and not a field derived here: the fact lives in a
   * ledger this row has no column for. Omitted (the direct-projection tests, and any caller
   * that has not asked) ⇒ the key is ABSENT from the DTO, which the wire contract reads as "not
   * known" and every consumer must render exactly like `null` — see `MessageDTO.awayRepliedAt`.
   */
  awayRepliedAt?: string | null,
): MessageDTO {
  const loc = (m.nativeLocator as { folder?: string } | null) ?? null;
  const folder = (fs?.desiredFolder ?? loc?.folder ?? "INBOX") as Folder;
  const category = (m.sensitivityCategory as SensitivityFlags["category"]) ?? null;
  /**
   * `sensitive` is the POSITIVE match, and only the positive match. Core owns the definition:
   * `sensitive = category !== null`; `no_ai`/`no_kb` fail CLOSED on the whole INDETERMINATE
   * bucket — ordinary mail we declined to show a model. This line used to OR all five flags, and
   * the client treats the field as "render no text at all": `isProtectedMessage` reads
   * `sensitivity.sensitive` alone, `hydrateBody` refuses the body, the mirror purges any it held.
   * The OR was a strict superset of the categorised set, so everything in the difference was
   * unreadable in the worst way — no request to wait for, "Loading the full message…" for ever.
   * The dropped flags remain on the DTO below, readable by name.
   */
  const sensitivity: SensitivityFlags = {
    sensitive: category !== null,
    category,
    no_ai: m.noAi, no_forward: m.noForward, no_kb: m.noKb, priority: m.priority,
  };

  return {
    id: m.id,
    accountId: m.accountId,
    mailboxId: m.mailboxId,
    threadId: m.threadId ?? null,
    messageIdHeader: m.messageIdHeader ?? null,
    subject: m.subject,
    // `?? null` — a row written before mail 0057 has no name on record, and the reader falls
    // back to the address, exactly as it rendered before the column existed. This literal was
    // `name: null` for every message for its whole life; the name was parsed at ingest and
    // dropped for want of a column.
    from: { name: m.fromName ?? null, address: m.fromAddress },
    to: (m.toAddresses as EmailAddress[]) ?? [],
    cc: (m.ccAddresses as EmailAddress[]) ?? [],
    date: iso(m.date),
    folder,
    snippet: m.snippet,
    unread: m.unread,
    // ONE projection, so read order reaches the client by every route it can arrive on: the list,
    // the single read, the delta feed and the bootstrap snapshot all render a message row through
    // this function. A second projection for any one of them is how a mirror ends up sorting one
    // page differently from the next.
    lastReadAt: iso(m.lastReadAt),
    hasAttachments: m.hasAttachments,
    attachmentCount: m.attachmentCount,
    sensitivity,
    triage: st ? messageStateRowToDTO(st) : null,
    // The tag ids on this message. This was a hardcoded `[]` in an early build until the tags
    // backend landed, which is what made the built tag UI inert in production: the
    // client filters `tags` by `m.labels.includes(tag.id)`, so an always-empty array meant no
    // message ever carried a tag no matter what the user clicked. `undefined` (the caller did
    // not fetch assignments) and "no assignments" both flatten to `[]` here, because the wire
    // contract has no third state and a missing array would crash `tagsOfMessage`.
    labels: labels ? [...labels] : [],
    remoteContent: "none",
    updatedAt: m.updatedAt.toISOString(),
    // Spread-in rather than a plain `autoReplyByUs:` so an un-asked caller yields a DTO with the
    // key ABSENT, not present-and-undefined. The two are the same in TypeScript and different
    // over JSON, and "this server does not know" must look exactly like "this server predates
    // the field" — which is what makes the client's `!== true` test correct for both.
    ...(autoReplyByUs === undefined ? {} : { autoReplyByUs }),
    // Spread-in for `autoReplyByUs`'s reason, and the same distinction: absent is "this server
    // does not know", `null` is "it was asked and the responder never answered this message".
    // Both render nothing, which is what makes absent safe for a client older than the field.
    ...(awayRepliedAt === undefined ? {} : { awayRepliedAt }),
  };
}

/**
 * Materialize MANY messages in SIX queries, whatever the count — CONSTANT, not fast: a page of
 * 500 costs the round trips of a page of 1 (`search-materialize.test.ts` pins the SELECT count).
 * The fifth query is the auto-reply flag (`autoReplyByUsWhere`, once per PAGE); the sixth is the
 * away answer stamp. `accountId` is on the `messages` predicate; side tables key by SURVIVING
 * ids; `message_tags` also filters its denormalized `account_id`. A soft-deleted row materializes
 * as ABSENT by default: an update emitted after a delete used to re-materialize the DTO, and on a
 * stale resume it SUPERSEDED the delete tombstone. `deleted: "include"` is the receipt reader
 * only; nothing that feeds a mirror may pass it.
 */
export interface MaterializeMessagesOpts {
  /** Default `"omit"` — the living-view rule. See the header before passing `"include"`. */
  deleted?: "omit" | "include";
}

export async function materializeMessages(
  db: Db, accountId: string, ids: readonly string[], opts: MaterializeMessagesOpts = {},
): Promise<Map<string, MessageDTO>> {
  const out = new Map<string, MessageDTO>();
  if (ids.length === 0) return out;

  const unique = [...new Set(ids)];
  const rows = await db.select().from(messages)
    .where(and(
      inArray(messages.id, unique),
      eq(messages.accountId, accountId),
      ...(opts.deleted === "include" ? [] : [isNull(messages.deletedAt)]),
    ));
  if (rows.length === 0) return out;

  const owned = rows.map((r) => r.id);
  const fsRows = await db.select().from(folderState).where(inArray(folderState.messageId, owned));
  const stRows = await db.select().from(messageStates).where(inArray(messageStates.messageId, owned));
  const mtRows = await db.select().from(messageTags)
    .where(and(inArray(messageTags.messageId, owned), eq(messageTags.accountId, accountId)));
  /**
   * THE AUTO-REPLY FLAG — one query per page, keyed on the ids that survived the account filter.
   *
   * On BOTH paths, deliberately: `owned` already reflects `opts.deleted`, so the receipt reader
   * (`deleted: "include"`) carries the flag too. A projection that answered the question on the
   * living view and not on the receipt would let `MessageService.delete`'s echo disagree with the
   * row the client already holds, and the mirror's apply contract has no repair for a field that
   * changes value on a `delete` it did not change on the `update` before it.
   */
  const arRows = await db.select({ id: messages.id }).from(messages)
    .where(and(
      inArray(messages.id, owned),
      eq(messages.accountId, accountId),
      autoReplyByUsWhere(dialect(db), {
        accountId: sql`${messages.accountId}`,
        id: sql`${messages.id}`,
        fromAddress: sql`${messages.fromAddress}`,
        messageIdHeader: sql`${messages.messageIdHeader}`,
      }),
    ));
  const autoReplyIds = new Set(arRows.map((r) => r.id));
  /**
   * The away responder's answer stamp — one query per page, on the ORIGINAL, not the reply. Keyed
   * on `owned`: the account filter has already run. Which rows count: `outcome in
   * ('sent','unverified')` — "the claim is kept and no second reply will ever be offered"; the
   * guard for the term is a `throttled` row carrying a `sent_at`, reachable by hand repair, the
   * only shape where dropping it changes an answer. `isNotNull(sent_at)` is a NARROWING, not a
   * second guard: `iso()` answers `null` for a null instant, so removing it changes the rows
   * crossing the wire and no answer — measured, which is why it is documented rather than pinned
   * by a test that could not fail. The ledger's UNIQUE is why no `distinct` is needed.
   */
  const wrRows = await db.select({
    messageId: awayReplies.messageId, sentAt: awayReplies.sentAt,
  }).from(awayReplies)
    .where(and(
      inArray(awayReplies.messageId, owned),
      eq(awayReplies.accountId, accountId),
      inArray(awayReplies.outcome, ["sent", "unverified"]),
      isNotNull(awayReplies.sentAt),
    ));
  const awayRepliedBy = new Map(wrRows.map((r) => [r.messageId, iso(r.sentAt)]));

  const fsBy = new Map(fsRows.map((r) => [r.messageId, r]));
  const stBy = new Map(stRows.map((r) => [r.messageId, r]));
  const tagsBy = new Map<string, string[]>();
  for (const r of mtRows) {
    const list = tagsBy.get(r.messageId);
    if (list) list.push(r.tagId);
    else tagsBy.set(r.messageId, [r.tagId]);
  }
  for (const m of rows) {
    out.set(m.id, messageRowToDTO(
      m, fsBy.get(m.id), stBy.get(m.id), tagsBy.get(m.id), autoReplyIds.has(m.id),
      // `?? null` and never `undefined`: the batch ASKED, so "no ledger row" is a known answer
      // and says so on the wire. Absent is reserved for a caller that did not ask.
      awayRepliedBy.get(m.id) ?? null,
    ));
  }
  return out;
}

/**
 * The same six queries as {@link materializeMessages}, in the caller's order.
 * `materializeMessages` is keyed by id and says nothing about sequence — right for `getChanges`,
 * whose `change_log` page carries the order. A snapshot page IS an ordered window (newest first,
 * keyset-paged), so it needs the DTOs back in the order it asked. Ids the account does not own
 * are absent from the map and simply skipped, preserving the batch's account filter rather than
 * re-implementing it. `opts` passes straight through, so a caller that owes its reader a
 * just-written row keeps the receipt reader's `deleted: "include"` while paying one page of round
 * trips.
 */
export async function materializeMessagesInOrder(
  db: Db, accountId: string, ids: readonly string[], opts: MaterializeMessagesOpts = {},
): Promise<MessageDTO[]> {
  const byId = await materializeMessages(db, accountId, ids, opts);
  const out: MessageDTO[] = [];
  for (const id of ids) {
    const dto = byId.get(id);
    if (dto) out.push(dto);
  }
  return out;
}

export async function materializeMessage(db: Db, accountId: string, id: string): Promise<MessageDTO | null> {
  // `include`: the singular is the RECEIPT reader — every caller is a route echoing the row it
  // just wrote, and one of them (`MessageService.delete`) has just stamped `deleted_at` on it.
  // The living-view rule is the batch's default; see the header above.
  return (await materializeMessages(db, accountId, [id], { deleted: "include" })).get(id) ?? null;
}

export async function materializeMessageState(db: Db, accountId: string, id: string): Promise<MessageStateDTO | null> {
  const [st] = await db.select().from(messageStates)
    .where(and(eq(messageStates.id, id), eq(messageStates.accountId, accountId))).limit(1);
  return st ? messageStateRowToDTO(st) : null;
}

/**
 * The batched small-state readers — one query per TYPE, not one per ROW. `getChanges` used to
 * route every non-message/thread/folder change through the per-id readers, one sequential round
 * trip each: invisible on a steady-state page, dominant on a BACKLOG page — measured on the live
 * serverless path, a 500-row page carrying 38 `message_state`/`draft` changes spent ~680 ms of
 * its 1,084 ms p50 in that loop, ~18 ms per row. Same fix as `materializeMessages`, for the
 * remaining volume types: one `inArray` read per type present on the page, projected by the SAME
 * `xRowToDTO` the per-id reader uses, so the paths cannot drift. Account scoping is on every
 * predicate; an id the account does not own is absent from the map — a delete tombstone.
 */
export async function materializeMessageStates(
  db: Db, accountId: string, ids: readonly string[],
): Promise<Map<string, MessageStateDTO>> {
  const out = new Map<string, MessageStateDTO>();
  if (ids.length === 0) return out;
  const rows = await db.select().from(messageStates)
    .where(and(inArray(messageStates.id, [...new Set(ids)]), eq(messageStates.accountId, accountId)));
  for (const r of rows) out.set(r.id, messageStateRowToDTO(r));
  return out;
}

export async function materializeRoutingDecisions(
  db: Db, accountId: string, ids: readonly string[],
): Promise<Map<string, RoutingDecisionDTO>> {
  const out = new Map<string, RoutingDecisionDTO>();
  if (ids.length === 0) return out;
  const rows = await db.select().from(routingDecisions)
    .where(and(inArray(routingDecisions.id, [...new Set(ids)]), eq(routingDecisions.accountId, accountId)));
  for (const r of rows) out.set(r.id, routingDecisionRowToDTO(r));
  return out;
}

export async function materializeApprovals(
  db: Db, accountId: string, ids: readonly string[],
): Promise<Map<string, ApprovalDTO>> {
  const out = new Map<string, ApprovalDTO>();
  if (ids.length === 0) return out;
  const rows = await db.select().from(approvals)
    .where(and(inArray(approvals.id, [...new Set(ids)]), eq(approvals.accountId, accountId)));
  for (const r of rows) out.set(r.id, approvalRowToDTO(r));
  return out;
}

/**
 * One change per CHILD row of the messages on a page — three queries, whatever the page holds.
 * `message_state`, a pending `routing_decision` and an `approval` all describe a message, so the
 * snapshot reads them BY PARENT rather than by account: at most `limit` parents is at most
 * `limit` children, and a child can never be delivered without the row it describes. Keyed on
 * `messageId`, not the child's own id — what separates this from the readers above, which
 * re-materialize a `change_log` row by entity id. A DECIDED routing decision is history and stays
 * out: the delta carries a decision's outcome. `accountId` is on every predicate beside the
 * `messageId` filter, belt and braces: a page naming another account's message must fail closed.
 */
export interface MessageChildChange {
  type: "message_state" | "routing_decision" | "approval";
  id: string;
  entity: MessageStateDTO | RoutingDecisionDTO | ApprovalDTO;
  updatedAt: string;
}

export async function materializeMessageChildren(
  db: Db, accountId: string, messageIds: readonly string[],
): Promise<MessageChildChange[]> {
  const out: MessageChildChange[] = [];
  if (messageIds.length === 0) return out;
  const ids = [...new Set(messageIds)];

  const stateRows = await db.select().from(messageStates)
    .where(and(eq(messageStates.accountId, accountId), inArray(messageStates.messageId, ids)));
  for (const s of stateRows) {
    out.push({
      type: "message_state", id: s.id, entity: messageStateRowToDTO(s),
      updatedAt: s.updatedAt.toISOString(),
    });
  }

  const decisionRows = await db.select().from(routingDecisions).where(and(
    eq(routingDecisions.accountId, accountId),
    eq(routingDecisions.status, "pending_approval"),
    inArray(routingDecisions.messageId, ids),
  ));
  for (const d of decisionRows) {
    out.push({
      type: "routing_decision", id: d.id, entity: routingDecisionRowToDTO(d),
      updatedAt: d.updatedAt.toISOString(),
    });
  }

  const approvalRows = await db.select().from(approvals)
    .where(and(eq(approvals.accountId, accountId), inArray(approvals.messageId, ids)));
  for (const a of approvalRows) {
    out.push({
      type: "approval", id: a.id, entity: approvalRowToDTO(a),
      updatedAt: a.updatedAt.toISOString(),
    });
  }

  return out;
}

export async function materializeRules(
  db: Db, accountId: string, ids: readonly string[],
): Promise<Map<string, RuleDTO>> {
  const out = new Map<string, RuleDTO>();
  if (ids.length === 0) return out;
  const rows = await db.select().from(rules)
    .where(and(inArray(rules.id, [...new Set(ids)]), eq(rules.accountId, accountId)));
  for (const r of rows) out.set(r.id, ruleRowToDTO(r));
  return out;
}

export async function materializeDrafts(
  db: Db, accountId: string, ids: readonly string[],
): Promise<Map<string, DraftDTO>> {
  const out = new Map<string, DraftDTO>();
  if (ids.length === 0) return out;
  const rows = await db.select().from(drafts)
    .where(and(inArray(drafts.id, [...new Set(ids)]), eq(drafts.accountId, accountId)));
  for (const r of rows) out.set(r.id, draftRowToDTO(r));
  return out;
}

export async function materializeTags(
  db: Db, accountId: string, ids: readonly string[],
): Promise<Map<string, TagDTO>> {
  const out = new Map<string, TagDTO>();
  if (ids.length === 0) return out;
  const rows = await db.select().from(tags)
    .where(and(inArray(tags.id, [...new Set(ids)]), eq(tags.accountId, accountId)));
  for (const r of rows) out.set(r.id, tagRowToDTO(r));
  return out;
}

/**
 * One thread row + ITS messages (date-ascending) + the folder_state of the first of them → DTO.
 *
 * `msgs` must already be ordered oldest-first and must be exactly this thread's messages: the DTO
 * publishes `messageIds` in that order and derives `unreadCount` and `folder` from it. Both
 * readers below hand it the same shape, which is the point of it being a function.
 */
export function threadRowsToDTO(
  t: typeof threads.$inferSelect,
  msgs: readonly (typeof messages.$inferSelect)[],
  firstFolderState: typeof folderState.$inferSelect | undefined,
): ThreadDTO {
  let folder: Folder = "INBOX";
  const first = msgs[0];
  if (first) {
    const loc = (first.nativeLocator as { folder?: string } | null) ?? null;
    folder = (firstFolderState?.desiredFolder ?? loc?.folder ?? "INBOX") as Folder;
  }
  return {
    id: t.id,
    accountId: t.accountId,
    subject: t.subject,
    messageIds: msgs.map((m) => m.id),
    participants: (t.participants as EmailAddress[]) ?? [],
    lastMessageAt: (iso(t.lastMessageAt) ?? t.updatedAt.toISOString()),
    unreadCount: msgs.filter((m) => m.unread).length,
    muted: t.muted,
    folder,
    updatedAt: t.updatedAt.toISOString(),
  };
}

export async function materializeThread(db: Db, accountId: string, id: string): Promise<ThreadDTO | null> {
  const [t] = await db.select().from(threads)
    .where(and(eq(threads.id, id), eq(threads.accountId, accountId))).limit(1);
  if (!t) return null;

  const msgs = await db.select().from(messages)
    .where(and(eq(messages.accountId, accountId), eq(messages.threadId, id)))
    .orderBy(asc(messages.date));

  const [fs] = msgs[0]
    ? await db.select().from(folderState).where(eq(folderState.messageId, msgs[0].id)).limit(1)
    : [undefined];

  return threadRowsToDTO(t, msgs, fs);
}

/**
 * Materialize MANY threads in THREE queries, whatever the count. `materializeThread` is three
 * round trips for ONE thread, and a snapshot page can reference hundreds — the exact outage shape
 * `materializeMessages` ended. The message read is a single `inArray` over the surviving thread
 * ids ordered date-ascending, grouped in returned order — each slice matches the per-id reader's
 * own `orderBy`, so the shared projection cannot see a difference. `accountId` is on the
 * `threads` AND `messages` predicates, so a foreign thread id is filtered before it can pull
 * messages into a DTO; `folder_state` is keyed by the first message of each SURVIVING thread. A
 * missing id is absent from the map.
 */
export async function materializeThreads(
  db: Db, accountId: string, ids: readonly string[],
): Promise<Map<string, ThreadDTO>> {
  const out = new Map<string, ThreadDTO>();
  if (ids.length === 0) return out;

  const unique = [...new Set(ids)];
  const tRows = await db.select().from(threads)
    .where(and(inArray(threads.id, unique), eq(threads.accountId, accountId)));
  if (tRows.length === 0) return out;

  const owned = tRows.map((t) => t.id);
  const mRows = await db.select().from(messages)
    .where(and(eq(messages.accountId, accountId), inArray(messages.threadId, owned)))
    .orderBy(asc(messages.date));

  const msgsBy = new Map<string, (typeof messages.$inferSelect)[]>();
  for (const m of mRows) {
    const key = m.threadId!;
    const list = msgsBy.get(key);
    if (list) list.push(m);
    else msgsBy.set(key, [m]);
  }

  const firstIds = owned.map((id) => msgsBy.get(id)?.[0]?.id).filter((v): v is string => v != null);
  const fsRows = firstIds.length > 0
    ? await db.select().from(folderState).where(inArray(folderState.messageId, firstIds))
    : [];
  const fsBy = new Map(fsRows.map((r) => [r.messageId, r]));

  for (const t of tRows) {
    const msgs = msgsBy.get(t.id) ?? [];
    out.set(t.id, threadRowsToDTO(t, msgs, msgs[0] ? fsBy.get(msgs[0].id) : undefined));
  }
  return out;
}

export async function materializeRoutingDecision(db: Db, accountId: string, id: string): Promise<RoutingDecisionDTO | null> {
  const [r] = await db.select().from(routingDecisions)
    .where(and(eq(routingDecisions.id, id), eq(routingDecisions.accountId, accountId))).limit(1);
  return r ? routingDecisionRowToDTO(r) : null;
}

export async function materializeApproval(db: Db, accountId: string, id: string): Promise<ApprovalDTO | null> {
  const [a] = await db.select().from(approvals)
    .where(and(eq(approvals.id, id), eq(approvals.accountId, accountId))).limit(1);
  return a ? approvalRowToDTO(a) : null;
}

export async function materializeRule(db: Db, accountId: string, id: string): Promise<RuleDTO | null> {
  const [r] = await db.select().from(rules)
    .where(and(eq(rules.id, id), eq(rules.accountId, accountId))).limit(1);
  return r ? ruleRowToDTO(r) : null;
}

/**
 * Re-materialize a draft into DraftDTO. MANDATORY: `EntityType` already
 * includes `"draft"`, so without this case a `draft` change_log row would fall
 * through to `default: null` and SyncService would delete-tombstone every live
 * draft. accountId-scoped.
 */
export async function materializeDraft(db: Db, accountId: string, id: string): Promise<DraftDTO | null> {
  const [d] = await db.select().from(drafts)
    .where(and(eq(drafts.id, id), eq(drafts.accountId, accountId))).limit(1);
  return d ? draftRowToDTO(d) : null;
}

/**
 * Re-materialize the CURRENT DTO for a `change_log` row's entity. Returns
 * `null` when the live entity is gone → SyncService emits a `delete` tombstone.
 * Unknown/not-yet-implemented entity types return `null` (tombstone) rather than
 * throwing, so an unrecognized change never wedges the feed.
 */
/**
 * One `tags` row → `TagDTO`. Its existence is the precondition for growing
 * `EntityType`: without this case `materialize` would fall through to `null` and `SyncService`
 * would read every tag change as a tombstone, deleting each tag from the client the moment it
 * was created. Added alongside the `"tag"` union member, deliberately.
 *
 * No `className` — see the migration. The client derives it from `hue`.
 */
export async function materializeTag(db: Db, accountId: string, id: string): Promise<TagDTO | null> {
  const [t] = await db.select().from(tags)
    .where(and(eq(tags.id, id), eq(tags.accountId, accountId))).limit(1);
  return t ? tagRowToDTO(t) : null;
}

/**
 * One `mailbox_folders` row → the `folder` entity (FOLDERS-SPEC.md §4). Pure — the reads (the
 * mailbox join, the exclusion, the flag) have already happened in `materializeFolder`.
 */
export function folderRowToDTO(r: UserFolderRow): FolderDTO {
  return {
    id: r.id,
    name: r.folder,
    mailboxId: r.mailboxId,
    mailbox: r.address,
    updatedAt: r.updatedAt.toISOString(),
    // The in-flight command marker (stage 2) rides only when one exists, so a settled folder's
    // DTO — every folder of every account that never used the verbs — is byte-identical to the
    // foundation's.
    ...(r.op
      ? {
          op: {
            kind: r.op.kind,
            ...(r.op.to !== null ? { to: r.op.to } : {}),
            ...(r.op.error !== null ? { error: r.op.error } : {}),
          },
        }
      : {}),
  };
}

/**
 * The delta materializer for `folder` change rows. THREE nulls, all deliberate and all drained
 * as delete tombstones: the row is gone, the row is excluded (never a user folder), or the
 * account's "Use folders" flag is OFF — the last one is what keeps a disable's tombstones and
 * any straggler rows from re-materializing after the flag went off, so a flag-off account's
 * delta carries no live `folder` entity ever (the parity claim, spec §10).
 */
async function materializeFolder(db: Db, accountId: string, id: string): Promise<FolderDTO | null> {
  if (!(await foldersEnabled(db, accountId))) return null;

  const row = await userFolderById(db, accountId, id);
  return row ? folderRowToDTO(row) : null;
}

/**
 * The account's settings row — the `"settings"` entity. NEVER NULL for the caller's own account,
 * and that is load-bearing: `getChanges` reads a null entity as a tombstone and would drain the
 * change as a DELETE — but "no row yet" is a real settings state (every knob at its default), not
 * an absence: a missing row materializes as the default-shaped DTO, exactly what `GET /consent`
 * reports. The id is the ACCOUNT id; any other id answers null, indistinguishable from missing,
 * tombstoned harmlessly. The per-mailbox exceptions live on `mailboxes.folders_disabled_at` (spec
 * §17) and travel here because "which mailboxes are switched off?" is a settings question
 * wherever the column lives.
 */
export async function materializeSettings(db: Db, accountId: string, id: string): Promise<SettingsDTO | null> {
  if (id !== accountId) return null;
  const [row] = await db.select().from(accountSettings)
    .where(eq(accountSettings.accountId, accountId)).limit(1);
  const off: Record<string, string> = {};
  const boxes = await db.select({ id: mailboxes.id, at: mailboxes.foldersDisabledAt })
    .from(mailboxes).where(eq(mailboxes.accountId, accountId));
  for (const b of boxes) {
    if (b.at !== null) off[b.id] = b.at.toISOString();
  }
  // THE PER-MAILBOX SIGNATURES (mail 0075) ARE DELIBERATELY NOT ON THIS ENTITY, and the
  // absence is a bound, not an omission. Every signature write appends its
  // own settings change row, and this materializer runs once PER ROW with no compaction — so
  // a batch of N signature writes would repeat the account's ENTIRE signature map N times in
  // the next delta (N mailboxes at the 10 000-character ceiling is megabytes of repetition).
  // The entity is the DOORBELL: its stamp moves per write, every stamp-watching client
  // re-asks GET /consent, and THAT read carries the map exactly once. Nothing consumes a
  // signatures field here — the compose surfaces and the Settings pane all read the consent
  // answer — so the field would be pure amplification.
  return {
    accountId,
    dormancyDays: row?.dormancyDays ?? null,
    autoSuggestAt: iso(row?.autoSuggestAt),
    blockRemoteImagesAt: iso(row?.blockRemoteImagesAt),
    loadTrackingPixelsAt: iso(row?.loadTrackingPixelsAt),
    blockAutoUnsubscribeAt: iso(row?.blockAutoUnsubscribeAt),
    foldersEnabledAt: iso(row?.foldersEnabledAt),
    folderMailboxesOff: off,
    locale: row?.locale ?? null,
    // A missing row still needs a stamp the client can compare; the epoch is honest for "nothing
    // was ever written", and the first real write replaces it with the row's own.
    updatedAt: row?.updatedAt ? row.updatedAt.toISOString() : new Date(0).toISOString(),
  };
}

export function materialize(db: Db, accountId: string, type: EntityType, id: string): Promise<unknown | null> {
  switch (type) {
    case "message": return materializeMessage(db, accountId, id);
    case "folder": return materializeFolder(db, accountId, id);
    case "tag": return materializeTag(db, accountId, id);
    case "message_state": return materializeMessageState(db, accountId, id);
    case "thread": return materializeThread(db, accountId, id);
    case "routing_decision": return materializeRoutingDecision(db, accountId, id);
    case "approval": return materializeApproval(db, accountId, id);
    case "rule": return materializeRule(db, accountId, id);
    case "draft": return materializeDraft(db, accountId, id);
    case "settings": return materializeSettings(db, accountId, id);
    default: return Promise.resolve(null);
  }
}
