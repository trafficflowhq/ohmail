import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * EVERY `change_log` WRITER SIGNALS, because there is exactly ONE writer.
 *
 * The wake channel's whole claim is "any committed append wakes the listeners" — from the
 * worker's ingest, the API's record-at-send, the screener, triage, the sidecar's local mirror.
 * That claim is not enforced by auditing call sites; it is enforced by there BEING one site:
 * `recordChanges` in `packages/db/src/change-log.ts` is the only production code that inserts
 * into `change_log`, and the wake signal lives inside it, in the same transaction as the insert.
 *
 * This test is the half a pg test cannot be: `change-notify.pg.test.ts` proves the chokepoint
 * notifies; this proves everything IS the chokepoint. A new writer that inserts into the table
 * directly would ship mutations no push client ever hears about — mail that arrives only on the
 * safety poll — and nothing at runtime would ever say so. Route the new writer through
 * `recordChanges` (or `recordChange`); do not add it to an allowlist here.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/** The production source trees that may touch the mail journal at all. */
const SRC_DIRS = [
  "packages/db/src",
  "packages/services/src",
  "packages/api/src",
  "packages/core/src",
  "packages/client-engine/src",
  "apps/worker/src",
  "packages/organizer/src",
  "apps/sidecar/src",
];

function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx|mts|cts)$/.test(name) && !name.endsWith(".d.ts")) out.push(p);
    }
  };
  walk(dir);
  return out;
}

describe("the change_log append chokepoint", () => {
  it("no production code inserts into change_log outside change-log.ts", () => {
    const offenders: string[] = [];
    for (const dir of SRC_DIRS) {
      for (const file of tsFilesUnder(join(ROOT, dir))) {
        if (file.endsWith(join("packages", "db", "src", "change-log.ts"))) continue;
        const text = readFileSync(file, "utf8");
        // The drizzle spelling (`insert(changeLog)`) and the raw-SQL spelling both count: an
        // insert this scan cannot see is an insert no listener will hear.
        if (/insert\s*\(\s*changeLog\s*\)/.test(text) || /insert\s+into\s+change_log/i.test(text)) {
          offenders.push(file.slice(ROOT.length + 1));
        }
      }
    }
    expect(offenders, "a change_log writer bypasses recordChanges — its commits wake nobody").toEqual([]);
  });

  it("the NOTIFY lives inside recordChanges, in the same transaction as the insert", () => {
    const src = readFileSync(join(ROOT, "packages/db/src/change-log.ts"), "utf8");
    const fn = src.slice(src.indexOf("export async function recordChanges"));
    const body = fn.slice(0, fn.indexOf("\n}"));
    // THROUGH THE SEAM'S MEMBER, not the server's function name. The two deliveries are genuinely
    // different and the seam says so: the server queues the notification and hands it to listeners
    // on OTHER connections at commit; the device store has no such thing, so the payload goes to an
    // in-process emitter and reaches only this program — which is the whole audience on a device,
    // where the reader and the writer are one process. What this case guards is unchanged: the
    // signal lives inside `recordChanges`, in the same transaction as the insert.
    expect(body, "recordChanges no longer notifies — every writer went silent at once")
      .toMatch(/\bdialect\([^)]*\)\.notify\(/);
    expect(body).toContain("CHANGE_LOG_CHANNEL");
    // The payload builder is the ONLY thing interpolated beside the channel: account id + seq.
    // Content in the payload ends up in pg logs; see CHANGE_LOG_CHANNEL's doc.
    expect(body).toContain("changeWakePayload(accountId,");
  });

  it("the payload builder cannot carry content — it is exactly `accountId:seq`", () => {
    const src = readFileSync(join(ROOT, "packages/db/src/change-log.ts"), "utf8");
    const fn = src.slice(src.indexOf("export function changeWakePayload"));
    const body = fn.slice(0, fn.indexOf("\n}"));
    expect(body).toContain("return `${accountId}:${seq}`;");
  });
});
