import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { and, eq } from "drizzle-orm";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import {
  accounts, changeLog, mailboxes, messageBodies, messages, type Tx,
} from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import { createLogger, normalizeMime } from "@trafficflow/core";
import { runSenderNameBackfill } from "../src/sender-name-backfill.js";

/**
 * THE SENDER-NAME / RECIPIENTS BACKFILL, REHEARSED AGAINST REAL POSTGRES.
 *
 * ── WHY NOT PGLITE ─────────────────────────────────────────────────────────────────────────
 *
 * Three of the claims this pass makes are claims ABOUT POSTGRES and are green by construction
 * anywhere else: the `jsonb ? 'from'` key-presence predicate that decides candidacy, the
 * `to_addresses = '[]'::jsonb` comparison that decides "unset", and the guarded UPDATE that is
 * supposed to lose to a concurrent writer. The last one needs two connections to mean anything.
 *
 * ── THE FIXTURES ARE BUILT BY INGEST'S OWN PARSER ──────────────────────────────────────────
 *
 * Every row is seeded from a raw message run through `normalizeMime`, storing exactly what
 * ingest stores (`headers`) and deliberately NOT storing what the pre-0057 ingest could not
 * (`from_name`, `to_addresses`, `cc_addresses`). The assertion is then that the pass recovers
 * the values that same `normalizeMime` produced — so the test cannot pass by the pass and the
 * fixture agreeing on a wrong answer.
 */

const AVAILABLE = await realPgAvailable();

describe.skipIf(!AVAILABLE)("the sender-name / recipients backfill", () => {
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let sql: ReturnType<typeof postgres>;

  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    sql = postgres(PG_TEST_URL, { max: 4, onnotice: () => {} });
    db = brandDialect(drizzle(sql, { schema }), "pg");
  }, 120_000);

  afterAll(async () => { await sql.end({ timeout: 5 }); });

  async function seedAccount(): Promise<{ accountId: string; mailboxId: string }> {
    const accountId = randomUUID();
    await db.insert(accounts).values({ id: accountId, name: `bf-${accountId.slice(0, 8)}` });
    const [mb] = await db.insert(mailboxes).values({
      accountId, provider: "imap", address: `bf-${accountId.slice(0, 8)}@example.test`,
    }).returning();
    return { accountId, mailboxId: mb!.id };
  }

  /** A row exactly as a PRE-0057 ingest left it: headers stored, the three columns unset. */
  async function seedHistorical(
    w: { accountId: string; mailboxId: string },
    raw: string,
  ): Promise<{ id: string; expected: Awaited<ReturnType<typeof normalizeMime>> }> {
    const norm = await normalizeMime(raw);
    const [m] = await db.insert(messages).values({
      accountId: w.accountId, mailboxId: w.mailboxId, bodyHash: "h",
      dedupKey: `bf:${randomUUID()}`,
      subject: norm.subject, fromAddress: norm.from.address,
      // The three columns the old ingest could not write. Left at their defaults on purpose.
      date: norm.date, nativeLocator: { folder: "INBOX", ref: `1:${randomUUID()}` },
    }).returning();
    await db.insert(messageBodies).values({
      messageId: m!.id, accountId: m!.accountId, text: norm.textBody, html: norm.htmlBody,
      // The spread is the same load-bearing one `drizzle-repo.ts:705` documents: `normalizeMime`
      // returns a NULL-PROTOTYPE header map, and drizzle's own `is()` reads `value.constructor`
      // on what it is handed — which throws on such an object before a single row is written.
      headers: { ...norm.headers },
    });
    return { id: m!.id, expected: norm };
  }

  function eml(headers: string[], body = "hello"): string {
    return [...headers, "Content-Type: text/plain; charset=utf-8", "", body].join("\r\n");
  }

  /**
   * EVERY run in this file is ACCOUNT-SCOPED, and that is not tidiness. The :5433 database is
   * shared by the whole suite and lives across files, so an unscoped `written`/`skipped` count
   * would include whatever another test file left behind — a number that is right today and
   * silently wrong the day someone seeds a message with a From header two files over.
   */
  const run = (w: { accountId: string }, apply: boolean, extra: Record<string, unknown> = {}) =>
    runSenderNameBackfill({ db: db as unknown as Tx, apply, batch: 3, accountId: w.accountId, ...extra });

  async function row(id: string) {
    const [m] = await db.select().from(messages).where(eq(messages.id, id));
    return m!;
  }

  async function changeRows(accountId: string, id: string) {
    return db.select().from(changeLog).where(and(
      eq(changeLog.accountId, accountId), eq(changeLog.entityId, id),
    ));
  }

  it("recovers exactly what ingest's own parser produced, and emits one change per row", async () => {
    const w = await seedAccount();
    const named = await seedHistorical(w, eml([
      "From: Papierwerk Studio <hello@Papierwerk.example>",
      "To: Mila <mila@lichtgrat.example>, second@example.test",
      "Cc: Carla <carla@example.test>",
    ]));
    const encoded = await seedHistorical(w, eml([
      "From: =?UTF-8?Q?J\x3dC3\x3dBCrgen_M\x3dC3\x3dBCller?= <juergen@example.test>",
      "To: mila@lichtgrat.example",
    ]));

    // The dry run counts and writes NOTHING — including no change-log row, which is the half a
    // "dry run" is easiest to get wrong.
    const dry = await run(w, false);
    expect(dry.fillable).toBeGreaterThanOrEqual(2);
    expect(dry.written).toBe(0);
    expect(await row(named.id)).toMatchObject({ fromName: null, toAddresses: [], ccAddresses: [] });
    expect(await changeRows(w.accountId, named.id)).toHaveLength(0);

    const applied = await run(w, true);
    expect(applied.written).toBeGreaterThanOrEqual(2);

    // Not a hand-written expectation: the value `normalizeMime` itself produced from the raw
    // message, which is what ingest would have written had the column existed.
    const n = await row(named.id);
    expect(n.fromName).toBe(named.expected.from.name);
    expect(n.fromName).toBe("Papierwerk Studio");
    expect(n.toAddresses).toEqual(named.expected.to);
    expect(n.ccAddresses).toEqual(named.expected.cc);
    expect((n.toAddresses as unknown[]).length).toBe(2);

    const e = await row(encoded.id);
    expect(e.fromName).toBe(encoded.expected.from.name);
    expect(e.fromName).toBe("Jürgen Müller");

    // ONE `message` update per written row — the obligation 0057 wrote down. Without it the
    // columns are right in Cloud and wrong on every mirror until a re-bootstrap.
    const ch = await changeRows(w.accountId, named.id);
    expect(ch).toHaveLength(1);
    expect(ch[0]).toMatchObject({ entityType: "message", op: "update" });
  }, 120_000);

  it("leaves a bare address nameless rather than inventing a name from it", async () => {
    const w = await seedAccount();
    const bare = await seedHistorical(w, eml(["From: bare@example.test", "To: mila@lichtgrat.example"]));

    const r = await run(w, true);
    expect(r.noDisplayName).toBeGreaterThanOrEqual(1);
    const m = await row(bare.id);
    expect(m.fromName).toBeNull();
    // The recipients half of the SAME row is written by the same UPDATE — an unnameable sender
    // does not cost the row its To line. (What DOES take the recipients down with it is a
    // competing writer on `from_name`; the guarded-update tests below are where that lives.)
    expect(m.toAddresses).toEqual(bare.expected.to);
  }, 120_000);

  it("never overwrites a value that is already there", async () => {
    const w = await seedAccount();
    const seeded = await seedHistorical(w, eml([
      "From: Header Name <someone@example.test>",
      "To: header-to@example.test",
    ]));
    await db.update(messages)
      .set({ fromName: "A Name The User Or Ingest Wrote", toAddresses: [{ name: null, address: "kept@example.test" }] })
      .where(eq(messages.id, seeded.id));

    await run(w, true);
    const m = await row(seeded.id);
    expect(m.fromName).toBe("A Name The User Or Ingest Wrote");
    expect(m.toAddresses).toEqual([{ name: null, address: "kept@example.test" }]);
    // Nothing was writable, so nothing was written and no mirror is told to re-read the row.
    expect(await changeRows(w.accountId, seeded.id)).toHaveLength(0);
  }, 120_000);

  it("is idempotent: a second apply writes nothing and emits no further changes", async () => {
    const w = await seedAccount();
    const a = await seedHistorical(w, eml([
      "From: Once Only <once@example.test>", "To: mila@lichtgrat.example",
    ]));

    const first = await run(w, true);
    expect(first.written).toBeGreaterThanOrEqual(1);
    const second = await run(w, true);
    // `scanned` does NOT go to zero — a nameless sender stays a candidate for ever, which is why
    // `fillable`/`written` is the number that says the work is done.
    expect(second.written).toBe(0);
    expect(second.fillable).toBe(0);
    expect(await changeRows(w.accountId, a.id)).toHaveLength(1);
  }, 120_000);

  /**
   * THE PROGRESS LINES SURVIVE THE REAL LOGGER'S CENSUS — and carry no mail.
   *
   * Driven through `createLogger`'s `sink` seam and asserted on the emitted BYTES, because that
   * is the only place `ALLOWED_FIELDS` has already run. A fake logger asserts what the call site
   * HANDS OVER, which is exactly how the attach-phase and sensitivity-repair fields shipped as
   * `droppedFields` with green suites — `packages/core/src/log.ts` records both incidents.
   *
   * Two directions, and the second is the one that matters more: the counters must be PRESENT,
   * and no display name or address may be anywhere in the bytes.
   */
  it("logs counts through the real logger, with nothing dropped and no mail in the line", async () => {
    const w = await seedAccount();
    await seedHistorical(w, eml([
      "From: Loggable Sender <loggable@example.test>", "To: recipient@example.test",
    ]));

    const lines: string[] = [];
    await runSenderNameBackfill({
      db: db as unknown as Tx, apply: true, batch: 3, accountId: w.accountId,
      log: createLogger({ service: "sender-name-backfill", sink: (s) => { lines.push(s); } }),
    });

    const complete = lines.find((l) => l.includes("sender_name_backfill_complete"));
    expect(complete, "no completion line was emitted").toBeDefined();
    // Anti-vacuity: the census reports what it refused, so this is the assertion that would have
    // caught the two incidents above.
    expect(complete).not.toContain("droppedFields");
    for (const key of ["scanned", "fillable", "written"]) expect(complete).toContain(`"${key}"`);

    const all = lines.join("\n");
    expect(all).not.toContain("Loggable Sender");
    expect(all).not.toContain("loggable@example.test");
    expect(all).not.toContain("recipient@example.test");
    // The field NAMES too: a key called `fromName` on a log line is one refactor away from
    // carrying the name instead of the count of them.
    expect(all).not.toContain("fromName");
    expect(all).not.toContain("toAddresses");
  }, 120_000);

  it("a row with no address headers at all is not a candidate", async () => {
    const w = await seedAccount();
    const [m] = await db.insert(messages).values({
      accountId: w.accountId, mailboxId: w.mailboxId, bodyHash: "h",
      dedupKey: `bf:${randomUUID()}`, subject: "no headers", fromAddress: "x@example.test",
      nativeLocator: { folder: "INBOX", ref: `1:${randomUUID()}` },
    }).returning();
    await db.insert(messageBodies).values({ messageId: m!.id, accountId: m!.accountId, text: "", html: null, headers: {} });

    const before = await run(w, false);
    expect(before.fillable).toBe(0);
    await run(w, true);
    expect((await row(m!.id)).fromName).toBeNull();
    expect(await changeRows(w.accountId, m!.id)).toHaveLength(0);
  }, 120_000);

  it("a header bag whose value is not a string does not stop the page", async () => {
    const w = await seedAccount();
    const good = await seedHistorical(w, eml([
      "From: Good Sender <good@example.test>", "To: mila@lichtgrat.example",
    ]));
    const [bad] = await db.insert(messages).values({
      accountId: w.accountId, mailboxId: w.mailboxId, bodyHash: "h",
      dedupKey: `bf:${randomUUID()}`, subject: "junk headers", fromAddress: "j@example.test",
      nativeLocator: { folder: "INBOX", ref: `1:${randomUUID()}` },
    }).returning();
    // `message_bodies.headers` is jsonb through `JSON.parse`; nothing at the type level stops
    // this shape reaching the pass, and one bad row must not cost every other row its name.
    await db.insert(messageBodies).values({
      messageId: bad!.id, accountId: bad!.accountId, text: "", html: null,
      headers: { from: [17], to: "not-an-array" } as unknown as Record<string, string[]>,
    });

    const r = await run(w, true);
    expect(r.written).toBeGreaterThanOrEqual(1);
    expect((await row(good.id)).fromName).toBe("Good Sender");
    expect((await row(bad!.id)).fromName).toBeNull();
  }, 120_000);

  it("pages: a batch smaller than the table still walks every row exactly once", async () => {
    const w = await seedAccount();
    const ids: string[] = [];
    for (let i = 0; i < 7; i++) {
      const s = await seedHistorical(w, eml([
        `From: Sender ${i} <s${i}@example.test>`, "To: mila@lichtgrat.example",
      ]));
      ids.push(s.id);
    }

    const r = await run(w, true, { batch: 2 });
    expect(r.written).toBe(7);
    for (let i = 0; i < 7; i++) {
      expect((await row(ids[i]!)).fromName).toBe(`Sender ${i}`);
      expect(await changeRows(w.accountId, ids[i]!)).toHaveLength(1);
    }
  }, 120_000);

  /**
   * THE GUARDED UPDATE, AGAINST A WRITER THAT LANDS BETWEEN THE PAGE READ AND THE WRITE.
   *
   * This is the only window that matters and it is invisible from outside: the page SELECT runs
   * outside the transaction on purpose, so between "this row's `from_name` is NULL and the
   * header says Alpha One" and the UPDATE, an ingest or a mirror can commit a name of its own.
   * The read-time check cannot see that; only the repeated `is null` in the UPDATE's WHERE can.
   *
   * `onPageRead` is the seam that puts a committed competing write in exactly that window, and
   * the mutation that proves the assertion is real is dropping the `is null` guard from the
   * UPDATE — with it gone this row comes back "Alpha One" and the test is red.
   */
  it("loses to a writer that lands between the page read and the write", async () => {
    const w = await seedAccount();
    const target = await seedHistorical(w, eml([
      "From: Alpha One <alpha@example.test>", "To: mila@lichtgrat.example",
    ]));

    let landed = false;
    const r = await runSenderNameBackfill({
      db: db as unknown as Tx, apply: true, batch: 10, accountId: w.accountId,
      onPageRead: async (ids) => {
        if (landed || !ids.includes(target.id)) return;
        landed = true;
        await db.update(messages).set({ fromName: "Written By Somebody Else" })
          .where(eq(messages.id, target.id));
      },
    });

    expect(landed, "the competing write never reached the window").toBe(true);
    expect((await row(target.id)).fromName).toBe("Written By Somebody Else");

    /* THE WHOLE ROW DROPS, INCLUDING THE RECIPIENTS THAT NOBODY CONTENDED FOR — and this
       assertion is here because the first version of it claimed the opposite. It read "per
       column, not per row: an already-named sender does not cost the row its To line", the
       source carried a matching comment, and the test went red on `[]`. The guards are ANDed
       into ONE UPDATE, so a competitor on `from_name` takes the recipients down with it.

       That is the intended behaviour, not a defect the test was bent around: a row is either
       wholly as this pass computed it or wholly untouched, never one run's parse mixed with
       another's — and the next run recovers it, which the two lines below prove rather than
       assert in a comment. */
    expect((await row(target.id)).toAddresses).toEqual([]);
    expect(r.skipped).toBe(1);
    expect(r.written).toBe(0);

    const again = await run(w, true);
    expect(again.written).toBe(1);
    expect((await row(target.id)).toAddresses).toEqual(target.expected.to);
    expect((await row(target.id)).fromName).toBe("Written By Somebody Else");
    // One change-log row, from the run that actually wrote — not from the one that skipped.
    expect(await changeRows(w.accountId, target.id)).toHaveLength(1);
  }, 120_000);

  /**
   * The same race with NOTHING else on the row to write. Here the guard is the only thing
   * standing between the competitor's value and this pass's, and the row must fall out as
   * `skipped` rather than being overwritten or silently counted as written.
   */
  it("counts a row it loses entirely as skipped", async () => {
    const w = await seedAccount();
    const target = await seedHistorical(w, eml(["From: Solo Sender <solo@example.test>"]));

    let landed = false;
    const r = await runSenderNameBackfill({
      db: db as unknown as Tx, apply: true, batch: 10, accountId: w.accountId,
      onPageRead: async (ids) => {
        if (landed || !ids.includes(target.id)) return;
        landed = true;
        await db.update(messages).set({ fromName: "Nobody Else's Business" })
          .where(eq(messages.id, target.id));
      },
    });

    expect(landed).toBe(true);
    expect((await row(target.id)).fromName).toBe("Nobody Else's Business");
    expect(r.skipped).toBe(1);
    expect(r.written).toBe(0);
    // Nothing was written, so no mirror is told to re-read a row this pass did not change.
    expect(await changeRows(w.accountId, target.id)).toHaveLength(0);
  }, 120_000);
});
