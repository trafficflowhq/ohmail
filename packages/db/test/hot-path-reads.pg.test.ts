import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { PgDialect } from "drizzle-orm/pg-core";
import { HOT_PATH_INDEX_SPECS } from "../src/hot-path-indexes.js";
import { runMigrations } from "../src/migrate.js";
import { PG_TEST_URL, realPgAvailable } from "../src/testing.js";

/**
 * EVERY HOT READ A ROW HAS NAMED, EACH ASKED WHETHER IT STILL HAS ITS INDEX.
 *
 * Two rows feed it. The missing-indexes row named four reads on tables that only grow and was
 * worked in three separate landings, so "is it closed?" had to be re-derived from the code every
 * time somebody asked; a backend review named two newest-first `messages` pages. (A database
 * review named a third read, the Screener auto-apply's held page, retired with that pass.) The
 * 2.0 schema's list named one more, whose index mail 0200 changed.
 * This file is the answer, executable: one row per read, naming the read, its source, the row
 * that named it and the index that serves it, asserted by asking the PLANNER on a grown table —
 * not by looking the index up in `pg_indexes`, which passes for an index the planner refuses and
 * fails for a differently-named one that works.
 *
 * THE CONTROL RUNS ON EVERY ROW ON EVERY RUN: the same predicate is planned again with the index
 * dropped inside the same transaction and must come back with the scan or the sort the index
 * removed. A green that cannot be made red is not evidence. `gone` is what the index REMOVES and
 * never the index's own name, because an index can be read FROM and sorted anyway: measured here,
 * a `date desc` (NULLS FIRST) spelling of the index appears in the plan with the Sort still
 * above it, and a name-only assertion would have called that green.
 *
 * WHERE EACH INDEX COMES FROM is part of the row, because they do not all come from the journal:
 * the prebuilt ones are built `CONCURRENTLY` outside the migrator by `ensureHotPathIndexes` (the
 * statement is refused inside a transaction block, and the migrator wraps its pass in one), and
 * one is a journal statement. The prebuilt ones are built here from their OWN shipped spec with
 * only the word `concurrently` removed, so the spec stays the single source and a spec edit
 * reaches this file; that the shipped text really is concurrent is asserted before the word is
 * taken out.
 *
 * Everything happens inside ONE transaction that is rolled back, so no row and no index of this
 * run outlives the case and a co-tenant on the same cluster is neither read nor touched.
 */
const PG_UP = await realPgAvailable();
const ROLLBACK = "hot-path-reads: rolled back on purpose";

let client: ReturnType<typeof postgres>;

/** Enough rows that a sequential scan is the expensive answer on every one of these tables. */
const GROWN = 20_000;

const specOf = (name: string) => {
  const s = HOT_PATH_INDEX_SPECS.find((x) => x.name === name);
  if (s === undefined) throw new Error(`no hot-path spec named ${name} — the census and the specs have drifted`);
  return s;
};

/** The shipped spec's own DDL, with the one word a transaction refuses taken out. */
const buildableDdl = (name: string): string => {
  const text = new PgDialect().sqlToQuery(specOf(name).ddl).sql;
  expect(text.toLowerCase(), `${name}'s shipped DDL is not a concurrent build`)
    .toContain("create index concurrently if not exists");
  return text.replace(/\bconcurrently\b/gi, "");
};

interface HotRead {
  /** What the read is, in the words its own source uses. */
  read: string;
  /** Where it lives — the thing a person greps for when this case goes red. */
  source: string;
  /** The row that named this read. Two rows feed this file; see the header. */
  named: "missing indexes" | "newest-first pages" | "the 2.0 schema";
  /** The index that must serve it, and where that index comes from. */
  index: string;
  from: "the hot-path prebuild" | "the cloud journal" | "the mail journal";
  /** Rows in, subject seeded; returns the exact query to plan. */
  seed: (tx: postgres.TransactionSql) => Promise<string>;
  /** What the plan must NOT contain once the index is there. */
  gone: RegExp;
  /** What the plan MUST contain once the index is there, beyond its name. */
  shows?: RegExp;
}

/**
 * A grown account for the two reads: `messages` with `folder_state` beside it, an UNDATED tail
 * and tombstones, because `nulls last` and the `deleted_at is null` partial predicate are both
 * part of what is being asked. Without the undated rows the `nulls last` clause would be
 * decorative and a NULLS FIRST index would serve the query — the property under test needs a
 * subject that HAS it.
 */
async function grownMailbox(tx: postgres.TransactionSql, label: string): Promise<string> {
  const [acct] = await tx`insert into accounts default values returning id`;
  const id = acct!.id as string;
  const [mb] = await tx`insert into mailboxes (account_id, provider, address)
    values (${id}, 'imap', ${`${label}-${id}@tf.example`}) returning id`;
  await tx.unsafe(
    `insert into messages (account_id, mailbox_id, body_hash, dedup_key, from_address, date, deleted_at)
     select $1::uuid, $2::uuid, 'h', $3 || ':' || g, 'a@x.example',
            case when g % 13 = 0 then null else now() - (g || ' minutes')::interval end,
            case when g % 33 = 0 then now() else null end
       from generate_series(1, ${GROWN}) g`, [id, mb!.id as string, label]);
  await tx.unsafe(
    `insert into folder_state (message_id, account_id, desired_folder, observed_folder, last_set_by)
     select id, account_id, case when (('x' || substr(md5(id::text), 1, 8))::bit(32)::int % 2) = 0
                     then 'INBOX' else 'ohmail/News' end, 'INBOX', 'us'
       from messages where account_id = $1::uuid`, [id]);
  await tx`analyze messages`;
  await tx`analyze folder_state`;
  return id;
}

const READS: readonly HotRead[] = [
  {
    read: "the profile-import already-resolved probe",
    source: "packages/db/src/organizer-profile-import.ts profileImportResolutionExists",
    named: "missing indexes",
    index: "audit_log_account_action_idx",
    from: "the hot-path prebuild",
    gone: /Seq Scan on audit_log/,
    seed: async (tx) => {
      const [acct] = await tx`insert into accounts default values returning id`;
      const mb = "11111111-1111-1111-1111-111111111111";
      await tx.unsafe(
        `insert into audit_log (account_id, action, payload)
         select $1::uuid,
                case when g % 7 = 0 then 'profile_import_resolved' else 'other_' || (g % 5) end,
                jsonb_build_object('mailboxId', $2::text, 'fingerprint', 'fp-' || g)
           from generate_series(1, ${GROWN}) g`, [acct!.id as string, mb]);
      await tx`analyze audit_log`;
      return `select id from audit_log
               where account_id = '${acct!.id}'::uuid and action = 'profile_import_resolved'
                 and payload->>'mailboxId' = '${mb}' and payload->>'fingerprint' = 'fp-13993'
               limit 1`;
    },
  },
  {
    read: "the storage-eviction victim read",
    source: "packages/db/src/storage.ts evictOldestBodies",
    named: "missing indexes",
    index: "messages_account_date_order_idx",
    from: "the hot-path prebuild",
    // The index exists for the ORDER, so the sort is what its absence costs.
    gone: /Sort Key: \(COALESCE/i,
    seed: async (tx) => {
      const [acct] = await tx`insert into accounts default values returning id`;
      const [mb] = await tx`insert into mailboxes (account_id, provider, address)
        values (${acct!.id as string}, 'imap', ${`hot-${acct!.id as string}@tf.example`}) returning id`;
      await tx.unsafe(
        `insert into messages (account_id, mailbox_id, body_hash, dedup_key, from_address, date)
         select $1::uuid, $2::uuid, 'h', 'k:' || g, 'a@x.example', now() - (g || ' minutes')::interval
           from generate_series(1, ${GROWN}) g`, [acct!.id as string, mb!.id as string]);
      await tx.unsafe(
        `insert into message_bodies (message_id, account_id, text) select id, account_id, repeat('x', 200) from messages
          where account_id = $1::uuid`, [acct!.id as string]);
      await tx`analyze messages`;
      await tx`analyze message_bodies`;
      return `select b."id", (octet_length(b."text") + coalesce(octet_length(b."html"), 0))
                from message_bodies b join messages m on m."id" = b."message_id"
               where m."account_id" = '${acct!.id}'::uuid and b."withheld_reason" is null
                 and (octet_length(b."text") > 0 or b."html" is not null)
               order by coalesce(m."date", m."created_at") asc, m."id" asc limit 64`;
    },
  },
  {
    read: "the stuck-send alert read",
    source: "packages/db/src/alerts.ts, the outbound_sends pending rule",
    named: "missing indexes",
    index: "outbound_sends_pending_created_idx",
    from: "the hot-path prebuild",
    gone: /Seq Scan on outbound_sends/,
    seed: async (tx) => {
      const [acct] = await tx`insert into accounts default values returning id`;
      await tx.unsafe(
        `insert into outbound_sends (account_id, idempotency_key, minted_message_id, status, created_at)
         select $1::uuid, 'k:' || g, 'mid:' || g,
                case when g % 20 = 0 then 'pending' else 'sent' end,
                now() - (g || ' seconds')::interval
           from generate_series(1, ${GROWN}) g`, [acct!.id as string]);
      await tx`analyze outbound_sends`;
      return `select count(*)::int as n, min("created_at") as oldest
                from outbound_sends
               where "status" = 'pending' and "created_at" < now() - interval '10 minutes'`;
    },
  },
  {
    read: "the mailboxes' letter counts",
    // Mail 0200 took the read flag out of this index: a flag that flips with every letter read
    // made every index entry of the letter move. The count never read the flag; it reads one
    // account's letters grouped by mailbox, and this is the index kept for that.
    source: "packages/services/src/mailbox-service.ts messageCounts",
    named: "the 2.0 schema",
    index: "messages_account_mailbox_idx",
    from: "the mail journal",
    // What the index removes: the account's letters read off an index kept for another read, or
    // off the table. Other accounts' letters stand beside it, so the account bound is worth an index.
    gone: /Seq Scan on messages|Scan (?:on|using) messages_(?!account_mailbox_idx)\w+/,
    seed: async (tx) => {
      const acct = await grownMailbox(tx, "counts");
      // Nine times as many letters of another account: the account bound is a tenth of the table.
      const [other] = await tx`insert into accounts default values returning id`;
      const [mb] = await tx`insert into mailboxes (account_id, provider, address)
        values (${other!.id as string}, 'imap', ${`counts-other-${other!.id as string}@tf.example`}) returning id`;
      await tx.unsafe(
        `insert into messages (account_id, mailbox_id, body_hash, dedup_key, from_address, date)
         select $1::uuid, $2::uuid, 'h', 'counts-other:' || g, 'a@x.example', now() - (g || ' minutes')::interval
           from generate_series(1, ${9 * GROWN}) g`, [other!.id as string, mb!.id as string]);
      // Eight other indexes lead with the account, and the planner may bound the count by any of
      // them: which it picks turns on their sizes that day. They are set aside for this plan
      // (inside the transaction), so the case reads what THIS index gives the count, and its
      // control what is left without it.
      const peers = await tx<{ n: string }[]>`select indexname::text as n from pg_indexes
        where schemaname = 'public' and tablename = 'messages' and indexname <> 'messages_account_mailbox_idx'
          and indexdef like '%USING btree (account_id%'`;
      for (const p of peers) await tx.unsafe(`drop index public."${p.n}"`);
      await tx`analyze messages`;
      return `select "mailbox_id", count(*)::int as n from messages
               where "account_id" = '${acct}'::uuid and "deleted_at" is null group by "mailbox_id"`;
    },
  },
  {
    read: "the message list page by header date, the order search's History walk reads",
    // The list's own builder walks the arrival index since mail 0139, pinned from the builder
    // itself by `packages/services/test/message-order-arrival.pg.test.ts`; search still walks this one.
    source: "the header-date order (search-service.ts, the History keyset; the pre-0139 list)",
    named: "newest-first pages",
    index: "messages_account_msg_order_idx",
    from: "the hot-path prebuild",
    // What the index removes is the SORT, not a scan: without it every page of every view
    // sorts the account's whole living set to answer for fifty rows.
    gone: /Sort Key: [^\n]*DESC NULLS LAST/i,
    seed: async (tx) => {
      const acct = await grownMailbox(tx, "list");
      return `select m."id", m."date" from messages m
                inner join folder_state fs on fs."message_id" = m."id"
               where m."account_id" = '${acct}'::uuid and fs."desired_folder" = 'INBOX'
                 and m."deleted_at" is null
               order by m."date" desc nulls last, m."id" desc limit 51`;
    },
  },
  {
    read: "a walk of one account's living letters, newest header date first",
    source: "the header-date order without a folder (search-service.ts, the History walk)",
    named: "newest-first pages",
    index: "messages_account_msg_order_idx",
    from: "the hot-path prebuild",
    gone: /Sort Key: [^\n]*DESC NULLS LAST/i,
    seed: async (tx) => {
      const acct = await grownMailbox(tx, "snap");
      return `select m."id", m."date" from messages m
               where m."account_id" = '${acct}'::uuid and m."deleted_at" is null
               order by m."date" desc nulls last, m."id" desc limit 200`;
    },
  },
  {
    read: "the passkey-ceremony consume read",
    source: "packages/services/src/auth/auth-service.ts consumeChallenge",
    named: "missing indexes",
    index: "webauthn_challenges_open_login_idx",
    from: "the cloud journal",
    gone: /Seq Scan on webauthn_challenges/,
    seed: async (tx) => {
      const lt = "22222222-2222-2222-2222-222222222222";
      await tx.unsafe(
        `insert into webauthn_challenges
           (login_token_id, challenge, type, rp_id, origin, expires_at, consumed_at, created_at)
         select gen_random_uuid(), 'ch-' || g, 'authentication', 'ohmail.app', 'https://app.ohmail.app',
                now() + interval '5 minutes',
                case when g % 3 = 0 then now() else null end,
                now() - (g || ' milliseconds')::interval
           from generate_series(1, ${GROWN}) g`);
      await tx.unsafe(
        `insert into webauthn_challenges (login_token_id, challenge, type, rp_id, origin, expires_at)
         values ($1::uuid, 'ch-target', 'authentication', 'ohmail.app', 'https://app.ohmail.app',
                 now() + interval '5 minutes')`, [lt]);
      await tx`analyze webauthn_challenges`;
      return `select * from webauthn_challenges
               where "type" = 'authentication' and "consumed_at" is null
                 and "login_token_id" = '${lt}'::uuid
               order by "created_at" desc limit 1`;
    },
  },
  {
    // The user arm, as the service asks it since cloud 0100: the index leads with the account, so
    // the read names both. A read by the user alone has no leading column to seek on.
    read: "the passkey-ceremony consume read, by the signed-in user",
    source: "packages/services/src/auth/auth-service.ts consumeChallenge",
    named: "the 2.0 schema",
    index: "webauthn_challenges_open_user_idx",
    from: "the cloud journal",
    gone: /Seq Scan on webauthn_challenges/,
    seed: async (tx) => {
      // 200 users of 200 accounts hold the open ceremonies; the read is one more user's.
      await tx.unsafe(
        `with a as (insert into accounts select from generate_series(1, 201) returning id),
              u as (insert into users (account_id, email)
                    select id, 'hot-' || id || '@tf.example' from a returning id, account_id, email)
         insert into webauthn_challenges
           (user_id, account_id, challenge, type, rp_id, origin, expires_at, consumed_at, created_at)
         select u.id, u.account_id, 'ch-' || g, 'authentication', 'ohmail.app', 'https://app.ohmail.app',
                now() + interval '5 minutes',
                case when g % 3 = 0 then now() else null end,
                now() - (g || ' milliseconds')::interval
           from u cross join generate_series(1, ${GROWN / 200}) g`);
      const [mine] = await tx`select user_id, account_id from webauthn_challenges
        where user_id is not null and consumed_at is null order by created_at limit 1`;
      await tx`analyze webauthn_challenges`;
      return `select * from webauthn_challenges
               where "type" = 'authentication' and "consumed_at" is null
                 and "user_id" = '${mine!.user_id as string}'::uuid
                 and "account_id" = '${mine!.account_id as string}'::uuid
               order by "created_at" desc limit 1`;
    },
  },
];

beforeAll(async () => {
  if (!PG_UP) return;
  client = postgres(PG_TEST_URL, { max: 2, onnotice: () => {} });
  await runMigrations(PG_TEST_URL);
}, 180_000);

afterAll(async () => { await client?.end({ timeout: 5 }); });

describe.skipIf(!PG_UP)("every hot read a row has named still has its index", () => {
  it.each(READS.map((r) => [r.read, r] as const))("%s", async (_name, r) => {
    let withIx = "";
    let without = "";
    try {
      await client.begin(async (tx) => {
        const q = await r.seed(tx);
        // The journal already carries its index; a prebuilt one is built here from its own spec.
        // DROPPED FIRST, and that is the whole point of building it from the spec: the shipped
        // DDL says `if not exists`, and `ensureHotPathIndexes` has usually already built the real
        // index into this very database — so without the drop the build is a no-op and every
        // assertion below reads THE LEFTOVER. Measured: a spec mutated to the wrong sort order
        // stayed green, because the plan it was shown came from the correctly-built index that
        // was already there. The drop is inside the transaction, so the real index comes back
        // with the rollback.
        if (r.from === "the hot-path prebuild") {
          await tx.unsafe(`drop index if exists public."${r.index}"`);
          await tx.unsafe(buildableDdl(r.index));
          await tx.unsafe(`analyze ${specOf(r.index).table}`);
        }
        withIx = (await tx.unsafe(`explain (costs off) ${q}`))
          .map((row) => String(row["QUERY PLAN"])).join("\n");
        // `if exists` so a MISSING index is reported by the assertions below, which name the read
        // and where its index comes from, rather than by a raw 42704 from the control itself.
        await tx.unsafe(`drop index if exists public."${r.index}"`);
        without = (await tx.unsafe(`explain (costs off) ${q}`))
          .map((row) => String(row["QUERY PLAN"])).join("\n");
        throw new Error(ROLLBACK);
      });
      throw new Error("the transaction committed — this run's rows are still in the tables");
    } catch (e) {
      if (!(e instanceof Error) || e.message !== ROLLBACK) throw e;
    }

    expect(withIx, `${r.read} (${r.source}) is not planned through ${r.index}, from ${r.from}`)
      .toContain(r.index);
    expect(withIx, `${r.read} still pays for the whole table with ${r.index} present`)
      .not.toMatch(r.gone);
    if (r.shows) expect(withIx, `${r.read} is not the plan its row names`).toMatch(r.shows);
    expect(without, `the control cannot make ${r.read} red — dropping ${r.index} changed no plan`)
      .toMatch(r.gone);
  }, 300_000);

  it("the census covers each row's reads and no index it names is invented", async () => {
    // PER NAMING ROW, not a total: the missing-indexes row named four and the backend review two, and a
    // seventh added here without a row of its own would make one of those counts a lie. A name
    // that no journal and no spec creates would make the whole file fiction.
    const by = (n: HotRead["named"]) => READS.filter((r) => r.named === n).length;
    expect(by("missing indexes")).toBe(4);
    expect(by("newest-first pages")).toBe(2);
    expect(by("the 2.0 schema")).toBe(2);
    expect(READS).toHaveLength(8);
    for (const r of READS) {
      if (r.from === "the hot-path prebuild") { expect(specOf(r.index).name).toBe(r.index); continue; }
      const rows = await client`select indexname from pg_indexes
         where schemaname = 'public' and indexname = ${r.index}`;
      expect(rows, `${r.index} is named as a journal index the journal never creates`).toHaveLength(1);
    }
  }, 60_000);
});
