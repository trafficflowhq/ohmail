import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "../src/dialect/index.js";
import { runMigrations } from "../src/admin.js";
import { SMTP_SIZE_PROBE_CODES } from "../src/mailbox-errors.js";
import { PG_TEST_URL, realPgAvailable } from "../src/testing.js";

/**
 * MAIL 0063 APPLIED AND VERIFIED ON REAL POSTGRES — the two columns, the closed-set CHECK watched
 * REFUSING, and the migration replayed to prove it is a no-op the second time.
 *
 * ── WHY NONE OF THIS CAN BE A PGLITE TEST ───────────────────────────────────────────────────
 *
 * Three of the four questions here are questions about a database built by the real migrator against
 * a shared, already-migrated instance, which is precisely what an in-process replay of the journal
 * into an empty database cannot answer:
 *
 *  · **did the entry APPLY at all.** drizzle applies an entry iff the greatest `created_at` in the
 *    journal's own table is BELOW that entry's `when`, so a `when` at or under the maximum is
 *    skipped silently and for ever (`packages/db-mail/drizzle/README.md`, step 2). This journal's
 *    maximum was *behind the cloud journal's* when 0063 was written, so the value had to clear the
 *    larger of the two — and a fresh database makes that comparison vacuous.
 *  · **is the CHECK really there.** `information_schema.columns` is blind to constraints. A column
 *    present WITHOUT its constraint accepts whatever a write site lets through and says nothing,
 *    which is the exact asymmetry `mailboxes_disabled_reason_closed` exists to close — and here the
 *    value being constrained is derived from an SMTP server's own AUTH response, so the constraint is
 *    a privacy boundary and not tidiness.
 *  · **is the migration REPLAYABLE.** Every statement is guarded (`ADD COLUMN IF NOT EXISTS`, and a
 *    `DROP CONSTRAINT IF EXISTS` before the `ADD`, because `ADD CONSTRAINT` has no `IF NOT EXISTS`).
 *    That is a claim about Postgres's DDL semantics, so it is tested by running the file's statements
 *    a second time over a database that already has them and asserting the catalog is unchanged.
 */
const PG_UP = await realPgAvailable();

const client = postgres(PG_TEST_URL, { max: 2, onnotice: () => {} });
const db = brandDialect(drizzle(client), "pg");

/** The constraint's definition as Postgres itself renders it — the only authority on its members. */
async function probeCodeCheckDef(): Promise<string | null> {
  const rows = await db.execute(sql`
    select pg_get_constraintdef(c.oid) as def
    from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    where t.relname = 'mailboxes' and c.conname = 'mailboxes_smtp_size_probe_code_closed'
  `);
  return (rows as unknown as Array<{ def: string }>)[0]?.def ?? null;
}

beforeAll(async () => {
  if (!PG_UP) return;
  await runMigrations(PG_TEST_URL);
});

afterAll(async () => {
  await client.end({ timeout: 5 }).catch(() => { /* the pool is already down */ });
});

describe.skipIf(!PG_UP)("mail 0063 — the `SIZE` probe's attempt stamp on real Postgres", () => {
  it("the journal entry APPLIED — `when` cleared the target's maximum", async () => {
    const rows = await db.execute(sql`
      select created_at from drizzle_mail.__drizzle_migrations
      order by created_at desc limit 1
    `);
    // 0063's own `when`. Had it been chosen at or below the table's maximum, the migrator would have
    // skipped it in silence and the column assertions below would be the only symptom — reported as
    // "the migration is broken" rather than "the timestamp is wrong".
    expect(Number((rows as unknown as Array<{ created_at: string }>)[0]!.created_at))
      .toBeGreaterThanOrEqual(1790982140527);
  });

  it("both columns exist, are nullable, and carry NO default", async () => {
    const rows = await db.execute(sql`
      select column_name, data_type, is_nullable, column_default
      from information_schema.columns
      where table_schema = 'public' and table_name = 'mailboxes'
        and column_name in ('smtp_size_probed_at', 'smtp_size_probe_code')
      order by column_name
    `);
    const found = rows as unknown as Array<{
      column_name: string; data_type: string; is_nullable: string; column_default: string | null;
    }>;
    expect(found.map((r) => r.column_name), "mail 0063 did not apply")
      .toEqual(["smtp_size_probe_code", "smtp_size_probed_at"]);
    expect(found[0]!.data_type).toBe("text");
    expect(found[1]!.data_type).toBe("timestamp with time zone");
    for (const r of found) {
      expect(r.is_nullable, r.column_name).toBe("YES");
      // NO DEFAULT, and here that is a scheduling property rather than an aesthetic one: a default
      // of `now()` would make every newly connected mailbox look as though it had just been probed,
      // deferring its first probe by a week.
      expect(r.column_default, r.column_name).toBeNull();
    }
  });

  it("NO BACKFILL — the migration file carries no data statement at all", async () => {
    // Unlike 0055's refusal, which is about honesty, this one is about the schedule: writing `now()`
    // across the table would silence the back-fill for a week over rows it has never dialled — the
    // exact work the columns exist to make sustainable. NULL means "never asked", and every existing
    // row is exactly that.
    //
    // ── AND IT IS ASSERTED OVER THE FILE, NOT OVER THE DATA, WHICH THE SIBLING MIGRATION DOES THE OTHER WAY ───
    //
    // The sibling migration's guard reads the TABLE ("no production-shaped row carries a value this migration could
    // have written") and that form is unavailable here — because these two columns have a legitimate
    // writer that runs against this very database: `smtp-size-pass.pg.test.ts` drives the real pass,
    // whose selection is fleet-wide by design, so fixture rows in the shared instance acquire real
    // stamps. A data assertion would then mean "no other suite has run", which is not a claim about
    // this migration and is the kind of red that trains people to ignore a gate.
    //
    // So the claim is made where it is decidable: the statements. Read from the file the migrator
    // runs, and paired with the journal's statement-hash census (`journal-split.test.ts` pins all
    // four hashes, so an APPENDED statement fails there) this closes both directions — a data
    // statement cannot be added without one of the two going red.
    const sqlText = readFileSync(
      new URL("../../db-mail/drizzle/0063_smtp_size_probe_stamp.sql", import.meta.url),
      "utf8",
    );
    const statements = sqlText
      .split("--> statement-breakpoint")
      .map((chunk) => chunk.replace(/^\s*--[^\n]*$/gm, "").trim())
      .filter((chunk) => chunk.length > 0);
    expect(statements).toHaveLength(4);
    for (const st of statements) {
      expect(st, `a data statement reached the migration: ${st.slice(0, 80)}`)
        .not.toMatch(/^\s*(INSERT|UPDATE|DELETE|TRUNCATE)\b/i);
      expect(st.slice(0, 12).toUpperCase()).toContain("ALTER TABLE");
    }
  });

  it("the CHECK is WATCHED REFUSING a value from outside the closed set", async () => {
    const id = randomUUID();
    let constraint = "";
    try {
      // The shape of the leak this constraint exists to stop: nodemailer's AUTH error message
      // embeds the submission server's own response line, which routinely names the user and can
      // echo a credential. A write site that passed the message instead of the code would produce
      // exactly this insert.
      await db.execute(sql`
        insert into mailboxes (id, account_id, provider, address, status, smtp_size_probe_code)
        values (${id}, gen_random_uuid(), 'imap', ${`${id}@probe.test`}, 'connected',
                '535 5.7.8 Authentication failed for u@x with password smtp-probe-password')`);
    } catch (err) {
      constraint = String((err as { constraint_name?: unknown; constraint?: unknown }).constraint_name
        ?? (err as { constraint?: unknown }).constraint ?? "");
    } finally {
      await db.execute(sql`delete from mailboxes where id = ${id}::uuid`);
    }
    expect(constraint).toBe("mailboxes_smtp_size_probe_code_closed");
  });

  it("…and ACCEPTS every member of the taxonomy, plus NULL", async () => {
    // The other direction, which is the half that catches a constraint narrower than the code that
    // writes it: the pass would then fail its own stamp write and stop remembering anything, which
    // reads as the dial-every-day defect coming back.
    for (const code of [...SMTP_SIZE_PROBE_CODES, null]) {
      const id = randomUUID();
      try {
        await db.execute(sql`
          insert into mailboxes (id, account_id, provider, address, status, smtp_size_probe_code)
          values (${id}, gen_random_uuid(), 'imap', ${`${id}@probe.test`}, 'connected', ${code})`);
      } finally {
        await db.execute(sql`delete from mailboxes where id = ${id}::uuid`);
      }
    }
  });

  it("the constraint's members are EXACTLY the TypeScript taxonomy — neither side may drift", async () => {
    // `SMTP_SIZE_PROBE_CODES` is what the compiler enforces at the write site; this is what the
    // database enforces for every other writer. A member in one and not the other is either a code
    // the pass can never store (its own write raises 23514) or a value the column would accept from
    // a hand-run UPDATE with no reader for it.
    const def = await probeCodeCheckDef();
    expect(def, "the CHECK is absent — a column present without it is silently unguarded").not.toBeNull();
    const quoted = [...(def ?? "").matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);
    expect([...quoted].sort()).toEqual([...SMTP_SIZE_PROBE_CODES].sort());
  });

  it("REPLAYS as a no-op — every statement is guarded, so a re-run applies zero changes", async () => {
    // The idempotence claim, executed rather than read. The file's statements are run a second time
    // against a database that already has them; if any were unguarded this throws (42701 for the
    // column, 42710 for the constraint) and the catalog comparison never happens.
    const before = await probeCodeCheckDef();
    await db.execute(sql`ALTER TABLE "mailboxes" ADD COLUMN IF NOT EXISTS "smtp_size_probed_at" timestamp with time zone`);
    await db.execute(sql`ALTER TABLE "mailboxes" ADD COLUMN IF NOT EXISTS "smtp_size_probe_code" text`);
    await db.execute(sql`ALTER TABLE "mailboxes" DROP CONSTRAINT IF EXISTS "mailboxes_smtp_size_probe_code_closed"`);
    await db.execute(sql`ALTER TABLE "mailboxes" ADD CONSTRAINT "mailboxes_smtp_size_probe_code_closed" CHECK ("smtp_size_probe_code" IS NULL OR "smtp_size_probe_code" IN ('learned', 'silent', 'auth_refused', 'unreachable', 'tls_refused', 'token_unavailable', 'no_credentials', 'unknown'))`);
    expect(await probeCodeCheckDef()).toBe(before);

    // And the migrator itself, re-run: it must decide there is nothing to apply rather than replay
    // the file. A second row in the journal table for this tag would mean the `when` comparison is
    // not doing what the README says it does.
    const countTag = async (): Promise<number> => {
      const rows = await db.execute(sql`
        select count(*)::int as n from drizzle_mail.__drizzle_migrations
        where created_at >= 1790982140527
      `);
      return (rows as unknown as Array<{ n: number }>)[0]!.n;
    };
    const applied = await countTag();
    await runMigrations(PG_TEST_URL);
    expect(await countTag(), "the migrator applied mail 0063 a second time").toBe(applied);
  }, 60_000);
});
