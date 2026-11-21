import { assertSessionUrl, PROD_DB_HOST_ENV, type ProdSetupReport } from "./setup-prod.js";

/**
 * `--store cloud` or `--store server`: what kind of store this is, for the one run that finds it at
 * 1.0.11's schema and moves it to 2.0. No default: without the word that run refuses. Any other
 * run never reads it.
 */
export function storeKindOf(argv: readonly string[]): "cloud" | "server" | undefined {
  const at = argv.indexOf("--store");
  const word = at >= 0 ? argv[at + 1] : argv.find((a) => a.startsWith("--store="))?.slice("--store=".length);
  if (word === undefined) return undefined;
  if (word !== "cloud" && word !== "server") throw new Error("--store takes 'cloud' or 'server'");
  return word;
}

export function setupTargetOf(env: NodeJS.ProcessEnv, sessionUrl = env.DATABASE_URL_SESSION) {
  const url = assertSessionUrl(sessionUrl);
  const expectedHost = env[PROD_DB_HOST_ENV]?.trim();
  if (!expectedHost) {
    throw new Error(
      `${PROD_DB_HOST_ENV} is required — set it to the endpoint hostname you intend to provision ` +
      "(it is compared to DATABASE_URL_SESSION before anything is written)",
    );
  }
  return { url, expectedHost };
}

/** The wrapper relies on the single final line naming both journals separately. */
export function printSetupReport(report: ProdSetupReport): void {
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
      // got here with a host that has a data API DID probe (an unverifiable policy would have
      // thrown), so this states which endpoint answered nothing and over how many relations.
      `${report.dataApi
        ? `; data API ${report.dataApi.endpoint} refused all ` +
          `${report.dataApi.probed} probed relations` +
          `${report.dataApi.endpointClosed ? " (endpoint closed this run)" : ""}`
        : ""}`,
  );
}
