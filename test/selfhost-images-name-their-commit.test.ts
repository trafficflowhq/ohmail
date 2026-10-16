import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { publicRel } from "./support/public-root.mjs";

/**
 * A RELEASED SELF-HOST IMAGE MUST BE ABLE TO NAME THE COMMIT IT WAS BUILT FROM.
 *
 * Measured on the tag's own images at 0.20.0: `/health` answered `"version":"dev"` and the About
 * pane read "build dev." — so an operator asking what they run was told nothing, and the only
 * thing that identified a build was the registry digest. Two builds of one release are
 * indistinguishable in that state, which is exactly the property a release ceremony's Rule 0
 * needs on this surface.
 *
 * The fix is one build argument, `TF_BUILD_VERSION`, carried by all three recipes into the place
 * their OWN reader consults — which is not the same place for all three, and that is what most of
 * this file is about. A recipe that declares the ARG and never lands it where its process looks
 * builds fine, ships, and answers `dev` again.
 */
const HERE = fileURLToPath(new URL(".", import.meta.url));
const ROOT = `${HERE}..`;

const read = (p: string): string => readFileSync(`${ROOT}/${p}`, "utf8");

/** The three recipes the release workflow builds and publishes. */
const RECIPES = [
  "apps/server/Dockerfile",
  "apps/worker/Dockerfile.selfhost",
  "apps/webapp/Dockerfile",
] as const;

describe("the released self-host images carry a build identity", () => {
  it.each(RECIPES)("%s declares the build argument", (file) => {
    const text = read(file);
    expect(text, `${file} declares no TF_BUILD_VERSION argument`).toMatch(/^ARG TF_BUILD_VERSION=""$/m);
    expect(text, `${file} declares the argument and never puts it in the environment`)
      .toMatch(/^ENV TF_BUILD_VERSION=\$\{TF_BUILD_VERSION\}$/m);
  });

  /**
   * The API host reads the `BUILD_VERSION` FILE the host bundler writes into the layout BEFORE
   * any variable (`apps/server/src/config.ts` — `buildIdentityOf`, since the buildSource fix), so
   * the argument goes into the BUILD stage, where `bundle-host.mjs` bakes it — the organizer's
   * arrangement, and what stops a compose-override variable outranking the image's own identity.
   */
  it("the API host takes it into the bundle, before the label file is written", () => {
    const text = read("apps/server/Dockerfile");
    const env = text.indexOf("ENV TF_BUILD_VERSION=");
    const bundle = text.indexOf("node scripts/bundle-host.mjs server");
    expect(bundle, "the API recipe no longer runs the host bundler").toBeGreaterThan(-1);
    expect(env, "the API host sets it after the bundle that writes BUILD_VERSION")
      .toBeLessThan(bundle);
    expect(env).toBeGreaterThan(-1);
  });

  /**
   * The runtime stage STATES the value too — documentation for a `docker inspect` reader and the
   * fallback for a bundle run outside the recipes; the file above is the authority.
   */
  it("the API host restates it in the stage that starts the process", () => {
    const text = read("apps/server/Dockerfile");
    const env = text.lastIndexOf("ENV TF_BUILD_VERSION=");
    expect(env, "the runtime restatement is gone").toBeGreaterThan(text.lastIndexOf("\nFROM "));
    expect(env, "the API host sets it after its CMD").toBeLessThan(text.lastIndexOf("\nCMD "));
  });

  /**
   * THE ORGANIZER DOES NOT TAKE IT FROM THE ENVIRONMENT, AND THAT IS DELIBERATE.
   * `apps/worker/src/build-version.ts` reads `BUILD_VERSION` beside the bundle BEFORE it reads
   * `TF_BUILD_VERSION`, and `buildIdentityErrorOf` reports a variable-sourced label as one that
   * "may name a build this image was never built from" — true of a variable set beside a
   * container, false of one baked in, but the code cannot tell the two apart. So the argument is
   * in the BUILD stage, where `bundle-host.mjs` reads it and writes the label into the layout.
   */
  it("the organizer takes it into the bundle, before the label file is written", () => {
    const text = read("apps/worker/Dockerfile.selfhost");
    const env = text.lastIndexOf("ENV TF_BUILD_VERSION=");
    const bundle = text.indexOf("node scripts/bundle-host.mjs worker");
    expect(bundle, "the organizer recipe no longer runs the host bundler").toBeGreaterThan(-1);
    expect(env, "the organizer sets it after the bundle that writes BUILD_VERSION")
      .toBeLessThan(bundle);
  });

  /**
   * The web app INLINES the identity at `next build` (`next.config.mjs` → `NEXT_PUBLIC_BUILD`,
   * the short sha the About pane prints), so a runtime-only ENV would be baked as `dev` and never
   * read again. It is stated twice on purpose: `next start` re-evaluates the config.
   */
  it("the web app takes it into the build AND the runtime stage", () => {
    const text = read("apps/webapp/Dockerfile");
    const build = text.indexOf("ENV TF_BUILD_VERSION=");
    const runtime = text.lastIndexOf("ENV TF_BUILD_VERSION=");
    const nextBuild = text.indexOf("npx --offline next build");
    expect(nextBuild).toBeGreaterThan(-1);
    expect(build, "the web app builds before it is told which commit it is").toBeLessThan(nextBuild);
    expect(runtime, "the web app states it once, so `next start` re-evaluates without it")
      .toBeGreaterThan(text.lastIndexOf("\nFROM "));
  });

  /**
   * The label the organizer reads is written by the shared host bundler, and the ARG is worth
   * nothing if that write ignores it. A STRUCTURAL reading — the script is an entry point that
   * bundles a whole app on import, so it cannot be driven from here; the end-to-end reading is a
   * `docker build` with the argument, booted, answering the sha on `/health`.
   */
  it("the host bundler prefers the commit over the release number", () => {
    const text = read("scripts/bundle-host.mjs");
    expect(text, "the bundler no longer reads the build argument")
      .toMatch(/const label = String\(process\.env\.TF_BUILD_VERSION \?\? ""\)\.trim\(\) \|\| version;/);
    expect(text, "the bundler writes something other than the resolved label")
      .toMatch(/writeFileSync\(join\(out, "BUILD_VERSION"\), `\$\{label\}\\n`\);/);
  });
});

describe("the release workflow hands every image the tagged commit", () => {
  const workflow = read(publicRel("github/workflows/ghcr-images.yml"));

  it("passes the argument to the build step", () => {
    expect(workflow, "the workflow builds the images without a build argument")
      .toMatch(/build-args: \|\n\s+TF_BUILD_VERSION=\$\{\{ github\.sha \}\}/);
  });

  /**
   * ONE step builds every image — the matrix is what makes it six jobs — so "passed for each
   * build job" is the matrix naming all three images beside that step, not three copies of it.
   */
  it("that step is the one every image goes through", () => {
    expect(workflow).toMatch(/image: \[ohmail-server, ohmail-worker, ohmail-web\]/);
    const matrix = workflow.indexOf("image: [ohmail-server");
    const args = workflow.indexOf("TF_BUILD_VERSION=${{ github.sha }}");
    const nextJob = workflow.indexOf("\n  gate-boot:", matrix);
    expect(args, "the build argument is outside the job the matrix drives").toBeGreaterThan(matrix);
    expect(args).toBeLessThan(nextJob);
  });

  /**
   * ANTI-VACUITY. The argument defaults to EMPTY in every recipe, so a clone building an image
   * by hand gets no argument, no failure, and the honest `dev` — the state this file is about is
   * a RELEASED image, not every image. And the managed organizer recipe is deliberately absent
   * from the list above: it is not built here, and its label comes from the deploy script.
   * Once the managed deployment runs `ohmail-worker-managed`, that image is this build's alias.
   */
  it("a build with no argument still builds, and the managed recipe is not claimed", () => {
    for (const file of RECIPES) expect(read(file)).toContain('ARG TF_BUILD_VERSION=""');
    expect(RECIPES as readonly string[]).not.toContain("apps/worker/Dockerfile");
    expect(RECIPES).toHaveLength(3);
  });
});
