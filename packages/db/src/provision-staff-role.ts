/**
 * Run `scripts/harden-staff-role.sql` against a database — the executable form of the runbook's
 * provisioning step (OPS1).
 *
 * That step says `psql -v ON_ERROR_STOP=1 -f scripts/harden-staff-role.sql`. **`psql` is not
 * installed on the machine this repo is developed on**, which makes the runbook unexecutable
 * rather than merely awkward — nobody noticed because nobody had run it. This reproduces psql's
 * guarantees, and it lives in `packages/db` rather than `scripts/` for one reason: it must
 * import `transactionPoolerReason` from this package rather than re-implement it — twice
 * already, a copied predicate rotted alone.
 *
 * ── WHAT IT REPRODUCES, AND WHY EACH MATTERS ────────────────────────────────────────────
 *
 *   · `ON_ERROR_STOP=1` — postgres.js aborts a `.unsafe()` batch on the first error, and the
 *     script carries its own `BEGIN`/`COMMIT`, so a failed run commits nothing.
 *   · An explicit `ROLLBACK` on the way out. An aborted batch otherwise leaves a
 *     long-lived client sitting inside a failed transaction; `psql` exits and rolls back for
 *     free, a pooled node client does not.
 *   · **Print every NOTICE and WARNING.** `no privileges could be revoked for "<schema>"` is
 *     EXPECTED for schemas this session does not own, and an operator who does not see them
 *     cannot tell an expected warning from a real one.
 *
 * ── THREE REFUSALS BEFORE IT WRITES ANYTHING ────────────────────────────────────────────
 *
 *   1. Not a transaction pooler — DDL belongs on a session connection. Shared predicate.
 *   2. The pre-flight must be clean. The script CAN ABORT, and all three of its abort
 *      conditions are properties of the DATABASE, not the file. Finding one here costs seconds;
 *      finding one mid-window costs the window.
 *   3. **The customer-facing copy must no longer say the role is "not yet live".**
 *      Provisioning `ohmail_admin` makes the FAQ's and the privacy policy's "not yet provisioned"
 *      statements false by understatement, and "Claims are contracts": the copy edit and the
 *      provisioning have to land together. The coupling is carried by
 *      `STAFF_ROLE_LIVE_IN_PRODUCTION` — `--apply` is refused while that flag is `false`, and
 *      `test/staff-role-copy-gate.test.ts` refuses to let the flag flip to `true`
 *      unless both copy sites have been updated. So this check needs no database and runs before
 *      the connection is opened; the copy edit is what the flag stands for.
 *   4. `--apply` must be explicit. The default prints identity and pre-flight and stops.
 *
 * It deliberately does NOT set the role's password: that value must never reach a shell history
 * or a log, and `ALTER ROLE … PASSWORD` is one statement an operator can paste themselves.
 *
 * Usage:
 *   pnpm --filter @trafficflow/db provision:staff            # dry run
 *   pnpm --filter @trafficflow/db provision:staff -- --apply
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { argv } from "node:process";
import postgres from "postgres";
import { transactionPoolerReason } from "./session-url.js";
import { STAFF_ADMIN_VIEWS, STAFF_ROLE_LIVE_IN_PRODUCTION } from "./staff-grants.js";

// `fileURLToPath`, never `.pathname` — this checkout lives under a directory with a SPACE.
const HERE = dirname(fileURLToPath(import.meta.url));
const SQL_PATH = join(HERE, "..", "..", "..", "scripts", "harden-staff-role.sql");

const APPLY = argv.includes("--apply");

function sessionUrl(): string {
  /**
   * REHEARSAL SEAM. The apply path executes a multi-statement batch with its own
   * `BEGIN`/`COMMIT` through `sql.unsafe()`, and discovering that postgres.js cannot do that
   * would be worst during the production window. `PROVISION_URL` points the whole runner —
   * pre-flight included — at a throwaway database so the apply can be rehearsed for real.
   * It is an override, never a default: absent, the production session URL is used.
   */
  const override = process.env.PROVISION_URL;
  if (override && override.trim() !== "") return override.trim();

  const line = readFileSync(join(homedir(), ".ohmail", "secrets.env"), "utf8")
    .split("\n")
    .find((l) => l.startsWith("DATABASE_URL_SESSION="));
  if (!line) throw new Error("DATABASE_URL_SESSION not found in ~/.ohmail/secrets.env");
  return line.slice("DATABASE_URL_SESSION=".length).trim().replace(/^["']|["']$/g, "");
}

async function main(): Promise<number> {
  // THE COPY GATE, BEFORE A CONNECTION IS EVEN OPENED. Provisioning `ohmail_admin` in
  // production makes the FAQ and privacy-policy disclaimers false-by-understatement. That copy
  // edit is coupled to `STAFF_ROLE_LIVE_IN_PRODUCTION`, and this refuses `--apply` until the flag
  // is flipped — which `staff-role-copy-gate.test.ts` will not let happen without the copy edit.
  // The rehearsal seam (`PROVISION_URL`) is exempt: a throwaway database is not production, and
  // the whole point of the seam is to exercise the apply path before the flag is ready to flip.
  if (APPLY && !STAFF_ROLE_LIVE_IN_PRODUCTION && !process.env.PROVISION_URL?.trim()) {
    console.error(
      "REFUSING: STAFF_ROLE_LIVE_IN_PRODUCTION is false. Provisioning ohmail_admin in production " +
      "makes the FAQ (apps/webapp/messages/en.json, q5) and the product privacy policy (§5) " +
      "false-by-understatement — they still say the column-restricted role is not yet live. Flip " +
      "the flag to true IN THE SAME COMMIT that updates both copy sites; " +
      "the staff-role copy-gate test enforces the copy edit. (Set PROVISION_URL to " +
      "rehearse the apply against a throwaway database.)",
    );
    return 2;
  }

  const url = sessionUrl();
  const pooler = transactionPoolerReason(url);
  if (pooler) {
    console.error(`REFUSING: DDL must not run on a transaction pooler — ${pooler}`);
    return 2;
  }

  const notices: string[] = [];
  const local = /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(url);
  const sql = postgres(url, {
    // A local rehearsal container speaks no TLS; a hosted database must.
    ssl: local ? false : "require",
    max: 1,
    onnotice: (n) => notices.push(`${n.severity}: ${n.message}${n.detail ? " — " + n.detail : ""}`),
  });

  try {
    const who = (await sql`select current_database() db, current_user usr`)[0]!;
    console.log(`database : ${who.db}\nconnected: ${who.usr}\n`);

    /** Each must be empty; each ABORTS the script. Header of harden-staff-role.sql. */
    const preflight: Array<[string, Promise<readonly unknown[]>]> = [
      ["privileges granted to PUBLIC in public/admin", sql`
        SELECT n.nspname, c.relname, a.privilege_type
          FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace,
               LATERAL aclexplode(c.relacl) a
         WHERE n.nspname IN ('public','admin') AND a.grantee = 0`],
      // `STAFF_ADMIN_VIEWS`, imported rather than spelled — this pre-flight must stay exactly
      // as wide as §12b, which has already widened once, from one view to two. A stale list here refuses
      // to RE-provision an already-correct database, which is the one thing a repair tool
      // must never do.
      ["unexpected objects in schema admin", sql`
        SELECT n.nspname, c.relname FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'admin'
           AND NOT (c.relkind = 'v' AND c.relname = ANY(${[...STAFF_ADMIN_VIEWS]}))`],
      ["SECURITY DEFINER routines in public/admin", sql`
        SELECT n.nspname, p.proname FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE p.prosecdef AND n.nspname IN ('public','admin')`],
    ];

    console.log("pre-flight (read-only) — each must be clean, each ABORTS the script:");
    let clean = true;
    for (const [label, q] of preflight) {
      const rows = await q;
      console.log(`  ${rows.length === 0 ? "clean" : `${rows.length} ROW(S)`}  ${label}`);
      for (const r of rows.slice(0, 10)) console.log(`      ${JSON.stringify(r)}`);
      if (rows.length > 0) clean = false;
    }

    if (!clean) {
      console.error(
        "\nREFUSING: the pre-flight is not clean. Each of these aborts the script, and none can " +
        "be repaired without changing what OTHER roles can do — a human decision, not this " +
        "runner's.",
      );
      return 1;
    }
    if (!APPLY) {
      console.log("\nDRY RUN — pre-flight clean, nothing written. Re-run with --apply.");
      return 0;
    }

    console.log("\napplying scripts/harden-staff-role.sql …");
    try {
      // `.simple()` is LOAD-BEARING, not decoration. postgres.js defaults to the extended
      // protocol, which permits exactly one statement per query — this script is a batch with
      // its own BEGIN/COMMIT, so without it the apply fails on the first semicolon. Found by
      // reading how `staff-role.pg.test.ts:255` runs the same file, not by running this.
      await sql.unsafe(readFileSync(SQL_PATH, "utf8")).simple();
      console.log("script COMMITTED.");
      console.log("\nNEXT: set the role's password yourself — it must not pass through this " +
                  "runner's argv or logs:\n  ALTER ROLE ohmail_admin PASSWORD '<generated>';");
      return 0;
    } catch (e) {
      // The script aborts BY DESIGN; its own message names the postcondition that failed.
      console.error(`\nSCRIPT ABORTED: ${e instanceof Error ? e.message : String(e)}`);
      await sql.unsafe("rollback").catch(() => { /* already rolled back */ });
      return 1;
    }
  } finally {
    if (notices.length) {
      console.log("\nserver notices — the `no privileges could be revoked` ones are EXPECTED:");
      for (const n of notices) console.log(`  ${n}`);
    }
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

process.exitCode = await main();
