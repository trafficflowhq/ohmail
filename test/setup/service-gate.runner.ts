import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";
import { VitestTestRunner } from "vitest/runners";
import { readServiceVerdict, serviceUp } from "../../packages/db/src/test-services.js";
import { SERVICE_GATE_PREFIX, classifyPath } from "../support/service-needs.mjs";

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const memo = new Map<string, Set<string>>();
type ImportSource = Parameters<VitestTestRunner["importFile"]>[1];

/**
 * A FILE THAT NEEDS A MISSING TEST SERVICE IS SKIPPED, NAMED, WITHOUT BEING LOADED. When the run's
 * probe (`services.global.ts`) found a service absent, a file that needs it (`service-needs.mjs`)
 * and does not check for it itself is replaced by one skipped describe that says which service,
 * where, and why. Under the service's require variable it fails instead. With nothing absent, or
 * no probe, every file loads as it always did. A classification error fails the file, never skips it.
 */
export default class ServiceGateRunner extends VitestTestRunner {
  importFile(filepath: string, source: ImportSource): unknown {
    if (source !== "collect") return super.importFile(filepath, source);
    const verdict = readServiceVerdict(process.env);
    if (verdict === null || !Object.values(verdict).some((p) => p !== undefined && !p.up)) return super.importFile(filepath, source);
    const missing: string[] = [];
    for (const name of classifyPath(filepath, ROOT, memo).gate) {
      const s = serviceUp(name);
      if (!s.up) missing.push(s.why);
    }
    if (missing.length === 0) return super.importFile(filepath, source);
    for (const why of missing) describe.skip(`${SERVICE_GATE_PREFIX}${why}`, () => { it("not run here", () => {}); });
    return Promise.resolve();
  }
}
