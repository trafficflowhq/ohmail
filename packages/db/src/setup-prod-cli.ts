import { pathToFileURL } from "node:url";
import {
  assertSessionUrl, setupProdDatabase, PROD_DB_HOST_ENV,
} from "./setup-prod.js";
import { dataApiPolicyFromEnv } from "./supabase-lockdown-core.js";

/**
 * THE `pnpm db:setup:prod` ENTRY POINT, kept in a module NOTHING re-exports.
 *
 * ── WHY THIS IS ITS OWN FILE ──────────────────────────────────────────────────────────────
 *
 * The guard at the bottom asks "was this module run directly?" by comparing `import.meta.url`
 * with `process.argv[1]`. That question has a correct answer in a module graph and NO correct
 * answer in a BUNDLE: a bundler concatenates every module into one file, so each of them reports
 * the bundle's own URL, the comparison is true, and the CLI runs — inside whatever program
 * happened to include it.
 *
 * That is not hypothetical. `setup-prod.ts` is re-exported through `@trafficflow/db/admin` for
 * `JOURNALS` and `adoptBaseline`, which the local mail engine needs to migrate its on-disk
 * database. Bundling the engine therefore put this guard in the artifact, where it fired on
 * every launch: the packaged engine tried to provision a PRODUCTION database at startup and
 * printed `[db:setup:prod] FAILED: DATABASE_URL_SESSION is required` before it had opened
 * anything. It also set `process.exitCode = 1`, so a launch that went on to work would still
 * have exited non-zero.
 *
 * Splitting the executable half from the library half is the fix, and it is the pattern this
 * repo already uses for exactly this hazard — `invite-cli.ts` and `sensitive-rescreen-cli.ts`
 * are both documented as "deliberately NOT exported: it opens a pool at import". Nothing may
 * re-export this file. `setup-prod.ts` beside it is now pure library: importing it runs nothing.
 */

/**
 * CLI: `pnpm db:setup:prod` (root) — reads `DATABASE_URL_SESSION` from the environment.
 * The URL is never accepted on argv so it cannot land in a shell history or `ps` output.
 *
 * `TF_PROD_DB_HOST` is REQUIRED here (see {@link assertExpectedHost}): the one command in
 * this repository that runs DDL against a real database must state which database it
 * believes that is, and be refused when the URL disagrees. It is not required by the
 * programmatic function, so tests and throwaway databases stay ergonomic.
 *
 * ── EVERY EXIT PATH RETURNS A CODE; NOTHING CALLS `process.exit` ────────────────────────
 *
 * `console.log`/`console.error` QUEUE when the destination is a pipe and `process.exit`
 * discards whatever has not drained. Measured, not assumed:
 * `node -e 'console.log("x".repeat(120000)); process.exit(0)' | wc -c` emits 65536 of 120001
 * on this platform. The exposure is exactly `pnpm db:setup:prod 2>&1 | tee cutover.log` during
 * a cutover — i.e. the line explaining the failure, during the incident. `process.exitCode`
 * plus a natural return keeps the pending write alive until it has left the process; it is
 * the shape `provision-staff-role.ts` already uses.
 *
 * The URL guards moved INSIDE the try for the same reason and one more: `assertSessionUrl` used
 * to be evaluated in the module body, outside any handler, so a rejected `DATABASE_URL_SESSION`
 * reported itself through Node's default path — a stack trace instead of this file's own
 * `[db:setup:prod] FAILED:` line. Same exit code, the CLI's own failure shape.
 *
 * `.then`, NOT top-level `await`, even though `provision-staff-role.ts` uses `await`. That file
 * is a leaf; THIS one is re-exported through `@trafficflow/db/admin` and reaches `apps/admin`
 * and `apps/api-vercel`, so a top-level await here makes an async module out of a dependency of
 * two Next builds. Nothing local runs `next build`, so that is precisely the class of breakage a
 * green `tsc -b` and a green suite would both wave through.
 *
 * `pathToFileURL` and NOT `file://${process.argv[1]}`: the latter is false for any path
 * that needs percent-encoding, so on a checkout under a directory with a SPACE (this
 * one) the script would exit 0 having done nothing at all — a lesson this repository has
 * already paid for once.
 */
async function runCli(): Promise<number> {
  try {
    const url = assertSessionUrl(process.env.DATABASE_URL_SESSION);
    const expectedHost = process.env[PROD_DB_HOST_ENV]?.trim();
    if (!expectedHost) {
      console.error(
        `[db:setup:prod] FAILED: ${PROD_DB_HOST_ENV} is required — set it to the endpoint hostname you ` +
          `intend to provision (it is compared to DATABASE_URL_SESSION before anything is written)`,
      );
      return 1;
    }
    const report = await setupProdDatabase(url, {
      log: (m) => console.log(`[db:setup:prod] ${m}`),
      expectedHost,
      // ALWAYS supplied, even when the environment holds nothing to verify with. The policy is
      // then `unverifiable`, and `setupProdDatabase` — which is the only thing that knows
      // whether this host is Supabase-shaped — turns that into a REFUSAL on a host that has the
      // Data API exposure class, and ignores it on a plain Postgres that cannot. That is what
      // stops this command from ending in `OK` over an endpoint nobody checked: the grant half
      // used to be the whole story here, and a green census is not a verdict about a public
      // key reading tables over HTTP.
      dataApi: dataApiPolicyFromEnv(process.env),
    });
    console.log(JSON.stringify(report, null, 2));
    console.log(
      // PER JOURNAL, not just the total: `28/28` would be printed identically by a database
      // whose two halves were 21/21 + 7/7 and by one that somehow held 28 rows in one table.
      // The pinned per-journal counts are the whole point of the pinning fix, so the line an
      // operator reads states them.
      `[db:setup:prod] OK — ${report.journals.map((j) => `${j.name} ${j.applied}/${j.expected}`).join(", ")} ` +
        `(${report.migrationsApplied}/${report.migrationsExpected} total), ` +
        `pg_trgm ${report.pgTrgmVersion}, applied this run: ` +
        `${report.appliedThisRun.length === 0 ? "none (idempotent no-op)" : report.appliedThisRun.join(", ")}` +
        // The endpoint verdict on the same line an operator reads as the sign-off. A run that
        // got here with a Supabase-shaped host DID probe (an unverifiable policy would have
        // thrown), so this states which endpoint answered nothing and over how many relations.
        `${report.supabaseDataApi
          ? `; data API ${report.supabaseDataApi.endpoint} refused all ` +
            `${report.supabaseDataApi.probed} probed relations` +
            `${report.supabaseDataApi.endpointClosed ? " (endpoint closed this run)" : ""}`
          : ""}`,
    );
    return 0;
  } catch (err: unknown) {
    console.error(`[db:setup:prod] FAILED: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runCli().then((code) => { process.exitCode = code; });
}
