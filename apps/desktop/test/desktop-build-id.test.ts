/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { BUILD_LABEL, BUILD_SHA, buildLabelOf } from "../src/build-id.js";

const read = (rel: string): string =>
  fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), rel), "utf8");

/**
 * WHICH BUILD IS RUNNING — the identity a desktop artifact did not carry.
 *
 * A candidate, the tag build and any later rebuild all reported one version string with nothing
 * inside to separate them, so no pass could assert that the binary it exercised is the binary the
 * tag ships. Three halves, and each is asserted where it can be: the rule is pure, the wiring is
 * source-level (one test run is not a bundler and not a CI runner), and the label a stamped build
 * shows is checked through the same function the pane renders.
 */
describe("the build identity", () => {
  it("names the commit when there is one, and says nothing when there is not", () => {
    const sha = "5be2690d8a1c4f0e9b3d2a1c5e7f9b0d3a2c4e6f";
    expect(buildLabelOf("0.17.0", sha)).toBe("0.17.0 · 5be2690d8");
    // The ordinary case for anyone building this themselves: no commit to name, so none is named.
    expect(buildLabelOf("0.17.0", "dev")).toBe("0.17.0");
    expect(buildLabelOf("0.17.0", "")).toBe("0.17.0");
  });

  it("REFUSES a value that is not a commit — a partial identifier is worse than none", () => {
    // Anti-vacuity in the direction that matters: the point of the label is that it identifies a
    // build, and a truncated, decorated or dirty value looks like an identifier without being one.
    expect(buildLabelOf("0.17.0", "5be2690d8")).toBe("0.17.0");
    expect(buildLabelOf("0.17.0", "5be2690d8a1c4f0e9b3d2a1c5e7f9b0d3a2c4e6f-dirty")).toBe("0.17.0");
    expect(buildLabelOf("0.17.0", "5BE2690D8A1C4F0E9B3D2A1C5E7F9B0D3A2C4E6F")).toBe("0.17.0");
    expect(buildLabelOf("0.17.0", "not-a-sha-at-all")).toBe("0.17.0");
  });

  it("answers the version alone where no build folded the defines", () => {
    // This import ran without a bundler, so both constants are absent — the same state an
    // unstamped build is in, and the pane must not print a placeholder as if it were a commit.
    expect(BUILD_LABEL).toBe("dev");
    expect(BUILD_SHA).toBe("");
  });

  it("keeps the build define wired in vite.config.ts", () => {
    // The label is only as identifying as the define that feeds it: a build where the define is
    // dropped ships a version string again, which is the state this exists to end.
    expect(read("../vite.config.ts"))
      .toContain('__OHMAIL_BUILD_SHA__: JSON.stringify((process.env.OHMAIL_BUILD_SHA ?? "").trim() || "dev")');
  });

  it("the About pane renders the label, not the bare version", () => {
    /* Source-level for `desktop-platform.test.ts`'s reason: mounting this pane needs the shell's
       mail-state provider, and the regression guarded against is precisely somebody putting the
       raw define back — which is invisible to a rendered assertion in a test run where both
       defines are absent and both answers would be a version string. */
    const src = read("../src/DesktopAbout.tsx")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(src, "the About pane shows the raw version define again").not.toContain("__OHMAIL_VERSION__");
    expect(src, "the About pane does not render the build label").toContain("value={BUILD_LABEL}");
  });

  it("the build workflow supplies the commit to every platform's job", () => {
    /* Workflow-level rather than per-step, because the UI is bundled twice on the macOS job
       (`ui:build:engine`, then again inside `app:build:engine`) and once per job on the other
       three — a per-step env is four places to forget. */
    const wf = read("../../../public/ohmail/github/workflows/build.yml");
    expect(wf, "the build workflow no longer passes its commit to the artifact")
      .toMatch(/^env:\n  OHMAIL_BUILD_SHA: \$\{\{ github\.sha \}\}$/m);
  });
});
