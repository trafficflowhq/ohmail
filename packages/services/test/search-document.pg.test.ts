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
import { searchBodyOf, upsertMessageSearch, upsertMessageSearchRows, type EmailAddress } from "@trafficflow/core/mail";
import { SearchService } from "@trafficflow/services";
import type { ServiceContext } from "@trafficflow/services";
import { FRAGMENT_FILES, FRAGMENTS } from "./helpers/file-name-fragments.js";

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
/** Five letters: one word in the subject or sender, another only in the body. */
const K = randomUUID();
/** The same letters with no document and no marker: the pre-0125 columns answer. */
const KL = randomUUID();
/**
 * The five letters again, under 130 newer letters: holding none of their words (F), Kai's survey
 * samples (H), and those under 20 newest holding none (G).
 */
const F = randomUUID();
const G = randomUUID();
const H = randomUUID();
/** The five letters under 1,300 newer letters of Kai's survey samples and 250 newest holding none: limit 50. */
const J = randomUUID();
/** Three older letters that only resemble `kai survey`, 130 newer of Kai's survey samples, 20 newest holding none. */
const N = randomUUID();
/** Ines Varga's letter with `harbour-ledger-7731.pdf`, and one with the same words apart. */
const V = randomUUID();
/** (4b)'s four mailboxes: a subject, a sender or a body hit beside letters found by a file name's part. */
const RANKED = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
/** (4c)'s two per case: an older hit under 250 newer letters a file name finds, and under 250 a body word finds. */
const SCALED = Array.from({ length: 18 }, () => randomUUID());
/** (4d)'s file names' fragments. */
const FRAG = randomUUID();
const ids: Record<string, string> = {};
/** The setup hook's own settling, which the teardown awaits. */
let setupDone: Promise<void> = Promise.resolve();

function ctx(accountId: string, handle: unknown = db): ServiceContext {
  return { db: handle as never, accountId, userId: null, now: () => NOW, requestId: "search-document" };
}

async function seed(o: {
  key: string; accountId: string; mailboxId: string; subject: string; from: EmailAddress;
  to?: EmailAddress[]; text: string; html?: string | null; daysAgo: number; files?: string[]; noDocument?: boolean;
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
  ids[o.key] = m!.id;
  if (o.noDocument === true) return;
  const body = searchBodyOf(o.text, o.html ?? null);
  await upsertMessageSearch(db as never, m!.id, {
    accountId: o.accountId, subject: o.subject, from: o.from, to: o.to ?? [], cc: [],
    attachmentNames: o.files ?? [], bodyText: body.bodyText, source: body.source,
  });
}

/** {@link seed} for many letters at once: one statement a table and the writer's own bulk upsert, each keyed `<prefix>-<key>`. */
async function seedAll(accountId: string, mailboxId: string, prefix: string, rows: ReadonlyArray<{
  key: string; subject: string; from: EmailAddress; to: EmailAddress[]; text: string; daysAgo: number; files: string[];
}>): Promise<void> {
  const keyed = rows.map((r) => ({ r, dedup: `doc:${randomUUID()}` }));
  const made = await db.insert(messages).values(keyed.map(({ r, dedup }) => ({
    accountId, mailboxId, bodyHash: "h", dedupKey: dedup, subject: r.subject, fromAddress: r.from.address, fromName: r.from.name,
    toAddresses: r.to, date: new Date(NOW.getTime() - r.daysAgo * 86_400_000), unread: false, hasAttachments: r.files.length > 0,
    nativeLocator: { folder: "INBOX", ref: "1:1" },
  }))).returning({ id: messages.id, dedupKey: messages.dedupKey });
  const idOf = new Map(made.map((m) => [m.dedupKey, m.id]));
  const id = (dedup: string): string => idOf.get(dedup)!;
  await db.insert(messageBodies).values(keyed.map(({ r, dedup }) => ({ messageId: id(dedup), text: r.text })));
  await db.insert(folderState).values(keyed.map(({ dedup }) => ({ messageId: id(dedup), desiredFolder: "INBOX", observedFolder: "INBOX", lastSetBy: "us" })));
  const files = keyed.flatMap(({ r, dedup }) => r.files.map((f) => ({ accountId, messageId: id(dedup), filename: f, contentType: "application/pdf" })));
  if (files.length > 0) await db.insert(attachments).values(files);
  await upsertMessageSearchRows(db as never, keyed.map(({ r, dedup }) => ({
    messageId: id(dedup),
    input: { accountId, subject: r.subject, from: r.from, to: r.to, cc: [], attachmentNames: r.files, bodyText: r.text, source: "text" as const },
  })));
  for (const { r, dedup } of keyed) ids[`${prefix}-${r.key}`] = id(dedup);
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
      const [mk] = await db.insert(mailboxes).values({ accountId: K, provider: "imap", address: "k@tf.example" }).returning();
      const [mkl] = await db.insert(mailboxes).values({ accountId: KL, provider: "imap", address: "kl@tf.example" }).returning();
      const [mf] = await db.insert(mailboxes).values({ accountId: F, provider: "imap", address: "f@tf.example" }).returning();
      const [mg] = await db.insert(mailboxes).values({ accountId: G, provider: "imap", address: "g@tf.example" }).returning();
      const [mh] = await db.insert(mailboxes).values({ accountId: H, provider: "imap", address: "h@tf.example" }).returning();
      const kai = person("Kai Brandt", "kb@harbourlab.example");
      for (const [i, [key, from, subject, text]] of ([
        ["k1", kai, "Lanternfish quarterly report", "The harbour survey counted 412 fish."],
        ["k2", kai, "Boat schedule", "Bring the lanternfish samples."],
        ["k3", person("Lumen Shop", "orders@lumen.example"), "Invoice 4471 aquarium supplies", "Thank you for your order of lanternfish food."],
        ["k4", person("Fish Digest", "weekly@fishdigest.example"), "Weekly digest deep sea", "This week: why the lanternfish glows."],
        ["k5", kai, "Old harbour note", "A year-old note about the lanternfish survey."],
      ] as const).entries()) {
        await seed({ key: `old-${key}`, accountId: KL, mailboxId: mkl!.id, subject, from, text, daysAgo: i + 1, noDocument: true });
        await seed({ key, accountId: K, mailboxId: mk!.id, subject, from, text, daysAgo: i + 1 });
        await seed({ key: `f-${key}`, accountId: F, mailboxId: mf!.id, subject, from, text, daysAgo: i + 1 });
        await seed({ key: `g-${key}`, accountId: G, mailboxId: mg!.id, subject, from, text, daysAgo: i + 1 });
        await seed({ key: `h-${key}`, accountId: H, mailboxId: mh!.id, subject, from, text, daysAgo: i + 1 });
      }
      for (let j = 0; j < 130; j++) {
        await seed({ key: `f-f${j}`, accountId: F, mailboxId: mf!.id, subject: `Status ${j}`, from: person("Robot Desk", "status@robot.example"), text: `All systems nominal, run ${j}.`, daysAgo: (j + 1) / 2000 });
        await seed({ key: `g-f${j}`, accountId: G, mailboxId: mg!.id, subject: `Field log ${j}`, from: kai, text: `Survey samples batch ${j}.`, daysAgo: (j + 21) / 2000 });
        await seed({ key: `h-f${j}`, accountId: H, mailboxId: mh!.id, subject: `Field log ${j}`, from: kai, text: `Survey samples batch ${j}.`, daysAgo: (j + 1) / 2000 });
      }
      for (let j = 0; j < 20; j++) {
        await seed({ key: `g-n${j}`, accountId: G, mailboxId: mg!.id, subject: `Status ${j}`, from: person("Robot Desk", "status@robot.example"), text: `All systems nominal, run ${j}.`, daysAgo: (j + 1) / 2000 });
      }

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
      for (const a of [D, P, L, K, F, G, H]) {
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
    for (const a of [D, P, L, K, KL, F, G, H, J, N, V, ...RANKED, ...SCALED, FRAG]) {
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

  it("(3b) every word anywhere in the letter: subject, people or body, each word in any part", async () => {
    const table: ReadonlyArray<readonly [string, readonly string[]]> = [
      ["lanternfish", ["k1", "k2", "k3", "k4", "k5"]], ["kai lanternfish", ["k1", "k2", "k5"]],
      ["from:kai lanternfish", ["k1", "k2", "k5"]], ["from:kai survey", ["k1", "k5"]], ["aquarium food", ["k3"]],
      ["glows digest", ["k4"]], ["from:lumen food", ["k3"]], ["lanternfish survey", ["k1", "k5"]],
      ['"lanternfish survey"', ["k5"]], ["kai samples or food", ["k2", "k3"]], ["lantern kai", ["k1", "k2", "k5"]],
    ];
    const keyOf = new Map(["k1", "k2", "k3", "k4", "k5"].map((k) => [ids[k]!, k]));
    const got = [];
    for (const [q] of table) {
      const r = await svc.search(ctx(K), { q, limit: 50 });
      got.push({ q, tier: r.tier, keys: r.items.map((m) => keyOf.get(m.id)!).sort() });
    }
    expect(got).toEqual(table.map(([q, keys]) => ({ q, tier: "exact", keys: [...keys] })));
    // An excluded word keeps a letter out wherever it sits, and no closest-words guess holds it.
    const out = await svc.search(ctx(K), { q: "kai -lanternfish", limit: 50 });
    expect(out.tier === "exact" ? out.items.map((m) => keyOf.get(m.id)) : [], "no exact row").toEqual([]);
    expect(out.items.map((m) => keyOf.get(m.id)), "no guess holds the excluded word").toEqual([]);
    // Before the backfill too: `lanternfsh` is a guess at k1's subject, and `survey` is in its body.
    const old = await svc.search(ctx(KL), { q: "lanternfsh -survey", limit: 50 });
    expect({ tier: old.tier, ids: old.items.map((m) => m.id) }).toEqual({ tier: "similar", ids: [] });
    const control = await svc.search(ctx(KL), { q: "lanternfsh", limit: 50 });
    expect(control.items.map((m) => m.id), "the control: the guess without the exclusion").toEqual([ids["old-k1"]]);
  });

  // At limit 5 an arm cuts at K = 20 and walks the newest 120 letters; 130 newer letters hold none
  // of the words (F), or every newest match of `kai survey` holds `samples` (H: the walk goes on;
  // G: under 20 newest without the words, read off the index, cut). Exact only when the page or the
  // estimate counts what the summary counts.
  it("(3c) an exclusion past the newest mail: the older letters are found, and a cut arm says so", async () => {
    const told = async (a: string, q: string, pre: string) => {
      const page = await svc.search(ctx(a), { q, limit: 5, parts: "page" });
      const estimate = await svc.search(ctx(a), { q, limit: 5, parts: "estimate" });
      const summary = await svc.search(ctx(a), { q, limit: 5, parts: "summary" });
      const keyOf = new Map(Object.entries(ids).filter(([k]) => k.startsWith(pre)).map(([k, id]) => [id, k.slice(pre.length)]));
      return {
        tier: page.tier, keys: page.items.map((m) => keyOf.get(m.id) ?? m.id).sort(), summary: summary.total,
        page: page.totalExact ? page.total : "cut", estimate: estimate.totalExact ? estimate.total : "cut",
      };
    };
    const table: ReadonlyArray<readonly [string, readonly string[]]> = [
      ["kai survey -samples", ["k1", "k5"]], ["kai or food -samples", ["k1", "k3", "k5"]], ["zebra or food -samples", ["k3"]],
      ["harbour -samples", ["k1", "k5"]], ["kai survey or food -samples", ["k1", "k3", "k5"]], ["zebra or kai survey -samples", ["k1", "k5"]],
    ];
    const got = [];
    for (const [q] of table) got.push({ q, ...(await told(F, q, "f-")) });
    expect(got).toEqual(table.map(([q, keys]) => ({ q, tier: "exact", keys: [...keys], summary: keys.length, page: keys.length, estimate: keys.length })));
    const deep = [];
    for (const q of ["kai survey -samples", "kai survey or quarterly -samples"]) deep.push({ q, ...(await told(H, q, "h-")) });
    expect(deep).toEqual(["kai survey -samples", "kai survey or quarterly -samples"]
      .map((q) => ({ q, tier: "exact", keys: ["k1", "k5"], summary: 2, page: 2, estimate: 2 })));
    // G: the two-word group's newest matches all hold `samples`; `quarterly` finds k1's subject.
    const r = await told(G, "kai survey or quarterly -samples", "g-");
    expect({ tier: r.tier, summary: r.summary, hasK1: r.keys.includes("k1"), others: r.keys.filter((k) => k !== "k1" && k !== "k5") })
      .toEqual({ tier: "exact", summary: 2, hasK1: true, others: [] });
    // The text arm read the bound of newest matches and kept none: it is cut, with no row to say so.
    expect({ page: r.page, estimate: r.estimate }).toEqual({ page: "cut", estimate: "cut" });
    // One group alone: no row survives, and the page stays the exact tier and says it is cut; the
    // estimate, with no candidate to estimate from, counts the set whole.
    const one = await told(G, "kai survey -samples", "g-");
    expect(one).toEqual({ tier: "exact", keys: [], summary: 2, page: "cut", estimate: 2 });
  });

  it("(3d) at limit 50, every newest match of the group excluded: the exact tier, cut, never closest-word guesses", async () => {
    const [mj] = await db.insert(mailboxes).values({ accountId: J, provider: "imap", address: "j@tf.example" }).returning();
    const kai = person("Kai Brandt", "kb@harbourlab.example");
    for (const [i, [key, from, subject, text]] of ([
      ["k1", kai, "Lanternfish quarterly report", "The harbour survey counted 412 fish."],
      ["k2", kai, "Boat schedule", "Bring the lanternfish samples."],
      ["k5", kai, "Old harbour note", "A year-old note about the lanternfish survey."],
    ] as const).entries()) await seed({ key: `j-${key}`, accountId: J, mailboxId: mj!.id, subject, from, text, daysAgo: i + 1 });
    // 1,300 newer from Kai with `survey` and `samples`, 250 newest holding none of the words.
    await db.execute(sql`
      insert into messages (id, account_id, mailbox_id, body_hash, dedup_key, subject, from_address, from_name, date, native_locator)
      select gen_random_uuid(), ${J}, ${mj!.id}, 'h', 'j:' || g,
             case when g <= 250 then 'Status ' || g else 'Field log ' || g end,
             case when g <= 250 then 'status@robot.example' else 'kb@harbourlab.example' end,
             case when g <= 250 then 'Robot Desk' else 'Kai Brandt' end,
             ${NOW.toISOString()}::timestamptz - (g || ' seconds')::interval, '{"folder":"INBOX","ref":"1:1"}'::jsonb
      from generate_series(1, 1550) g`);
    await db.execute(sql`
      insert into message_search (message_id, account_id, head_tsv, text_tsv, terms, source)
      select m.id, m.account_id,
             setweight(to_tsvector('english', m.subject), 'A') || setweight(to_tsvector('simple', m.from_name || ' ' || m.from_address || ' ' || translate(m.from_address, '@.', '  ')), 'B'),
             to_tsvector('english', case when m.from_name = 'Kai Brandt' then 'Survey samples batch ' || substr(m.dedup_key, 3) else 'All systems nominal.' end),
             lower(m.subject || ' ' || m.from_name || ' ' || m.from_address), 'text'
      from messages m where m.account_id = ${J} and m.dedup_key like 'j:%'`);
    await db.insert(accountSettings).values({ accountId: J, searchIndexBuiltAt: NOW })
      .onConflictDoUpdate({ target: accountSettings.accountId, set: { searchIndexBuiltAt: NOW } });
    const q = "kai survey -samples";
    const page = await svc.search(ctx(J), { q, limit: 50, parts: "page" });
    const estimate = await svc.search(ctx(J), { q, limit: 50, parts: "estimate" });
    const summary = await svc.search(ctx(J), { q, limit: 50, parts: "summary" });
    const mine = new Set([ids["j-k1"], ids["j-k5"]]);
    expect({
      tier: page.tier, others: page.items.filter((m) => !mine.has(m.id)).length, page: page.totalExact ? page.total : "cut",
      estimateTier: estimate.tier, estimate: estimate.totalExact ? estimate.total : "cut", summaryTier: summary.tier, summary: summary.total,
    }).toEqual({ tier: "exact", others: 0, page: "cut", estimateTier: "exact", estimate: 2, summaryTier: "exact", summary: 2 });
  }, 120_000);

  it("(3e) no exact match behind a cut exact tier: the page in each order, the estimate and the summary say exact and 0", async () => {
    const [mn] = await db.insert(mailboxes).values({ accountId: N, provider: "imap", address: "n@tf.example" }).returning();
    const kai = person("Kai Brandt", "kb@harbourlab.example");
    for (const [i, [subject, from, text]] of ([
      ["Kia survy results", person("Kia Brand", "kia@brand.example"), "Numbers from the field."],
      ["Servey notes", person("Lab Desk", "desk@lab.example"), "Notes from Tuesday."],
      ["Kai surveyor visit", kai, "The visit is on Monday."],
    ] as const).entries()) await seed({ key: `n-g${i + 1}`, accountId: N, mailboxId: mn!.id, subject, from, text, daysAgo: i + 1 });
    for (let j = 0; j < 130; j++) {
      await seed({ key: `n-f${j}`, accountId: N, mailboxId: mn!.id, subject: `Field log ${j}`, from: kai, text: `Survey samples batch ${j}.`, daysAgo: (j + 21) / 2000 });
    }
    for (let j = 0; j < 20; j++) {
      await seed({ key: `n-n${j}`, accountId: N, mailboxId: mn!.id, subject: `Status ${j}`, from: person("Robot Desk", "status@robot.example"), text: `All systems nominal, run ${j}.`, daysAgo: (j + 1) / 2000 });
    }
    await db.insert(accountSettings).values({ accountId: N, searchIndexBuiltAt: NOW })
      .onConflictDoUpdate({ target: accountSettings.accountId, set: { searchIndexBuiltAt: NOW } });
    const q = "kai survey -samples";
    const said = (r: { tier: string; total: number; totalExact: boolean; items: unknown[] }) => ({ tier: r.tier, items: r.items.length, total: r.totalExact ? r.total : "cut" });
    const got = [];
    for (const sort of ["relevance", "date_desc"] as const) {
      got.push({ sort, part: "page", ...said(await svc.search(ctx(N), { q, limit: 5, sort, parts: "page" })) });
    }
    got.push({ sort: "relevance", part: "estimate", ...said(await svc.search(ctx(N), { q, limit: 5, parts: "estimate" })) });
    got.push({ sort: "relevance", part: "summary", ...said(await svc.search(ctx(N), { q, limit: 5, parts: "summary" })) });
    got.push({ sort: "relevance", part: "both", ...said(await svc.search(ctx(N), { q, limit: 5 })) });
    // Nothing holds both words without `samples`: never the closest words' count over the exact tier's empty list.
    expect(got).toEqual([
      { sort: "relevance", part: "page", tier: "exact", items: 0, total: "cut" },
      { sort: "date_desc", part: "page", tier: "exact", items: 0, total: "cut" },
      { sort: "relevance", part: "estimate", tier: "exact", items: 0, total: 0 },
      { sort: "relevance", part: "summary", tier: "exact", items: 0, total: 0 },
      { sort: "relevance", part: "both", tier: "exact", items: 0, total: 0 },
    ]);
  }, 120_000);

  it("(3f) any part of a file name beside another word, in the exact tier", async () => {
    const [mv] = await db.insert(mailboxes).values({ accountId: V, provider: "imap", address: "v@tf.example" }).returning();
    await seed({ key: "v-sr2", accountId: V, mailboxId: mv!.id, subject: "Papers for SR2", from: person("Ines Varga", "iv@post.example"), text: "SR2: the scan is attached.", daysAgo: 1, files: ["harbour-ledger-7731.pdf"] });
    await seed({ key: "v-d2", accountId: V, mailboxId: mv!.id, subject: "Ledger copy", from: person("Port Office", "office@port.example"), text: "The harbour scan.", daysAgo: 2, files: ["notes.txt"] });
    await seed({ key: "v-q3", accountId: V, mailboxId: mv!.id, subject: "Q3 papers", from: person("Desk", "po@desk.example"), text: "See attached.", daysAgo: 3, files: ["INV-123.pdf"] });
    await db.insert(accountSettings).values({ accountId: V, searchIndexBuiltAt: NOW })
      .onConflictDoUpdate({ target: accountSettings.accountId, set: { searchIndexBuiltAt: NOW } });
    const keyOf = new Map([[ids["v-sr2"], "sr2"], [ids["v-d2"], "d2"], [ids["v-q3"], "q3"]]);
    const table: ReadonlyArray<readonly [string, readonly string[]]> = [
      ["ledger", ["d2", "sr2"]], ["ines harbour", ["sr2"]], ["ines ledger", ["sr2"]], ["ines pdf", ["sr2"]], ["ines 7731", ["sr2"]],
      ["ines harbour-ledger-7731.pdf", ["sr2"]], ["scan pdf", ["sr2"]], ["scan 7731", ["sr2"]], ["papers ledger", ["sr2"]],
      ["harbour ledger", ["d2", "sr2"]], ["ledger 7731 scan", ["sr2"]], ["ines harbour 7731", ["sr2"]],
      ["Ines LEDGER", ["sr2"]], ["SCAN Pdf 7731", ["sr2"]],
      // A whole name of runs under four letters beside a subject word: the name itself is a word of the text.
      ["q3 inv-123.pdf", ["q3"]],
    ];
    const read = async (q: string) => {
      const r = await svc.search(ctx(V), { q });
      return { q, tier: r.tier, keys: r.items.map((m) => keyOf.get(m.id) ?? m.id).sort() };
    };
    const got = [];
    for (const [q] of table) got.push(await read(q));
    expect(got).toEqual(table.map(([q, keys]) => ({ q, tier: "exact", keys: [...keys] })));
    // A phrase reads whole words; a part under three characters is not looked for inside a name.
    const whole = [];
    for (const q of ['"ines ledger"', "ines 77"]) whole.push(await read(q));
    expect(whole.filter((r) => r.tier === "exact" && r.keys.length > 0)).toEqual([]);
  });

  it("(4) a subject hit ranks above a newer, louder body-only hit", async () => {
    const r = await svc.page(ctx(D), { q: "renewal" });
    expect(r.items.map((m) => m.id).slice(0, 2)).toEqual([ids.subjectHit, ids.bodyHit]);
  });

  it("(4b) a file name's part ranks like a body word, by recency, never above a subject or sender hit", async () => {
    type Row = { key: string; subject: string; from: EmailAddress; text: string; daysAgo: number; files: string[] };
    const filed = (key: string, file: string, daysAgo: number): Row =>
      ({ key, subject: `Papers ${key}`, from: person(`Clerk ${key}`, `${key}@desk.example`), text: "See attached.", daysAgo, files: [file] });
    const ORDERS: ReadonlyArray<readonly [q: string, rows: readonly Row[], first: readonly string[]]> = [
      ["ledger", [{ key: "subj", subject: "Ledger copy", from: person("Port Office", "office@port.example"), text: "The harbour scan.", daysAgo: 10, files: ["notes.txt"] },
        filed("f1", "harbour-ledger-7731.pdf", 1), filed("f2", "harbour-ledger-7732.pdf", 2), filed("f3", "harbour-ledger-7733.pdf", 3)],
      ["subj", "f1", "f2", "f3"]],
      ["varga", [{ key: "sender", subject: "Hello", from: person("Ines Varga", "iv@post.example"), text: "Short note.", daysAgo: 10, files: ["notes.txt"] },
        filed("g1", "varga-contract-1.pdf", 1), filed("g2", "varga-contract-2.pdf", 2), filed("g3", "varga-contract-3.pdf", 3)],
      ["sender", "g1", "g2", "g3"]],
      ["ledger", [{ key: "body", subject: "Weekly note", from: person("Port Office", "office@port.example"), text: "The ledger is closed for the month.", daysAgo: 1, files: ["notes.txt"] },
        filed("file", "harbour-ledger-7731.pdf", 3)], ["body", "file"]],
      ["contract", [{ key: "subj", subject: "Contract renewal", from: person("Port Office", "office@port.example"), text: "See you Monday.", daysAgo: 40, files: ["notes.txt"] },
        ...Array.from({ length: 80 }, (_, i) => filed(`c${i}`, `Contract_v${i}.docx`, i / 4))], ["subj"]],
    ];
    const got: Array<{ q: string; svc: string; first: string[] }> = [];
    const want: typeof got = [];
    for (const [i, [q, rows, first]] of ORDERS.entries()) {
      const account = RANKED[i]!;
      const [mb] = await db.insert(mailboxes).values({ accountId: account, provider: "imap", address: `ranked${i}@tf.example` }).returning();
      for (const row of rows) await seed({ ...row, key: `ranked${i}-${row.key}`, accountId: account, mailboxId: mb!.id });
      await db.insert(accountSettings).values({ accountId: account, searchIndexBuiltAt: NOW })
        .onConflictDoUpdate({ target: accountSettings.accountId, set: { searchIndexBuiltAt: NOW } });
      const keyOf = new Map(rows.map((row) => [ids[`ranked${i}-${row.key}`], row.key]));
      for (const [label, s] of [["store", svc], ["desktop", new SearchService({ indexFills: true, localStore: true })]] as const) {
        const r = await s.search(ctx(account), { q, limit: 50 });
        got.push({ q, svc: label, first: r.items.map((m) => keyOf.get(m.id) ?? m.id).slice(0, first.length) });
        want.push({ q, svc: label, first: [...first] });
      }
    }
    expect(got).toEqual(want);
  }, 60_000);

  // (4c): 250 newer letters a file name finds beside an older subject or sender hit, against 250 newer
  // letters whose text holds the word: names with marks and with spaces, a word's start, a short word.
  // Second, where the newest of 250 newer letters a body word finds ties the older hit and is newer;
  // first for `pdf`, which no part-word arm reads.
  type Scaled = { key: string; subject: string; from: EmailAddress; text: string; daysAgo: number; files: string[] };
  const newer = (i: number, text: string, file: string): Scaled =>
    ({ key: `n${i}`, subject: `Papers ${i}`, from: person(`Clerk ${i}`, `c${i}@desk.example`), text, daysAgo: i / 8, files: [file] });
  const olderHit = (subject: string, from: EmailAddress, text: string): Scaled => ({ key: "T", subject, from, text, daysAgo: 100, files: ["notes.txt"] });
  const LEDGER = olderHit("Ledger copy", person("Port Office", "office@port.example"), "The harbour scan.");
  const VARGA = olderHit("Hello", person("Ines Varga", "iv@post.example"), "Short note.");
  const ADDRESS = olderHit("Address change", person("Port Office", "office@port.example"), "From Monday.");
  const PDF = olderHit("PDF guide", person("Port Office", "office@port.example"), "From Monday.");
  const ledgerBody = (i: number) => newer(i, "The ledger is closed.", "notes.txt");
  const vargaBody = (i: number) => newer(i, "Varga sent the papers.", "notes.txt");
  const addressBody = (i: number) => newer(i, "The address list is attached.", "notes.txt");
  const DEEP: ReadonlyArray<readonly [label: string, q: string, older: Scaled, file: (i: number) => Scaled, body: (i: number) => Scaled]> = [
    ["ledger, a name with marks", "ledger", LEDGER, (i) => newer(i, "See attached.", `harbour-ledger-${i}.pdf`), ledgerBody],
    ["ledger, a name with spaces", "ledger", LEDGER, (i) => newer(i, "See attached.", `Annual Ledger ${i}.pdf`), ledgerBody],
    ["ledg, a word's start", "ledg", LEDGER, (i) => newer(i, "See attached.", `harbour-ledger-${i}.pdf`), ledgerBody],
    ["varga, a name with marks", "varga", VARGA, (i) => newer(i, "See attached.", `offer-varga-${i}.pdf`), vargaBody],
    ["varga, a name with spaces", "varga", VARGA, (i) => newer(i, "See attached.", `Offer Varga ${i}.pdf`), vargaBody],
    ["varg, a word's start", "varg", VARGA, (i) => newer(i, "See attached.", `offer-varga-${i}.pdf`), vargaBody],
    ["address, beside the recipient lists' keys", "address", ADDRESS, (i) => newer(i, "See attached.", `address-list-${i}.pdf`), addressBody],
    ["addre, a word's start", "addre", ADDRESS, (i) => newer(i, "See attached.", `address-list-${i}.pdf`), addressBody],
    ["pdf, under four letters", "pdf", PDF, (i) => newer(i, "See attached.", `report-${i}.pdf`), (i) => newer(i, "The pdf is attached.", "notes.txt")],
  ];
  for (const [c, [label, q, older, file, body]] of DEEP.entries()) {
    it(`(4c) past the arms' cut (${label}): an older subject or sender hit stands where it stands beside as many newer body hits`, async () => {
      const SVCS = [["store", svc], ["desktop", new SearchService({ indexFills: true, localStore: true })]] as const;
      const placeOf = async (s: SearchService, account: string, target: string): Promise<number> => {
        let seen = 0;
        let cursor: string | undefined;
        for (let page = 0; page < 8; page++) {
          const r = await s.search(ctx(account), { q, limit: 50, parts: "page", ...(cursor ? { cursor } : {}) });
          const at = r.items.findIndex((m) => m.id === target);
          if (at >= 0) return seen + at + 1;
          seen += r.items.length;
          if (!r.nextCursor) return -1;
          cursor = r.nextCursor;
        }
        return -1;
      };
      const at = new Map<string, { file: number; body: number }>();
      for (const [k, [kind, row]] of ([["file", file], ["body", body]] as const).entries()) {
        const n = 2 * c + k;
        const account = SCALED[n]!;
        const [mb] = await db.insert(mailboxes).values({ accountId: account, provider: "imap", address: `scaled${n}@tf.example` }).returning();
        const to = [person("Mila Hartmann", "mila@lichtgrat.example")];
        await seedAll(account, mb!.id, `scaled${n}`, [older, ...Array.from({ length: 250 }, (_, i) => row(i))].map((r) => ({ ...r, to })));
        await db.insert(accountSettings).values({ accountId: account, searchIndexBuiltAt: NOW })
          .onConflictDoUpdate({ target: accountSettings.accountId, set: { searchIndexBuiltAt: NOW } });
        for (const [l, s] of SVCS) at.set(l, { ...(at.get(l) ?? { file: 0, body: 0 }), [kind]: await placeOf(s, account, ids[`scaled${n}-T`]!) });
      }
      const place = q === "pdf" ? 1 : 2;
      expect(SVCS.map(([l]) => ({ svc: l, ...at.get(l)! }))).toEqual(SVCS.map(([l]) => ({ svc: l, file: place, body: place })));
    }, 120_000);
  }

  it("(4d) a file name's fragment typed with its marks: the exact tier, the letter first, as many letters as before", async () => {
    const [mb] = await db.insert(mailboxes).values({ accountId: FRAG, provider: "imap", address: "frag@tf.example" }).returning();
    const to = [person("Mila Hartmann", "mila@lichtgrat.example")];
    for (const [i, [key, file]] of FRAGMENT_FILES.entries()) {
      const from = key === "hl" ? person("Ines Varga", "iv@post.example") : person(`Clerk ${key}`, `${key}@desk.example`);
      await seed({ key: `frag-${key}`, accountId: FRAG, mailboxId: mb!.id, subject: key === "hl" ? "Papers for SR2" : `Papers ${key}`, from, to, text: "See attached.", daysAgo: 1 + i, files: [file] });
    }
    for (let n = 100; n <= 160; n++) {
      await seed({ key: `frag-n${n}`, accountId: FRAG, mailboxId: mb!.id, subject: `Papers n${n}`, from: person(`Clerk n${n}`, `n${n}@desk.example`), to, text: "See attached.", daysAgo: 20 + n / 10, files: [`INV-${n}.pdf`] });
    }
    await db.insert(accountSettings).values({ accountId: FRAG, searchIndexBuiltAt: NOW })
      .onConflictDoUpdate({ target: accountSettings.accountId, set: { searchIndexBuiltAt: NOW } });
    await db.execute(sql`analyze message_search`);
    const keyOf = new Map(Object.entries(ids).filter(([k]) => k.startsWith("frag-")).map(([k, id]) => [id, k.slice("frag-".length)]));
    const SVCS = [["store", svc], ["desktop", new SearchService({ indexFills: true, localStore: true })]] as const;
    const got: Array<{ q: string; svc: string; tier: string; first: string | null; letters: number }> = [];
    for (const [q] of FRAGMENTS) {
      for (const [label, s] of SVCS) {
        const r = await s.search(ctx(FRAG), { q, limit: 50, parts: "page" });
        got.push({ q, svc: label, tier: r.tier, first: r.items[0] ? keyOf.get(r.items[0].id) ?? r.items[0].id : null, letters: r.items.length });
      }
    }
    expect(got).toEqual(FRAGMENTS.flatMap(([q, first, letters]) => SVCS.map(([label]) => ({ q, svc: label, tier: "exact", first, letters }))));
  }, 60_000);

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
    expect("totalEstimate" in cut).toBe(false);
    // The estimate part says AT LEAST its candidates: no count from the planner's statistics.
    const least = await svc.search(ctx(L), { q: "filler", parts: "estimate", limit: 5 });
    const exact = (await svc.search(ctx(L), { q: "filler", parts: "summary" })).total;
    expect(least.totalExact).toBe(false);
    expect("totalEstimate" in least).toBe(false);
    expect(least.total).toBeLessThanOrEqual(exact);
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
