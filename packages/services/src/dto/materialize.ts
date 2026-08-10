import { and, asc, eq, inArray } from "drizzle-orm";
import type { EmailAddress } from "@trafficflow/core/mail";
import {
  messages, folderState, messageStates, threads, routingDecisions, approvals, rules, drafts,
  tags, messageTags,
  type EntityType,
} from "@trafficflow/db";
import type { Db } from "../context.js";
import type {
  Folder, MessageDTO, MessageStateDTO, ThreadDTO, RoutingDecisionDTO, ApprovalDTO, RuleDTO,
  DraftDTO, DraftStatus, SensitivityFlags, TriageState, TagDTO,
} from "./types.js";

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

/**
 * ── THE ROW → DTO PROJECTIONS ARE EXPORTED, AND THAT IS THE POINT OF THEM ────────────────────
 *
 * Every `materializeX` below is "one `select` by id, then project". `SyncService.getChanges`
 * needs the by-id half because it starts from a `change_log` row; `SyncService.getSnapshot`
 * needs to read a whole table at once and must NOT pay one round trip per row (an account that
 * has run the consent seed holds one rule per correspondent — thousands of them, and an N+1
 * there is the same shape as the outage `materializeMessages` was written to end).
 *
 * So the projection is a separate, pure function per type and the by-id reader calls it. Both
 * callers therefore produce the identical DTO by construction rather than by inspection — the
 * same reason `messageRowToDTO` was extracted when the batch message path landed. A snapshot
 * that projected its own rules would be a second definition of what a rule looks like on the
 * wire, and the two would drift on the first field either side added.
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
 * ONE message row → its DTO. Pure: every read has already happened.
 *
 * Extracted so the single-id path and the batch path cannot drift. They used to be the same
 * function because there WAS only one path, and the cost of that hid in `SyncService`, which
 * called it once per `change_log` row — three sequential round-trips per message, 1 500 for a
 * 500-row page. At real database round-trip latency that pushed a single page past the function
 * timeout and a full bootstrap into the minutes, so the first page timed out and the client
 * received NOTHING. On a large mailbox every view rendered empty.
 *
 * EXPORTED so the sensitivity projection can be watched directly rather than only through a
 * database round trip. `sensitive` decides whether a client renders a message's text AT ALL
 * (see the note inside), which is too consequential to be reachable only through a fixture.
 */
export function messageRowToDTO(
  m: typeof messages.$inferSelect,
  fs: typeof folderState.$inferSelect | undefined,
  st: typeof messageStates.$inferSelect | undefined,
  labels: readonly string[] | undefined,
): MessageDTO {
  const loc = (m.nativeLocator as { folder?: string } | null) ?? null;
  const folder = (fs?.desiredFolder ?? loc?.folder ?? "INBOX") as Folder;
  const category = (m.sensitivityCategory as SensitivityFlags["category"]) ?? null;
  /**
   * ── `sensitive` IS THE POSITIVE MATCH, AND ONLY THE POSITIVE MATCH ────────────────────────
   *
   * Core owns this definition and states it in one line: `const sensitive = category !== null`
   * (`packages/core/src/sensitive.ts`), directly above the rule that explains why the OTHER four
   * flags are not it — *"`no_ai` and `no_kb` fail CLOSED on indeterminate … fail-closed is a rule
   * about disclosure to a model, not a licence to block user actions"*. `no_forward` and
   * `priority` follow the positive match exactly, so they can only ever agree with `category`;
   * `no_ai` and `no_kb` are set for the whole INDETERMINATE bucket as well, and that bucket is
   * ordinary mail we declined to show a model.
   *
   * This line used to OR all five together, and that widening is not cosmetic, because the client
   * treats the field as "render no text at all": `isProtectedMessage` (client-engine) reads
   * `sensitivity.sensitive` and nothing else, `OhmailEngine.hydrateBody` refuses to fetch a body
   * for such a message, and the mirror purges any body it already held.
   *
   * The size of the error follows from the classifier's own structure rather than from any one
   * mailbox: `no_ai` and `no_kb` are true for `sensitive` AND for the whole `indeterminate`
   * bucket, so the OR is a STRICT SUPERSET of the categorised set, and everything in the
   * difference is by definition mail the classifier did NOT positively classify. Every one of
   * those was unreadable, and unreadable in the worst way available: the reader surfaces have no
   * request to wait for, so they sat on "Loading the full message…" for ever.
   *
   * So this is not a narrowing for tidiness — it is this projection being brought back to the
   * definition core already publishes, and the flags it drops remain on the DTO below, where a
   * caller that genuinely means "was this withheld from the model" reads them by name.
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
    from: { name: null, address: m.fromAddress },
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
  };
}

/**
 * Materialize MANY messages in FOUR queries, whatever the count.
 *
 * The shape that matters is not "faster" but "constant": a page of 500 costs the same number of
 * round-trips as a page of 1, so the sync endpoint's latency stops scaling with the mailbox. A
 * missing id is simply absent from the map, which is the same signal the single-id path gives by
 * returning null, so `SyncService` still emits its tombstone unchanged.
 *
 * THREE became FOUR, and the count is in this sentence because it is the property under
 * test — `materialize-batch.test.ts` counts round-trips, so a future N+1 fails here rather than
 * being discovered on a production bootstrap. The tag lookup is one `inArray` over
 * `message_tags` keyed by the SAME surviving ids as the other two side tables, which is why it
 * costs one query and not one per message.
 *
 * `accountId` is on the `messages` predicate, so an id belonging to another account is filtered
 * before it can be assembled — the batch cannot widen what a caller may see. The three side
 * tables are keyed by the message ids that survived that filter, never by the caller's raw
 * input. `message_tags` additionally carries its own `account_id` and it is ALSO filtered on,
 * belt and braces: that column is denormalized, so a bug that ever let it disagree with the
 * message's owner must fail closed rather than leak one account's tag names to another.
 */
export async function materializeMessages(
  db: Db, accountId: string, ids: readonly string[],
): Promise<Map<string, MessageDTO>> {
  const out = new Map<string, MessageDTO>();
  if (ids.length === 0) return out;

  const unique = [...new Set(ids)];
  const rows = await db.select().from(messages)
    .where(and(inArray(messages.id, unique), eq(messages.accountId, accountId)));
  if (rows.length === 0) return out;

  const owned = rows.map((r) => r.id);
  const fsRows = await db.select().from(folderState).where(inArray(folderState.messageId, owned));
  const stRows = await db.select().from(messageStates).where(inArray(messageStates.messageId, owned));
  const mtRows = await db.select().from(messageTags)
    .where(and(inArray(messageTags.messageId, owned), eq(messageTags.accountId, accountId)));

  const fsBy = new Map(fsRows.map((r) => [r.messageId, r]));
  const stBy = new Map(stRows.map((r) => [r.messageId, r]));
  const tagsBy = new Map<string, string[]>();
  for (const r of mtRows) {
    const list = tagsBy.get(r.messageId);
    if (list) list.push(r.tagId);
    else tagsBy.set(r.messageId, [r.tagId]);
  }
  for (const m of rows) {
    out.set(m.id, messageRowToDTO(m, fsBy.get(m.id), stBy.get(m.id), tagsBy.get(m.id)));
  }
  return out;
}

/**
 * The same four queries as {@link materializeMessages}, in the caller's order.
 *
 * `materializeMessages` is keyed by id and therefore says nothing about sequence, which is
 * exactly right for `getChanges` (the `change_log` page already carries the order). A snapshot
 * page IS an ordered window — newest first, keyset-paged — so it needs the DTOs back in the
 * order it asked for them. Ids the account does not own are absent from the map and are simply
 * skipped here, which preserves the batch's account filter rather than re-implementing it.
 */
export async function materializeMessagesInOrder(
  db: Db, accountId: string, ids: readonly string[],
): Promise<MessageDTO[]> {
  const byId = await materializeMessages(db, accountId, ids);
  const out: MessageDTO[] = [];
  for (const id of ids) {
    const dto = byId.get(id);
    if (dto) out.push(dto);
  }
  return out;
}

export async function materializeMessage(db: Db, accountId: string, id: string): Promise<MessageDTO | null> {
  return (await materializeMessages(db, accountId, [id])).get(id) ?? null;
}

export async function materializeMessageState(db: Db, accountId: string, id: string): Promise<MessageStateDTO | null> {
  const [st] = await db.select().from(messageStates)
    .where(and(eq(messageStates.id, id), eq(messageStates.accountId, accountId))).limit(1);
  return st ? messageStateRowToDTO(st) : null;
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
 * Materialize MANY threads in THREE queries, whatever the count.
 *
 * `materializeThread` is three round trips for ONE thread, and a full snapshot page can reference
 * hundreds of them — well over a thousand sequential round trips, which is the exact shape of the
 * outage `materializeMessages` was written to end. This is the same fix for the same reason: a
 * page of forty threads costs what a page of one costs.
 *
 * The message read is a SINGLE `inArray` over the surviving thread ids ordered date-ascending,
 * then grouped in Postgres's returned order — so each thread's slice is date-ascending exactly as
 * the per-id reader's own `orderBy` produces, and the shared projection cannot see a difference.
 *
 * `accountId` is on the `threads` predicate AND on the `messages` predicate, so a thread id from
 * another account is filtered before it is assembled and cannot pull that account's messages into
 * a DTO. `folder_state` is keyed by the first message of each SURVIVING thread, never by caller
 * input. A missing id is simply absent from the map — the same signal the per-id reader gives by
 * returning null.
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

export function materialize(db: Db, accountId: string, type: EntityType, id: string): Promise<unknown | null> {
  switch (type) {
    case "message": return materializeMessage(db, accountId, id);
    case "tag": return materializeTag(db, accountId, id);
    case "message_state": return materializeMessageState(db, accountId, id);
    case "thread": return materializeThread(db, accountId, id);
    case "routing_decision": return materializeRoutingDecision(db, accountId, id);
    case "approval": return materializeApproval(db, accountId, id);
    case "rule": return materializeRule(db, accountId, id);
    case "draft": return materializeDraft(db, accountId, id);
    default: return Promise.resolve(null);
  }
}
