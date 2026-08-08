import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { recordChange } from "@trafficflow/db";
import {
  approvals, drafts, folderState, messageBodies, messageStates, messages, messageTags,
  routingDecisions, rules, tags, threads,
} from "@trafficflow/db/mail";
import type {
  ApprovalDTO, ChangeOp, DraftDTO, EntityType, MessageBodyBatchItem, MessageDTO, MessageStateDTO,
  Page, RoutingDecisionDTO, RuleDTO, SyncChange, SyncResponse, TagDTO, ThreadDTO,
} from "@trafficflow/services/mail";
import type { LocalDb } from "./db.js";
import type { LocalWorld } from "./identity.js";
import type { CloudAuth } from "./cloud-auth.js";
import { stampSynced } from "./sync-stamp.js";
import type { Diagnostic } from "./log.js";

/**
 * THE CLOUD MIRROR — pull the hosted account's change feed and apply it into the local mail
 * schema, so the desktop reads a complete mirror WITHOUT ever organizing the mailbox.
 *
 * This is the CloudMirror SOURCE. It is deliberately the whole of what a Cloud-mode install does
 * to the mail store: it has no IMAP adapter, takes no organizer lease and runs no sync loop —
 * `cloud-engine.ts`'s module graph reaches none of the three, and a census
 * (`test/cloud-engine-census.test.ts`) makes that structural rather than a matter of discipline.
 * The hosted worker stays the single organizer; this process is a reader of what the worker filed.
 *
 * ── THE FIVE CONVERGENCE RULES, PORTED INTO UPSERTS ───────────────────────────────────────────
 *
 * `packages/client-engine/src/apply.ts` proves the `/sync` contract against a `Map`; the same five
 * rules hold here against SQL:
 *
 *   1. sort a page's merged buckets by ascending `seq` (the order of record);
 *   2. apply keyed on (type,id) as an idempotent upsert;
 *   3. an older-or-equal seq never overwrites — satisfied structurally, since a page is applied in
 *      ascending seq and pages are applied in cursor order, so the last write for an id wins and a
 *      replay re-applies the same or newer state;
 *   4. delete ⇒ remove the row (a later create resurrects via the upsert);
 *   5. move ⇒ the carried DTO is upserted like any other, and its folder lands in `folder_state`.
 *
 * Applying the same page twice — the crash-recovery case, since the cursor is written AFTER the
 * commit — converges, because every write is an upsert and every delete is unconditional.
 *
 * ── THE REMAP IS LOAD-BEARING ─────────────────────────────────────────────────────────────────
 *
 * Every DTO carries the HOSTED account's `accountId`/`mailboxId`. The local database is scoped by
 * the single synthetic local identity (`identity.ts`), so every row is written under
 * `world.accountId`/`world.mailboxId`. Skipping this yields a full mirror keyed to an account the
 * local reader has never heard of — it renders EMPTY, because `materializeMessages` filters on the
 * local account. Entity IDs (message id, thread id, …) are the `/sync` feed's own keys and are
 * preserved unchanged.
 *
 * ── AND ONE LOCAL `recordChange` PER APPLIED ENTITY ───────────────────────────────────────────
 *
 * The Swift projection reads the sidecar's OWN `/sync`, which is `change_log` over the local
 * database. So each applied entity appends one local change-log row inside the same transaction —
 * a LOCAL seq unrelated to the Cloud cursor — and that is what makes the projection's `/sync`
 * advance. Message bodies are the exception: they are not a `/sync` entity (the client hydrates
 * them separately), so they are upserted without a change-log row.
 */

/**
 * The nine `/sync` entity types the hosted feed carries (`packages/api/src/routes/sync.ts`).
 *
 * `"tag"` IS ONE OF THEM, and its absence here is why a hosted account's tags did not reach the
 * desktop. This list is sent as `?types=`, so it is a request as well as a description: leaving a
 * type out asks the server not to send it. Tag ASSIGNMENTS are not a type of their own — they ride
 * `message`, as `MessageDTO.labels`, which is why {@link applyUpsert} writes both from one change.
 */
export const CLOUD_SYNC_TYPES: readonly EntityType[] = [
  "message", "thread", "routing_decision", "approval",
  "draft", "rule", "message_state", "folder", "tag",
];

/**
 * FK-safe application order for a page's non-deletes. A message references its thread, a triage
 * state / routing decision references its message, so parents land first and a message upserts a
 * thread stub for a thread that has not arrived yet. Deletes run in the reverse of this order.
 *
 * `tag` is FIRST, ahead of `message`, and that ordering is what makes the label writes work: a
 * message's `labels` are foreign keys into `tags`, and the tag they name is always created before
 * it can be assigned — so within a page ordered by seq the tag's own change is already in hand by
 * the time the message carrying the assignment is applied.
 */
const APPLY_ORDER: readonly EntityType[] = [
  "tag", "thread", "message", "message_state", "rule", "draft", "approval", "routing_decision",
];

const DEFAULT_PAGE_LIMIT = 500;
const DEFAULT_BODIES_LIMIT = 100;

interface CursorState {
  /** The hosted `/sync` cursor. `"0"` bootstraps a full replay. */
  sync: string;
  /** The `GET /messages/bodies` keyset cursor (a message id), or null before/at the end. */
  bodies: string | null;
  /**
   * Set while a `since=0` bootstrap is in flight and its trailing sweep has NOT yet run. It is what
   * makes the mark-and-sweep crash-safe: a bootstrap that commits a page then dies leaves a NON-zero
   * cursor, and resuming incrementally from it would rebuild only a PARTIAL generation and sweep real
   * rows. So a launch that finds this set restarts the whole bootstrap from zero — rebuilding the
   * complete generation — and clears it only once the sweep has run.
   */
  bootstrapping: boolean;
}

export interface CloudMirrorConfig {
  db: LocalDb;
  world: LocalWorld;
  auth: CloudAuth;
  /** `<dataDir>/cloud-cursor.json` — a file beside `sidecar.lock`, never a table (the journal is shared). */
  cursorPath: string;
  log?: Diagnostic;
  now?: () => Date;
  /** `/sync` page size. Production takes the default; a test shrinks it to force multiple pages. */
  pageLimit?: number;
  /** How long to wait between full pulls when caught up. */
  pollIntervalMs?: number;
}

export interface CloudMirror {
  /** Drain `/sync` to the horizon, then backfill bodies. Returns the number of applied entities. */
  pullOnce(): Promise<number>;
  /** Pull now, then poll. */
  start(): Promise<void>;
  /** Stop polling. */
  stop(): void;
  /**
   * Is the hosted account reachable right now? True optimistically at construction; a pull that
   * fails (bad network, spent token) flips it false, a pull that succeeds flips it back. The
   * write-through proxy reads this to answer `503 offline_read_only` rather than forward into a
   * void, and `/health` surfaces it so the shell can render the mode.
   */
  online(): boolean;
  /** Report connectivity observed elsewhere — the proxy's own forward reaching Cloud, or not. */
  markConnectivity(reachable: boolean): void;
  /**
   * The hosted `change_log` seq the mirror has drained `/sync` up to, decoded from the cursor.
   * This is the CLOUD sequence — the one an `X-Sync-Seq` echo is expressed in — NOT the local
   * `change_log`, which is a different sequence entirely. `0n` before the first page.
   */
  cloudSeq(): bigint;
  /**
   * Pull (single-flight) until `cloudSeq() >= target`, or until `deadlineMs` elapses; returns
   * whether it covered. This is the write-through echo: a hosted mutation echoes its `X-Sync-Seq`
   * (a cloud seq) and the proxy waits here so the client's immediate re-drain of the local `/sync`
   * already contains its own write.
   */
  awaitCloudSeq(target: bigint, deadlineMs: number): Promise<boolean>;
}

export const DEFAULT_CLOUD_POLL_MS = 20_000;

/**
 * Reconnect backoff. A pull that fails (dropped network, spent token) retries soon and then backs
 * off exponentially to a ceiling, rather than waiting a full poll interval or hammering every tick.
 * A success resets it and returns to the steady poll cadence.
 */
export const RECONNECT_BASE_MS = 1_000;
export const RECONNECT_MAX_MS = 300_000;

const asDate = (iso: string | null | undefined): Date | null => (iso ? new Date(iso) : null);

function readCursor(path: string): CursorState {
  try {
    const j = JSON.parse(readFileSync(path, "utf8")) as Partial<CursorState>;
    return {
      sync: typeof j.sync === "string" && j.sync !== "" ? j.sync : "0",
      bodies: typeof j.bodies === "string" ? j.bodies : null,
      bootstrapping: j.bootstrapping === true,
    };
  } catch {
    return { sync: "0", bodies: null, bootstrapping: false };
  }
}

function writeCursor(path: string, state: CursorState): void {
  writeFileSync(path, JSON.stringify(state));
}

/** Drop the cursor file. The 410 path deletes it before re-bootstrapping from zero. */
function deleteCursor(path: string): void {
  rmSync(path, { force: true });
}

/** A drain begins as a bootstrap iff it starts at `since=0` — a `""`/`"0"` cursor. */
const isBootstrapCursor = (s: string): boolean => !s || s === "0";

/**
 * A BOOTSTRAP GENERATION: the ids a since=0 re-pull touched, tagged per entity type.
 *
 * A `since=0` replay carries the account's CURRENT entities, not ancient tombstones. So a message
 * deleted on Cloud while the mirror was offline — its tombstone since fallen below the retention
 * horizon — is simply absent from the replay, and a plain re-pull would leave the local row as a
 * PHANTOM forever. The fix is mark-and-sweep: tag every managed row this generation writes, then
 * delete the managed rows it never touched. Membership is keyed by each table's own id, except
 * `message_state`, whose `/sync` id is its `messageId` (as {@link applyPage} records it).
 */
interface BootstrapGen {
  thread: Set<string>;
  message: Set<string>;
  message_state: Set<string>;
  rule: Set<string>;
  draft: Set<string>;
  approval: Set<string>;
  routing_decision: Set<string>;
  tag: Set<string>;
}

function newBootstrapGen(): BootstrapGen {
  return {
    thread: new Set(), message: new Set(), message_state: new Set(), rule: new Set(),
    draft: new Set(), approval: new Set(), routing_decision: new Set(), tag: new Set(),
  };
}

/** The tx handle `db.transaction` hands its callback. */
type Tx = Parameters<Parameters<LocalDb["transaction"]>[0]>[0];

async function messagePresent(tx: Tx, id: string): Promise<boolean> {
  const rows = await tx.select({ id: messages.id }).from(messages).where(eq(messages.id, id)).limit(1);
  return rows.length > 0;
}

async function threadPresent(tx: Tx, id: string): Promise<boolean> {
  const rows = await tx.select({ id: threads.id }).from(threads).where(eq(threads.id, id)).limit(1);
  return rows.length > 0;
}

/**
 * REPLACE a message's tag assignments with exactly the ones its DTO carries.
 *
 * ── WHY IT IS A REPLACE AND NOT AN UPSERT ───────────────────────────────────────────────────
 *
 * `labels` is the whole set, not a delta: an UNassign is delivered as the same `message` change
 * with one fewer id in it. An insert-only apply would therefore add tags and never remove one, so
 * a tag taken off a message in the browser would stay on it here for ever. Delete-then-insert
 * inside the page transaction gives the set semantics the wire actually has, and it is idempotent
 * on replay for the same reason every other write here is.
 *
 * ── AN ID NAMING A TAG WE HAVE NOT GOT IS SKIPPED, NOT STUBBED ──────────────────────────────
 *
 * `message_tags.tag_id` has a foreign key, so an assignment can only be written for a tag that is
 * already mirrored. The ordinary case is covered by {@link APPLY_ORDER}: a tag exists before it can
 * be assigned, so its change carries a lower seq and lands first. What is left is the case where
 * the tag's create has fallen below the feed's retention horizon while the message's own change has
 * not — and there the honest answer is to skip the assignment rather than invent a nameless tag to
 * hang it on. The client filters its tag list against each message's labels, so a label it cannot
 * resolve would draw nothing anyway; a stub would draw an empty chip.
 */
async function applyLabels(tx: Tx, world: LocalWorld, messageId: string, labels: readonly string[] | undefined): Promise<void> {
  await tx.delete(messageTags).where(eq(messageTags.messageId, messageId));
  if (!labels || labels.length === 0) return;
  for (const tagId of new Set(labels)) {
    const known = await tx.select({ id: tags.id }).from(tags).where(eq(tags.id, tagId)).limit(1);
    if (known.length === 0) continue;
    await tx.insert(messageTags)
      .values({ accountId: world.accountId, messageId, tagId })
      .onConflictDoNothing();
  }
}

/**
 * Apply one non-delete change. Returns false when a foreign-key referent is missing and the row
 * is skipped — the cursor still advances (a later update to the same entity re-emits it), which is
 * the forward-compatible posture `apply.ts` takes toward an unknown type.
 */
async function applyUpsert(tx: Tx, world: LocalWorld, ch: SyncChange, now: Date, gen: BootstrapGen | null): Promise<boolean> {
  switch (ch.type) {
    case "thread": {
      const t = ch.entity as ThreadDTO | undefined;
      if (!t) return false;
      await tx.insert(threads).values({
        id: t.id,
        accountId: world.accountId,
        subject: t.subject ?? "",
        participants: t.participants ?? [],
        lastMessageAt: asDate(t.lastMessageAt),
        muted: !!t.muted,
        updatedAt: asDate(t.updatedAt) ?? now,
      }).onConflictDoUpdate({
        target: threads.id,
        set: {
          subject: t.subject ?? "",
          participants: t.participants ?? [],
          lastMessageAt: asDate(t.lastMessageAt),
          muted: !!t.muted,
          updatedAt: asDate(t.updatedAt) ?? now,
        },
      });
      gen?.thread.add(t.id);
      return true;
    }
    case "message": {
      const m = ch.entity as MessageDTO | undefined;
      if (!m) return false;
      // A thread STUB before the message, so the FK holds even when the thread's own change has
      // not arrived. A later `thread` change overwrites the stub with the real row.
      if (m.threadId) {
        await tx.insert(threads)
          .values({ id: m.threadId, accountId: world.accountId, updatedAt: now })
          .onConflictDoNothing({ target: threads.id });
      }
      const display = {
        messageIdHeader: m.messageIdHeader ?? null,
        subject: m.subject ?? "",
        fromAddress: m.from?.address ?? "",
        date: asDate(m.date),
        nativeLocator: { folder: m.folder },
        noAi: !!m.sensitivity?.no_ai,
        noForward: !!m.sensitivity?.no_forward,
        noKb: !!m.sensitivity?.no_kb,
        priority: !!m.sensitivity?.priority,
        sensitivityCategory: m.sensitivity?.category ?? null,
        threadId: m.threadId ?? null,
        unread: !!m.unread,
        snippet: m.snippet ?? "",
        toAddresses: m.to ?? [],
        ccAddresses: m.cc ?? [],
        hasAttachments: !!m.hasAttachments,
        attachmentCount: m.attachmentCount ?? 0,
        updatedAt: asDate(m.updatedAt) ?? now,
      };
      await tx.insert(messages).values({
        id: m.id,
        accountId: world.accountId,
        mailboxId: world.mailboxId,
        // A mirror carries no raw body, so it derives no dedup/body hash. `dedup_key` is unique per
        // mailbox; keying it to the message id keeps the constraint honest without a body to hash.
        bodyHash: "",
        dedupKey: `cloud:${m.id}`,
        ...display,
      }).onConflictDoUpdate({ target: messages.id, set: display });
      // `folder_state.desired_folder` is what `message-service.ts` projects as the message's folder.
      await tx.insert(folderState).values({
        messageId: m.id,
        desiredFolder: m.folder,
        observedFolder: m.folder,
        lastSetBy: "external",
        reconcileStatus: "reconciled",
        updatedAt: now,
      }).onConflictDoUpdate({
        target: folderState.messageId,
        set: { desiredFolder: m.folder, observedFolder: m.folder, updatedAt: now },
      });
      // The tag assignments this message carries. Written from the message change because that is
      // how the wire delivers them — see {@link applyLabels}.
      await applyLabels(tx, world, m.id, m.labels);
      gen?.message.add(m.id);
      // Mark the thread STUB too: a surviving message pins its thread via the FK, so the sweep must
      // not treat that thread as a phantom even when the thread's own change never arrives.
      if (m.threadId) gen?.thread.add(m.threadId);
      return true;
    }
    case "tag": {
      const t = ch.entity as TagDTO | undefined;
      if (!t) return false;
      const body = {
        accountId: world.accountId,
        name: t.name,
        hue: t.hue ?? "moss",
        updatedAt: asDate(t.updatedAt) ?? now,
      };
      /* ON CONFLICT on the ID, not on the account/name unique index. Two tags cannot share a name
         on the hosted account either, so the index is satisfied by the source; targeting the id is
         what makes a RENAME land as a rename instead of colliding with the row it is renaming. */
      await tx.insert(tags).values({ id: t.id, createdAt: asDate(t.createdAt) ?? now, ...body })
        .onConflictDoUpdate({ target: tags.id, set: body });
      gen?.tag.add(t.id);
      return true;
    }
    case "message_state": {
      const s = ch.entity as MessageStateDTO | undefined;
      if (!s) return false;
      if (!(await messagePresent(tx, s.messageId))) return false;
      await tx.insert(messageStates).values({
        accountId: world.accountId,
        messageId: s.messageId,
        state: s.state,
        bubbleUpAt: asDate(s.bubbleUpAt),
        setAt: asDate(s.setAt) ?? now,
        updatedAt: asDate(s.updatedAt) ?? now,
      }).onConflictDoUpdate({
        target: messageStates.messageId,
        set: {
          state: s.state,
          bubbleUpAt: asDate(s.bubbleUpAt),
          setAt: asDate(s.setAt) ?? now,
          updatedAt: asDate(s.updatedAt) ?? now,
        },
      });
      gen?.message_state.add(s.messageId);
      return true;
    }
    case "rule": {
      const r = ch.entity as RuleDTO | undefined;
      if (!r) return false;
      const stats = r.stats ?? { hits: 0, lastHitAt: null, demotions: 0 };
      const body = {
        accountId: world.accountId,
        kind: r.kind,
        match: r.match,
        destination: r.destination,
        priority: r.priority ?? 0,
        provenance: r.provenance ?? "manual",
        enabled: r.enabled ?? true,
        hits: stats.hits ?? 0,
        lastHitAt: asDate(stats.lastHitAt),
        demotions: stats.demotions ?? 0,
        updatedAt: asDate(r.updatedAt) ?? now,
      };
      await tx.insert(rules).values({ id: r.id, ...body })
        .onConflictDoUpdate({ target: rules.id, set: body });
      gen?.rule.add(r.id);
      return true;
    }
    case "draft": {
      const d = ch.entity as DraftDTO | undefined;
      if (!d) return false;
      if (d.threadId) {
        await tx.insert(threads)
          .values({ id: d.threadId, accountId: world.accountId, updatedAt: now })
          .onConflictDoNothing({ target: threads.id });
      }
      // `in_reply_to_message_id` has an FK; keep it only when the parent is mirrored.
      const inReplyTo = d.inReplyToMessageId && (await messagePresent(tx, d.inReplyToMessageId))
        ? d.inReplyToMessageId
        : null;
      const body = {
        accountId: world.accountId,
        mailboxId: world.mailboxId,
        threadId: d.threadId ?? null,
        inReplyToMessageId: inReplyTo,
        subject: d.subject ?? "",
        body: d.body ?? "",
        html: d.html ?? null,
        to: d.to ?? [],
        cc: d.cc ?? [],
        rationale: d.rationale ?? null,
        status: d.status,
        updatedAt: asDate(d.updatedAt) ?? now,
      };
      await tx.insert(drafts).values({ id: d.id, ...body })
        .onConflictDoUpdate({ target: drafts.id, set: body });
      gen?.draft.add(d.id);
      if (d.threadId) gen?.thread.add(d.threadId);   // the thread stub this draft pinned
      return true;
    }
    case "approval": {
      const a = ch.entity as ApprovalDTO | undefined;
      if (!a) return false;
      const body = {
        accountId: world.accountId,
        kind: a.kind,
        messageId: a.messageId ?? null,
        routingDecisionId: a.routingDecisionId ?? null,
        action: a.proposed?.action ?? "",
        summary: a.proposed?.summary ?? "",
        payload: (a.proposed?.payload ?? null) as unknown,
        confidence: a.confidence ?? null,
        status: a.status,
        expiresAt: asDate(a.expiresAt),
        updatedAt: asDate(a.updatedAt) ?? now,
      };
      await tx.insert(approvals).values({ id: a.id, ...body })
        .onConflictDoUpdate({ target: approvals.id, set: body });
      gen?.approval.add(a.id);
      return true;
    }
    case "routing_decision": {
      const rd = ch.entity as RoutingDecisionDTO | undefined;
      if (!rd) return false;
      if (!(await messagePresent(tx, rd.messageId))) return false;
      const body = {
        accountId: world.accountId,
        messageId: rd.messageId,
        inputProvenance: rd.inputProvenance,
        matchedRuleId: rd.matchedRuleId ?? null,
        destination: rd.destination,
        confidence: rd.confidence ?? null,
        rationale: rd.rationale ?? null,
        spam: !!rd.spam,
        status: rd.status,
        updatedAt: asDate(rd.updatedAt) ?? now,
      };
      await tx.insert(routingDecisions).values({ id: rd.id, ...body })
        .onConflictDoUpdate({ target: routingDecisions.id, set: body });
      gen?.routing_decision.add(rd.id);
      return true;
    }
    default:
      // Forward-compatible: an unknown type (e.g. "folder", which has no local table) is skipped
      // exactly as `apply.ts` tolerates an unknown entity rather than wedging the feed.
      return false;
  }
}

/** Apply one delete. Children of a message go first, so the message's own FKs are clear. */
async function applyDelete(tx: Tx, ch: SyncChange): Promise<boolean> {
  switch (ch.type) {
    case "message": {
      if (!(await messagePresent(tx, ch.id))) return false;
      await tx.delete(folderState).where(eq(folderState.messageId, ch.id));
      await tx.delete(messageStates).where(eq(messageStates.messageId, ch.id));
      await tx.delete(messageBodies).where(eq(messageBodies.messageId, ch.id));
      await tx.delete(routingDecisions).where(eq(routingDecisions.messageId, ch.id));
      // The assignments hang off the message by FK, so they go before it.
      await tx.delete(messageTags).where(eq(messageTags.messageId, ch.id));
      await tx.delete(messages).where(eq(messages.id, ch.id));
      return true;
    }
    case "tag":
      // Assignments first, for the same FK reason, and this is also what a deleted tag MEANS: the
      // messages stay, they simply stop carrying it.
      await tx.delete(messageTags).where(eq(messageTags.tagId, ch.id));
      await tx.delete(tags).where(eq(tags.id, ch.id));
      return true;
    case "thread": {
      if (!(await threadPresent(tx, ch.id))) return false;
      await tx.delete(drafts).where(eq(drafts.threadId, ch.id));
      await tx.delete(threads).where(eq(threads.id, ch.id));
      return true;
    }
    case "message_state":
      await tx.delete(messageStates).where(eq(messageStates.messageId, ch.id));
      return true;
    case "rule":
      await tx.delete(rules).where(eq(rules.id, ch.id));
      return true;
    case "draft":
      await tx.delete(drafts).where(eq(drafts.id, ch.id));
      return true;
    case "approval":
      await tx.delete(approvals).where(eq(approvals.id, ch.id));
      return true;
    case "routing_decision":
      await tx.delete(routingDecisions).where(eq(routingDecisions.id, ch.id));
      return true;
    default:
      return false;
  }
}

/**
 * Apply one `/sync` page in ONE transaction, emitting a local change-log row per applied entity.
 * `gen`, when present, is the bootstrap generation this page belongs to: every upsert marks the row
 * it touched so the trailing sweep can tell survivors from phantoms.
 */
async function applyPage(db: LocalDb, world: LocalWorld, resp: SyncResponse, now: Date, gen: BootstrapGen | null): Promise<number> {
  const changes: SyncChange[] = [
    ...resp.changes.creates, ...resp.changes.updates, ...resp.changes.moves, ...resp.changes.deletes,
  ];
  if (changes.length === 0) return 0;
  changes.sort((a, b) => a.seq - b.seq);   // rule 1: ascending seq
  const nonDeletes = changes.filter((c) => c.op !== "delete");
  const deletes = changes.filter((c) => c.op === "delete");

  return db.transaction(async (tx) => {
    let applied = 0;
    const record = async (type: EntityType, id: string, op: ChangeOp, move?: SyncChange["move"]): Promise<void> => {
      await recordChange(tx, {
        accountId: world.accountId,
        entityType: type,
        entityId: id,
        op,
        meta: op === "move" && move ? { from: move.from ?? null, to: move.to } : null,
      });
    };

    for (const type of APPLY_ORDER) {
      for (const ch of nonDeletes) {
        if (ch.type !== type) continue;
        if (await applyUpsert(tx, world, ch, now, gen)) {
          await record(type, ch.id, ch.op, ch.move);
          applied++;
        }
      }
    }
    for (const type of [...APPLY_ORDER].reverse()) {
      for (const ch of deletes) {
        if (ch.type !== type) continue;
        if (await applyDelete(tx, ch)) {
          await record(type, ch.id, "delete");
          applied++;
        }
      }
    }
    return applied;
  });
}

/**
 * THE MARK-AND-SWEEP. After a `since=0` bootstrap drain, delete every managed mail row the
 * generation never touched — the phantoms.
 *
 * FK-safe, children before parents: routing decisions, approvals, drafts, message states and rules
 * first (each can be an independent phantom hanging off a SURVIVING message when only that child was
 * removed on Cloud), then messages — whose delete cascades folder_state, bodies, states and routing
 * decisions exactly as a tombstone would — and threads last, whose delete cascades their drafts.
 *
 * Each swept entity appends a local DELETE change-log row, so the Swift projection's own `/sync`
 * drops it too; a sweep the reader never hears about would leave the phantom on screen. `applyDelete`
 * is reused verbatim so the cascade matches the incremental delete path byte for byte.
 */
async function sweepPhantoms(db: LocalDb, world: LocalWorld, gen: BootstrapGen, now: Date): Promise<number> {
  return db.transaction(async (tx) => {
    let swept = 0;
    const sweepOne = async (type: EntityType, id: string): Promise<void> => {
      const ch: SyncChange = { type, op: "delete", id, seq: 0, updatedAt: now.toISOString() };
      if (await applyDelete(tx, ch)) {
        await recordChange(tx, { accountId: world.accountId, entityType: type, entityId: id, op: "delete", meta: null });
        swept++;
      }
    };

    for (const r of await tx.select({ id: routingDecisions.id }).from(routingDecisions).where(eq(routingDecisions.accountId, world.accountId)))
      if (!gen.routing_decision.has(r.id)) await sweepOne("routing_decision", r.id);
    for (const r of await tx.select({ id: approvals.id }).from(approvals).where(eq(approvals.accountId, world.accountId)))
      if (!gen.approval.has(r.id)) await sweepOne("approval", r.id);
    for (const r of await tx.select({ id: drafts.id }).from(drafts).where(eq(drafts.accountId, world.accountId)))
      if (!gen.draft.has(r.id)) await sweepOne("draft", r.id);
    // `message_state`'s /sync id is its messageId (see applyPage's record call).
    for (const r of await tx.select({ messageId: messageStates.messageId }).from(messageStates).where(eq(messageStates.accountId, world.accountId)))
      if (!gen.message_state.has(r.messageId)) await sweepOne("message_state", r.messageId);
    for (const r of await tx.select({ id: rules.id }).from(rules).where(eq(rules.accountId, world.accountId)))
      if (!gen.rule.has(r.id)) await sweepOne("rule", r.id);
    for (const r of await tx.select({ id: messages.id }).from(messages).where(eq(messages.accountId, world.accountId)))
      if (!gen.message.has(r.id)) await sweepOne("message", r.id);
    for (const r of await tx.select({ id: threads.id }).from(threads).where(eq(threads.accountId, world.accountId)))
      if (!gen.thread.has(r.id)) await sweepOne("thread", r.id);
    /* Tags LAST. A tag deleted on Cloud is a tag whose messages survive and stop carrying it, so
       sweeping one has to happen after the messages it might still be attached to have settled —
       `applyDelete` clears the assignments with it. */
    for (const r of await tx.select({ id: tags.id }).from(tags).where(eq(tags.accountId, world.accountId)))
      if (!gen.tag.has(r.id)) await sweepOne("tag", r.id);

    return swept;
  });
}

export function createCloudMirror(cfg: CloudMirrorConfig): CloudMirror {
  const now = cfg.now ?? ((): Date => new Date());
  const pageLimit = cfg.pageLimit ?? DEFAULT_PAGE_LIMIT;
  const cursor = readCursor(cfg.cursorPath);
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** Optimistic: a mirror is assumed reachable until a pull proves otherwise. */
  let reachable = true;
  /** The single-flight pull: the poll timer and an echo-await share ONE drain. */
  let inflight: Promise<number> | null = null;
  /** Current reconnect delay; grows on failure, resets on success. See {@link scheduleAfter}. */
  let backoffMs = RECONNECT_BASE_MS;

  /** The cloud seq the cursor encodes — the inverse of `SyncService.encodeCursor`. */
  const cloudSeq = (): bigint => {
    const s = cursor.sync;
    if (!s || s === "0") return 0n;
    try {
      const dec = Buffer.from(s, "base64url").toString("utf8");
      return /^\d+$/.test(dec) ? BigInt(dec) : 0n;
    } catch {
      return 0n;
    }
  };

  /**
   * Drain `GET /sync` to the horizon. Returns what it applied and, when the drain was a `since=0`
   * bootstrap, the generation it marked so the caller can sweep phantoms afterwards.
   *
   * A drain that STARTS at `since=0` is a bootstrap — a first launch, a healed/absent cursor, or the
   * relaunch after a 410 deleted the cursor mid-drain. A 410 mid-drain resets to zero and restarts
   * the generation. An incremental drain (a real cursor) marks nothing and sweeps nothing.
   */
  const drainSync = async (): Promise<{ applied: number; sweep: BootstrapGen | null }> => {
    let applied = 0;
    // A drain that begins at since=0 — a first launch, or a healed/absent cursor — OR that finds a
    // bootstrap left unfinished by a crash is a BOOTSTRAP. Force since=0 so the generation is rebuilt
    // in FULL (a partial resume would sweep real rows), and tag what it touches.
    let sweep: BootstrapGen | null = null;
    if (isBootstrapCursor(cursor.sync) || cursor.bootstrapping) {
      cursor.sync = "0";
      cursor.bootstrapping = true;
      sweep = newBootstrapGen();
    }
    for (;;) {
      const q = new URLSearchParams({
        since: cursor.sync || "0",
        limit: String(pageLimit),
        types: CLOUD_SYNC_TYPES.join(","),
      });
      const res = await cfg.auth.authedFetch(`/sync?${q.toString()}`);
      if (res.status === 410) {
        // The cursor fell behind the retention horizon (`sync-service.ts` — a malformed or
        // sub-horizon cursor). DELETE the cursor file and re-bootstrap from zero. A since=0 replay
        // carries only CURRENT entities, so anything deleted on Cloud while we were away is absent
        // from it and would linger locally as a phantom — the fresh generation below tags what the
        // bootstrap touches so the trailing sweep removes exactly the rest. `bootstrapping` is
        // persisted by the first page commit below, so a crash mid-bootstrap still resumes as one.
        deleteCursor(cfg.cursorPath);
        cursor.sync = "0";
        cursor.bodies = null;
        cursor.bootstrapping = true;
        sweep = newBootstrapGen();
        applied = 0;
        cfg.log?.("cloud_cursor_expired", { reason: "410 from /sync; re-bootstrapping from since=0 with mark-and-sweep" });
        continue;
      }
      if (!res.ok) throw new Error(`the hosted /sync answered HTTP ${res.status}`);
      const body = (await res.json()) as SyncResponse;
      applied += await applyPage(cfg.db, cfg.world, body, now(), sweep);
      // AFTER the commit: a crash before this line re-applies the page next launch, which converges.
      cursor.sync = body.cursor;
      writeCursor(cfg.cursorPath, cursor);
      if (!body.hasMore) break;
    }
    return { applied, sweep };
  };

  /** Backfill message bodies via the batch text-pull endpoint's `GET /messages/bodies`. Not a `/sync` entity, so no change-log row. */
  const backfillBodies = async (): Promise<number> => {
    let written = 0;
    for (;;) {
      const q = new URLSearchParams({ limit: String(DEFAULT_BODIES_LIMIT) });
      if (cursor.bodies) q.set("after", cursor.bodies);
      const res = await cfg.auth.authedFetch(`/messages/bodies?${q.toString()}`);
      if (!res.ok) throw new Error(`the hosted /messages/bodies answered HTTP ${res.status}`);
      const page = (await res.json()) as Page<MessageBodyBatchItem>;
      await cfg.db.transaction(async (tx) => {
        for (const item of page.items) {
          // The FK requires the message; a body whose message is not yet mirrored is skipped and
          // re-offered on a later pass (the bodies cursor only advances past what this page held).
          if (!(await messagePresent(tx, item.messageId))) continue;
          const row = {
            text: item.text ?? "",
            html: item.html ?? null,
            loadedRemoteContent: !!item.loadedRemoteContent,
          };
          await tx.insert(messageBodies).values({ messageId: item.messageId, ...row })
            .onConflictDoUpdate({ target: messageBodies.messageId, set: row });
          written++;
        }
      });
      cursor.bodies = page.nextCursor;
      writeCursor(cfg.cursorPath, cursor);
      if (!page.nextCursor) break;
    }
    return written;
  };

  const runPull = async (): Promise<number> => {
    try {
      const { applied, sweep } = await drainSync();
      // Sweep BEFORE bodies: a phantom message is gone, so `backfillBodies` never fetches its body.
      if (sweep) {
        const swept = await sweepPhantoms(cfg.db, cfg.world, sweep, now());
        if (swept > 0) {
          cfg.log?.("cloud_mirror_swept", { count: swept, reason: "bootstrap phantoms removed after a since=0 re-pull" });
        }
        // The bootstrap AND its sweep have completed: clear the flag so the next drain resumes
        // incrementally instead of re-bootstrapping.
        cursor.bootstrapping = false;
        writeCursor(cfg.cursorPath, cursor);
      }
      await backfillBodies();
      /* THE TWO STAMPS THE PROGRESS SURFACE READS. See {@link stampSynced} — on a mirrored
         install this process is the only thing that could write them, and without them the
         window's sync line has no way to tell a first import from a settled mailbox. `bodies`
         being exhausted is part of "drained": the mail list is complete before its bodies are,
         and a first import that claims to be finished while messages still open blank has
         claimed too early. */
      await stampSynced(cfg.db, cfg.world.mailboxId, now(), cursor.bodies === null);
      // A completed pull is the definition of reachable: the local database keeps serving what it
      // holds either way, but the proxy needs to know it can forward a write again.
      reachable = true;
      cfg.log?.("cloud_pull_applied", { count: applied });
      return applied;
    } catch (err) {
      // A failed pull is a bad network or a spent token — offline, not stopped. The proxy answers
      // `503 offline_read_only` off this flag; the poll keeps retrying and flips it back on success.
      reachable = false;
      throw err;
    }
  };

  /**
   * Single-flight `pullOnce`: the poll timer and an echo-await can ask concurrently, and sharing
   * one drain keeps the cursor writes serialized. Two concurrent drains would still CONVERGE (every
   * apply is an upsert), but one is cheaper and avoids two writers racing the cursor file.
   */
  const pullOnce = (): Promise<number> => {
    inflight ??= runPull().finally(() => {
      inflight = null;
    });
    return inflight;
  };

  const awaitCloudSeq = async (target: bigint, deadlineMs: number): Promise<boolean> => {
    const end = Date.now() + Math.max(0, deadlineMs);
    for (;;) {
      if (cloudSeq() >= target) return true;
      try {
        await pullOnce();
      } catch {
        // Offline mid-echo — `runPull` already flipped the flag. Keep trying to the deadline in
        // case it was a blip, then let the caller answer anyway (the write landed on Cloud).
      }
      if (cloudSeq() >= target) return true;
      const remaining = end - Date.now();
      if (remaining <= 0) return false;
      await new Promise((r) => setTimeout(r, Math.min(50, remaining)));
    }
  };

  /**
   * Schedule the next pull. A SUCCESS resets the backoff and polls at the steady cadence; a FAILURE
   * retries on an exponential backoff bounded by {@link RECONNECT_MAX_MS}, so a dropped network or a
   * spent token reconnects promptly without hammering. Either way the next drain RESUMES FROM THE
   * CURSOR FILE — the last committed page already wrote it — so no progress is re-fetched.
   */
  const scheduleAfter = (failed: boolean): void => {
    if (stopped) return;
    let delay: number;
    if (failed) {
      delay = backoffMs;
      backoffMs = Math.min(backoffMs * 2, RECONNECT_MAX_MS);
    } else {
      backoffMs = RECONNECT_BASE_MS;
      delay = cfg.pollIntervalMs ?? DEFAULT_CLOUD_POLL_MS;
    }
    timer = setTimeout(() => {
      void pullOnce()
        .then(() => scheduleAfter(false))
        .catch((err: unknown) => {
          // A failed pull is a bad network or an expired token, not a reason to stop being a mirror.
          // The local database keeps serving what it holds; the next attempt resumes from the cursor.
          cfg.log?.("cloud_pull_failed", { err, reason: "the pull did not complete; the mirror keeps serving what it holds and retries with backoff" });
          scheduleAfter(true);
        });
    }, delay);
    timer.unref?.();
  };

  return {
    pullOnce,
    online: () => reachable,
    markConnectivity: (v: boolean) => {
      reachable = v;
    },
    cloudSeq,
    awaitCloudSeq,
    async start() {
      // A first pull that fails is a bad network or an expired token, not a launch failure: the
      // mirror serves what it holds and the poll retries (on backoff). Scheduling regardless is what
      // keeps a transient bootstrap failure from stopping the mirror forever.
      try {
        await pullOnce();
        scheduleAfter(false);
      } catch (err) {
        cfg.log?.("cloud_pull_failed", { err, reason: "the first pull did not complete; the mirror serves what it holds and the poll retries with backoff" });
        scheduleAfter(true);
      }
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
