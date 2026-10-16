import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { publicPath } from "./support/public-root.mjs";

/**
 * "LATEST" IS A STATE THE FEEDS JOB GRANTS, AND IT GRANTS IT LAST.
 *
 * Publishing a desktop release makes it Latest immediately, while the feeds it needs —
 * latest.json, appcast-macos.xml, SHA256SUMS — are attached minutes later by
 * release-feeds.yml. An outage or a timeout in between leaves a release that is Latest with no
 * feed, and every installed client's pinned update URL answers 404 until somebody repairs the
 * page by hand (0.16.2, and about five minutes at 0.17.0).
 *
 * The workflow therefore fences the page: it marks a release that arrives Latest a prerelease
 * before anything that can fail, attaches the feeds, reads all three back from the address
 * clients use, and only then takes the flag off. A prerelease is not Latest, so a run that dies
 * anywhere in between leaves /releases/latest resolving to the previous release, whose feeds
 * work — an update path rather than a 404.
 *
 * Nothing here runs GitHub Actions. Each block is pulled out of the workflow and executed AS THE
 * SHELL IT IS against `gh` and `curl` stubs that answer the way the real ones answer, so a block
 * that changes under an editor's hand is measured here rather than on a release.
 */
const HERE = fileURLToPath(new URL(".", import.meta.url));
const WF = publicPath("github/workflows/release-feeds.yml");
const wfText = readFileSync(WF, "utf8");
const wf = wfText.split("\n");

const FEEDS = ["latest.json", "appcast-macos.xml", "SHA256SUMS"] as const;
const TAG = "v9.9.9";
const VERSION = "9.9.9";
/** The release `/releases/latest` resolves to until this run grants the flag to `TAG`. */
const PREVIOUS_TAG = "v9.9.8";

/** The `run:` body of a named step, dedented — the shell the runner would execute. */
function runBlock(stepName: string): string {
  const at = wf.findIndex((l) => l.trim() === `- name: ${stepName}`);
  expect(at, `the step "${stepName}" is gone from release-feeds.yml`).toBeGreaterThan(-1);
  const nextStep = wf.findIndex((l, i) => i > at && /^ {6}- (name|uses):/.test(l));
  const runAt = wf.findIndex((l, i) => i > at && l.trim() === "run: |");
  expect(runAt, `"${stepName}" has no run block`).toBeGreaterThan(at);
  expect(runAt, `"${stepName}" lost its run block to the next step`).toBeLessThan(nextStep === -1 ? wf.length : nextStep);
  const indent = wf[runAt].indexOf("run:") + 2;
  const body: string[] = [];
  for (let i = runAt + 1; i < wf.length; i++) {
    if (wf[i].trim() === "") {
      body.push("");
      continue;
    }
    if (wf[i].search(/\S/) < indent) break;
    body.push(wf[i].slice(indent));
  }
  return `${body.join("\n")}\n`;
}

/**
 * The marker block inside the big attach step, bounded by its own first and last lines so an
 * edit that moves it reddens here rather than quietly shrinking what is measured.
 */
function attachMarkerBlock(): string {
  const first = wf.findIndex((l) => l.trim() === "mkdir -p feeds-state/attached");
  expect(first, "the attached-feed markers are gone from release-feeds.yml").toBeGreaterThan(0);
  const last = wf.findIndex((l, i) => i > first && l.includes("the release does not carry:"));
  expect(last, "the refusal that names an unattached feed is gone").toBeGreaterThan(first);
  const body = wf.slice(first, last + 3).map((l) => l.replace(/^ {10}/, ""));
  expect(body[body.length - 1].trim(), "the block was sliced short of its own `fi`").toBe("fi");
  expect(body.join("\n")).toContain("FEEDS-NOT-ATTACHED");
  return `${body.join("\n")}\n`;
}

type World = {
  /** Release-page state the `gh` stub answers from. */
  prerelease?: boolean;
  draft?: boolean;
  /** Asset names the page carries. */
  assets?: string[];
  /** What each URL under /releases/download/<tag>/ answers with; absent = 404. */
  served?: Record<string, string>;
  /** Files in the workspace — the bytes this run signed. */
  workspace?: Record<string, string>;
  /** The prepare job's artifact, `meta/manifest.json`: the one place the version is written. */
  manifest?: Record<string, unknown> | null;
  /** Marker files already written by earlier steps: "attached/latest.json", … */
  markers?: string[];
  env?: Record<string, string>;
  /** The tag `/releases/latest` resolves to before the block runs — the PREVIOUS release. */
  latest?: string;
  /** `gh release edit` answers 0 and changes nothing / refuses outright. */
  editIgnored?: boolean;
  editFails?: boolean;
  /** `--latest` is accepted and `/releases/latest` does not move — a promotion that did not take. */
  latestSticks?: boolean;
  /** `gh release view` refuses — the release-state request nobody can read. */
  viewFails?: boolean;
};

type Result = { code: number; out: string; err: string; outputs: string; summary: string; ghLog: string; state: string; dir: string };

const GH_STUB = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$STUB/gh.log"
tag=""; for a in "$@"; do case "$a" in v[0-9]*) [ -z "$tag" ] && tag=$a ;; esac; done
pre=$(grep -a "^prerelease " "$STUB/state" | cut -d' ' -f2); pre=\${pre:-false}
dr=$(grep -a "^draft " "$STUB/state" | cut -d' ' -f2); dr=\${dr:-false}
lat=$(grep -a "^latest " "$STUB/state" | cut -d' ' -f2)
assets=$(grep -a "^assets " "$STUB/state" | cut -d' ' -f2-)
setflag() { tmp=$(mktemp); sed "s/^prerelease .*/prerelease $1/" "$STUB/state" > "$tmp" && mv "$tmp" "$STUB/state"; }
setlatest() { tmp=$(mktemp); sed "s/^latest .*/latest $1/" "$STUB/state" > "$tmp" && mv "$tmp" "$STUB/state"; }
# The whole reason this row exists: the real API does NOT move /releases/latest when the
# prerelease flag comes off. Only an explicit make_latest does, so only \`--latest\` moves it
# here — a step that takes the flag off and stops leaves this stub answering the previous tag,
# which is what 0.19.2 and 0.19.3 measured on the live page.
case "$1" in
  api)
    case "$2" in
      */releases/latest)
        if [ -z "$lat" ] || [ "$lat" = none ]; then echo "gh: Not Found (HTTP 404)" >&2; exit 1; fi
        printf '%s\\n' "$lat" ;;
    esac
    exit 0 ;;
esac
case "$1 $2" in
  "release view")
    if [ -n "\${GH_STUB_VIEW_FAILS:-}" ]; then echo "gh: HTTP 502 Bad Gateway" >&2; exit 1; fi
    case "$*" in
      *--jq*) for a in $assets; do printf '%s\\n' "$a"; done ;;
      *) printf '{"isPrerelease":%s,"isDraft":%s}\\n' "$pre" "$dr" ;;
    esac ;;
  "release edit")
    if [ -n "\${GH_STUB_EDIT_FAILS:-}" ]; then echo "gh: the release could not be edited" >&2; exit 1; fi
    if [ -z "\${GH_STUB_EDIT_IGNORED:-}" ]; then
      case "$*" in
        *--prerelease=false*) setflag false ;;
        *--prerelease*) setflag true ;;
      esac
      if [ -z "\${GH_STUB_LATEST_STICKS:-}" ]; then
        case "$*" in *--latest*) setlatest "$tag" ;; esac
      fi
    fi ;;
esac
exit 0
`;

const CURL_STUB = `#!/usr/bin/env bash
out=""; url=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    https://*) url="$1"; shift ;;
    *) shift ;;
  esac
done
printf '%s\\n' "$url" >> "$STUB/curl.log"
name=\${url##*/}; name=\${name%%\\?*}
src="$STUB/served/$name"
if [ ! -f "$src" ]; then exit 22; fi
if [ -n "$out" ]; then cp "$src" "$out"; else cat "$src"; fi
exit 0
`;

/** Runs one workflow block in a world, and answers with the shell's own exit code. */
function run(block: string, world: World = {}): Result {
  const dir = mkdtempSync(join(tmpdir(), "ohmail-feeds-fence-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "gh"), GH_STUB);
  writeFileSync(join(bin, "curl"), CURL_STUB);
  // A no-op `sleep`, so the ten-read retry of an absent feed is measured in milliseconds.
  writeFileSync(join(bin, "sleep"), "#!/usr/bin/env bash\nexit 0\n");
  for (const f of ["gh", "curl", "sleep"]) chmodSync(join(bin, f), 0o755);

  writeFileSync(
    join(dir, "state"),
    `prerelease ${world.prerelease ?? false}\ndraft ${world.draft ?? false}\nlatest ${world.latest ?? PREVIOUS_TAG}\nassets ${(world.assets ?? []).join(" ")}\n`,
  );
  writeFileSync(join(dir, "gh.log"), "");
  writeFileSync(join(dir, "curl.log"), "");
  mkdirSync(join(dir, "served"));
  for (const [name, body] of Object.entries(world.served ?? {})) writeFileSync(join(dir, "served", name), body);
  for (const [name, body] of Object.entries(world.workspace ?? {})) writeFileSync(join(dir, name), body);
  if (world.manifest !== null) {
    mkdirSync(join(dir, "meta"), { recursive: true });
    writeFileSync(join(dir, "meta", "manifest.json"), JSON.stringify(world.manifest ?? { version: VERSION }));
  }
  for (const m of world.markers ?? []) {
    mkdirSync(join(dir, "feeds-state", m.split("/")[0]), { recursive: true });
    writeFileSync(join(dir, "feeds-state", m), "");
  }
  writeFileSync(join(dir, "outputs"), "");
  writeFileSync(join(dir, "summary.md"), "");
  writeFileSync(join(dir, "step.sh"), block);

  const env: NodeJS.ProcessEnv = {
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    HOME: dir,
    STUB: dir,
    GITHUB_REPOSITORY: "trafficflowhq/ohmail",
    GITHUB_OUTPUT: join(dir, "outputs"),
    GITHUB_STEP_SUMMARY: join(dir, "summary.md"),
    /* What the step is handed for a release event; a dispatch overrides both. */
    EVENT_NAME: "release",
    RUN_REF: `refs/tags/${TAG}`,
    RELEASE_TAG: TAG,
    ...(world.editIgnored ? { GH_STUB_EDIT_IGNORED: "1" } : {}),
    ...(world.editFails ? { GH_STUB_EDIT_FAILS: "1" } : {}),
    ...(world.viewFails ? { GH_STUB_VIEW_FAILS: "1" } : {}),
    ...(world.latestSticks ? { GH_STUB_LATEST_STICKS: "1" } : {}),
    ...(world.env ?? {}),
  };
  // spawnSync, not execFileSync: a block that SUCCEEDS still writes to stderr here (the fence
  // that could not close prints its refusal and carries on), and execFileSync hands back stdout
  // alone on success — the arm for that line would have read an empty string and passed for
  // nothing.
  const p = spawnSync("bash", ["step.sh"], { cwd: dir, env, encoding: "utf8" });
  return {
    code: p.status ?? -1,
    out: p.stdout ?? "",
    err: p.stderr ?? "",
    outputs: readFileSync(join(dir, "outputs"), "utf8"),
    summary: readFileSync(join(dir, "summary.md"), "utf8"),
    ghLog: readFileSync(join(dir, "gh.log"), "utf8"),
    // The page as the stub holds it AFTER the block ran — "it stays a prerelease" is a claim
    // about the release, and reading it off the gh log would be reading the request, not the page.
    state: readFileSync(join(dir, "state"), "utf8"),
    dir,
  };
}

const FENCE = runBlock("Fence the release until its feeds are on it");
const ATTACHED = attachMarkerBlock();
const SERVED = runBlock("Read the three feeds back from where clients read them");
const PROMOTE = runBlock("Grant latest, now that the feeds are on the release");
const SUMMARY = runBlock("Run summary");

/* The attach markers live inside a step that has already set REPO and RELEASE_TAG, and defined
   the transfer retry its listing read goes through — taken from that step, not retyped. */
function stepFunction(stepName: string, fn: string): string {
  const at = wf.findIndex((l) => l.trim() === `- name: ${stepName}`);
  const from = wf.findIndex((l, i) => i > at && l.trim() === `${fn}() {`);
  expect(from, `"${stepName}" defines no ${fn}`).toBeGreaterThan(at);
  const indent = wf[from].search(/\S/);
  const to = wf.findIndex((l, i) => i > from && l.search(/\S/) === indent && l.trim() === "}");
  return `${wf.slice(from, to + 1).map((l) => l.slice(indent)).join("\n")}\n`;
}
const ATTACH_PREAMBLE = `set -euo pipefail\nREPO="$GITHUB_REPOSITORY"\n${stepFunction("Write, verify and attach the feeds", "retry_on_transport")}`;

/** What the attach and read-back steps write when all three feeds are on the page and answering. */
const ALL_MARKERS = FEEDS.flatMap((f) => [`attached/${f}`, `served/${f}`]);

const SIGNED = {
  "latest.json": `{"version":"${VERSION}","platforms":{}}\n`,
  "appcast-macos.xml": "<rss><channel><item/></channel></rss>\n",
  SHA256SUMS: "abc  ohmail-linux-x86_64.AppImage\n",
};

describe("the fence: a release is not Latest until its feeds are on it", () => {
  it("marks a release that was published as Latest a prerelease, before anything that can fail", () => {
    const r = run(FENCE, { prerelease: false });
    expect(r.code).toBe(0);
    expect(r.ghLog).toContain("release edit");
    expect(r.ghLog).toContain("--prerelease");
    expect(r.ghLog).not.toContain("--prerelease=false");
    expect(r.outputs).toContain("fence=fenced");
    expect(r.out).toContain(TAG);
  });

  it("leaves a release that is already a prerelease alone", () => {
    // The ordinary path once release-page.sh creates the page fenced: nothing to edit, and the
    // job goes on to attach the feeds the flag is waiting for.
    const r = run(FENCE, { prerelease: true });
    expect(r.code).toBe(0);
    expect(r.ghLog).not.toContain("release edit");
    expect(r.outputs).toContain("fence=already");
  });

  it("touches nothing on a draft", () => {
    const r = run(FENCE, { draft: true, prerelease: false });
    expect(r.code).toBe(0);
    expect(r.ghLog).not.toContain("release edit");
    expect(r.outputs).toContain("fence=draft");
  });

  it("touches nothing at all on a verify-only dispatch", () => {
    // The mode that reads the provenance check against a real release: it may not write to the
    // page, and the one job with the scope to is also the first to say it will not.
    const r = run(FENCE, { prerelease: false, env: { VERIFY_ONLY: "true" } });
    expect(r.code).toBe(0);
    expect(r.ghLog, "a verify-only run asked the release for something").toBe("");
    expect(r.outputs).toContain("fence=verify-only");
    expect(r.state).toContain("prerelease false");
  });

  it("refuses a dispatch from a branch before it reads or touches anything: the signing job would refuse it", () => {
    /* The signing job's environment admits a run on a release tag only. A dispatch from main used to
     * fence a Latest page here and then die at the signing job, leaving it demoted with no feeds. */
    const branch = run(FENCE, { prerelease: false, env: { EVENT_NAME: "workflow_dispatch", RUN_REF: "refs/heads/main" } });
    expect(branch.code).not.toBe(0);
    expect(branch.err).toContain(`FENCE-REFUSED ${TAG}: this dispatch runs on refs/heads/main`);
    expect(branch.err).toContain(`--ref ${TAG} -f tag=${TAG}`);
    expect(branch.ghLog, "a refused dispatch asked the release for something").toBe("");
    expect(branch.state).toContain("prerelease false");
    expect(branch.outputs).not.toContain("fence=");
    /* On another tag too: the run must be ON the tag it releases. */
    expect(run(FENCE, { prerelease: false, env: { EVENT_NAME: "workflow_dispatch", RUN_REF: "refs/tags/v9.9.8" } }).code).not.toBe(0);
  });

  it("fences a dispatch made ON the tag as it fences a release event, and lets a verify-only dispatch run from anywhere", () => {
    const onTag = run(FENCE, { prerelease: false, env: { EVENT_NAME: "workflow_dispatch", RUN_REF: `refs/tags/${TAG}` } });
    expect(onTag.code).toBe(0);
    expect(onTag.outputs).toContain("fence=fenced");
    const verify = run(FENCE, { prerelease: false, env: { EVENT_NAME: "workflow_dispatch", RUN_REF: "refs/heads/main", VERIFY_ONLY: "true" } });
    expect(verify.code).toBe(0);
    expect(verify.outputs).toContain("fence=verify-only");
    expect(verify.ghLog).toBe("");
  });

  it("refuses a run whose event the runner did not name, rather than guessing it is not a dispatch", () => {
    const r = run(FENCE, { prerelease: false, env: { EVENT_NAME: "" } });
    expect(r.code).not.toBe(0);
    expect(r.ghLog).toBe("");
  });

  it("stops the run when the release's own state will not answer, having touched nothing", () => {
    // A failed release-state request used to kill the step with `set -e` — no name, and no word
    // about what it leaves behind. It refuses by name now, and because this job is what every
    // other job waits for, nothing downstream can change a flag on a page nobody could read.
    const r = run(FENCE, { prerelease: false, viewFails: true });
    expect(r.code).not.toBe(0);
    expect(r.err).toContain(`FENCE-STATE-UNREADABLE ${TAG}`);
    expect(r.err).toContain("No flag was touched by this run");
    expect(r.ghLog).not.toContain("release edit");
    expect(r.outputs).not.toContain("fence=");
  });

  it("names a flag that would not go on, and carries on attaching the feeds", () => {
    // The page is already Latest without feeds. Failing here would leave it exactly that way;
    // attaching the feeds is the only thing that helps it, so the run continues and says so.
    for (const world of [{ editIgnored: true }, { editFails: true }]) {
      const r = run(FENCE, { prerelease: false, ...world });
      expect(r.code, "a fence that could not close stopped the run").toBe(0);
      expect(r.err).toContain(`FENCE-NOT-APPLIED ${TAG}`);
      expect(r.outputs).toContain("fence=not-applied");
    }
  });
});

describe("what the release carries, read back from the release", () => {
  it("marks the three feeds the page actually carries", () => {
    const r = run(ATTACH_PREAMBLE + ATTACHED, { assets: [...FEEDS, "ohmail.app.tar.gz"] });
    expect(r.code).toBe(0);
    for (const f of FEEDS) expect(existsSync(join(r.dir, "feeds-state", "attached", f)), f).toBe(true);
  });

  it("refuses, by name, a feed the upload reported and the release does not carry", () => {
    for (const missing of FEEDS) {
      const r = run(ATTACH_PREAMBLE + ATTACHED, { assets: FEEDS.filter((f) => f !== missing) });
      expect(r.code, `${missing} absent and the job went on`).not.toBe(0);
      expect(r.err).toContain(`FEEDS-NOT-ATTACHED ${missing}`);
      expect(existsSync(join(r.dir, "feeds-state", "attached", missing))).toBe(false);
      // The two that ARE there are still marked: the summary states per feed, not per run.
      for (const other of FEEDS.filter((f) => f !== missing)) {
        expect(existsSync(join(r.dir, "feeds-state", "attached", other)), other).toBe(true);
      }
    }
  });
});

describe("read back from the address clients use", () => {
  it("admits three feeds that answer with the bytes this run signed", () => {
    const r = run(SERVED, { workspace: SIGNED, served: { ...SIGNED } });
    expect(r.code).toBe(0);
    for (const f of FEEDS) expect(existsSync(join(r.dir, "feeds-state", "served", f)), f).toBe(true);
    expect(r.outputs).toContain(`served_version=${VERSION}`);
  });

  it("carries a fresh cache-buster on every read, because a cached 404 answers for the page", () => {
    const r = run(SERVED, { workspace: SIGNED, served: { ...SIGNED } });
    const urls = readFileSync(join(r.dir, "curl.log"), "utf8").split("\n").filter(Boolean);
    expect(urls).toHaveLength(3);
    for (const u of urls) expect(u).toMatch(/\?cb=/);
    expect(new Set(urls).size, "two reads shared a cache-buster").toBe(urls.length);
  });

  it("refuses a feed that does not answer, by name", () => {
    for (const absent of FEEDS) {
      const served = { ...SIGNED } as Record<string, string>;
      delete served[absent];
      const r = run(SERVED, { workspace: SIGNED, served });
      expect(r.code, `${absent}404s and the job went on`).not.toBe(0);
      expect(r.err).toContain(`FEEDS-NOT-ATTACHED ${absent}`);
      expect(existsSync(join(r.dir, "feeds-state", "served", absent))).toBe(false);
    }
  });

  it("refuses a feed that answers with bytes nobody signed", () => {
    const r = run(SERVED, { workspace: SIGNED, served: { ...SIGNED, "appcast-macos.xml": "<rss>substituted</rss>\n" } });
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("FEEDS-NOT-ATTACHED appcast-macos.xml");
    expect(r.err).toContain("not the bytes this run signed");
  });

  it("refuses a manifest that announces the right version and carries the wrong bytes", () => {
    // Both refusals on latest.json are reachable, which is the reason the version is asked
    // first: the version check cannot stand in for the comparison, and this is the case that
    // only the comparison catches — a re-signed manifest for the same release.
    const r = run(SERVED, {
      workspace: SIGNED,
      served: { ...SIGNED, "latest.json": `{"version":"${VERSION}","platforms":{"windows-x86_64":{}}}\n` },
    });
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("FEEDS-NOT-ATTACHED latest.json");
    expect(r.err).toContain("not the bytes this run signed");
  });

  it("takes the version from the prepare job's manifest, not from anything handed to it", () => {
    // The manifest is the one place the version is written, and the read-back re-reads it there
    // rather than deriving it twice. Proved by moving it: the manifest says 9.9.8, the feed says
    // 9.9.9, and the step refuses — nothing in this harness's environment carries a version.
    const r = run(SERVED, { workspace: SIGNED, served: { ...SIGNED }, manifest: { version: "9.9.8" } });
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("FEEDS-NOT-ATTACHED latest.json");
    expect(r.err).toContain("9.9.8");
  });

  it("refuses a feed that announces another release's version", () => {
    // Attached is not served: the CDN can hand back the PREVIOUS release's manifest, and a client
    // that reads it is offered a payload this release did not build.
    const r = run(SERVED, { workspace: SIGNED, served: { ...SIGNED, "latest.json": `{"version":"9.9.8","platforms":{}}\n` } });
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("FEEDS-NOT-ATTACHED latest.json");
    expect(r.err).toContain("9.9.8");
    expect(existsSync(join(r.dir, "feeds-state", "served", "latest.json"))).toBe(false);
  });
});

describe("latest, granted last", () => {
  it("takes the flag off once the feeds are on the release", () => {
    const r = run(PROMOTE, { prerelease: true, markers: ALL_MARKERS, env: { TAG_SHAPE: "release", PROMOTE: "true", FENCE: "fenced" } });
    expect(r.code).toBe(0);
    expect(r.ghLog).toContain("--prerelease=false");
    expect(r.outputs).toContain("promoted=yes");
    expect(r.out).toContain(`LATEST-GRANTED ${TAG}`);
  });

  it("grants Latest in the same request, because the flag coming off does not move it", () => {
    // THE 0.19.2 AND 0.19.3 SHAPE. Both releases came out of this job with the prerelease flag
    // off and `/releases/latest` still resolving to the tag before them, until somebody ran
    // `gh release edit --latest` by hand. The stub models the API the same way — only an
    // explicit `--latest` moves the address — so a step that edits the flag alone leaves the
    // read-back below naming the previous tag.
    const r = run(PROMOTE, { prerelease: true, markers: ALL_MARKERS, env: { TAG_SHAPE: "release", PROMOTE: "true", FENCE: "fenced" } });
    expect(r.code).toBe(0);
    const edits = r.ghLog.split("\n").filter((l) => l.startsWith("release edit"));
    expect(edits, "the flag and Latest were asked for in separate requests").toHaveLength(1);
    expect(edits[0]).toContain("--prerelease=false");
    expect(edits[0]).toContain("--latest");
    expect(r.state, "/releases/latest still answers the previous release").toContain(`latest ${TAG}`);
    expect(r.out).toContain(`LATEST-GRANTED ${TAG}`);
  });

  it("refuses when the flag came off and /releases/latest still names another release", () => {
    // The read-back, given a page that accepted the request and did not move. Without it the
    // job reports LATEST-GRANTED over a release nobody can update to.
    const r = run(PROMOTE, {
      prerelease: true,
      latestSticks: true,
      markers: ALL_MARKERS,
      env: { TAG_SHAPE: "release", PROMOTE: "true", FENCE: "fenced" },
    });
    expect(r.code).not.toBe(0);
    expect(r.err).toContain(`LATEST-NOT-GRANTED ${TAG}`);
    expect(r.err).toContain(PREVIOUS_TAG);
    expect(r.outputs).toContain("promoted=no");
    expect(r.out).not.toContain("LATEST-GRANTED");
  });

  it("leaves a page a prerelease when the run was asked to", () => {
    const r = run(PROMOTE, { prerelease: true, env: { TAG_SHAPE: "release", PROMOTE: "false", FENCE: "already" } });
    expect(r.code).toBe(0);
    expect(r.ghLog).not.toContain("release edit");
    expect(r.outputs).toContain("promoted=no");
    expect(r.state, "a held page was granted Latest").toContain(`latest ${PREVIOUS_TAG}`);
  });

  it("does not publish a draft", () => {
    const r = run(PROMOTE, { draft: true, env: { TAG_SHAPE: "release", PROMOTE: "true", FENCE: "draft" } });
    expect(r.code).toBe(0);
    expect(r.ghLog).not.toContain("release edit");
    expect(r.outputs).toContain("promoted=no");
    expect(r.state, "a draft was granted Latest").toContain(`latest ${PREVIOUS_TAG}`);
  });

  it("fails when the flag will not come off, rather than reporting a release Latest that is not", () => {
    const r = run(PROMOTE, { prerelease: true, editIgnored: true, markers: ALL_MARKERS, env: { TAG_SHAPE: "release", PROMOTE: "true", FENCE: "fenced" } });
    expect(r.code).not.toBe(0);
    expect(r.err).toContain(`LATEST-NOT-GRANTED ${TAG}`);
    expect(r.outputs).toContain("promoted=no");
  });

  it("leaves the page a prerelease when the release-state request fails", () => {
    // THE CONTROL THIS STEP EXISTS FOR. The state used to be read only AFTER the edit, so a
    // request that would not answer found the flag already off. Now the read comes first: it
    // fails, nothing is edited, and the page is still a prerelease — /releases/latest keeps
    // resolving to the last release whose feeds work.
    const r = run(PROMOTE, { prerelease: true, viewFails: true, markers: ALL_MARKERS, env: { TAG_SHAPE: "release", PROMOTE: "true", FENCE: "fenced" } });
    expect(r.code).not.toBe(0);
    expect(r.err).toContain(`LATEST-NOT-GRANTED ${TAG}`);
    expect(r.err).toContain("did not answer in five reads");
    expect(r.ghLog, "the flag was edited on a page nobody could read").not.toContain("release edit");
    expect(r.state).toContain("prerelease true");
    expect(r.outputs).toContain("promoted=no");
  });

  it("refuses to promote a run that recorded no attached and answering feeds", () => {
    // Position is a property of the file; the markers are a property of the run. Each one
    // missing is named, and the edit is never reached.
    for (const missing of ALL_MARKERS) {
      const r = run(PROMOTE, {
        prerelease: true,
        markers: ALL_MARKERS.filter((m) => m !== missing),
        env: { TAG_SHAPE: "release", PROMOTE: "true", FENCE: "fenced" },
      });
      expect(r.code, `${missing} was missing and the page was promoted anyway`).not.toBe(0);
      expect(r.err).toContain(`LATEST-NOT-GRANTED ${TAG}`);
      expect(r.err).toContain(missing);
      expect(r.ghLog).not.toContain("release edit");
      expect(r.state).toContain("prerelease true");
      expect(r.state, `${missing} was missing and Latest was granted anyway`).toContain(`latest ${PREVIOUS_TAG}`);
    }
  });

  it("does not publish a page that became a draft, read from the page rather than from the fence", () => {
    const r = run(PROMOTE, { draft: true, prerelease: true, markers: ALL_MARKERS, env: { TAG_SHAPE: "release", PROMOTE: "true", FENCE: "fenced" } });
    expect(r.code).toBe(0);
    expect(r.ghLog).not.toContain("release edit");
    expect(r.outputs).toContain("promoted=no");
    expect(r.outputs).toContain("reason=the page is a draft");
  });
});

describe("the summary states what happened", () => {
  const row = (s: string, feed: string) => s.split("\n").find((l) => l.startsWith(`| \`${feed}\``)) ?? "";

  it("reports three feeds on a Latest release when that is what the markers say", () => {
    const r = run(SUMMARY, {
      prerelease: false,
      latest: TAG,
      markers: FEEDS.flatMap((f) => [`attached/${f}`, `served/${f}`]),
      env: { FENCE: "fenced", SERVED_VERSION: VERSION },
    });
    expect(r.code).toBe(0);
    for (const f of FEEDS) expect(row(r.summary, f).endsWith("| yes | yes |"), f).toBe(true);
    expect(r.summary).toContain("is **Latest**");
    expect(r.summary).toContain(VERSION);
    expect(r.summary).not.toContain("FEEDS-NOT-ATTACHED");
  });

  it("does not claim attachment or verification after a step that failed", () => {
    // The guard this test exists for: the old summary printed "attached … verified … compared
    // back" unconditionally, under `if: always()`, so a run that stranded a release reported one
    // that had not been stranded.
    const r = run(SUMMARY, { prerelease: true, markers: [], env: { FENCE: "fenced", SERVED_VERSION: "" } });
    expect(r.code).toBe(0);
    for (const f of FEEDS) {
      expect(row(r.summary, f).endsWith("| no | no |"), f).toBe(true);
      expect(r.summary).toContain(`FEEDS-NOT-ATTACHED ${f}`);
    }
    expect(r.summary).toContain("is a **prerelease**");
    expect(r.summary).not.toContain("compared byte for byte");
  });

  it("states each feed separately when only some of them landed", () => {
    const r = run(SUMMARY, {
      prerelease: true,
      markers: ["attached/latest.json", "served/latest.json", "attached/SHA256SUMS"],
      env: { FENCE: "already", SERVED_VERSION: VERSION },
    });
    expect(r.code).toBe(0);
    expect(row(r.summary, "latest.json").endsWith("| yes | yes |")).toBe(true);
    expect(row(r.summary, "appcast-macos.xml").endsWith("| no | no |")).toBe(true);
    expect(row(r.summary, "SHA256SUMS").endsWith("| yes | no |")).toBe(true);
    expect(r.summary).toContain("FEEDS-NOT-ATTACHED appcast-macos.xml");
    expect(r.summary).toContain("FEEDS-NOT-ATTACHED SHA256SUMS");
    expect(r.summary).not.toContain("FEEDS-NOT-ATTACHED latest.json");
  });

  it("does not call a release Latest because its prerelease flag is off", () => {
    // What the summary said at 0.19.2 and 0.19.3: the flag was off, so it printed "is Latest",
    // while the address clients resolve answered the release before it. The claim is read from
    // that address now, and it names the tag actually being served.
    const r = run(SUMMARY, {
      prerelease: false,
      latest: PREVIOUS_TAG,
      markers: FEEDS.flatMap((f) => [`attached/${f}`, `served/${f}`]),
      env: { FENCE: "fenced", SERVED_VERSION: VERSION },
    });
    expect(r.code).toBe(0);
    expect(r.summary, "the summary called it Latest on the strength of the flag").not.toContain("is **Latest**");
    expect(r.summary).toContain("LATEST-NOT-GRANTED");
    expect(r.summary).toContain(PREVIOUS_TAG);
  });

  it("says when the run never reached the fence", () => {
    const r = run(SUMMARY, { prerelease: false, markers: [], env: { FENCE: "", SERVED_VERSION: "" } });
    expect(r.code).toBe(0);
    expect(r.summary).toContain("did not reach the fence step");
  });
});

describe("the shape the fence depends on", () => {
  it("subscribes to `published`, the one activity type every publish fires, and to `released` for a hand promotion", () => {
    // `released` + `prereleased` as the pair that carries the work is a trap: a prerelease
    // published out of a draft fires neither, and a stable publish fires `published` AND
    // `released`. So `published` carries the work, and `released` is read by the refence job
    // alone — test/release-feeds-workflow.test.ts holds that no other job runs on it.
    expect(wfText).toContain("  release:\n    types: [published, released]\n");
  });

  it("grants latest in a step that carries no condition, after the feeds have answered", () => {
    // No `if:` is the mechanism: a step without one runs only when every step before it
    // succeeded, so a feed that did not attach cannot be followed by a promotion.
    const order = ["Write, verify and attach the feeds", "Read the three feeds back from where clients read them", "Grant latest, now that the feeds are on the release", "Run summary"].map((n) =>
      wf.findIndex((l) => l.trim() === `- name: ${n}`),
    );
    for (const i of order) expect(i).toBeGreaterThan(-1);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    const promoteAt = order[2];
    const summaryAt = order[3];
    expect(wf.slice(promoteAt, summaryAt).some((l) => l.trim().startsWith("if:")), "the promotion grew a condition").toBe(false);
    expect(wf.slice(summaryAt, summaryAt + 3).some((l) => l.trim() === "if: always()")).toBe(true);
  });

  it("fences before the first step that can fail, in a job of its own that runs first", () => {
    const fenceAt = wf.findIndex((l) => l.trim() === "- name: Fence the release until its feeds are on it");
    const firstStep = wf.findIndex((l, i) => i > 0 && /^ {6}- (name|uses):/.test(l));
    expect(fenceAt, "something runs before the fence").toBe(firstStep);
    // From `jobs:` onward — `on:` has two-space keys of its own, and `release:` is one of them.
    const jobsAt = wf.indexOf("jobs:");
    expect(jobsAt).toBeGreaterThan(-1);
    const jobKeys = wf.slice(jobsAt).filter((l) => /^ {2}[a-z][a-z0-9-]*:$/.test(l)).map((l) => l.trim().slice(0, -1));
    expect(jobKeys[0], "the fence is not the first job").toBe("fence");
    expect(wf.some((l) => l.trim() === "needs: fence"), "nothing waits for the fence").toBe(true);
  });

  it("puts the fence in a job that may actually move the flag", () => {
    /* THE DEFECT THIS EXISTS FOR, measured: when the signing split landed under this change, the
     * rebase merged cleanly and left the fence step at the top of `prepare`, which carries
     * `contents: read`. `gh release edit` there is a 403 — the fence would print
     * FENCE-NOT-APPLIED, carry on by its own design, and the release would be Latest with no
     * feeds for the whole run. A clean merge that is silently wrong.
     *
     * So: the job the fence step lives in declares `contents: write`. */
    const fenceAt = wf.findIndex((l) => l.trim() === "- name: Fence the release until its feeds are on it");
    let jobStart = -1;
    for (let i = fenceAt; i > wf.indexOf("jobs:"); i--) if (/^ {2}[a-z][a-z0-9-]*:$/.test(wf[i])) { jobStart = i; break; }
    expect(jobStart).toBeGreaterThan(-1);
    const jobEnd = wf.findIndex((l, i) => i > jobStart && /^ {2}[a-z][a-z0-9-]*:$/.test(l));
    const job = wf.slice(jobStart, jobEnd === -1 ? wf.length : jobEnd).join("\n");
    expect(job, `the fence sits in a job without the write scope: ${wf[jobStart].trim()}`)
      .toMatch(/^ {4}permissions:\n {6}contents: write$/m);
  });
});
