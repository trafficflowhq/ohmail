import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { ensureConcurrentIndexes, plainIndexDdl } from "../src/concurrent-index.js";
import { HOT_PATH_INDEX_SPECS, ensureHotPathIndexes } from "../src/hot-path-indexes.js";
import { TRIGRAM_INDEX_SPECS } from "../src/search-setup.js";
import { makeTestDb } from "../src/testing.js";

/**
 * A STORE NOTHING ELSE WRITES TO WHILE IT BUILDS takes the plain form of every index statement —
 * the desktop's PGlite, opened before it serves. Every shipped spec has exactly one plain form; a
 * statement without the clause, or with two, is refused rather than rewritten into something
 * else; and a plain build on PGlite leaves valid indexes. The server path passes nothing and keeps
 * `concurrently`.
 */
const render = (q: ReturnType<typeof sql>): string => new PgDialect().sqlToQuery(q).sql;

describe("the plain form of an index statement", () => {
  it("every shipped spec has one, which says `create index` and never `concurrently`", () => {
    const specs = [...TRIGRAM_INDEX_SPECS, ...HOT_PATH_INDEX_SPECS];
    expect(specs.length).toBeGreaterThan(2);
    for (const spec of specs) {
      expect(render(spec.ddl), spec.name).toMatch(/create index concurrently/i);
      const plain = render(plainIndexDdl(spec.ddl));
      expect(plain, spec.name).not.toMatch(/concurrently/i);
      expect(plain, spec.name).toMatch(/^\s*create index (if not exists )?"/i);
      expect(plain.replace(/\s+/g, " "), spec.name)
        .toBe(render(spec.ddl).replace(/create index concurrently/i, "create index").replace(/\s+/g, " "));
    }
  });

  it("refuses a statement with no such clause and one with two", () => {
    expect(() => plainIndexDdl(sql`create index if not exists "x" on public.messages ("id")`)).toThrow(/0 "create index concurrently"/);
    expect(() => plainIndexDdl(sql`create index concurrently "a" on t (x); create index concurrently "b" on t (y)`))
      .toThrow(/2 "create index concurrently"/);
  });

  /* A test hook builds the hot-path indexes plain: a concurrent build waits on every older snapshot. */
  it("ensureHotPathIndexes passes `concurrently: false` through, rebuild arm included; the default stays concurrent", async () => {
    const run = async (opts?: { concurrently: false }): Promise<string[]> => {
      const sent: string[] = [];
      const fake = {
        execute: async (q: ReturnType<typeof sql>) => {
          const text = render(q);
          sent.push(text);
          if (text.includes("information_schema.tables")) return [{ present: true }];
          if (text.includes("indisvalid")) return [{ valid: false }];   // force the rebuild arm
          return [];
        },
      };
      await (opts ? ensureHotPathIndexes(fake, opts) : ensureHotPathIndexes(fake));
      return sent;
    };
    const control = await run();
    expect(control.filter((q) => /^\s*create index concurrently/i.test(q)).length, "the default builds concurrently").toBeGreaterThan(2);
    expect(control.filter((q) => /^drop index concurrently/i.test(q)).length, "the default drops concurrently").toBeGreaterThan(2);
    const plain = await run({ concurrently: false });
    expect(plain.filter((q) => /^\s*create index/i.test(q)).length, "the plain run builds as many")
      .toBe(control.filter((q) => /^\s*create index/i.test(q)).length);
    expect(plain.filter((q) => /^drop index/i.test(q)).length).toBeGreaterThan(2);
    expect(plain.filter((q) => /concurrently/i.test(q))).toEqual([]);
  });

  it("a plain build on PGlite leaves every index valid and never sends `concurrently`", async () => {
    const db = await makeTestDb();
    // PGlite ACCEPTS a concurrent build, so validity alone cannot tell the two paths apart: the
    // statements the helper sends are recorded and read.
    const sent: string[] = [];
    const recording = { execute: (q: ReturnType<typeof sql>) => { sent.push(render(q)); return db.execute(q); } };
    await db.execute(sql.raw(`drop index if exists public."${HOT_PATH_INDEX_SPECS[0]!.name}"`));
    await ensureConcurrentIndexes(recording, HOT_PATH_INDEX_SPECS.map((s) => ({ ...s, minRows: undefined })), {
      label: "the plain build", concurrently: false,
    });
    const names = HOT_PATH_INDEX_SPECS.map((s) => s.name);
    const rows = (await db.execute(sql`
      select c.relname as name, i.indisvalid as valid from pg_index i join pg_class c on c.oid = i.indexrelid
       where c.relname in (${sql.join(names.map((n) => sql`${n}`), sql`, `)})`)) as unknown as { rows: Array<{ name: string; valid: boolean }> };
    expect(rows.rows.map((r) => r.name).sort()).toEqual([...names].sort());
    expect(rows.rows.every((r) => r.valid)).toBe(true);
    expect(sent.filter((q) => /^\s*create index/i.test(q)).length, "at least one index was built here").toBeGreaterThan(0);
    expect(sent.filter((q) => /concurrently/i.test(q))).toEqual([]);
  });
});
