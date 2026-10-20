import { rmSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { makeScreenerService } from "@trafficflow/services/mail";
import { openLocalDb, type OpenLocalDb } from "../src/db.js";
import { resetFirstPageGate } from "../src/first-page-gate.js";
import { PGLITE_STANDUP_BUDGET_MS } from "./pglite-budget.js";
import { freshDataDir } from "./_datadir.js";

vi.setConfig({ testTimeout: PGLITE_STANDUP_BUDGET_MS * 4, hookTimeout: PGLITE_STANDUP_BUDGET_MS * 4 });

/**
 * GET /screener DATES A HELD SENDER'S MAIL FROM THE SENDER-DATE INDEX (mail 0157), on the desktop
 * store. With a baseline the cutline probe states its window as a top-level conjunct, so the index on
 * (account, lower(sender), coalesce(date, created_at)) serves it as a range under a custom plan AND a
 * generic one (a named statement after five runs: the ingest lane, the server's prepared statements).
 * Before 0157 the probe read `messages_account_from_addr_idx` and dated every message in a Filter.
 * Without the conjunct the generic plan cannot use the range. Without a baseline there is no range,
 * and the answer is the same.
 */
const NOW = Date.now();
const DAY = 86_400_000;
const QUIET = 600;
const OLD_PER_QUIET = 12;
const ACTIVE = 40;
const OHBOX = 4_000;
const INDEX = "messages_account_sender_date_idx";

let dir = "";
let o: OpenLocalDb;
let accountId = "";
const rows = (r: unknown): any[] => (Array.isArray(r) ? r : ((r as { rows?: any[] }).rows ?? []));
const client = () => (o.db as unknown as { $client: { query: (t: string, p?: unknown[]) => Promise<unknown> } }).$client;
const iso = (ms: number) => new Date(ms).toISOString();

beforeAll(async () => {
  resetFirstPageGate();
  dir = await freshDataDir("ohmail-sender-date-");
  o = await openLocalDb(dir);
  accountId = rows(await o.db.execute(sql`insert into accounts (name) values ('sender-date') returning id`))[0].id;
  const mailboxId = rows(await o.db.execute(sql`insert into mailboxes (account_id, provider, address, organizer_role)
    values (${accountId}, 'imap', 'sd@mail.example', 'organizer') returning id`))[0].id;
  const cols = "account_id, mailbox_id, body_hash, dedup_key, subject, snippet, from_address, date, created_at, unread, to_addresses, cc_addresses, native_locator";
  const tail = `'[]', '[]', '{"folder":"INBOX","ref":"1:1"}'`;
  // Quiet held senders: one held letter a year old, older letters in the Ohbox.
  await client().query(`insert into messages (${cols}) select $1, $2, 'h', 'qh:' || s, 'subject', 'snippet', 'Quiet' || s || '@x.test',
    $3::timestamptz, $3::timestamptz, false, ${tail} from generate_series(1, ${QUIET}) s`, [accountId, mailboxId, iso(NOW - 400 * DAY)]);
  await client().query(`insert into messages (${cols}) select $1, $2, 'h', 'qi:' || s || ':' || k, 'subject', 'snippet', 'quiet' || s || '@x.test',
    $3::timestamptz - k * interval '3 days', $3::timestamptz - k * interval '3 days', false, ${tail}
    from generate_series(1, ${QUIET}) s, generate_series(1, ${OLD_PER_QUIET}) k`, [accountId, mailboxId, iso(NOW - 420 * DAY)]);
  // Active held senders: one unread letter yesterday.
  await client().query(`insert into messages (${cols}) select $1, $2, 'h', 'ah:' || s, 'subject', 'snippet', 'new' || s || '@x.test',
    $3::timestamptz, $3::timestamptz, true, ${tail} from generate_series(1, ${ACTIVE}) s`, [accountId, mailboxId, iso(NOW - DAY)]);
  // An Ohbox of strangers.
  await client().query(`insert into messages (${cols}) select $1, $2, 'h', 'ob:' || g, 'subject', 'snippet', 'ohbox' || (g % 200) || '@y.test',
    $3::timestamptz - (g % 300) * interval '1 day', $3::timestamptz - (g % 300) * interval '1 day', false, ${tail}
    from generate_series(1, ${OHBOX}) g`, [accountId, mailboxId, iso(NOW)]);
  await client().query(`insert into folder_state (message_id, desired_folder, observed_folder, last_set_by)
    select id, f, f, 'us' from (select id, case when dedup_key like 'qh:%' or dedup_key like 'ah:%' then 'ohmail/Screener' else 'INBOX' end as f
      from messages where account_id = $1) q`, [accountId]);
  await client().query(`insert into account_settings (account_id, screening_baseline_at) values ($1, $2::timestamptz)`, [accountId, iso(NOW - 10 * DAY)]);
  await o.analyzeSearchIfStale();
  const n = rows(await client().query(`select count(*)::int as n from messages`))[0].n;
  expect(n).toBeGreaterThanOrEqual(10_000);
});

afterAll(async () => {
  await o?.close().catch(() => undefined);
  if (dir) rmSync(dir, { recursive: true, force: true });
  resetFirstPageGate();
});

async function recorded(fn: () => Promise<unknown>): Promise<Array<{ text: string; params: unknown[] }>> {
  const seen: Array<{ text: string; params: unknown[] }> = [];
  const c = client();
  const orig = c.query;
  c.query = function (this: unknown, text: unknown, params?: unknown, ...rest: unknown[]) {
    seen.push({ text: String(text), params: Array.isArray(params) ? params : [] });
    return (orig as any).call(this, text, params, ...rest);
  } as any;
  try { await fn(); } finally { c.query = orig; }
  return seen;
}

interface PlanNode { [k: string]: any; Plans?: PlanNode[] }
const nodes = (p: PlanNode): PlanNode[] => [p, ...(p.Plans ?? []).flatMap(nodes)];
const planOf = (r: unknown): PlanNode => {
  const doc = Object.values(rows(r)[0])[0] as unknown;
  return (typeof doc === "string" ? JSON.parse(doc) : doc as any)[0].Plan as PlanNode;
};
const lit = (v: unknown): string => v === null || v === undefined ? "NULL"
  : typeof v === "number" ? String(v) : typeof v === "boolean" ? (v ? "true" : "false")
  : `'${String(typeof v === "object" ? JSON.stringify(v) : v).replace(/'/g, "''")}'`;

/** The page statement of GET /screener, its `mc` probe nodes under a custom and a generic plan, and its total. */
async function probe(): Promise<{ custom: PlanNode[]; generic: PlanNode[]; total: number }> {
  let total = -1;
  const seen = await recorded(async () => {
    const out = await makeScreenerService({}).list({
      db: o.db as never, accountId, userId: null, now: () => new Date(NOW), requestId: "sender-date",
    } as never, {});
    total = out.total ?? -1;
  });
  const page = seen.find((s) => /"sender_marked"/.test(s.text) && /limit \$\d+/.test(s.text));
  expect(page, "the page's statement was not seen").toBeDefined();
  const custom = nodes(planOf(await client().query(`explain (analyze, buffers, format json) ${page!.text}`, page!.params)))
    .filter((n) => n.Alias === "mc");
  await client().query(`prepare sender_date_g as ${page!.text}`);
  let generic: PlanNode[] = [];
  try {
    await client().query("set plan_cache_mode = force_generic_plan");
    generic = nodes(planOf(await client().query(
      `explain (analyze, buffers, format json) execute sender_date_g(${page!.params.map(lit).join(", ")})`))).filter((n) => n.Alias === "mc");
  } finally {
    await client().query("reset plan_cache_mode");
    await client().query("deallocate sender_date_g");
  }
  return { custom, generic, total };
}

const ranged = (n: PlanNode) => n["Index Name"] === INDEX && /COALESCE\(date, created_at\) >=/.test(String(n["Index Cond"] ?? ""));
const show = (ns: PlanNode[]) => JSON.stringify(ns.map((n) => ({ index: n["Index Name"], cond: n["Index Cond"], filter: n.Filter })));

describe("GET /screener on the desktop store dates held mail from the sender-date index", () => {
  it("baselined: the probe reads a range of the index under a custom and a generic plan", async () => {
    const { custom, generic, total } = await probe();
    expect(total).toBe(ACTIVE);
    expect(custom.length, "no mc node").toBeGreaterThan(0);
    expect(custom.every(ranged), `custom plan: ${show(custom)}`).toBe(true);
    expect(generic.length, "no mc node").toBeGreaterThan(0);
    expect(generic.every(ranged), `generic plan: ${show(generic)}`).toBe(true);
  });

  it("CONTROL: without a baseline there is no range, and the same senders wait", async () => {
    await client().query("update account_settings set screening_baseline_at = null where account_id = $1", [accountId]);
    try {
      const { custom, generic, total } = await probe();
      expect(total).toBe(ACTIVE);
      expect(custom.length + generic.length).toBeGreaterThan(0);
      expect([...custom, ...generic].some(ranged), `unbaselined: ${show([...custom, ...generic])}`).toBe(false);
    } finally {
      await client().query("update account_settings set screening_baseline_at = $2::timestamptz where account_id = $1", [accountId, iso(NOW - 10 * DAY)]);
    }
  });
});
