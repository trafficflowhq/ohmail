import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { accounts, accountSettings, junkRescues, mailboxes, rules as rulesTbl } from "@trafficflow/db";
import { makeOwnedDb, type OwnedDb } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { dbFor } from "@trafficflow/services/mail";
import { rescueJunk } from "../src/junk-window.js";
import type { ApiDeps } from "../src/deps.js";

/**
 * TWO "NOT JUNK" PRESSES ON ONE MAILBOX AT ONCE BOTH LAND (JUNK-ALLOW-TWO-PRESSES-CAN-DEADLOCK).
 * Each press rings the mailbox's doorbell (an UPDATE of its row) in the transaction that fenced
 * that row; fenced FOR SHARE, two presses each hold the share the other's UPDATE waits on. A gate
 * holding both commands' locators makes the overlap certain: each press is parked AFTER its fence
 * and BEFORE its doorbell, then both are let go. Real Postgres only; every backend is named.
 */
const AVAILABLE = await realPgAvailable();
const NOW = new Date("2026-10-04T12:00:00.000Z");
const JUNK_PATH = "INBOX/Spamverdacht";

/** The lane database's URL with an `application_name`, so `pg_stat_activity` names the backend. */
function named(name: string): string {
  const u = new URL(PG_TEST_URL);
  u.searchParams.set("application_name", name);
  return u.toString();
}

const codeOf = (e: unknown): string | undefined =>
  (e as { code?: string } | null)?.code ?? (e as { cause?: { code?: string } } | null)?.cause?.code;

describe.skipIf(!AVAILABLE)("two Not junk presses on one mailbox at once", () => {
  let base: OwnedDb;
  const clients: OwnedDb[] = [];
  const open = (name: string): OwnedDb => { const o = makeOwnedDb(named(name)); clients.push(o); return o; };

  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    base = open(`jr2-base-${randomUUID().slice(0, 8)}`);
  }, 180_000);
  afterAll(async () => { for (const c of clients) await c.close().catch(() => {}); });

  async function world() {
    const [acct] = await base.db.insert(accounts).values({ name: `jr2-${randomUUID().slice(0, 8)}` }).returning();
    const accountId = acct!.id;
    await base.db.insert(accountSettings).values({ accountId, foldersEnabledAt: NOW });
    const [mb] = await base.db.insert(mailboxes).values({
      accountId, provider: "imap", address: `jr2-${randomUUID().slice(0, 8)}@example.invalid`, junkFolder: JUNK_PATH,
    }).returning({ id: mailboxes.id });
    return { accountId, mailboxId: mb!.id };
  }

  /** Until `name`'s backend waits on a lock; refuses after `ms` so a red names where it stuck. */
  async function untilWaiting(name: string, ms = 15_000): Promise<void> {
    const end = Date.now() + ms;
    for (;;) {
      const rows = await base.db.execute(sql`select count(*)::int as n from pg_stat_activity
        where application_name = ${name} and wait_event_type = 'Lock'`) as unknown as Array<{ n: number }>;
      if ((rows[0]?.n ?? 0) > 0) return;
      if (Date.now() > end) throw new Error(`${name} never waited on a lock`);
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  /**
   * A gate transaction holding both locators uncommitted: each press's command insert queues on
   * it after the press's fence. `release` rolls the gate back and lets both through at once.
   */
  async function gate(accountId: string, mailboxId: string, uids: number[]) {
    const g = open(`jr2-gate-${randomUUID().slice(0, 8)}`);
    let held!: () => void;
    const holding = new Promise<void>((r) => { held = r; });
    let release!: () => void;
    const released = new Promise<void>((r) => { release = r; });
    const done = g.db.transaction(async (tx) => {
      await tx.insert(junkRescues).values(uids.map((uid) => ({
        accountId, mailboxId, folder: JUNK_PATH, uidvalidity: 7n, uid, requestedAt: NOW, updatedAt: NOW,
      })));
      held();
      await released;
      throw new Error("gate rolled back");
    }).catch(() => undefined);
    await holding;
    return { release: async () => { release(); await done; } };
  }

  async function race(allow: [boolean, boolean]) {
    const w = await world();
    const tag = randomUUID().slice(0, 8);
    const names = [`jr2-a-${tag}`, `jr2-b-${tag}`] as const;
    const g = await gate(w.accountId, w.mailboxId, [101, 102]);
    const presses = names.map((name, i) => {
      // One named pool per press: its context's handle, bound to the account, is over the same pool,
      // so the press's transaction runs on the backend `untilWaiting` names.
      const own = open(name).db;
      const deps = { db: own, now: () => NOW } as unknown as ApiDeps;
      const ctx = { accountId: w.accountId, db: dbFor(own, w.accountId), now: () => NOW } as unknown as Parameters<typeof rescueJunk>[1];
      return rescueJunk(deps, ctx, {
        mailboxId: w.mailboxId, uid: 101 + i, uidValidity: "7",
        ...(allow[i] ? { allow: { sender: `sender${i}@example.invalid` } } : {}),
      });
    });
    for (const name of names) await untilWaiting(name);
    await g.release();
    const settled = await Promise.allSettled(presses);
    return { w, settled };
  }

  for (const allow of [[false, false], [true, false]] as Array<[boolean, boolean]>) {
    it(`both presses land (allow ${allow.join("/")}): no 40P01, two commands, one doorbell`, async () => {
      const { w, settled } = await race(allow);
      const codes = settled.map((s) => (s.status === "rejected" ? codeOf(s.reason) ?? String(s.reason) : "ok"));
      expect(codes, "a press failed").toEqual(["ok", "ok"]);
      const rows = await base.db.select().from(junkRescues).where(eq(junkRescues.accountId, w.accountId));
      expect(rows.map((r) => r.uid).sort((a, b) => a - b)).toEqual([101, 102]);
      const [mb] = await base.db.select({ at: mailboxes.syncRequestedAt }).from(mailboxes).where(eq(mailboxes.id, w.mailboxId));
      expect(mb!.at?.toISOString()).toBe(NOW.toISOString());
      if (allow[0]) {
        const r = await base.db.select({ match: rulesTbl.match }).from(rulesTbl).where(eq(rulesTbl.accountId, w.accountId));
        expect(r.map((x) => x.match)).toEqual(["sender0@example.invalid"]);
      }
    }, 60_000);
  }

  it("the gate itself does not manufacture a deadlock: two allow presses queue on the rule-key lock", async () => {
    // Positive control for the harness: both presses take the account's rule-key lock before the
    // mailbox row, so the second waits for the first at that lock and never holds the row.
    const { settled } = await race([true, true]);
    expect(settled.map((s) => s.status)).toEqual(["fulfilled", "fulfilled"]);
  }, 60_000);
});
