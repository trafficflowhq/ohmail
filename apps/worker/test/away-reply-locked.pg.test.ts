import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { bindDb, type Tx } from "@trafficflow/db";
import { makeOwnedDb } from "@trafficflow/db/cloud";
import { dialect } from "@trafficflow/db/dialect";
import {
  lockedQueryGroundAvailable, startLockedQueryGround, type LockedQueryGround,
} from "../../../packages/db/test/_locked-query-ground.js";
import { screenerAutoSuggestPass } from "@ohmail/organizer/screener-auto-suggest";
import { fakeSpendPort } from "../../../packages/organizer/test/_spendport.js";
import { awayReplyCandidatesSql, awayReplyFlagRedeliverPass } from "../src/away-reply-flag-redeliver.js";

const available = lockedQueryGroundAvailable("away-reply-locked.pg.test.ts");
const database = "locked_away_replies";
const account = randomUUID();
const other = randomUUID();

describe.skipIf(!available)("away replies in a large mailbox with forced row security", () => {
  let ground: LockedQueryGround;
  let owner: postgres.Sql;
  let worker: postgres.Sql;
  let workerDb: ReturnType<typeof makeOwnedDb>;
  let replyId: string;

  beforeAll(async () => {
    ground = await startLockedQueryGround(import.meta.url, database, "ohmail_worker");
    owner = postgres(ground.ownerUrl, { max: 1, onnotice: () => {} });
    worker = postgres(ground.runtimeUrl, { max: 1, onnotice: () => {} });
    workerDb = makeOwnedDb(ground.runtimeUrl);
    const [policy] = await worker<{ active: boolean }[]>`
      select pg_catalog.row_security_active('public.messages') as active`;
    expect(policy?.active).toBe(true);

    const suffix = String.fromCharCode(64) + "fixture.invalid";
    await owner`insert into accounts (id) values (${account}), (${other})`;
    const [mailbox] = await owner<{ id: string }[]>`insert into mailboxes (account_id, provider, address)
      values (${account}, 'imap', ${"mailbox" + suffix}) returning id`;
    await owner`insert into messages (account_id, mailbox_id, body_hash, dedup_key, from_address, snippet)
      select ${account}, ${mailbox!.id}, 'fixture', i::text,
        case when i % 100 = 0 then 'Mailbox' else 'Bulk' || (i % 8192) end || ${suffix},
        repeat(md5(i::text), 16)
      from generate_series(1, 400000) as i`;
    const [reply] = await owner<{ id: string }[]>`
      select id from messages where account_id = ${account} and dedup_key = '13000'`;
    replyId = reply!.id;
    await owner`insert into message_bodies (account_id, message_id, headers)
      select account_id, id, case when id = ${replyId} then
        '{"auto-submitted":["auto-replied"]}'::jsonb else '{"auto-submitted":["no"]}'::jsonb end
      from messages where account_id = ${account} and dedup_key::int % 5 = 0`;
    await owner`with mailbox as (
        insert into mailboxes (account_id, provider, address)
        values (${other}, 'imap', ${"mailbox" + suffix}) returning id
      ), letter as (
        insert into messages (account_id, mailbox_id, body_hash, dedup_key, from_address)
        select ${other}, id, 'fixture', 'reply', ${"mailbox" + suffix} from mailbox returning id
      )
      insert into message_bodies (account_id, message_id, headers)
      select ${other}, id, '{"auto-submitted":["auto-replied"]}'::jsonb from letter`;
    await owner`analyze messages`;
    await owner`analyze message_bodies`;
  }, 180_000);

  afterAll(async () => {
    await workerDb?.close();
    await worker?.end({ timeout: 2 });
    await owner?.end({ timeout: 2 });
    await ground?.close();
  });

  it("re-delivers the responder's reply within the read budget", async () => {
    const db = bindDb(workerDb.db, { account }) as unknown as Tx;
    const started = performance.now();
    const result = await awayReplyFlagRedeliverPass(db, { accountId: account });
    const elapsed = performance.now() - started;
    expect(result).toEqual({ examined: 1, redelivered: 1, exhausted: true, cursor: null });
    const changes = await owner`select account_id, entity_id from change_log`;
    expect(changes).toEqual([{ account_id: account, entity_id: replyId }]);

    const d = dialect(db);
    const plan = await d.exec(db, sql`explain (analyze, buffers, format json)
      ${awayReplyCandidatesSql(d, account, null)}`);
    type PlanNode = { "Relation Name"?: string; "Actual Loops": number; Plans?: PlanNode[] };
    const visit = (node: PlanNode): PlanNode[] => [node, ...(node.Plans ?? []).flatMap(visit)];
    const nodes = visit((plan[0]?.[0] as [{ Plan: PlanNode }])[0].Plan);
    const bodyReads = nodes.filter((node) => node["Relation Name"] === "message_bodies");
    expect(bodyReads).toHaveLength(1);
    expect(bodyReads[0]?.["Actual Loops"]).toBe(4000);

    const dir = process.env.TF_MAIL_QUERY_PLANS;
    if (dir) {
      console.info(`away reply benchmark: ${elapsed.toFixed(1)} ms through the pass`);
      writeFileSync(resolve(dir, "away-reply-worker.json"),
        JSON.stringify(plan, null, 2).replace(/[\w.+-]+@[\w.-]+/g, "[fixture]"));
    }
    expect(elapsed, "away reply duration in milliseconds").toBeLessThan(500);
  }, 180_000);

  it("honors a queued suggestion retry from before opt-in under row security", async () => {
    const id = randomUUID();
    const optedInAt = new Date("2025-12-20T00:00:00Z");
    const createdAt = new Date("2025-12-10T00:00:00Z");
    await owner`insert into accounts (id) values (${id})`;
    await owner`insert into account_settings (account_id, auto_suggest_at) values (${id}, ${optedInAt})`;
    const [mailbox] = await owner<{ id: string }[]>`insert into mailboxes
      (account_id, provider, address, organizer_role)
      values (${id}, 'imap', 'retry-mailbox@example.test', 'organizer') returning id`;
    const [message] = await owner<{ id: string }[]>`insert into messages
      (account_id, mailbox_id, body_hash, dedup_key, from_address, date, created_at, unread)
      values (${id}, ${mailbox!.id}, 'fixture', 'retry', 'retry-sender@example.test', ${createdAt}, ${createdAt}, true)
      returning id`;
    await owner`insert into folder_state (account_id, message_id, desired_folder, observed_folder, last_set_by, reconcile_status)
      values (${id}, ${message!.id}, 'ohmail/Screener', 'ohmail/Screener', 'external', 'settled')`;
    await owner`insert into message_instances (account_id, mailbox_id, message_id, folder, uidvalidity, uid, is_primary)
      values (${id}, ${mailbox!.id}, ${message!.id}, 'ohmail/Screener', 1, 1, true)`;
    await owner`insert into routing_decisions (account_id, message_id, destination, input_provenance, status)
      values (${id}, ${message!.id}, 'ohmail/Screener', 'screener_suggestion_retry', 'retry_due')`;
    const credits = fakeSpendPort();
    credits.budget(0);
    const unreachable = async () => { throw new Error("the test spend port cannot buy a suggestion"); };
    const db = bindDb(workerDb.db, { account: id }) as unknown as Tx;
    const result = await screenerAutoSuggestPass(db, {
      accountId: id, classifier: { classify: unreachable, screen: unreachable }, credits,
      now: () => new Date("2026-01-01T00:00:00Z"),
    });
    expect(result).toMatchObject({ examined: 1, stopped: "out_of_credits" });
  });
});
