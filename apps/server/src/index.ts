import { setNoticeSink, noticeSinkFor, type Tx } from "@trafficflow/db";
import { setupProdDatabase } from "@trafficflow/db/admin";
import { makeOwnedDb, makeChangeWakeHub, isSuspended } from "@trafficflow/db/cloud";
import { createLogger, UNMETERED_STORAGE_CAP } from "@trafficflow/core";
import { makeSendAdapter } from "@trafficflow/api";
import { runScheduledSendPass } from "@trafficflow/services";
import { loadServerConfig } from "./config.js";
import { buildDeps, buildServerServices, oauthProviderFor, type ServerRuntime } from "./deps.js";
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

/**
 * SEND LATER's clock on this host (mail 0077) — a minute, the hosted deployment's own cadence
 * and for its reason: the appointment's stated precision is "±about a minute". The first pass
 * runs shortly after listen so an appointment that came due during a restart is not a minute
 * later than it already is.
 */
export const SCHEDULED_SEND_EVERY_MS = 60_000;
export const SCHEDULED_SEND_FIRST_DELAY_MS = 15_000;

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
    // A token the INVARIANT mints mid-life (the last account erased itself; the boot token
    // expired unredeemed) prints exactly where the boot one did.
    onSetupTokenMinted: (t) => {
      logger.info("first_run_setup_token_minted", { expiresAt: t.expiresAt.toISOString() });
      printSetupToken(t, (line) => { console.log(line); });
    },
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

  /**
   * ── SEND LATER'S CLOCK RUNS IN THIS PROCESS, AND THAT IS THE DECISION ──────────────────────
   *
   * The hosted deployment drives `runScheduledSendPass` over HTTP because its API host is
   * serverless — something external must supply the clock. THIS host is the opposite case: one
   * always-on process that already holds the database, the key provider and the OAuth token
   * provider, so the pass runs in-process on a settle-then-re-arm chain (never `setInterval`;
   * a slow pass must not overlap itself). Without this, the schedule verbs would accept
   * appointments no clock ever keeps on a box whose operator armed no internal cron — mail
   * "scheduled" forever, which is the feature promising and never delivering. The internal
   * HTTP route stays mounted for an operator who prefers an external scheduler; overlap
   * between the two is safe by the claim's own `FOR UPDATE SKIP LOCKED`.
   *
   * `accountEligible` is the suspension gate: a suspended account's automation must not keep
   * firing (the worker's roster makes the same ruling), so its due rows stay `'scheduled'`,
   * untouched, until the suspension lifts. The storage cap is this host's typed UNMETERED —
   * the same declaration its send route makes for the sent-copy projection.
   */
  let sendClock: ReturnType<typeof setTimeout> | null = null;
  let sendClockStopped = false;
  const armSendClock = (delayMs: number): void => {
    if (sendClockStopped) return;
    sendClock = setTimeout(() => {
      void (async () => {
        try {
          const passDeps = buildDeps(new Request(cfg.origin), rt);
          const r = await runScheduledSendPass(owned.db, {
            openSendAdapter: (mailboxId) => makeSendAdapter(passDeps, mailboxId),
            resolveStorageCap: async () => UNMETERED_STORAGE_CAP,
            accountEligible: async (accountId) => !(await isSuspended(owned.db as unknown as Tx, accountId)),
            log: logger,
          });
          if (r.claimed > 0) {
            logger.info("scheduled_send_pass", {
              claimed: r.claimed, sent: r.sent, unverified: r.unverified,
              failed: r.failed, deferred: r.deferred,
            });
          }
        } catch (err) {
          // The pass absorbs per-row faults itself; this catches the claim. The appointments
          // stand and the next minute asks again — one bad pass never kills the cadence.
          logger.error("scheduled_send_pass_failed", { err });
        } finally {
          armSendClock(SCHEDULED_SEND_EVERY_MS);
        }
      })();
    }, delayMs);
    sendClock.unref();
  };
  armSendClock(SCHEDULED_SEND_FIRST_DELAY_MS);

  let stopping = false;
  const shutdown = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    // The clock first: a pass that has not started must not start over a closing pool. One
    // already in flight finishes — its claim is small and the pool closes after `close()`.
    sendClockStopped = true;
    if (sendClock !== null) clearTimeout(sendClock);
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
