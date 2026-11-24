/**
 * THE WRITES AN EVENT'S RECORD CARRIES: every `cal_writes` row of the event that is still owed to
 * the provider, or that it refused, oldest first. The record itself stays the provider's copy; what
 * a person wants and the provider has not taken rides beside it, and leaves it when it is taken.
 */
import { and, eq, inArray } from "drizzle-orm";
import { calWrites } from "@trafficflow/db/mail";
import { asCalendarWriteFault, parseWritePayload } from "@trafficflow/db/calendar";
import type { CalendarWriteMark } from "@ohmail/wire";
import type { Db } from "../context.js";

/** The marks of each of these events, oldest first; an event with none is not in the map. */
export async function writeMarksOf(db: Db, accountId: string, eventIds: readonly string[]): Promise<Map<string, CalendarWriteMark[]>> {
  const out = new Map<string, CalendarWriteMark[]>();
  if (eventIds.length === 0) return out;
  const rows = await db.select({
    id: calWrites.id, eventId: calWrites.eventId, key: calWrites.idempotencyKey, state: calWrites.state,
    refusal: calWrites.refusal, payload: calWrites.payload, createdAt: calWrites.createdAt,
  }).from(calWrites).where(and(
    eq(calWrites.accountId, accountId), inArray(calWrites.eventId, [...eventIds]), inArray(calWrites.state, ["pending", "refused"]),
  ));
  const ordered = rows.map((r) => ({ r, payload: parseWritePayload(r.payload) })).sort((a, b) =>
    a.r.createdAt.getTime() - b.r.createdAt.getTime()
    || (a.payload?.part?.n ?? 1) - (b.payload?.part?.n ?? 1)
    || (a.r.id < b.r.id ? -1 : a.r.id > b.r.id ? 1 : 0));
  for (const { r, payload } of ordered) {
    if (r.eventId === null) continue;
    const list = out.get(r.eventId) ?? [];
    list.push({
      id: r.id,
      key: r.key,
      state: r.state === "refused" ? "refused" : "pending",
      reason: r.refusal === null ? null : asCalendarWriteFault(r.refusal),
      act: payload?.transfer && payload.act.kind === "calendar_event_move" ? { ...payload.act, copyThenRemove: true } : payload?.act ?? null,
      part: payload?.part?.n ?? null,
      at: r.createdAt.toISOString(),
    });
    out.set(r.eventId, list);
  }
  return out;
}
