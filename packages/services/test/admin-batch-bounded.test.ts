import { describe, expect, it } from "vitest";
import { makeTestDb } from "@trafficflow/db/testing";
import { accounts, accountStorage, mailboxes, users } from "@trafficflow/db";
import { mailboxStorageStats } from "@trafficflow/db/cloud";
import {
  adminAccountDetail, adminAccounts, adminAccountsByIds, adminStorage, type AdminDb,
} from "../src/admin-service.js";

/**
 * THE BATCH AND THE ACCOUNT PAGE READ ONLY THE ACCOUNTS ASKED FOR. Both loaded the whole roster
 * (every account, every login, every mailbox) to answer for at most a hundred ids. Every
 * statement a call issues is recorded at the database client; each one over `accounts`, `users`
 * or `mailboxes` must carry a WHERE bound by an asked id. The paged roster is the control: it
 * ranks every account, so it does read them all, and the recorder sees it.
 */

const NOW = new Date("2026-10-01T08:00:00.000Z");
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";

type Db = Awaited<ReturnType<typeof makeTestDb>>;
interface Statement { text: string; params: unknown[] }
type Query = (text: unknown, params?: unknown, ...rest: unknown[]) => Promise<unknown>;

/** Every statement the PGlite client receives while `run` executes, with its parameters. */
async function recorded<T>(db: Db, run: () => Promise<T>): Promise<{ value: T; statements: Statement[] }> {
  const client = (db as unknown as { $client: { query: Query } }).$client;
  const original = client.query;
  const statements: Statement[] = [];
  client.query = (text, params, ...rest) => {
    statements.push({ text: String(text), params: Array.isArray(params) ? params : [] });
    return original.call(client, text, params, ...rest);
  };
  try {
    return { value: await run(), statements };
  } finally {
    client.query = original;
  }
}

const ROSTER_TABLE = /\bfrom "(accounts|users|mailboxes)"/;

/** The statements over the roster tables that no asked id bounds. */
function unbounded(statements: readonly Statement[], asked: readonly string[]): string[] {
  return statements
    .filter((s) => ROSTER_TABLE.test(s.text))
    .filter((s) => !/\bwhere\b/.test(s.text) || !s.params.some((p) => asked.includes(String(p))))
    .map((s) => s.text.replace(/\s+/g, " ").slice(0, 200));
}

async function world(): Promise<Db> {
  const db = await makeTestDb();
  const day = (n: number): Date => new Date(NOW.getTime() - n * 86_400_000);
  await db.insert(accounts).values([
    { id: A, name: "Acme", createdAt: day(30) },
    { id: B, name: "Beta", createdAt: day(20) },
    { id: C, name: "Gamma", createdAt: day(10) },
  ]);
  await db.insert(users).values([
    { accountId: A, email: "owner@acme.example", createdAt: day(30) },
    { accountId: B, email: "owner@beta.example", createdAt: day(20) },
    { accountId: C, email: "owner@gamma.example", createdAt: day(10) },
  ]);
  await db.insert(mailboxes).values([
    { accountId: A, provider: "imap", address: "a@acme.example", status: "connected", lastSyncAt: day(1) },
    { accountId: B, provider: "imap", address: "b@beta.example", status: "error" },
    { accountId: C, provider: "imap", address: "c@gamma.example", status: "connected", syncBlockedReason: "account_closed", syncBlockedSince: day(2) },
  ]);
  return db;
}

describe("the batch by id and the account page are bounded by the ids asked", () => {
  it("the batch issues no statement over the roster tables that the asked ids do not bound", async () => {
    const db = await world();
    const { value, statements } = await recorded(db, () =>
      adminAccountsByIds(db as unknown as AdminDb, NOW, [C, A], { roles: ["owner"] }));
    expect(value.rows.map((r) => r.id)).toEqual([C, A]);
    expect(statements.some((s) => ROSTER_TABLE.test(s.text)), "the recorder saw the roster reads").toBe(true);
    expect(unbounded(statements, [A, C])).toEqual([]);
    expect(JSON.stringify(statements.map((s) => s.params))).not.toContain(B);
  });

  it("the account page reads its own account and nobody else's", async () => {
    const db = await world();
    const { value, statements } = await recorded(db, () => adminAccountDetail(db as unknown as AdminDb, NOW, B, { roles: ["owner"] }));
    expect(value?.account.id).toBe(B);
    expect(value?.account.mailboxesInError).toBe(1);
    expect(unbounded(statements, [B])).toEqual([]);
  });

  it("an id that is not a uuid reaches no statement, and an ask with none issues no roster read", async () => {
    const db = await world();
    const { value, statements } = await recorded(db, () =>
      adminAccountsByIds(db as unknown as AdminDb, NOW, ["not-an-id"], { roles: ["owner"] }));
    expect(value).toMatchObject({ rows: [], unknownIds: ["not-an-id"] });
    expect(statements.filter((s) => ROSTER_TABLE.test(s.text))).toEqual([]);
  });

  it("answers the rows the paged roster answers for the same accounts", async () => {
    const db = await world();
    const page = await adminAccounts(db as unknown as AdminDb, NOW, { pageSize: 100 }, { roles: ["owner"] });
    const batch = await adminAccountsByIds(db as unknown as AdminDb, NOW, [A, B, C], { roles: ["owner"] });
    const byId = new Map(page.accounts.map((a) => [a.id, a]));
    expect(batch.rows).toEqual([A, B, C].map((id) => byId.get(id)));
  });

  it("CONTROL: the paged roster ranks every account, and the recorder sees the unbounded read", async () => {
    const db = await world();
    const { statements } = await recorded(db, () => adminAccounts(db as unknown as AdminDb, NOW, {}, { roles: ["owner"] }));
    expect(unbounded(statements, [A, B, C]).some((s) => /from "accounts"/.test(s))).toBe(true);
  });
});

describe("the storage page reads the snapshot of its own page's accounts, once (cloud 0057)", () => {
  const SNAPSHOT = /\bfrom "mailbox_storage_stats"/;
  const MAIL_TABLES = /\b(messages|message_bodies|message_instances)\b/;

  /** Three measured accounts, two mailboxes each, 10 letters a mailbox imported whole. */
  async function measured(): Promise<Db> {
    const db = await world();
    await db.insert(accountStorage).values([A, B, C].map((accountId) => ({ accountId, bytes: 100 })));
    await db.insert(mailboxStorageStats).values([A, B, C].flatMap((accountId, i) => [1, 2].map((n) => ({
      accountId, mailboxId: `aaaaaaaa-0000-4000-8000-0000000000${i}${n}`, letters: 10, textLetters: 10, emptied: 0,
      textBytes: 250_000, instances: 10, serverLetters: 10, counted: true, imported: true, at: NOW,
    }))));
    return db;
  }

  it("one statement over the snapshot per page, bound by the page's accounts, and none over the mail tables", async () => {
    const db = await measured();
    const first = await recorded(db, () => adminStorage(db as unknown as AdminDb, NOW, null, 2));
    expect(first.value.rows.map((r) => [r.accountId, r.expectedLetters])).toEqual([[A, 20], [B, 20]]);
    const reads = first.statements.filter((s) => SNAPSHOT.test(s.text));
    expect(reads).toHaveLength(1);
    expect(reads[0]!.text).toMatch(/\bwhere\b/);
    expect(JSON.stringify(reads[0]!.params)).toContain(A);
    expect(JSON.stringify(reads[0]!.params)).toContain(B);
    expect(JSON.stringify(reads[0]!.params)).not.toContain(C);
    expect(first.statements.filter((s) => MAIL_TABLES.test(s.text))).toEqual([]);

    const second = await recorded(db, () => adminStorage(db as unknown as AdminDb, NOW, first.value.nextCursor, 2));
    expect(second.value.rows.map((r) => [r.accountId, r.expectedLetters])).toEqual([[C, 20]]);
    const more = second.statements.filter((s) => SNAPSHOT.test(s.text));
    expect(more).toHaveLength(1);
    expect(JSON.stringify(more[0]!.params)).toContain(C);
    expect(JSON.stringify(more[0]!.params)).not.toMatch(new RegExp(`${A}|${B}`));
  });
});
