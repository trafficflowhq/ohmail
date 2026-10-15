import { rmSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import type { Tx } from "@trafficflow/db";
import { makeScreenerService, unscreenedSummary } from "@trafficflow/services/mail";
import { openLocalDb, type OpenLocalDb } from "../src/db.js";
import { armFirstPageGate, noteFirstPageServed, resetFirstPageGate } from "../src/first-page-gate.js";
import { PGLITE_STANDUP_BUDGET_MS } from "./pglite-budget.js";
import { freshDataDir } from "./_datadir.js";

vi.setConfig({ testTimeout: PGLITE_STANDUP_BUDGET_MS * 4 });

/**
 * THE SCREENER'S TWO READS COST A PAGE, NOT THE MAILBOX — read off the store's own plans, over a
 * local store shaped like a large one (statistics kept for the search tables, as the store keeps
 * them). `GET /screener/unscreened` walked the Ohbox in pages that each sorted every message of the
 * account, because `mailboxes` was never analyzed; `GET /screener` ran its window twice (page, then
 * total), dated a sender's every message through its folder, and asked the claim probe of senders
 * with no marked mail. All three RED at the base; watched red one at a time: the mailbox look
 * removed from the first page's maintenance, the cutline back to GROUP BY/HAVING, the claim gate
 * removed. The answers themselves are held equal by `screener-reads-same-answer.test.ts`.
 */
const NOW = Date.now();
const DAY = 86_400_000;
const HELD_ACTIVE = 15;
const HELD_RETIRED = 45;
const OLD_PER_SENDER = 6;
const OHBOX = 2_500;

let dir = "";
let o: OpenLocalDb;
let accountId = "";
const rows = (r: unknown): any[] => (Array.isArray(r) ? r : ((r as { rows?: any[] }).rows ?? []));

beforeAll(async () => {
  // The open registers its maintenance with the gate, so the gate is fresh BEFORE it, never between cases.
  resetFirstPageGate();
  dir = await freshDataDir("ohmail-screener-plan-");
  o = await openLocalDb(dir);
  accountId = rows(await o.db.execute(sql`insert into accounts (name) values ('plan') returning id`))[0].id;
  const mailboxId = rows(await o.db.execute(sql`insert into mailboxes (account_id, provider, address, organizer_role)
    values (${accountId}, 'imap', 'plan@mail.example', 'organizer') returning id`))[0].id;
  const insert = async (from: string, folder: string, at: Date, unread: boolean, n: number, tag: string): Promise<void> => {
    // One thread per letter, as the store keeps them.
    await o.db.execute(sql`with t as (insert into threads (account_id) select ${accountId} from generate_series(1, ${n}) returning id),
        n as (select id, row_number() over () as g from t)
      insert into messages (account_id, mailbox_id, thread_id, body_hash, dedup_key, subject, snippet, from_address, date, created_at, unread, to_addresses, cc_addresses, native_locator)
      select ${accountId}, ${mailboxId}, n.id, 'h', ${tag} || ':' || n.g, 'subject ' || n.g, 'snippet', ${from}, ${at.toISOString()}::timestamptz, ${at.toISOString()}::timestamptz, ${unread},
        '[]'::jsonb, '[]'::jsonb, '{"folder":"INBOX","ref":"1:1"}'::jsonb
      from n`);
    await o.db.execute(sql`insert into folder_state (message_id, desired_folder, observed_folder, last_set_by)
      select id, ${folder}, ${folder}, 'us' from messages where dedup_key like ${`${tag}:%`}`);
  };
  // Senders at the gate: some recent and unread, the rest quiet for a year with older mail in the Ohbox.
  for (let s = 0; s < HELD_ACTIVE; s++) await insert(`new${s}@x.test`, "ohmail/Screener", new Date(NOW - DAY), true, 1, `na${s}`);
  for (let s = 0; s < HELD_RETIRED; s++) {
    await insert(`old${s}@x.test`, "ohmail/Screener", new Date(NOW - 400 * DAY), false, 1, `oh${s}`);
    await insert(`old${s}@x.test`, "INBOX", new Date(NOW - 420 * DAY), false, OLD_PER_SENDER, `oi${s}`);
  }
  // An Ohbox of strangers nobody decided about.
  for (let s = 0; s < 50; s++) await insert(`ohbox${s}@y.test`, "INBOX", new Date(NOW - (s + 2) * DAY), false, OHBOX / 50, `ob${s}`);
  // The search tables' statistics, as the store keeps them; `mailboxes` is left as every store had it.
  await o.analyzeSearchIfStale();
});

afterAll(async () => {
  await o?.close().catch(() => undefined);
  if (dir) rmSync(dir, { recursive: true, force: true });
  resetFirstPageGate();
});

/** Every statement the store's handle is given while `fn` runs. */
async function recorded(fn: () => Promise<unknown>): Promise<Array<{ text: string; params: unknown[] }>> {
  const seen: Array<{ text: string; params: unknown[] }> = [];
  const client = (o.db as unknown as { $client: { query: (...a: unknown[]) => Promise<unknown> } }).$client;
  const orig = client.query;
  client.query = function (this: unknown, text: unknown, params?: unknown, ...rest: unknown[]) {
    seen.push({ text: String(text), params: Array.isArray(params) ? params : [] });
    return orig.call(this, text, params, ...rest);
  };
  try { await fn(); } finally { client.query = orig; }
  return seen;
}

interface PlanNode { "Node Type": string; Alias?: string; "Actual Rows": number; "Actual Loops": number; Plans?: PlanNode[] }
async function plan(s: { text: string; params: unknown[] }): Promise<PlanNode> {
  const r = rows(await (o.db as any).$client.query(`explain (analyze, format json) ${s.text}`, s.params));
  const doc = Object.values(r[0])[0] as unknown;
  return (typeof doc === "string" ? JSON.parse(doc) : doc as any)[0].Plan as PlanNode;
}
function nodes(p: PlanNode): PlanNode[] {
  return [p, ...(p.Plans ?? []).flatMap(nodes)];
}
const reltuples = async (table: string): Promise<number> =>
  Number(rows(await o.db.execute(sql`select reltuples::float8 as rt from pg_class where relname = ${table}`))[0]?.rt);

describe("the Screener's reads, by plan", () => {
  it("the Ohbox offer's walk is planned for the Ohbox it has, once the first page has been served", async () => {
    /* The page asks for 200 of the candidates in id order. Planned for a few hundred, it took the
       whole account's mail and sorted it for every page (74k: ~130 ms a page); planned for the
       Ohbox it has, it walks the candidates in order (8 ms). The planner's own estimate of the
       candidates, against their count, is what decided it. */
    const estimate = async (): Promise<{ planned: number; found: number }> => {
      const seen = await recorded(() => unscreenedSummary(o.db as unknown as Tx, accountId));
      const walk = seen.find((s) => /from "folder_state" inner join "messages"/.test(s.text) && /limit \$\d+$/.test(s.text.trim()));
      expect(walk, "the walk's page statement was not seen").toBeDefined();
      const all = `select count(*) from (${walk!.text.trim().replace(/ limit \$\d+$/, "")}) q`;
      const params = walk!.params.slice(0, -1);
      const client = (o.db as unknown as { $client: { query: (t: string, p: unknown[]) => Promise<unknown> } }).$client;
      const doc = Object.values(rows(await client.query(`explain (format json) ${all}`, params))[0])[0] as unknown;
      const top = (typeof doc === "string" ? JSON.parse(doc) : doc as any)[0].Plan as { Plans: Array<{ "Plan Rows": number }> };
      const found = Number(Object.values(rows(await client.query(all, params))[0])[0]);
      return { planned: top.Plans[0]!["Plan Rows"], found };
    };
    // Control: as every store had it, the planner expected a sliver of the Ohbox.
    expect(await reltuples("mailboxes"), "the fixture starts with mailboxes never analyzed").toBeLessThan(0);
    const before = await estimate();
    expect(before.found, "the fixture holds an Ohbox").toBeGreaterThanOrEqual(OHBOX);
    expect(before.planned, "the control reproduces the misestimate").toBeLessThan(before.found / 4);
    armFirstPageGate();
    noteFirstPageServed();
    await vi.waitFor(async () => expect(await reltuples("mailboxes")).toBeGreaterThanOrEqual(0), { timeout: 20_000 });
    const after = await estimate();
    expect(after.found).toBe(before.found);
    expect(after.planned, "the walk is still planned for a sliver of the Ohbox").toBeGreaterThanOrEqual(after.found / 2);
  });

  it("GET /screener reads the held window once, page and total together", async () => {
    const seen = await recorded(() => makeScreenerService({}).list({
      db: o.db as never, accountId, userId: null, now: () => new Date(NOW), requestId: "plan",
    } as never, {}));
    // The held window is the statement carrying `sender_marked`; it ran once, the total inside it.
    expect(seen.filter((s) => /"sender_marked"/.test(s.text)).length).toBe(1);
  });

  it("the cutline dates a message before it reads its folder, and the claim probe asks only marked senders", async () => {
    const seen = await recorded(async () => {
      const out = await makeScreenerService({}).list({
        db: o.db as never, accountId, userId: null, now: () => new Date(NOW), requestId: "plan",
      } as never, {});
      expect(out.total, "the active senders wait, the quiet ones are retired").toBe(HELD_ACTIVE);
    });
    const page = seen.find((s) => /"sender_marked"/.test(s.text) && /limit \$\d+/.test(s.text));
    expect(page, "the page's statement was not seen").toBeDefined();
    const all = nodes(await plan(page!));
    // Folder rows the cutline read: one per active sender (the probe stops there), none for a quiet one.
    const folderReads = all.filter((n) => n.Alias === "fsc").reduce((t, n) => t + n["Actual Rows"] * n["Actual Loops"] + n["Actual Loops"], 0);
    expect(folderReads, "the cutline read the folder of every message of every sender").toBeLessThanOrEqual(4 * HELD_ACTIVE);
    // Nobody here is marked, so the claim's probe has nobody to ask.
    const claimLoops = all.filter((n) => n.Alias === "hm").reduce((t, n) => t + n["Actual Loops"], 0);
    expect(claimLoops, "the claim probe ran for unmarked senders").toBe(0);
  });
});
