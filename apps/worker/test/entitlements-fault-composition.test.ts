import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { withoutComments } from "../../../scripts/lib/source-scan.mjs";
import { readSource } from "./_start-function.js";

/**
 * THE WORKER COUNTS ITS FAILED CALLS TO THE ENTITLEMENTS PROGRAM, AND READS WHO IS AT A CAP.
 * Every one of its four clients hands the shared recorder the `worker` arm — never awaited on the
 * per-mailbox path, awaited in the cron processes that exit when their pass ends — and its alert
 * pass takes the at-cap reader from the same bag as the parked one. Source, comments blanked.
 */

const REPO = fileURLToPath(new URL("../../..", import.meta.url));
const read = (p: string): string => withoutComments(readSource(`${REPO}/${p}`));
const RECORDER = /entitlementsFaultRecorder\(\(\) => db as unknown as Tx, "worker"/;

describe("the worker's entitlements clients record what fails", () => {
  it("the per-mailbox client records through the recorder and does not wait on the write", () => {
    const src = read("apps/worker/src/index.ts");
    expect(src).toMatch(new RegExp(`const recordEntitlementsFault = ${RECORDER.source}`));
    expect(src).toMatch(/onCallFault: \(f\) => \{ void recordEntitlementsFault\(f\); \}/);
  });

  it.each(["proposal-cron", "reconcile-cron", "workflow-cron"])("%s awaits the recorder", (name) => {
    expect(read(`apps/worker/src/${name}.ts`)).toMatch(new RegExp(`onCallFault: ${RECORDER.source}`));
  });

  it("the alert pass reads who is at a cap from the bag its parked reader comes from", () => {
    const src = read("apps/worker/src/index.ts");
    expect(src).toMatch(/const alertReaders = alertReadersOf\(entitlements\);/);
    expect(src).toMatch(/parkedAccountsReader: ParkedAccountsReader \| null = alertReaders\.parkedAccounts;/);
    expect(src).toMatch(/accountsAtCap: alertReaders\.accountsAtCap,/);
  });

  it("the needles do not match a composition that records nothing", () => {
    const bare = withoutComments("makeEntitlementsClient({ baseUrl, secret, onCallFault: \"unrecorded\" });\n");
    expect(bare).not.toMatch(new RegExp(`onCallFault: ${RECORDER.source}`));
    expect(withoutComments("onCallFault: async (f) => { await recordEntitlementsFault(f); },\n"))
      .not.toMatch(/onCallFault: \(f\) => \{ void recordEntitlementsFault\(f\); \}/);
    expect(withoutComments("parkedAccounts: parkedAccountsReader,\n")).not.toMatch(/accountsAtCap: alertReaders\.accountsAtCap,/);
  });
});
