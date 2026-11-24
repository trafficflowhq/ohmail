import { noticeSinkFor, setNoticeSink } from "@trafficflow/db";
import { API_MAX_DURATION_MS, resetAdminDbs, type AlertSink, type RetiredKekReferences } from "@trafficflow/db/cloud";
import { createLogger, type Logger } from "@trafficflow/core";
import { SEND_ATTACHMENT_MAX_TOTAL_BYTES } from "@trafficflow/services";
import type { ApiDeps } from "@trafficflow/api";
import { buildProgram, kekRetirementCheck, resetHandles, type DoorInput, type Program } from "@ohmail/server/program";
import type { HostConfig } from "./config.js";
import { HOSTED_LARGE_BODY_MAX_BYTES } from "./prefix.js";
import { handOff } from "./quiet-hold.js";

/**
 * THE FUNCTION DOOR onto the one API program (`@ohmail/server/program`).
 *
 * What a function is, as the program's inputs ({@link doorInput}): the platform's request-body cap,
 * its invocation ceiling, a cold start that must not pay for services no request asked for, and
 * the hand-off that keeps an instance awake for work that outlives an answer. Everything else —
 * the service bag, the per-request deps, the dispatch — is the program's, built once per cold
 * instance and keyed on the config object, so a test that loads a different environment gets a
 * different program.
 */

/** One base logger per cold instance; `withRequestId` children it per request. */
let loggerCache: { key: object; logger: Logger } | null = null;
function hostLogger(cfg: HostConfig): Logger {
  if (loggerCache && loggerCache.key === cfg) return loggerCache.logger;
  const logger = createLogger({
    service: "api",
    fields: { environment: cfg.environment, version: cfg.version },
  });
  // `@trafficflow/db` DROPS Postgres notices until a host installs a sink, so without this the
  // API's notices are silent rather than structured. Installed here because this function already
  // owns the once-per-cold-instance lifetime; a warm instance reuses the cached logger, so the sink
  // stays valid for the life of the instance. Only `severity` and `code` cross the boundary — the
  // notice's own prose can carry row values, which is the whole point of the module.
  setNoticeSink(noticeSinkFor(logger));
  loggerCache = { key: cfg, logger };
  return logger;
}

/**
 * What this door is, to the program. The body ceiling is the platform's own request-body cap
 * (`prefix.ts`); 3 MiB of raw attachment bytes encode to about 4 MB, which clears it with room for
 * the JSON envelope. `API_MAX_DURATION_MS` is the catch-all route's `maxDuration`: the platform
 * kills an invocation there, and the drafting and screener services cut their model calls before it.
 */
export function doorInput(cfg: HostConfig): DoorInput {
  const logger = hostLogger(cfg);
  return {
    logger,
    bodyMaxBytes: HOSTED_LARGE_BODY_MAX_BYTES,
    sendSurfaceMaxTotalBytes: SEND_ATTACHMENT_MAX_TOTAL_BYTES,
    invocationBudgetMs: API_MAX_DURATION_MS,
    // A bare `GET /health` must not pay the auth service's scrypt warm-up on every cold start.
    lazyServices: true,
    // The platform owns the socket: an unread body is its to discard.
    closeUndrained: false,
    // This platform freezes an instance once it answers; work behind an answer is handed to it.
    afterAnswer: handOff,
    // A first-run setup token is a self-hosted server's ceremony; printed where a log is read.
    onSetupTokenMinted: (minted) => {
      logger.info("first_run_setup_token_minted", { expiresAt: minted.expiresAt.toISOString() });
    },
  };
}

let programCache: { key: object; program: Program } | null = null;

/** The program for this config: one per cold instance. */
export function programFor(cfg: HostConfig): Program {
  if (programCache && programCache.key === cfg) return programCache.program;
  const program = buildProgram(cfg.settings, doorInput(cfg));
  programCache = { key: cfg, program };
  return program;
}

/** Build the request container. `req` is the ALREADY-NORMALIZED request. */
export function buildDeps(req: Request, cfg: HostConfig): ApiDeps {
  return programFor(cfg).buildDeps(req);
}

/** The pager's arms, the list `deps.alerts` hands the pass. */
export function alertSinksFor(cfg: HostConfig): AlertSink[] {
  return programFor(cfg).runtime.alertSinks;
}

/** The last-resort page's arms: the same objects, the mail arm database-free. */
export function lastResortSinksFor(cfg: HostConfig): AlertSink[] {
  return programFor(cfg).runtime.alertLastResortSinks;
}

/** `/health`'s key-retirement check for this config, over `read`. */
export function kekRetirementFor(
  cfg: HostConfig, read: (retiredThrough: number) => Promise<RetiredKekReferences>,
): () => Promise<{ error: string; detail: string } | null> {
  return kekRetirementCheck(cfg.kekRetiredThrough, read);
}

/** Test seam: drop the cached program and everything built with it. */
export function resetServices(): void {
  programCache = null;
  loggerCache = null;
  // Cleared with the logger it was built from: a sink outliving its logger would keep a torn-down
  // test's logger alive and attribute the next test's notices to it.
  setNoticeSink(null);
  // Both halves: the closure cache and the PROBE cache in `@trafficflow/db`. A test that points one
  // URL at a different role must not be answered by a handle probed against the previous one.
  resetHandles();
  resetAdminDbs();
}
