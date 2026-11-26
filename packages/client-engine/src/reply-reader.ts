import type { EngineMessage } from "@ohmail/wire";
import { OPTIMISTIC_SENT_TTL_MS } from "./engine/ceilings.js";
import { isOwnSent, messageIdKey } from "./selectors.js";
import type { EntityReader, MirrorStore } from "./store.js";

const PREFIX = "open-sent-reply:";

interface SentReply {
  readonly sourceId: string;
  readonly preview: EngineMessage;
  readonly retryUntil?: number;
  readonly expiresAt?: number;
  readonly copyId?: string;
}

interface ReplyCopies {
  readonly messages: number;
  readonly meta: number;
  readonly pending: Set<string>;
  readonly arrived: Map<string, EngineMessage>;
}

const copyIndexes = new WeakMap<EntityReader, ReplyCopies>();

function replyRows(store: EntityReader) {
  return store.entries<SentReply>("view_meta").filter(({ id }) => id.startsWith(PREFIX));
}

function messageKey(message: EngineMessage): string | undefined {
  const header = message.messageIdHeader;
  return typeof header === "string"
    ? JSON.stringify([message.accountId, message.mailboxId, messageIdKey(header)])
    : undefined;
}

function replyCopies(store: EntityReader): ReplyCopies {
  const messages = store.stampOf("message");
  const meta = store.stampOf("view_meta");
  const cached = copyIndexes.get(store);
  if (cached?.messages === messages && cached.meta === meta) return cached;

  const waiting = replyRows(store).filter(({ entity }) => entity.copyId === undefined);
  const keys = new Set(waiting.map(({ entity }) => messageKey(entity.preview)));
  const matching = new Map<string, EngineMessage>();
  if (keys.size > 0) {
    for (const message of store.list<EngineMessage>("message")) {
      const key = messageKey(message);
      if (!key || !keys.has(key) || message.local === true) continue;
      const previous = matching.get(key);
      if (!previous || (!isOwnSent(previous) && isOwnSent(message))) matching.set(key, message);
    }
  }

  const pending = new Set<string>();
  const arrived = new Map<string, EngineMessage>();
  for (const { id, entity: { preview, sourceId } } of waiting) {
    const key = messageKey(preview);
    const copy = key === undefined ? undefined : matching.get(key);
    if (copy) arrived.set(id, copy);
    else {
      pending.add(preview.id);
      pending.add(sourceId);
    }
  }

  const result = { messages, meta, pending, arrived };
  copyIndexes.set(store, result);
  return result;
}

/** Whether this selected letter or a reply it directly received still awaits its mailbox copy. */
export function awaitsReplyCopy(store: EntityReader | undefined, id: string | null | undefined): boolean {
  return store !== undefined && id != null && replyCopies(store).pending.has(id);
}

/** Keep the confirmation before the draft and outbox can retire. No outgoing words or files are stored here. */
export async function rememberSentReply(
  store: MirrorStore, sourceId: string, message: EngineMessage, retryUntil: number,
): Promise<void> {
  const preview = {
    ...message,
    body: undefined,
    snippet: "",
    hasAttachments: false,
    attachmentCount: 0,
  };
  await store.putLocal("view_meta", PREFIX + message.id, { sourceId, preview, retryUntil } satisfies SentReply);
}

function retryDeadline(reply: SentReply): number {
  return reply.retryUntil ?? Date.parse(reply.preview.updatedAt) + OPTIMISTIC_SENT_TTL_MS;
}

/** The next outstanding deadline, from the same records the hold reads. */
export function nextSentReplyExpiry(store: MirrorStore): number {
  let next = Infinity;
  for (const { entity } of replyRows(store)) {
    if (entity.copyId === undefined) next = Math.min(next, retryDeadline(entity));
  }
  return next;
}

/** A settled reply stays settled if the mirror later evicts or deletes the copy. */
export async function reconcileSentReplies(store: MirrorStore, now: number): Promise<void> {
  const { arrived } = replyCopies(store);
  for (const { id, entity } of replyRows(store)) {
    const copy = arrived.get(id);
    if (copy) {
      await store.putLocal("view_meta", id, { ...entity, copyId: copy.id, expiresAt: now + OPTIMISTIC_SENT_TTL_MS });
    } else if ((entity.copyId === undefined ? retryDeadline(entity) : entity.expiresAt ?? Infinity) <= now) {
      await store.putLocal("view_meta", id, null);
    }
  }
}

/** Resolve the old selection on restart or when its mailbox copy arrives. */
export function continuedReply(store: EntityReader, id: string): EngineMessage | undefined {
  const key = PREFIX + id;
  const sent = store.get<SentReply>("view_meta", key);
  if (!sent) return undefined;
  if (sent.copyId) return store.get<EngineMessage>("message", sent.copyId);
  return replyCopies(store).arrived.get(key) ?? sent.preview;
}
