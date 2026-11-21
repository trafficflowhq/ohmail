import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (p: string) => readFileSync(path.join(ROOT, p), "utf8");

/**
 * THE MATRIX'S WIRING, CHECKED FROM THE RUN THAT ALWAYS HAPPENS.
 *
 * The second run proves which store it opened by comparing two environment variables. Both came
 * from a single `env` block in a single config, so deleting that block did two things at once: the
 * run became a copy of the first, and the check written to notice returned early and passed. A
 * guard whose arming and whose subject share one edit is not a guard.
 *
 * So the pairing is asserted from HERE — the default project, which runs on every `pnpm test` —
 * against the config files as text. This file cannot be disarmed by the edit it exists to catch,
 * because it does not read the environment at all.
 */
describe("the two-store matrix is wired the way its guard assumes", () => {
  it("gives every project a declared dialect and an expectation that matches it", () => {
    for (const [file, want] of [["vitest.config.ts", "pg"], ["test/vitest.sqlite.config.ts", "sqlite"]] as const) {
      const src = read(file);
      expect(src, `${file} must declare which store its run opens`)
        .toMatch(new RegExp(`OHMAIL_EXPECT_DIALECT:\\s*"${want}"`));
    }
    // Only the second project sets the dialect itself; the first is the default and sets nothing,
    // which is why its expectation is what makes an unset variable detectable.
    expect(read("test/vitest.sqlite.config.ts")).toMatch(/OHMAIL_TEST_DIALECT:\s*"sqlite"/);
    expect(read("vitest.config.ts")).not.toMatch(/OHMAIL_TEST_DIALECT:/);
  });

  it("keeps the second project's include list narrow and real", () => {
    // Every file the second run claims to cover must exist. A stale entry is a file that "passes"
    // on the second store without ever having been read.
    const src = read("test/vitest.sqlite.config.ts");
    const include = [...src.matchAll(/"(packages\/[^"]+\.test\.ts)"/g)].map((m) => m[1]);
    expect(include.length).toBeGreaterThanOrEqual(6);
    for (const f of include) expect(() => read(f), `${f} is in the sqlite include list`).not.toThrow();
  });
});
