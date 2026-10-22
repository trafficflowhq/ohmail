import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PG_TEST_URL } from "../../packages/db/src/testing.js";
import { SERVICE_VERDICT_ENV, type ServiceName } from "../../packages/db/src/test-services.js";
import { absentLine, probeServices, serviceAddresses } from "../support/services.js";

/**
 * EACH TEST SERVICE PROBED ONCE, BEFORE ANY TEST FILE: Postgres, GreenMail, Dovecot and RustFS, each
 * by a TCP connect that sends nothing. The result goes to OHMAIL_TEST_SERVICES, which every worker
 * inherits; the runner (`service-gate.runner.ts`) skips a file that needs an absent service and does
 * not check for it itself, and the harness's own gates read the same result. One line per absent
 * service; nothing when all are there. Always written, so a stale value never outlives its run.
 */
const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

export async function setup(): Promise<void> {
  const verdict = await probeServices(process.env, serviceAddresses(process.env, ROOT, PG_TEST_URL));
  process.env[SERVICE_VERDICT_ENV] = JSON.stringify(verdict);
  for (const [name, p] of Object.entries(verdict) as [ServiceName, NonNullable<(typeof verdict)[ServiceName]>][]) {
    if (!p.up) process.stderr.write(absentLine(name, p));
  }
}
