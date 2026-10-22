// @services: none — PGlite only; its one Postgres URL is a closed port
import { cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { CLOUD_JOURNAL, JOURNALS, MAIL_JOURNAL } from "../src/journal-specs.js";
import type { JournalSpec } from "../src/baseline.js";
import {
  TemplateRefused, buildPgliteTemplate, declaredMigrations, journalMismatch, keyInputs, loadVerifiedTemplate,
  migrateFresh, openFromTarball, pgliteJournalMismatch, resolvedVersion, templateKey, templatePath,
  type TemplateDeps,
} from "../src/testing-template.js";
import { cloneFromTemplate, makeTestDb } from "../src/testing.js";

/**
 * The "Testing bar" invariant FOR THE TEMPLATE: a database cloned from it is the database a fresh replay builds —
 * columns, indexes, constraints, triggers and both journals — and a build or a tarball missing
 * one migration is REFUSED, at the build and again at the readback. The key moves with every
 * input it names. The comparator is shown to bite on the short build before it is trusted.
 */

const BUILD_MS = 180_000;
const scratch = mkdtempSync(join(realpathSync(tmpdir()), "ohmail-template-test-"));
afterAll(() => { rmSync(scratch, { recursive: true, force: true }); });

/** The cloud journal minus its LAST entry: nothing later can depend on the migration removed. */
function shortCloud(): { spec: JournalSpec; dropped: number } {
  const dir = join(scratch, "cloud-short");
  cpSync(CLOUD_JOURNAL.dir, dir, { recursive: true });
  const jpath = join(dir, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(jpath, "utf8")) as { entries: Array<{ when: number; tag: string }> };
  const last = journal.entries.pop()!;
  writeFileSync(jpath, JSON.stringify(journal, null, 2));
  rmSync(join(dir, `${last.tag}.sql`));
  return { spec: { ...CLOUD_JOURNAL, dir }, dropped: Number(last.when) };
}

type Row = Record<string, unknown>;
async function readback(client: PGlite): Promise<Record<string, Row[]>> {
  const user = "NOT IN ('pg_catalog', 'information_schema', 'pg_toast')";
  const q = async (sql: string): Promise<Row[]> => (await client.query<Row>(sql)).rows;
  return {
    columns: await q(`SELECT table_schema, table_name, column_name, ordinal_position, data_type, udt_name,
      is_nullable, column_default FROM information_schema.columns WHERE table_schema ${user} ORDER BY 1, 2, 4`),
    indexes: await q(`SELECT schemaname, tablename, indexname, indexdef FROM pg_indexes
      WHERE schemaname ${user} ORDER BY 1, 2, 3`),
    constraints: await q(`SELECT n.nspname, c.conrelid::regclass::text AS rel, c.conname, pg_get_constraintdef(c.oid) AS def
      FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace WHERE n.nspname ${user} ORDER BY 1, 2, 3`),
    triggers: await q(`SELECT tgrelid::regclass::text AS rel, tgname, pg_get_triggerdef(oid) AS def
      FROM pg_trigger WHERE NOT tgisinternal ORDER BY 1, 2`),
    journals: [
      ...await q(`SELECT 'mail' AS j, id, hash, created_at FROM drizzle_mail.__drizzle_migrations ORDER BY id`),
      ...await q(`SELECT 'cloud' AS j, id, hash, created_at FROM drizzle_cloud.__drizzle_migrations ORDER BY id`),
    ],
  };
}

let good: Buffer;
let bad: Buffer;
let dropped: number;
let short: JournalSpec;

beforeAll(async () => {
  good = await buildPgliteTemplate(join(scratch, "good.tar"));
  ({ spec: short, dropped } = shortCloud());
  const c = new PGlite();
  try {
    await migrateFresh(c, [MAIL_JOURNAL, short]);
    bad = Buffer.from(await (await c.dumpDataDir("none")).arrayBuffer());
  } finally {
    await c.close();
  }
}, BUILD_MS);

describe("a database from the template is the database a fresh replay builds", () => {
  it("columns, indexes, constraints, triggers and both journals read back identical", async () => {
    const fresh = new PGlite();
    await migrateFresh(fresh);
    const fromTemplate = await makeTestDb();
    const cloned = (fromTemplate as unknown as { $client: PGlite }).$client;
    try {
      const [a, b] = [await readback(fresh), await readback(cloned)];
      // Non-empty, so equality says something: this tree's schema, and every declared migration.
      const declared = JOURNALS.reduce((n, s) => n + declaredMigrations(s.dir).size, 0);
      expect(a.columns!.length).toBeGreaterThan(300);
      expect(a.indexes!.length).toBeGreaterThan(100);
      expect(a.journals!.length).toBe(declared);
      expect(b).toEqual(a);
    } finally {
      await fresh.close();
      await cloned.close();
    }
  }, BUILD_MS);

  it("the comparator bites: the short build reads back different journals", async () => {
    const [full, shortDb] = [await openFromTarball(good), await openFromTarball(bad)];
    try {
      const [a, b] = [await readback(full), await readback(shortDb)];
      expect(b.journals!.length).toBe(a.journals!.length - 1);
      expect(b).not.toEqual(a);
    } finally {
      await full.close();
      await shortDb.close();
    }
  }, BUILD_MS);
});

describe("a build or a tarball missing one migration is refused", () => {
  it("the builder refuses to publish it, and writes nothing at the path", async () => {
    const path = join(scratch, "short-build.tar");
    const thrown = await buildPgliteTemplate(path, { migrateSpecs: [MAIL_JOURNAL, short] }).then(() => null, (e: unknown) => e);
    expect(thrown).toBeInstanceOf(TemplateRefused);
    expect(String((thrown as Error).message)).toContain(`not applied: ${dropped}`);
    expect(existsSync(path)).toBe(false);
  }, BUILD_MS);

  it("the readback refuses it, and the verify names the missing migration", async () => {
    const c = await openFromTarball(bad);
    try {
      expect(await pgliteJournalMismatch(c)).toContain(`not applied: ${dropped}`);
    } finally {
      await c.close();
    }
    const ok = await openFromTarball(good);
    try {
      expect(await pgliteJournalMismatch(ok)).toBeNull();
    } finally {
      await ok.close();
    }
  }, BUILD_MS);
});

describe("verify on load: unlink and rebuild once, throw on the second", () => {
  const deps = (path: string, builds: Buffer[]): TemplateDeps & { built: number; said: string[] } => {
    const d = {
      path, built: 0, said: [] as string[],
      build: async (p: string) => { const b = builds[Math.min(d.built++, builds.length - 1)]!; writeFileSync(p, b); return b; },
      open: openFromTarball,
      verify: (client: PGlite) => pgliteJournalMismatch(client),
      say: (line: string) => { d.said.push(line); },
    };
    return d;
  };

  it("a good tarball on disk is loaded as it is: no build, no sentence", async () => {
    const path = join(scratch, "load-good.tar");
    writeFileSync(path, good);
    const d = deps(path, [good]);
    const { client } = await loadVerifiedTemplate(d);
    await client.close();
    expect([d.built, d.said.length]).toEqual([0, 0]);
  }, BUILD_MS);

  it("a planted short tarball is removed and rebuilt once, and the rebuild is what loads", async () => {
    const path = join(scratch, "load-planted.tar");
    writeFileSync(path, bad);
    const d = deps(path, [good]);
    const { buf, client } = await loadVerifiedTemplate(d);
    await client.close();
    expect(d.built).toBe(1);
    expect(d.said).toHaveLength(1);
    expect(d.said[0]).toContain(`not applied: ${dropped}`);
    expect(buf.equals(good)).toBe(true);
    expect(readFileSync(path).equals(good)).toBe(true);
  }, BUILD_MS);

  // PGlite 0.2.17 opens bytes that are not a tar as an EMPTY cluster rather than refusing them:
  // the verify is the only thing between a corrupt file and a schema-less database.
  it("bytes that are not a tarball are refused by the verify and rebuilt", async () => {
    const path = join(scratch, "load-garbage.tar");
    writeFileSync(path, Buffer.from("not a tarball"));
    const d = deps(path, [good]);
    const { client } = await loadVerifiedTemplate(d);
    await client.close();
    expect(d.built).toBe(1);
    expect(d.said[0]).toMatch(/does not open|mail: no drizzle_mail\.__drizzle_migrations table/);
  }, BUILD_MS);

  it("a second mismatch after the rebuild throws by name, and leaves no file behind", async () => {
    const path = join(scratch, "load-twice.tar");
    writeFileSync(path, bad);
    const d = deps(path, [bad]);
    const thrown = await loadVerifiedTemplate(d).then(() => null, (e: unknown) => e);
    expect(thrown).toBeInstanceOf(TemplateRefused);
    expect(String((thrown as Error).message)).toMatch(/failed its verify twice/);
    expect(d.built).toBe(1);
    expect(existsSync(path)).toBe(false);
  }, BUILD_MS);
});

describe("the key", () => {
  const base = keyInputs();

  it("is 16 hex, stable for the same inputs, and names the real tmpdir", () => {
    expect(templateKey(base)).toMatch(/^[0-9a-f]{16}$/);
    expect(templateKey(keyInputs())).toBe(templateKey(base));
    expect(templatePath("0123456789abcdef")).toBe(join(realpathSync(tmpdir()), "ohmail-pglite-template-0123456789abcdef.tar"));
  });

  it("reads the versions this module resolves", () => {
    expect(base.pglite).toMatch(/^\d+\.\d+\.\d+/);
    expect(base.drizzle).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("moves with the builder's bytes, either version and the server arm's extra", () => {
    const k = templateKey(base);
    expect(templateKey({ ...base, builder: Buffer.concat([base.builder, Buffer.from(" ")]) })).not.toBe(k);
    expect(templateKey({ ...base, pglite: `${base.pglite}-x` })).not.toBe(k);
    expect(templateKey({ ...base, drizzle: `${base.drizzle}-x` })).not.toBe(k);
    expect(templateKey({ ...base, extra: ["server_version_num:170000"] })).not.toBe(k);
    expect(templateKey({ ...base, extra: ["server_version_num:170000"] }))
      .not.toBe(templateKey({ ...base, extra: ["server_version_num:160000"] }));
  });

  it("moves with each spec's name, migrations schema, journal bytes, and every sql file's name and bytes", () => {
    const k = templateKey(base);
    const copy = (name: string): JournalSpec => {
      const dir = join(scratch, `key-${name}`);
      cpSync(MAIL_JOURNAL.dir, dir, { recursive: true });
      return { ...MAIL_JOURNAL, dir };
    };
    const withMail = (spec: JournalSpec) => templateKey({ ...base, specs: [spec, CLOUD_JOURNAL] });
    const same = copy("same");
    expect(withMail(same)).toBe(k);
    expect(withMail({ ...same, name: "mail2" })).not.toBe(k);
    expect(withMail({ ...same, migrationsSchema: "drizzle_mail2" })).not.toBe(k);
    const journal = copy("journal");
    writeFileSync(join(journal.dir, "meta", "_journal.json"), `${readFileSync(join(journal.dir, "meta", "_journal.json"), "utf8")} `);
    expect(withMail(journal)).not.toBe(k);
    const sqlBytes = copy("sqlbytes");
    const tag = (JSON.parse(readFileSync(join(sqlBytes.dir, "meta", "_journal.json"), "utf8")) as { entries: Array<{ tag: string }> }).entries[0]!.tag;
    writeFileSync(join(sqlBytes.dir, `${tag}.sql`), `${readFileSync(join(sqlBytes.dir, `${tag}.sql`), "utf8")}\n`);
    expect(withMail(sqlBytes)).not.toBe(k);
    const sqlName = copy("sqlname");
    writeFileSync(join(sqlName.dir, "9999_extra.sql"), "");
    expect(withMail(sqlName)).not.toBe(k);
    expect(templateKey({ ...base, specs: [CLOUD_JOURNAL, MAIL_JOURNAL] })).not.toBe(k);
  });

  it("refuses to key a package that does not resolve", () => {
    expect(() => resolvedVersion("@electric-sql/no-such-package")).toThrow(TemplateRefused);
    expect(() => resolvedVersion("@electric-sql/no-such-package")).toThrow(/does not resolve/);
  });
});

describe("journalMismatch is row for row, both ways", () => {
  const declared = new Map([[1, "a"], [2, "b"]]);
  const spec = { name: "mail" };
  it("admits the exact set and refuses each other shape by name", () => {
    expect(journalMismatch(spec, [{ created_at: 1, hash: "a" }, { created_at: "2", hash: "b" }], declared)).toBeNull();
    expect(journalMismatch(spec, [{ created_at: 1, hash: "a" }], declared)).toMatch(/not applied: 2/);
    expect(journalMismatch(spec, [{ created_at: 1, hash: "a" }, { created_at: 2, hash: "x" }], declared)).toMatch(/hash/);
    expect(journalMismatch(spec, [{ created_at: 1, hash: "a" }, { created_at: 2, hash: "b" }, { created_at: 3, hash: "c" }], declared))
      .toMatch(/3 is not declared/);
    expect(journalMismatch(spec, [{ created_at: 1, hash: "a" }, { created_at: 1, hash: "a" }, { created_at: 2, hash: "b" }], declared))
      .toMatch(/recorded twice/);
    expect(journalMismatch(spec, [], declared)).toMatch(/0 rows for 2 declared/);
  });
});

describe("the server arm's clone target", () => {
  // Refused before anything dials, so a closed port proves no connection was needed to refuse.
  it("refuses the shared box, the maintenance database, a template, and a non-identifier", async () => {
    for (const bad of ["trafficflow_test", "postgres", "trafficflow_tpl_0123456789abcdef", 'x"; drop']) {
      await expect(cloneFromTemplate("postgres://nobody@127.0.0.1:1/none", bad, { say: () => {} }))
        .rejects.toThrow(/not a database this clones into/);
    }
  });
});
