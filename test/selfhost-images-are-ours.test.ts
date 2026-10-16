import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { publicRel } from "./support/public-root.mjs";

/**
 * ═══ THE SELF-HOST STACK BOOTS ONLY IMAGES WE SERVE ════════════════════════════════════════
 *
 * On 2026-09-12 both MinIO repositories were deleted from Docker Hub. Every self-host install
 * — on the shipped release as much as on the candidate — could no longer pull its object
 * store: a fresh `docker compose up` died at `minio-init` with `pull access denied`. Nothing
 * in this project had changed. Somebody else's registry decided it, and the blast radius was
 * every operator running our software.
 *
 * So the stack now names ONE registry, ours. The images we build are built by the release
 * workflow; the images we do not build are COPIED into `ghcr.io/trafficflowhq` by
 * `.github/scripts/mirror-images.sh` from `deploy/selfhost/images.lock`, by digest. `crane
 * copy` re-pushes a manifest unchanged, so the digest in the lock is the identity of the
 * upstream image AND of our copy — which is what lets anyone check the two against each other.
 *
 * What this file holds down, because each half is one edit away from being untrue:
 *
 *   1. the lock is well formed — a digest, a licence and a source on every row;
 *   2. every image in a SHIPPED compose is ours, and every mirrored one is pinned to a lock
 *      row by digest AND by tag;
 *   3. no lock row is dead, and no compose anywhere still names the registry that deleted them;
 *   4. the workflow mirrors BEFORE it boots, and the boot gate names what it could not pull;
 *   5. the script refuses — a row without a digest, an upstream that disagrees with the lock,
 *      a copy that landed something else — and is idempotent, verifying without touching
 *      upstream at all, which is the property that makes a deletion upstream survivable.
 */

const HERE = fileURLToPath(new URL(".", import.meta.url));
const ROOT = join(HERE, "..");
const LOCK_PATH = "deploy/selfhost/images.lock";
const SCRIPT_PATH = publicRel("github/scripts/mirror-images.sh");
const rd = (p: string) => readFileSync(join(ROOT, p), "utf8");

/** The registry every shipped image must come from. */
const OURS = "ghcr.io/trafficflowhq/";

/** The composes an operator boots. The rest of the repo's composes are this workspace's harness. */
const SHIPPED = ["deploy/selfhost/docker-compose.yml", "deploy/umbrel/ohmail/docker-compose.yml"];

/** Our own three, built by this repository's release workflow rather than mirrored. */
const BUILT_BY_US = ["ohmail-server", "ohmail-worker", "ohmail-web"];

type LockRow = { name: string; upstream: string; digest: string; license: string; source: string };

/** The lock, parsed the way the shell parses it, with every complaint named rather than thrown. */
function parseLock(text: string): { rows: LockRow[]; problems: string[] } {
  const rows: LockRow[] = [];
  const problems: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const f = line.split(/\s+/);
    if (f.length !== 5) {
      problems.push(`${f[0]}: ${f.length} fields, expected 5 (name upstream digest license source)`);
      continue;
    }
    const [name, upstream, digest, license, source] = f as [string, string, string, string, string];
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(name)) problems.push(`${name}: not a registry repository name`);
    if (!/^sha256:[0-9a-f]{64}$/.test(digest)) problems.push(`${name}: '${digest}' is not a sha256 digest`);
    if (!/^[a-z0-9.-]+(:\d+)?\/\S+:\S+$/.test(upstream)) problems.push(`${name}: '${upstream}' is not <registry>/<repo>:<tag>`);
    if (!license || license === "-") problems.push(`${name}: no licence named`);
    if (!/^https:\/\//.test(source)) problems.push(`${name}: the source column must be a URL`);
    rows.push({ name, upstream, digest, license, source });
  }
  return { rows, problems };
}

/** Every `image:` value in a compose, in file order. */
function composeImages(text: string): string[] {
  return [...text.matchAll(/^\s*image:\s*(\S+)\s*$/gm)].map((m) => m[1]!);
}

/**
 * Every reason a shipped compose would not be servable by us — as strings, so the controls
 * below can assert that the defect they inject is refused BY NAME rather than merely counted.
 */
function refusals(compose: string, rows: readonly LockRow[]): string[] {
  const out: string[] = [];
  const byName = new Map(rows.map((r) => [r.name, r]));
  for (const ref of composeImages(compose)) {
    if (!ref.startsWith(OURS)) {
      out.push(`${ref} is not served by us (registry: ${ref.split("/")[0]})`);
      continue;
    }
    const rest = ref.slice(OURS.length);
    const name = rest.split(/[:@]/)[0]!;
    if (BUILT_BY_US.includes(name)) continue;
    const m = /^([^:@]+):([^@]+)@(sha256:[0-9a-f]{64})$/.exec(rest);
    if (!m) {
      out.push(`${ref} is not pinned as <name>:<tag>@sha256:<digest>`);
      continue;
    }
    const row = byName.get(m[1]!);
    if (!row) {
      out.push(`${ref} names ${m[1]}, which has no row in ${LOCK_PATH}`);
      continue;
    }
    if (row.digest !== m[3]) out.push(`${ref} is pinned to ${m[3]}, the lock says ${row.digest}`);
    const upstreamTag = row.upstream.slice(row.upstream.lastIndexOf(":") + 1);
    if (upstreamTag !== m[2]) out.push(`${ref} is tagged ${m[2]}, the lock's upstream is ${upstreamTag}`);
  }
  return out;
}

/** Every compose file in the repository, found by walking — so a fifth one is covered too. */
function everyCompose(): string[] {
  const out: string[] = [];
  const skip = new Set(["node_modules", ".git", "build", "dist", ".next", ".vercel", "target"]);
  const walk = (dir: string) => {
    for (const e of readdirSync(join(ROOT, dir) || ROOT, { withFileTypes: true })) {
      if (skip.has(e.name) || e.name.startsWith(".git")) continue;
      const rel = dir ? `${dir}/${e.name}` : e.name;
      if (e.isDirectory()) walk(rel);
      else if (/^docker-compose[.\w-]*\.ya?ml$/.test(e.name)) out.push(rel);
    }
  };
  walk("");
  return out;
}

describe("the image lock is well formed", () => {
  const { rows, problems } = parseLock(rd(LOCK_PATH));

  it("every row carries a digest, a licence and the source that licence obliges us to name", () => {
    expect(problems).toEqual([]);
    expect(rows.length, "the lock is empty — every case below would be vacuous").toBeGreaterThan(0);
  });

  it("no two rows claim the same name", () => {
    expect(new Set(rows.map((r) => r.name)).size).toBe(rows.length);
  });

  it("the parser refuses a row that pins nothing — the control for the case above", () => {
    /* Without this, a lock whose digests were all replaced by a dash would satisfy the first
       case as long as the file still parsed into five columns. */
    const broken = parseLock("mirror-x docker.io/library/x:1 - MIT https://example.invalid/x");
    expect(broken.problems.join("\n")).toContain("is not a sha256 digest");
    const short = parseLock("mirror-x docker.io/library/x:1 sha256:" + "a".repeat(64) + " MIT");
    expect(short.problems.join("\n")).toContain("4 fields, expected 5");
  });
});

describe("a shipped stack boots only images we serve", () => {
  const { rows } = parseLock(rd(LOCK_PATH));

  for (const path of SHIPPED) {
    it(`${path} names our registry, pinned by digest`, () => {
      const images = composeImages(rd(path));
      expect(images.length, `${path}: no image: lines parsed — wrong subject`).toBeGreaterThan(3);
      expect(refusals(rd(path), rows)).toEqual([]);
    });
  }

  it("and an upstream image in one of them is refused BY NAME", () => {
    /* THE POSITIVE CONTROL. Everything above passes trivially against a compose with no images
       and against a checker that returns []. This injects the exact defect of 2026-09-12. */
    const hurt = rd(SHIPPED[0]!).replace(
      /^(\s*image:\s*)ghcr\.io\/trafficflowhq\/mirror-minio:.*$/m,
      "$1minio/minio:RELEASE.2025-04-22T22-12-26Z",
    );
    expect(hurt, "the substitution matched nothing — the control is vacuous").not.toEqual(rd(SHIPPED[0]!));
    const said = refusals(hurt, rows).join("\n");
    expect(said).toContain("minio/minio:RELEASE.2025-04-22T22-12-26Z is not served by us");
    expect(said).toContain("registry: minio");
  });

  it("a mirrored image whose digest drifts from the lock is refused", () => {
    const hurt = rd(SHIPPED[0]!).replace(/@sha256:[0-9a-f]{64}/, "@sha256:" + "b".repeat(64));
    expect(refusals(hurt, rows).join("\n")).toContain("the lock says");
  });

  it("a mirrored image with no digest at all is refused", () => {
    const hurt = rd(SHIPPED[0]!).replace(/@sha256:[0-9a-f]{64}/, "");
    expect(refusals(hurt, rows).join("\n")).toContain("is not pinned as");
  });

  it("no row in the lock is dead weight", () => {
    const used = new Set(SHIPPED.flatMap((p) => composeImages(rd(p))).map((r) => r.slice(OURS.length).split(/[:@]/)[0]));
    for (const r of rows) expect(used.has(r.name), `${r.name} is mirrored and booted by nothing`).toBe(true);
  });
});

describe("the registry that deleted these images is named nowhere", () => {
  /* NOT a style rule: `minio/minio` and `minio/mc` on Docker Hub are gone, and a compose that
     still names them cannot pull at all. The shipped stacks are mirrored; the dev harness is
     repointed at quay, which serves the identical manifests. */
  const composes = everyCompose();

  it("every compose in the repository is covered", () => {
    expect(composes).toContain("docker-compose.yml");
    expect(composes.length, "the walk found no composes — every case here is vacuous").toBeGreaterThan(3);
  });

  for (const path of composes) {
    it(`${path} does not pull MinIO from Docker Hub`, () => {
      for (const ref of composeImages(rd(path))) {
        const dead = /^(?:(?:registry-1\.|index\.)?docker\.io\/)?minio\/(minio|mc)[:@]/.test(ref);
        expect(dead, `${path} still pulls ${ref} from a repository that no longer exists`).toBe(false);
      }
    });
  }

  it("and the check would catch it — the control", () => {
    const dead = (ref: string) => /^(?:(?:registry-1\.|index\.)?docker\.io\/)?minio\/(minio|mc)[:@]/.test(ref);
    expect(dead("minio/mc:RELEASE.2025-04-16T18-13-26Z")).toBe(true);
    expect(dead("docker.io/minio/minio:RELEASE.2025-04-22T22-12-26Z")).toBe(true);
    /* …and does not fire on the two refs that are fine, which is the other half of it. */
    expect(dead("quay.io/minio/minio:RELEASE.2025-04-22T22-12-26Z")).toBe(false);
    expect(dead("ghcr.io/trafficflowhq/mirror-minio:RELEASE.2025-04-22T22-12-26Z")).toBe(false);
  });
});

describe("the release workflow mirrors before it boots", () => {
  const wf = rd(publicRel("github/workflows/ghcr-images.yml"));

  it("there is a mirror-images job, and it runs the script", () => {
    expect(wf).toMatch(/^ {2}mirror-images:$/m);
    expect(wf).toContain("bash .github/scripts/mirror-images.sh");
    /* The script is published under that path by the template rename, so the mirror's own
       workflow can find it. A job calling a file the mirror lacks fails at the release. */
    expect(rd(SCRIPT_PATH).length).toBeGreaterThan(500);
  });

  it("the boot gate waits for it", () => {
    expect(wf).toContain("needs: [version, build-push, mirror-images]");
  });

  it("the boot gate refuses an image that is not ours, in the published tree", () => {
    expect(wf).toContain("is not served by us");
    expect(wf).toMatch(/\(ghcr\.io\/trafficflowhq\/\*\) : ;;/);
  });

  it("the anonymous-pull gate covers the mirrored packages too", () => {
    /* A GHCR package is born PRIVATE. Mirroring a new row creates a package only we can pull,
       and the compose would then name a registry a stranger cannot read — this mirroring's own
       failure, from the other side. The gate reads the lock so a new row is covered at once. */
    expect(wf).toContain("done < deploy/selfhost/images.lock");
    expect(wf).toMatch(/needs: \[version, build-push, mirror-images\]/);
    const gate = wf.slice(wf.indexOf("  gate-visibility:"), wf.indexOf("  promote-candidate:"));
    expect(gate).toContain("images.lock");
    expect(gate).toContain("not anonymously pullable");
  });

  it("and names the image and registry it could not pull", () => {
    /* The 2026-09-12 diagnosis came from reading a crashed service's log. It is produced
       deliberately now: pulled one ref at a time, failures collected and printed with their
       registry. `docker compose pull -q` would have swallowed exactly this. */
    expect(wf).toContain("the stack could not pull:");
    expect(wf).toContain("(registry: ${REF%%/*})");
    expect(wf).not.toContain("docker compose pull -q");
  });
});

describe("the mirror script refuses, and is idempotent", () => {
  const SCRIPT = join(ROOT, SCRIPT_PATH);
  const LOCK = join(ROOT, LOCK_PATH);
  const { rows } = parseLock(rd(LOCK_PATH));

  /** A registry in a directory: one file per reference holding its digest, one log of calls. */
  function rig(): { dir: string; state: string; calls: string; crane: string } {
    const dir = mkdtempSync(join(tmpdir(), "mirror-images-"));
    const crane = join(dir, "crane");
    writeFileSync(crane, [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      `enc() { printf '%s' "$1" | tr '/:@' '___'; }`,
      `echo "$*" >> "$CALLS"`,
      "case \"${1:-}\" in",
      `  digest) f="$STATE/$(enc "$2")"; [ -f "$f" ] || exit 1; cat "$f" ;;`,
      `  copy) f="$STATE/$(enc "$2")"; [ -f "$f" ] || exit 1;`,
      `        d="$(cat "$f")"; [ -n "\${COPY_LANDS:-}" ] && d="$COPY_LANDS";`,
      `        printf '%s' "$d" > "$STATE/$(enc "$3")" ;;`,
      "  *) exit 2 ;;",
      "esac",
      "",
    ].join("\n"));
    chmodSync(crane, 0o755);
    const state = join(dir, "state");
    execFileSync("mkdir", ["-p", state]);
    const calls = join(dir, "calls");
    writeFileSync(calls, "");
    /* Upstream starts out holding exactly what the lock says it does. */
    for (const r of rows) {
      writeFileSync(join(state, r.upstream.replace(/[/:@]/g, "_")), r.digest);
    }
    return { dir, state, calls, crane };
  }

  function run(r: ReturnType<typeof rig>, extra: Record<string, string> = {}): { out: string; rc: number } {
    const env = {
      PATH: process.env.PATH ?? "", MIRROR_REGISTRY: "ghcr.io/trafficflowhq",
      IMAGES_LOCK: extra.IMAGES_LOCK ?? LOCK, CRANE: r.crane, STATE: r.state, CALLS: r.calls, ...extra,
    };
    try {
      return { out: execFileSync("bash", [SCRIPT], { env, encoding: "utf8", stdio: "pipe" }), rc: 0 };
    } catch (e) {
      const err = e as { status?: number; stdout?: string; stderr?: string };
      return { out: `${err.stdout ?? ""}${err.stderr ?? ""}`, rc: err.status ?? 1 };
    }
  }

  const lockWith = (dir: string, edit: (s: string) => string): Record<string, string> => {
    const p = join(dir, "images.lock");
    const text = edit(rd(LOCK_PATH));
    expect(text, "the fixture edit matched nothing").not.toEqual(rd(LOCK_PATH));
    writeFileSync(p, text);
    return { IMAGES_LOCK: p };
  };

  it("mirrors every row on a cold registry", () => {
    const r = rig();
    const { out, rc } = run(r);
    expect(rc, out).toBe(0);
    expect(out).toContain(`${rows.length} row(s) — 0 verified, ${rows.length} copied, 0 refused`);
  });

  it("a second run verifies, pushes nothing, and never contacts upstream", () => {
    /* THE PROPERTY THE WHOLE DESIGN RESTS ON. If a re-run asked upstream for anything, a
       deletion upstream would still be able to fail a release of already-mirrored images —
       which is the failure this lane exists to make impossible. */
    const r = rig();
    expect(run(r).rc).toBe(0);
    writeFileSync(r.calls, "");
    const { out, rc } = run(r);
    expect(rc, out).toBe(0);
    expect(out).toContain(`${rows.length} verified, 0 copied`);
    const calls = readFileSync(r.calls, "utf8").trim().split("\n");
    expect(calls).toHaveLength(rows.length);
    for (const c of calls) expect(c).toMatch(/^digest ghcr\.io\/trafficflowhq\//);
  });

  it("even when upstream has been deleted out from under it", () => {
    const r = rig();
    expect(run(r).rc).toBe(0);
    execFileSync("bash", ["-c", `rm -f "${r.state}"/quay* "${r.state}"/docker*`]);
    const { out, rc } = run(r);
    expect(rc, out).toBe(0);
    expect(out).toContain(`${rows.length} verified`);
  });

  it("a row without a digest is refused by name", () => {
    const r = rig();
    const { out, rc } = run(r, lockWith(r.dir, (s) => s.replace(/sha256:[0-9a-f]{64}/, "-")));
    expect(rc).toBe(1);
    expect(out).toContain("is not a sha256 digest");
  });

  it("a row short of its licence or source is refused by name", () => {
    const r = rig();
    /* The last column off every ROW — a regex over the whole file would have matched inside the
       header comment instead, which is how this control first passed while measuring nothing. */
    const { out, rc } = run(r, lockWith(r.dir, (s) => s.split("\n")
      .map((l) => (l.trim() && !l.startsWith("#") ? l.replace(/\s+\S+\s*$/, "") : l)).join("\n")));
    expect(rc).toBe(1);
    expect(out).toContain("the row is short");
  });

  it("an upstream that disagrees with the lock is refused rather than mirrored", () => {
    const r = rig();
    writeFileSync(join(r.state, rows[0]!.upstream.replace(/[/:@]/g, "_")), "sha256:" + "c".repeat(64));
    const { out, rc } = run(r);
    expect(rc).toBe(1);
    expect(out).toContain("the lock says");
  });

  it("an upstream that is gone and was never mirrored is refused by name", () => {
    const r = rig();
    execFileSync("bash", ["-c", `rm -f "${r.state}"/quay*`]);
    const { out, rc } = run(r);
    expect(rc).toBe(1);
    expect(out).toContain("is not readable, and ghcr.io/trafficflowhq/");
  });

  it("a copy that lands a different manifest is refused", () => {
    /* The read-back. A copy is not believed because it exited 0 — the destination is asked
       what it now holds, which is the only thing an operator's boot will ask it. */
    const r = rig();
    const { out, rc } = run(r, { COPY_LANDS: "sha256:" + "d".repeat(64) });
    expect(rc).toBe(1);
    expect(out).toContain("after the copy, expected");
  });

  it("a lock with no rows is a refusal, not a cheerful nothing", () => {
    const r = rig();
    const { out, rc } = run(r, lockWith(r.dir, (s) => s.split("\n").filter((l) => l.startsWith("#")).join("\n")));
    expect(rc).toBe(1);
    expect(out).toContain("holds no rows");
  });
});
