import { afterEach, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { and, eq } from "drizzle-orm";
import { changeLog, mailboxes } from "@trafficflow/db";
import { freshDataDir } from "./_datadir.js";
import { openLocalDb, type OpenLocalDb } from "../src/db.js";
import { ensureLocalWorld } from "../src/identity.js";
import {
  authorizeOrganizerTakeover, recordConsentWithoutClaim, requestOrganizerTakeover,
} from "../src/organize-here.js";

/**
 * THE AGREE PRESS RINGS THE SETTINGS DOORBELL (R20-02). The press writes the account's window, and
 * the open window re-asks `GET /consent` only when a `settings` change row arrives on `/sync`
 * (`useConsentState`'s contract). The desktop door wrote the window and no row, so the device kept
 * partitioning with the window it read before the press. Each consent transaction now appends one
 * row, last; a press that writes nothing appends none.
 */

const opens: OpenLocalDb[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const o of opens.splice(0)) await o.close().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const t0 = new Date("2026-03-01T10:00:00.000Z");
const t1 = new Date("2026-06-01T10:00:00.000Z");

async function standUp(opts: { organizing?: boolean } = {}) {
  const dataDir = await freshDataDir("ohmail-agree-doorbell-");
  dirs.push(dataDir);
  const opened = await openLocalDb(dataDir);
  opens.push(opened);
  const world = await ensureLocalWorld(opened.db, { address: "me@ohmail.test", now: t0 });
  await opened.db.update(mailboxes)
    .set({ organizerRole: "reader", organizeConsentedAt: null })
    .where(eq(mailboxes.id, world.mailboxId));
  const rings = async (): Promise<number> => (await opened.db.select().from(changeLog).where(and(
    eq(changeLog.accountId, world.accountId), eq(changeLog.entityType, "settings"),
    eq(changeLog.entityId, world.accountId),
  ))).length;
  if (opts.organizing) {
    await requestOrganizerTakeover(opened.db, {
      intent: "takeover", mailboxId: world.mailboxId, accountId: world.accountId, now: t0,
      screening: { dormancyDays: 90, scope: "window" },
    });
    await opened.db.update(mailboxes).set({ organizerRole: "organizer" }).where(eq(mailboxes.id, world.mailboxId));
  }
  return { db: opened.db, accountId: world.accountId, mailboxId: world.mailboxId, rings };
}

describe("every consent transaction on the desktop door appends one settings change row", () => {
  it("a first consent with a window", async () => {
    const w = await standUp();
    const before = await w.rings();
    const out = await requestOrganizerTakeover(w.db, {
      intent: "join", mailboxId: w.mailboxId, accountId: w.accountId, now: t0,
      screening: { dormancyDays: 90, scope: "window" },
    });
    expect(out.outcome).toBe("authorized");
    expect(await w.rings(), "the press wrote the window and rang nothing").toBe(before + 1);
  });

  it("a re-run that widens the window (already organizing)", async () => {
    const w = await standUp({ organizing: true });
    const before = await w.rings();
    const out = await requestOrganizerTakeover(w.db, {
      intent: "join", mailboxId: w.mailboxId, accountId: w.accountId, now: t1,
      screening: { dormancyDays: 365, scope: "window" },
    });
    expect(out.outcome).toBe("already_organizing");
    expect(await w.rings(), "the re-run's window never reached the device").toBe(before + 1);
  });

  it("a consent recorded without a claim (the phone's refused press)", async () => {
    const w = await standUp();
    const before = await w.rings();
    expect(await recordConsentWithoutClaim(w.db, { mailboxId: w.mailboxId, now: t0 })).toBe("recorded");
    expect(await w.rings()).toBe(before + 1);
  });

  it("the CLI's first consent", async () => {
    const w = await standUp();
    const before = await w.rings();
    const out = await authorizeOrganizerTakeover(w.db, { mailboxId: w.mailboxId, now: t0, intent: "takeover" });
    expect(out.outcome).toBe("authorized");
    expect(await w.rings()).toBe(before + 1);
  });

  it("CONTROL: a press that asks no window over an existing record writes nothing and rings nothing", async () => {
    const w = await standUp({ organizing: true });
    const before = await w.rings();
    const out = await requestOrganizerTakeover(w.db, { intent: "takeover", mailboxId: w.mailboxId, now: t1 });
    expect(out.outcome).toBe("already_organizing");
    expect(await w.rings()).toBe(before);
  });
});
