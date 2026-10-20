import { createHash } from "node:crypto";
import {
  cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAIL_JOURNAL } from "@trafficflow/db/journal";
import { encodeMirrorRecord, normalizeBase } from "../src/cloud-origin.js";
import { LOCAL_STORE_EXTENSIONS, PGDATA_SUBDIR, openLocalDb } from "../src/db.js";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  A MIRROR DATA DIRECTORY THAT DOES NOT PAY FOR `initdb`
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Every test that stands up the engine used to hand `createSidecar` an EMPTY directory, and
 * PGlite then ran `initdb` inside WASM before the first assertion. Measured on this machine at
 * main, three ways in one process:
 *
 *   empty directory        total 10 072 ms   (new PGlite + waitReady 9 698 ms · migrate 354 ms)
 *   the same dir re-opened total     82 ms   (new PGlite + waitReady     62 · migrate  15)
 *   a COPY of that dir     total     82 ms   + 19 ms for the copy
 *
 * So the ten seconds are `initdb`, not the 102 migrations and not the test. `cloud-mirror.test.ts`
 * paid it 61 times — 625 s for a file whose assertions run against in-process fakes.
 *
 * This builds ONE initialised, fully migrated PGDATA per key and copies it. The key is the mail
 * journal's own bytes plus the PGlite version, so a migration added or edited invalidates it and
 * no run can inherit a schema that is not this tree's — the same question `journalDrift` asks of a
 * long-lived database, asked of a cache.
 *
 * WHAT IT DOES NOT COPY IS THE POINT: only `pgdata/`. The install identity, the cursor files, the
 * lock and everything else a launch writes into the data directory stay absent, so a test still
 * gets a first launch in every respect except the one that costs ten seconds.
 *
 * ── THE ONE THING IT CHANGES, AND WHO MAY NOT USE IT ──────────────────────────────────────
 *
 * `openPhaseFor` reads `creating_store` from the ABSENCE of `pgdata/PG_VERSION`, so a templated
 * directory narrates `opening_store` instead. A test whose subject IS the first launch — the boot
 * phases and their narration — must keep `mkdtempSync` and keep paying. That is not a limitation
 * to work around: those files are the ones measuring the cost this removes.
 *
 * ── AND WHY THE BUILD IS WARMED BY globalSetup RATHER THAN BY THE FIRST TEST ───────────────
 *
 * Built lazily, the one ten-second build lands inside whichever test asked first, against vitest's
 * 5 s default — and that test then fails as `Test timed out in 5000ms` while the file it belongs to
 * is correct. (`initdb` used to escape that clock because it blocks the event loop, so the timer
 * never fired; the build has real await points and does not.) `test/setup/pgdata-template.global.ts`
 * therefore warms it once per vitest invocation, outside every test and hook budget. The lazy path
 * below stays, because a warm-up that failed must not decide whether the suite can run — it
 * announces itself on stderr so a timeout behind it is attributable to the build and not to the
 * product.
 */

/**
 * The mail journal's bytes + the PGlite version: what the template's schema is a function of.
 *
 * `journalDir` is a parameter only so a test can point it at a COPY and watch the key move when a
 * migration's bytes change — the property that keeps an edited migration from being served the old
 * schema for ever. Production always takes the default.
 */
export function templateKey(journalDir: string = MAIL_JOURNAL.dir, extensions: readonly string[] = STORE_EXTENSIONS): string {
  const h = createHash("sha256");
  h.update(process.env.OHMAIL_PGDATA_TEMPLATE_SALT ?? "");
  // THE EXTENSIONS ARE PART OF THE SCHEMA: a template whose indexes use `pg_trgm` cannot be opened
  // by a checkout that does not load it, and the directory is shared by every checkout on the host.
  h.update(`extensions:${[...extensions].sort().join(",")}`);
  const dir = journalDir;
  h.update(readFileSync(join(dir, "meta", "_journal.json")));
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".sql")).sort()) {
    h.update(f);
    h.update(readFileSync(join(dir, f)));
  }
  h.update(pgliteVersion());
  return h.digest("hex").slice(0, 16);
}

function pgliteVersion(): string {
  try {
    const url = new URL("../../../node_modules/@electric-sql/pglite/package.json", import.meta.url);
    return `pglite@${(JSON.parse(readFileSync(url, "utf8")) as { version: string }).version}`;
  } catch {
    // Not knowable is its own key: a template must never be shared across an unknown version.
    return `pglite@unknown-${process.version}`;
  }
}

/** The extension set the opener loads, by name; `[]` is the withheld store's template. */
const STORE_EXTENSIONS: readonly string[] = Object.keys(LOCAL_STORE_EXTENSIONS);

const cached = new Map<string, string>();

/** Where the template for `key` lives. Exported so a test can assert what a call produced. */
export function templatePathFor(key: string): string {
  return join(realpathSync(tmpdir()), `ohmail-pgdata-template-${key}`);
}

/**
 * The template PGDATA for this tree, built once and re-used by every later worker process.
 *
 * Built into a private directory and moved into place, so a run can never open a template that is
 * still being initialised; a worker that loses the race discards its own copy and uses the winner's.
 */
async function templatePgdata(withoutSearchExtensions = false): Promise<string> {
  const variant = withoutSearchExtensions ? "without" : "with";
  const hit = cached.get(variant);
  if (hit !== undefined) return hit;
  const shared = templatePathFor(templateKey(MAIL_JOURNAL.dir, withoutSearchExtensions ? [] : STORE_EXTENSIONS));
  if (existsSync(join(shared, "PG_VERSION"))) { cached.set(variant, shared); return shared; }
  process.stderr.write(
    "[datadir] building the PGDATA template (about 10 s, once per journal) — a test that times out "
      + "immediately after this line timed out on the build, not on its own work\n");
  const scratch = mkdtempSync(join(realpathSync(tmpdir()), "ohmail-pgdata-build-"));
  try {
    const handle = await openLocalDb(scratch, withoutSearchExtensions ? { withoutSearchExtensions: true } : {});
    // The template is verified before it is published: an empty journal would hand every later
    // test a database with no schema and an assertion failure that names the product.
    const rows = await handle.db.execute(
      `select count(*)::int as n from "${MAIL_JOURNAL.migrationsSchema}"."__drizzle_migrations"`,
    ) as unknown as { rows?: Array<{ n: number }> } & Array<{ n: number }>;
    const applied = Number((rows.rows ?? rows)[0]?.n ?? 0);
    await handle.close();
    if (applied < 1) throw new Error(`[datadir] the template migrated to ${applied} journal rows`);
    if (existsSync(join(shared, "PG_VERSION"))) { cached.set(variant, shared); return shared; }
    // A CLOSED store still has its `postmaster.pid`, and copying it hands every test a directory
    // that claims a server is running in it. PGlite tolerates that today; a Postgres that refuses
    // a stale lock file would fail 76 files at once, so the template is left cold.
    rmSync(join(scratch, PGDATA_SUBDIR, "postmaster.pid"), { force: true });
    try {
      renameSync(join(scratch, PGDATA_SUBDIR), shared);
    } catch {
      // Another worker published first (a rename onto a populated directory fails); take theirs.
      if (!existsSync(join(shared, "PG_VERSION"))) throw new Error("[datadir] no template after the rename");
    }
    cached.set(variant, shared);
    return shared;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** Build the template if it is not there yet. Called by the global setup; safe to call twice. */
export async function warmPgdataTemplate(): Promise<string> {
  return templatePgdata();
}

/**
 * A fresh mirror data directory whose `pgdata/` is already initialised and migrated.
 *
 * A drop-in for `mkdtempSync(join(realpathSync(tmpdir()), tag))` at every site that hands the
 * directory to `createSidecar` or `openLocalDb`. The caller still owns removing it.
 */
export async function freshDataDir(
  tag: string, opts: { withoutSearchExtensions?: true } = {},
): Promise<string> {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), tag));
  // Read at CALL time, not at module load: a test that turns the template off has to be able to.
  if (process.env.OHMAIL_PGDATA_TEMPLATE === "0") return dir;
  cpSync(await templatePgdata(opts.withoutSearchExtensions === true), join(dir, PGDATA_SUBDIR), { recursive: true });
  return dir;
}

/**
 * {@link freshDataDir} for a Cloud launch at `cloudUrl`, with the `mirror-owner` record a first
 * launch at that server writes. Without it a launch at any server but the managed one reads the
 * copied `pgdata` as another server's mirror (`mirrorIsForeign` with no record), discards it and
 * runs `initdb` inside the test. A test whose subject is that adopt-or-discard decision keeps
 * {@link freshDataDir}.
 */
export async function freshCloudDataDir(
  tag: string, o: { address: string | null; cloudUrl: string },
): Promise<string> {
  const base = normalizeBase(o.cloudUrl);
  if (base === null) throw new Error(`[datadir] ${o.cloudUrl} is not a server base`);
  const dir = await freshDataDir(tag);
  writeFileSync(join(dir, "mirror-owner"),
    encodeMirrorRecord(o.address?.trim().toLowerCase() ?? null, base), { mode: 0o600 });
  return dir;
}
