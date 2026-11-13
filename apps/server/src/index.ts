import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { setNoticeSink, noticeSinkFor } from "@trafficflow/db";
import { setupProdDatabase } from "@trafficflow/db/admin";
import { makeOwnedDb } from "@trafficflow/db/cloud";
import { createLogger } from "@trafficflow/core";
import { aiBootFields } from "@trafficflow/core/ai-provider-env";
import { awaitDatabase } from "./await-database.js";
import { processDoor } from "./build-release.js";
import { COLLAPSED_SENTENCE, PROXY_PEER_HEADER, serverConfigOf } from "./config.js";
import { processDoorInput } from "./deps.js";
import { makeHttpServer, makeTrustedProxies, systemLookup } from "./http.js";
import { buildProgram } from "./program.js";
import { loadSettings } from "./settings.js";
import { mintFirstRunSetupToken, printSetupToken } from "./setup-token.js";

/**
 * THE PROCESS DOOR of the API program: one long-running process behind a proxy. It reads the
 * settings, builds the one program (`program.ts`), and serves it over node:http.
 *
 * BOOT, in the ruled order — config → database up → migrate → mint → listen — and each step's
 * placement is a decision:
 *
 *  · **Config first, refusing loudly.** A long-running process may simply not start on a
 *    misshapen value; the message names the variable and never its value (config.ts). The KEK
 *    is the one capture-not-throw: `/health` must come up to NAME a broken ring.
 *  · **A database still starting is waited for, bounded** (await-database.ts), so a slow first
 *    start costs no restart; the migration itself still runs once.
 *  · **`setupProdDatabase` — the library half — before anything touches a table.** Both
 *    journals under the migration advisory lock, `pg_trgm` + the trigram indexes, then the
 *    five-property VERIFICATION (a half-provisioned database refuses the boot rather than
 *    serving 500s). `TF_PROD_DB_HOST` pinning is the CLI's concern, not this host's: here the
 *    URL was configured once, reviewed, and is the same one every request runs on. Only a
 *    configuration whose server migrates its own database does this (`differences.ts`); the
 *    managed service is migrated by its deploy and this process only serves.
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
 * The `BUILD_VERSION` file `scripts/bundle-host.mjs` writes into the layout. Read HERE and handed
 * to the settings: `import.meta` cannot be carried by a module the function door bundles.
 */
const buildVersionFile = (): string => {
  try {
    // From the bundled `bin/ohmail-server.mjs` this is the image's `/app/BUILD_VERSION`; from
    // `src/index.ts` under tsx it is `apps/server/BUILD_VERSION` — absent in a checkout, so a
    // source run falls through to the variable and then to `dev`, the honest answer there.
    return readFileSync(new URL("../BUILD_VERSION", import.meta.url), "utf8").trim();
  } catch {
    // No file means "not a recipe build" — the next source answers.
    return "";
  }
};

async function main(): Promise<void> {
  const settings = loadSettings(process.env, processDoor(buildVersionFile));
  const cfg = serverConfigOf(settings);
  const logger = createLogger({
    service: "server",
    fields: { environment: cfg.environment, version: cfg.version },
  });
  // Postgres notices route through the hardened logger for the life of the process; without a
  // sink `@trafficflow/db` drops them, and a notice's prose can carry row values.
  setNoticeSink(noticeSinkFor(logger));
  // Which model this server answers suggestions and drafts with, and whether its address is the
  // default or one set in .env — the organizer logs the same line. Never the address.
  logger.info("ai_provider_configured", aiBootFields(cfg.ai));

  // The whole program, composed before anything touches a table: nothing here dials the database.
  const program = buildProgram(settings, processDoorInput(logger, (t) => {
    // A token the INVARIANT mints mid-life (the last account erased itself; the boot token
    // expired unredeemed) prints exactly where the boot one did.
    logger.info("first_run_setup_token_minted", { expiresAt: t.expiresAt.toISOString() });
    printSetupToken(t, (line) => { console.log(line); });
  }));
  const db = program.runtime.db.request();

  // A database still starting is waited for here, never by retrying the migration below.
  await awaitDatabase(async () => {
    if (settings.database.kind === "pooled") {
      await db.execute(sql`select 1`);
      return;
    }
    const probe = makeOwnedDb(cfg.databaseUrl);
    try { await probe.db.execute(sql`select 1`); } finally { await probe.close(); }
  }, { onWait: ({ err, tries, elapsedMs }) => logger.warn("boot_database_waiting", { err, tries, elapsedMs }) });

  if (program.chosen.migrations === "at-start") {
    logger.info("boot_migrating");
    const report = await setupProdDatabase(cfg.databaseUrl, {
      // `setupStep`, not `msg`: a generic key admitted by the census would let any later caller
      // log a driver message under it. Only this seam writes this one.
      log: (msg) => logger.info("db_setup", { setupStep: msg }),
    });
    logger.info("boot_migrated", {
      appliedThisRun: report.appliedThisRun,
      migrationsApplied: report.migrationsApplied,
      migrationsExpected: report.migrationsExpected,
    });
  }

  if (program.chosen.firstAccount === "setup-token") {
    const minted = await mintFirstRunSetupToken(db);
    if (minted) {
      logger.info("first_run_setup_token_minted", { expiresAt: minted.expiresAt.toISOString() });
      // The raw token's ONE appearance, on stdout, fenced. Everything else logs around it.
      printSetupToken(minted, (line) => { console.log(line); });
    }
  }

  // WHOSE `x-forwarded-for` NAMES THE CLIENT (`TF_TRUSTED_PROXIES`; the bundled compose names its
  // own proxy). A configured name resolves when a peer first misses the set, and every change of
  // its answer is logged once: that line is where an operator reads the resolved set. An
  // untrusted peer that sends the header, or a trusted one that names no client, is logged once
  // per peer, its address only, never the header.
  const trustedProxies = makeTrustedProxies(cfg.trustedProxies, {
    lookup: systemLookup,
    onNote: (n) => {
      if (n.kind === "resolved") logger.info("trusted_proxy_resolved", { host: n.name, resolved: n.addresses });
      else logger.warn("trusted_proxy_unresolved", { host: n.name, configVar: "TF_TRUSTED_PROXIES" });
    },
  });
  logger.info("trusted_proxies_configured", { configVar: "TF_TRUSTED_PROXIES", count: cfg.trustedProxies.length });
  // THE EXTERNAL DOOR: the proxy decides whose X-Forwarded-For it believes and writes its own peer
  // into PROXY_PEER_HEADER, so a client equal to that peer is one the proxy took nobody's word
  // for. This process states only its own facts: the value it validated, never a gateway it did
  // not resolve (the proxy's log names that).
  const door = cfg.externalDoor;
  const effective = door.door === "external" ? door.raw : "";
  if (door.door === "external") {
    logger.info("external_door_configured", { configVar: "OHMAIL_TLS_TERMINATOR", effective, proxyPeerFrom: PROXY_PEER_HEADER });
  }
  const server = makeHttpServer(program.dispatch, {
    bodyMaxBytes: cfg.bodyMaxBytes,
    headersTimeoutMs: cfg.headersTimeoutMs,
    requestTimeoutMs: cfg.requestTimeoutMs,
    trustedProxies,
    ...(door.door === "external" ? { proxyPeerHeader: PROXY_PEER_HEADER } : {}),
    onForwardingNote: (n) => {
      if (n.kind === "proxy_peer_is_client") {
        logger.warn("forwarded_address_collapsed", {
          host: n.peer, configVar: "OHMAIL_TLS_TERMINATOR", effective, reason: COLLAPSED_SENTENCE,
        });
        return;
      }
      logger.warn(
        n.kind === "untrusted_forwarder" ? "forwarded_header_from_untrusted_peer" : "trusted_proxy_sent_no_client_address",
        { host: n.peer, configVar: "TF_TRUSTED_PROXIES" },
      );
    },
  });

  server.listen(cfg.port, () => {
    logger.info("listening", { port: cfg.port, origin: cfg.origin });
  });

  // THE CLOCKS (`clocks.ts`): a self-hosted server's own sending chain and alert clock, armed as
  // they always were; with `TF_API_CLOCKS=1` also the passes a scheduler pokes, under one leader.
  const clocks = program.startClocks();

  let stopping = false;
  const shutdown = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    // The clocks first: a pass that has not started must not start over a closing pool. One
    // already in flight finishes — a send mid-flight must finalize its reservation, and an alert
    // pass must not log `alert_pass_failed` at every restart — and the pool closes after it.
    const clocksSettled = clocks ? clocks.stop() : Promise.resolve();
    logger.info("shutdown_begin", { signal });
    server.close(() => {
      void (async () => {
        await clocksSettled;
        await program.close();
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
