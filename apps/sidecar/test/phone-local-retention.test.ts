import { mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ChangeBatch, ImapCapabilities, ImapConfig, MailboxAdapter } from "@trafficflow/core/adapters/imap";
import type { LeaseIo, RawClaimMessage } from "@trafficflow/core/adapters/organizer-lease";
import { startPhoneEngine, type PhoneEngine, type PhoneSqlExecutor, type PhoneSqlRows } from "../src/mobile.js";

/**
 * THE PHONE'S STORE PRUNES ITS CHANGE LOG TOO. The phone runs the same drain over SQLite, so its
 * upkeep runs the same retention in the device store's dialect: rows 40 days old, a relaunch (the
 * pass runs at a launch's first drain), and the floor rises with each entity keeping one row; rows
 * 20 days old all survive. Measured only on the device store (`vitest.sqlite.config.ts`).
 */
const sqlite = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: new (path: string) => {
    exec(sql: string): void;
    close(): void;
    prepare(sql: string): {
      all(...p: unknown[]): unknown[];
      run(...p: unknown[]): unknown;
      columns?(): { column?: string | null; name?: string }[];
    };
  };
};

function nodeExecutor(path: string): PhoneSqlExecutor & { direct: (sql: string, params?: unknown[]) => Record<string, unknown>[] } {
  const raw = new sqlite.DatabaseSync(path);
  let tail: Promise<unknown> = Promise.resolve();
  const serial = <T>(job: () => Promise<T> | T): Promise<T> => {
    const next = tail.then(job, job);
    tail = next.catch(() => undefined);
    return next;
  };
  return {
    async all(sql: string, params: readonly unknown[]): Promise<PhoneSqlRows> {
      return serial(() => {
        const st = raw.prepare(sql);
        const columns = (st.columns ? st.columns() : []).map((c) => c.name ?? c.column ?? "");
        const objects = st.all(...(params as unknown[])) as Record<string, unknown>[];
        return { columns, rows: columns.length > 0 ? objects.map((o) => columns.map((c) => o[c])) : objects.map((o) => Object.values(o)) };
      });
    },
    async run(sql: string, params: readonly unknown[]): Promise<void> {
      return serial(() => { raw.prepare(sql).run(...(params as unknown[])); });
    },
    async batch(statements): Promise<void> {
      return serial(() => {
        raw.exec("BEGIN IMMEDIATE");
        try {
          for (const { sql, params = [] } of statements) raw.prepare(sql).run(...(params as unknown[]));
          raw.exec("COMMIT");
        } catch (err) {
          try { raw.exec("ROLLBACK"); } catch { /* keep the first error */ }
          throw err;
        }
      });
    },
    async close(): Promise<void> { try { raw.close(); } catch { /* already closed */ } },
    direct: (sql, params = []) => raw.prepare(sql).all(...params) as Record<string, unknown>[],
  };
}

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

const ON_DEVICE_STORE = process.env.OHMAIL_EXPECT_DIALECT === "sqlite";
const DAY = 86_400_000;
const open: PhoneEngine[] = [];
afterEach(async () => { while (open.length > 0) await open.pop()!.stop().catch(() => undefined); });

describe.runIf(ON_DEVICE_STORE)("the phone's change log has a retention, on the device store", () => {
  async function phone(ageDays: number) {
    const file = join(mkdtempSync(join(tmpdir(), "ohmail-phone-retention-")), "store.db");
    const lines: string[] = [];
    const launch = async (exec: PhoneSqlExecutor): Promise<PhoneEngine> => {
      const engine = await startPhoneEngine({
        exec,
        imap: { host: "imap.invalid", port: 993, secure: true, auth: { user: "a@b.test", pass: "pw-not-used-password-password" } },
        machineName: "ohmail on a phone", installId: "install-phone-retention",
        adapterFactory: quiet(), log: (event: string) => { lines.push(event); },
      } as Parameters<typeof startPhoneEngine>[0]);
      open.push(engine);
      return engine;
    };
    const first = await launch(nodeExecutor(file));
    await first.stop();
    const exec = nodeExecutor(file);
    const acct = String(exec.direct("select account_id from mailboxes limit 1")[0]!.account_id);
    const old = Date.now() - ageDays * DAY;
    exec.direct("update change_log set created_at = ? where account_id = ?", [old, acct]);
    const top = Number(exec.direct("select coalesce(max(seq), 0) as m from change_log where account_id = ?", [acct])[0]!.m);
    let seq = top;
    for (let e = 0; e < 100; e += 1) {
      for (const op of ["create", "update", "update"]) {
        seq += 1;
        exec.direct(`insert into change_log (account_id, seq, entity_type, entity_id, op, created_at)
          values (?, ?, 'message', ?, ?, ?)`, [acct, seq, `00000000-0000-4000-8000-${String(e).padStart(12, "0")}`, op, old]);
      }
    }
    exec.direct(`insert into account_sync_state (account_id, next_seq) values (?, ?)
      on conflict (account_id) do update set next_seq = excluded.next_seq`, [acct, seq + 1]);
    for (const [k, at] of [["meta-request:old", Date.now() - DAY], ["meta-request:live", Date.now() + DAY]] as const) {
      exec.direct(`insert into idempotency_keys (account_id, key, request_hash, response_status, response_json, expires_at)
        values (?, ?, 'h', 200, '{"applied":true}', ?)`, [acct, k, at]);
    }
    const engine = await launch(exec);
    return { engine, exec, acct, first: top + 1, last: seq, lines };
  }

  it("one drain raises the floor and keeps one row an entity", async () => {
    const p = await phone(40);
    await p.engine.resume();
    const floor = Number(p.exec.direct("select pruned_through_seq as f from account_sync_state where account_id = ?", [p.acct])[0]!.f);
    expect(floor, "the phone's floor never rose: its change log grows for ever").toBeGreaterThan(0);
    const kept = Number(p.exec.direct("select count(*) as n from change_log where account_id = ? and seq between ? and ?",
      [p.acct, p.first, p.last])[0]!.n);
    expect(kept, "the churn below the floor was not compacted on the device store").toBeLessThanOrEqual(101);
    expect(kept).toBeGreaterThanOrEqual(100);
    expect(p.lines, "the pass failed on the device store's dialect").not.toContain("local_retention_failed");
    expect(p.exec.direct("select key from idempotency_keys where account_id = ?", [p.acct]).map((r) => r.key),
      "the device store keeps every request key it ever claimed").toEqual(["meta-request:live"]);
  }, 60_000);

  it("rows inside the grace all survive the same drain", async () => {
    const p = await phone(20);
    await p.engine.resume();
    const floor = Number(p.exec.direct("select pruned_through_seq as f from account_sync_state where account_id = ?", [p.acct])[0]!.f);
    expect(floor).toBe(0);
    const kept = Number(p.exec.direct("select count(*) as n from change_log where account_id = ? and seq >= ?", [p.acct, p.first])[0]!.n);
    expect(kept).toBe(300);
    expect(p.lines).not.toContain("local_retention_failed");
  }, 60_000);
});
