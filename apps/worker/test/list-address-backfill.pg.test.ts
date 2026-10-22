/* @postpush: alone — a large corpus on a lane database other files share can move their
 * planner statistics (hot-path-reads.pg read red once beside this file's chunk and green alone 3 of 3),
 * and their rows would blur this file's own timing. The post-push driver runs it by itself. */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { and, eq } from "drizzle-orm";
import { brandDialect, carryDialect } from "@trafficflow/db/dialect";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import {
  accountSettings, accounts, applyScreenerDecision, folderState, listAddresses, listBrandsOf, mailboxes, messages, type Tx,
} from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import { listAddressBackfillPass } from "../src/list-address-backfill.js";

/**
 * THE LIST-ADDRESS BACKFILL ON REAL POSTGRES (mail 0150), over a large synthetic corpus:
 * stored messages, a share of them naming a list in `List-Post`, a few of those failing
 * authentication. Every statement runs under a 10 s `statement_timeout` on this file's own
 * connections: the `?|` read over the account's bodies, the composite-key upsert in its fenced
 * chunks and the stamp; and a person's press writing a brand into the JSON column under the
 * rule-key lock, through postgres-js. Scoped to this file's own account and removed afterwards.
 *
 * The corpus insert and the cleanup run on a client of their own with a wider bound: since mail
 * 0154 the insert computes `messages_recipient_keys` per row for its GIN index, and on a loaded
 * CI VM it outran the 10 s meant for the backfill (cancelled at 10.16 s; 11.2-15.2 s for the
 * whole file alone). The 10 s still holds every statement the backfill and the press run.
 */
const AVAILABLE = await realPgAvailable();
const MESSAGES = 100_000;
/** The backfill's own bound, on `sql`. */
const PASS_TIMEOUT_MS = 10_000;
/** The fixture's bound, on `fixture`: 6x the slowest whole-file run (15.2 s), up to the next step. */
const FIXTURE_TIMEOUT_MS = 120_000;

/** A statement timeout (57014) rethrown with the statement's name, its elapsed time and its bound. */
async function named<T>(name: string, budgetMs: number, run: () => Promise<T>): Promise<T> {
  const t0 = performance.now();
  try {
    return await run();
  } catch (e) {
    if ((e as { code?: unknown }).code !== "57014") throw e;
    const ms = Math.round(performance.now() - t0);
    throw new Error(`${name} hit its ${budgetMs} ms statement_timeout after ${ms} ms`, { cause: e });
  }
}

describe.skipIf(!AVAILABLE)("the list-address backfill (Postgres)", () => {
  let db: Tx;
  let sql: ReturnType<typeof postgres>;
  let fixture: ReturnType<typeof postgres>;
  let accountId = "";

  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    sql = postgres(PG_TEST_URL, { max: 4, onnotice: () => {}, connection: { statement_timeout: PASS_TIMEOUT_MS } });
    fixture = postgres(PG_TEST_URL, { max: 1, onnotice: () => {}, connection: { statement_timeout: FIXTURE_TIMEOUT_MS } });
    db = brandDialect(drizzle(sql, { schema }), "pg") as unknown as Tx;
    accountId = randomUUID();
    await db.insert(accounts).values({ id: accountId, name: `lbpg-${accountId.slice(0, 8)}` });
    const [mb] = await db.insert(mailboxes).values({
      accountId, provider: "imap", address: `lbpg-${accountId.slice(0, 8)}@example.test`,
    }).returning();
    // One statement: the rows and their bodies. A list post every 20th row, naming one of 31 lists;
    // a sparse share of rows failed authentication and names an address that must not be recorded.
    const t0 = performance.now();
    await named("the corpus insert", FIXTURE_TIMEOUT_MS, () => fixture`
      with m as (
        insert into messages (account_id, mailbox_id, body_hash, dedup_key, subject, from_address, native_locator, auth_verdict)
        select ${accountId}::uuid, ${mb!.id}::uuid, 'h', 'lbpg:' || g, 'm' || g, 'sender' || g || '@example.test',
               '{"folder":"INBOX","ref":"1:1"}'::jsonb, case when g % 1000 = 0 then 'fail' end
          from generate_series(1, ${MESSAGES}) g
        returning id, subject
      )
      insert into message_bodies (message_id, text, headers)
      select id, 'x', case
        when substr(subject, 2)::int % 1000 = 0
          then jsonb_build_object('list-post', jsonb_build_array('<mailto:forged' || (substr(subject, 2)::int % 7) || '@lists.test>'))
        when substr(subject, 2)::int % 20 = 0
          then jsonb_build_object('list-post', jsonb_build_array('<mailto:list' || (substr(subject, 2)::int % 31) || '@lists.test?subject=x>'))
        else '{}'::jsonb end
        from m`);
    process.stderr.write(`list-address-backfill: corpus of ${MESSAGES} inserted in ${Math.round(performance.now() - t0)} ms\n`);
    await db.insert(listAddresses).values({ accountId, address: "list0@lists.test", consentedBrands: ["PostFinance"] });
  }, 300_000);

  afterAll(async () => {
    if (accountId !== "") {
      // Every row this account holds — the press writes rules, contacts and deltas too: the rows keyed
      // by message first, then each base table carrying `account_id`, again while a key refuses one.
      // The account row goes last, so a row left behind fails the cleanup by name.
      const own = fixture`(select id from messages where account_id = ${accountId}::uuid)`;
      await fixture`delete from folder_state where message_id in ${own}`;
      await fixture`delete from message_bodies where message_id in ${own}`;
      let left = (await fixture`select c.table_name as t from information_schema.columns c
        join information_schema.tables b on b.table_schema = c.table_schema and b.table_name = c.table_name
        where c.table_schema = 'public' and c.column_name = 'account_id' and b.table_type = 'BASE TABLE'`)
        .map((r) => String(r.t));
      for (let pass = 0; left.length > 0 && pass < 6; pass += 1) {
        const refused: string[] = [];
        for (const t of left) await fixture`delete from ${fixture(t)} where account_id = ${accountId}::uuid`.catch(() => refused.push(t));
        left = refused;
      }
      await fixture`delete from accounts where id = ${accountId}::uuid`;
    }
    await sql.end({ timeout: 5 });
    await fixture.end({ timeout: 5 });
  }, 300_000);

  it("records the 31 list addresses once under the timeout, keeps a consented brand, and stamps", async () => {
    const pass = () => named("listAddressBackfillPass", PASS_TIMEOUT_MS, () => listAddressBackfillPass(db, { accountId }));
    const r = await pass();
    expect(r).toMatchObject({ ran: true, addresses: 31 });
    const rows = await db.select({ address: listAddresses.address, brands: listAddresses.consentedBrands })
      .from(listAddresses).where(eq(listAddresses.accountId, accountId));
    expect(rows.map((x) => x.address).sort()).toEqual(Array.from({ length: 31 }, (_, i) => `list${i}@lists.test`).sort());
    expect(rows.some((x) => x.address.startsWith("forged")), "a failed authentication named a list").toBe(false);
    expect(listBrandsOf(rows.find((x) => x.address === "list0@lists.test")!.brands)).toEqual(["PostFinance"]);
    const [s] = await db.select({ at: accountSettings.listAddressesScannedAt }).from(accountSettings)
      .where(eq(accountSettings.accountId, accountId));
    expect(s?.at).not.toBeNull();
    expect(await pass()).toEqual({ ran: false, values: 0, addresses: 0 });
  }, 120_000);

  it("a person's press adds its brand to the JSON column once, and a second brand beside it", async () => {
    const [mb] = await db.select({ id: mailboxes.id }).from(mailboxes).where(eq(mailboxes.accountId, accountId));
    await db.update(mailboxes).set({ organizerRole: "organizer" }).where(eq(mailboxes.id, mb!.id));
    const claim = async (brand: string, n: number) => {
      const [m] = await db.insert(messages).values({
        accountId, mailboxId: mb!.id, bodyHash: "h", dedupKey: `lbpg-claim:${brand}:${n}`, subject: "Ihre Karte",
        fromAddress: "list1@lists.test", fromName: brand, senderCheck: "impersonation", senderCheckBrand: brand,
        nativeLocator: { folder: "ohmail/Screener", ref: `9:${n}` },
      }).returning();
      await db.insert(folderState).values({
        messageId: m!.id, desiredFolder: "ohmail/Screener", observedFolder: "ohmail/Screener", lastSetBy: "us",
        reconcileStatus: "reconciled",
      });
    };
    const press = () => (db as unknown as { transaction: <T>(f: (tx: unknown) => Promise<T>) => Promise<T> })
      .transaction((tx) => applyScreenerDecision(carryDialect(db, tx as object) as Tx, {
        accountId, scope: "sender", address: "list1@lists.test", appliedFolder: "INBOX", decision: "yes",
        triggeringActionId: `screener:${randomUUID()}`, now: new Date(), overExisting: "converge", decidedBy: "person",
      }));
    const brands = async () => listBrandsOf((await db.select({ b: listAddresses.consentedBrands }).from(listAddresses)
      .where(and(eq(listAddresses.accountId, accountId), eq(listAddresses.address, "list1@lists.test"))))[0]!.b);
    await claim("PostFinance", 1);
    await press();
    expect(await brands()).toEqual(["PostFinance"]);
    await claim("PostFinance", 2);
    await claim("Swisscom", 3);
    await press();
    expect(await brands()).toEqual(["PostFinance", "Swisscom"]);
  }, 120_000);
});
