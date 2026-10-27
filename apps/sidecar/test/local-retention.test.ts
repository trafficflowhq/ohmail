import { rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import type { ChangeBatch, ImapCapabilities, ImapConfig, MailboxAdapter } from "@trafficflow/core/adapters/imap";
import type { LeaseIo, RawClaimMessage } from "@trafficflow/core/adapters/organizer-lease";
import { RETENTION_DELETE_BATCH, accountSyncState, changeLog, idempotencyKeys, seqBounds, type Tx } from "@trafficflow/db";
import { createSidecar, type Sidecar } from "../src/engine.js";
import { LOCAL_RETENTION_EVERY_MS, localRetentionDue, runLocalRetention } from "../src/local-retention.js";
import { inStoreLane } from "../src/store-lanes.js";
import { PGLITE_STANDUP_BUDGET_MS } from "./pglite-budget.js";
import { freshDataDir } from "./_datadir.js";

vi.setConfig({ testTimeout: PGLITE_STANDUP_BUDGET_MS });

/**
 * THE LOCAL STORE PRUNES ITS OWN CHANGE LOG. The door stamps the window's session on every drain,
 * so the hosted horizon holds the log back here exactly as it does for a hosted client, and the
 * drain's upkeep runs the same compaction. Rows 40 days old, one drain: the floor rises, every
 * entity keeps one row, and a cursor below the floor is told to start again. Rows 20 days old sit
 * inside the grace and all survive, which is this file's control.
 */

class FreeLease implements LeaseIo {
  private nextUid = 1;
  private readonly claims: RawClaimMessage[] = [];
  async ensureMetaFolder(): Promise<void> {}
  async listClaims(): Promise<RawClaimMessage[]> { return this.claims.map((c) => ({ ...c })); }
  async appendClaim(raw: string): Promise<void> { this.claims.push({ ref: this.nextUid++, raw }); }
  async removeClaims(refs: readonly unknown[]): Promise<void> {
    const gone = new Set(refs);
    for (let i = this.claims.length - 1; i >= 0; i--) if (gone.has(this.claims[i]!.ref)) this.claims.splice(i, 1);
  }
  uidValidity(): number { return 4_100; }
}

function quiet(): (cfg: ImapConfig) => MailboxAdapter & { leaseIo(): LeaseIo } {
  const lease = new FreeLease();
  return () => ({
    leaseIo: () => lease,
    async connect() {}, async close() {},
    async capabilities(): Promise<ImapCapabilities> {
      return { move: true, uidplus: true, condstore: true, qresync: false, idle: true, specialUse: true, sentFolder: null };
    },
    async ensureFolders() {},
    async changesSince(): Promise<ChangeBatch> {
      return { creates: [], moves: [], flagChanges: [], deletes: [], newCursor: { folders: {} } };
    },
    async move(l) { return l; }, async setFlags() {}, async scanSentRecipients() { return []; },
    async watch() { return async () => {}; },
    async send() { throw new Error("this mailbox cannot send"); },
    async fetchPart() { throw new Error("this mailbox cannot fetchPart"); },
  });
}

const DAY = 86_400_000;
const cursor = (seq: bigint): string => Buffer.from(String(seq), "utf8").toString("base64url");

describe("the local store's change log has a retention", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

  /** One store, 100 entities x (create, update, update) planted `ageDays` old, every row before them aged too. */
  async function world(ageDays: number): Promise<{ sidecar: Sidecar; lines: string[]; planted: bigint[] }> {
    const dataDir = await freshDataDir("ohmail-local-retention-");
    const lines: string[] = [];
    const sidecar = await createSidecar({
      dataDir,
      imap: { host: "imap.invalid", port: 993, secure: true, auth: { user: "owner@trafficflow.test", pass: "not-dialled-password-password" } },
      address: "owner@trafficflow.test", pollIntervalMs: 60 * 60 * 1000, leaseStaleAfterMs: 60_000,
      adapterFactory: quiet(), log: (event) => lines.push(event),
    });
    cleanups.push(async () => { await sidecar.stop(); rmSync(dataDir, { recursive: true, force: true }); });
    const acct = sidecar.world.accountId;
    const old = new Date(Date.now() - ageDays * DAY);
    await sidecar.db.update(changeLog).set({ createdAt: old }).where(eq(changeLog.accountId, acct));
    const top = (await seqBounds(sidecar.db as unknown as Tx, acct)).max ?? 0n;
    const planted: bigint[] = [];
    let seq = top;
    for (let e = 0; e < 100; e += 1) {
      const entityId = randomUUID();
      for (const op of ["create", "update", "update"] as const) {
        seq += 1n;
        planted.push(seq);
        await sidecar.db.insert(changeLog).values({ accountId: acct, seq, entityType: "message", entityId, op, createdAt: old });
      }
    }
    // The counter row the allocator keeps; a store that wrote any change through it has one.
    await sidecar.db.insert(accountSyncState).values({ accountId: acct, nextSeq: seq + 1n })
      .onConflictDoUpdate({ target: accountSyncState.accountId, set: { nextSeq: seq + 1n } });
    return { sidecar, lines, planted };
  }

  const auth = (s: Sidecar) => ({ authorization: `Bearer ${s.sessionToken}` });
  const floorOf = async (s: Sidecar): Promise<bigint> => {
    const [row] = await s.db.select({ f: accountSyncState.prunedThroughSeq }).from(accountSyncState)
      .where(eq(accountSyncState.accountId, s.world.accountId));
    return BigInt(row?.f ?? 0);
  };

  it("one drain raises the floor, keeps one row an entity, and a cursor below it is told to start again", async () => {
    const { sidecar, lines, planted } = await world(40);
    const key = (k: string, expiresAt: Date) => ({
      accountId: sidecar.world.accountId, key: k, requestHash: "h", responseStatus: 200, responseJson: { applied: true }, seq: null, expiresAt,
    });
    await sidecar.db.insert(idempotencyKeys).values([key("meta-request:old", new Date(Date.now() - DAY)), key("meta-request:live", new Date(Date.now() + DAY))]);
    await sidecar.start();
    const acct = sidecar.world.accountId;
    const keys = await sidecar.db.select({ k: idempotencyKeys.key }).from(idempotencyKeys).where(eq(idempotencyKeys.accountId, acct));
    expect(keys.map((r) => r.k), "the local store keeps every request key it ever claimed").toEqual(["meta-request:live"]);
    const floor = await floorOf(sidecar);
    expect(floor, "the floor never rose: the local store keeps its whole change log for ever").toBeGreaterThan(0n);
    const kept = await sidecar.db.select({ n: sql<number>`count(*)` }).from(changeLog).where(and(
      eq(changeLog.accountId, acct), sql`${changeLog.seq} >= ${Number(planted[0])}`, sql`${changeLog.seq} <= ${Number(planted.at(-1))}`,
    ));
    // One create per entity, and the account's newest row, which the floor may land on.
    expect(Number(kept[0]!.n), "the churn below the floor was not compacted").toBeLessThanOrEqual(101);
    expect(Number(kept[0]!.n)).toBeGreaterThanOrEqual(100);
    expect(lines).toContain("local_retention_pruned");

    const below = await sidecar.handle(new Request(`http://sidecar/sync?since=${cursor(floor - 5n)}`, { headers: auth(sidecar) }));
    expect(below.status, "a cursor below the floor was served a page that skips the pruned rows").toBe(410);
    expect(JSON.stringify(await below.json())).toMatch(/cursor_expired/);
    const top = (await seqBounds(sidecar.db as unknown as Tx, acct)).max!;
    const current = await sidecar.handle(new Request(`http://sidecar/sync?since=${cursor(top)}`, { headers: auth(sidecar) }));
    await current.text();
    expect(current.status, "a current cursor was refused, so the 410 above says nothing about the floor").toBe(200);
  });

  /** Hourly per store, and never while mail is coming in: the pass is upkeep, not the import's. */
  it("is due once an hour per store, and never while the ingest's lane is running", async () => {
    const { sidecar } = await world(40);
    const store = {};
    let t = 1_000_000;
    const clock = { wall: (): number => t, mono: (): number => t };   // one clock moving both readings
    expect(localRetentionDue(store, clock), "a store that never ran it is not due").toBe(true);
    expect(await inStoreLane("ingest", async () => localRetentionDue(store, clock)),
      "the pass was due while mail was coming in").toBe(false);
    await runLocalRetention(sidecar.db as unknown as Tx, sidecar.world.accountId, new Date(), () => {}, clock);
    t += LOCAL_RETENTION_EVERY_MS - 1;
    expect(localRetentionDue(sidecar.db, clock), "due again inside the hour").toBe(false);
    t += 1;
    expect(localRetentionDue(sidecar.db, clock)).toBe(true);
    expect(localRetentionDue(store, clock), "one store's run made another's due").toBe(true);
  });

  it("rows inside the grace all survive the same drain, and the floor stays 0", async () => {
    const { sidecar, planted } = await world(20);
    await sidecar.start();
    expect(await floorOf(sidecar)).toBe(0n);
    const kept = await sidecar.db.select({ n: sql<number>`count(*)` }).from(changeLog).where(and(
      eq(changeLog.accountId, sidecar.world.accountId), sql`${changeLog.seq} >= ${Number(planted[0])}`,
    ));
    expect(Number(kept[0]!.n)).toBe(300);
    const below = await sidecar.handle(new Request(`http://sidecar/sync?since=${cursor(planted[10]!)}`, { headers: auth(sidecar) }));
    await below.text();
    expect(below.status).toBe(200);
  });

  /** A store that never pruned its request keys drains them one delete batch a pass. */
  it("a pass deletes one batch of expired request keys, and the next pass the rest", async () => {
    const { sidecar } = await world(20);
    const acct = sidecar.world.accountId;
    await sidecar.db.execute(sql`insert into idempotency_keys (account_id, key, request_hash, response_status, response_json, expires_at)
      select ${acct}::uuid, 'meta-request:old-' || g, 'h', 200, '{"applied":true}'::jsonb, now() - interval '1 day'
      from generate_series(1, ${RETENTION_DELETE_BATCH + 5}) g`);
    await sidecar.db.insert(idempotencyKeys).values({
      accountId: acct, key: "meta-request:live", requestHash: "h", responseStatus: 200, responseJson: { applied: true }, seq: null,
      expiresAt: new Date(Date.now() + DAY),
    });
    const counts = async (): Promise<{ aged: number; live: number }> => {
      const [r] = await sidecar.db.select({
        aged: sql<number>`count(*) filter (where ${idempotencyKeys.expiresAt} <= now())`,
        live: sql<number>`count(*) filter (where ${idempotencyKeys.expiresAt} > now())`,
      }).from(idempotencyKeys).where(eq(idempotencyKeys.accountId, acct));
      return { aged: Number(r!.aged), live: Number(r!.live) };
    };
    await runLocalRetention(sidecar.db as unknown as Tx, acct, new Date(), () => {});
    expect(await counts(), "one pass deleted more than one batch").toEqual({ aged: 5, live: 1 });
    await runLocalRetention(sidecar.db as unknown as Tx, acct, new Date(), () => {});
    expect(await counts()).toEqual({ aged: 0, live: 1 });
  });
});
