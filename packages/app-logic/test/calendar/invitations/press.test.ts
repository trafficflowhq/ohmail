/**
 * AN ANSWER, PRESSED over the real queue and a real mirror: its scope follows the record it is given on, nothing is
 * said while it is owed, a refusal is said by its word, and an invitation gone or cancelled since is not pressed.
 */
import { describe, expect, it } from "vitest";
import { MemoryMirrorStore, MutationRejectedError } from "@ohmail/client-engine";
import type { CalendarWriteTransport } from "@ohmail/client-engine/calendar-writes";
import type { CalendarAct, CalendarEventRecord, CalendarWriteAnswer } from "@ohmail/wire";
import { calendarPortOf } from "../../../src/calendar/index.js";
import { answerOf, pressAnswer, type InvitationRow } from "../../../src/calendar/invitations/index.js";
import { UPDATED, invitation } from "./fixtures.js";

type Answer = { answer: CalendarWriteAnswer; seq: number | null };

async function portOver(
  records: readonly CalendarEventRecord[],
  door: (act: CalendarAct, key: string) => Promise<Answer>,
) {
  let n = 0;
  const store = new MemoryMirrorStore();
  await store.applyChanges(
    records.map((r, i) => ({
      type: "calendar_event",
      op: "create" as const,
      id: r.id,
      entity: r,
      seq: i + 1,
      updatedAt: UPDATED,
    })),
  );
  const transport: CalendarWriteTransport = {
    writeCalendar: (act, key) => door(act, key),
    retryCalendarWrite: () => Promise.reject(new Error("not asked")),
    dismissCalendarWrite: () => Promise.reject(new Error("not asked")),
  };
  const port = calendarPortOf({
    engine: {
      store,
      subscribe: () => () => undefined,
      read: () => ({ version: () => store.version() }),
    } as never,
    transport,
    clock: { uuid: () => `key-${++n}`, now: () => Date.UTC(2026, 10, 16, 9) },
    settings: () => new Promise(() => undefined),
    held: () => ({ window: { daysBack: 30, daysAhead: 365, maxRows: 5000 }, loaded: [] }),
    load: "none",
  });
  return { port, store };
}

function rowOf(record: CalendarEventRecord): InvitationRow {
  return {
    ref: {
      event: record.id,
      occurrence: record.recurrenceId === "" ? null : record.recurrenceId,
      day: "2026-11-18",
    },
    recordId: record.id,
    title: record.title,
    day: "2026-11-18",
    organizer: "Marco",
    calendarId: record.calendarId,
    answer: "none",
    cancelled: false,
    waiting: null,
    refusal: null,
    refusedWriteId: null,
    viewOnly: false,
    connectionStopped: false,
    when: null,
    place: null,
  };
}

const taken = (key: string): Answer => ({
  answer: { write: { id: "w-1", key, state: "pending", reason: null }, events: [] },
  seq: null,
});

describe("an answer to an invitation", () => {
  it("answers the record whole for an event, and the one day for a changed day of a series", () => {
    const single = invitation("ev-1", "20261118");
    const day = invitation("ev-2", "20261118", { recurrenceId: "20261118T090000" });
    expect(answerOf(rowOf(single), "accepted", single)).toEqual({
      kind: "calendar_event_answer",
      eventId: "ev-1",
      base: UPDATED,
      scope: { kind: "record" },
      answer: "accepted",
    });
    expect(answerOf(rowOf(day), "declined", day)).toMatchObject({
      eventId: "ev-2",
      scope: { kind: "occurrence", at: "20261118T090000" },
      answer: "declined",
    });
  });

  it("sends one answer through the queue, with the record's base as the device holds it, and says it once taken", async () => {
    const sent: CalendarAct[] = [];
    const record = invitation("ev-1", "20261118", { updatedAt: "2026-11-10T07:00:00.000Z" });
    const { port } = await portOver([record], async (act, key) => {
      sent.push(act);
      return taken(key);
    });
    const outcome = await pressAnswer(port, rowOf(record), "tentative");
    expect(outcome).toMatchObject({ pressed: true, say: "taken.answer" });
    expect(sent).toEqual([
      {
        kind: "calendar_event_answer",
        eventId: "ev-1",
        base: "2026-11-10T07:00:00.000Z",
        scope: { kind: "record" },
        answer: "tentative",
      },
    ]);
  });

  it("says nothing while the answer is owed, and lays it over the invitation as waiting on this device", async () => {
    const record = invitation("ev-1", "20261118");
    const { port } = await portOver([record], async () => {
      throw new MutationRejectedError("offline", { status: null, code: null, retryable: true });
    });
    const outcome = await pressAnswer(port, rowOf(record), "accepted");
    expect(outcome).toMatchObject({ pressed: true, verdict: null, say: null });
    const held = port.events().find((e) => e.record.id === "ev-1");
    expect(held).toMatchObject({ waiting: "device", record: { myAnswer: "accepted" } });
  });

  it("says our server's refusal by its own word", async () => {
    const record = invitation("ev-1", "20261118");
    const { port } = await portOver([record], async () => {
      throw new MutationRejectedError("read only", {
        status: 409,
        code: "calendar_read_only",
        retryable: false,
      });
    });
    expect(await pressAnswer(port, rowOf(record), "declined")).toMatchObject({
      pressed: true,
      say: "refusal.readOnly",
    });
  });

  it("presses nothing for an invitation cancelled or gone since its row was drawn", async () => {
    const sent: CalendarAct[] = [];
    const shown = invitation("ev-1", "20261118");
    const { port, store } = await portOver([shown], async (act, key) => {
      sent.push(act);
      return taken(key);
    });
    await store.applyChanges([
      {
        type: "calendar_event",
        op: "update",
        id: "ev-1",
        entity: { ...shown, status: "cancelled" },
        seq: 9,
        updatedAt: UPDATED,
      },
    ]);
    expect(await pressAnswer(port, rowOf(shown), "accepted")).toEqual({ pressed: false });
    expect(await pressAnswer(port, rowOf(invitation("ev-gone", "20261118")), "accepted")).toEqual({
      pressed: false,
    });
    expect(sent).toEqual([]);
  });
});
