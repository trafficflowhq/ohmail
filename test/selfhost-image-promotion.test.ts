import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { publicRel } from "./support/public-root.mjs";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const WF = publicRel("github/workflows/ghcr-images.yml");
const wf = readFileSync(join(ROOT, WF), "utf8");

/**
 * ═══ `latest` MOVES LAST, AND THE SHELL THAT MOVES IT PARSES ═══════════════════════════════
 *
 * The self-host compose pulls `ghcr.io/trafficflowhq/ohmail-{server,worker,web}` and defaults to
 * `:latest`. Those are three separate registry tags and no registry moves three of them in one
 * operation, so a `docker compose pull` that lands inside a promotion sees a mixture.
 *
 * WHAT THE MIXTURE COSTS, which is why this is not a tidiness question: an API and an organizer
 * from different releases can accept scheduled mail without ever running its sender clock. The
 * mail is taken and never sent, and both processes report themselves healthy the whole time.
 *
 * The promotion used to write `<version>` and `latest` for one image, then the next, then the
 * next — so the mixture could be a NEW `latest` server beside an OLD `latest` worker. It is two
 * passes with a gate now, and this file holds that ORDER down:
 *
 *  1. no `latest` is written in the version pass;
 *  2. every `<version>` manifest is checked readable before the `latest` pass runs;
 *  3. the `latest` pass composes from the version tag, not from the staging pair — so one
 *     image's two tags cannot disagree about digests.
 *
 * ── AND THE SHELL ITSELF IS PARSED, WHICH CAUGHT A REAL DEFECT ─────────────────────────────
 *
 * A workflow's `run:` block is shell that nothing in this repository executes before a release
 * runs it for real. While writing the two passes above, a failure message was drafted as
 * `echo "... and `latest` has NOT moved ..."` — a BACKTICK inside a double-quoted shell string,
 * which is command substitution: the runner would have tried to execute `latest` as a command,
 * inside the error path of the one job that moves public tags. `bash -n` over every extracted
 * block is what makes that a red test instead of a release-day surprise.
 */

/** Every `run: |` block in the workflow, dedented, with GitHub expressions neutralised. */
function runBlocks(): Array<{ step: string; body: string }> {
  const lines = wf.split("\n");
  const out: Array<{ step: string; body: string }> = [];
  let step = "(before any step)";
  for (let i = 0; i < lines.length; i++) {
    const nameM = /^\s*-?\s*name:\s*(.+)$/.exec(lines[i]!);
    if (nameM) step = nameM[1]!.trim();
    const runM = /^(\s*)run:\s*\|\s*$/.exec(lines[i]!);
    if (!runM) continue;
    const indent = runM[1]!.length + 2;
    const body: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j]!;
      if (l.trim() !== "" && (l.length - l.replace(/^\s*/, "").length) < indent) break;
      body.push(l.slice(indent));
    }
    /* `${{ … }}` is GitHub's, not the shell's, and it is deliberately absent from these bodies
       (the jobs pass values through `env:` so a tag name can never be interpolated into shell
       source). Neutralised rather than assumed absent, so this helper stays usable if another
       step is added that does use one. */
    out.push({ step, body: body.join("\n").replace(/\$\{\{[^}]*\}\}/g, "GH_EXPR") });
  }
  return out;
}

describe("the workflow's shell parses", () => {
  const blocks = runBlocks();

  it("finds the run blocks at all", () => {
    /* The positive control for the parser: a helper that found nothing would make every case
       below pass without reading a line of shell. */
    expect(blocks.length, "no run: blocks parsed out of the workflow").toBeGreaterThanOrEqual(6);
  });

  it("every run block passes bash -n", () => {
    const dir = mkdtempSync(join(tmpdir(), "ohmail-wf-"));
    const broken: string[] = [];
    for (const [n, b] of blocks.entries()) {
      const f = join(dir, `block-${n}.sh`);
      writeFileSync(f, b.body);
      try {
        execFileSync("bash", ["-n", f], { stdio: "pipe" });
      } catch (err) {
        const e = err as { stderr?: Buffer };
        broken.push(`${b.step}: ${String(e.stderr ?? "").trim()}`);
      }
    }
    expect(broken, "a run: block is not valid shell").toEqual([]);
  });

  it("no backtick survives inside a double-quoted string in any run block", () => {
    /* The defect above, as its own case: `bash -n` accepts command substitution happily — it is
       valid shell — so parsing alone would not have caught it. Prose backticks in the file's
       COMMENTS are fine and plentiful; this looks only inside the shell. */
    const hits: string[] = [];
    for (const b of blocks) {
      for (const [n, line] of b.body.split("\n").entries()) {
        if (line.trim().startsWith("#")) continue;
        const dq = /"[^"]*`[^"]*"/.exec(line);
        if (dq) hits.push(`${b.step} line ${n + 1}: ${line.trim()}`);
      }
    }
    expect(hits, "a backtick in a double-quoted shell string is command substitution").toEqual([]);
  });
});

describe("latest moves last, and only over a version tag that is whole", () => {
  const blocks = runBlocks();
  /* THE NEEDLES ARE THE THREE STEPS' OWN NAMES, not the word "gate": the anonymous-pull
     VISIBILITY step is also called a gate and runs BEFORE promotion, so a loose needle matched it
     and the ordering case failed with "expected 6 to be less than 2" — a red that reads as the
     passes being in the wrong order when they are not. */
  const MANIFEST_PASS = "pass 1 — one manifest list per image";
  const GATE = "the gate — every version manifest is readable";
  const LATEST_PASS = "pass 2 — latest, last";
  const byStep = (needle: string) => {
    const b = blocks.find((x) => x.step.toLowerCase().includes(needle));
    expect(b, `no promotion step matching "${needle}"`).toBeDefined();
    return b!.body;
  };

  it("the version pass writes no latest tag", () => {
    const pass1 = byStep(MANIFEST_PASS);
    expect(pass1).toMatch(/-t "ghcr\.io\/trafficflowhq\/\$IMG:\$V"/);
    expect(pass1, "pass 1 moves latest — the whole point is that it does not")
      .not.toMatch(/:latest/);
  });

  it("a gate checks all three version manifests before latest moves", () => {
    const gate = byStep(GATE);
    expect(gate).toMatch(/imagetools inspect/);
    for (const img of ["ohmail-server", "ohmail-worker", "ohmail-web"]) {
      expect(gate, `${img} is not in the gate's loop`).toContain(img);
    }
    expect(gate, "the gate does not refuse").toMatch(/exit 1/);
  });

  it("the latest pass composes from the version tag, not from the staging pair", () => {
    const pass2 = byStep(LATEST_PASS);
    expect(pass2).toMatch(/-t "ghcr\.io\/trafficflowhq\/\$IMG:latest"/);
    expect(pass2).toMatch(/"ghcr\.io\/trafficflowhq\/\$IMG:\$V"/);
    /* Recomposing `latest` from the staging pair would be a SECOND manifest list for the same
       digests — harmless today and exactly the shape that lets the two tags of one image drift
       apart the day a stage tag is pruned or re-pushed. */
    expect(pass2, "pass 2 recomposes from the staging tags").not.toMatch(/stage-\$V-\$RUN/);
  });

  it("and the passes are in that order in the file", () => {
    const at = (needle: string) => {
      const i = blocks.findIndex((x) => x.step.toLowerCase().includes(needle));
      expect(i, `step "${needle}" not found`).toBeGreaterThanOrEqual(0);
      return i;
    };
    expect(at(MANIFEST_PASS)).toBeLessThan(at(GATE));
    expect(at(GATE)).toBeLessThan(at(LATEST_PASS));
  });

  it("the operator template says why pinning a version is the answer to the last window", () => {
    /* Three writes of `latest` cannot be made one, so the residue is documented where the person
       who can act on it reads it, rather than left as a property of the workflow nobody sees. */
    const ex = readFileSync(join(ROOT, "deploy/selfhost/.env.example"), "utf8");
    const block = /OHMAIL_IMAGE_TAG[\s\S]{0,1400}?\n#OHMAIL_IMAGE_TAG=/.exec(ex);
    expect(block, "the OHMAIL_IMAGE_TAG block was not found").not.toBeNull();
    expect(block![0].toLowerCase(), "the skew is not explained where it is configured")
      .toContain("skew");
  });
});

/**
 * ═══ A CANDIDATE MOVES NO PUBLIC TAG ═══════════════════════════════════════════════════════
 *
 * A release candidate needs bootable images before the release exists — the self-host end-to-end surface
 * could not be run on rc3 or rc4 at all, because the only images this workflow produces are the
 * ones a release promotes. So a `candidate: <40 hex>` dispatch builds and pushes exactly one tag
 * per image, `rc-<sha>`, and the version tag and `latest` stay where they are: an unreleased build
 * reaching an unpinned install is the cost, and it is paid by every self-host operator at once.
 *
 * The decision is a SCRIPT, so this file can RUN it rather than read it. Both directions are
 * driven — the candidate refuses to promote, and the ordinary release still does.
 */
describe("a candidate run builds rc-<sha> and promotes nothing", () => {
  const TAGS = join(ROOT, publicRel("github/scripts/ghcr-image-tags.sh"));
  const decide = (env: Record<string, string>): { out: string; rc: number } => {
    try {
      const out = execFileSync("bash", [TAGS],
        { env: { PATH: process.env.PATH ?? "", ...env }, encoding: "utf8" });
      return { out, rc: 0 };
    } catch (e) {
      const err = e as { status?: number; stdout?: string; stderr?: string };
      return { out: `${err.stdout ?? ""}${err.stderr ?? ""}`, rc: err.status ?? 1 };
    }
  };
  const SHA = "0123456789abcdef0123456789abcdef01234567";
  const blocks = runBlocks();
  const byStep = (needle: string): string => {
    const b = blocks.find((x) => x.step.toLowerCase().includes(needle));
    expect(b, `no step matching "${needle}"`).toBeDefined();
    return b!.body;
  };

  it("the dispatch takes a candidate input at all", () => {
    // Anti-vacuity for everything below: the run is unreachable without the input.
    expect(wf).toMatch(/^ {6}candidate:$/m);
    expect(wf).toContain("rc-<sha>");
  });

  it("a candidate yields rc-<sha> and promote_public=no", () => {
    const { out, rc } = decide({ EVENT_NAME: "workflow_dispatch", DISPATCH_CANDIDATE: SHA, TREE_VERSION: "0.17.0" });
    expect(rc).toBe(0);
    expect(out).toContain(`image_tag=rc-${SHA}`);
    expect(out).toContain("promote_public=no");
    expect(out).toContain(`candidate=${SHA}`);
  });

  it("a release run is unchanged: the version tag, and promote_public=yes", () => {
    // The positive control. A decision that answered "no" to everything would pass the case above.
    const { out, rc } = decide({ EVENT_NAME: "push", REF_NAME: "v0.17.0", TREE_VERSION: "0.17.0" });
    expect(rc).toBe(0);
    expect(out).toContain("image_tag=0.17.0");
    expect(out).toContain("promote_public=yes");
    expect(out.split("\n")).toContain("candidate=");
  });

  it("a candidate that is not a 40-hex commit is refused by name", () => {
    for (const bad of ["deadbeef", "0.17.0", `${SHA}A`, "../etc"]) {
      const { out, rc } = decide({ EVENT_NAME: "workflow_dispatch", DISPATCH_CANDIDATE: bad, TREE_VERSION: "0.17.0" });
      expect(rc, `${bad} was accepted`).toBe(1);
      expect(out).toContain("refusing candidate");
    }
  });

  it("a candidate on a tag push is refused — a candidate is a manual act", () => {
    const { out, rc } = decide({ EVENT_NAME: "push", REF_NAME: "v0.17.0", DISPATCH_CANDIDATE: SHA, TREE_VERSION: "0.17.0" });
    expect(rc).toBe(1);
    expect(out).toContain("a candidate is a manual act");
  });

  it("an rc-* version on the release path is refused, so the two namespaces cannot cross", () => {
    const { out, rc } = decide({ EVENT_NAME: "workflow_dispatch", DISPATCH_VERSION: `rc-${SHA}`, TREE_VERSION: `rc-${SHA}` });
    expect(rc).toBe(1);
    expect(out).toContain("belongs to a candidate run");
  });

  it("the promote job runs only when promote_public is yes, and refuses again as a step", () => {
    /* Two conditions, because the `if:` is one edit away from gone and this is the tag that
       reaches every unpinned install. */
    expect(wf).toContain("needs.version.outputs.promote_public == 'yes'");
    const guard = byStep("refuse to promote a candidate");
    expect(guard).toContain('if [ -n "$CANDIDATE" ] || [ "$PROMOTE" != "yes" ]; then');
    expect(guard).toContain("exit 1");
  });

  it("the candidate job writes rc-* only, and refuses any other tag it is handed", () => {
    expect(wf).toContain("needs.version.outputs.promote_public == 'no'");
    const body = byStep("one manifest list per image, under rc-<sha>");
    expect(body).toContain("(rc-*) : ;;");
    expect(body).toContain("may only write rc-* tags");
    expect(body, "the candidate job writes latest").not.toContain(":latest");
    expect(body, "the candidate job writes a bare version tag").not.toContain(':$V"');
  });

  it("the candidate job is gated on the same boot and visibility gates as a release", () => {
    // An unreleased image an operator boots is still an image that must boot.
    const at = wf.indexOf("promote-candidate:");
    expect(at, "the candidate job is missing").toBeGreaterThan(0);
    expect(wf.slice(at, at + 400)).toContain("needs: [version, build-push, gate-boot, gate-visibility]");
  });
});

/**
 * ═══ THE MANAGED DEPLOYMENT'S IMAGE IS AN ALIAS, NOT A BUILD ════════════════════════════════
 *
 * `ohmail-worker-managed` is the organizer's version manifest under a second name — the bytes this
 * workflow's own gate boots on both architectures — so it is composed from `ohmail-worker:<version>`
 * after the gate, read anonymously before `latest` moves, and never given `latest`. A candidate run
 * aliases its rc tag the same way, which is what creates the package before a release names it.
 */
describe("the managed deployment's image is the organizer's, under a second name", () => {
  const blocks = runBlocks();
  const GATE = "the gate — every version manifest is readable";
  const ALIAS_PASS = "pass 1b — the managed alias";
  const MANAGED_READ = "the managed alias answers an anonymous pull";
  const LATEST_PASS = "pass 2 — latest, last";
  const FINAL_READ = "the promoted tags answer an anonymous pull";
  const at = (needle: string): number => {
    const i = blocks.findIndex((x) => x.step.toLowerCase().includes(needle));
    expect(i, `step "${needle}" not found`).toBeGreaterThanOrEqual(0);
    return i;
  };
  const body = (needle: string): string => blocks[at(needle)]!.body;

  it("the managed alias is composed from the organizer's version tag, after the gate and before latest, never from the staging pair or a build", () => {
    const alias = body(ALIAS_PASS);
    expect(alias).toContain('-t "ghcr.io/trafficflowhq/ohmail-worker-managed:$V"');
    expect(alias).toContain('"ghcr.io/trafficflowhq/ohmail-worker:$V"');
    expect(alias, "the alias is recomposed from the staging pair").not.toContain("stage-$V-$RUN");
    expect(alias).toContain('imagetools inspect --raw "ghcr.io/trafficflowhq/ohmail-worker-managed:$V"');
    expect(wf.slice(wf.indexOf("\n  promote:\n")), "the promote job builds an image").not.toContain("build-push-action");
    const read = body(MANAGED_READ);
    expect(read).toContain("https://ghcr.io/v2/trafficflowhq/ohmail-worker-managed/manifests/$V");
    expect(read).toContain("Change visibility -> Public");
    expect(read).toContain("latest has NOT moved");
    expect(at(GATE)).toBeLessThan(at(ALIAS_PASS));
    expect(at(ALIAS_PASS)).toBeLessThan(at(MANAGED_READ));
    expect(at(MANAGED_READ)).toBeLessThan(at(LATEST_PASS));
  });

  it("pass 2 and the final anonymous loop write and read no ohmail-worker-managed", () => {
    for (const step of [LATEST_PASS, FINAL_READ]) {
      expect(body(step), `${step} names the managed alias`).not.toContain("ohmail-worker-managed");
      expect(body(step)).toContain("for IMG in ohmail-server ohmail-worker ohmail-web; do");
    }
    expect(wf, "the managed alias was given latest").not.toContain("ohmail-worker-managed:latest");
  });

  it("the candidate job aliases rc-<sha> after its inspect", () => {
    const cand = body("one manifest list per image, under rc-<sha>");
    const inspect = cand.indexOf('docker buildx imagetools inspect --raw "ghcr.io/trafficflowhq/$IMG:$TAG"');
    const alias = cand.indexOf('-t "ghcr.io/trafficflowhq/ohmail-worker-managed:$TAG"');
    expect(inspect, "the candidate's inspect loop is gone").toBeGreaterThan(-1);
    expect(alias, "the candidate job writes no managed alias after its inspect").toBeGreaterThan(inspect);
    expect(cand).toContain('"ghcr.io/trafficflowhq/ohmail-worker:$TAG"');
    expect(cand).toContain('imagetools inspect --raw "ghcr.io/trafficflowhq/ohmail-worker-managed:$TAG"');
  });

  it("every uses: in ghcr-images.yml is a 40-hex pin with its version comment", () => {
    const uses = wf.split("\n").filter((l) => /^\s*(?:- )?uses:/.test(l));
    // 11: the mirror job's docker login left; crane's own login is that job's only one.
    expect(uses.length, "the census read too few uses: lines").toBeGreaterThanOrEqual(11);
    const loose = uses.filter((l) => !/^\s*(?:- )?uses: [\w.-]+\/[\w.-]+@[0-9a-f]{40} # v\d+(?:\.\d+)*$/.test(l));
    expect(loose, "an action is not pinned to a commit with its version beside it").toEqual([]);
  });
});
