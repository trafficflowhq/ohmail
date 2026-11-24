import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { accountSettings, mailboxes, rules as rulesTbl } from "@trafficflow/db";
import { makeTestDb } from "@trafficflow/db/testing";
import { dbFor, GRADUATION_THRESHOLD, HeyMigrationService, LearningService, type ServiceContext } from "@trafficflow/services";
import { rescueJunk } from "../src/junk-window.js";
import type { ApiDeps } from "../src/deps.js";

/**
 * "NOT JUNK, ALWAYS ALLOW" IS THE PERSON'S OWN RULE: it carries their stamp and is never
 * `promoted`, so a graduation for that sender never retargets it and never adds a rule beside it.
 * Converging onto a learned or Screener-made row makes that row theirs the same way; a manual or
 * migrated row already is, and keeps its provenance.
 */
const NOW = new Date("2026-10-05T09:00:00.000Z");
const ADDR = "lena@atelier.example";
const NEWS = "ohmail/News";

async function seed() {
  const db = await makeTestDb();
  const accountId = randomUUID();
  await db.insert(accountSettings).values({ accountId, foldersEnabledAt: NOW });
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: `allow-${randomUUID().slice(0, 8)}@example.invalid`, junkFolder: "Junk",
  }).returning({ id: mailboxes.id });
  // The person's request, signed in: the container's handle and both contexts' bound to the account.
  const bound = dbFor(db, accountId);
  const deps = { db: bound, now: () => NOW } as unknown as ApiDeps;
  const ctx = { accountId, db: bound, now: () => NOW } as unknown as Parameters<typeof rescueJunk>[1];
  const svcCtx = { db: bound, accountId, userId: null, now: () => NOW, requestId: "allow" } as unknown as ServiceContext;
  return { db, deps, ctx, svcCtx, accountId, mailboxId: mb!.id };
}
type World = Awaited<ReturnType<typeof seed>>;

const rowsOf = async (w: World) => (await w.db.select().from(rulesTbl)
  .where(and(eq(rulesTbl.accountId, w.accountId), eq(rulesTbl.kind, "sender"))))
  .map((r) => ({ id: r.id, destination: r.destination, enabled: r.enabled, provenance: r.provenance, stamped: r.personDecidedAt !== null }));

async function graduateToNews(w: World): Promise<void> {
  const learning = new LearningService();
  for (let i = 0; i < GRADUATION_THRESHOLD; i++) {
    await learning.record(w.svcCtx, { triggeringActionId: `g:${i}`, kind: "approval", senderAddress: ADDR, destination: NEWS, label: "positive" });
  }
  await learning.promoteOrDemote(w.svcCtx, `sender:${ADDR}→${NEWS}`);
}

describe("Not junk, always allow is the person's own rule", () => {
  it("a new allow carries the person's stamp, and a graduation for the sender leaves it alone", async () => {
    const w = await seed();
    await rescueJunk(w.deps, w.ctx, { mailboxId: w.mailboxId, uid: 2, uidValidity: "7", allow: { sender: ADDR } });
    const [allow] = await rowsOf(w);
    expect(allow).toMatchObject({ destination: "INBOX", enabled: true, provenance: "manual", stamped: true });
    await graduateToNews(w);
    expect(await rowsOf(w), "the graduation retargeted the person's allow or wrote beside it").toEqual([allow]);
  });

  it("an allow over a learned screen-out makes that row the person's", async () => {
    const w = await seed();
    const [learned] = await w.db.insert(rulesTbl).values({
      accountId: w.accountId, kind: "sender", match: ADDR, destination: "ohmail/Screened", priority: 0, enabled: true, provenance: "promoted",
    }).returning({ id: rulesTbl.id });
    await rescueJunk(w.deps, w.ctx, { mailboxId: w.mailboxId, uid: 2, uidValidity: "7", allow: { sender: ADDR } });
    expect(await rowsOf(w)).toEqual([{ id: learned!.id, destination: "INBOX", enabled: true, provenance: "manual", stamped: true }]);
    await graduateToNews(w);
    expect((await rowsOf(w)).map((r) => [r.id, r.destination])).toEqual([[learned!.id, "INBOX"]]);
  });

  it("an allow over a migrated screen-out keeps its provenance: the row was already the person's", async () => {
    const w = await seed();
    const [migrated] = await w.db.insert(rulesTbl).values({
      accountId: w.accountId, kind: "sender", match: ADDR, destination: "ohmail/Screened", priority: 0, enabled: true, provenance: "migrated",
    }).returning({ id: rulesTbl.id });
    await rescueJunk(w.deps, w.ctx, { mailboxId: w.mailboxId, uid: 2, uidValidity: "7", allow: { sender: ADDR } });
    expect(await rowsOf(w)).toEqual([{ id: migrated!.id, destination: "INBOX", enabled: true, provenance: "migrated", stamped: true }]);
  });

  // The import owns a row only while it is migrated AND unstamped: a re-run or an undo of the HEY
  // import leaves a sender the person decided on alone.
  const imported = [{ senderOrDomain: ADDR, kind: "sender", destination: "ohmail/Screened" }] as never;
  for (const after of ["re-run", "undo"] as const) {
    it(`the HEY import's ${after} leaves the person's allow over an imported screen-out`, async () => {
      const w = await seed();
      const hey = new HeyMigrationService();
      await hey.migrateFromObservations(w.svcCtx, { observations: imported });
      await rescueJunk(w.deps, w.ctx, { mailboxId: w.mailboxId, uid: 2, uidValidity: "7", allow: { sender: ADDR } });
      const allowed = await rowsOf(w);
      expect(allowed.map(({ id: _id, ...r }) => r)).toEqual([{ destination: "INBOX", enabled: true, provenance: "migrated", stamped: true }]);
      if (after === "re-run") await hey.migrateFromObservations(w.svcCtx, { observations: imported });
      else await hey.undoMigration(w.svcCtx);
      expect(await rowsOf(w), `the import's ${after} wrote over the person's allow`).toEqual(allowed);
    });
  }

  it("an allow over a row that already admits is stamped as the person's too", async () => {
    const w = await seed();
    await w.db.insert(rulesTbl).values({
      accountId: w.accountId, kind: "sender", match: ADDR, destination: "INBOX", priority: 0, enabled: true, provenance: "migrated",
    });
    await rescueJunk(w.deps, w.ctx, { mailboxId: w.mailboxId, uid: 2, uidValidity: "7", allow: { sender: ADDR } });
    expect((await rowsOf(w)).map(({ id: _id, ...r }) => r)).toEqual([{ destination: "INBOX", enabled: true, provenance: "migrated", stamped: true }]);
    await new HeyMigrationService().undoMigration(w.svcCtx);
    expect(await rowsOf(w), "the import's undo removed an allow the person pressed").toHaveLength(1);
  });
});
