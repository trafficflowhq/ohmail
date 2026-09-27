import { createHash, randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { adoptBaseline, type JournalSpec } from "./baseline.js";
import { JOURNALS } from "./journal-specs.js";
import { brandDialect } from "./dialect/index.js";

/**
 * THE MIGRATED DATABASE `makeTestDb` CLONES, built once per key and verified on every first load.
 *
 * Replaying both journals is most of what a fresh PGlite costs, so the result is dumped once per
 * key to `ohmail-pglite-template-<key>.tar` under the real tmpdir (files run isolated, so an
 * in-memory cache would rebuild per file). The key covers everything the schema is a function of;
 * the verify covers what the key cannot see (a corrupt, planted or half-built file). Neither may
 * fall back to a fresh build without saying so.
 */

/** Set to `0` by a PERSON to take the fresh path; no test file may set it (a census holds that). */
export const PGLITE_TEMPLATE_ENV = "OHMAIL_PGLITE_TEMPLATE";

export function templateDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[PGLITE_TEMPLATE_ENV] === "0";
}

/** A template this tree refuses to build, load or trust, with the reason in the message. */
export class TemplateRefused extends Error {
  constructor(message: string) {
    super(`[pglite-template] ${message}`);
    this.name = "TemplateRefused";
  }
}

/**
 * `when` → sha256 of the migration file, for every migration a journal folder declares. The hash
 * is what the migrator writes into `__drizzle_migrations.hash`, so the file on disk is the answer.
 */
export function declaredMigrations(dir: string): Map<number, string> {
  const journal = JSON.parse(
    readFileSync(join(dir, "meta", "_journal.json"), "utf8"),
  ) as { entries: Array<{ when: number; tag: string }> };
  const out = new Map<number, string>();
  for (const e of journal.entries) {
    const sql = readFileSync(join(dir, `${e.tag}.sql`));
    out.set(Number(e.when), createHash("sha256").update(sql).digest("hex"));
  }
  return out;
}

/** One applied row of a journal table: the migration's stamp and the sha256 the migrator stored. */
export interface AppliedRow { hash: string; created_at: string | number }

/**
 * ROW FOR ROW, BOTH WAYS: every applied row declared with the same hash, and every declared
 * migration applied. `journalDrift` asks the first half only (behind is not drift there); a
 * template is a finished database, so behind is a mismatch here. A sentence, or `null`.
 */
export function journalMismatch(
  spec: Pick<JournalSpec, "name">, rows: readonly AppliedRow[], declared: ReadonlyMap<number, string>,
): string | null {
  const seen = new Set<number>();
  for (const r of rows) {
    const when = Number(r.created_at);
    const want = declared.get(when);
    if (want === undefined) return `${spec.name}: applied ${when} is not declared by this tree`;
    if (want !== String(r.hash)) return `${spec.name}: applied ${when} carries a hash this tree's file does not`;
    if (seen.has(when)) return `${spec.name}: ${when} is recorded twice`;
    seen.add(when);
  }
  const missing = [...declared.keys()].filter((w) => !seen.has(w));
  if (missing.length > 0) {
    return `${spec.name}: ${rows.length} rows for ${declared.size} declared; not applied: ${missing.slice(0, 3).join(", ")}`
      + (missing.length > 3 ? ` and ${missing.length - 3} more` : "");
  }
  return null;
}

/** A pinned identifier, quoted: the schema comes from this repository's own spec table. */
function journalTable(spec: JournalSpec): string {
  return `"${spec.migrationsSchema.replace(/"/g, '""')}"."__drizzle_migrations"`;
}

/** The first mismatch across `specs` in a PGlite database, or `null`. An absent table is one. */
export async function pgliteJournalMismatch(client: PGlite, specs: readonly JournalSpec[] = JOURNALS): Promise<string | null> {
  for (const spec of specs) {
    const present = await client.query<{ ok: boolean }>(`SELECT to_regclass('${journalTable(spec)}') IS NOT NULL AS ok`);
    if (present.rows[0]?.ok !== true) return `${spec.name}: no ${spec.migrationsSchema}.__drizzle_migrations table`;
    const rows = await client.query<AppliedRow>(`SELECT hash, created_at FROM ${journalTable(spec)} ORDER BY created_at`);
    const why = journalMismatch(spec, rows.rows, declaredMigrations(spec.dir));
    if (why !== null) return why;
  }
  return null;
}

/** The adopt+migrate loop `makeTestDb` has always run, in {@link JOURNALS} order. */
export async function migrateFresh(client: PGlite, specs: readonly JournalSpec[] = JOURNALS): Promise<void> {
  const db = brandDialect(drizzle(client), "pg");
  for (const spec of specs) {
    await adoptBaseline(db, spec);
    await migrate(db, { migrationsFolder: spec.dir, migrationsSchema: spec.migrationsSchema });
  }
}

/**
 * The version of `pkg` as THIS module resolves it: the entry point, then the nearest enclosing
 * `package.json` carrying that name. (`<pkg>/package.json` itself is not exported by either
 * package, so asking for it throws.) Unresolvable is a refusal: an unknown version keys nothing.
 */
export function resolvedVersion(pkg: string, from: string = import.meta.url): string {
  let entry: string;
  try {
    entry = createRequire(from).resolve(pkg);
  } catch (e) {
    throw new TemplateRefused(`${pkg} does not resolve from ${fileURLToPath(from)}, so no template can be keyed on it `
      + `(${(e as { code?: string }).code ?? String(e)})`);
  }
  for (let dir = dirname(entry); dir !== dirname(dir); dir = dirname(dir)) {
    const file = join(dir, "package.json");
    if (!existsSync(file)) continue;
    const pj = JSON.parse(readFileSync(file, "utf8")) as { name?: string; version?: string };
    if (pj.name === pkg && typeof pj.version === "string" && pj.version !== "") return pj.version;
  }
  throw new TemplateRefused(`${pkg} resolved to ${entry}, and no package.json above it names ${pkg} with a version`);
}

/** Everything the template's content is a function of. `extra` is the server arm's version. */
export interface KeyInputs {
  readonly builder: Buffer;
  readonly pglite: string;
  readonly drizzle: string;
  readonly specs: readonly JournalSpec[];
  readonly extra?: readonly string[];
}

export function keyInputs(specs: readonly JournalSpec[] = JOURNALS): KeyInputs {
  return {
    builder: readFileSync(fileURLToPath(import.meta.url)),
    pglite: resolvedVersion("@electric-sql/pglite"),
    drizzle: resolvedVersion("drizzle-orm"),
    specs,
  };
}

/**
 * 16 hex of sha256 over the inputs IN THIS ORDER: the builder's bytes, the two versions, then per
 * spec its name, migrations schema, `_journal.json` bytes and every `*.sql` by sorted name and
 * bytes. Every field is framed by its label and length, so no two inputs can spell one stream.
 */
export function templateKey(inputs: KeyInputs): string {
  const h = createHash("sha256");
  const field = (label: string, bytes: Buffer | string): void => {
    const b = typeof bytes === "string" ? Buffer.from(bytes, "utf8") : bytes;
    h.update(`${JSON.stringify(label)}:${b.length}:`);
    h.update(b);
  };
  field("builder", inputs.builder);
  field("pglite", inputs.pglite);
  field("drizzle-orm", inputs.drizzle);
  for (const spec of inputs.specs) {
    field("spec", spec.name);
    field("migrationsSchema", spec.migrationsSchema);
    field("_journal.json", readFileSync(join(spec.dir, "meta", "_journal.json")));
    for (const f of readdirSync(spec.dir).filter((n) => n.endsWith(".sql")).sort()) {
      field("sql-name", f);
      field("sql", readFileSync(join(spec.dir, f)));
    }
  }
  for (const x of inputs.extra ?? []) field("extra", x);
  return h.digest("hex").slice(0, 16);
}

/** Where the tarball for `key` lives: the REAL tmpdir, so every checkout on the host shares it. */
export function templatePath(key: string, dir: string = realpathSync(tmpdir())): string {
  return join(dir, `ohmail-pglite-template-${key}.tar`);
}

/**
 * Build, verify, dump and publish one tarball. `migrateSpecs` exists so a test can build from a
 * journal with a migration removed and watch the verify against `verifySpecs` refuse to publish.
 * Written to a private name and renamed, so no reader can see a half-written file.
 */
export async function buildPgliteTemplate(
  path: string,
  opts: { migrateSpecs?: readonly JournalSpec[]; verifySpecs?: readonly JournalSpec[] } = {},
): Promise<Buffer> {
  const client = new PGlite();
  let buf: Buffer;
  try {
    await migrateFresh(client, opts.migrateSpecs ?? JOURNALS);
    const why = await pgliteJournalMismatch(client, opts.verifySpecs ?? JOURNALS);
    if (why !== null) throw new TemplateRefused(`the build does not match this tree's journals and was not published: ${why}`);
    buf = Buffer.from(await (await client.dumpDataDir("none")).arrayBuffer());
  } finally {
    await client.close();
  }
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, buf);
    renameSync(tmp, path);
  } finally {
    rmSync(tmp, { force: true });
  }
  return buf;
}

/** What {@link loadVerifiedTemplate} does to the world; injectable so every arm can be driven. */
export interface TemplateDeps {
  readonly path: string;
  build(path: string): Promise<Buffer>;
  open(buf: Buffer): Promise<PGlite>;
  verify(client: PGlite): Promise<string | null>;
  say(line: string): void;
}

export const openFromTarball = async (buf: Buffer): Promise<PGlite> => {
  const client = new PGlite({ loadDataDir: new Blob([new Uint8Array(buf)]) });
  await client.waitReady;
  return client;
};

/**
 * READ, OPEN, VERIFY; ON A MISMATCH UNLINK AND REBUILD ONCE; A SECOND MISMATCH THROWS. A tarball
 * that does not even open is a mismatch too. Resolves to the verified bytes and the verified
 * client, which is a fresh database and is handed to the first caller rather than discarded.
 */
export async function loadVerifiedTemplate(deps: TemplateDeps): Promise<{ buf: Buffer; client: PGlite }> {
  let first: string | null = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const buf = existsSync(deps.path) ? readFileSync(deps.path) : await deps.build(deps.path);
    let client: PGlite | null = null;
    let why: string | null;
    try {
      client = await deps.open(buf);
      why = await deps.verify(client);
    } catch (e) {
      // Captured: a tarball that cannot be opened or read is a mismatch, removed and rebuilt below.
      why = `it does not open or read as a database (${e instanceof Error ? e.message : String(e)})`;
    }
    if (why === null && client !== null) return { buf, client };
    await client?.close().catch(() => { /* the mismatch is the report */ });
    rmSync(deps.path, { force: true });
    if (first !== null) {
      throw new TemplateRefused(`${deps.path} failed its verify twice — first: ${first}; after the rebuild: ${why}`);
    }
    first = why;
    deps.say(`[pglite-template] ${deps.path} does not match this tree (${why}); removed, rebuilding once`);
  }
  throw new TemplateRefused("unreachable: the loop returns or throws");
}

let loaded: Promise<{ buf: Buffer; client: PGlite }> | null = null;
let firstHandedOut = false;

function realDeps(): TemplateDeps {
  return {
    path: templatePath(templateKey(keyInputs())),
    build: (path) => {
      process.stderr.write("[pglite-template] building the migrated PGlite template (once per journal state)\n");
      return buildPgliteTemplate(path);
    },
    open: openFromTarball,
    verify: (client) => pgliteJournalMismatch(client),
    say: (line) => { process.stderr.write(`${line}\n`); },
  };
}

/** A fresh, migrated PGlite from this tree's template: one read and one verify per process. */
export async function templatedPglite(): Promise<PGlite> {
  loaded ??= loadVerifiedTemplate(realDeps());
  const { buf, client } = await loaded;
  if (!firstHandedOut) { firstHandedOut = true; return client; }
  return openFromTarball(buf);
}

/**
 * Build this tree's template if absent: the global setup's call, so a run that never asks for a
 * database pays one key and one `existsSync`. The build verifies before it publishes, and every
 * process verifies again on its first load. Returns the tarball path.
 */
export async function warmPgliteTemplate(): Promise<string> {
  const deps = realDeps();
  if (!existsSync(deps.path)) await deps.build(deps.path);
  return deps.path;
}
