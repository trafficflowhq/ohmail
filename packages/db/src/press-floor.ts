import { and, eq, gt, inArray, isNotNull } from "drizzle-orm";
import { flagState, folderState, messageStates, messageTags } from "./schema-mail.js";
import type { Tx } from "./change-log.js";
import { IDEMPOTENCY_TTL_MS } from "./idempotency.js";

/**
 * THE STALE-PRESS FLOOR — was the field a press sets decided AFTER the press was made? A state
 * verb replayed past its 24 h idempotency record carries its age; the API turns that into a floor
 * on the server's clock, and each verb asks here, inside its transaction and before any write, about
 * the one field it sets. `decided_at` is a DECISION stamp (mail 0145) — never `updated_at`, which
 * the worker's observations bump. NULL admits: a row decided before the column existed.
 * In `packages/db` because `applyMessageMove` asks the same question on the organizer's store.
 */

/**
 * A press this old is COMPARED; a younger one is a first arrival and lands in arrival order. One
 * hour under the idempotency TTL: a same-key retry inside the day is answered from its stored row,
 * and the margin covers a client clock that under-reads the age.
 */
export const PRESS_AGED_MS = IDEMPOTENCY_TTL_MS - 60 * 60 * 1000;

/** The oldest press age a request may state; beyond it the header is refused, never compared. */
export const PRESS_AGE_MAX_MS = 366 * 24 * 60 * 60 * 1000;

/** Is a press made at `pressedAt` old enough, by `now`, for its field to be compared? */
export function pressIsAged(pressedAt: Date, now: Date): boolean {
  return now.getTime() - pressedAt.getTime() >= PRESS_AGED_MS;
}

/** A press instant from another install's clock, bounded by this store's: never ahead of `now`. */
export function clampPressInstant(d: Date, now: Date): Date {
  return new Date(Math.min(Math.max(d.getTime(), now.getTime() - PRESS_AGE_MAX_MS), now.getTime()));
}

/** The instant a decision is stamped with: the press's floor when it carried one, else now. */
export function decisionInstant(floor: Date | null | undefined, now: Date): Date {
  return floor ?? now;
}

/** `folder_state.decided_at > floor` — a move, delete or restore placed after this press. */
export async function placementDecidedAfter(tx: Tx, messageId: string, floor: Date): Promise<boolean> {
  // scoped-by: every caller passes an id it loaded by (id, accountId) in this transaction
  const [row] = await tx.select({ id: folderState.messageId }).from(folderState).where(and(
    eq(folderState.messageId, messageId), isNotNull(folderState.decidedAt), gt(folderState.decidedAt, floor),
  )).limit(1);
  return row !== undefined;
}

/** The ids among `messageIds` whose read state (`flag_state.decided_at`) was decided after `floor`. */
export async function readDecidedAfter(tx: Tx, messageIds: readonly string[], floor: Date): Promise<Set<string>> {
  if (messageIds.length === 0) return new Set();
  // scoped-by: every caller passes ids it loaded by accountId in this transaction
  const rows = await tx.select({ id: flagState.messageId }).from(flagState).where(and(
    inArray(flagState.messageId, [...messageIds]), isNotNull(flagState.decidedAt), gt(flagState.decidedAt, floor),
  ));
  return new Set(rows.map((r) => r.id));
}

/** `message_states.decided_at > floor` — a triage placed after this press. */
export async function triageDecidedAfter(tx: Tx, messageId: string, floor: Date): Promise<boolean> {
  // scoped-by: every caller passes an id it loaded by (id, accountId) in this transaction
  const [row] = await tx.select({ id: messageStates.id }).from(messageStates).where(and(
    eq(messageStates.messageId, messageId), isNotNull(messageStates.decidedAt), gt(messageStates.decidedAt, floor),
  )).limit(1);
  return row !== undefined;
}

/**
 * The tag's row was assigned after `floor`, so a removal pressed before it is stale. Tags carry no
 * decision column: the row's `created_at` is the assignment, stamped with its own press's floor.
 * An assignment replayed over a LATER removal is not caught here (the row is gone, no tombstone).
 */
export async function tagAssignedAfter(
  tx: Tx, accountId: string, messageId: string, tagId: string, floor: Date,
): Promise<boolean> {
  const [row] = await tx.select({ id: messageTags.tagId }).from(messageTags).where(and(
    eq(messageTags.accountId, accountId), eq(messageTags.messageId, messageId),
    eq(messageTags.tagId, tagId), gt(messageTags.createdAt, floor),
  )).limit(1);
  return row !== undefined;
}
