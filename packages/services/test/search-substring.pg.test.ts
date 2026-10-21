import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import { brandDialect } from "@trafficflow/db/dialect";
import { mailboxes, messages, messageBodies, folderState } from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import { runMigrations, ensureSearchExtensions } from "@trafficflow/db/admin";
import { pgTestUrl, MIGRATED_DB_SETUP_BUDGET_MS } from "@trafficflow/db/testing";
import { SearchService } from "@trafficflow/services";
import type { ServiceContext } from "@trafficflow/services";

/**
 * A WORD INSIDE ANOTHER WORD IS A MATCH — real Postgres with pg_trgm, the store the managed and
 * self-hosted servers run. `axa` is one lexeme and `myAXA` another, so the lexical arm alone
 * answered nothing and the view fell back to typo guesses. The substring arm is fused with it:
 * account X holds only substring answers (a subject and a sender's domain), account Y the
 * ranking and phrase cases. Every read is scoped to this file's own random accounts.
 */
const URL = pgTestUrl(import.meta.url);
const client = postgres(URL, { max: 5 });
const db = brandDialect(drizzle(client, { schema }), "pg");
const svc = new SearchService();

const NOW = new Date("2026-09-23T12:00:00.000Z");
const X = randomUUID();
const Y = randomUUID();
const ids: Record<string, string> = {};

function ctx(accountId: string): ServiceContext {
  return { db, accountId, userId: null, now: () => NOW, requestId: "search-substring" };
}

async function seed(o: {
  key: string; accountId: string; mailboxId: string; subject: string; from: string; body: string; daysAgo: number;
}): Promise<void> {
  const [m] = await db.insert(messages).values({
    accountId: o.accountId, mailboxId: o.mailboxId, bodyHash: "h",
    dedupKey: `substring:${randomUUID()}`, subject: o.subject, fromAddress: o.from,
    date: new Date(NOW.getTime() - o.daysAgo * 86_400_000), unread: false, hasAttachments: false,
    nativeLocator: { folder: "INBOX", ref: "1:1" },
  }).returning();
  await db.insert(messageBodies).values({ messageId: m!.id, text: o.body });
  await db.insert(folderState).values({
    messageId: m!.id, desiredFolder: "INBOX", observedFolder: "INBOX", lastSetBy: "us",
  });
  ids[o.key] = m!.id;
}

describe("the store finds a word inside another word (real Postgres, pg_trgm)", () => {
  beforeAll(async () => {
    await runMigrations(URL);
    await ensureSearchExtensions(db, { concurrently: false });
    const [mx] = await db.insert(mailboxes).values({ accountId: X, provider: "imap", address: "x@tf.example" }).returning();
    const [my] = await db.insert(mailboxes).values({ accountId: Y, provider: "imap", address: "y@tf.example" }).returning();

    await seed({ key: "myaxa", accountId: X, mailboxId: mx!.id, subject: "myAXA Portal", from: "portal@insure.example", body: "Your documents are ready.", daysAgo: 3 });
    await seed({ key: "domain", accountId: X, mailboxId: mx!.id, subject: "Quarterly letter", from: "news@axa.example", body: "Read this month's letter.", daysAgo: 5 });
    await seed({ key: "decoy", accountId: X, mailboxId: mx!.id, subject: "Holiday plans", from: "friend@mail.example", body: "See you soon.", daysAgo: 1 });

    // The body hit is NEWER and its body says the word three times, so neither recency nor
    // `ts_rank` puts the subject hit first — only both arms holding it does.
    await seed({ key: "subjectHit", accountId: Y, mailboxId: my!.id, subject: "AXA claim update", from: "claims@insure.example", body: "Status of your claim.", daysAgo: 20 });
    await seed({ key: "bodyHit", accountId: Y, mailboxId: my!.id, subject: "Meeting notes", from: "colleague@work.example", body: "axa axa axa and the renewal.", daysAgo: 2 });
    await seed({ key: "phrase", accountId: Y, mailboxId: my!.id, subject: "Portal access renewed", from: "it@work.example", body: "Nothing else.", daysAgo: 4 });
    await seed({ key: "scattered", accountId: Y, mailboxId: my!.id, subject: "Access to the portal", from: "it@work.example", body: "Nothing else.", daysAgo: 6 });
  }, MIGRATED_DB_SETUP_BUDGET_MS);

  afterAll(async () => {
    for (const acct of [X, Y]) {
      await db.execute(sql`delete from folder_state where message_id in (select id from messages where account_id = ${acct})`);
      await db.execute(sql`delete from message_bodies where message_id in (select id from messages where account_id = ${acct})`);
      await db.execute(sql`delete from messages where account_id = ${acct}`);
      await db.execute(sql`delete from mailboxes where account_id = ${acct}`);
    }
    await client.end({ timeout: 5 });
  });

  it("(1) `axa` matches the subject `myAXA Portal` and the sender domain — as matches, not guesses", async () => {
    // The premise, measured: the lexical arm alone holds neither row.
    const lex = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from messages m left join message_bodies b on b.message_id = m.id
      where m.account_id = ${X} and (m.subject_tsv @@ websearch_to_tsquery('english', 'axa')
        or b.body_tsv @@ websearch_to_tsquery('english', 'axa'))`)) as unknown as Array<{ n: number }>;
    expect(lex[0]!.n).toBe(0);

    const r = await svc.search(ctx(X), { q: "axa" });
    expect(r.tier).toBe("exact");
    expect(r.total).toBe(2);
    expect(new Set(r.items.map((m) => m.id))).toEqual(new Set([ids.myaxa, ids.domain]));
  });

  it("(2) the positive control: a query with no substring answer still falls to the typo tier", async () => {
    const r = await svc.search(ctx(X), { q: "holidya" });
    expect(r.tier).toBe("similar");
    expect(r.items.map((m) => m.id)).toContain(ids.decoy);
  });

  it("(3) a quoted phrase stays exact — no inner substring, no scattered words", async () => {
    const quoted = await svc.search(ctx(Y), { q: '"portal access"' });
    expect(quoted.tier).toBe("exact");
    expect(quoted.items.map((m) => m.id)).toEqual([ids.phrase]);
    expect(quoted.total).toBe(1);
    // Unquoted, both words anywhere: the lexical AND admits the scattered subject too.
    const loose = await svc.search(ctx(Y), { q: "portal access" });
    expect(new Set(loose.items.map((m) => m.id))).toEqual(new Set([ids.phrase, ids.scattered]));
    // And `"axa"` quoted does not reach inside `myAXA`: the exact tier is empty.
    expect((await svc.search(ctx(X), { q: '"axa"' })).tier).toBe("similar");
  });

  it("(4) an exact subject hit ranks above a body hit that is newer and louder", async () => {
    const r = await svc.search(ctx(Y), { q: "axa" });
    expect(r.tier).toBe("exact");
    expect(r.items.map((m) => m.id)).toEqual([ids.subjectHit, ids.bodyHit]);
    expect(r.total).toBe(2);
  });

  it("(5) `total` and the facets count the fused set, and a page is cut after fusion", async () => {
    const r = await svc.search(ctx(X), { q: "axa" });
    const folderTotal = Object.values(r.facets!.folder).reduce((a, b) => a + b, 0);
    expect(folderTotal).toBe(r.total);
    const one = await svc.search(ctx(Y), { q: "axa", limit: 1 });
    expect(one.items.map((m) => m.id)).toEqual([ids.subjectHit]);
    expect(one.total).toBe(2);
  });
});
