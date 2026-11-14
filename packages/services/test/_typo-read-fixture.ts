import { expect } from "vitest";
import { sql, type SQL } from "drizzle-orm";
import type { SearchService, ServiceContext } from "@trafficflow/services";

/**
 * THE TYPO READ'S FIXTURE, for both stores' twins (`search-typo-read.pg.test.ts`, the desktop
 * store's `search-typo-read-local.test.ts`): a fixture of many messages with documents built, newest first by
 * `g`. `kestrel` and the less similar `kesterl` each in one subject of ten (dense in the newest mail,
 * ranked apart from their dates), `osprey` only past the newest
 * 900, `plover` once in the newest 20 and again only past 900. A page of 5 cuts the arm at 20.
 */
export const TYPO_LIMIT = 5;
const CUT = 4 * TYPO_LIMIT;
export type TypoPath = "walk" | "index" | "walk and index";
export interface TypoFilters { unread?: boolean; sender?: string }
/** The last but one: one sender's messages hold too few rows for the walk its probe asks for. */
export const TYPO_CASES: Array<{ q: string; filters?: TypoFilters; path?: TypoPath }> = [
  { q: "kestrl", path: "walk" },
  { q: "osprye", path: "index" },
  { q: "plovr", path: "walk and index" },
  { q: "kestrl", filters: { unread: true }, path: "walk" },
  { q: "plovr", filters: { sender: "sender5@site.example" }, path: "index" },
  { q: "késtrel" },
];

interface Exec { execute(q: SQL): Promise<unknown>; transaction<T>(f: (tx: Exec) => Promise<T>): Promise<T> }
const rowsOf = <T>(r: unknown): T[] => (Array.isArray(r) ? r : ((r as { rows?: T[] }).rows ?? [])) as T[];

export async function seedTypoMailbox(db: unknown, account: string): Promise<void> {
  const x = db as Exec;
  const [mb] = rowsOf<{ id: string }>(await x.execute(sql`insert into mailboxes (account_id, provider, address)
    values (${account}::uuid, 'imap', 'typo@read.example') returning id`));
  const subject = sql`'weekly note ' || g || case when g % 10 = 0 then ' kestrel' when g % 10 = 5 then ' kesterl' else '' end
    || case when g > 900 and g % 7 = 0 then ' osprey' else '' end
    || case when g = 5 or (g > 900 and g % 9 = 0) then ' plover' else '' end`;
  await x.execute(sql`insert into messages (account_id, mailbox_id, body_hash, dedup_key, subject, from_address, from_name, date, unread, has_attachments, native_locator)
    select ${account}::uuid, ${mb!.id}::uuid, 'h', 'typo:' || g, ${subject}, 'sender' || (g % 7) || '@site.example', 'Sender ' || (g % 7),
      timestamptz '2026-08-20T00:00:00Z' - make_interval(mins => g), g % 3 = 0, false, jsonb_build_object('folder', 'INBOX', 'ref', '1:' || g)
    from generate_series(1, 1600) g`);
  await x.execute(sql`insert into message_search (message_id, account_id, head_tsv, text_tsv, terms, source)
    select m.id, m.account_id, to_tsvector('english', m.subject), to_tsvector('english', ''),
      lower(m.subject || ' ' || m.from_name || ' ' || m.from_address), 'text'
    from messages m where m.account_id = ${account}::uuid`);
  await x.execute(sql`insert into pass_progress (account_id, job, subject_id, done_at)
    values (${account}::uuid, 'search_index_backfill', ${account}::uuid, now())
    on conflict (account_id, job, subject_id) do update set done_at = now()`);
  await x.execute(sql`analyze messages`);
  await x.execute(sql`analyze message_search`);
}

/** The arm's meaning, asked directly: the newest cut of `q <% terms`, ranked by similarity, date, id. */
export async function typoOracle(db: unknown, account: string, q: string, f: TypoFilters = {}): Promise<string[]> {
  return (db as Exec).transaction(async (tx) => {
    await tx.execute(sql`select set_config('pg_trgm.word_similarity_threshold', '0.3', true)`);
    const filter = sql`${f.unread === undefined ? sql`` : sql`and m.unread = ${sql.raw(String(f.unread))}`}
      ${f.sender === undefined ? sql`` : sql`and lower(m.from_address) = lower(${f.sender})`}`;
    const rows = rowsOf<{ id: string }>(await tx.execute(sql`select c.id from (
      select m.id, m.date, word_similarity(${q}, s.terms) as r from messages m join message_search s on s.message_id = m.id
      where m.account_id = ${account}::uuid and m.deleted_at is null ${filter} and s.account_id = ${account}::uuid and ${q} <% s.terms
      order by m.date desc nulls last, m.id desc limit ${CUT}) c order by c.r desc, c.date desc nulls last, c.id desc`));
    return rows.map((r) => String(r.id));
  });
}

/** Every relevance page of `q`, walked by its cursor. */
export async function typoPages(svc: SearchService, ctx: ServiceContext, q: string, f?: TypoFilters): Promise<{ tier: string; ids: string[] }> {
  const filters = f === undefined ? {} : { filters: f };
  const first = await svc.search(ctx, { q, parts: "page", limit: TYPO_LIMIT, ...filters });
  const ids = first.items.map((m) => m.id);
  let cursor = first.nextCursor;
  for (let i = 0; cursor !== null && i < 10; i++) {
    const next = await svc.search(ctx, { q, parts: "page", limit: TYPO_LIMIT, cursor, ...filters });
    expect(next.tier).toBe(first.tier);
    ids.push(...next.items.map((m) => m.id));
    cursor = next.nextCursor;
  }
  return { tier: first.tier, ids };
}

/**
 * Which reads the typo arm (`sa0`) ran, off the page statement's EXPLAIN ANALYZE: `walked` when the
 * walk (`tw`, past its probes `tz`, `tf` and `tp`) looked up a document, `read` when a node outside the walk asked `<%`.
 */
export function typoPaths(plan: Record<string, unknown>): { walked: boolean; read: boolean } {
  const out = { walked: false, read: false };
  const visit = (n: Record<string, unknown>, inArm: boolean, inCte: string): void => {
    const name = String(n["Subplan Name"] ?? "");
    const arm = inArm || name === "CTE sa0";
    const cte = ["CTE tw", "CTE tp", "CTE tf", "CTE tz"].includes(name) ? name : name.startsWith("InitPlan") ? "init" : inCte;
    const ran = Number(n["Actual Loops"] ?? 0) > 0;
    const asks = JSON.stringify([n["Index Cond"], n["Recheck Cond"], n["Filter"], n["Join Filter"]]).includes("<%");
    if (arm && ran && cte === "" && asks) out.read = true;
    if (arm && ran && cte === "CTE tw" && n["Relation Name"] === "message_search") out.walked = true;
    for (const c of (n["Plans"] as Array<Record<string, unknown>> | undefined) ?? []) visit(c, arm, cte);
  };
  visit(plan, false, "");
  return out;
}
