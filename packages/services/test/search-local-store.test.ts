import { beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { searchIndexBackfillPass } from "@trafficflow/core/mail";
import { SearchService } from "../src/index.js";
import { makeCtx } from "./helpers.js";

/**
 * THE DESKTOP'S OWN STORE READS EACH ARM WITHIN A BOUND (`localStore`), and answers what the
 * server's reading answers wherever that reading is exact. A page of 10 makes the cut 40, the
 * index read 160 and the walk the newest messages it may. A fixture of messages, newest first by `g`: a word
 * in every body, a rare one (30), a subject word (128), two past the index read whose newest walked
 * messages hold fewer than a cut (a body word, 190; a subject word, 186) and one they hold none of
 * (180, every one older).
 */
const LIMIT = 10;
const local = new SearchService({ indexFills: true, localStore: true });
const server = new SearchService();
let ctx: Awaited<ReturnType<typeof makeCtx>>["ctx"];
let byG: Map<string, number>;

beforeAll(async () => {
  const made = await makeCtx();
  ctx = made.ctx;
  const body = sql`'the notes follow' || ' densea'
    || case when g % 20 = 0 then ' rarea' else '' end
    || case when (g > 240 and g % 2 = 0) or (g <= 240 and g % 24 = 0) then ' mida' else '' end
    || case when g > 240 and g % 2 = 1 then ' olda' else '' end`;
  const subject = sql`'weekly note ' || g
    || case when (g > 240 and g % 3 = 0) or (g <= 240 and g % 30 = 0) then ' subja' else '' end
    || case when (g > 240 and g % 2 = 1) or (g <= 240 and g % 40 = 1) then ' subjb' else '' end`;
  await made.db.execute(sql`
    insert into messages (account_id, mailbox_id, body_hash, dedup_key, subject, from_address, date, unread, has_attachments, native_locator, to_addresses, cc_addresses)
    select ${made.accountId}::uuid, ${made.mailboxId}::uuid, 'h', 'local:' || g, ${subject}, 'sender' || (g % 7) || '@site.example',
      timestamptz '2026-07-20T09:00:00Z' - make_interval(hours => g), false, false,
      jsonb_build_object('folder', case when g % 5 = 0 then 'Archive' else 'INBOX' end, 'ref', '1:' || g), '[]'::jsonb, '[]'::jsonb
    from generate_series(1, 600) g`);
  await made.db.execute(sql`insert into message_bodies (message_id, text)
    select m.id, (select ${body} from (select substring(m.dedup_key from 7)::int as g) x) from messages m where m.account_id = ${made.accountId}::uuid`);
  const built = await searchIndexBackfillPass({ db: made.db as never, accountId: made.accountId });
  expect(built.marked).toBe(true);
  const rows = await made.db.execute(sql`select id, substring(dedup_key from 7)::int as g from messages where account_id = ${made.accountId}::uuid`);
  byG = new Map(((rows as unknown as { rows: Array<{ id: string; g: number }> }).rows).map((r) => [r.id, Number(r.g)]));
}, 120_000);

/** Every relevance page of `q`, walked by its cursor: ids in order, and the first page's reading. */
async function pages(svc: SearchService, q: string, filters?: { folder?: string }) {
  const first = await svc.search(ctx, { q, parts: "page", limit: LIMIT, ...(filters ? { filters } : {}) });
  const ids = first.items.map((m) => m.id);
  let cursor = first.nextCursor;
  while (cursor !== null) {
    const next = await svc.search(ctx, { q, parts: "page", limit: LIMIT, cursor, ...(filters ? { filters } : {}) });
    ids.push(...next.items.map((m) => m.id));
    cursor = next.nextCursor;
  }
  return { first, ids };
}

describe("the desktop store's bounded arms", () => {
  it.each(["densea", "rarea", "subja"])("%s: every relevance page and its reading equal the server's", async (q) => {
    const a = await pages(local, q);
    const b = await pages(server, q);
    expect(a.ids.length).toBeGreaterThan(0);
    expect(a.ids).toEqual(b.ids);
    expect([a.first.tier, a.first.totalExact, a.first.total, a.first.bounded])
      .toEqual([b.first.tier, b.first.totalExact, b.first.total, b.first.bounded]);
  });

  it("a rare word read off the index is found whole, and its count is exact", async () => {
    const r = await pages(local, "rarea");
    expect(r.ids.map((id) => byG.get(id)!).sort((x, y) => x - y)).toEqual(Array.from({ length: 30 }, (_, i) => 20 * (i + 1)));
    expect(r.first.totalExact).toBe(true);
  });

  it.each([["mida", 10, 190], ["subjb", 6, 186]])(
    "%s: past the index read, a bounded window of the newest messages is walked and the answer says it was cut", async (q, walked, total) => {
      const r = await pages(local, q);
      const gs = r.ids.map((id) => byG.get(id)!);
      expect(gs.length).toBe(walked);
      expect(Math.max(...gs)).toBeLessThanOrEqual(240);
      expect(r.first.totalExact).toBe(false);
      expect(r.first.bounded || r.first.nextCursor !== null).toBe(true);
      const e = await local.search(ctx, { q, parts: "estimate", limit: LIMIT });
      expect(e.totalExact).toBe(false);
      const s = await local.search(ctx, { q, parts: "summary" });
      expect([s.total, s.totalExact]).toEqual([total, true]);
      // The positive control: the server's reading has no such bound and reaches past the walk.
      const all = (await pages(server, q)).ids.map((id) => byG.get(id)!);
      expect(Math.max(...all)).toBeGreaterThan(240);
    });

  it("a word past the index read that the walk holds none of is read off its index: an exact page, never the closest words", async () => {
    const r = await pages(local, "olda");
    expect(r.first.tier).toBe("exact");
    expect(r.first.items.map((m) => byG.get(m.id)!)).toEqual(Array.from({ length: LIMIT }, (_, i) => 241 + 2 * i));
    const e = await local.search(ctx, { q: "olda", parts: "estimate", limit: LIMIT });
    expect(e.tier).toBe("exact");
  });

  it("the walk is the newest mail UNDER THE FILTER, and its hits are all of that filter's newest", async () => {
    const r = await pages(local, "mida", { folder: "Archive" });
    const gs = r.ids.map((id) => byG.get(id)!);
    expect(gs.length).toBeGreaterThan(0);
    for (const g of gs) expect(g % 5).toBe(0);
    // Archive holds every fifth message: its newest 240 reach g = 1200, past the whole mailbox.
    const expected = Array.from({ length: 600 }, (_, i) => i + 1)
      .filter((g) => g % 5 === 0 && ((g > 240 && g % 2 === 0) || (g <= 240 && g % 24 === 0)));
    expect([...gs].sort((x, y) => x - y)).toEqual(expected);
  });

  it.each(["date_desc", "date_asc", "sender", "mailbox"] as const)("%s: every page of a chosen order lists the word's matches in that order, as the server's do", async (sort) => {
    const walk = async (svc: SearchService) => {
      const out: string[] = [];
      let cursor: string | undefined;
      do {
        const r = await svc.search(ctx, { q: "rarea", parts: "page", limit: LIMIT, sort, ...(cursor ? { cursor } : {}) });
        expect(r.tier).toBe("exact");
        out.push(...r.items.map((m) => m.id));
        cursor = r.nextCursor ?? undefined;
      } while (cursor);
      return out;
    };
    const ids = await walk(local);
    const gs = ids.map((id) => byG.get(id)!);
    expect([...gs].sort((x, y) => x - y)).toEqual(Array.from({ length: 30 }, (_, i) => 20 * (i + 1)));
    if (sort === "date_desc") expect(gs).toEqual([...gs].sort((x, y) => x - y));
    if (sort === "date_asc") expect(gs).toEqual([...gs].sort((x, y) => y - x));
    expect(ids).toEqual(await walk(server));
  });
});
