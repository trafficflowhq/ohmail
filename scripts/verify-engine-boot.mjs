/**
 * verify-engine-boot.mjs — the engine BOOTS from the bundle layout, and DIES when the journal is not where
 * the layout puts it. `@ohmail/db-mail` composes the migration journal as
 * `dirname(import.meta.url)/../drizzle`, and esbuild rewrites `import.meta.url` to the OUTPUT file's URL, so
 * a bundle at `<root>/bin/ohmail-engine.mjs` looks for its `.sql` at `<root>/drizzle` — one level ABOVE (in
 * a packaged app, `<resources>/engine/drizzle`). This is invisible to every vitest suite (they run the
 * engine from `apps/sidecar/src` where the same expression resolves to the source journal); the ONLY place
 * it is exercised as it ships is here. WATCHED FAILING, not assumed: a success-only boot test would pass a
 * bundle that baked an absolute build path, so the second half MOVES the journal aside and requires the boot
 * to fail in `migrate()` (`start_failed`/`ENOENT`, no `serving`), or the first half is worthless. A healthy boot is recognised by reading `serving` on stderr (a live pid is not a running engine), fed a dead IMAP port and no password so it never reaches the network. `node scripts/verify-engine-boot.mjs [engineRoot]` (holds `bin/ohmail-engine.mjs` and `drizzle/`, `build/engine` by default). */
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
  let listing = [];
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
      /* The data dir as it stands at the end, so a failure can be CHARACTERISED instead of guessed
       * at. Names only, one level, and no contents: this runs in a public CI log. */
      try { listing = readdirSync(dataDir).slice(0, 20); } catch { listing = []; }
      rmSync(dataDir, { recursive: true, force: true });
      res({ err, exitCode, pgdataEntries, listing });
    };
    // The engine serves and then waits on stdin. Give it a window to migrate and announce, then
    // close stdin — its documented graceful stop — and read what it said.
    const closeStdin = setTimeout(() => child.stdin.end(), 6000);
    const kill = setTimeout(() => child.kill("SIGKILL"), 15000);
    child.on("exit", (code) => { clearTimeout(closeStdin); clearTimeout(kill); done(code); });
  });
}

console.log(`verify-engine-boot: ${engineRoot}`);

/* WHAT A FAILING BOOT SAID, filtered to the engine's own JSON log lines and the data dir listing.
 * A flake nobody characterises will one day pass for the wrong reason: on 2026-09-12 the Windows
 * nsis job failed here ("migration could not find the schema") and passed on the re-run of the
 * SAME sha with a byte-identical bundle (738 inputs, 6.0 MiB), and there was nothing to read. */
function characterise(label, b) {
  process.stderr.write(`\nverify-engine-boot: ${label} — exit ${b.exitCode}, ${b.pgdataEntries} pgdata entries\n`);
  const lines = b.err.split("\n").filter((l) => l.includes('"event":') || /error|ENOENT|EPERM|EBUSY|EACCES/i.test(l));
  for (const l of lines.slice(-25)) process.stderr.write(`  | ${l.slice(0, 300)}\n`);
  process.stderr.write(`  | data dir held: ${b.listing.length ? b.listing.join(", ") : "<nothing>"}\n`);
}

// ── 1. Journal in place: the engine migrates and serves ──────────────────────────────────────
/* TWO ATTEMPTS, AND THE JOB REFUSES ONLY WHEN BOTH FAIL. The second attempt is inside the job, so
 * a flake produces both readings in one log instead of a re-run somebody has to ask for by hand —
 * and a REAL breakage still refuses, because a bundle that cannot find its journal cannot find it
 * twice. Both attempts are characterised; a second attempt that succeeds says so out loud, so a
 * green here is never mistaken for a first-try green. */
let healthy = await boot();
let served = /"event":"serving"/.test(healthy.err);
let attempts = 1;
if (!served) {
  characterise("attempt 1 did not serve", healthy);
  healthy = await boot();
  served = /"event":"serving"/.test(healthy.err);
  attempts = 2;
  if (served) {
    console.log("  ! attempt 1 did not serve and attempt 2 did — this boot is FLAKY on this runner;");
    console.log("    both readings are above. Do not read this green as a first-try green.");
  }
}
if (!served) {
  characterise("attempt 2 did not serve either", healthy);
  fail(`the engine did NOT serve with its journal in place on ${attempts} attempts — migration could not find the schema`);
}
if (healthy.pgdataEntries < 10) {
  characterise("served with too few pgdata entries", healthy);
  fail(`served but PGlite wrote only ${healthy.pgdataEntries} pgdata entries — the mirror is not real`);
}
console.log(`  ✓ serves with the journal at ./drizzle (${healthy.pgdataEntries} pgdata entries, attempt ${attempts})`);

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
  characterise("served with the journal moved away", broken);
  fail("the engine SERVED with its journal moved away — it is not resolving the journal from the "
    + "bundle layout, so this test guards nothing and the layout could ship broken");
}
if (!/"event":"start_failed"/.test(broken.err) || !/ENOENT/.test(broken.err)) {
  characterise("neither served nor reported a start failure", broken);
  fail("the engine neither served nor reported a start failure with a missing journal — the failure "
    + "mode is not the one this guard reads, so a real breakage would look different");
}
console.log("  ✓ refuses to serve with the journal missing (start_failed / ENOENT)");

console.log("verify-engine-boot: OK — the engine boots from the bundle layout, and only from it.");

function fail(msg) {
  console.error(`\nverify-engine-boot: FAILED — ${msg}`);
  process.exit(1);
}
