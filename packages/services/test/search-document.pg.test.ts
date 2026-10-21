import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql, type SQL } from "drizzle-orm";
import { brandDialect } from "@trafficflow/db/dialect";
import { accountSettings, attachments, folderState, mailboxes, messageBodies, messages } from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import { runMigrations, ensureSearchExtensions } from "@trafficflow/db/admin";
import { pgTestUrl, MIGRATED_DB_SETUP_BUDGET_MS, MIGRATED_DB_TEARDOWN_BUDGET_MS } from "@trafficflow/db/testing";
import { searchBodyOf, upsertMessageSearch, type EmailAddress } from "@trafficflow/core/mail";
import { SearchService } from "@trafficflow/services";
import type { ServiceContext } from "@trafficflow/services";

/**
 * SEARCH OVER THE SEARCH DOCUMENT (mail 0125) — real Postgres with pg_trgm, every row written by
 * the real writer and every account's marker STAMPED, so the pre-0125 arms are off and each case
 * measures the document alone. Account D holds the reach cases, P the paging set, and L a corpus
 * of generated rows large enough that the planner prefers an index, for the plan and the budget.
 */
const PG_URL = pgTestUrl(import.meta.url);
const client = postgres(PG_URL, { max: 4, onnotice: () => {} });
const db = brandDialect(drizzle(client, { schema }), "pg");
const svc = new SearchService();
const NOW = new Date("2026-09-23T12:00:00.000Z");
const D = randomUUID();
const P = randomUUID();
const L = randomUUID();
const ids: Record<string, string> = {};
/** The setup hook's own settling, which the teardown awaits. */
let setupDone: Promise<void> = Promise.resolve();

function ctx(accountId: string, handle: unknown = db): ServiceContext {
  return { db: handle as never, accountId, userId: null, now: () => NOW, requestId: "search-document" };
}

async function seed(o: {
  key: string; accountId: string; mailboxId: string; subject: string; from: EmailAddress;
  to?: EmailAddress[]; text: string; html?: string | null; daysAgo: number; files?: string[];
}): Promise<void> {
  const [m] = await db.insert(messages).values({
    accountId: o.accountId, mailboxId: o.mailboxId, bodyHash: "h", dedupKey: `doc:${randomUUID()}`,
    subject: o.subject, fromAddress: o.from.address, fromName: o.from.name,
    toAddresses: o.to ?? [], date: new Date(NOW.getTime() - o.daysAgo * 86_400_000),
    unread: false, hasAttachments: (o.files ?? []).length > 0, nativeLocator: { folder: "INBOX", ref: "1:1" },
  }).returning();
  await db.insert(messageBodies).values({ messageId: m!.id, text: o.text, html: o.html ?? null });
  await db.insert(folderState).values({ messageId: m!.id, desiredFolder: "INBOX", observedFolder: "INBOX", lastSetBy: "us" });
  for (const f of o.files ?? []) {
    await db.insert(attachments).values({ accountId: o.accountId, messageId: m!.id, filename: f, contentType: "application/pdf" });
  }
  const body = searchBodyOf(o.text, o.html ?? null);
  await upsertMessageSearch(db as never, m!.id, {
    accountId: o.accountId, subject: o.subject, from: o.from, to: o.to ?? [], cc: [],
    attachmentNames: o.files ?? [], bodyText: body.bodyText, source: body.source,
  });
  ids[o.key] = m!.id;
}

const person = (name: string, address: string): EmailAddress => ({ name, address });

/**
 * Record every statement a service call hands the driver — on the handle and inside any
 * transaction it opens — to EXPLAIN it afterwards in the same session shape.
 */
function recording(): { handle: unknown; seen: SQL[] } {
  const seen: SQL[] = [];
  const wrap = <T extends object>(target: T): T => new Proxy(target, {
    get(t, p, r) {
      if (p === "execute") return (s: SQL) => { seen.push(s); return (t as { execute: (s: SQL) => unknown }).execute(s); };
      if (p === "select") return (...a: unknown[]) => recorded((t as { select: (...x: unknown[]) => object }).select(...a), seen);
      if (p === "transaction") {
        return (fn: (tx: unknown) => Promise<unknown>) =>
          (t as { transaction: (f: (tx: object) => Promise<unknown>) => Promise<unknown> }).transaction((tx) => fn(wrap(tx)));
      }
      return Reflect.get(t, p, r);
    },
  });
  return { handle: wrap(db as object), seen };
}

/**
 * A query builder whose statement is recorded when it runs: a search page's rows and their DTOs
 * are ONE builder read, so a recorder that saw only `execute` would miss the statement it guards.
 */
function recorded<B extends object>(b: B, seen: SQL[]): B {
  return new Proxy(b, {
    get(t, p) {
      const v = Reflect.get(t, p, t) as unknown;
      if (p === "then" && typeof v === "function") {
        seen.push((t as unknown as { getSQL: () => SQL }).getSQL());
        return (v as (...x: unknown[]) => unknown).bind(t);
      }
      if (typeof v !== "function") return v;
      return (...a: unknown[]) => {
        const out = (v as (...x: unknown[]) => unknown).apply(t, a);
        return out !== null && typeof out === "object" && ("from" in out || "getSQL" in out) ? recorded(out, seen) : out;
      };
    },
  });
}

/** Every plan node's type, from `EXPLAIN (FORMAT JSON)`, under the session settings recorded before it. */
async function planNodes(statement: SQL, session: SQL[] = []): Promise<Array<{ type: string; relation?: string }>> {
  const rows = await db.transaction(async (tx) => {
    for (const s of session) await tx.execute(s);
    return tx.execute(sql`explain (format json) ${statement}`);
  }) as unknown as Array<{ "QUERY PLAN": unknown }>;
  const out: Array<{ type: string; relation?: string }> = [];
  const walk = (n: Record<string, unknown>): void => {
    out.push({ type: String(n["Node Type"]), ...(n["Relation Name"] ? { relation: String(n["Relation Name"]) } : {}) });
    for (const c of (n["Plans"] as Record<string, unknown>[] | undefined) ?? []) walk(c);
  };
  const plan = (rows[0]!["QUERY PLAN"] as Array<{ Plan: Record<string, unknown> }>)[0]!.Plan;
  walk(plan);
  return out;
}

describe("search reads the search document (real Postgres, pg_trgm)", () => {
  beforeAll(async () => {
    // The teardown waits for this to settle: a hook that timed out keeps running, and its inserts
    // would otherwise race the deletes below into a foreign-key violation.
    let done!: () => void;
    setupDone = new Promise((r) => { done = r; });
    try {
      await runMigrations(PG_URL);
      await ensureSearchExtensions(db, { concurrently: false });
      const [md] = await db.insert(mailboxes).values({ accountId: D, provider: "imap", address: "d@tf.example" }).returning();
      const [mp] = await db.insert(mailboxes).values({ accountId: P, provider: "imap", address: "p@tf.example" }).returning();
      const [ml] = await db.insert(mailboxes).values({ accountId: L, provider: "imap", address: "l@tf.example" }).returning();

      await seed({ key: "myaxa", accountId: D, mailboxId: md!.id, subject: "myAXA Portal", from: person("Portal", "portal@insure.example"), text: "Your documents are ready.", daysAgo: 3 });
      await seed({ key: "recipient", accountId: D, mailboxId: md!.id, subject: "Quarterly letter", from: person("Anna Weber", "anna@club.example"), to: [person("Claims desk", "claims@axa.example")], text: "Please find the letter.", daysAgo: 5 });
      await seed({ key: "file", accountId: D, mailboxId: md!.id, subject: "Scan", from: person("Scanner", "scan@work.example"), text: "Attached.", daysAgo: 6, files: ["axa-policy-2026.pdf"] });
      await seed({ key: "htmlOnly", accountId: D, mailboxId: md!.id, subject: "Newsletter", from: person("News", "news@shop.example"), text: "", html: "<html><head><style>.zorblatt{}</style></head><body><p>Our quintessence sale ends Friday</p></body></html>", daysAgo: 7 });
      await seed({ key: "subjectHit", accountId: D, mailboxId: md!.id, subject: "Renewal notice", from: person("Office", "office@work.example"), text: "Status.", daysAgo: 20 });
      await seed({ key: "bodyHit", accountId: D, mailboxId: md!.id, subject: "Meeting notes", from: person("Colleague", "colleague@work.example"), text: "renewal renewal renewal and the budget.", daysAgo: 2 });
      await seed({ key: "phrase", accountId: D, mailboxId: md!.id, subject: "Portal access renewed", from: person("IT", "it@work.example"), text: "Nothing else.", daysAgo: 4 });
      await seed({ key: "scattered", accountId: D, mailboxId: md!.id, subject: "Access to the portal", from: person("IT", "it@work.example"), text: "Nothing else.", daysAgo: 8 });

      for (let i = 0; i < 7; i++) {
        await seed({ key: `p${i}`, accountId: P, mailboxId: mp!.id, subject: `Harvest report ${i}`, from: person("Farm", `farm${i}@farm.example`), text: `The harvest of week ${i}.`, daysAgo: i + 1 });
      }

      // L: thousands of generated messages, two words at known frequencies (`common` in every third
      // body, `rarest` in one), documents built by the same writer's SQL shape in one statement.
      await db.execute(sql`
        insert into messages (id, account_id, mailbox_id, body_hash, dedup_key, subject, from_address, date, native_locator)
        select gen_random_uuid(), ${L}, ${ml!.id}, 'h', 'gen:' || g, 'generated subject ' || g,
               'sender' || (g % 300) || '@gen.example', ${NOW.toISOString()}::timestamptz - (g || ' minutes')::interval,
               '{"folder":"INBOX","ref":"1:1"}'::jsonb
        from generate_series(1, 12000) g`);
      await db.execute(sql`
        insert into message_search (message_id, account_id, head_tsv, text_tsv, terms, source)
        select m.id, m.account_id, to_tsvector('english', m.subject), to_tsvector('english',
                 case when m.dedup_key = 'gen:6000' then 'the rarest word' when (substr(m.dedup_key, 5)::int % 3) = 0
                      then 'a common word and filler text' else 'filler text only' end),
               lower(m.subject || ' ' || m.from_address), 'text'
        from messages m where m.account_id = ${L}`);
      for (const a of [D, P, L]) {
        await db.insert(accountSettings).values({ accountId: a, searchIndexBuiltAt: NOW })
          .onConflictDoUpdate({ target: accountSettings.accountId, set: { searchIndexBuiltAt: NOW } });
      }
      await db.execute(sql`analyze messages`);
      await db.execute(sql`analyze message_search`);
    } finally {
      done();
    }
  }, MIGRATED_DB_SETUP_BUDGET_MS);

  afterAll(async () => {
    await setupDone;
    for (const a of [D, P, L]) {
      await db.execute(sql`delete from message_search where account_id = ${a}`);
      await db.execute(sql`delete from attachments where account_id = ${a}`);
      await db.execute(sql`delete from folder_state where message_id in (select id from messages where account_id = ${a})`);
      await db.execute(sql`delete from message_bodies where message_id in (select id from messages where account_id = ${a})`);
      await db.execute(sql`delete from messages where account_id = ${a}`);
      await db.execute(sql`delete from mailboxes where account_id = ${a}`);
      await db.execute(sql`delete from account_settings where account_id = ${a}`);
    }
    await client.end({ timeout: 5 });
  }, MIGRATED_DB_TEARDOWN_BUDGET_MS);

  it("(1) `axa` inside a subject, a recipient's domain and a file name — 0 before, 3 now", async () => {
    // The pre-0125 lexical shape over the same rows: a lexeme match holds none of the three.
    const [before] = await db.execute(sql`
      select count(*)::int as n from messages m left join message_bodies b on b.message_id = m.id
      where m.account_id = ${D} and (m.subject_tsv @@ websearch_to_tsquery('english', 'axa')
        or b.body_tsv @@ websearch_to_tsquery('english', 'axa'))`) as unknown as Array<{ n: number }>;
    expect(before!.n).toBe(0);
    const r = await svc.search(ctx(D), { q: "axa" });
    expect(r.tier).toBe("exact");
    expect(new Set(r.items.map((m) => m.id))).toEqual(new Set([ids.myaxa, ids.recipient, ids.file]));
    expect(r.total).toBe(3);
  });

  it("(2) a recipient's NAME and an HTML-only body's words are found; its stylesheet is not", async () => {
    expect((await svc.page(ctx(D), { q: "claims desk" })).items.map((m) => m.id)).toEqual([ids.recipient]);
    expect((await svc.page(ctx(D), { q: "quintessence" })).items.map((m) => m.id)).toEqual([ids.htmlOnly]);
    expect((await svc.page(ctx(D), { q: "zorblatt" })).items).toEqual([]);
  });

  it("(3) a quoted phrase is exact; unquoted, the scattered words match too", async () => {
    const quoted = await svc.search(ctx(D), { q: '"portal access"' });
    expect(quoted.items.map((m) => m.id)).toEqual([ids.phrase]);
    const loose = await svc.search(ctx(D), { q: "portal access" });
    expect(new Set(loose.items.map((m) => m.id))).toEqual(new Set([ids.phrase, ids.scattered]));
  });

  it("(4) a subject hit ranks above a newer, louder body-only hit", async () => {
    const r = await svc.page(ctx(D), { q: "renewal" });
    expect(r.items.map((m) => m.id).slice(0, 2)).toEqual([ids.subjectHit, ids.bodyHit]);
  });

  it("(5) relevance pages continue each other: no repeat, no skip, the last page ends it", async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const r = await svc.page(ctx(P), { q: "harvest", limit: 2, ...(cursor ? { cursor } : {}) });
      seen.push(...r.items.map((m) => m.id));
      cursor = r.nextCursor ?? undefined;
      pages++;
    } while (cursor && pages < 10);
    expect(pages).toBe(4);
    expect(new Set(seen).size).toBe(seen.length);
    expect(new Set(seen)).toEqual(new Set(Object.keys(ids).filter((k) => /^p\d$/.test(k)).map((k) => ids[k])));
    const one = await svc.page(ctx(P), { q: "harvest" });
    expect(one.items.map((m) => m.id)).toEqual(seen);
  });

  it("(6) a date order walks the whole match set by its own keyset", async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const r = await svc.page(ctx(P), { q: "harvest", sort: "date_asc", limit: 3, ...(cursor ? { cursor } : {}) });
      seen.push(...r.items.map((m) => m.id));
      cursor = r.nextCursor ?? undefined;
    } while (cursor);
    expect(seen).toEqual(["p6", "p5", "p4", "p3", "p2", "p1", "p0"].map((k) => ids[k]));
  });

  it("(7) a cursor from another order or a forged one is refused, not guessed at", async () => {
    const r = await svc.page(ctx(P), { q: "harvest", limit: 2 });
    await expect(svc.page(ctx(P), { q: "harvest", sort: "date_desc", cursor: r.nextCursor! })).rejects.toThrow(/another order/);
    await expect(svc.page(ctx(P), { q: "harvest", cursor: "not-a-cursor" })).rejects.toThrow(/not a search cursor/);
  });

  it("(8) the parts: the page counts its candidates, the summary the union, and both agree here", async () => {
    const page = await svc.search(ctx(D), { q: "axa", parts: "page" });
    expect(page.facets).toBeNull();
    expect(page.total).toBe(3);
    expect(page.totalExact).toBe(true);
    const s = await svc.search(ctx(D), { q: "axa", parts: "summary" });
    expect(s.items).toEqual([]);
    expect(s.total).toBe(3);
    expect(Object.values(s.facets!.folder).reduce((a, b) => a + b, 0)).toBe(3);
    expect(s.indexed).toBeUndefined();
    // A page cut below its matches says its count is a lower bound, and asks the planner nothing.
    const cut = await svc.search(ctx(L), { q: "filler", parts: "page", limit: 5 });
    expect(cut.totalExact).toBe(false);
    expect(cut.nextCursor).not.toBeNull();
    expect(cut.totalEstimate).toBeUndefined();
    // The estimate part says ABOUT how many, from the planner's statistics: within a factor of two.
    const about = await svc.search(ctx(L), { q: "filler", parts: "estimate", limit: 5 });
    const exact = (await svc.search(ctx(L), { q: "filler", parts: "summary" })).total;
    expect(about.totalExact).toBe(false);
    expect(about.totalEstimate).toBeGreaterThanOrEqual(about.total);
    expect(about.totalEstimate! / exact).toBeGreaterThan(0.5);
    expect(about.totalEstimate! / exact).toBeLessThan(2);
  });

  it("(9) a typo falls to the similar tier, over the document's header corpus", async () => {
    const r = await svc.page(ctx(D), { q: "quartrly" });
    expect(r.tier).toBe("similar");
    expect(r.items.map((m) => m.id)).toContain(ids.recipient);
  });

  it("(10) THE PLAN: every arm on its index — no sequential scan of messages or message_search", async () => {
    for (const q of ["common", "rarest", "generated", "sender12"]) {
      const { handle, seen } = recording();
      await svc.page(ctx(L, handle), { q });
      const fused = seen.filter((s) => new PgDialectText(s).includes("with a0 as"));
      expect(fused.length, `the fused page statement was not recorded for ${q}`).toBe(1);
      const session = seen.filter((s) => new PgDialectText(s).includes("set_config"));
      expect(session.length, "the page's session settings were not recorded").toBeGreaterThan(0);
      const nodes = await planNodes(fused[0]!, session);
      const scans = nodes.filter((n) => n.type === "Seq Scan" && (n.relation === "messages" || n.relation === "message_search"));
      expect(scans, `${q}: ${JSON.stringify(nodes)}`).toEqual([]);
      // No OR across the join: each arm reads ONE document predicate.
      expect(new PgDialectText(fused[0]!).text).not.toMatch(/@@[^,()]*\)?\s+or\s+[^()]*@@/i);
    }
  });

  it("(11) THE BUDGET: the first page answers within 100 ms at p95, broad or narrow", async () => {
    for (const q of ["common", "rarest", "filler", "sender12"]) {
      await svc.search(ctx(L), { q, parts: "page" });
      const ms: number[] = [];
      for (let i = 0; i < 10; i++) ms.push((await svc.search(ctx(L), { q, parts: "page" })).ms);
      ms.sort((a, b) => a - b);
      expect(ms[Math.floor(ms.length * 0.95) - 1] ?? ms[ms.length - 1], `${q}: ${ms.join(",")}`).toBeLessThanOrEqual(100);
    }
  });
});

/** A statement's text as Postgres receives it. */
class PgDialectText {
  readonly text: string;
  constructor(s: SQL) {
    this.text = (db as unknown as { dialect: { sqlToQuery: (s: SQL) => { sql: string } } }).dialect.sqlToQuery(s).sql.replace(/\s+/g, " ");
  }
  includes(needle: string): boolean { return this.text.includes(needle); }
}
