/**
 * verify-engine-boot.mjs — the engine BOOTS from the bundle layout, and DIES when the journal is
 * not where the layout puts it.
 *
 * ── THE INVARIANT NOTHING ELSE CHECKS ─────────────────────────────────────────────────────
 *
 * `@ohmail/db-mail` composes the migration journal as `dirname(import.meta.url)/../drizzle`, and
 * esbuild rewrites `import.meta.url` to the OUTPUT file's own URL. So a bundle at
 * `<root>/bin/ohmail-engine.mjs` looks for its `.sql` at `<root>/drizzle` — one level ABOVE it.
 * Inside a packaged app that is `<resources>/engine/drizzle`, beside `<resources>/engine/bin/`.
 *
 * This relationship is invisible to every test in the repository: the vitest suites run the engine
 * from `apps/sidecar/src` in the workspace, where the same expression happens to resolve to the
 * source journal. The ONLY place it is exercised as it ships is here — boot the bundle from the
 * layout the packager produces, and watch it both ways.
 *
 * ── WATCHED FAILING, NOT ASSUMED ──────────────────────────────────────────────────────────
 *
 * A boot test that only ever asserts success proves the happy path and nothing about the guard: a
 * bundle that resolved its journal from an absolute build path baked in at compile time would pass
 * it while shipping broken. So the second half MOVES the journal aside and requires the boot to
 * fail in migrate() — `start_failed` with `ENOENT`, and no `serving`. If that half does not go
 * red, the first half is worthless, and this script exits non-zero saying so.
 *
 * ── HOW A HEALTHY BOOT IS RECOGNISED ──────────────────────────────────────────────────────
 *
 * A live pid is not a running engine. The engine announces `serving` on stderr once PGlite has
 * migrated and the mirror is open — reached by reading that line, never by observing the process
 * stayed alive. It is fed a dead IMAP port and no stored password, so it opens the local mirror,
 * logs `stored_login_absent` → `serving`, and waits: it never has to reach the network to prove
 * the thing under test, which is that the SCHEMA came up from the journal at the right path.
 *
 *   node scripts/verify-engine-boot.mjs [engineRoot]
 *
 * `engineRoot` holds `bin/ohmail-engine.mjs` and `drizzle/` — `build/engine` by default, or the
 * `engine/` directory inside a packaged app's resources, which is the same two-directory shape.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, renameSync, rmSync } from "node:fs";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const engineRoot = resolve(process.argv[2] ?? join(ROOT, "build", "engine"));
const bundle = join(engineRoot, "bin", "ohmail-engine.mjs");
const journal = join(engineRoot, "drizzle");

if (!existsSync(bundle)) fail(`no engine bundle at ${bundle} — run scripts/build-engine.mjs first`);
if (!existsSync(journal)) fail(`no journal at ${journal} — the layout is already wrong`);

/** Boot once against a dead IMAP port, return what stderr said and how many pgdata entries landed. */
function boot() {
  const dataDir = mkdtempSync(join(tmpdir(), "ohmail-boot-"));
  const child = spawn(process.execPath, [bundle], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      OHMAIL_KEK: "a".repeat(64),
      OHMAIL_IMAP_HOST: "127.0.0.1",
      OHMAIL_IMAP_PORT: "59999",       // nothing listens; the engine never needs it to boot
      OHMAIL_IMAP_USER: "boot@local",
      OHMAIL_MAILBOX_ADDRESS: "boot@local",
      OHMAIL_IMAP_SECURE: "0",
      OHMAIL_DATA_DIR: dataDir,
    },
  });
  let err = "";
  child.stderr.on("data", (b) => { err += b.toString("utf8"); });

  return new Promise((res) => {
    const done = (exitCode) => {
      let pgdataEntries = 0;
      try { pgdataEntries = readdirSync(join(dataDir, "pgdata")).length; } catch { /* none */ }
      rmSync(dataDir, { recursive: true, force: true });
      res({ err, exitCode, pgdataEntries });
    };
    // The engine serves and then waits on stdin. Give it a window to migrate and announce, then
    // close stdin — its documented graceful stop — and read what it said.
    const closeStdin = setTimeout(() => child.stdin.end(), 6000);
    const kill = setTimeout(() => child.kill("SIGKILL"), 15000);
    child.on("exit", (code) => { clearTimeout(closeStdin); clearTimeout(kill); done(code); });
  });
}

console.log(`verify-engine-boot: ${engineRoot}`);

// ── 1. Journal in place: the engine migrates and serves ──────────────────────────────────────
const healthy = await boot();
const served = /"event":"serving"/.test(healthy.err);
if (!served) {
  process.stderr.write(healthy.err);
  fail("the engine did NOT serve with its journal in place — migration could not find the schema");
}
if (healthy.pgdataEntries < 10) {
  fail(`served but PGlite wrote only ${healthy.pgdataEntries} pgdata entries — the mirror is not real`);
}
console.log(`  ✓ serves with the journal at ./drizzle (${healthy.pgdataEntries} pgdata entries)`);

// ── 2. Journal moved aside: the engine must fail in migrate(), not serve ──────────────────────
const stash = `${journal}.verify-moved`;
renameSync(journal, stash);
let broken;
try {
  broken = await boot();
} finally {
  renameSync(stash, journal);
}
if (/"event":"serving"/.test(broken.err)) {
  process.stderr.write(broken.err);
  fail("the engine SERVED with its journal moved away — it is not resolving the journal from the "
    + "bundle layout, so this test guards nothing and the layout could ship broken");
}
if (!/"event":"start_failed"/.test(broken.err) || !/ENOENT/.test(broken.err)) {
  process.stderr.write(broken.err);
  fail("the engine neither served nor reported a start failure with a missing journal — the failure "
    + "mode is not the one this guard reads, so a real breakage would look different");
}
console.log("  ✓ refuses to serve with the journal missing (start_failed / ENOENT)");

console.log("verify-engine-boot: OK — the engine boots from the bundle layout, and only from it.");

function fail(msg) {
  console.error(`\nverify-engine-boot: FAILED — ${msg}`);
  process.exit(1);
}
