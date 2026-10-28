import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appointmentStamp, type EmailAddress, type EngineMessage } from "@ohmail/client-engine";
import { fullDateTime, recipientRows, rowStamp, waterlineStamp, writtenDateTime } from "../app/shell/format";
import { setActiveFormatZone } from "../app/shell/locale";

/**
 * THE PURE HALF OF THE MESSAGE HEADER.
 *
 * `recipientRows` and `fullDateTime` are the two functions the card composes its header from,
 * and both are pure over an `EngineMessage`, so they are pinned here rather than through the DOM.
 * The viewer redesign replaced the folded summary — the two-name cap, the "+N", the Cc
 * count — with the recipients WRITTEN OUT, so what is pinned now is the opposite claim: nothing
 * caps, nothing counts, and the two invariants that survive are the empty branch and the
 * me-fold on the STORED address.
 */

function msg(over: Partial<EngineMessage>): EngineMessage {
  return {
    id: "m",
    accountId: "a",
    mailboxId: "mb",
    threadId: null,
    messageIdHeader: null,
    subject: "s",
    from: { name: "Sender", address: "sender@example.invalid" },
    to: [],
    cc: [],
    date: "2026-08-05T14:32:00.000Z",
    folder: "INBOX",
    snippet: "snip",
    unread: false,
    labels: [],
    ...over,
  } as unknown as EngineMessage;
}

const addr = (address: string, name: string | null = null): EmailAddress => ({ name, address });

describe("recipientRows", () => {
  it("renders nothing when there is no To and no Cc", () => {
    expect(recipientRows(msg({ to: [], cc: [] }), []).empty).toBe(true);
  });

  it("marks the reader's own address `me`, case-insensitively, and keeps everyone in order", () => {
    const s = recipientRows(
      msg({ to: [addr("ME@Example.INVALID", "Me"), addr("anna@roth.invalid", "Anna Roth")] }),
      ["me@example.invalid"],
    );
    expect(s.empty).toBe(false);
    expect(s.to).toEqual([
      { me: true, name: "Me", address: "ME@Example.INVALID" },
      { me: false, name: "Anna Roth", address: "anna@roth.invalid" },
    ]);
  });

  it("with NO known own addresses, the same recipient is nobody special — never `me`", () => {
    // The explicit degradation branch: an empty `ownAddresses` means the reader is recognised
    // nowhere, so their own address is just another address.
    const one = addr("me@example.invalid");
    expect(recipientRows(msg({ to: [one] }), []).to[0]!.me).toBe(false);
    expect(recipientRows(msg({ to: [one] }), ["me@example.invalid"]).to[0]!.me).toBe(true);
  });

  it("caps NOTHING: every To recipient is a chip — the '+N' fold is retired, not resized", () => {
    const s = recipientRows(
      msg({
        to: [addr("a@x.invalid", "A"), addr("b@x.invalid", "B"), addr("c@x.invalid", "C"), addr("d@x.invalid", "D")],
      }),
      [],
    );
    expect(s.to.map((r) => r.name)).toEqual(["A", "B", "C", "D"]);
  });

  it("a no-name recipient carries a null name — the card prints the address once, never twice", () => {
    expect(recipientRows(msg({ to: [addr("bare@x.invalid")] }), []).to).toEqual([
      { me: false, name: null, address: "bare@x.invalid" },
    ]);
  });

  it("a Cc'd reader folds the same way, and comes first in the field", () => {
    const s = recipientRows(
      msg({ to: [addr("a@x.invalid", "A")], cc: [addr("c@x.invalid"), addr("d@x.invalid"), addr("me@example.invalid")] }),
      ["me@example.invalid"],
    );
    expect(s.cc).toEqual([
      { me: true, name: null, address: "me@example.invalid" },
      { me: false, name: null, address: "c@x.invalid" },
      { me: false, name: null, address: "d@x.invalid" },
    ]);
  });

  it("a message with only Cc is not empty", () => {
    expect(recipientRows(msg({ to: [], cc: [addr("c@x.invalid", "Cara")] }), []).empty).toBe(false);
  });
});

/**
 * The SHAPE of the absolute stamp. Pinned to UTC so the shape is all these assertions are about —
 * `fullDateTime` reads the reader's zone, so without this they would be measuring the machine the
 * suite happens to run on. That the zone is the reader's, and that the DATE moves with it and not
 * only the hour, is `reader-zone.test.ts`.
 */
describe("fullDateTime", () => {
  beforeEach(() => setActiveFormatZone("UTC"));
  afterEach(() => setActiveFormatZone(null));

  it("names the exact instant with a weekday, day, short month, year and clock", () => {
    expect(fullDateTime(msg({ date: "2026-08-05T14:32:00.000Z" }))).toBe("Wed 5 Aug 2026, 14:32");
  });

  it("pads the clock and keeps two digits", () => {
    expect(fullDateTime(msg({ date: "2026-01-09T04:05:00.000Z" }))).toBe("Fri 9 Jan 2026, 04:05");
  });

  it("says nothing for a message with no Date header, rather than `Invalid Date`", () => {
    expect(fullDateTime(msg({ date: null }))).toBe("");
    expect(fullDateTime(msg({ date: "not-a-date" }))).toBe("");
  });

  it("names the arrival for a letter dated after it, or undated; the details keep the header", () => {
    const arrived = "2026-10-28T10:00:05.000Z";
    const ahead = msg({ date: "2026-10-30T10:00:00.000Z", sortAt: arrived });
    const now = new Date("2026-10-28T10:05:00.000Z");
    expect(fullDateTime(ahead)).toBe("Wed 28 Oct 2026, 10:00");
    expect(rowStamp(ahead, now, true)).toMatchObject({ time: "Wed 28 Oct 2026, 10:00", timeSpoken: "Wed 28 Oct 2026, 10:00" });
    expect(rowStamp(ahead, now, false)).toMatchObject({ time: "10:00", timeTitle: "Wed 28 Oct 2026, 10:00" });
    const undated = msg({ date: null, sortAt: arrived });
    expect(rowStamp(undated, now, true).time).toBe("Wed 28 Oct 2026, 10:00");
    expect(writtenDateTime(ahead)).toBe("Fri 30 Oct 2026, 10:00");
    expect(writtenDateTime(undated)).toBe("Wed 28 Oct 2026, 10:00");
  });
});

/**
 * ═══ THE WATERLINE READS THE READER'S ZONE — the stamp that used to read the browser's ═══════
 *
 * Alone among the product's stamps this one asked `Intl` for a combined weekday-and-time pattern
 * with NO `timeZone` at all, so it rendered in whatever zone the browser happened to be in. On a
 * machine whose zone matches the reader's that is invisible; on any other it put a different hour
 * on the waterline from the rows directly beneath it, and nothing on screen said which was which.
 *
 * The zone is injected here for exactly that reason: without it these assertions would measure the
 * machine the suite runs on and would have passed just as happily before the fix, which is the
 * definition of a guard that is not evidence.
 *
 * The second half is the combined pattern. German renders `weekday + hour` as "Mi., 18:40" — a
 * comma no caller chose — while every other "a day this week at a time" in the product reads
 * "Mi 18:40". One grammar, composed from two parts.
 */
describe("waterlineStamp", () => {
  afterEach(() => setActiveFormatZone(null));
  // A Friday: the fixed instants below are one to two days before it, inside the week.
  const NOW = new Date("2026-08-14T12:00:00.000Z");

  it("renders the instant in the READER'S zone, not the host's", () => {
    const at = "2026-08-12T23:30:00.000Z";
    setActiveFormatZone("UTC");
    expect(waterlineStamp(at, NOW, "en")).toBe("Wed 23:30");
    /* The same instant is already the NEXT day in Zurich, so both halves move — the weekday and
       the clock. A fix that had moved only the hour would say "Wed 01:30". */
    setActiveFormatZone("Europe/Zurich");
    expect(waterlineStamp(at, NOW, "en")).toBe("Thu 01:30");
    setActiveFormatZone("Pacific/Auckland");
    expect(waterlineStamp(at, NOW, "en")).toBe("Thu 11:30");
  });

  it("speaks the one grammar, with no locale comma in it", () => {
    setActiveFormatZone("UTC");
    expect(waterlineStamp("2026-08-12T18:40:00.000Z", NOW, "de")).toBe("Mi 18:40");
    expect(waterlineStamp("2026-08-12T18:40:00.000Z", NOW, "de")).not.toContain(",");
  });

  it("midnight is 00, never 24", () => {
    setActiveFormatZone("UTC");
    expect(waterlineStamp("2026-08-12T00:07:00.000Z", NOW, "en")).toBe("Wed 00:07");
  });

  it("says nothing for an unparseable instant", () => {
    setActiveFormatZone("UTC");
    expect(waterlineStamp("not-a-date", NOW, "en")).toBe("");
  });

  /* PAST A WEEK THE DATE. A last visit eleven days ago read "Mon 18:40", which every other stamp
     in the product would read as this week's Monday. */
  it("names the date past the week, and the clock alone today", () => {
    setActiveFormatZone("UTC");
    expect(waterlineStamp("2026-08-03T18:40:00.000Z", NOW, "en")).toBe("3 Aug, 18:40");
    expect(waterlineStamp("2026-08-07T18:40:00.000Z", NOW, "en")).toBe("7 Aug, 18:40");
    expect(waterlineStamp("2026-08-08T18:40:00.000Z", NOW, "en")).toBe("Sat 18:40");
    expect(waterlineStamp("2025-12-30T08:00:00.000Z", NOW, "en")).toBe("30 Dec 2025, 08:00");
    expect(waterlineStamp("2026-08-14T08:05:00.000Z", NOW, "en")).toBe("08:05");
  });

  it("is the engine's appointment stamp, band for band", () => {
    setActiveFormatZone("Europe/Zurich");
    for (const iso of [
      "2026-08-14T06:00:00.000Z", "2026-08-10T06:00:00.000Z", "2026-08-01T06:00:00.000Z",
      "2025-08-01T06:00:00.000Z",
    ]) {
      expect(waterlineStamp(iso, NOW, "de")).toBe(appointmentStamp(new Date(iso), NOW, "Europe/Zurich", "de"));
    }
  });
});

