import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { accounts } from "@trafficflow/db";
import { runMigrations } from "@trafficflow/db/admin";
import { closePooledDbs, makeOwnedDb, makePooledDb } from "@trafficflow/db/cloud";
import { calCalendars, calConnections, calEvents, calSettings } from "@trafficflow/db/mail";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { dbFor, SyncService, type ServiceContext } from "@trafficflow/services";
import { calendarFeed } from "@trafficflow/services/calendar";
import type { SnapshotResponse } from "@ohmail/wire";

const pgUp = await realPgAvailable();
const now = new Date("2026-07-27T12:00:00.123Z");
const day = (offset: number) => new Date(now.getTime() + offset * 86_400_000);
const eventIds = (page: SnapshotResponse) =>
  page.changes.filter((change) => change.type === "calendar_event").map((change) => change.id);

describe.skipIf(!pgUp)("a calendar's first sync on PostgreSQL", () => {
  beforeAll(async () => { await runMigrations(PG_TEST_URL); }, 120_000);

  it.each([
    { name: "direct", open: () => makeOwnedDb(PG_TEST_URL, { role: "api" }) },
    { name: "pooled", open: () => ({ db: makePooledDb(PG_TEST_URL), close: closePooledDbs }) },
  ])("resumes each page in order without dropping or repeating events via the $name handle", async ({ open }) => {
    const { db, close } = open();
    const accountId = randomUUID();
    try {
      const connectionId = randomUUID();
      const calendarId = randomUUID();
      await db.insert(accounts).values({ id: accountId, name: "Calendar snapshot" });
      await db.insert(calSettings).values({ accountId, enabledAt: now });
      await db.insert(calConnections).values({ id: connectionId, accountId, provider: "google", label: "Personal" });
      await db.insert(calCalendars).values({ id: calendarId, accountId, connectionId, providerId: "home", name: "Home", access: "owner" });

      const early = randomUUID();
      const [moved, tied] = [randomUUID(), randomUUID()].sort();
      const series = randomUUID();
      const held = randomUUID();
      const event = (id: string, start: number, end: number) => ({
        id, accountId, calendarId, providerId: id, uid: id, startKind: "instant",
        startLocal: day(start).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z"),
        startsAt: day(start), endsAt: day(end),
      });
      await db.insert(calEvents).values([
        { ...event(series, -800, -790), repeatRule: "FREQ=DAILY;COUNT=11" },
        { ...event(moved!, 1, 1.1), uid: series, recurrenceId: "20240526T120000Z", occurrenceAt: day(-792) },
        { ...event(tied!, 1, 1.1) },
        { ...event(early, 0, 0.1) },
        // This exception still belongs in the window because its original occurrence is inside.
        { ...event(held, 800, 800.1), recurrenceId: "20260730T120000Z", occurrenceAt: day(3) },
      ]);

      const ctx: ServiceContext = { db: dbFor(db, accountId), accountId, userId: null, now: () => now, requestId: "snapshot" };
      const sync = new SyncService();
      const types = ["message", "settings", "calendar_connection", "calendar", "calendar_event"] as const;
      const opts = { calendar: calendarFeed, types, limit: 2 };

      const mail = await sync.getSnapshot(ctx, opts);
      expect(eventIds(mail)).toEqual([]);
      expect(mail.nextCursor).toEqual(expect.any(String));

      const first = await sync.getSnapshot(ctx, { ...opts, cursor: mail.nextCursor! });
      expect(eventIds(first)).toEqual([early, moved]);
      expect(first.nextCursor).toEqual(expect.any(String));

      const second = await sync.getSnapshot(ctx, { ...opts, cursor: first.nextCursor! });
      expect(eventIds(second)).toEqual([tied, series]);
      expect(second.nextCursor).toEqual(expect.any(String));

      const last = await sync.getSnapshot(ctx, { ...opts, cursor: second.nextCursor! });
      expect(eventIds(last)).toEqual([held]);
      expect(last.nextCursor).toBeNull();
    } finally {
      await db.transaction(async (tx) => {
        await tx.delete(calEvents).where(eq(calEvents.accountId, accountId));
        await tx.delete(calCalendars).where(eq(calCalendars.accountId, accountId));
        await tx.delete(calConnections).where(eq(calConnections.accountId, accountId));
        await tx.delete(calSettings).where(eq(calSettings.accountId, accountId));
        await tx.delete(accounts).where(eq(accounts.id, accountId));
      }).finally(close);
    }
  }, 120_000);
});
