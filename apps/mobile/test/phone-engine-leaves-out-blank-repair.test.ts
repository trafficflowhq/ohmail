/**
 * The blank repair leaves the phone's engine. It runs on the desktop app, the hosted worker and the
 * self-host organizer; the phone keeps the fix that stops new blanks and gets the repair in a later
 * version. Two `WORKSPACE_MODULE_SUBSTITUTES` rows in `apps/sidecar/src/phone/aliases.js` take its
 * pass (`apps/worker/src/blank-repair.ts`, where the cycle imports it) and its one store read
 * (`packages/core/src/adapters/blank-rows.ts`, where the repository imports it) out, each for a twin
 * that refuses by name, and the phone's composition passes `blankRepair: "off"`, so the cycle never
 * calls the twin. A phone runs no repair, whole or in part.
 *
 * Read from the artifact: the real modules are not inputs, the twins are, the importers still are,
 * and none of the repair's own strings is in the text.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { REPO, buildPhoneEngine } from "../scripts/bundle-engine.mjs";

const TWINS = ["apps/sidecar/src/phone/blank-repair.ts", "apps/sidecar/src/phone/blank-rows.ts"];
const LEFT_OUT = /^(?:apps\/worker\/(?:src|dist)\/blank-repair|packages\/core\/(?:src|dist)\/adapters\/blank-rows)\.[jt]s$/;
/* Strings only the real modules carry: the pass's two failure events, and the blank's dedup key,
   which the store read is the one phone-reachable user of. */
const MARKERS = [
  "blank_repair_fetch_failed",
  "blank_repair_move_failed",
  "fp1:5c4048857eee31fa015e82f59ce5977ef899eee90c8b1cb25eb6599f6f3e69ab",
];

describe("the phone engine carries no blank repair", () => {
  it("the twins are inputs, the real modules are not, and the table applied each row once", async () => {
    const { inputs, applied, text } = await buildPhoneEngine({ write: false });
    expect(inputs.filter((p: string) => LEFT_OUT.test(p))).toEqual([]);
    expect(inputs.filter((p: string) => TWINS.includes(p)).sort()).toEqual(TWINS);
    const rows = applied.filter(([, to]: [string, string]) => TWINS.some((t) => to.endsWith(t)));
    expect(rows.map(([from]: [string, string]) => from).sort()).toEqual(["./blank-repair.js", "./blank-rows.js"]);
    // The importers are still in, so each twin answers a real importer.
    for (const importer of [/^apps\/worker\/(dist|src)\/sync\.[jt]s$/, /^packages\/core\/(dist|src)\/adapters\/drizzle-repo\.[jt]s$/]) {
      expect(inputs.some((p: string) => importer.test(p)), String(importer)).toBe(true);
    }
    expect(MARKERS.filter((m) => text.includes(m))).toEqual([]);
    // Not vacuous: the cycle's call site and the twins' refusal are in the text.
    expect(text).toContain("blank_repair_pass_failed");
    expect(text).toContain("this build does not repair blank messages");
  }, 120_000);

  it("the phone's composition passes blankRepair off to the engine it builds", () => {
    const src = readFileSync(join(REPO, "apps", "sidecar", "src", "mobile.ts"), "utf8");
    const call = /await createSidecar\(\{([\s\S]*?)\n  \}\);/.exec(src);
    expect(call, "the phone's createSidecar call was not found").not.toBeNull();
    const body = call![1]!;
    expect(body.match(/\bblankRepair:/g) ?? []).toHaveLength(1);
    expect(body).toMatch(/^\s+blankRepair: "off",$/m);
    // The only createSidecar the phone composes.
    expect(src.match(/\bcreateSidecar\(\{/g) ?? []).toHaveLength(1);
  });
});
