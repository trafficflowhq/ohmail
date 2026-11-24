import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// The 1.0 road and nothing after it: the reissue is that road's, and a replay over it stops there.
import { migrateToOldHeads } from "../src/migrate.js";
import { OLD_HEADS } from "../src/journal-heads.js";
import { pgTestUrl } from "../src/testing.js";

/**
 * THE REISSUED MIGRATION'S THREE POPULATIONS, on real Postgres — the folders foundation's
 * review rounds 1–3 (see `REISSUED_ORIGINALS` in `src/baseline.ts` for the whole account):
 *
 *  · a FRESH replay applies 0066 and no-ops 0069, and the bookkeeping is complete;
 *  · the SKIP WINDOW — a database whose watermark passed 0066's `when` before the entry
 *    existed — is healed by 0069 (the column arrives) AND handed 0066's bookkeeping row (the
 *    adoption), so `journalStatuses` stops reporting the journal incomplete over a column
 *    that exists. This is the population the canonical setup path used to ABORT on;
 *  · re-running records nothing — the adoption is idempotent under the unique `created_at`
 *    index, exactly as `adoptBaseline` is.
 *
 * And the BYTE-COPY property: drizzle stores the sha256 of the file it applied, a database
 * that ran the intermediate retimed repair holds 0066's file hash at the reissue's `when`,
 * and only identical bytes make that row describe the current journal entry. Asserted here
 * against the files, so a later edit to either file goes red instead of silently forking
 * the story the bookkeeping tells.
 *
 * A THROWAWAY database (search-extensions.pg.test.ts's harness): the skip window is reached
 * by un-recording two rows and dropping the column, which must never happen to the shared
 * accumulator other files migrate against.
 */

const ADMIN_URL = pgTestUrl(import.meta.url);

const PROBE_DB = `ohmail_reissue_probe_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
const probeUrl = (): string => {
  const u = new URL(ADMIN_URL);
  u.pathname = `/${PROBE_DB}`;
  return u.toString();
};

const ORIGINAL_WHEN = 1790982140530;
const REISSUE_WHEN = 1791154940527;
const MAIL_DIR = join(__dirname, "..", "..", "db-mail", "drizzle");

let PG_UP = false;
let admin: ReturnType<typeof postgres> | null = null;

beforeAll(async () => {
  try {
    admin = postgres(ADMIN_URL, { connection: { statement_timeout: 0, lock_timeout: 0 }, max: 1, prepare: false, connect_timeout: 5 });
    await admin`select 1`;
    PG_UP = true;
    await admin.unsafe(`create database "${PROBE_DB}"`);
  } catch {
    PG_UP = false;
  }
}, 30_000);

afterAll(async () => {
  if (admin && PG_UP) {
    await admin.unsafe(`drop database if exists "${PROBE_DB}" with (force)`).catch(() => {});
  }
  await admin?.end({ timeout: 5 });
}, 30_000);

describe("the reissued folders migration heals every population it names", () => {
  it("byte-copy: 0069's file IS 0066's file, so one hash describes both entries", () => {
    const a = readFileSync(join(MAIL_DIR, "0066_folders_enabled.sql"));
    const b = readFileSync(join(MAIL_DIR, "0069_folders_enabled_reissue.sql"));
    expect(createHash("sha256").update(a).digest("hex"))
      .toBe(createHash("sha256").update(b).digest("hex"));
  });

  it("fresh replay, the skip window, and idempotence — on real Postgres", async () => {
    if (!PG_UP) return; // no docker Postgres on this machine — the pg harness's standing skip
    const url = probeUrl();

    // ── 1. Fresh replay: complete bookkeeping, both rows present. ──
    await migrateToOldHeads(url);
    const db = postgres(url, { max: 1, prepare: false });
    try {
      const rowsAt = async (when: number): Promise<number> =>
        Number((await db`select count(*)::int as n from drizzle_mail.__drizzle_migrations
                          where created_at = ${when}`)[0]!.n);
      expect(await rowsAt(ORIGINAL_WHEN), "fresh replay applies 0066").toBe(1);
      expect(await rowsAt(REISSUE_WHEN), "fresh replay applies 0069").toBe(1);

      // ── 2. THE SKIP WINDOW, simulated exactly: no row for either entry, no column —
      //       the state of a database whose watermark passed 0066 before the entry existed.
      //       Every row ABOVE the reissue goes too (0070 and anything later): the skipped
      //       population's watermark is 0067/0068-era by construction — a database that
      //       reached 0070 necessarily applied 0069 on the way (the journal is append-only) —
      //       and leaving a later row here would hold the watermark above the reissue, which
      //       is a state no real database can be in. The later entries are idempotent ADD
      //       COLUMN IF NOT EXISTS, so the re-run below re-records them as no-ops. ──
      await db`delete from drizzle_mail.__drizzle_migrations
               where created_at in (${ORIGINAL_WHEN}, ${REISSUE_WHEN})
                  or created_at > ${REISSUE_WHEN}`;
      await db`alter table account_settings drop column if exists folders_enabled_at`;

      await migrateToOldHeads(url);
      const col = await db`select column_name from information_schema.columns
                           where table_name = 'account_settings' and column_name = 'folders_enabled_at'`;
      expect(col.length, "0069 healed the column").toBe(1);
      expect(await rowsAt(REISSUE_WHEN), "0069's own row").toBe(1);
      // THE ADOPTION: the original's row is recorded although the migrator can never reach it.
      expect(await rowsAt(ORIGINAL_WHEN), "0066's bookkeeping row, adopted").toBe(1);

      // …and the canonical verification's own predicate — every journal `when` has a row —
      // asserted through the counts plus the unique index on created_at: rows == entries with
      // uniqueness means no `when` is missing, which is exactly what `journalStatuses` checks.
      const total = Number((await db`select count(*)::int as n from drizzle_mail.__drizzle_migrations`)[0]!.n);
      const entries = (JSON.parse(readFileSync(join(MAIL_DIR, "meta", "_journal.json"), "utf8")) as
        { entries: Array<{ when: number }> }).entries.filter((e) => e.when <= OLD_HEADS.mail.when).length;
      expect(total, "rows match journal entries — nothing missing, nothing extra").toBe(entries);

      // ── 3. Idempotence: a third run records nothing new. ──
      await migrateToOldHeads(url);
      expect(Number((await db`select count(*)::int as n from drizzle_mail.__drizzle_migrations`)[0]!.n))
        .toBe(total);

      // ── 4. THE SUPERSEDED-HASH POPULATION: a database that ran the review-round
      //       intermediate holds the reissue's row under that file's hash; the adoption
      //       rewrites it to the canonical one, so the row describes the shipped journal. ──
      const PRIOR = "ac41c89e9a966ad47bba888d5e867cd8950650ed842f61b4d6852cae487bd111";
      await db`update drizzle_mail.__drizzle_migrations set hash = ${PRIOR}
               where created_at = ${REISSUE_WHEN}`;
      await migrateToOldHeads(url);
      const canonical = createHash("sha256")
        .update(readFileSync(join(MAIL_DIR, "0069_folders_enabled_reissue.sql"))).digest("hex");
      const stored = (await db`select hash from drizzle_mail.__drizzle_migrations
                               where created_at = ${REISSUE_WHEN}`)[0]!.hash as string;
      expect(stored, "the superseded hash is canonicalized").toBe(canonical);
    } finally {
      await db.end({ timeout: 5 });
    }
  }, 180_000);
});
