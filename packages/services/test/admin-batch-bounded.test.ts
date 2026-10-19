import { describe, expect, it } from "vitest";
import { makeTestDb } from "@trafficflow/db/testing";
import { accounts, mailboxes, users } from "@trafficflow/db";
import {
  adminAccountDetail, adminAccounts, adminAccountsByIds, type AdminDb,
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
