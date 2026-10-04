import { and, eq, gt, inArray } from "drizzle-orm";
import { changeLog } from "@trafficflow/db";
import { dialect } from "@trafficflow/db/dialect";
import type { ApiDeps } from "./deps.js";
import { errorResponse } from "./responses.js";

// A leaf-free check: the services barrel would carry its whole graph into the phone's engine.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The header a client sends on a state verb replayed past the server's 24 h idempotency record. */
export const DECIDED_AT_HEADER = "x-decided-at";

/**
 * A STATE VERB REPLAYED PAST ITS IDEMPOTENCY RECORD runs only where nothing changed the message
 * since the press: any change-log row for it after `decidedAt` (the press itself landing, or
 * another device) is a newer state, and the replay is refused `superseded` rather than re-run.
 * Absent or unreadable header: the route runs as it always did (older clients send none).
 */
export async function refuseSupersededReplay(
  req: Request, deps: ApiDeps, messageIds: readonly string[],
): Promise<Response | null> {
  const raw = req.headers.get(DECIDED_AT_HEADER);
  const accountId = deps.session?.accountId;
  const ids = messageIds.filter((id) => UUID.test(id));
  if (raw === null || !accountId || ids.length === 0) return null;
  const decidedAt = new Date(raw);
  if (Number.isNaN(decidedAt.getTime())) return null;
  const newer = await deps.db.select({ id: changeLog.entityId }).from(changeLog).where(and(
    eq(changeLog.accountId, accountId),
    eq(changeLog.entityType, "message"),
    inArray(changeLog.entityId, ids),
    gt(changeLog.createdAt, dialect(deps.db).ts(decidedAt) as unknown as Date),
  )).limit(1);
  if (newer.length === 0) return null;
  return errorResponse("superseded", 409, "A newer change to this message stands, so this older one was not applied.");
}
