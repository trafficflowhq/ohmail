import { pathToFileURL } from "node:url";
import {
  assertSessionUrl, setupProdDatabase, PROD_DB_HOST_ENV,
} from "./setup-prod.js";
import { dataApiPolicyFromEnv } from "./supabase-lockdown-core.js";

/**
 * The `pnpm db:setup:prod` entry point, kept in a module NOTHING re-exports. The guard at the
 * bottom asks "was this module run directly?" by comparing `import.meta.url` with
 * `process.argv[1]` — correct in a module graph, unanswerable in a BUNDLE: every module reports
 * the bundle's own URL, the comparison is true, and the CLI runs inside whatever program included
 * it. Not hypothetical: `setup-prod.ts` is re-exported through `/admin`, so bundling the engine
 * put this guard in the artifact, where it fired on every launch — the packaged engine tried to
 * provision a PRODUCTION database at startup. Splitting executable from library is the repo's
 * existing pattern. Nothing may re-export this file; `setup-prod.ts` is now pure library.
 */

/**
 * CLI: `pnpm db:setup:prod` — reads `DATABASE_URL_SESSION` from the environment; never on argv,
 * so it cannot land in shell history or `ps`. `TF_PROD_DB_HOST` is REQUIRED: the one command that
 * runs DDL against a real database must state which database it believes that is. Every exit path
 * returns a code; nothing calls `process.exit`: `console.log` QUEUES on a pipe and `process.exit`
 * discards what has not drained — the lost line is the one explaining the failure. `tsx` masks
 * it; a test unmasks it. The URL guards live INSIDE the try, so a rejected URL reports through
 * this file's own `FAILED:` line. `.then`, NOT top-level `await`: this file reaches two Next
 * builds. `pathToFileURL`, not `file://${argv}` — a checkout under a SPACE exits 0 silently.
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
