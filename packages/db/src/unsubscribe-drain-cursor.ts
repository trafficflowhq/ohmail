import { eq, sql } from "drizzle-orm";
import type { Tx } from "./change-log.js";
import { unsubscribeDrainState } from "./schema-mail.js";

/**
 * WHERE THE DRAIN'S WINDOW WALK STOPPED, read at the start of a run and written once at its end.
 *
 * The walk's order is `(updated_at, message_id)` and a cursor is that pair. `null` means "start at
 * the head of the window" — the state of a store that has never run the pass, and what a lap that
 * reached the end of the window leaves behind. The pair lives here rather than in the service
 * because the upsert is the load-bearing statement and the device runs this pass over SQLite:
 * one spelling, both stores.
 */
export interface DrainCursor {
  readonly at: Date;
  readonly messageId: string;
}

/** The scheduled pass over screened-out mail — the only named pass so far. */
export const UNSUB_DRAIN_PASS = "screened_out";

/** The stored position, or `null` where there is none — both are one answer to the caller. */
export async function readDrainCursor(tx: Tx, pass: string): Promise<DrainCursor | null> {
  const [row] = await tx.select({
    at: unsubscribeDrainState.cursorAt,
    messageId: unsubscribeDrainState.cursorMessageId,
  })
    .from(unsubscribeDrainState)
    .where(eq(unsubscribeDrainState.pass, pass))
    .limit(1);
  // The CHECK keeps the pair whole in the store; this keeps it whole in the program, so half a
  // cursor from anywhere reads as "start at the head" rather than as a position in nothing.
  if (row === undefined || row.at == null || row.messageId == null) return null;
  const at: Date | string = row.at;
  return { at: at instanceof Date ? at : new Date(at), messageId: row.messageId };
}

/** Record where the pass stopped. `null` clears it: the next run starts at the head. */
export async function writeDrainCursor(
  tx: Tx, pass: string, cursor: DrainCursor | null, now: Date,
): Promise<void> {
  await tx.insert(unsubscribeDrainState).values({
    pass,
    cursorAt: cursor?.at ?? null,
    cursorMessageId: cursor?.messageId ?? null,
    updatedAt: now,
  }).onConflictDoUpdate({
    target: unsubscribeDrainState.pass,
    set: {
      cursorAt: sql`excluded.cursor_at`,
      cursorMessageId: sql`excluded.cursor_message_id`,
      updatedAt: sql`excluded.updated_at`,
    },
  });
}
