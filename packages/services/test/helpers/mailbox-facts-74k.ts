import { sql } from "drizzle-orm";
import { accounts, mailboxes } from "@trafficflow/db";
import { makeMailboxService, type MailboxDTO, type ServiceContext } from "@trafficflow/services";
import type { Db } from "./mailbox-facts-seed.js";

/**
 * GET /mailboxes at 74k, the fixture of `mailbox-facts-budget.test.ts` and its real-Postgres twin.
 *
 * The caller holds a synthetic mailbox of 74k rows with 15 outstanding filings and one of 0.2k rows
 * with 3; a neighbour account holds 20k rows and 5k outstanding filings, so a read that loses
 * the caller's account reads the neighbour's filings and shows up in the budget. Message `g` of a
 * mailbox is outstanding when `g <= k`, and `g % 3` picks its shape: 0 stuck (refused twice, an
 * hour old, due), 1 deferred an hour, 2 fresh and due. The same rows on every store and every run.
 */

export const NOW = new Date("2026-10-21T10:00:00.000Z");
const id = (tail: string): string => `00000000-0000-4000-8000-${tail.padStart(12, "0")}`;
export const MINE = id("100");
export const THEIRS = id("200");
export const BIG = id("101");
export const SMALL = id("102");
const TMB = id("201");

/** The filing statement's budget on Postgres: buffers, and rows visited per table. */
export const BUDGET = { buffers: 2_000, folderState: 200, messages: 200 } as const;

const HOUR = 3_600_000;
const MIN = 60_000;

async function seedMailbox(
  db: Db, sqlite: boolean, account: string, mailbox: string, n: number, k: number, tag: string,
): Promise<void> {
  if (sqlite) {
    const t = NOW.getTime();
    await db.run(sql`with recursive g(n) as (select 1 union all select n + 1 from g where n < ${n})
      insert into messages (account_id, mailbox_id, dedup_key, body_hash)
      select ${account}, ${mailbox}, 'mid:<' || ${tag} || '-' || n || '@example.test>', 'm-' || n from g`);
    await db.run(sql`insert into folder_state (message_id, desired_folder, observed_folder, last_set_by, reconcile_status,
        updated_at, attempts, next_attempt_at, last_error_class)
      select id,
        case when g <= ${k} then 'ohmail/News' else 'Archive' end,
        case when g <= ${k} then 'INBOX' else 'Archive' end,
        'us',
        case when g <= ${k} then 'pending' else 'reconciled' end,
        case when g <= ${k} and g % 3 = 0 then ${t - HOUR} when g <= ${k} then ${t - MIN} else ${t - 720 * HOUR} end,
        case when g <= ${k} and g % 3 = 0 then 2 when g <= ${k} and g % 3 = 1 then 1 else 0 end,
        case when g <= ${k} and g % 3 = 1 then ${t + HOUR} when g <= ${k} and g % 3 = 0 then ${t - MIN} else null end,
        case when g <= ${k} and g % 3 = 0 then 'read_only' when g <= ${k} and g % 3 = 1 then 'no_such_folder' else null end
      from (select id, cast(substr(body_hash, 3) as integer) as g from messages where mailbox_id = ${mailbox})`);
    return;
  }
  const now = NOW.toISOString();
  await db.execute(sql`insert into messages (account_id, mailbox_id, dedup_key, body_hash)
    select ${account}::uuid, ${mailbox}::uuid, 'mid:<' || ${tag} || '-' || g || '@example.test>', 'm-' || g
      from generate_series(1, ${n}::int) g`);
  await db.execute(sql`insert into folder_state (message_id, desired_folder, observed_folder, last_set_by, reconcile_status,
      updated_at, attempts, next_attempt_at, last_error_class)
    select id,
      case when g <= ${k}::int then 'ohmail/News' else 'Archive' end,
      case when g <= ${k}::int then 'INBOX' else 'Archive' end,
      'us',
      case when g <= ${k}::int then 'pending' else 'reconciled' end,
      case when g <= ${k}::int and g % 3 = 0 then ${now}::timestamptz - interval '1 hour'
           when g <= ${k}::int then ${now}::timestamptz - interval '1 minute'
           else ${now}::timestamptz - interval '30 days' end,
      case when g <= ${k}::int and g % 3 = 0 then 2 when g <= ${k}::int and g % 3 = 1 then 1 else 0 end,
      case when g <= ${k}::int and g % 3 = 1 then ${now}::timestamptz + interval '1 hour'
           when g <= ${k}::int and g % 3 = 0 then ${now}::timestamptz - interval '1 minute' else null end,
      case when g <= ${k}::int and g % 3 = 0 then 'read_only' when g <= ${k}::int and g % 3 = 1 then 'no_such_folder' else null end
    from (select id, substr(body_hash, 3)::int as g from messages where mailbox_id = ${mailbox}::uuid) s`);
}

/** The fixture; `analyze`d, so the planner sees it as a store that has settled. */
export async function seed74k(db: Db, sqlite: boolean): Promise<void> {
  await db.insert(accounts).values([{ id: MINE, name: "mfb74-mine" }, { id: THEIRS, name: "mfb74-theirs" }]);
  await db.insert(mailboxes).values([
    { id: BIG, accountId: MINE, provider: "imap", address: "big@example.test" },
    { id: SMALL, accountId: MINE, provider: "imap", address: "small@example.test" },
    { id: TMB, accountId: THEIRS, provider: "imap", address: "theirs@example.test" },
  ]);
  await seedMailbox(db, sqlite, MINE, BIG, 74_000, 15, "big");
  await seedMailbox(db, sqlite, MINE, SMALL, 200, 3, "small");
  await seedMailbox(db, sqlite, THEIRS, TMB, 20_000, 5_000, "theirs");
  if (sqlite) await db.run(sql`analyze`);
  else await db.execute(sql`analyze mailboxes, messages, folder_state`);
}

export const svc = makeMailboxService({ installId: "i", lastOrganizerCycleAt: async () => null });
export const ctxOf = (db: Db): ServiceContext => ({ db, accountId: MINE, userId: null, now: () => NOW, requestId: "r" });

/** What the strip must say about the caller's two mailboxes, whatever the store. */
export const EXPECTED_FACTS = [
  {
    id: BIG, pendingMoves: 15,
    filing: {
      due: 10, deferred: 5, oldestPendingAt: "2026-10-21T09:00:00.000Z", nextAttemptAt: "2026-10-21T11:00:00.000Z",
      attempts: 2, lastRefusalClass: "read_only", stuck: 5, stuckSince: "2026-10-21T09:00:00.000Z",
      stuckRefusalClass: "read_only", lastCycleAt: null, asOf: NOW.toISOString(),
    },
  },
  {
    id: SMALL, pendingMoves: 3,
    filing: {
      due: 2, deferred: 1, oldestPendingAt: "2026-10-21T09:00:00.000Z", nextAttemptAt: "2026-10-21T11:00:00.000Z",
      attempts: 2, lastRefusalClass: "read_only", stuck: 1, stuckSince: "2026-10-21T09:00:00.000Z",
      stuckRefusalClass: "read_only", lastCycleAt: null, asOf: NOW.toISOString(),
    },
  },
];

export const factsOf = (rows: MailboxDTO[]) => rows.map((m) => ({ id: m.id, pendingMoves: m.pendingMoves, filing: m.filing }));

/** Median and p90 of `n` timed calls after three warm ones, for the PR's table; never asserted. */
export async function timed(run: () => Promise<unknown>, n = 15): Promise<{ median: number; p90: number }> {
  for (let i = 0; i < 3; i++) await run();
  const t: number[] = [];
  for (let i = 0; i < n; i++) { const a = performance.now(); await run(); t.push(performance.now() - a); }
  t.sort((x, y) => x - y);
  return { median: +t[Math.floor(n / 2)]!.toFixed(2), p90: +t[Math.floor(n * 0.9)]!.toFixed(2) };
}

export interface PlanNode {
  "Node Type": string; "Relation Name"?: string; "Index Name"?: string; "Index Cond"?: string;
  "Actual Rows"?: number; "Actual Loops"?: number; "Rows Removed by Filter"?: number;
  "Rows Removed by Index Recheck"?: number; "Shared Hit Blocks"?: number; "Shared Read Blocks"?: number;
  Plans?: PlanNode[];
}

/** An `explain (analyze, buffers, format json)` read: buffers, rows visited per table, and the scans. */
export function costOf(top: PlanNode): { buffers: number; folderState: number; messages: number; scans: string[] } {
  const out = { buffers: (top["Shared Hit Blocks"] ?? 0) + (top["Shared Read Blocks"] ?? 0), folderState: 0, messages: 0, scans: [] as string[] };
  const walk = (n: PlanNode): void => {
    const t = n["Relation Name"];
    if (t === "folder_state" || t === "messages") {
      const rows = ((n["Actual Rows"] ?? 0) + (n["Rows Removed by Filter"] ?? 0) + (n["Rows Removed by Index Recheck"] ?? 0))
        * (n["Actual Loops"] ?? 1);
      if (t === "folder_state") out.folderState += rows; else out.messages += rows;
      out.scans.push(`${n["Node Type"]} ${t}${n["Index Name"] ? ` using ${n["Index Name"]}` : ""} ${n["Index Cond"] ?? "no index condition"} (${rows} rows)`);
    }
    for (const c of n.Plans ?? []) walk(c);
  };
  walk(top);
  return out;
}

/** The filing statement with the caller's bound on `outstanding_account_id` taken out (a control). */
export function withoutAccountBound(text: string, sqlite: boolean): { text: string; replaced: number } {
  let replaced = 0;
  const re = sqlite ? /"folder_state"\."outstanding_account_id" = \?/g : /"folder_state"\."outstanding_account_id" = (\$\d+)/g;
  const out = text.replace(re, (_m, p: string | undefined) => { replaced += 1; return sqlite ? "? is not null" : `${p}::uuid is not null`; });
  return { text: out, replaced };
}

/** The SQLite plan lines that break the budget: every `folder_state` read is the caller's outstanding range. */
export function sqliteFilingFaults(plan: string[]): string[] {
  return plan.filter((l) => /^SCAN /.test(l)
    || l.includes("messages_account_mailbox_unread_idx")
    || (/\bfolder_state\b/.test(l) && l !== "SEARCH folder_state USING INDEX folder_state_outstanding_idx (outstanding_account_id=?)"));
}
