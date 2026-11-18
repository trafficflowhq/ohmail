import type { DraftDTO } from "@ohmail/wire";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { drafts, mailboxes, recordChanges } from "@trafficflow/db";
import { makeOwnedDb, type OwnedDb } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { SYNC_PAGE_MAX_BYTES } from "@trafficflow/core/transport-frame";
import { syncService } from "@trafficflow/services";
import type { ServiceContext } from "@trafficflow/services";
import { flatten } from "./_apply-harness.js";

const PG_UP = await realPgAvailable();
const NOW = new Date("2026-09-28T09:00:00.000Z");

/**
 * A DELTA PAGE FITS THE FRAME THAT CARRIES IT — the snapshot's byte bound, on `GET /sync`.
 *
 * The delta paged by rows alone, so one page of large drafts outweighed the local transport's
 * frame, which refuses it whole and on every retry. Real Postgres: the byte cut moves a coalesced
 * page's lookahead cursor, and PGlite's heap will not hold these rows. Plain and coalesced pages
 * are both driven, and a row too heavy for any page is withheld as the snapshot withholds it.
 */
describe.skipIf(!PG_UP)("a delta page fits the frame that carries it (real Postgres)", () => {
  let owned: OwnedDb;
  const made: string[] = [];
  const RICH_KIB = 170;

  const filler = (kib: number, seed: string): string =>
    `${seed}-`.repeat(Math.ceil((kib * 1024) / (seed.length + 1))).slice(0, kib * 1024);

  const dctx = (accountId: string): ServiceContext => ({
    db: owned.db as unknown as ServiceContext["db"], accountId, userId: null,
    now: () => NOW, requestId: "delta-fits-the-frame",
  });

  /** An account holding `n` drafts of ~170 KiB text and ~170 KiB HTML each. */
  async function richAccount(n: number): Promise<{ accountId: string; mailboxId: string; ids: string[] }> {
    const accountId = randomUUID();
    made.push(accountId);
    const [mb] = await owned.db.insert(mailboxes).values({
      accountId, provider: "imap", address: `delta-${accountId}@tf.example`,
    }).returning();
    const ids: string[] = [];
    for (let i = 0; i < n; i += 10) {
      const back = await owned.db.insert(drafts).values(Array.from({ length: 10 }, (_, k) => ({
        accountId, mailboxId: mb!.id, subject: `rich ${i + k}`,
        body: filler(RICH_KIB, `t${i + k}`), html: `<p>${filler(RICH_KIB, `h${i + k}`)}</p>`,
        status: "draft" as const, updatedAt: new Date(NOW.getTime() - (i + k) * 60_000),
      }))).returning({ id: drafts.id });
      ids.push(...back.map((r) => r.id));
    }
    return { accountId, mailboxId: mb!.id, ids };
  }

  const draftChanges = (accountId: string, ids: readonly string[], op: "create" | "update") =>
    ids.map((entityId) => ({ accountId, entityType: "draft" as const, entityId, op, meta: null }));

  /** Drain `/sync` from `since`, weighing every page with the route's own serializer. */
  async function drain(accountId: string, since: string): Promise<{
    bytes: number[]; drafts: Map<string, DraftDTO>; repeatsOnPage1: number;
  }> {
    const seen = new Map<string, DraftDTO>();
    const bytes: number[] = [];
    let repeatsOnPage1 = 0;
    for (let page = 1; ; page += 1) {
      const resp = await syncService.getChanges(dctx(accountId), { since });
      bytes.push(Buffer.byteLength(JSON.stringify(resp), "utf8"));
      const ids = flatten(resp).filter((c) => c.type === "draft").map((c) => c.id);
      if (page === 1) repeatsOnPage1 = ids.length - new Set(ids).size;
      for (const c of flatten(resp)) if (c.type === "draft" && c.entity) seen.set(c.id, c.entity as DraftDTO);
      if (!resp.hasMore) return { bytes, drafts: seen, repeatsOnPage1 };
      since = resp.cursor;
      if (page > 40) throw new Error("the delta drain did not terminate");
    }
  }

  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    owned = makeOwnedDb(PG_TEST_URL);
  }, 120_000);

  afterAll(async () => {
    if (!owned) return;
    for (const a of made) {
      await owned.db.execute(sql`delete from change_log where account_id = ${a}`);
      await owned.db.delete(drafts).where(eq(drafts.accountId, a));
      await owned.db.delete(mailboxes).where(eq(mailboxes.accountId, a));
    }
    await owned.close();
  }, 300_000);

  it("a plain page of large drafts ends before the frame and the next page carries the rest", async () => {
    const { accountId, ids } = await richAccount(100);
    await owned.db.transaction((tx) => recordChanges(tx, draftChanges(accountId, ids, "create")));
    const walk = await drain(accountId, "0");
    for (const [i, n] of walk.bytes.entries()) {
      expect(n, `page ${i + 1} is ${n} bytes, past the frame`).toBeLessThanOrEqual(SYNC_PAGE_MAX_BYTES);
    }
    expect(walk.bytes.length, "one page could not have carried these rows").toBeGreaterThan(1);
    expect([...walk.drafts.keys()].sort()).toEqual([...ids].sort());
    for (const d of walk.drafts.values()) expect(d.bodyOmitted).toBeUndefined();
  }, 600_000);

  it("a coalesced page cut by bytes resumes at the entity it did not carry", async () => {
    const { accountId, mailboxId, ids } = await richAccount(100);
    // Written once, after the rich drafts, and never again: a resume past the CUT entity's last
    // change instead of its first skips every one of them.
    const quiet = (await owned.db.insert(drafts).values(Array.from({ length: 20 }, (_, i) => ({
      accountId, mailboxId, subject: `quiet ${i}`, body: `a line ${i}`, status: "draft" as const,
    }))).returning({ id: drafts.id })).map((r) => r.id);
    // One change below the cursor, then 620 above it — past the coalescing span, so each page is
    // one row per entity and the cut moves the lookahead cursor, not a row cursor.
    const [below] = await owned.db.transaction((tx) => recordChanges(tx, [
      { accountId, entityType: "rule", entityId: randomUUID(), op: "create", meta: null },
    ]));
    await owned.db.transaction((tx) => recordChanges(tx, [
      ...draftChanges(accountId, [...ids, ...quiet], "create"),
      ...Array.from({ length: 5 }, () => draftChanges(accountId, ids, "update")).flat(),
    ]));
    const walk = await drain(accountId, syncService.encodeCursor(below!));
    expect(walk.repeatsOnPage1, "page 1 was not the coalesced shape").toBe(0);
    for (const [i, n] of walk.bytes.entries()) {
      expect(n, `page ${i + 1} is ${n} bytes, past the frame`).toBeLessThanOrEqual(SYNC_PAGE_MAX_BYTES);
    }
    expect(walk.bytes.length).toBeGreaterThan(1);
    expect([...walk.drafts.keys()].sort()).toEqual([...ids, ...quiet].sort());
    for (const d of walk.drafts.values()) expect(d.bodyOmitted).toBeUndefined();
  }, 600_000);

  it("a draft no page could carry is withheld and the rows beside it arrive whole", async () => {
    const accountId = randomUUID();
    made.push(accountId);
    const [mb] = await owned.db.insert(mailboxes).values({
      accountId, provider: "imap", address: `delta-${accountId}@tf.example`,
    }).returning();
    const [huge] = await owned.db.insert(drafts).values({
      accountId, mailboxId: mb!.id, subject: "the enormous one", rationale: filler(40 * 1024, "huge"),
      body: "a short plain alternative", status: "draft", updatedAt: NOW,
    }).returning({ id: drafts.id });
    const small = await owned.db.insert(drafts).values(Array.from({ length: 3 }, (_, i) => ({
      accountId, mailboxId: mb!.id, subject: `ordinary ${i}`, body: `nothing much ${i}`,
      status: "draft" as const, updatedAt: new Date(NOW.getTime() - (i + 1) * 60_000),
    }))).returning({ id: drafts.id });
    await owned.db.transaction((tx) => recordChanges(
      tx, draftChanges(accountId, [huge!.id, ...small.map((r) => r.id)], "create"),
    ));
    const walk = await drain(accountId, "0");
    for (const n of walk.bytes) expect(n).toBeLessThanOrEqual(SYNC_PAGE_MAX_BYTES);
    const withheld = walk.drafts.get(huge!.id);
    expect(withheld?.bodyOmitted).toBe("over_page_budget");
    expect(withheld?.rationale).toBeNull();
    for (const r of small) expect(walk.drafts.get(r.id)?.body).toMatch(/^nothing much /);
  }, 600_000);
});
