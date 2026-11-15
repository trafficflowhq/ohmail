import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { and, eq } from "drizzle-orm";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import {
  accounts, accountStorage, bodyBytesOf, changeLog, mailboxes, messageBodies, messageInstances,
  messages,
} from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import {
  UNMETERED_STORAGE_CAP, fingerprintDedupKey, messageFingerprint, normalizeMime,
  prepareHtmlForStorage,
} from "@trafficflow/core";
import type { MailboxAdapter } from "@trafficflow/core/adapters/imap";
import { makeDrizzleRepo, type WorkerRepo } from "@trafficflow/core/adapters/drizzle-repo";
import type { NativeLocator } from "@trafficflow/core";
import { junkRestorePass } from "../src/junk-restore.js";

/**
 * ═══ THE `junk_filed` RESTORE ON REAL POSTGRES — the rewrite, the accounting, the predicate ══
 *
 * Real Postgres (:5433), because every claim here is transactional bookkeeping — the FOR UPDATE
 * lock-and-recheck, `reserveBodyBytes`' counter row lock, the savepoint the shared rewrite opens
 * inside the caller's transaction — which is exactly the class PGlite has been shown not to
 * witness (CLAUDE.md). The control flow around the rewrite (budgets, refusal memory, the epoch
 * guard) is `junk-restore.test.ts`'s; this file is the half that touches the database.
 *
 * It also carries mail 0071's MEASUREMENT: the candidate read
 * (`DrizzleRepo.listJunkFiledHusks`) must ride `message_bodies_withheld_idx`, the partial index
 * that migration creates — asserted against the live catalog (`pg_indexes` carries the partial
 * predicate) and against the planner (EXPLAIN of the read's exact shape names the index), so a
 * migration that stops shipping the index, or a predicate edit that makes the index inapplicable
 * to this read, goes red HERE rather than as a worker cycle that quietly stops finishing.
 *
 * ── MUTATIONS WATCHED (each run red, then restored) ─────────────────────────────────────────
 *
 *  · husk-restore.ts: drop the `withheld === 'junk_filed'` recheck under the row lock ⇒ the
 *    second-rewrite test red (a row already restored is rewritten and the counter double-pays).
 *  · husk-restore.ts: treat `reserveBodyBytes` as always granted ⇒ the at-cap test red (the
 *    account grows past its entitlement through a restore).
 *  · drizzle-repo.ts#listJunkFiledHusks: drop `isNull(messages.deletedAt)` ⇒ the tombstone
 *    exclusion red; drop the primary-instance join ⇒ the junk-parked exclusion red.
 */

const AVAILABLE = await realPgAvailable();
const LOC = (folder: string, ref: string): NativeLocator => ({ folder, ref });

const RAW = [
  "From: stranger@example.test",
  "To: me@ohmail.test",
  "Subject: back from junk",
  "Message-ID: <back-from-junk-1@example.test>",
  "Date: Tue, 25 Aug 2026 09:00:00 +0000",
  "MIME-Version: 1.0",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "the whole body of a message a verdict once filed to Junk, now back in the Imbox",
  "",
].join("\r\n");

describe.skipIf(!AVAILABLE)("mail 0065/0071 — the junk_filed restore against real Postgres", () => {
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let sql: ReturnType<typeof postgres>;

  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    sql = postgres(PG_TEST_URL, { max: 4, onnotice: () => {} });
    db = brandDialect(drizzle(sql, { schema }), "pg");
  }, 60_000);

  afterAll(async () => { await sql?.end({ timeout: 5 }); });

  const repoOf = (): WorkerRepo & { transaction: <T>(fn: (r: WorkerRepo) => Promise<T>) => Promise<T> } =>
    makeDrizzleRepo(db as never) as never;

  /**
   * One account, one message whose identity matches {@link RAW}, its body stored then husked by
   * the repo's own `huskBody` — the exact write the filing completion performs — so the counter
   * has genuinely released the bytes before the pass tries to put them back.
   */
  async function seed(opts: {
    instances?: Array<{ folder: string; uid: number; primary: boolean }>;
    identity?: "matching" | "wrong";
    deletedAt?: Date;
    uniqueRaw?: string;
  } = {}) {
    const accountId = randomUUID();
    const tag = accountId.slice(0, 8);
    const raw = (opts.uniqueRaw ?? RAW).replace("back-from-junk-1", `back-from-junk-${tag}`);
    const norm = await normalizeMime(Buffer.from(raw, "utf8"));
    await db.insert(accounts).values({ id: accountId, name: `jr-${tag}` });
    const [mb] = await db.insert(mailboxes).values({
      accountId, provider: "imap", address: `jr-${tag}@example.test`, status: "connected",
    }).returning();
    const instances = opts.instances ?? [{ folder: "INBOX", uid: 300, primary: true }];
    const wrong = opts.identity === "wrong";
    const [m] = await db.insert(messages).values({
      accountId, mailboxId: mb!.id,
      dedupKey: wrong ? `mid:<somebody-elses-${tag}@example.test>` : fingerprintDedupKey(messageFingerprint(norm)),
      messageIdHeader: wrong ? `somebody-elses-${tag}@example.test` : norm.canonical.messageIdHeader,
      fromAddress: norm.from.address, subject: norm.subject,
      bodyHash: norm.canonical.bodyHash,
      nativeLocator: instances.length > 0
        ? LOC(instances[0]!.folder, `1:${instances[0]!.uid}`)
        : LOC("[Gmail]/Spam", "7:700"),
      ...(opts.deletedAt !== undefined ? { deletedAt: opts.deletedAt } : {}),
    }).returning();
    for (const i of instances) {
      await db.insert(messageInstances).values({
        accountId, messageId: m!.id, mailboxId: mb!.id, folder: i.folder, uid: i.uid,
        uidvalidity: 1n, isPrimary: i.primary,
      });
    }
    await db.insert(messageBodies).values({ messageId: m!.id, accountId: m!.accountId, text: norm.textBody, html: null });
    const bytes = bodyBytesOf({ text: norm.textBody, html: null });
    await db.insert(accountStorage).values({ accountId, bytes });
    // THE FILING'S OWN HUSK — text emptied, marker written, bytes released, all by the one
    // production write. After this the counter is back at zero, honestly.
    const husked = await repoOf().huskBody!(accountId, m!.id, "junk_filed");
    expect(husked).toBe(true);
    return { accountId, mailboxId: mb!.id, messageId: m!.id, norm, raw, bytes };
  }

  function adapterFor(raw: string, uid = 300, uidValidity = "1"): MailboxAdapter {
    return {
      move: async () => { throw new Error("this pass must never move mail"); },
      setFlags: async () => { throw new Error("this pass must never flag mail"); },
      fetchByUid: async (folder: string, uids: readonly number[]) => ({
        uidValidity,
        creates: uids.filter((u) => u === uid).map((u) => ({
          type: "create" as const, locator: { folder, ref: `${uidValidity}:${u}` }, raw: Buffer.from(raw, "utf8"),
        })),
        absent: uids.filter((u) => u !== uid),
        oversize: [],
      }),
    } as unknown as MailboxAdapter;
  }

  const runPass = (w: { accountId: string; mailboxId: string; raw: string }, cap: number | typeof UNMETERED_STORAGE_CAP = UNMETERED_STORAGE_CAP) => {
    const repo = repoOf();
    return junkRestorePass({
      repo, adapter: adapterFor(w.raw), accountId: w.accountId, mailboxId: w.mailboxId,
      storageCap: cap, write: (fn) => repo.transaction(fn),
      refused: new Set<string>(), capDeferred: new Map<string, number>(),
    });
  };

  const counterOf = async (accountId: string): Promise<number> => {
    const [row] = await db.select().from(accountStorage).where(eq(accountStorage.accountId, accountId));
    return Number(row?.bytes ?? 0);
  };

  it("restores the husk from the mailbox: body back, marker cleared, bytes paid, one update delta", async () => {
    const w = await seed();
    expect(await counterOf(w.accountId), "the husk must have released its bytes").toBe(0);

    const r = await runPass(w);
    expect(r).toMatchObject({ examined: 1, fetched: 1, restored: 1 });

    const [body] = await db.select().from(messageBodies).where(eq(messageBodies.messageId, w.messageId));
    expect(body!.withheldReason).toBeNull();
    expect(body!.text).toBe(w.norm.textBody);
    // The account pays for EXACTLY what was stored — the same arithmetic the rewrite used.
    const expected = bodyBytesOf({ text: w.norm.textBody, html: prepareHtmlForStorage(w.norm.htmlBody) });
    expect(await counterOf(w.accountId)).toBe(expected);

    const [msg] = await db.select().from(messages).where(eq(messages.id, w.messageId));
    expect(msg!.snippet).toContain("the whole body of a message");

    const deltas = await db.select().from(changeLog).where(and(
      eq(changeLog.accountId, w.accountId), eq(changeLog.entityId, w.messageId), eq(changeLog.op, "update"),
    ));
    expect(deltas, "clients learn about the refill through exactly one update delta").toHaveLength(1);

    // IDEMPOTENT: the restored row leaves the predicate, so the next cycle selects nothing.
    const again = await runPass(w);
    expect(again).toMatchObject({ examined: 0, fetched: 0, restored: 0 });
  });

  it("the lock-and-recheck: a second rewrite answers not_husked and the counter moves once", async () => {
    const w = await seed();
    const repo = repoOf();
    const fresh = await normalizeMime(Buffer.from(w.raw, "utf8"));
    const husk = { id: w.messageId, dedupKey: fingerprintDedupKey(messageFingerprint(fresh)), messageIdHeader: fresh.canonical.messageIdHeader };
    expect(await repo.unhuskJunkFiledBody!(w.accountId, husk, fresh, null)).toBe("restored");
    const paid = await counterOf(w.accountId);
    expect(paid).toBeGreaterThan(0);
    // The loser of the race — same bytes, same identity, row no longer husked.
    expect(await repo.unhuskJunkFiledBody!(w.accountId, husk, fresh, null)).toBe("not_husked");
    expect(await counterOf(w.accountId), "one restore, one reservation, whoever wins").toBe(paid);
  });

  it("at cap the husk STANDS: marker true, text empty, counter untouched", async () => {
    const w = await seed();
    // AT the cap, not merely capped: `reserveBodyBytes` is ingest's rolling-window reserve and
    // grants while the counter is strictly BELOW the cap (the crossing row stays in), so the
    // decline this test pins is the account whose OTHER stored mail already fills its
    // entitlement — counter at the cap — asking to grow further through a restore.
    await db.update(accountStorage).set({ bytes: 10 }).where(eq(accountStorage.accountId, w.accountId));
    const r = await runPass(w, 10);
    expect(r).toMatchObject({ restored: 0, refused: 1 });
    const [body] = await db.select().from(messageBodies).where(eq(messageBodies.messageId, w.messageId));
    expect(body!.withheldReason, "the marker keeps telling the truth: the bytes live in the mailbox").toBe("junk_filed");
    expect(body!.text).toBe("");
    expect(await counterOf(w.accountId), "a declined reserve leaves the counter exactly where it stood").toBe(10);
  });

  it("a husk still parked in Junk — no watched instance — is never offered", async () => {
    const w = await seed({ instances: [] });
    const r = await runPass(w);
    expect(r).toMatchObject({ examined: 0, fetched: 0 });
    const [body] = await db.select().from(messageBodies).where(eq(messageBodies.messageId, w.messageId));
    expect(body!.withheldReason).toBe("junk_filed");
  });

  it("a tombstoned row is never offered, whatever instances it still carries", async () => {
    const w = await seed({ deletedAt: new Date() });
    const r = await runPass(w);
    expect(r).toMatchObject({ examined: 0, fetched: 0 });
  });

  it("identity mismatch writes NOTHING — the two-witness check against the real parser", async () => {
    const w = await seed({ identity: "wrong" });
    const r = await runPass(w);
    expect(r).toMatchObject({ restored: 0, refused: 1 });
    const [body] = await db.select().from(messageBodies).where(eq(messageBodies.messageId, w.messageId));
    expect(body!.withheldReason).toBe("junk_filed");
    expect(body!.text, "bytes are never stored into a row they do not belong to").toBe("");
    expect(await counterOf(w.accountId)).toBe(0);
  });

  it("mail 0071: the candidate read rides message_bodies_withheld_idx (measured, not assumed)", async () => {
    const w = await seed();
    // The catalog carries the index WITH its partial predicate — the migration's exact shape.
    const [ix] = await sql`select indexdef from pg_indexes where indexname = 'message_bodies_withheld_idx'`;
    expect(ix, "migration 0071 did not create the index").toBeDefined();
    expect(ix!.indexdef).toContain("(withheld_reason, message_id)");
    expect(ix!.indexdef).toContain("withheld_reason IS NOT NULL");

    // And the planner can serve listJunkFiledHusks' EXACT shape from it: with seqscan priced
    // out, the plan must name the index — proving the partial predicate implies the read's
    // equality filter and the keyset can seek it. (On full-sized tables the planner picks
    // it unforced — the husks are a sliver of message_bodies; a 4-row test database legitimately
    // prefers a scan, so the assertion prices that choice out rather than trusting table sizes.)
    const plan = await sql.begin(async (tx) => {
      await tx`set local enable_seqscan = off`;
      return tx.unsafe(`
        explain select m.id, i.folder, i.uid
          from message_bodies b
          join messages m on m.id = b.message_id
          join message_instances i on i.message_id = m.id and i.is_primary
         where b.withheld_reason = 'junk_filed'
           and m.account_id = '${w.accountId}' and m.mailbox_id = '${w.mailboxId}'
           and m.deleted_at is null and m.id > '00000000-0000-0000-0000-000000000000'
         order by m.id asc limit 200`);
    });
    const text = plan.map((row) => String((row as Record<string, unknown>)["QUERY PLAN"])).join("\n");
    expect(text).toContain("message_bodies_withheld_idx");
  });
});
