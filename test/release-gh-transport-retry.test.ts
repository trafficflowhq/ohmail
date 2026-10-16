import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { publicPath } from "./support/public-root.mjs";

/**
 * A RELEASE TRANSFER SURVIVES A DROPPED STREAM, AND NOTHING ELSE IS RETRIED.
 *
 * At 0.23.1 the feeds job's one download of the release's assets died on an HTTP/2
 * PROTOCOL_ERROR, and the released page had no update feeds until the job was re-run by hand.
 * Every `gh release download|upload` in the published workflows runs through `retry_on_transport`:
 * three tries, 20 s then 40 s apart, on a named transport shape only. The verdict is the release
 * read back (sizes against its listing, or bytes by `cmp`), never the command's rc. Each function
 * is pulled out of the workflow and run AS THE SHELL IT IS against a `gh` stub.
 */
const HERE = fileURLToPath(new URL(".", import.meta.url));
const WF_DIR = publicPath("github/workflows");
const FILES = readdirSync(WF_DIR).filter((f) => f.endsWith(".yml")).sort();
const TEXT: Record<string, string> = Object.fromEntries(FILES.map((f) => [f, readFileSync(join(WF_DIR, f), "utf8")]));

const TAG = "v9.9.9";
const PREPARE = "Resolve the assets, pin the signers and stage them for signing";
const FEEDS = "Write, verify and attach the feeds";
const ATTACH = "Attach to the release";
const READBACK = "What was uploaded is what was signed";

type Step = { file: string; job: string; name: string; lines: string[] };

/** Every step of a workflow with its physical lines; a step starts at a six-space list item. */
function parseSteps(file: string): Step[] {
  const out: Step[] = [];
  let job = "";
  let cur: Step | null = null;
  for (const l of TEXT[file].split("\n")) {
    const j = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(l);
    if (j) {
      job = j[1];
      cur = null;
      continue;
    }
    const s = /^ {6}- (?:name: )?(.*)$/.exec(l);
    if (s) {
      cur = { file, job, name: s[1].trim(), lines: [] };
      out.push(cur);
    }
    if (cur) cur.lines.push(l);
  }
  return out;
}
/* Parsed once, so a step found through a call is the same object `steps()` hands back. */
const STEPS: Record<string, Step[]> = Object.fromEntries(FILES.map((f) => [f, parseSteps(f)]));
const steps = (file: string): Step[] => STEPS[file];

function stepNamed(file: string, name: string): Step {
  const st = steps(file).find((s) => s.name === name);
  expect(st, `the step "${name}" is gone from ${file}`).toBeDefined();
  return st!;
}

/** A step's shell commands: `\` continuations joined, comment lines dropped. */
function commands(st: Step): string[] {
  const out: string[] = [];
  let acc = "";
  for (const raw of st.lines) {
    const t = raw.trim();
    if (!acc && t.startsWith("#")) continue;
    acc = acc ? `${acc} ${t}` : t;
    if (acc.endsWith("\\")) {
      acc = acc.slice(0, -1).trimEnd();
      continue;
    }
    if (acc) out.push(acc);
    acc = "";
  }
  return out;
}

/** `name() { … }` as a step defines it, dedented to column 0; null when the step does not. */
function fnIn(st: Step, name: string): string | null {
  const at = st.lines.findIndex((l) => l.trim() === `${name}() {`);
  if (at < 0) return null;
  const indent = st.lines[at].search(/\S/);
  const end = st.lines.findIndex((l, i) => i > at && l.search(/\S/) === indent && l.trim() === "}");
  expect(end, `${name} in "${st.name}" has no closing brace at its own indent`).toBeGreaterThan(at);
  return `${st.lines.slice(at, end + 1).map((l) => l.slice(indent)).join("\n")}\n`;
}

function fnOf(file: string, stepName: string, name: string): string {
  const text = fnIn(stepNamed(file, stepName), name);
  expect(text, `"${stepName}" in ${file} defines no ${name}`).not.toBeNull();
  return text!;
}

/** The physical lines from the first matching `from` through the first matching `to`, dedented. */
function slice(st: Step, from: (t: string) => boolean, to: (t: string) => boolean): string {
  const a = st.lines.findIndex((l) => from(l.trim()));
  expect(a, `the slice's first line is gone from "${st.name}"`).toBeGreaterThan(-1);
  const b = st.lines.findIndex((l, i) => i >= a && to(l.trim()));
  expect(b, `the slice's last line is gone from "${st.name}"`).toBeGreaterThanOrEqual(a);
  const indent = st.lines[a].search(/\S/);
  return `${st.lines.slice(a, b + 1).map((l) => l.slice(indent)).join("\n")}\n`;
}

/** The `run:` body of a step, dedented — the shell the runner executes. */
function runBody(st: Step): string {
  const at = st.lines.findIndex((l) => l.trim() === "run: |");
  expect(at, `"${st.name}" has no run block`).toBeGreaterThan(-1);
  const indent = st.lines[at].indexOf("run:") + 2;
  const body: string[] = [];
  for (const l of st.lines.slice(at + 1)) {
    if (l.trim() !== "" && l.search(/\S/) < indent) break;
    body.push(l.slice(indent));
  }
  return `${body.join("\n")}\n`;
}

const TRANSFER = /\bgh release (download|upload)\b/;
type Call = { step: Step; text: string; verb: string };
const ALL: Call[] = FILES.flatMap((f) => steps(f)).flatMap((step) =>
  commands(step)
    .filter((text) => TRANSFER.test(text))
    .map((text) => ({ step, text, verb: TRANSFER.exec(text)![1] })),
);
/** A command that PRINTS the words, as the run summary's recovery instructions do. */
const PRINTED = ALL.filter((c) => /^echo\b/.test(c.text));
const CALLS = ALL.filter((c) => !PRINTED.includes(c));
const at = (c: Call) => `${c.step.file} · ${c.step.name} · ${c.text.slice(0, 90)}`;
const dirOf = (c: Call) => /--dir (\S+)/.exec(c.text)?.[1] ?? "";
const patternsOf = (c: Call) => [...c.text.matchAll(/--pattern "?([^"\s]+)"?/g)].map((m) => m[1]);
/** An upload's file operands: every word after the tag that is not a flag or a flag's value. */
function uploadedFiles(c: Call): string[] {
  const words = c.text.replace(/^.*?gh release upload \S+/, "").trim().split(/\s+/);
  const files: string[] = [];
  for (let i = 0; i < words.length; i++) {
    if (words[i] === "--repo") i++;
    else if (!words[i].startsWith("--")) files.push(words[i]);
  }
  return files;
}
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

describe("every release transfer in the published workflows goes through the retry", () => {
  it("reads the ten transfers it exists for, so a zero below is a reading", () => {
    const inFile = (f: string) => CALLS.filter((c) => c.step.file === f).length;
    expect(inFile("release-feeds.yml")).toBe(4);
    expect(inFile("android.yml")).toBe(6);
    expect(CALLS).toHaveLength(10);
    expect(PRINTED.map((c) => `${c.step.file} · ${c.step.name}`)).toEqual(["release-feeds.yml · Run summary"]);
  });

  it("runs every one of them through retry_on_transport", () => {
    const bare = CALLS.filter((c) => TRANSFER.test(c.text.replace(/retry_on_transport gh release (download|upload)\b/g, "")));
    expect(bare.map(at), "a transfer that one dropped stream fails outright").toEqual([]);
  });

  it("retries the read that says whether the feeds are on the page", () => {
    const feeds = commands(stepNamed("release-feeds.yml", FEEDS));
    expect(feeds.filter((t) => t.startsWith("ON_PAGE="))).toEqual([
      `ON_PAGE="$(retry_on_transport gh release view "$RELEASE_TAG" --repo "$REPO" --json assets --jq '.assets[].name')"`,
    ]);
  });

  it("defines the function in every step that calls it, as one text", () => {
    const callers = [...new Set(CALLS.map((c) => c.step))];
    expect(callers.map((s) => `${s.file} · ${s.name}`)).toEqual([
      `android.yml · ${ATTACH}`,
      `android.yml · ${READBACK}`,
      `release-feeds.yml · ${PREPARE}`,
      `release-feeds.yml · ${FEEDS}`,
    ]);
    const texts = callers.map((s) => fnIn(s, "retry_on_transport"));
    texts.forEach((t, i) => expect(t, `"${callers[i].name}" calls retry_on_transport and does not define it`).not.toBeNull());
    expect(new Set(texts).size, "the copies of retry_on_transport have drifted apart").toBe(1);
  });

  it("clobbers on every upload, so a retry replaces what a dropped attempt left", () => {
    const uploads = CALLS.filter((c) => c.verb === "upload");
    expect(uploads).toHaveLength(4);
    for (const c of uploads) expect(c.text, at(c)).toMatch(/ --clobber\b/);
  });

  it("checks every whole-release download against the listing before the next command", () => {
    const whole = CALLS.filter((c) => c.verb === "download" && patternsOf(c).length === 0);
    expect(whole.map((c) => c.step.name)).toEqual([PREPARE, FEEDS]);
    for (const c of whole) {
      const cmds = commands(c.step);
      expect(cmds[cmds.indexOf(c.text) + 1], at(c)).toBe(`assets_on_disk "$RELEASE_TAG" "$REPO" ${dirOf(c)}`);
    }
    const texts = whole.map((c) => fnIn(c.step, "assets_on_disk"));
    texts.forEach((t, i) => expect(t, `"${whole[i].step.name}" does not define assets_on_disk`).not.toBeNull());
    expect(new Set(texts).size, "the copies of assets_on_disk have drifted apart").toBe(1);
  });

  it("compares every pattern download byte for byte", () => {
    const patterned = CALLS.filter((c) => c.verb === "download" && patternsOf(c).length > 0);
    expect(patterned.flatMap(patternsOf)).toHaveLength(6);
    for (const c of patterned) {
      const later = commands(c.step).slice(commands(c.step).indexOf(c.text) + 1);
      for (const p of patternsOf(c)) {
        const cmp = new RegExp(`^cmp \\S+ ${escape(dirOf(c))}/${escape(p)}$`);
        expect(later.some((l) => cmp.test(l)), `${at(c)}: nothing compares ${p}`).toBe(true);
      }
    }
  });

  it("reads every uploaded file back off the release in the same job", () => {
    const uploads = CALLS.filter((c) => c.verb === "upload");
    expect(uploads.flatMap(uploadedFiles)).toHaveLength(6);
    for (const c of uploads) {
      const job = steps(c.step.file).filter((s) => s.job === c.step.job);
      const after = job.slice(job.indexOf(c.step)).flatMap(commands);
      for (const f of uploadedFiles(c)) {
        const cmp = new RegExp(`^cmp ${escape(f)} uploaded/${escape(f.split("/").pop()!)}$`);
        expect(after.some((l) => cmp.test(l)), `${at(c)}: nothing reads ${f} back`).toBe(true);
      }
    }
  });
});

/* The stub answers each verb from its own list, one line per call, the last line repeating:
   `rc|stderr|action`. `partial` leaves half a file behind the way a dropped download does,
   `stdout` prints half an answer, `truncate` succeeds with a short file. The page is a
   directory, so an upload lands on it and a listing reads real sizes through real jq. */
const GH_STUB = `#!/usr/bin/env bash
set -u
printf '%s\\n' "$*" >> "$STUB/gh.log"
case "$1 $2" in
  "release download") kind=download ;;
  "release upload") kind=upload ;;
  "release view") kind=view ;;
  *) echo "gh stub: nothing models gh $*" >&2; exit 99 ;;
esac
n=$(( $(cat "$STUB/n.$kind") + 1 )); printf '%s\\n' "$n" > "$STUB/n.$kind"
line=$(sed -n "\${n}p" "$STUB/answers.$kind")
[ -n "$line" ] || line=$(tail -n 1 "$STUB/answers.$kind")
[ -n "$line" ] || line="0||"
rc=\${line%%|*}; rest=\${line#*|}; err=\${rest%%|*}; act=\${rest#*|}
shift 3
dir=""; jqf=""; pats=" "; files=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dir) dir=$2; shift 2 ;;
    --pattern) pats="$pats$2 "; shift 2 ;;
    --jq) jqf=$2; shift 2 ;;
    --repo|--json) shift 2 ;;
    --clobber) shift ;;
    *) files="$files $1"; shift ;;
  esac
done
first=""; for f in "$STUB"/page/*; do first=\${f##*/}; break; done
if [ "$rc" != 0 ]; then
  if [ "$act" = partial ] && [ -n "$dir" ]; then mkdir -p "$dir"; head -c 3 "$STUB/page/$first" > "$dir/$first"; fi
  if [ "$act" = stdout ]; then echo "HALF-AN-ANSWER"; fi
  printf '%s\\n' "$err" >&2
  exit "$rc"
fi
case "$kind" in
  download)
    mkdir -p "$dir"
    for f in "$STUB"/page/*; do
      [ -f "$f" ] || continue
      b=\${f##*/}
      if [ "$pats" != " " ]; then case "$pats" in *" $b "*) ;; *) continue ;; esac; fi
      cp "$f" "$dir/$b"
    done
    if [ "$act" = truncate ]; then head -c 3 "$STUB/page/$first" > "$dir/$first"; fi ;;
  upload)
    for f in $files; do cp "$f" "$STUB/page/\${f##*/}"; done ;;
  view)
    json='{"assets":['; sep=''
    for f in "$STUB"/page/*; do
      [ -f "$f" ] || continue
      json="$json$sep{\\"name\\":\\"\${f##*/}\\",\\"size\\":$(wc -c < "$f" | tr -d ' '),\\"state\\":\\"uploaded\\"}"; sep=','
    done
    json="$json]}"
    if [ -n "$jqf" ]; then printf '%s' "$json" | jq -r "$jqf"; else printf '%s\\n' "$json"; fi ;;
esac
exit 0
`;
const SLEEP_STUB = `#!/usr/bin/env bash\nprintf '%s\\n' "$1" >> "$STUB/sleep.log"\n`;

const INSTALLERS = {
  "ohmail-windows-setup.exe": "the windows installer's bytes\n",
  "ohmail.app.tar.gz": "the macos archive's bytes\n",
  "ohmail-linux-x86_64.AppImage": "the x86_64 appimage's bytes\n",
};
type World = { page?: Record<string, string>; workspace?: Record<string, string>; download?: string[]; upload?: string[]; view?: string[] };
type Ran = { code: number; out: string; err: string; gh: string[]; sleeps: string[]; dir: string };

function sh(script: string, world: World = {}): Ran {
  const dir = mkdtempSync(join(tmpdir(), "ohmail-gh-retry-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "gh"), GH_STUB);
  writeFileSync(join(bin, "sleep"), SLEEP_STUB);
  for (const f of ["gh", "sleep"]) chmodSync(join(bin, f), 0o755);
  mkdirSync(join(dir, "page"));
  for (const [n, b] of Object.entries(world.page ?? INSTALLERS)) writeFileSync(join(dir, "page", n), b);
  for (const [n, b] of Object.entries(world.workspace ?? {})) {
    mkdirSync(dirname(join(dir, n)), { recursive: true });
    writeFileSync(join(dir, n), b);
  }
  for (const k of ["download", "upload", "view"] as const) {
    writeFileSync(join(dir, `answers.${k}`), (world[k] ?? []).map((l) => `${l}\n`).join(""));
    writeFileSync(join(dir, `n.${k}`), "0\n");
  }
  writeFileSync(join(dir, "gh.log"), "");
  writeFileSync(join(dir, "sleep.log"), "");
  writeFileSync(join(dir, "step.sh"), script);
  // A curated environment: nothing the host's shell exports (a `grep` function among them) leaks in.
  const env = { PATH: `${bin}:/usr/bin:/bin`, HOME: dir, STUB: dir, LC_ALL: "C", GITHUB_REPOSITORY: "trafficflowhq/ohmail", GITHUB_REF_NAME: TAG };
  const p = spawnSync("bash", ["step.sh"], { cwd: dir, env, encoding: "utf8" });
  const lines = (f: string) => readFileSync(join(dir, f), "utf8").split("\n").filter(Boolean);
  return { code: p.status ?? -1, out: p.stdout ?? "", err: p.stderr ?? "", gh: lines("gh.log"), sleeps: lines("sleep.log"), dir };
}

const RETRY = () => fnOf("release-feeds.yml", PREPARE, "retry_on_transport");
const ON_DISK = () => fnOf("release-feeds.yml", PREPARE, "assets_on_disk");
const preamble = () => `set -euo pipefail\nREPO="$GITHUB_REPOSITORY"\nRELEASE_TAG=${TAG}\n${RETRY()}${ON_DISK()}`;
/** Calls the function as the steps do and prints its own rc, so `set -e` cannot hide it. */
const download = () =>
  `${preamble()}rc=0; retry_on_transport gh release download "$RELEASE_TAG" --repo "$REPO" --dir assets --clobber || rc=$?\necho "FN-RC=$rc"\n`;
const fnRc = (r: Ran) => /FN-RC=(\d+)/.exec(r.out)?.[1];
const DROPPED = "stream error: stream ID 1; PROTOCOL_ERROR; received from peer";

describe("retry_on_transport, run as the shell it is", () => {
  it("survives 0.23.1's dropped stream: one retry after 20 s, then the download completes", () => {
    const r = sh(download(), { download: [`1|${DROPPED}|partial`, "0||"] });
    expect(fnRc(r)).toBe("0");
    expect(r.gh.filter((l) => l.startsWith("release download"))).toHaveLength(2);
    expect(r.sleeps).toEqual(["20"]);
    expect(r.err, "the log does not say what happened on the first try").toContain(DROPPED);
    expect(r.err).toContain("try 1 of 3");
    expect(readFileSync(join(r.dir, "assets", "ohmail.app.tar.gz"), "utf8")).toBe(INSTALLERS["ohmail.app.tar.gz"]);
  });

  it("does not retry a 404, and hands back the command's own rc", () => {
    const r = sh(download(), { download: ["4|HTTP 404: Not Found (https://api.github.com/repos/trafficflowhq/ohmail/releases/tags/v9.9.9)|"] });
    expect(fnRc(r)).toBe("4");
    expect(r.gh).toHaveLength(1);
    expect(r.sleeps).toEqual([]);
  });

  it("gives up after three tries, 20 s then 40 s apart, when the transport never recovers", () => {
    const r = sh(download(), { download: ["1|HTTP 502: Bad Gateway (https://api.github.com/repos/trafficflowhq/ohmail/releases)|"] });
    expect(fnRc(r)).toBe("1");
    expect(r.gh).toHaveLength(3);
    expect(r.sleeps).toEqual(["20", "40"]);
    expect(r.err).toContain("transport failure on all 3 tries");
  });

  it.each([
    ["an HTTP/2 PROTOCOL_ERROR alone", "http2: server sent GOAWAY and closed the connection; ErrCode=PROTOCOL_ERROR"],
    ["a stream error alone", "stream error: stream ID 3; INTERNAL_ERROR; received from peer"],
    ["a reset connection", "read tcp 10.1.0.4:52110->140.82.112.6:443: read: connection reset by peer"],
    ["a bare EOF", 'Get "https://objects.githubusercontent.com/release-asset": EOF'],
    ["an unexpected EOF", "unexpected EOF"],
    ["a 502", "HTTP 502: Bad Gateway"],
    ["a 503", "HTTP 503: Service Unavailable"],
    ["a 504", "HTTP 504: Gateway Timeout"],
  ])("retries %s", (_what, message) => {
    const r = sh(download(), { download: [`1|${message}|`, "0||"] });
    expect(fnRc(r)).toBe("0");
    expect(r.gh).toHaveLength(2);
    expect(r.sleeps).toEqual(["20"]);
  });

  it.each([
    ["a 404", "HTTP 404: Not Found"],
    ["a refused token", "HTTP 401: Bad credentials"],
    ["a release that is not there", "release not found"],
    ["an asset that already exists", "HTTP 422: Validation Failed (already_exists)"],
    ["a 500", "HTTP 500: Internal Server Error"],
    ["a word that merely contains EOF", "GEOFENCED: this asset is not served here"],
    ["a word that merely starts with EOF", "EOFILE is not a word this matches"],
    ["a pattern nothing matches", "no assets match the file pattern"],
  ])("fails at once on %s", (_what, message) => {
    const r = sh(download(), { download: [`1|${message}|`] });
    expect(fnRc(r)).toBe("1");
    expect(r.gh).toHaveLength(1);
    expect(r.sleeps).toEqual([]);
    expect(r.err).toContain(message);
  });

  it("decides with a shell pattern, so macOS's BSD grep and Linux's GNU grep cannot read one stderr two ways", () => {
    /* The feeds job runs on macOS. The branch that decides a retry is bash's own `case`, read the
     * same by every grep there is; a control kept with the release kit is the reading of it on a
     * Mac. Every copy is one text, asserted above, so one read covers all. */
    const fn = RETRY();
    const code = fn.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
    expect(code, "the retry decision went back to a grep").not.toMatch(/\bgrep\b/);
    expect(fn).toContain('case " $line " in');
    expect(fn).toContain("*[![:alnum:]_]EOF[![:alnum:]_]*) shape=1 ;;");
  });

  it.each([
    ["with no newline at the end", "printf 'unexpected EOF' >&2"],
    ["on the second line of the output", "printf 'downloading ohmail.dmg\\nHTTP 503: Service Unavailable\\n' >&2"],
  ])("reads a transport shape %s", (_what, emit) => {
    const script = `${preamble()}fails() { printf 'x\\n' >> tries; ${emit}; return 1; }\nrc=0; retry_on_transport fails || rc=$?\necho "FN-RC=$rc TRIES=$(wc -l < tries | tr -d ' ')"\n`;
    const r = sh(script);
    expect(r.out).toContain("FN-RC=1 TRIES=3");
    expect(r.sleeps).toEqual(["20", "40"]);
  });

  it("passes on the answer of the try that succeeded, and nothing a dropped one printed", () => {
    // Inside `$( … )`, where `set -e` is not inherited: the function must return its own rc.
    const script = `${preamble()}NAMES="$(retry_on_transport gh release view "$RELEASE_TAG" --repo "$REPO" --json assets --jq '.assets[].name')"\nprintf 'NAMES<%s>\\n' "$NAMES"\n`;
    const r = sh(script, { view: ["1|HTTP 503: Service Unavailable|stdout", "0||"] });
    expect(r.code).toBe(0);
    expect(r.out).toContain("NAMES<ohmail-linux-x86_64.AppImage\nohmail-windows-setup.exe\nohmail.app.tar.gz>");
    expect(r.out).not.toContain("HALF-AN-ANSWER");
  });
});

describe("assets_on_disk: the verdict of a whole-release download", () => {
  const check = (setup: string) => `${preamble()}mkdir -p assets\n${setup}\nrc=0; assets_on_disk "$RELEASE_TAG" "$REPO" assets || rc=$?\necho "FN-RC=$rc"\n`;
  const copyAll = 'cp page/* assets/';

  it("admits every listed asset at the size the release states", () => {
    const r = sh(check(copyAll));
    expect(fnRc(r)).toBe("0");
    expect(r.out).toContain("3 assets on disk at the sizes v9.9.9 lists");
  });

  it("refuses a listed asset that is not on disk, by name", () => {
    const r = sh(check(`${copyAll}\nrm assets/ohmail.app.tar.gz`));
    expect(fnRc(r)).toBe("1");
    expect(r.err).toContain("ASSET-NOT-DOWNLOADED ohmail.app.tar.gz");
  });

  it("refuses an asset whose size is not the release's, by name", () => {
    const r = sh(check(`${copyAll}\nprintf 'short' > assets/ohmail-windows-setup.exe`));
    expect(fnRc(r)).toBe("1");
    expect(r.err).toContain("ASSET-SIZE-MISMATCH ohmail-windows-setup.exe");
  });

  it("refuses a release that lists nothing rather than finding nothing wrong", () => {
    const r = sh(check(""), { page: {} });
    expect(fnRc(r)).toBe("1");
    expect(r.err).toContain("lists no assets");
  });

  it("retries its own listing read on a dropped stream", () => {
    const r = sh(check(copyAll), { view: [`1|${DROPPED}|`, "0||"] });
    expect(fnRc(r)).toBe("0");
    expect(r.gh.filter((l) => l.startsWith("release view"))).toHaveLength(2);
  });
});

describe("the workflow's own transfer lines, run against the stub", () => {
  const wholeDownload = (name: string) =>
    slice(stepNamed("release-feeds.yml", name), (t) => t === "rm -rf assets && mkdir assets", (t) => t.startsWith('assets_on_disk "$RELEASE_TAG"'));

  it.each([PREPARE, FEEDS])("%s: a dropped stream is retried and the download is then checked", (name) => {
    const r = sh(`${preamble()}${wholeDownload(name)}echo WHOLE-DOWNLOAD-OK\n`, { download: [`1|${DROPPED}|partial`, "0||"] });
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain("WHOLE-DOWNLOAD-OK");
    expect(r.gh.filter((l) => l.startsWith("release download"))).toHaveLength(2);
  });

  it.each([PREPARE, FEEDS])("%s: a download that answers 0 with a short file is refused", (name) => {
    const r = sh(`${preamble()}${wholeDownload(name)}echo WHOLE-DOWNLOAD-OK\n`, { download: ["0||truncate"] });
    expect(r.code).not.toBe(0);
    expect(r.out).not.toContain("WHOLE-DOWNLOAD-OK");
    expect(r.err).toContain("ASSET-SIZE-MISMATCH");
  });

  it.each([PREPARE, FEEDS])("%s: a 404 fails the step on the first try", (name) => {
    const r = sh(`${preamble()}${wholeDownload(name)}echo WHOLE-DOWNLOAD-OK\n`, { download: ["1|HTTP 404: Not Found|"] });
    expect(r.code).not.toBe(0);
    expect(r.gh).toHaveLength(1);
  });

  it("the feeds upload survives a reset connection and is read back off the page", () => {
    const tail = slice(
      stepNamed("release-feeds.yml", FEEDS),
      (t) => t.startsWith('retry_on_transport gh release upload "$RELEASE_TAG"'),
      (t) => t.includes("the attached feeds and checksums are byte-identical to the verified ones"),
    );
    const workspace = { "latest.json": '{"version":"9.9.9"}\n', "appcast-macos.xml": "<rss/>\n", SHA256SUMS: "abc  x\n" };
    const r = sh(`${preamble()}${tail}`, { workspace, upload: ["1|read tcp 10.1.0.4:443: read: connection reset by peer|", "0||"] });
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain("byte-identical to the verified ones");
    for (const f of Object.keys(workspace)) expect(existsSync(join(r.dir, "feeds-state", "attached", f)), f).toBe(true);
  });

  const ANDROID = { "ohmail-android.apk": "apk bytes\n", "ohmail-android.aab": "aab bytes\n", "mapping/ohmail-android-mapping.txt.gz": "mapping bytes\n" };
  const onPage = Object.fromEntries(Object.entries(ANDROID).map(([n, b]) => [n.split("/").pop()!, b]));

  it("the android uploads survive a 502 on the APK and keep their order", () => {
    const st = stepNamed("android.yml", ATTACH);
    const uploads = slice(st, (t) => t.startsWith('retry_on_transport gh release upload "$TAG"'), (t) => t === "ohmail-android.aab");
    const r = sh(`${preamble()}TAG=${TAG}\n${fnOf("android.yml", ATTACH, "retry_on_transport")}${uploads}`, {
      page: {},
      workspace: ANDROID,
      upload: ["0||", "1|HTTP 502: Bad Gateway|", "0||", "0||"],
    });
    expect(r.code, r.err).toBe(0);
    expect(r.gh.map((l) => l.split(" ").pop())).toEqual([
      "mapping/ohmail-android-mapping.txt.gz",
      "ohmail-android.apk",
      "ohmail-android.apk",
      "ohmail-android.aab",
    ]);
    expect(readdirSync(join(r.dir, "page")).sort()).toEqual(Object.keys(onPage).sort());
  });

  it("the android read-back survives a dropped stream and still compares all three", () => {
    const r = sh(runBody(stepNamed("android.yml", READBACK)), { page: onPage, workspace: ANDROID, download: [`1|${DROPPED}|partial`, "0||"] });
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain("release APK verified byte-for-byte");
    expect(r.out).toContain("release App Bundle verified byte-for-byte");
    expect(r.out).toContain("release mapping verified byte-for-byte");
  });
});
