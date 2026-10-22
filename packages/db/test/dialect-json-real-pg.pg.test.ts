import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { brandDialect, dialect, SQL_TRIM_BLANK } from "../src/dialect/index.js";
import { folderState } from "../src/schema-mail.js";
import { PG_TEST_URL, realPgAvailable, serviceAddressOf, serviceUp } from "../src/testing.js";
import { ELEMENT_CASES, FOLD_CASES, IS_ARRAY_CASES, MERGE_CASES } from "./_dialect-json-cases.js";

/**
 * THE PORTED EXPRESSIONS AGAINST REAL POSTGRES, BESIDE THE SPELLINGS THEY REPLACED.
 *
 * Two things this run answers that no other can. First, PGlite is a build of the server and not
 * the server this ships against: function RESOLUTION is the difference that bites — `trim(a, b)`
 * resolves to `btrim` here and there is no reason to assume the wasm build and the release agree
 * about that, so the port's own spelling is exercised where it will run.
 *
 * Second, and the reason this file exists rather than a note: the constructs the port removed are
 * POSTGRES-ONLY, so the only place the old and the new can be asked the same question is on
 * Postgres. Every case below runs both and compares. That is what "the server's answer did not
 * change" means as a measurement instead of as a claim.
 *
 * Table-free: these are expressions, so this file seeds nothing and can be read on its own.
 */
const URL = PG_TEST_URL;
let client: ReturnType<typeof postgres> | null = null;
let db: ReturnType<typeof drizzle> | null = null;
let available = false;

beforeAll(async () => {
  available = await realPgAvailable(URL);
  if (!available) return;
  client = postgres(URL, { max: 1 });
  db = brandDialect(drizzle(client), "pg");
}, 60_000);

afterAll(async () => { await client?.end(); });

/** One scalar off the real server, positionally through the seam. */
async function one(expr: ReturnType<typeof sql>): Promise<unknown> {
  const rows = await dialect(db!).exec(db!, sql`select ${expr}`);
  expect(rows.length, "the probe returned no row").toBe(1);
  return rows[0]![0];
}

/* The run's one probe (test/setup/services.global.ts): no Postgres skips the file by name; one that
 * is there must answer the first case below. */
const PG = serviceUp("pg", serviceAddressOf(URL, 5432));

describe.skipIf(!PG.up)(`the ported JSON expressions, on the server this ships against${PG.up ? "" : ` (SKIPPED: ${PG.why})`}`, () => {
  it("is talking to a real Postgres and not to the wasm build", async () => {
    // FIRST, and outside any condition derived from it: everything below is vacuous if this file
    // silently ran against nothing, and "no database" and "every case passed" look identical.
    expect(available, `no Postgres at ${URL.replace(/\/\/[^@]*@/, "//")}: run scripts/lane-db.sh`)
      .toBe(true);
    expect(await one(sql`current_setting('server_version_num')::int > 0`)).toBe(true);
  });

  it("merges a JSON document exactly as the inline `||` did", async () => {
    if (!available) return;
    const d = dialect(db!);
    for (const c of MERGE_CASES) {
      const doc = c.document === null ? sql`${null}` : sql`${c.document}`;
      const ported = await one(d.jsonMergeShallow(doc, sql`${c.patch}`));
      // THE SPELLING THAT WAS THERE, asked of the same inputs. Both sides are jsonb, so this is
      // an equality of documents and not of text.
      const before = await one(sql`(coalesce(${doc}::jsonb, '{}'::jsonb) || (${c.patch})::jsonb)`);
      expect(ported, `${c.what}: the port and the inline form disagree`).toEqual(before);
      expect(ported, c.what).toEqual(c.expected);
    }
  });

  it("answers `is this an array` exactly as `jsonb_typeof` did", async () => {
    if (!available) return;
    const d = dialect(db!);
    for (const c of IS_ARRAY_CASES) {
      const doc = d.castJsonb(sql`${c.document}`);
      expect(await one(d.jsonIsArray(d.jsonGet(doc, c.key))) === true, c.what).toBe(c.isArray);
      expect(await one(sql`jsonb_typeof(${doc} -> ${c.key}) = 'array'`) === true, c.what)
        .toBe(c.isArray);
    }
  });

  it("reads a JSON array's string members exactly as the inline `#>>` arm did", async () => {
    if (!available) return;
    const d = dialect(db!);
    for (const c of ELEMENT_CASES) {
      const doc = d.castJsonb(sql`${c.document}`);
      const el = d.jsonArrayElements(d.jsonGet(doc, c.key), "el");
      const ported = await d.exec(db!, sql`select ${el.text} from ${el.from} where ${el.isString}`);
      expect(ported.map((r) => r[0]), c.what).toEqual([...c.strings]);
      const before = await d.exec(db!, sql`
        select (e.value #>> '{}') from jsonb_array_elements(${doc} -> ${c.key}) as e(value)
         where jsonb_typeof(e.value) = 'string'`);
      expect(before.map((r) => r[0]), `${c.what}: the port and the inline arm disagree`)
        .toEqual(ported.map((r) => r[0]));
    }
  });

  /**
   * THE TWO REGEX ARMS, value by value against the operators they replaced.
   *
   * `!~*` and `~*` have no counterpart on the device store, so this pairing can only be measured
   * here — and it is the whole evidence that the away-responder predicate answers what it did.
   * The NBSP row is the residual: neither spelling strips it, so both say "machine-sent".
   */
  it("folds and searches exactly as the regex operators did", async () => {
    if (!available) return;
    const d = dialect(db!);
    const NEEDLES = ["bulk", "autoreply", "auto_reply", "junk", "list"];
    for (const c of FOLD_CASES) {
      const folded = sql`lower(trim(${c.value}, ${SQL_TRIM_BLANK}))`;
      const notNo = await one(sql`${folded} <> 'no'`);
      const before = await one(sql`${c.value} !~* '^[[:space:]]*no[[:space:]]*$'`);
      expect(notNo, `${JSON.stringify(c.value)}: not-no`).toBe(c.notNo);
      expect(before, `${JSON.stringify(c.value)}: the regex and the trim disagree`).toBe(notNo);

      const holds = sql`(${sql.join(
        NEEDLES.map((n) => sql`${d.strpos(folded, sql`${n}`)} > 0`), sql` or `)})`;
      const prec = await one(holds);
      const precBefore = await one(sql`${c.value} ~* 'bulk|auto_?reply|junk|list'`);
      expect(prec, `${JSON.stringify(c.value)}: precedence`).toBe(c.precedence);
      expect(precBefore, `${JSON.stringify(c.value)}: the regex and the searches disagree`)
        .toBe(prec);
    }
  });

  /** `trim(a, b)` is `btrim(a, b)` here, and that is the whole reason the ledger arm could move. */
  it("resolves the two-argument trim the same way `btrim` does", async () => {
    if (!available) return;
    expect(await one(sql`trim(${"<a@b.test>"}, '<>') = btrim(${"<a@b.test>"}, '<>')`)).toBe(true);
    expect(await one(sql`trim(${"<a@b.test>"}, '<>')`)).toBe("a@b.test");
  });

  /**
   * THE DTO'S TIMESTAMP LABEL — `toISOString()` against the `to_char` pattern it replaced.
   *
   * Microsecond-precision instants, because that is where the two could differ: the pattern's `MS`
   * truncates to three digits and so does a JavaScript `Date`. A round-trip that ROUNDED would
   * change one byte of a wire field on the server, which is exactly what this port must not do.
   *
   * THROUGH THE COLUMN'S OWN DECODER, which is what the DTO does and what PGlite could not have
   * shown: this driver hands a timestamptz back as a STRING, rendered at the session's own time
   * zone (`… 12:20:30.123456+02` here), and the wasm build hands back the same shape only by
   * coincidence of configuration. `mapWith(<column>)` is therefore load-bearing rather than
   * decoration — without it the DTO would hold a string and `.toISOString()` would throw — so the
   * decoder is the thing under test, applied to the real server's own bytes.
   */
  it("labels an instant exactly as the `to_char` pattern did", async () => {
    if (!available) return;
    const ISO = 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"';
    const stamps = [
      "2026-09-11 10:20:30.123456+00", "2026-09-11 10:20:30.999999+00",
      "2026-09-11 10:20:30.000001+00", "2026-09-11 10:20:30.999500+00",
      "2026-09-11 10:20:30.1+00", "2026-09-11 10:20:30+00",
    ];
    for (const s of stamps) {
      const rows = await dialect(db!).exec(db!, sql`
        select to_char((${s})::timestamptz at time zone 'utc', ${ISO}), (${s})::timestamptz`);
      const [label, raw] = rows[0]!;
      const instant = folderState.updatedAt.mapFromDriverValue(raw) as Date;
      expect(instant instanceof Date, `${s}: the column decoder did not produce a Date`).toBe(true);
      expect(instant.toISOString(), s).toBe(label);
    }
  });

  /**
   * THE ORDERED PICK — the subquery against the `array_agg(… order by …)[1]` it replaced.
   *
   * Same rows, same order, same first value, over a table this file makes and drops so it needs
   * no schema. What it pins is the ORDERING, including the `desc` on a nullable column, which is
   * where a rewrite of an ordered aggregate is easiest to get subtly wrong.
   */
  it("picks the first row by the same order an ordered aggregate did", async () => {
    if (!available) return;
    const t = `dialect_pick_${process.pid}`;
    await client!.unsafe(`create temporary table ${t} (cls text, attempts int, next timestamptz)`);
    try {
      await client!.unsafe(`insert into ${t} values
        ('refused', 1, '2026-01-01T00:00:00Z'), ('bounds', 3, '2026-01-02T00:00:00Z'),
        ('bounds', 3, '2026-01-03T00:00:00Z'), ('gone', 2, null), (null, 9, null)`);
      const agg = await client!.unsafe(
        `select (array_agg(cls order by attempts desc, next desc)
                 filter (where cls is not null))[1] as v from ${t}`);
      const pick = await client!.unsafe(
        `select (select cls from ${t} where cls is not null
                  order by attempts desc, next desc limit 1) as v`);
      expect(pick[0]!.v, "the subquery and the ordered aggregate disagree").toBe(agg[0]!.v);
      expect(pick[0]!.v).toBe("bounds");
    } finally {
      await client!.unsafe(`drop table if exists ${t}`);
    }
  });
});
