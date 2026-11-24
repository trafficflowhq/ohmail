import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { mailboxes, messages } from "@trafficflow/db";
import { makeTestDb } from "@trafficflow/db/testing";
import { MessageService, type ServiceContext } from "@trafficflow/services";
import { zonedMonth } from "../src/reader-clock.js";

/**
 * HISTORY'S MONTHS ARE THE READER'S. The rail bucketed in UTC while
 * rows read in the reader's zone, so in Zurich a message at 00:30 on 1 September counted in August
 * and pressing August landed on it. Runs on both stores: the default project opens PGlite, the
 * `test/vitest.sqlite.config.ts` project the device's SQLite.
 *
 * Mutations watched red: `zonedMonths` skipped (the UTC buckets stand) → the Zurich cases; the
 * window's `[-1, 0, 1]` narrowed to `[0]` → the west-of-UTC case.
 */
const svc = new MessageService();

async function world(dates: Array<string | null>) {
  const db = await makeTestDb();
  const accountId = randomUUID();
  const [mb] = await db.insert(mailboxes)
    .values({ accountId, provider: "imap", address: `${accountId.slice(0, 8)}@example.test` }).returning();
  const ids: Record<string, string> = {};
  for (const [i, iso] of dates.entries()) {
    const [row] = await db.insert(messages).values({
      accountId, mailboxId: mb!.id, bodyHash: "h", dedupKey: `tz:${i}`, subject: `m${i}`,
      date: iso === null ? null : new Date(iso), nativeLocator: { folder: "INBOX", ref: `1:${i}` },
    }).returning();
    ids[iso ?? "undated"] = row!.id;
  }
  const ctx = { db, accountId, userId: null, now: () => new Date(), requestId: "tz" } as unknown as ServiceContext;
  return { ctx, ids };
}

const MIDNIGHT_30 = "2026-08-31T22:30:00.000Z"; // 00:30 on 1 Sep in Zurich (CEST, UTC+2)
const LATE_AUG = "2026-08-31T21:30:00.000Z"; // 23:30 on 31 Aug in Zurich
const MID_AUG = "2026-08-15T10:00:00.000Z";
const MID_SEP = "2026-09-10T10:00:00.000Z";
const WINTER = "2026-01-31T23:30:00.000Z"; // 00:30 on 1 Feb in Zurich (CET, UTC+1)
const DATES = [MIDNIGHT_30, LATE_AUG, MID_AUG, MID_SEP, WINTER, null];

describe("History's month rail, by the reader's zone", () => {
  it("00:30 on the 1st in Zurich counts in the new month, summer and winter", async () => {
    const { ctx, ids } = await world(DATES);
    const t = await svc.timeline(ctx, { zone: "Europe/Zurich" });
    expect(t.months.map((m) => [m.month, m.count])).toEqual([
      ["2026-09", 2], ["2026-08", 2], ["2026-02", 1],
    ]);
    expect(t.total).toBe(6);
    expect(t.undated).toBe(1);
    // The jump: August's newest is 23:30 on 31 Aug, never the September row at 00:30.
    const aug = t.months.find((m) => m.month === "2026-08")!;
    expect(aug.first.id).toBe(ids[LATE_AUG]);
    expect(t.months.find((m) => m.month === "2026-09")!.first.id).toBe(ids[MID_SEP]);
  });

  it("the same rows, unstated zone, keep the UTC months an older client was served", async () => {
    const { ctx, ids } = await world(DATES);
    const t = await svc.timeline(ctx);
    expect(t.months.map((m) => [m.month, m.count])).toEqual([
      ["2026-09", 1], ["2026-08", 3], ["2026-01", 1],
    ]);
    expect(t.months.find((m) => m.month === "2026-08")!.first.id).toBe(ids[MIDNIGHT_30]);
  });

  it("west of UTC a month's last evening stays in it", async () => {
    // 22:00 on 31 Aug in New York (EDT, UTC-4) is 02:00 on 1 Sep in UTC.
    const EVENING = "2026-09-01T02:00:00.000Z";
    const { ctx, ids } = await world([EVENING, MID_SEP]);
    const t = await svc.timeline(ctx, { zone: "America/New_York" });
    expect(t.months.map((m) => [m.month, m.count])).toEqual([["2026-09", 1], ["2026-08", 1]]);
    expect(t.months.find((m) => m.month === "2026-08")!.first.id).toBe(ids[EVENING]);
    expect(t.total).toBe(2);
  });
});

describe("a zoned month as a window of instants", () => {
  it("starts at local midnight on the 1st and ends at the next one", () => {
    const sep = zonedMonth(2026, 9, "Europe/Zurich");
    expect(sep.month).toBe("2026-09");
    expect(sep.start.toISOString()).toBe("2026-08-31T22:00:00.000Z");
    expect(sep.end.toISOString()).toBe("2026-09-30T22:00:00.000Z");
    const dec = zonedMonth(2026, 12, "America/New_York");
    expect(dec.start.toISOString()).toBe("2026-12-01T05:00:00.000Z");
    expect(dec.end.toISOString()).toBe("2027-01-01T05:00:00.000Z");
  });
});
