/* @postpush: alone — it makes two databases of its own, one of them walked along the 1.0 road. */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { folderState, mailboxes, messageBodies, messages } from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import { NOTHING_OPENS, ensureSearchExtensions, migrateToOldHeads, retireOldSearch, runMigrations } from "@trafficflow/db/admin";
import {
  MIGRATED_DB_SETUP_BUDGET_MS, MIGRATED_DB_TEARDOWN_BUDGET_MS, realPgAvailable, throwawayDb,
} from "@trafficflow/db/testing";
import { upsertMessageSearch } from "@trafficflow/core/mail";
import { SearchService } from "@trafficflow/services";
import type { ServiceContext } from "@trafficflow/services";

/**
 * THE ARM FOR LETTERS WITHOUT A SEARCH DOCUMENT IS PLANNED BY A FACT OF THE STORE. It names two
 * columns that mail 0200 drops wherever no letter is found by them alone, so a store made from
 * empty has neither. There, an account whose index is not stamped built yet (every account, until
 * the worker's pass comes round) must still get its answer from the documents its letters carry.
 * Where the columns stand, the arm goes on reading the letters that have no document.
 */
const PG_UP = await realPgAvailable();
const NOW = new Date("2026-11-14T12:00:00.000Z");
const fresh = throwawayDb("search_fact_fresh");
const standing = throwawayDb("search_fact_standing");

const ctxOf = (db: unknown, accountId: string): ServiceContext =>
  ({ db: db as never, accountId, userId: null, now: () => NOW, requestId: "search-store-fact" });

describe.skipIf(!PG_UP)("a store made from empty: no old columns", () => {
  let client: ReturnType<typeof postgres>;
  let db: ReturnType<typeof brandDialect>;
  const A = randomUUID();
  const ids: string[] = [];

  beforeAll(async () => {
    await fresh.createFromTemplate();
    client = postgres(fresh.url, { max: 2, onnotice: () => { /* quiet */ } });
    db = brandDialect(drizzle(client, { schema }), "pg");
    await ensureSearchExtensions(db as never, { concurrently: false });
    const d = db as unknown as ReturnType<typeof drizzle<typeof schema>>;
    const [mb] = await d.insert(mailboxes).values({ accountId: A, provider: "imap", address: "fact@sf.example" }).returning();
    for (const [i, word] of ["heron", "bittern"].entries()) {
      const [m] = await d.insert(messages).values({
        accountId: A, mailboxId: mb!.id, bodyHash: "h", dedupKey: `sf:${randomUUID()}`, subject: `a ${word} sighting`,
        fromAddress: "watcher@sf.example", date: new Date(NOW.getTime() - i * 60_000), nativeLocator: { folder: "INBOX", ref: `1:${i}` },
      }).returning();
      await d.insert(messageBodies).values({ messageId: m!.id, accountId: m!.accountId, text: `a ${word} stood by the reedbed` });
      await d.insert(folderState).values({ messageId: m!.id, accountId: m!.accountId, desiredFolder: "INBOX", observedFolder: "INBOX", lastSetBy: "us" });
      await upsertMessageSearch(d as never, m!.id, {
        accountId: A, subject: `a ${word} sighting`, from: { name: null, address: "watcher@sf.example" }, to: [], cc: [],
        attachmentNames: [], bodyText: `a ${word} stood by the reedbed`, source: "text",
      });
      ids.push(m!.id);
    }
  }, MIGRATED_DB_SETUP_BUDGET_MS);
  afterAll(async () => {
    await client?.end({ timeout: 5 });
    await fresh.drop();
  }, MIGRATED_DB_TEARDOWN_BUDGET_MS);

  it("the store has neither column", async () => {
    const cols = await client`select 1 from information_schema.columns where table_schema = 'public' and column_name in ('body_tsv', 'subject_tsv')`;
    expect(cols).toHaveLength(0);
  });

  it("an account whose index is not stamped built finds its letters by their documents: a body word, a subject word", async () => {
    const svc = new SearchService();
    const body = await svc.search(ctxOf(db, A), { q: "reedbed" });
    expect(body.items.map((m) => m.id).sort()).toEqual([...ids].sort());
    const subject = await svc.search(ctxOf(db, A), { q: "bittern" });
    expect(subject.items.map((m) => m.id)).toEqual([ids[1]]);
  });
});

/**
 * THE RETIREMENT CHANGES NO ANSWER. A store that stood at 1.0.11 with an account whose letters had
 * no search document keeps the old columns through mail 0200, and that account's search reads
 * them. Every query shape answers the same letters before the setup's step, after it while the
 * account is still owed, and, once its documents are built and the old search is gone, through
 * the documents on a handle opened after the step.
 */
describe.skipIf(!PG_UP)("a store that kept the old columns: the same answers before, while and after the old search leaves", () => {
  let client: ReturnType<typeof postgres>;
  let step: ReturnType<typeof postgres>;
  let db: ReturnType<typeof brandDialect>;
  const BUILT = randomUUID();   // every letter has its document, the account its stamp
  const OWED = randomUUID();    // letters from before the documents: its search reads the old columns
  const LETTERS = [
    { subject: "Harbour notes", body: "The lighthouse keeper wrote about the storm." },
    { subject: "Visit", body: "We walked to the lighthouse at dawn, calm sea." },
    { subject: "Insurance from myAXA", body: "Your keeper policy renews in June." },
    { subject: "Weekend", body: "Lighthouses along the coast, a keeper's cottage." },
    { subject: "Lunch", body: "Nothing about the coast here." },
    { subject: "Lanternfish quarterly report", body: "The harbour survey counted 412 fish." },
  ];
  const SHAPES = [
    "lighthouse", "lighthouse keeper", "lighth", '"lighthouse keeper"', "lighthouse -storm", "axa", "lighthuose",
    "lanternfsh", "lanternfsh -survey",
  ];
  const letterOf = new Map<string, number>();
  const owedIds: string[] = [];
  const dateOf = (i: number): Date => new Date(NOW.getTime() - i * 3_600_000);
  const documentOf = (accountId: string, i: number) => ({
    accountId, subject: LETTERS[i]!.subject, from: { name: null, address: `writer${i}@vector.example` }, to: [], cc: [],
    attachmentNames: [], bodyText: LETTERS[i]!.body, source: "text" as const,
  });
  /** The account's index stamped built. */
  const stampBuilt = (sql: ReturnType<typeof postgres>, accountId: string) => sql`insert into pass_progress (account_id, job, subject_id, done_at)
    values (${accountId}, 'search_index_backfill', ${accountId}, now())
    on conflict (account_id, job, subject_id) do update set done_at = excluded.done_at`;

  /** Every shape's answer, as the letters' places in LETTERS. */
  const answers = async (handle: unknown, accountId: string): Promise<Record<string, number[]>> => {
    const svc = new SearchService();
    const out: Record<string, number[]> = {};
    for (const q of SHAPES) out[q] = (await svc.search(ctxOf(handle, accountId), { q, parts: "page" })).items.map((m) => letterOf.get(m.id)!);
    return out;
  };

  beforeAll(async () => {
    await standing.create(async (url) => {
      await migrateToOldHeads(url);
      const plant = postgres(url, { max: 1, onnotice: () => { /* quiet */ } });
      try {
        await plant`insert into accounts (id, name) values (${OWED}, 'store-fact-owed')`;
        const [mb] = await plant<{ id: string }[]>`insert into mailboxes (account_id, provider, address)
          values (${OWED}, 'imap', 'owed@vector.example') returning id`;
        for (const [i, l] of LETTERS.entries()) {
          const [m] = await plant<{ id: string }[]>`insert into messages (account_id, mailbox_id, body_hash, dedup_key, subject, from_address, date, native_locator)
            values (${OWED}, ${mb!.id}, 'h', ${`sf:${randomUUID()}`}, ${l.subject}, ${`writer${i}@vector.example`}, ${dateOf(i)},
                    ${JSON.stringify({ folder: "INBOX", ref: `1:${i}` })}::jsonb) returning id`;
          await plant`insert into message_bodies (message_id, text) values (${m!.id}, ${l.body})`;
          await plant`insert into folder_state (message_id, desired_folder, observed_folder, last_set_by) values (${m!.id}, 'INBOX', 'INBOX', 'us')`;
          letterOf.set(m!.id, i);
          owedIds.push(m!.id);
        }
      } finally {
        await plant.end({ timeout: 5 });
      }
      // A store at 1.0.11's heads is moved by the transition; this one holds nothing sealed.
      await runMigrations(url, { transition: { kind: "server", openSealed: NOTHING_OPENS } });
    });
    client = postgres(standing.url, { max: 2, onnotice: () => { /* quiet */ } });
    step = postgres(standing.url, { max: 1, onnotice: () => { /* quiet */ } });
    db = brandDialect(drizzle(client, { schema }), "pg");
    await ensureSearchExtensions(db as never, { concurrently: false });
    const d = db as unknown as ReturnType<typeof drizzle<typeof schema>>;
    const [mb] = await d.insert(mailboxes).values({ accountId: BUILT, provider: "imap", address: "built@vector.example" }).returning();
    for (const [i, l] of LETTERS.entries()) {
      const [m] = await d.insert(messages).values({
        accountId: BUILT, mailboxId: mb!.id, bodyHash: "h", dedupKey: `sf:${randomUUID()}`, subject: l.subject,
        fromAddress: `writer${i}@vector.example`, date: dateOf(i), nativeLocator: { folder: "INBOX", ref: `1:${i}` },
      }).returning();
      await d.insert(messageBodies).values({ messageId: m!.id, accountId: m!.accountId, text: l.body });
      await d.insert(folderState).values({ messageId: m!.id, accountId: m!.accountId, desiredFolder: "INBOX", observedFolder: "INBOX", lastSetBy: "us" });
      await upsertMessageSearch(d as never, m!.id, documentOf(BUILT, i));
      letterOf.set(m!.id, i);
    }
    await stampBuilt(client, BUILT);
  }, MIGRATED_DB_SETUP_BUDGET_MS);
  afterAll(async () => {
    await Promise.all([client?.end({ timeout: 5 }), step?.end({ timeout: 5 })]);
    await standing.drop();
  }, MIGRATED_DB_TEARDOWN_BUDGET_MS);

  it("every shape, on a built account and on an owed one", async () => {
    const cols = await client`select 1 from information_schema.columns where table_schema = 'public' and column_name in ('body_tsv', 'subject_tsv')`;
    expect(cols, "mail 0200 kept both columns: six letters are found by them alone").toHaveLength(2);
    const before = { built: await answers(db, BUILT), owed: await answers(db, OWED) };
    for (const who of ["built", "owed"] as const) {
      expect([...before[who].lighthouse!].sort(), `${who}: the body word`).toEqual([0, 1, 3]);
      expect(before[who].axa, `${who}: the substring`).toEqual([2]);
      expect(before[who]["lighthouse -storm"], `${who}: an excluded word`).not.toContain(0);
      // A guess at a subject's word, and the same guess with a word of that letter's body excluded.
      expect(before[who].lanternfsh, `${who}: the guess`).toEqual([5]);
      expect(before[who]["lanternfsh -survey"], `${who}: no guess holds the excluded word`).toEqual([]);
    }

    // The setup's step while the account is owed: the old search is kept, and no answer changes.
    const stepDb = brandDialect(drizzle(step), "pg");
    expect(await retireOldSearch(stepDb, { concurrently: false }))
      .toEqual({ columns: "standing", trigger: "cleared", gin: "kept", owedAccounts: 1, owedLetters: 6 });
    expect({ built: await answers(db, BUILT), owed: await answers(db, OWED) }).toEqual(before);

    // The pass half way: two letters have their documents, four are still read through the old columns.
    const d = db as unknown as ReturnType<typeof drizzle<typeof schema>>;
    for (const i of [0, 1]) await upsertMessageSearch(d as never, owedIds[i]!, documentOf(OWED, i));
    expect(await answers(db, OWED), "during the pass").toEqual(before.owed);

    // The pass builds the rest and stamps the account; the step then takes the old search.
    for (const [i, id] of owedIds.entries()) await upsertMessageSearch(d as never, id, documentOf(OWED, i));
    await stampBuilt(client, OWED);
    expect((await retireOldSearch(stepDb, { concurrently: false })).columns).toBe("gone");

    // A handle opened after the step, as an API started after the setup: both accounts read their documents.
    const later = postgres(standing.url, { max: 2, onnotice: () => { /* quiet */ } });
    try {
      const laterDb = brandDialect(drizzle(later, { schema }), "pg");
      expect(await answers(laterDb, BUILT)).toEqual(before.built);
      expect(await answers(laterDb, OWED), "the owed account's letters, now through their documents").toEqual(before.built);
    } finally {
      await later.end({ timeout: 5 });
    }
  }, 180_000);
});
