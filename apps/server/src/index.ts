import { setNoticeSink, noticeSinkFor } from "@trafficflow/db";
import { setupProdDatabase } from "@trafficflow/db/admin";
import { makeOwnedDb, makeChangeWakeHub } from "@trafficflow/db/cloud";
import { createLogger } from "@trafficflow/core";
import { loadServerConfig } from "./config.js";
import { buildServerServices, oauthProviderFor, type ServerRuntime } from "./deps.js";
import { handleServerRequest } from "./handler.js";
import { makeHttpServer } from "./http.js";
import { mintFirstRunSetupToken, printSetupToken } from "./setup-token.js";

/**
 * BOOT, in the ruled order — config → migrate → mint → listen — and each step's placement is a
 * decision:
 *
 *  · **Config first, refusing loudly.** A long-running process may simply not start on a
 *    misshapen value; the message names the variable and never its value (config.ts). The KEK
 *    is the one capture-not-throw: `/health` must come up to NAME a broken ring.
 *  · **`setupProdDatabase` — the library half — before anything touches a table.** Both
 *    journals under the migration advisory lock, `pg_trgm` + the trigram indexes, then the
 *    five-property VERIFICATION (a half-provisioned database refuses the boot rather than
 *    serving 500s). `TF_PROD_DB_HOST` pinning is the CLI's concern, not this host's: here the
 *    URL was configured once, reviewed, and is the same one every request runs on.
 *  · **The setup-token mint after migration, before listen.** After, because the pairing table
 *    has to exist; before, because `/hello` must never answer `needsSetup: true` while the
 *    token that ceremony needs is not yet in the log. Concurrent boots serialize on the mint's
 *    own advisory lock (setup-token.ts).
 *  · **Listen last.** The first request a proxy health-check sends finds a fully provisioned,
 *    fully composed host or no host at all — never a half-booted one.
 *
 * SIGTERM → `server.close()` (stop accepting; in-flight requests finish), open sockets — which
 * on this host means SSE streams — destroyed after a short grace, then the wake hub's LISTEN
 * released, then the pool. The order matters: streams die before the hub so no wake fires into
 * a torn-down fan-out, and the pool goes last because everything above it may still be writing.
 */

/** How long in-flight requests get after SIGTERM before their sockets are destroyed. */
export const SHUTDOWN_GRACE_MS = 5_000;

async function main(): Promise<void> {
  const cfg = loadServerConfig(process.env);
  const logger = createLogger({
    service: "server",
    fields: { environment: cfg.environment, version: cfg.version },
  });
  // Postgres notices route through the hardened logger for the life of the process; without a
  // sink `@trafficflow/db` drops them, and a notice's prose can carry row values.
  setNoticeSink(noticeSinkFor(logger));

  logger.info("boot_migrating");
  const report = await setupProdDatabase(cfg.databaseUrl, {
    log: (msg) => logger.info("db_setup", { msg }),
  });
  logger.info("boot_migrated", {
    appliedThisRun: report.appliedThisRun,
    migrationsApplied: report.migrationsApplied,
    migrationsExpected: report.migrationsExpected,
  });

  const owned = makeOwnedDb(cfg.databaseUrl);

  const minted = await mintFirstRunSetupToken(owned.db);
  if (minted) {
    logger.info("first_run_setup_token_minted", { expiresAt: minted.expiresAt.toISOString() });
    // The raw token's ONE appearance, on stdout, fenced. Everything else logs around it.
    printSetupToken(minted, (line) => { console.log(line); });
  }

  const hub = makeChangeWakeHub(cfg.databaseUrl, logger);
  const rt: ServerRuntime = {
    cfg,
    db: owned.db,
    services: buildServerServices(cfg, owned.db),
    changeWake: hub,
    oauth: oauthProviderFor(cfg, owned.db),
    logger,
  };

  const server = makeHttpServer((req) => handleServerRequest(req, rt), {
    bodyMaxBytes: cfg.bodyMaxBytes,
    headersTimeoutMs: cfg.headersTimeoutMs,
    requestTimeoutMs: cfg.requestTimeoutMs,
  });

  server.listen(cfg.port, () => {
    logger.info("listening", { port: cfg.port, origin: cfg.origin });
  });

  let stopping = false;
  const shutdown = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    logger.info("shutdown_begin", { signal });
    server.close(() => {
      void (async () => {
        await hub.end();
        await owned.close();
        logger.info("shutdown_complete", {});
      })();
    });
    // `close()` waits for in-flight responses, and an SSE stream is in-flight for minutes by
    // design — so after the grace the remaining sockets are destroyed. EventSource clients read
    // that as an ordinary reconnect against a host that is going away.
    const t = setTimeout(() => { server.closeAllConnections(); }, SHUTDOWN_GRACE_MS);
    t.unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err: unknown) => {
  // The refusal path: a named-variable config error or a failed provisioning verification.
  // Message only — a provisioning error names journals and indexes, never credentials.
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
