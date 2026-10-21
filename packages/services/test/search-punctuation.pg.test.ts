import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import { mailboxes, messages, messageBodies, folderState } from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import { runMigrations, ensureSearchExtensions } from "@trafficflow/db/admin";
import { pgTestUrl, MIGRATED_DB_SETUP_BUDGET_MS } from "@trafficflow/db/testing";
import { SearchService } from "@trafficflow/services";
import type { ServiceContext } from "@trafficflow/services";
import { brandDialect } from "@trafficflow/db/dialect";

/**
 * THE ARCHIVE HALF OF THE `D-U-N-S` MISS — measured against real Postgres, because the whole
 * question is what `to_tsvector` and `websearch_to_tsquery` do with punctuation, and PGlite is
 * not the authority on that.
 *
 * The report was that `D-U-N-S` answered "Nothing on this device. … Searching the whole
 * archive…" and the second sentence never resolved. Two candidate causes, and they need
 * separating before either is fixed: the archive could be MISSING the message, or the archive
 * could be answering while the view sat in its `searching` state for ever.
 *
 * ── WHAT POSTGRES ACTUALLY DOES, MEASURED (PG 16, `english` config) ──────────────────────────
 *
 *   websearch_to_tsquery('english', 'D-U-N-S')   →  'd-u-n-' <-> 'd' <-> 'u' <-> 'n'
 *   to_tsvector('english', 'Your D-U-N-S Number is enclosed.')
 *                                                →  'd':3 'd-u-n-':2 'enclos':9 'n':5
 *                                                    'number':7 'u':4
 *
 * So the query is a PHRASE — the compound lexeme followed, in order, by its parts — and the
 * subject's vector carries exactly that sequence at positions 2,3,4,5. It matches, `ts_rank`
 * 0.4636. The archive was never missing this message: **the reported miss was the view's
 * state, not the query.** Case (a) is that measurement, kept as a fact so a config or version
 * change that breaks it is visible here rather than in a mailbox.
 *
 * ── WHAT THE LEXICAL ARM STILL CANNOT DO, AND WHY THE VERBATIM ARM IS LANDED ────────────────
 *
 * A punctuated query is one lexeme, and a lexeme match is all-or-nothing: `Alpha/Beta merger`
 * vectors as the single lexeme `'alpha/beta'`, so `pha/Bet` — `'pha/bet'` — matches nothing at
 * all, however plainly the characters are in the subject. The substring arm answers it: open
 * for any query of a trigram's width or wider, and for a punctuated one below it (case (d)).
 *
 * ── AND ONE MEASURED BOUNDARY (case (f)) ───────────────────────────────────────────────────
 *
 * `websearch_to_tsquery('english','DUNS')` is `'dun'` — stemmed — and it does NOT match the
 * hyphenated subject's vector, because the characters `DUNS` are not inside `D-U-N-S` for any arm
 * to find. The device's first paint answers the same (it indexes no joined form either,
 * `search-device-parity.test.ts`), so the joined spelling reaches the hyphenated message nowhere.
 *
 * Every read here is scoped to this file's own random account, and nothing is stamped with a
 * time this run did not happen at: the database may be co-tenanted. Which one it is belongs to
 * the one resolver — a file that spells out its own URL is classified as safe to run unlocked
 * and then reaches the shared box anyway.
 */
const URL = pgTestUrl(import.meta.url);
const client = postgres(URL, { max: 5 });
const db = brandDialect(drizzle(client, { schema }), "pg");
const svc = new SearchService();

const NOW = new Date("2026-09-08T12:00:00.000Z");
const SENT = new Date("2026-09-01T10:00:00.000Z");
/** The verbatim-only row is OLDER, so a date tie-break cannot be what puts it last. */
const SENT_OLDER = new Date("2026-08-01T10:00:00.000Z");

const A = randomUUID();
const ids: Record<string, string> = {};

/** The reported subject, verbatim. */
const DUNS_SUBJECT = "Your D-U-N-S Number is enclosed.";

function ctx(): ServiceContext {
  return { db, accountId: A, userId: null, now: () => NOW, requestId: "search-punct-test" };
}

async function seed(o: { key: string; mailboxId: string; subject: string; body: string; date?: Date }): Promise<void> {
  const [m] = await db.insert(messages).values({
    accountId: A, mailboxId: o.mailboxId, bodyHash: "h",
    dedupKey: `punct:${randomUUID()}`, subject: o.subject, fromAddress: "registry@dnb.example",
    date: o.date ?? SENT, unread: false, hasAttachments: false,
    nativeLocator: { folder: "INBOX", ref: "1:1" },
  }).returning();
  await db.insert(messageBodies).values({ messageId: m!.id, text: o.body });
  await db.insert(folderState).values({
    messageId: m!.id, desiredFolder: "INBOX", observedFolder: "INBOX", lastSetBy: "us",
  });
  ids[o.key] = m!.id;
}

describe("archive search over punctuation (real Postgres)", () => {
  beforeAll(async () => {
    await runMigrations(URL);
    await ensureSearchExtensions(db, { concurrently: false });
    const [mb] = await db.insert(mailboxes).values({ accountId: A, provider: "imap", address: "a@tf.example" }).returning();

    await seed({ key: "duns", mailboxId: mb!.id, subject: DUNS_SUBJECT, body: "The certificate is attached." });
    // The lexeme-boundary pair. `pha/Bet` is a lexical match for the first and reaches the
    // second only as characters — which is the whole of the verbatim arm's job.
    await seed({ key: "lexical", mailboxId: mb!.id, subject: "Pha/Bet quarterly", body: "Nothing else." });
    await seed({
      key: "verbatim", mailboxId: mb!.id, subject: "Alpha/Beta merger", body: "Nothing else.",
      date: SENT_OLDER,
    });
    /*
     * THE RANK INVERSION, and it is why case (g) exists at all.
     *
     * This subject does NOT satisfy `websearch_to_tsquery('english','D-U-N-S')` — the query is a
     * phrase and these letters are not in that order — and yet `ts_rank` scores it **0.9578**
     * against the real match's 0.4636, because `ts_rank` counts whichever query OPERANDS are
     * present and knows nothing about the phrase operator that refused. It also holds "D-U-N-S"
     * as a substring, inside `xD-U-N-Sx`, so the verbatim arm does match it. Measured, both
     * numbers, on this database.
     */
    await seed({
      key: "loud", mailboxId: mb!.id, subject: "u n u n u n u n u n xD-U-N-Sx",
      body: "Nothing else.", date: SENT_OLDER,
    });
  }, MIGRATED_DB_SETUP_BUDGET_MS);

  afterAll(async () => { await client.end({ timeout: 5 }); });

  it("(a) the hyphenated subject IS in the archive's lexical reach — the miss was not here", async () => {
    // The predicate, alone, before the service: this is the measurement the whole slice turned on.
    const rows = (await db.execute<{ m: boolean; r: number; tsq: string }>(sql`
      select to_tsvector('english', ${DUNS_SUBJECT}) @@ websearch_to_tsquery('english', 'D-U-N-S') as m,
             ts_rank(to_tsvector('english', ${DUNS_SUBJECT}), websearch_to_tsquery('english', 'D-U-N-S')) as r,
             websearch_to_tsquery('english', 'D-U-N-S')::text as tsq`)) as unknown as Array<{ m: boolean; r: number; tsq: string }>;
    expect(rows[0]!.m).toBe(true);
    // The SHAPE, not merely the verdict: a phrase over the compound and its parts.
    expect(rows[0]!.tsq).toBe("'d-u-n-' <-> 'd' <-> 'u' <-> 'n'");
    expect(Number(rows[0]!.r)).toBeGreaterThan(0);

    const r = await svc.search(ctx(), { q: "D-U-N-S" });
    expect(r.tier).toBe("exact");
    expect(r.items.map((m) => m.id)).toContain(ids.duns);
  });

  it("(b) a punctuated query the lexical arm cannot answer is found verbatim", async () => {
    // `'pha/bet'` is one lexeme and `'alpha/beta'` is another; no lexical arm can bridge them.
    const [{ n }] = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n
      from messages m left join message_bodies b on b.message_id = m.id
      where m.account_id = ${A} and m.id = ${ids.verbatim}
        and (m.subject_tsv @@ websearch_to_tsquery('english', 'pha/Bet')
             or b.body_tsv @@ websearch_to_tsquery('english', 'pha/Bet'))`)) as unknown as Array<{ n: number }>;
    expect(n).toBe(0);

    const r = await svc.search(ctx(), { q: "pha/Bet" });
    expect(r.tier).toBe("exact");
    expect(r.items.map((m) => m.id)).toContain(ids.verbatim);
  });

  it("(c) the verbatim arm ranks BELOW the lexical one, and is never the only arm", async () => {
    const r = await svc.search(ctx(), { q: "pha/Bet" });
    const order = r.items.map((m) => m.id);
    expect(order).toEqual([ids.lexical, ids.verbatim]);
    // The lexical row is the NEWER of the two, so this ordering is not the date tie-break
    // agreeing by coincidence — the verbatim row would have to come second on relevance alone.
    expect(r.total).toBe(2);
  });

  it("(d) the GATE: a trigram's width, or punctuation, opens the substring arm", async () => {
    /*
     * The pair discriminates on WIDTH: `pha` is three characters, so it is found inside
     * `Alpha/Beta` as a match (as `axa` is inside `myAXA`); `ph` is below the width and
     * unpunctuated, so the arm stays shut and what comes back is the typo tier under its label.
     * It once pinned punctuation as the only key; a word inside a word is a match now.
     */
    const pha = await svc.search(ctx(), { q: "pha" });
    expect(pha.tier).toBe("exact");
    expect(new Set(pha.items.map((m) => m.id))).toEqual(new Set([ids.lexical, ids.verbatim]));
    expect((await svc.search(ctx(), { q: "pha/Bet" })).tier).toBe("exact");
    expect((await svc.search(ctx(), { q: "ph" })).tier).toBe("similar");
  });

  it("(e) the verbatim arm searches the SUBJECT and not the body", async () => {
    // A body-only substring is deliberately out of the arm: `message_bodies.text` has no index
    // that can serve `ILIKE '%…%'`, and the arm's cost argument depends on that. Two rows'
    // BODIES hold "thing else." (inside "Nothing else.") and no subject does.
    const r = await svc.search(ctx(), { q: "thing else." });
    expect(r.tier).toBe("similar");
    expect(r.items.map((m) => m.id)).not.toContain(ids.lexical);
    expect(r.items.map((m) => m.id)).not.toContain(ids.verbatim);
  });

  it("(g) a verbatim row that OUT-RANKS the lexical one on ts_rank still sits below it", async () => {
    /*
     * The tier cannot be inferred from the rank, and this is the case that proves it rather than
     * asserting it. `ts_rank` is 0.9578 for the `loud` row — which the tsquery REFUSES — against
     * 0.4636 for the row that matches. A rank expression that simply used `ts_rank` would put a
     * substring hit above the reader's actual match, and would do it silently: both rows are
     * plausible answers to the characters typed.
     *
     * So the tier is STATED in the expression (`1 + ts_rank` for a lexical row, `0` for a
     * verbatim-only one), which holds regardless of what `ts_rank` returns or of any bound on it.
     */
    const rows = (await db.execute<{ loud: number; lex: number }>(sql`
      select ts_rank(m.subject_tsv, websearch_to_tsquery('english','D-U-N-S')) as loud,
             (select ts_rank(x.subject_tsv, websearch_to_tsquery('english','D-U-N-S'))
                from messages x where x.id = ${ids.duns}) as lex
        from messages m where m.id = ${ids.loud}`)) as unknown as Array<{ loud: number; lex: number }>;
    // The premise, measured in the same run rather than remembered from a probe.
    expect(Number(rows[0]!.loud)).toBeGreaterThan(Number(rows[0]!.lex));

    const r = await svc.search(ctx(), { q: "D-U-N-S" });
    const order = r.items.map((m) => m.id);
    expect(order.indexOf(ids.duns!)).toBeGreaterThanOrEqual(0);
    expect(order.indexOf(ids.loud!)).toBeGreaterThan(order.indexOf(ids.duns!));
  });

  it("(f) `DUNS` does not reach the hyphenated subject in the archive, as it does not on the device", async () => {
    const rows = (await db.execute<{ tsq: string; m: boolean }>(sql`
      select websearch_to_tsquery('english', 'DUNS')::text as tsq,
             to_tsvector('english', ${DUNS_SUBJECT}) @@ websearch_to_tsquery('english', 'DUNS') as m`)) as unknown as Array<{ tsq: string; m: boolean }>;
    expect(rows[0]!.tsq).toBe("'dun'");
    expect(rows[0]!.m).toBe(false);

    // And the service agrees: the characters `DUNS` are not inside `D-U-N-S`.
    const r = await svc.search(ctx(), { q: "DUNS" });
    expect(r.items.map((m) => m.id)).not.toContain(ids.duns);
  });
});
