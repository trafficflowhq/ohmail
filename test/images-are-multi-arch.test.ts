import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { publicPath, publicRel } from "./support/public-root.mjs";

/**
 * THE SELF-HOST IMAGES RUN ON arm64, AND THAT IS A CLAIM, SO IT IS TESTED.
 *
 * `docs/self-host/README.md`, `deploy/umbrel/README.md` and `deploy/start9/README.md` all tell
 * a reader the three images are built for amd64 AND arm64. Whole classes of hardware are
 * invited in on the strength of that sentence — a Raspberry Pi, an Asahi Mac, an Ampere or
 * Graviton box — and the only thing that makes it true is a handful of lines in one workflow
 * file, in a repository where nothing else reads them.
 *
 * WHAT BREAKING IT LOOKS LIKE, WHICH IS WHY REGEXES OVER YAML ARE WORTH THIS MUCH:
 *
 *   * Someone drops `arm64` from the build matrix (arm runners were slow that week, or a
 *     failing arm build was in the way of a release). `docker buildx imagetools create` then
 *     composes a "manifest list" out of the one manifest it was given, the promotion goes
 *     green, `latest` still resolves for every amd64 puller — and every ARM operator's next
 *     `docker compose pull` says `no matching manifest for linux/arm64/v8`. The docs still
 *     promise arm64. Nothing in CI notices, because from CI's point of view a release built,
 *     booted and promoted.
 *   * Someone points both matrix legs at `ubuntu-latest` and adds QEMU. The images still say
 *     arm64 and the manifest list is still well formed; what changed is that a Node toolchain
 *     is now cross-compiling under emulation, which is where the flaky, silently-wrong native
 *     halves come from.
 *   * Someone gives both arches ONE buildx cache scope. Two builds writing one scope hand each
 *     other layers, and the surviving evidence of a mixed-arch image is a runtime `exec format
 *     error` on somebody's Pi.
 *   * Someone adds `platform: linux/amd64` to a compose service — the reflex fix for a local
 *     Docker Desktop annoyance — and pins every operator, on every architecture, to the amd64
 *     image.
 *
 * All four are single-line edits that read as tidying. None of them fails a build.
 *
 * The registry side cannot be asserted here (it needs the network, and this suite is offline),
 * so what is asserted is the SHAPE THAT PRODUCES the registry state: both arches, each built
 * and BOOTED on its own hardware, cached apart, composed together, and never pinned away by
 * the compose an operator runs. The live manifests were read once by hand at the time this was
 * written — `ohmail-server`, `ohmail-worker` and `ohmail-web` at `latest` and at `0.11.0` are
 * OCI image indexes carrying linux/amd64 and linux/arm64 — and that reading is exactly what
 * this file exists to keep true without repeating it.
 */

const HERE = fileURLToPath(new URL(".", import.meta.url));
const ROOT = `${HERE}..`;

const workflow = readFileSync(publicPath("github/workflows/ghcr-images.yml"), "utf8");
const compose = readFileSync(`${ROOT}/deploy/selfhost/docker-compose.yml`, "utf8");
const selfhostReadme = readFileSync(`${ROOT}/docs/self-host/README.md`, "utf8");
const vps = readFileSync(`${ROOT}/docs/self-host/VPS.md`, "utf8");
const umbrel = readFileSync(`${ROOT}/docs/self-host/UMBREL.md`, "utf8");
const projectReadme = readFileSync(publicPath("README.md"), "utf8");

/** The three published recipes, and the images they become. */
const RECIPES = [
  { image: "ohmail-server", dockerfile: "apps/server/Dockerfile" },
  { image: "ohmail-worker", dockerfile: "apps/worker/Dockerfile.selfhost" },
  { image: "ohmail-web", dockerfile: "apps/webapp/Dockerfile" },
] as const;

/**
 * One job's YAML block, by name, up to the next top-level job key.
 *
 * The trailing sentinel is what lets the LAST job in the file be read like any other. Without
 * it `promote` matched nothing, `m` was null, and — had the null check not been there — every
 * assertion about promotion would have passed against an empty string. Which is this file's
 * own subject matter: a check that cannot fail.
 */
function job(name: string): string {
  const sentinel = ["", "  zzz-end-sentinel:", ""].join("\n");
  const m = new RegExp(`\\n {2}${name}:\\n([\\s\\S]*?)(?=\\n {2}[a-z][a-z-]*:\\n)`).exec(
    workflow + sentinel,
  );
  expect(m, `the ghcr-images workflow has no ${name} job`).not.toBeNull();
  const block = m![1];
  expect(block.length, `the ${name} job block came back empty`).toBeGreaterThan(50);
  return block;
}

/** Prose wraps; the claims in it do not. Match against one line, never the layout. */
const flow = (s: string) => s.replace(/\s+/g, " ");

/**
 * A Dockerfile's LOGICAL instructions: comment lines dropped, backslash continuations folded
 * into the instruction they belong to. Anything that scans a Dockerfile line by line is
 * scanning fragments, and a fragment that begins mid-instruction belongs to no instruction at
 * all as far as a `/^RUN/` filter is concerned.
 */
function joinContinuations(text: string): string[] {
  const out: string[] = [];
  let open = false;
  for (const raw of text.split("\n")) {
    // A COMMENT LINE IS REMOVED AND CHANGES NOTHING ELSE — including inside a continued
    // instruction, which is how docker's own parser reads it. Recomputing `open` from a
    // comment line was a defect with two faces, both of them silent: the comment does not
    // end in a backslash, so it CLOSED the instruction and orphaned everything after it
    // (`RUN set -eux; \` / `# why` / `&& curl …-linux-x64…` — the curl fragment then
    // belongs to no RUN and is never scanned), and a comment that happens to say "curl"
    // would have been scanned as if it were a command.
    if (/^\s*#/.test(raw)) continue;
    if (open) out[out.length - 1] += `\n${raw}`;
    else out.push(raw);
    open = /\\\s*$/.test(raw);
  }
  return out;
}

describe("the published images are multi-arch, and stay that way", () => {
  it("builds both architectures, for all three images", () => {
    const build = job("build-push");
    expect(build).toMatch(/arch:\s*\[amd64,\s*arm64\]/);
    expect(build).toMatch(/image:\s*\[ohmail-server,\s*ohmail-worker,\s*ohmail-web\]/);
    // The platform actually handed to buildx follows the matrix leg. A literal
    // `platforms: linux/amd64` here would build one arch twice under two tag names.
    expect(build).toContain("platforms: linux/${{ matrix.arch }}");
    for (const { dockerfile } of RECIPES) expect(build).toContain(dockerfile);
  });

  it("each architecture builds on its own hardware — never QEMU", () => {
    const build = job("build-push");
    expect(build).toContain("runs-on: ${{ matrix.runner }}");
    // `ubuntu-24.04-arm` is a real aarch64 host, free on public repositories.
    expect(build).toMatch(/- arch: arm64\n\s+runner: ubuntu-24\.04-arm\b/);
    expect(build).toMatch(/- arch: amd64\n\s+runner: ubuntu-latest\b/);
    // Emulation is the thing being avoided, so its setup action must be absent from the
    // whole workflow — a Node toolchain under QEMU is the slow, flaky path this design
    // deliberately declined.
    expect(workflow).not.toContain("setup-qemu-action");
  });

  it("the two architectures do not share a buildx cache scope", () => {
    const build = job("build-push");
    for (const dir of ["cache-from", "cache-to"]) {
      const line = new RegExp(`${dir}: type=gha,scope=[^\\n]*`).exec(build)?.[0] ?? "";
      expect(line, `${dir} is not scoped per image AND per arch`).toContain("${{ matrix.image }}");
      expect(line, `${dir} is not scoped per image AND per arch`).toContain("${{ matrix.arch }}");
    }
  });

  it("both architectures are BOOTED, each on its own hardware", () => {
    const boot = job("gate-boot");
    expect(boot).toContain("runs-on: ${{ matrix.runner }}");
    expect(boot).toMatch(/- arch: arm64\n\s+runner: ubuntu-24\.04-arm\b/);
    expect(boot).toMatch(/- arch: amd64\n\s+runner: ubuntu-latest\b/);
    // The stack it boots must be the three images staged for THIS leg. A hardcoded `-amd64`
    // here is the defect this gate was matrixed to remove: it booted amd64 twice and
    // reported the arm64 image as exercised.
    expect(boot).toContain("-${{ matrix.arch }}");
    expect(boot).not.toMatch(/STAGE_TAG:[^\n]*-amd64/);
    // And the boot asserts the architecture it actually got, rather than trusting the
    // runner label — a matrix whose tag suffix and runner drifted apart would otherwise
    // report two green arches for one binary.
    expect(boot).toContain("docker image inspect --format '{{.Architecture}}'");
    // THE INSPECT IS NOT THE CHECK. Reading an architecture and printing it is a log line;
    // what makes it a gate is the comparison and the exit beside it. Deleting just those
    // two — the shape a later edit reaches for when it wants the diagnostic without the
    // failure — would leave the line above in place and this test green, which is the same
    // vacuous-guard failure the whole file is written against. So all three are asserted.
    expect(boot).toMatch(/GOT=\$\(docker image inspect/);
    const refusal = /\[ "\$GOT" = "\$ARCH" \] \|\| \{[^}]*exit 1;[^}]*\}/;
    expect(boot).toMatch(refusal);
    // …and THE REFUSAL, not the inspect, must come before the stack starts. Ordering the
    // diagnostic proves nothing: move the comparison below `docker compose up -d` and the
    // wrong-architecture stack boots first and is refused afterwards, while an assertion
    // about where the inspect sits stays green. So the position asserted is the failing
    // line's, and it is measured against the same string both times.
    const up = boot.indexOf("docker compose up -d");
    expect(up, "gate-boot no longer starts the stack").toBeGreaterThan(-1);
    expect(refusal.exec(boot)!.index, "the architecture refusal is not before the boot")
      .toBeLessThan(up);
  });

  it("promotion composes BOTH staged manifests into every public tag", () => {
    const promote = job("promote");
    expect(promote).toContain("docker buildx imagetools create");
    expect(promote).toContain("stage-$V-$RUN-amd64");
    expect(promote).toContain("stage-$V-$RUN-arm64");
    // Promotion must wait on the builds and on both boots. `needs` is what makes a failed
    // arm64 build block the release instead of quietly shipping an amd64-only index.
    expect(promote).toMatch(/needs:\s*\[version,\s*build-push,\s*gate-boot,\s*gate-visibility\]/);
    // Composition, not a rebuild: what the gates checked has to be what ships.
    expect(promote).not.toContain("build-push-action");
  });

  it("no Dockerfile fetches a platform-specific binary by URL", () => {
    // The vendored-toolchain pattern is how a multi-arch build goes wrong without saying so:
    // a hardcoded x86_64 download succeeds on the arm runner (curl does not care) and lands
    // a binary the container cannot execute. Nothing here does that. The native halves these
    // images need come from npm, which resolves platform packages by the host it runs on:
    // `@next/swc-*` and `lightningcss-*` off the committed lockfile (it records every
    // platform's optional package with its own `cpu`/`os` fields), and esbuild's binary off
    // the explicit `npm install esbuild@<pinned>` the two bundled recipes run beside the build
    // — not from the lockfile, and worth naming rather than glossing: it is the one install
    // here that resolves fresh.
    for (const { dockerfile } of RECIPES) {
      const text = readFileSync(`${ROOT}/${dockerfile}`, "utf8");
      // WHOLE LOGICAL INSTRUCTIONS, because Docker's continuation is where a line-at-a-time
      // scan loses its subject. The conventional form
      //
      //     RUN set -eux; \
      //         curl -fsSL https://…/x-linux-x64.tar.gz | tar -xz
      //
      // has its download on a line beginning with neither RUN nor an operator, so a filter
      // over raw lines drops exactly the half that matters and reports the file clean.
      const runs = joinContinuations(text).filter((i) => /^\s*RUN\b/.test(i));
      expect(runs.length, `${dockerfile}: no RUN instructions found — wrong subject`)
        .toBeGreaterThan(0);
      for (const instruction of runs) {
        expect(instruction, `${dockerfile} downloads a binary in a RUN step`).not.toMatch(
          /\b(curl|wget)\b/,
        );
        expect(instruction, `${dockerfile} names a concrete architecture`).not.toMatch(
          /x86_64|aarch64|\blinux-(x64|amd64|arm64)\b/,
        );
      }
      // The base has to be a tag with an arm64 variant, and the official Node images are it.
      expect(text).toContain("FROM node:22-bookworm-slim");
    }
  });

  it("the compose an operator runs pins no architecture", () => {
    // `platform:` on a service overrides the manifest-list selection for everybody, which
    // turns a multi-arch image back into a single-arch one at the only point where it
    // mattered. There is no legitimate use of it in a stack meant to run on both.
    expect(compose).not.toMatch(/^\s+platform:/m);
  });

  it("the self-host docs state arm64, and say what is and is not verified", () => {
    const readme = flow(selfhostReadme);
    // The claim…
    expect(readme).toContain("amd64 and arm64");
    // …the hardware it invites in, named, so a Pi owner does not have to infer it…
    expect(readme).toMatch(/x86_64 or an arm64 machine/);
    expect(readme).toMatch(/Raspberry Pi/);
    // …and the honesty beside it: built and booted in CI, unproven on anybody's actual
    // hardware. Losing this sentence turns a checked statement into an implied promise.
    expect(readme).toMatch(/no arm64 machine in this project/);
    expect(readme).toMatch(/report how it went/i);
    // The two arm64 shapes that are NOT covered, named. "arm64" reads as one thing to a
    // reader and is two here: there is no 32-bit image at all, and a 16 KB-page kernel
    // (Asahi on some Macs) is the arm64 variant with a history of breaking prebuilt
    // binaries. Dropping either line leaves a sentence that is technically true and
    // misleading to exactly the people who would act on it.
    expect(readme).toMatch(/32-bit/);
    expect(readme).toMatch(/16 KB memory pages/);
  });

  it("both install guides say it too — the reader of one need not find the other", () => {
    // A reader picks ONE guide and follows it end to end. An architecture fact that lives
    // only in the shared README is a fact the VPS reader shopping for the cheaper Ampere
    // instance, and the Pi owner installing on Umbrel, both miss.
    for (const [name, text] of [
      ["VPS.md", vps],
      ["UMBREL.md", umbrel],
    ] as const) {
      const t = flow(text);
      expect(t, `${name} does not name arm64`).toMatch(/arm64/);
      // …and neither guide may promise it without the same caveat the README carries.
      expect(t, `${name} claims arm64 with no caveat`).toMatch(/week of real mail/);
    }
    // The VPS guide is where hardware is chosen, so it names the shapes by name.
    expect(flow(vps)).toMatch(/x86_64 or arm64/);
    expect(flow(vps)).toMatch(/Graviton/);
    // Umbrel's own hardware is the arm64 case that matters most.
    expect(flow(umbrel)).toMatch(/Raspberry Pi/);
  });

  it("every document that claims the double boot dates it, and says what came before", () => {
    // THE CLAIM HAS A START DATE AND THE READER MAY BE BEHIND IT. The arm64 boot gate is
    // newer than most published tags: an operator on a pinned older `OHMAIL_IMAGE_TAG` — or
    // on the Umbrel package, which pins 0.11.0 — holds images that were BUILT for arm64 and
    // booted only on amd64. "Every release boots both architectures" is true of the process
    // and false of their artifact, which is the worst kind of true sentence: it reads as
    // reassurance about the thing in front of them.
    //
    // So every document making the claim must carry a version boundary AND the state before
    // it. The boundary is matched by SHAPE, not by number, so a release bump does not turn
    // this red for no reason — and the "earlier releases" half is what a bump must not
    // quietly drop.
    for (const [name, text, before] of [
      ["docs/self-host/README.md", selfhostReadme, /only ever booted on amd64/],
      ["docs/self-host/VPS.md", vps, /earlier ones were only built/],
      ["docs/self-host/UMBREL.md", umbrel, /booted only the amd64 stack/],
      [publicRel("README.md"), projectReadme, /only ever booted on amd64/],
    ] as const) {
      const t = flow(text);
      expect(t, `${name} claims the double boot without dating it`)
        .toMatch(/from 0\.\d+\.\d+ on/i);
      expect(t, `${name} does not say what earlier releases were`).toMatch(before);
    }
  });
});
