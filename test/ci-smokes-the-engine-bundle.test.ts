import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { publicPath } from "./support/public-root.mjs";

/**
 * A CHECK THAT ONLY RUNS WHEN AN EARLIER CHECK PASSED IS NOT A CHECK.
 *
 * The mirror's `build.yml` renders the WINDOW bundle — the one a real install opens its mail
 * in. For two releases it was never rendered at all, and nothing said so: a second UI artifact
 * existed then (a fixtures-only "interface preview", since retired under the no-demo rule), its
 * smoke sat earlier in the same job, and steps inside a GitHub job are sequential — so a red
 * preview smoke meant the window bundle was never built and never rendered. Not failed, not
 * skipped, never asked. The run was red for the other artifact's reason, and the gap the window
 * smoke would have caught surfaced when the release was cut.
 *
 * The repair is structural rather than diligent, and it OUTLIVES the artifact that caused it:
 * the window bundle is built and rendered in a job of its own, which nothing gates and which
 * gates nothing — so no earlier failure of any kind (a toolchain update, a runtime download, a
 * Rust regression) can ever decide whether the bundle's own question gets asked. This file is
 * what keeps it that way, because the failure it prevents is silent and the next person to tidy
 * this workflow will see three callers of one check and want to remove one.
 *
 * The fail-fast half survives too: each platform job smokes the window bundle BEFORE its native
 * toolchain runs, so a broken UI is a two-minute red rather than an hour-long one.
 *
 * Read against `public/ohmail/github/workflows/build.yml`, which is where that workflow is
 * AUTHORED — the copy at `.github/workflows/build.yml` in the public mirror is replayed from
 * here by `scripts/publish-desktop.mjs`, so this is the file a change has to pass through.
 */

const HERE = fileURLToPath(new URL(".", import.meta.url));
const WORKFLOW = publicPath("github/workflows/build.yml");
const wf = readFileSync(WORKFLOW, "utf8");

/** How the smoke is spelled, in its two invocations. Both literal — a job that reaches the
 *  smoke through a variable or a matrix would defeat the reading below, which is a change this
 *  test should be made to fail on rather than one it should try to follow. `npm run smoke` IS
 *  `smoke.mjs --expect engine` (package.json), and that identity is asserted below rather than
 *  assumed. */
const ENGINE_SMOKE = "scripts/smoke.mjs --expect engine";
const FAILFAST_SMOKE = /^\s*run: npm run smoke\s*$/m;

/**
 * The `jobs:` block, split by job id, WITH COMMENT LINES REMOVED.
 *
 * Job ids are the only keys at exactly two spaces: keys inside a job sit at four, and every
 * `run: |` body in this file is indented at ten or more. The comments have to go because this
 * workflow is heavily commented and a job's banner sits ABOVE its `id:` line, which puts it in
 * the previous job's slice — the first draft of this file read the `engine` job as running the
 * engine smoke and packaging the app, on the strength of the paragraph that introduces the job
 * after it. Prose describing a check is not the check.
 */
function jobs(): { id: string; body: string }[] {
  const at = wf.indexOf("\njobs:\n");
  if (at < 0) throw new Error("build.yml has no top-level `jobs:` block");
  const block = wf.slice(at);
  const heads: { id: string; at: number }[] = [];
  for (const m of block.matchAll(/^ {2}([a-z][\w-]*):\n/gm)) heads.push({ id: m[1], at: m.index! });
  return heads.map((h, i) => ({
    id: h.id,
    body: block
      .slice(h.at, heads[i + 1]?.at ?? block.length)
      .split("\n")
      .filter((line) => !/^\s*#/.test(line))
      .join("\n"),
  }));
}

describe("the window bundle is rendered whatever any other step did", () => {
  it("is smoked in a job that runs nothing else and waits for nothing", () => {
    const smokers = jobs().filter((j) => j.body.includes(ENGINE_SMOKE));
    expect(smokers.map((j) => j.id), `no job in build.yml runs \`${ENGINE_SMOKE}\``)
      .not.toEqual([]);

    /* The whole point. A job with `needs:` can be stopped by whatever it needs, and a job that
       also compiles Rust or downloads a runtime can be stopped by either before it gets here.
       The verdict job is identified as: smokes the bundle, needs nothing, runs no cargo. */
    const independent = smokers.filter(
      (j) => !/^ {4}needs:/m.test(j.body) && !/cargo /.test(j.body),
    );
    expect(
      independent.map((j) => j.id),
      "every job that smokes the window bundle either has `needs:` or can die on a toolchain\n" +
        "  first — which is the arrangement that once left the bundle unrendered for two releases",
    ).not.toEqual([]);
  });

  it("…and that job builds the bundle it renders, rather than inheriting one", () => {
    const [job] = jobs().filter(
      (j) => j.body.includes(ENGINE_SMOKE) && !/^ {4}needs:/m.test(j.body) && !/cargo /.test(j.body),
    );
    expect(job).toBeDefined();
    // `dist/` is written by whichever ui:build ran last. Rendering it without building it here
    // would be smoking somebody else's bytes under this bundle's name.
    expect(job.body, "the independent smoke does not build the window bundle")
      .toContain("npm run ui:build:engine");
  });

  it("every platform job keeps the fail-fast smoke in front of the packaging", () => {
    /* The other half of the arrangement: a red UI must stop a platform job BEFORE it spends an
       hour packaging. The fail-fast smokes THE SAME artifact now (the retired preview once held
       this slot), so it must both build it and smoke it before `app:build:engine` runs. */
    for (const job of jobs().filter((j) => /^\s*run: npm run app:build:engine/m.test(j.body))) {
      const failFast = job.body.search(FAILFAST_SMOKE);
      expect(failFast, `job \`${job.id}\` packages the app but never smokes the bundle first`)
        .toBeGreaterThan(-1);
      expect(
        failFast,
        `job \`${job.id}\` smokes the bundle after it has already packaged the app`,
      ).toBeLessThan(job.body.indexOf("app:build:engine"));
      expect(job.body.indexOf("npm run ui:build:engine"), `job \`${job.id}\` smokes a bundle it never built`)
        .toBeLessThan(failFast);
    }
  });
});

describe("the three callers of the smoke are the same check", () => {
  /* The objection this arrangement has to answer: three callers of one check is one caller that
     can drift. They do not drift while they are the same script with the same argument, so that
     is what is asserted — not that the calls exist, which the tests above already cover. */
  it("the packager and the npm script call it with exactly the argument the workflow does", () => {
    const packager = readFileSync(`${HERE}../apps/desktop/scripts/build-engine-app.mjs`, "utf8");
    expect(packager, "the packaging script no longer smokes the bundle beside the artifact")
      .toMatch(/"smoke\.mjs"\)[^)]*"--expect",\s*"engine"/s);
    expect(wf).toContain(ENGINE_SMOKE);
    // `npm run smoke` — the fail-fast's spelling — is the same script with the same argument.
    const manifest = JSON.parse(
      readFileSync(`${HERE}../apps/desktop/package.json`, "utf8"),
    ) as { scripts: Record<string, string> };
    expect(manifest.scripts.smoke).toBe("node scripts/smoke.mjs --expect engine");
  });

  it("the smoke still understands that argument, and refuses every other — the retired one by name", () => {
    // Derived rather than assumed: renaming the mode on one side only would render nothing
    // under the right name, which is the failure this whole file is about wearing a disguise.
    const smoke = readFileSync(`${HERE}../apps/desktop/scripts/smoke.mjs`, "utf8");
    expect(smoke).toMatch(/if \(EXPECT !== "engine"\)/);
    // `--expect preview` selected the retired fixtures artifact; a stale caller passing it gets
    // its own sentence rather than these checks under an old name.
    expect(smoke).toMatch(/EXPECT === "preview"/);
    expect(smoke).toMatch(/retired/);
  });
});

describe("the workflow that carries all this still runs on its own", () => {
  it("on every push to main, every v* tag and every pull request, not workflow_dispatch alone", () => {
    // A job behind `workflow_dispatch` only would be the same silence with more ceremony.
    expect(wf).toMatch(/\non:\n {2}push:\n {4}branches: \[main\]\n {4}tags: \["v\*"\]\n/);
    // `pull_request:` is asked inside the `on:` block, not beside `push:`: another trigger may sit between.
    const on = /\non:\n((?:[ \t].*\n|\n)*)/.exec(wf)?.[1] ?? "";
    expect(on).toMatch(/^ {2}pull_request:/m);
  });
});
