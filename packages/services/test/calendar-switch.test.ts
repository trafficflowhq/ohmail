import type { SettingsDTO } from "@ohmail/wire";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { makeTestDb } from "@trafficflow/db/testing";
import { accountSettings, accounts, changeLog, recordChange } from "@trafficflow/db";
import { calCalendars, calConnections, calSettings } from "@trafficflow/db/mail";
import {
  calendarFeed, calendarSettings, requireCalendarOn, setCalendarSettings,
} from "@trafficflow/services/calendar";
import { SyncService, ServiceError, dbFor, type ServiceContext } from "../src/index.js";

/**
 * THE ACCOUNT'S CALENDAR SWITCH: one row, written in the order every settings writer keeps, with
 * one `settings` change beside it whose seq the write answers, and nothing at all when nothing
 * changes. And the settings record that carries it to every device: the instant or `null` where a
 * composition keeps a calendar, and no key at all where it keeps none.
 */

const NOW = new Date("2026-07-27T00:00:00.000Z");

async function world() {
  const db = await makeTestDb();
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: `cal-${accountId.slice(0, 8)}` });
  let clock = NOW;
  const ctx: ServiceContext = { db: dbFor(db, accountId), accountId, userId: null, now: () => clock, requestId: "r" };
  return { db, accountId, ctx, tick: (ms: number) => { clock = new Date(clock.getTime() + ms); } };
}

const settingsChanges = async (db: Awaited<ReturnType<typeof makeTestDb>>, accountId: string) =>
  db.select({ seq: changeLog.seq, op: changeLog.op, id: changeLog.entityId }).from(changeLog)
    .where(and(eq(changeLog.accountId, accountId), eq(changeLog.entityType, "settings")));

const stampOf = async (db: Awaited<ReturnType<typeof makeTestDb>>, accountId: string) =>
  (await db.select({ at: accountSettings.updatedAt }).from(accountSettings).where(eq(accountSettings.accountId, accountId)))[0]?.at ?? null;

async function calendarOf(db: Awaited<ReturnType<typeof makeTestDb>>, accountId: string, access: string): Promise<string> {
  const connectionId = randomUUID();
  const id = randomUUID();
  await db.insert(calConnections).values({ id: connectionId, accountId, provider: "google", label: "Personal" });
  await db.insert(calCalendars).values({ id, accountId, connectionId, providerId: `cal-${id}`, name: "Home", access });
  return id;
}

const refusal = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return "accepted";
  } catch (err) {
    return err instanceof ServiceError ? `${err.httpStatus} ${err.code}` : String(err);
  }
};

describe("the account's calendar switch", () => {
  it("answers the defaults before anything was written", async () => {
    const w = await world();
    expect(await calendarSettings(w.ctx)).toEqual({
      unconfigured: true, enabledAt: null, secondZone: null, weekNumbers: false, dayFromMinute: null, dayToMinute: null, newEventsCalendarId: null,
    });
    expect(await calendarFeed.enabledAt(w.db, w.accountId)).toBeNull();
  });

  it("switching on stores the instant, moves the settings stamp and records one settings change, whose seq it answers", async () => {
    const w = await world();
    await w.db.insert(accountSettings).values({ accountId: w.accountId, updatedAt: new Date("2026-01-01T00:00:00.000Z") });
    const { settings, seq } = await setCalendarSettings(w.ctx, { enabled: true, weekNumbers: true });
    expect(settings).toMatchObject({ enabledAt: NOW.toISOString(), weekNumbers: true });
    expect(await calendarFeed.enabledAt(w.db, w.accountId)).toEqual(NOW);
    expect(await stampOf(w.db, w.accountId)).toEqual(NOW);
    const changes = await settingsChanges(w.db, w.accountId);
    expect(changes).toEqual([{ seq: seq!, op: "update", id: w.accountId }]);
  });

  it("a request that changes nothing writes nothing and answers no seq", async () => {
    const w = await world();
    await setCalendarSettings(w.ctx, { enabled: true });
    w.tick(60_000);
    const stamp = await stampOf(w.db, w.accountId);
    const again = await setCalendarSettings(w.ctx, { enabled: true, weekNumbers: false });
    expect(again.seq).toBeNull();
    // Switching on again keeps the instant it first went on.
    expect(again.settings.enabledAt).toBe(NOW.toISOString());
    expect(await settingsChanges(w.db, w.accountId)).toHaveLength(1);
    expect(await stampOf(w.db, w.accountId)).toEqual(stamp);
  });

  it("switching off clears the instant, and on again takes a new one", async () => {
    const w = await world();
    await setCalendarSettings(w.ctx, { enabled: true });
    w.tick(60_000);
    expect((await setCalendarSettings(w.ctx, { enabled: false })).settings.enabledAt).toBeNull();
    expect((await calendarSettings(w.ctx)).unconfigured).toBeUndefined();
    expect(await calendarFeed.enabledAt(w.db, w.accountId)).toBeNull();
    w.tick(60_000);
    const on = await setCalendarSettings(w.ctx, { enabled: true });
    expect(on.settings.enabledAt).toBe(new Date(NOW.getTime() + 120_000).toISOString());
    expect(await settingsChanges(w.db, w.accountId)).toHaveLength(3);
  });

  it("refuses a body that names nothing or says something no setting can hold", async () => {
    const w = await world();
    for (const body of [
      {}, [], null, "on", { enabled: "yes" }, { secondZone: "Mars/Olympus_Mons" }, { secondZone: "x".repeat(65) },
      { weekNumbers: 1 }, { dayFromMinute: 480 }, { dayFromMinute: 600, dayToMinute: 480 }, { dayToMinute: 1441, dayFromMinute: 0 },
      { dayFromMinute: 7.5, dayToMinute: 600 }, { newEventsCalendarId: "not-an-id" },
    ]) {
      expect(await refusal(setCalendarSettings(w.ctx, body)), JSON.stringify(body)).toBe("400 validation_failed");
    }
    expect(await settingsChanges(w.db, w.accountId)).toEqual([]);
    expect(await w.db.select().from(calSettings)).toEqual([]);
    const ok = await setCalendarSettings(w.ctx, { secondZone: "Asia/Tokyo", dayFromMinute: 480, dayToMinute: 1080 });
    expect(ok.settings).toMatchObject({ secondZone: "Asia/Tokyo", dayFromMinute: 480, dayToMinute: 1080, enabledAt: null });
  });

  it("names a calendar for new events only among this account's own, and one that takes them", async () => {
    const w = await world();
    const otherAccount = randomUUID();
    await w.db.insert(accounts).values({ id: otherAccount, name: "other" });
    const foreign = await calendarOf(w.db, otherAccount, "owner");
    const reader = await calendarOf(w.db, w.accountId, "reader");
    const writable = await calendarOf(w.db, w.accountId, "writer");
    expect(await refusal(setCalendarSettings(w.ctx, { newEventsCalendarId: foreign }))).toBe("404 not_found");
    expect(await refusal(setCalendarSettings(w.ctx, { newEventsCalendarId: reader }))).toBe("404 not_found");
    expect(await refusal(setCalendarSettings(w.ctx, { newEventsCalendarId: randomUUID() }))).toBe("404 not_found");
    expect((await setCalendarSettings(w.ctx, { newEventsCalendarId: writable })).settings.newEventsCalendarId).toBe(writable);
  });

  it("writes nothing for an account whose erasure began", async () => {
    const w = await world();
    await w.db.update(accounts).set({ erasedAt: NOW }).where(eq(accounts.id, w.accountId));
    expect(await refusal(setCalendarSettings(w.ctx, { enabled: true }))).toBe("410 account_erased");
    expect(await w.db.select().from(calSettings)).toEqual([]);
    expect(await settingsChanges(w.db, w.accountId)).toEqual([]);
  });

  it("the later calendar routes' first question: 409 calendar_off until it is on", async () => {
    const w = await world();
    expect(await refusal(requireCalendarOn(w.ctx))).toBe("409 calendar_off");
    await setCalendarSettings(w.ctx, { enabled: true });
    expect(await requireCalendarOn(w.ctx)).toEqual(NOW);
  });
});

describe("the settings record carries the switch", () => {
  const svc = new SyncService();
  const switchOn = (s: unknown) => (s as SettingsDTO);

  async function withSettingsChange() {
    const w = await world();
    await w.db.transaction((tx) => recordChange(tx as never, { accountId: w.accountId, entityType: "settings", entityId: w.accountId, op: "update" }));
    return w;
  }
  const settingsOf = (res: Awaited<ReturnType<SyncService["getChanges"]>>) =>
    switchOn([...res.changes.creates, ...res.changes.updates].find((c) => c.type === "settings")?.entity);

  it("through the feed: no key where no calendar is kept; null, then the instant, where one is", async () => {
    const w = await withSettingsChange();
    const without = settingsOf(await svc.getChanges(w.ctx, { since: "0" }));
    expect(without).toBeDefined();
    expect(Object.keys(without)).not.toContain("calendarEnabledAt");
    expect(settingsOf(await svc.getChanges(w.ctx, { since: "0", calendar: calendarFeed })).calendarEnabledAt).toBeNull();
    await setCalendarSettings(w.ctx, { enabled: true });
    expect(settingsOf(await svc.getChanges(w.ctx, { since: "0", calendar: calendarFeed })).calendarEnabledAt).toBe(NOW.toISOString());
  });

  it("on the snapshot's first page alike", async () => {
    const w = await world();
    const page1 = async (calendar?: typeof calendarFeed) =>
      switchOn((await svc.getSnapshot(w.ctx, calendar ? { calendar } : {})).changes.find((c) => c.type === "settings")?.entity);
    expect(Object.keys(await page1())).not.toContain("calendarEnabledAt");
    expect((await page1(calendarFeed)).calendarEnabledAt).toBeNull();
    await setCalendarSettings(w.ctx, { enabled: true });
    expect((await page1(calendarFeed)).calendarEnabledAt).toBe(NOW.toISOString());
    expect(Object.keys(await page1())).not.toContain("calendarEnabledAt");
  });
});
