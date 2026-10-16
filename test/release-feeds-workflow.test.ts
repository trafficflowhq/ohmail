import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { publicPath } from "./support/public-root.mjs";

/**
 * THE TAG STATES THE INTENT, AND A HAND PROMOTION IS READ AFTER THE FACT.
 *
 * Only a release-shaped tag (`v1.2.3`) is ever made Latest: the shape is asked before the
 * dispatch's `promote` input, which defaults to true. A prerelease turned into a release by hand
 * fires `released`, and one job reads the feeds where clients read them and fences a miss. Each
 * block runs as the shell it is against a `gh` stub that refuses a call naming no repository and a
 * `curl` stub that refuses a read with no cache-buster; both refusals are watched firing below.
 */
const HERE = fileURLToPath(new URL(".", import.meta.url));
const WF = publicPath("github/workflows/release-feeds.yml");
const wfText = readFileSync(WF, "utf8");
const wf = wfText.split("\n");

const TAG = "v9.9.9";
const VERSION = "9.9.9";
const PREVIOUS_TAG = "v9.9.8";
const FEEDS = ["latest.json", "appcast-macos.xml", "SHA256SUMS"] as const;

/** The `run:` body of a named step, dedented. */
function runBlock(stepName: string, from: string = wfText): string {
  const lines = from.split("\n");
  const at = lines.findIndex((l) => l.trim() === `- name: ${stepName}`);
  expect(at, `the step "${stepName}" is gone from release-feeds.yml`).toBeGreaterThan(-1);
  const runAt = lines.findIndex((l, i) => i > at && l.trim() === "run: |");
  const indent = lines[runAt].indexOf("run:") + 2;
  const body: string[] = [];
  for (let i = runAt + 1; i < lines.length; i++) {
    if (lines[i].trim() !== "" && lines[i].search(/\S/) < indent) break;
    body.push(lines[i].slice(indent));
  }
  return `${body.join("\n")}\n`;
}

/** `name() { … }` out of a block, dedented — the function as the step defines it. */
function fnIn(block: string, name: string): string {
  const lines = block.split("\n");
  const at = lines.findIndex((l) => l.trim() === `${name}() {`);
  expect(at, `the block defines no ${name}`).toBeGreaterThan(-1);
  const indent = lines[at].search(/\S/);
  const end = lines.findIndex((l, i) => i > at && l.search(/\S/) === indent && l.trim() === "}");
  return `${lines.slice(at, end + 1).map((l) => l.slice(indent)).join("\n")}\n`;
}

/** A job's lines, from its key to the next job key. */
function jobBody(name: string): string {
  const at = wf.indexOf(`  ${name}:`);
  expect(at, `the job ${name} is gone`).toBeGreaterThan(wf.indexOf("jobs:"));
  const end = wf.findIndex((l, i) => i > at && /^ {2}[a-z][a-z0-9-]*:$/.test(l));
  return wf.slice(at, end === -1 ? wf.length : end).join("\n");
}

const FENCE_STEP = "Fence the release until its feeds are on it";
const PROMOTE_STEP = "Grant latest, now that the feeds are on the release";
const REFENCE_STEP = "Read the feeds of a release promoted by hand";

/* THE REPOSITORY IS NAMED, OR THE CALL IS REFUSED: `gh` resolves it from the working directory
   otherwise, and a release read from the wrong checkout reads another repository's page. */
const GH_STUB = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$STUB/gh.log"
named=""; prev=""
for a in "$@"; do
  case "$prev" in --repo|-R) named=$a ;; esac
  prev=$a
done
case "$1" in
  api) case "$2" in repos/*/*/*) ;; *) echo "GH-STUB-REFUSED api path names no repository: $2" >&2; exit 97 ;; esac ;;
  *) [ -n "$named" ] || { echo "GH-STUB-REFUSED gh $* names no repository" >&2; exit 97; } ;;
esac
pre=$(grep -a "^prerelease " "$STUB/state" | cut -d' ' -f2)
dr=$(grep -a "^draft " "$STUB/state" | cut -d' ' -f2)
lat=$(grep -a "^latest " "$STUB/state" | cut -d' ' -f2)
set_state() { tmp=$(mktemp); sed "s/^$1 .*/$1 $2/" "$STUB/state" > "$tmp" && mv "$tmp" "$STUB/state"; }
case "$1 $2" in
  "api repos/"*) printf '%s\\n' "$lat" ;;
  "release view")
    case "$*" in
      *"--jq .isPrerelease"*) printf '%s\\n' "$pre" ;;
      *) printf '{"isPrerelease":%s,"isDraft":%s}\\n' "$pre" "$dr" ;;
    esac ;;
  "release edit")
    if [ -z "\${GH_STUB_EDIT_IGNORED:-}" ]; then
      case "$*" in
        *--prerelease=false*) set_state prerelease false ;;
        *--prerelease*) set_state prerelease true ;;
      esac
      case "$*" in *--latest*) set_state latest "$3" ;; esac
    fi ;;
esac
exit 0
`;

/* Serves /releases/latest/download/<f> from served-latest/, /releases/download/<tag>/<f> from served-own/.
   A read with no cache-buster is refused: a cached 404 answers for the page, and the workflow
   says every read carries a fresh one. `staleReads` serves the first N latest reads from served-stale/. */
const CURL_STUB = `#!/usr/bin/env bash
out=""; url=""
while [ $# -gt 0 ]; do
  case "$1" in -o) out="$2"; shift 2 ;; https://*) url="$1"; shift ;; *) shift ;; esac
done
printf '%s\\n' "$url" >> "$STUB/curl.log"
case "$url" in *"?cb="*) ;; *) echo "CURL-STUB-REFUSED a read with no cache-buster: $url" >&2; exit 2 ;; esac
case "$url" in https://github.com/trafficflowhq/ohmail/*) ;; *) echo "CURL-STUB-REFUSED another repository: $url" >&2; exit 2 ;; esac
path=\${url%%\\?*}; name=\${path##*/}
case "$path" in
  */releases/latest/download/*)
    n=$(cat "$STUB/stale.n" 2>/dev/null || echo 0)
    if [ "$n" -gt 0 ]; then echo $((n - 1)) > "$STUB/stale.n"; src="$STUB/served-stale/$name"; else src="$STUB/served-latest/$name"; fi ;;
  */releases/download/*) src="$STUB/served-own/$name" ;;
  *) exit 22 ;;
esac
[ -f "$src" ] || exit 22
cp "$src" "$out"
exit 0
`;

type World = {
  prerelease?: boolean;
  draft?: boolean;
  latest?: string;
  own?: Record<string, string>;
  served?: Record<string, string>;
  stale?: Record<string, string>;
  staleReads?: number;
  markers?: string[];
  env?: Record<string, string>;
  editIgnored?: boolean;
};
type Ran = { code: number; out: string; err: string; outputs: string; gh: string[]; curl: string[]; sleeps: string[]; state: string };

function run(block: string, world: World = {}): Ran {
  const dir = mkdtempSync(join(tmpdir(), "ohmail-feeds-intent-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "gh"), GH_STUB);
  writeFileSync(join(bin, "curl"), CURL_STUB);
  writeFileSync(join(bin, "sleep"), `#!/usr/bin/env bash\nprintf '%s\\n' "$1" >> "$STUB/sleep.log"\n`);
  for (const f of ["gh", "curl", "sleep"]) chmodSync(join(bin, f), 0o755);
  writeFileSync(join(dir, "state"), `prerelease ${world.prerelease ?? false}\ndraft ${world.draft ?? false}\nlatest ${world.latest ?? PREVIOUS_TAG}\n`);
  for (const [sub, files] of [["served-own", world.own], ["served-latest", world.served], ["served-stale", world.stale]] as const) {
    mkdirSync(join(dir, sub));
    for (const [n, b] of Object.entries(files ?? {})) writeFileSync(join(dir, sub, n), b);
  }
  writeFileSync(join(dir, "stale.n"), `${world.staleReads ?? 0}\n`);
  for (const m of world.markers ?? []) {
    mkdirSync(join(dir, "feeds-state", m.split("/")[0]), { recursive: true });
    writeFileSync(join(dir, "feeds-state", m), "");
  }
  for (const f of ["gh.log", "curl.log", "sleep.log", "outputs"]) writeFileSync(join(dir, f), "");
  writeFileSync(join(dir, "step.sh"), block);
  const env = {
    PATH: `${bin}:/usr/bin:/bin`,
    HOME: dir,
    STUB: dir,
    LC_ALL: "C",
    GITHUB_REPOSITORY: "trafficflowhq/ohmail",
    /* What the fence is handed for a release event (it refuses a dispatch made off the tag). */
    EVENT_NAME: "release",
    RUN_REF: "refs/tags/v9.9.9",
    GITHUB_OUTPUT: join(dir, "outputs"),
    RELEASE_TAG: TAG,
    ...(world.editIgnored ? { GH_STUB_EDIT_IGNORED: "1" } : {}),
    ...(world.env ?? {}),
  };
  const p = spawnSync("bash", ["step.sh"], { cwd: dir, env, encoding: "utf8" });
  const lines = (f: string) => readFileSync(join(dir, f), "utf8").split("\n").filter(Boolean);
  return {
    code: p.status ?? -1,
    out: p.stdout ?? "",
    err: p.stderr ?? "",
    outputs: readFileSync(join(dir, "outputs"), "utf8"),
    gh: lines("gh.log"),
    curl: lines("curl.log"),
    sleeps: lines("sleep.log"),
    state: readFileSync(join(dir, "state"), "utf8"),
  };
}

const FENCE = runBlock(FENCE_STEP);
const PROMOTE = runBlock(PROMOTE_STEP);
const REFENCE = runBlock(REFENCE_STEP);
const TAG_SHAPE_FN = fnIn(FENCE, "tag_shape");

describe("the tag states the intent", () => {
  const shape = (tag: string) => {
    const p = spawnSync("bash", ["-c", `set -euo pipefail\n${TAG_SHAPE_FN}tag_shape "$1"\n`, "x", tag], { encoding: "utf8" });
    expect(p.status, `tag_shape ${JSON.stringify(tag)} failed: ${p.stderr}`).toBe(0);
    return p.stdout.trim();
  };

  it("reads v1.2.3 as a release and v1.2.3-rc.1 as a prerelease", () => {
    expect(shape("v1.2.3")).toBe("release");
    expect(shape("v1.2.3-rc.1")).toBe("prerelease");
  });

  it.each(["v0.25.3", "v10.0.0", "v1.20.300"])("reads %s as a release", (tag) => {
    expect(shape(tag)).toBe("release");
  });

  it.each(["v1.2.3-beta", "v0.4.0-preview", "v1.2.3+build.5", "1.2.3", "v1.2", "v1.2.3.4", "android-v1.2.3", "v1.2.3 ", " v1.2.3", "v1.2.x", ""])(
    "reads %j as a prerelease",
    (tag) => {
      expect(shape(tag)).toBe("prerelease");
    },
  );

  it("is one function in the file, defined where the run starts", () => {
    expect(wfText.split("tag_shape() {").length - 1, "the classifier has a second copy that can drift").toBe(1);
    expect(jobBody("fence")).toContain("tag_shape() {");
    expect(jobBody("fence")).toMatch(/^ {6}tag_shape: \$\{\{ steps\.fence\.outputs\.tag_shape \}\}$/m);
  });

  it("writes the shape before anything can return, on every event", () => {
    const events: Record<string, string>[] = [{}, { VERIFY_ONLY: "true" }, { RELEASE_ACTION: "released" }];
    for (const env of events) {
      const r = run(FENCE, { prerelease: true, env });
      expect(r.code, r.err).toBe(0);
      expect(r.outputs, JSON.stringify(env)).toContain("tag_shape=release");
    }
    const rc = run(FENCE, { prerelease: true, env: { RELEASE_TAG: "v9.9.9-rc.1" } });
    expect(rc.outputs).toContain("tag_shape=prerelease");
  });

  it("carries no output nothing consumes", () => {
    // `entered_prerelease` was written and read by nothing: a claim with no reader.
    expect(wfText).not.toContain("entered_prerelease");
  });
});

describe("the promotion asks the tag first", () => {
  const ALL_MARKERS = FEEDS.flatMap((f) => [`attached/${f}`, `served/${f}`]);
  const ready = { prerelease: true, markers: ALL_MARKERS };

  it("grants Latest to a release-shaped tag once its feeds answer — the positive control", () => {
    const r = run(PROMOTE, { ...ready, latest: PREVIOUS_TAG, env: { TAG_SHAPE: "release", PROMOTE: "true", FENCE: "already" } });
    expect(r.code, r.err).toBe(0);
    expect(r.outputs).toContain("promoted=yes");
    expect(r.state).toContain(`latest ${TAG}`);
  });

  it("never grants Latest to a prerelease-shaped tag, whatever the dispatch asked", () => {
    const r = run(PROMOTE, { ...ready, env: { TAG_SHAPE: "prerelease", PROMOTE: "true", FENCE: "already" } });
    expect(r.code, r.err).toBe(0);
    expect(r.outputs).toContain("promoted=no");
    expect(r.outputs).toContain("reason=the tag names a prerelease");
    expect(r.gh.filter((l) => l.startsWith("release edit")), "a prerelease tag was edited").toEqual([]);
    expect(r.state).toContain("prerelease true");
    expect(r.state).toContain(`latest ${PREVIOUS_TAG}`);
  });

  it("reads a fence that said nothing as a prerelease", () => {
    const silent: Record<string, string>[] = [{ TAG_SHAPE: "", PROMOTE: "true", FENCE: "already" }, { PROMOTE: "true", FENCE: "already" }];
    for (const env of silent) {
      const r = run(PROMOTE, { ...ready, env });
      expect(r.code, r.err).toBe(0);
      expect(r.outputs).toContain("promoted=no");
      expect(r.state).toContain("prerelease true");
    }
  });

  it("asks the tag before the input", () => {
    // Both refuse; the reason names which one was asked first.
    const r = run(PROMOTE, { ...ready, env: { TAG_SHAPE: "prerelease", PROMOTE: "false", FENCE: "already" } });
    expect(r.outputs).toContain("reason=the tag names a prerelease");
    expect(r.outputs).not.toContain("promote off");
    const at = (needle: string) => PROMOTE.indexOf(needle);
    expect(at('if [ "${TAG_SHAPE:-}" != release ]; then')).toBeGreaterThan(-1);
    expect(at('if [ "${TAG_SHAPE:-}" != release ]; then')).toBeLessThan(at('if [ "$PROMOTE" != true ]; then'));
  });

  it("takes the shape from the fence, across the job boundary", () => {
    expect(jobBody("publish")).toMatch(/^ {10}TAG_SHAPE: \$\{\{ needs\.fence\.outputs\.tag_shape \}\}$/m);
  });
});

describe("a release promoted by hand is read, and fenced again without its feeds", () => {
  const SIGNED = {
    "latest.json": `{"version":"${VERSION}","platforms":{}}\n`,
    "appcast-macos.xml": "<rss><channel><item/></channel></rss>\n",
    SHA256SUMS: "abc  ohmail-linux-x86_64.AppImage\n",
  };
  const PREVIOUS = {
    "latest.json": `{"version":"9.9.8","platforms":{}}\n`,
    "appcast-macos.xml": "<rss><channel><item>9.9.8</item></channel></rss>\n",
    SHA256SUMS: "def  ohmail-linux-x86_64.AppImage\n",
  };
  const promoted = { prerelease: false, latest: TAG, own: SIGNED, served: SIGNED };
  const refence = (world: World, shape = "release") => run(REFENCE, { ...world, env: { TAG_SHAPE: shape, ...(world.env ?? {}) } });
  const edits = (r: Ran) => r.gh.filter((l) => l.startsWith("release edit"));

  it("admits a promotion whose three feeds answer at /releases/latest/download with this release's bytes", () => {
    const r = refence(promoted);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain(`HAND-PROMOTION-VERIFIED ${TAG}`);
    expect(edits(r)).toEqual([]);
    expect(r.state).toContain("prerelease false");
    // Every feed read from BOTH addresses, and every read carries its own cache-buster.
    for (const f of FEEDS) {
      expect(r.curl.some((u) => u.includes(`/releases/latest/download/${f}?cb=`)), f).toBe(true);
      expect(r.curl.some((u) => u.includes(`/releases/download/${TAG}/${f}?cb=`)), f).toBe(true);
    }
    expect(new Set(r.curl).size, "two reads shared a cache-buster").toBe(r.curl.length);
  });

  it("fences a page whose Latest address still serves the previous release", () => {
    const r = refence({ ...promoted, served: PREVIOUS });
    expect(r.code).not.toBe(0);
    expect(r.err).toContain(`HAND-PROMOTED-WITHOUT-FEEDS ${TAG}: /releases/latest/download/latest.json is not this release's`);
    expect(edits(r)).toEqual([`release edit ${TAG} --repo trafficflowhq/ohmail --prerelease`]);
    expect(r.state).toContain("prerelease true");
    expect(r.err).toContain("is a prerelease again");
    // Five rounds before the verdict: the address can take a moment to move after a promotion.
    expect(r.sleeps).toEqual(["12", "12", "12", "12"]);
  });

  it("admits a promotion once the Latest address has caught up", () => {
    const r = refence({ ...promoted, stale: PREVIOUS, staleReads: 1 });
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain(`HAND-PROMOTION-VERIFIED ${TAG}`);
    expect(r.sleeps).toEqual(["12"]);
    expect(edits(r)).toEqual([]);
  });

  it.each(FEEDS)("fences a page that does not carry %s", (missing) => {
    const own = { ...SIGNED } as Record<string, string>;
    delete own[missing];
    const r = refence({ ...promoted, own });
    expect(r.code).not.toBe(0);
    expect(r.err).toContain(`HAND-PROMOTED-WITHOUT-FEEDS ${TAG}: ${missing} is not on the release`);
    expect(r.state).toContain("prerelease true");
  });

  it.each(FEEDS)("fences a page whose %s does not answer at /releases/latest/download", (missing) => {
    const served = { ...SIGNED } as Record<string, string>;
    delete served[missing];
    const r = refence({ ...promoted, served });
    expect(r.code).not.toBe(0);
    expect(r.err).toContain(`HAND-PROMOTED-WITHOUT-FEEDS ${TAG}: ${missing} does not answer at /releases/latest/download`);
    expect(r.state).toContain("prerelease true");
  });

  it("fences a page whose own manifest announces another version", () => {
    const wrong = { ...SIGNED, "latest.json": `{"version":"9.9.8","platforms":{}}\n` };
    const r = refence({ ...promoted, own: wrong, served: wrong });
    expect(r.code).not.toBe(0);
    expect(r.err).toContain(`HAND-PROMOTED-WITHOUT-FEEDS ${TAG}: latest.json announces 9.9.8, not ${VERSION}`);
  });

  it("fences a prerelease-shaped tag whatever its feeds say, and reads nothing to decide it", () => {
    for (const shape of ["prerelease", ""]) {
      const r = refence(promoted, shape);
      expect(r.code, `shape ${JSON.stringify(shape)}`).not.toBe(0);
      expect(r.err).toContain(`HAND-PROMOTED-A-PRERELEASE ${TAG}`);
      expect(r.state).toContain("prerelease true");
      expect(r.curl).toEqual([]);
    }
  });

  it("says so by name when the flag would not go back on", () => {
    const r = refence({ ...promoted, served: PREVIOUS, editIgnored: true });
    expect(r.code).not.toBe(0);
    expect(r.err).toContain(`REFENCE-NOT-APPLIED ${TAG}`);
    expect(r.err).not.toContain("is a prerelease again");
  });

  it("names the repository on every gh call — the stub's refusal, watched firing", () => {
    // The admitted run above made its calls through the stub, so the stub admits a named call.
    // The same block with the repository taken off its edit is refused, and says which call.
    const cut = REFENCE.replace('gh release edit "$RELEASE_TAG" --repo "$REPO" --prerelease', 'gh release edit "$RELEASE_TAG" --prerelease');
    expect(cut, "the mutation matched nothing").not.toBe(REFENCE);
    const r = run(cut, { ...promoted, served: PREVIOUS, env: { TAG_SHAPE: "release" } });
    expect(r.err).toContain("GH-STUB-REFUSED gh release edit v9.9.9 --prerelease names no repository");
    expect(r.state, "an unnamed edit changed the page").toContain("prerelease false");
    expect(r.err).toContain(`REFENCE-NOT-APPLIED ${TAG}`);
  });

  it("carries a cache-buster on every read — the curl stub's refusal, watched firing", () => {
    const cut = REFENCE.replace('"$1?cb=$(date +%s)-$RANDOM-$attempt"', '"$1"');
    expect(cut, "the mutation matched nothing").not.toBe(REFENCE);
    const r = run(cut, { ...promoted, env: { TAG_SHAPE: "release" } });
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("CURL-STUB-REFUSED a read with no cache-buster");
    expect(r.out).not.toContain("HAND-PROMOTION-VERIFIED");
  });
});

describe("the run a hand promotion starts", () => {
  it("is read by the refence job alone; the jobs that sign and attach do not run on it", () => {
    expect(wfText).toContain("  release:\n    types: [published, released]\n");
    expect(jobBody("refence")).toMatch(/^ {4}if: github\.event_name == 'release' && github\.event\.action == 'released'$/m);
    expect(jobBody("prepare")).toMatch(/^ {4}if: .*&& github\.event\.action != 'released'$/m);
    expect(jobBody("sign")).toMatch(/^ {4}needs: prepare$/m);
    expect(jobBody("publish")).toMatch(/^ {4}needs: \[fence, prepare, sign\]$/m);
  });

  it("leaves the fence untouched on it: no gh call, and the shape still written", () => {
    const r = run(FENCE, { prerelease: false, env: { RELEASE_ACTION: "released" } });
    expect(r.code, r.err).toBe(0);
    expect(r.gh, "the fence asked the page something on a hand promotion").toEqual([]);
    expect(r.outputs).toContain("fence=hand-promotion");
    expect(r.state).toContain("prerelease false");
  });

  it("cannot start itself: every token that edits a release is the run's own", () => {
    /* A promotion made with GITHUB_TOKEN starts no workflow, so this job's own `--latest` edit
     * never fires `released`. A personal token there would. Counted, with the positive control
     * that the count is what the file carries today. */
    const tokens = wf.filter((l) => /^\s+GH_TOKEN:/.test(l)).map((l) => l.trim());
    expect(tokens.length, "the census read no GH_TOKEN at all").toBe(6);
    expect(new Set(tokens)).toEqual(new Set(["GH_TOKEN: ${{ github.token }}"]));
    expect(wfText).not.toMatch(/GH_TOKEN: \$\{\{ secrets\./);
  });

  it("names every new step exactly once", () => {
    for (const name of [FENCE_STEP, PROMOTE_STEP, REFENCE_STEP]) {
      expect(wf.filter((l) => l.trim() === `- name: ${name}`), name).toHaveLength(1);
    }
  });
});
