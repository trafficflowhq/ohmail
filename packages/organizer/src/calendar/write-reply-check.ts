import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import {
  calCalendars,
  calEvents,
  calWrites,
  recordCalendarChanges,
  type CalendarChange,
  type LedgerTx,
} from "@trafficflow/db";
import { appliedPayloadOf, parseWritePayload } from "@trafficflow/db/calendar";
import { dialect } from "@trafficflow/db/dialect";
import { inConnection, readingBound } from "./connection.js";
import { timeOfKey } from "./map.js";
import { calendarEnabledAt } from "./state.js";
import type { CalendarWriteDrainInput } from "./types.js";
import { waitFor } from "./words.js";
import { REPLY } from "./write-request.js";
import { claimed, refuseInTx, settleApplied, type ClaimedWrite, type SettleContext } from "./write-settle.js";

const REPLIES_PER_SYNC = 8;

/** Read a saved Outlook reply after the sync cursor has settled. The receipt never authorizes a POST. */
export async function checkOutlookReplies(
  input: CalendarWriteDrainInput,
  map: SettleContext["map"],
  startedAt: string,
  completed: readonly string[],
) {
  const writer = input.provider.writer;
  if (writer === null || input.signal.aborted) return;
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(5_000)]);
  const { db, key } = input;
  const rows = await inConnection(db, key, async ({ tx }) => {
    if ((await calendarEnabledAt(tx, key.accountId)) === null) return [];
    return tx
      .select({
        id: calWrites.id,
        calendarId: calWrites.calendarId,
        calendarProviderId: calCalendars.providerId,
        calendarAccess: calCalendars.access,
        eventId: calWrites.eventId,
        baseVersionTag: calWrites.baseVersionTag,
        attempts: calWrites.attempts,
        state: calWrites.state,
        payload: calWrites.payload,
        eventProviderId: calEvents.providerId,
        calendarRevision: sql<string>`${calCalendars}.xmin::text`,
        receiptRevision: sql<string>`${calWrites}.xmin::text`,
      })
      .from(calWrites)
      .innerJoin(
        calCalendars,
        and(eq(calCalendars.id, calWrites.calendarId), eq(calCalendars.accountId, calWrites.accountId)),
      )
      .leftJoin(
        calEvents,
        and(
          eq(calEvents.id, calWrites.eventId),
          eq(calEvents.accountId, calWrites.accountId),
          eq(calEvents.calendarId, calWrites.calendarId),
        ),
      )
      .where(
        and(
          eq(calWrites.accountId, key.accountId),
          eq(calCalendars.connectionId, key.id),
          isNull(calCalendars.readOwner),
          sql`${calWrites.payload} ? 'act'`,
          eq(calWrites.op, "answer"),
          inArray(calWrites.calendarId, [...completed]),
          sql`${calWrites.updatedAt} < ${startedAt}::timestamptz`,
          or(
            and(
              eq(calWrites.state, "pending"),
              inArray(sql<string>`${calWrites.payload} #>> '{answerDispatch,phase}'`, [
                "sending",
                "accepted",
              ]),
            ),
            and(
              eq(calWrites.state, "refused"),
              or(
                eq(calWrites.refusal, "answer_unconfirmed"),
                sql`${calWrites.payload} ->> 'resendsReply' = 'true'`,
              ),
            ),
          ),
        ),
      )
      .orderBy(sql`${calWrites.state} <> 'pending'`, asc(calWrites.updatedAt), asc(calWrites.id))
      .limit(REPLIES_PER_SYNC);
  });
  if (rows === "gone") return;

  for (const row of rows) {
    if (signal.aborted) return;
    const payload = parseWritePayload(row.payload);
    if (payload === null) continue;
    const act = payload.act;
    const state = row.state;
    if (act.kind !== "calendar_event_answer" || (state !== "pending" && state !== "refused")) continue;
    const saved = payload.answerDispatch;
    // A definitively refused resend can still inherit the original unresolved choice.
    if (saved?.phase === "ready" && (state !== "refused" || !payload.resendsReply)) continue;
    const dispatch =
      (saved?.phase === "ready" ? undefined : saved) ??
      (row.eventProviderId && payload.acceptedAnswerId
        ? { phase: "accepted" as const, id: payload.acceptedAnswerId, source: row.eventProviderId }
        : undefined);
    const source = dispatch?.source ?? row.eventProviderId;
    if (source === null) continue;
    const occurrence = act.scope.kind === "occurrence" ? timeOfKey(act.scope.at) : null;
    if (act.scope.kind === "occurrence" && occurrence === null) continue;
    const result = await writer
      .answer(
        input.connection,
        { id: row.calendarProviderId },
        {
          id: source,
          version: row.baseVersionTag ?? "",
          text: null,
          occurrence,
          ...(occurrence && { recurringSeries: true }),
        },
        { as: "", reply: REPLY[act.answer], dispatch, observeReply: true },
        signal,
      )
      .catch(() => null);
    if (input.signal.aborted) return;

    const write: ClaimedWrite = {
      ...row,
      op: "answer",
      kept: appliedPayloadOf(act),
      toCalendarId: null,
      provisional: false,
      observedReply: { state, revision: row.receiptRevision },
    };
    // The exact GET answers the mirror from before it was made. A new reader must win.
    const current = readingBound(db, key, async (tx) => {
      const [held] = await dialect(tx).forUpdate(
        tx
          .select({ id: calCalendars.id })
          .from(calCalendars)
          .where(
            and(
              eq(calCalendars.id, row.calendarId),
              eq(calCalendars.accountId, key.accountId),
              eq(calCalendars.connectionId, key.id),
              isNull(calCalendars.readOwner),
              sql`${calCalendars}.xmin::text = ${row.calendarRevision}`,
            ),
          ),
        { mode: "share" },
      );
      return held !== undefined;
    });
    let staleReply = false;
    if (!signal.aborted && result?.ok && !result.answerPending) {
      const settled = await settleApplied(
        { db: current, key, word: "microsoft", map: { ...map, ownCalendar: row.calendarAccess === "owner" } },
        write,
        result.items,
        dispatch?.id ?? source,
        false,
      );
      if (typeof settled !== "string") continue;
      staleReply = settled === "stale_reply";
    }

    const unconfirmed = result?.ok
      ? result.answerPending || staleReply
      : !!dispatch && act.scope.kind === "occurrence" && result?.reason === "event_gone";
    await inConnection(current, key, async ({ tx }) => {
      const same = claimed(write, key.accountId);
      if (!signal.aborted && state === "pending" && payload.answerSyncChecks === 1 && unconfirmed) {
        const [held] = await dialect(tx).forUpdate(
          tx.select({ id: calWrites.id }).from(calWrites).where(same),
          { mode: "update" },
        );
        if (!held) return;
        const changes: CalendarChange[] = [];
        await refuseInTx(tx, key.accountId, write, "answer_unconfirmed", changes);
        await recordCalendarChanges(tx as unknown as LedgerTx, key.accountId, changes);
      } else {
        // Failed or obsolete reads rotate behind the other receipts without counting.
        await tx
          .update(calWrites)
          .set({
            updatedAt: sql`now()`,
            ...(!signal.aborted &&
              state === "pending" &&
              unconfirmed && { payload: { ...payload, answerSyncChecks: 1 } }),
          })
          .where(same);
      }
    });
    if (result?.ok === false && (result.reason === "throttled" || (result.retryAfterMs ?? 0) > 0)) {
      return waitFor("throttled", 1, result.retryAfterMs);
    }
  }
}
