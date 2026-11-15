import { describe, expect, it } from "vitest";
import { readLetterInvitation } from "@trafficflow/core/mail";
import { readCalendar } from "../packages/cal-core/src/ical/calendar";
import { DEFAULT_LIMITS } from "../packages/cal-core/src/limits";
import { recurrenceKeyOf, recurrenceKeyString } from "../packages/cal-core/src/recur/key";
import { intlZones } from "../packages/cal-core/src/time/zones";
import { CORPUS } from "../packages/cal-core/test/corpus/index";
import { text } from "../packages/cal-core/test/support";

/**
 * TWO READERS OF ONE INVITATION. Mail keeps an invitation's identity at ingest (core's
 * `invitation-mail`, in the phone's engine); the calendar package reads whole calendars and is not.
 * They share no code, so this file is what notices if they drift: for every text of the calendar's
 * corpus, the same event, occurrence key, revision, method and organizer. A text whose method is
 * none of the four that keep a row keeps none. The core package may not import the calendar's, so
 * the comparison lives here, beside the other parity tests.
 */
const platform = intlZones();

describe("the invitation's identity, read by mail and by the calendar", () => {
  it.each(CORPUS.map((f) => [f.name, f] as const))("%s", (_name, fixture) => {
    const kept = readLetterInvitation([{ id: "1", contentType: "text/calendar", text: text(fixture) }]);
    const read = readCalendar(text(fixture), DEFAULT_LIMITS);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const first = read.calendar.events[0] ?? null;
    const method = read.calendar.method;
    if (first === null || first.uid === null || !["REQUEST", "REPLY", "CANCEL", "COUNTER"].includes(method ?? "")) {
      expect(kept).toBeUndefined();
      return;
    }
    expect(kept).toBeDefined();
    expect(kept!.uid).toBe(first.uid);
    expect(kept!.recurrenceId).toBe(first.recurrenceId === null ? "" : recurrenceKeyString(recurrenceKeyOf(first.recurrenceId, platform)));
    expect(kept!.sequence).toBe(first.sequence ?? 0);
    expect(kept!.method).toBe(method === "REQUEST" && first.status === "CANCELLED" ? "CANCEL" : method);
    expect(kept!.organizer?.toLowerCase() ?? null).toBe(first.organizer?.email ?? null);
  });

  it("the corpus holds invitations of every method that keeps a row", () => {
    const methods = new Set(CORPUS.map((f) => readLetterInvitation([{ id: "1", contentType: "text/calendar", text: text(f) }])?.method));
    for (const m of ["REQUEST", "REPLY", "CANCEL", "COUNTER"]) expect(methods.has(m as never), m).toBe(true);
  });
});
