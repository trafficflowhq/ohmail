import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { foldersEnabled, userFolderById, type UserFolderRow } from "../folders.js";
import type { EmailAddress } from "@trafficflow/core/mail";
import {
  accountSettings, mailboxes,
  messages, folderState, messageStates, threads, routingDecisions, approvals, rules, drafts,
  tags, messageTags,
  type EntityType,
} from "@trafficflow/db";
import type { Db } from "../context.js";
import type {
  FolderDTO, SettingsDTO,
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
 *
 * ── A SOFT-DELETED ROW MATERIALIZES AS ABSENT, BY DEFAULT ──────────────────────────────────
 *
 * `deleted_at IS NULL` is the living-view rule (schema-mail.ts states it beside the column),
 * and this batch is the LIVING-VIEW reader: it feeds `/sync`'s delta prefetch, whose tombstone
 * seam turns "absent from the prefetch" into an `op: "delete"` — and whose own comments, plus
 * the coalesced stale read's entire equivalence argument ("a dead entity's latest change
 * materializes null → tombstone"), always CLAIMED this held. It did not: any writer emitting a
 * `message` update change after a delete — `bubbleUpPass` firing a schedule the delete
 * deliberately leaves standing (`spendResurface` is scoped to `resurfaced` alone) — had that
 * update re-materialize the full DTO, and the mail the user threw away reappeared on every
 * mirror. On a coalesced stale resume it was worse: the update SUPERSEDED the delete tombstone,
 * so the deletion was never delivered at all. Found by the verb-parity harness
 * (`packages/client-engine/test/verb-parity/`, the message_delete × bubbleUpPass scenario).
 *
 * `deleted: "include"` is the receipt reader: a route that has just stamped `deleted_at` still
 * owes its caller the DTO (`MessageService.delete` 500s without it), and an idempotent replay
 * re-serves that stored receipt. Nothing that feeds a mirror may pass it.
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
 * ── THE BATCHED SMALL-STATE READERS — one query per TYPE, not one per ROW ──────────────────
 *
 * `SyncService.getChanges` used to route every non-message/thread/folder change through the
 * per-id readers above, one sequential round trip each. That is invisible on a steady-state
 * page (a handful of rows) and dominant on a BACKLOG page: measured on the live serverless
 * path (2026-08-29, a live account, a 1,500-row stale resume), a 500-row page carrying 38
 * `message_state`/`draft` changes spent ~680 ms of its 1,084 ms p50 in that loop — ~18 ms of
 * round trip per row, the exact shape `materializeMessages` and `materializeThreads` were
 * written to end for their types. These are the same fix for the remaining volume types: one
 * `inArray` read per type present on the page, projected by the SAME `xRowToDTO` the per-id
 * reader uses, so the two paths cannot drift.
 *
 * Account scoping is on every predicate exactly as the per-id readers have it; an id the
 * account does not own is simply absent from the map, which the caller reads as the per-id
 * reader's `null` — a delete tombstone.
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
 * THE ACCOUNT'S SETTINGS ROW — the `"settings"` entity (`change-log.ts` names why it exists).
 *
 * NEVER NULL for the caller's own account, and that is load-bearing: `SyncService.getChanges`
 * reads a null entity as a tombstone and would drain the change to every client as a DELETE —
 * but "no row yet" is a real settings state (every knob at its default, created lazily by the
 * first write), not an absence. So a missing row materializes as the default-shaped DTO, exactly
 * what `GET /consent` reports for the same account.
 *
 * The id is the ACCOUNT id (one row per account); a change row naming any other id is not this
 * account's settings and answers null like every cross-account read here — indistinguishable
 * from missing, which the feed then tombstones harmlessly.
 *
 * The per-mailbox exceptions live on `mailboxes.folders_disabled_at` (spec §17), not on the
 * settings row, and travel here because the client-facing question — "which mailboxes did this
 * account switch off?" — is a settings question wherever the column lives.
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
