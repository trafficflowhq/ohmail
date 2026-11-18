import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { makeTestDb } from "@trafficflow/db/testing";
import { accountSettings, changeLog, mailboxes } from "@trafficflow/db";
import {
  SyncService, dbFor, dismissHeldRelease, setBlockRemoteImages,
  type ServiceContext, type SettingsDTO,
} from "../src/index.js";

/**
 * "NOT NOW" ON ONE DEVICE REACHES EVERY OTHER ONE — the dismissal rings the settings doorbell.
 *
 * Measured on 0.25.0: dismissed on the web, the offer stayed on the Cloud-paired desktop through
 * Pull new mail and a reopened Screener. The dismissal is an `account_settings` column, and the
 * write appended no change row and left `updated_at` alone, so no wake rang and no delta carried
 * a stamp a client could see move. The write now does both in its own transaction; the engine
 * re-asks its one held-release door when that stamp moves (`held-release-reaches-every-surface`).
 */

const svc = new SyncService();

async function setup(start = "2026-09-25T14:00:00.000Z") {
  const db = await makeTestDb();
  const accountId = randomUUID();
  await db.insert(mailboxes).values({ accountId, provider: "imap", address: "own@example.com" });
  let tick = 0;
  const ctx: ServiceContext = {
    db: dbFor(db, accountId), accountId, userId: null,
    now: () => new Date(Date.parse(start) + ++tick * 1_000),
    requestId: "r",
  };
  return { db, accountId, ctx };
}

const settingsRows = (db: Awaited<ReturnType<typeof makeTestDb>>, accountId: string) =>
  db.select().from(changeLog).where(and(
    eq(changeLog.accountId, accountId), eq(changeLog.entityType, "settings"),
  ));

type AnyChange = { type: string; entity?: unknown };
const lastSettings = (page: { changes: { creates: AnyChange[]; updates: AnyChange[] } }) =>
  [...page.changes.creates, ...page.changes.updates]
    .filter((c) => c.type === "settings").pop()?.entity as SettingsDTO | undefined;

describe("dismissing the held-mail offer rings the settings doorbell", () => {
  it("appends one settings change row, entity_id = the account, op = update", async () => {
    const { db, accountId, ctx } = await setup();
    await dismissHeldRelease(ctx, { fingerprint: "v1-00000000000000aa" });
    const rows = await settingsRows(db, accountId);
    expect(rows.length, "the dismissal appended no settings change row — no other device hears it").toBe(1);
    expect(rows[0]!.entityId).toBe(accountId);
    expect(rows[0]!.op).toBe("update");
  });

  it("moves the settings entity's stamp, so a stamp-watching device re-asks", async () => {
    const { ctx } = await setup();
    await setBlockRemoteImages(ctx, true); // an existing row with a first stamp
    const before = lastSettings(await svc.getChanges(ctx, { since: "0" }))!;

    await dismissHeldRelease(ctx, { fingerprint: "v1-00000000000000aa" });
    const after = lastSettings(await svc.getChanges(ctx, { since: "0" }))!;
    expect(after.updatedAt > before.updatedAt,
      `the stamp did not move (${before.updatedAt} -> ${after.updatedAt})`).toBe(true);
  });

  it("stores the fingerprint and stamps a first row from the context clock", async () => {
    const { db, accountId, ctx } = await setup();
    await dismissHeldRelease(ctx, { fingerprint: "v1-00000000000000bb" });
    const [row] = await db.select().from(accountSettings).where(eq(accountSettings.accountId, accountId));
    expect(row?.heldReleaseDismissed).toBe("v1-00000000000000bb");
    expect(row?.updatedAt.toISOString()).toBe("2026-09-25T14:00:01.000Z");
  });

  /** The positive control's twin: a refused dismissal writes nothing and rings nothing. */
  it("a refused fingerprint appends no change row", async () => {
    const { db, accountId, ctx } = await setup();
    await expect(dismissHeldRelease(ctx, { fingerprint: "" })).rejects.toMatchObject({ httpStatus: 400 });
    expect(await settingsRows(db, accountId)).toHaveLength(0);
  });
});
