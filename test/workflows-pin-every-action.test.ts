import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { KEY_RING_V1 } from "./support/key-ring-env.js";
import { publicPath } from "./support/public-root.mjs";
import { evalIf } from "./support/workflow-if.js";

/**
 * EVERY ACTION A PUBLIC WORKFLOW RUNS IS PINNED TO A COMMIT, AND THE SET IS WRITTEN DOWN HERE.
 *
 * A version tag is a pointer its owner can move; a 40-hex commit is the code that was read. Once
 * the repository requires pinned actions, a tag-pinned line is a job that fails at setup. CENSUS
 * is the whole action set by file, so adding an action or moving a pin changes this file too.
 */
const HERE = fileURLToPath(new URL(".", import.meta.url));
const DIR = publicPath("github/workflows");
const SCRIPTS = publicPath("github/scripts");
const yaml = createRequire(import.meta.url)("js-yaml") as { load(text: string): unknown };

/** Each workflow's distinct `uses:`, as written: the commit its version tag named when it was pinned. */
const CENSUS: Record<string, string[]> = {
  "android.yml": [
    "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7",
    "actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093 # v4",
    "actions/setup-java@cf277c60eb25467037889841efdb72551f06f6c3 # v4",
    "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7",
    "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4",
  ],
  "build.yml": [
    "actions/cache@0057852bfaa89a56745cba8c7296529d2fc39830 # v4",
    "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7",
    "actions/download-artifact@37930b1c2abaa49bbe596cd826c3c89aef350131 # v7",
    "actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7",
    "actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9 # v7",
  ],
  "ci.yml": [
    "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7",
    "actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7",
    "actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9 # v7",
  ],
  "contributor.yml": [
    "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7",
    "actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7",
  ],
  "dco.yml": ["actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4"],
  "ghcr-images.yml": [
    "actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4",
    "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4",
    "docker/build-push-action@10e90e3645eae34f1e60eeb005ba3a3d33f178e8 # v6",
    "docker/login-action@c94ce9fb468520275223c153574b00df6fe4bcc9 # v3",
    "docker/setup-buildx-action@8d2750c68a42422c14e847fe6c8ac0403b4cbd6f # v3",
  ],
  "guard.yml": ["actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4"],
  "release-feeds.yml": [
    "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7",
    "actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093 # v4",
    "actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7",
    "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4",
  ],
  "selfhost-smoke.yml": [
    "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7",
    "actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7",
  ],
};

/** A `uses:` KEY, whatever its value. A comment that mentions `uses:` is not one. */
const KEY = /^\s*(?:-\s+)?uses\s*:/;
/** The one shape admitted: a full commit, then the version tag it was read from. */
const PIN = /^\s*(?:- )?uses: ([\w.-]+\/[\w.-]+(?:\/[\w.-]+)*@[0-9a-f]{40}) # (v\d+(?:\.\d+)*)$/;

/** Every `uses:` value the YAML parser reads: each step's action and each reusable-workflow call. */
function parsedUses(text: string): string[] {
  const wf = yaml.load(text) as { jobs?: Record<string, { uses?: unknown; steps?: Array<{ uses?: unknown }> }> };
  const out: string[] = [];
  for (const job of Object.values(wf?.jobs ?? {})) {
    if (job?.uses !== undefined) out.push(String(job.uses));
    for (const step of job?.steps ?? []) if (step?.uses !== undefined) out.push(String(step.uses));
  }
  return out.sort();
}

/** What refuses in one workflow: a key line off the pinned shape, or a value only the parser saw. */
function pinFindings(text: string): string[] {
  const keys = text.split("\n").filter((l) => KEY.test(l));
  const out = keys.filter((l) => !PIN.test(l)).map((l) => `not pinned: ${l.trim()}`);
  const read = keys.map((l) => PIN.exec(l)?.[1] ?? l.replace(KEY, "").replace(/\s#.*$/, "").trim()).sort();
  const parsed = parsedUses(text);
  if (JSON.stringify(parsed) !== JSON.stringify(read)) {
    out.push(`the parser reads ${parsed.length} uses: (${parsed.join(", ")}), the line reader ${read.length}`);
  }
  return out;
}

/** One workflow's pinned set, spelled as the census spells it. */
function actionSet(text: string): string[] {
  const pins = text.split("\n").map((l) => PIN.exec(l)).filter((m): m is RegExpExecArray => m !== null);
  return [...new Set(pins.map((m) => `${m[1]} # ${m[2]}`))].sort();
}

const FILES = readdirSync(DIR).filter((f) => /\.ya?ml$/.test(f)).sort();
const read = (f: string) => readFileSync(`${DIR}/${f}`, "utf8");

describe("every action a public workflow runs is pinned to a commit", () => {
  it("the census names every workflow in the directory, and only those", () => {
    expect(FILES.length, "the reader found no workflow at all").toBeGreaterThan(0);
    expect(FILES, "a workflow was added or removed without its census rows").toEqual(Object.keys(CENSUS).sort());
  });

  it.each(FILES)("%s: every uses: is a 40-hex commit with its version tag beside it", (f) => {
    expect(parsedUses(read(f)).length, "the parser read no uses: in this workflow").toBeGreaterThan(0);
    expect(pinFindings(read(f)), "an action is not pinned to a commit with its tag beside it").toEqual([]);
  });

  it.each(FILES)("%s: its action set is the census's", (f) => {
    expect(actionSet(read(f)), "an action was added, or a pin moved, without the census").toEqual([...(CENSUS[f] ?? [])].sort());
  });

  it("refuses a planted tag, a branch, a short or label-less commit, and a value only the parser sees", () => {
    const pinned = "jobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7\n";
    expect(pinFindings(pinned), "the positive control").toEqual([]);
    for (const planted of [
      "actions/checkout@v7",
      "actions/checkout@main",
      "actions/checkout@3d3c42e5aac5",
      "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
    ]) {
      expect(pinFindings(`${pinned}      - uses: ${planted}\n`), planted).toEqual([`not pinned: - uses: ${planted}`]);
    }
    const flow = pinFindings(`${pinned}      - { uses: actions/checkout@v7 }\n`);
    expect(flow.join("\n"), "a flow mapping hides a uses: from the line reader").toMatch(/the parser reads 2 uses: .*, the line reader 1$/);
  });
});

/**
 * AND NO STEP RUNS BYTES IT DOWNLOADED BEFORE A COMMITTED SHA-256 HAS REFUSED A WRONG ONE.
 *
 * A pinned action can still fetch moving bytes: setup-crane installed crane's latest release,
 * unchecked, beside a packages: write token. A curl or wget piped (or handed through `$(…)` or
 * `<(…)`) into an extractor or interpreter refuses outright. One written to a file that a later
 * command runs, unpacks or makes executable needs, after the fetch and before that use, a check
 * against a 64-hex constant written in the workflow that ends `|| { …; exit N; }`: either
 * `echo "$SUM  <file>" | sha256sum -c -`, or `GOT=$(sha256sum <file> …)` then `test "$GOT" = "$SUM"`.
 */
type Step = { name?: unknown; run?: unknown; env?: Record<string, unknown>; if?: unknown; "continue-on-error"?: unknown };
type Job = { env?: Record<string, unknown>; steps?: Step[]; services?: Record<string, { image?: unknown } | null>; container?: unknown };
/** A step's run: block; `cond` when an `if:` can skip the step, `soft` when its failure does not stop the job. */
type Unit = { label: string; run: string; consts: Set<string>; env: Map<string, string>; cond: boolean; soft: boolean };
/** A logical line, with its step (`unit`), its nesting inside if/case/loops/braces, and whether a heredoc holds it. */
type Line = { label: string; text: string; consts: Set<string>; unit: number; depth: number; doc: boolean };
type Simple = { words: string[]; raw: string; next: string; parent: string[] };
type Downloads = { findings: string[]; verified: string[]; data: string[] };

const SUM = /^[0-9a-f]{64}$/;
/** Commands that run, unpack or install what they are handed. */
const RUNS = new Set(["tar", "bsdtar", "unzip", "gunzip", "gzip", "zcat", "xz", "unxz", "bzip2", "zstd", "7z", "cpio",
  "sh", "bash", "zsh", "dash", "ksh", "fish", "source", ".", "eval", "python", "python3", "perl", "ruby", "node", "deno",
  "bun", "php", "pwsh", "java", "dpkg", "rpm", "apt", "apt-get", "install", "chmod"]);
/** What a download may be piped into and stay data. */
const READS = new Set(["jq", "grep", "head", "tail", "sed", "awk", "cut", "tr", "sort", "uniq", "wc", "cat", "base64", "xxd", "od", "cmp", "diff"]);
const EXE_NAME = /\.(?:tar|tar\.gz|tgz|tar\.xz|txz|tar\.bz2|tbz2?|tar\.zst|zip|7z|jar|war|sh|bash|run|bin|py|pl|rb|exe|msi|dmg|pkg|deb|rpm|apk|appimage|whl|gem|nupkg|vsix|so|dylib|dll|ps1|bat|cmd)$/i;
const LEAD = new Set(["if", "then", "else", "elif", "do", "while", "until", "!", "{", "(", "time", "command", "builtin", "exec"]);
const WRAP = /^(?:sudo|env|nohup|nice|stdbuf|xargs|timeout|retry\w*)$/;
/** Commands that put a file under a second name: the new name is the download too. */
const MOVES = new Set(["mv", "cp", "ln"]);
/** Fetchers this census does not follow, as commands: whatever they fetch is refused, data or not. */
const OTHER_FETCHERS = /^(?:aria2c|axel|wget2|http|https|xh|lwp-download|lwp-request|invoke-webrequest|iwr|invoke-restmethod|irm|start-bitstransfer)$/i;
/** The same inside a script a step runs inline: Python, Node, .NET, Ruby, Perl, and a remote module run directly. */
const OTHER_FETCH_TEXT = new RegExp([
  String.raw`\burllib[23]?\b`, String.raw`\burl(?:retrieve|open)\s*\(`, String.raw`\brequests\.(?:get|post|put|request|Session)\b`,
  String.raw`\bimport\s+requests\b`, String.raw`\bhttpx\.`, String.raw`\bfetch\s*\(\s*[^)\s]`, String.raw`\bhttps?\.(?:get|request)\s*\(`,
  String.raw`\brequire\(\s*["'](?:node:)?https?["']\s*\)`, String.raw`\bfrom\s+["'](?:node:)?https?["']`, String.raw`\bundici\b`,
  String.raw`\baxios\b`, String.raw`\bNet\.WebClient\b`, String.raw`\.Download(?:File|String|Data)(?:Async)?\s*\(`, String.raw`\bopen-uri\b`,
  String.raw`\bNet::HTTP\b`, String.raw`\bLWP::`, String.raw`\bHTTP::Tiny\b`, String.raw`\b(?:deno|bun)\s+run\s+["']?https?:\/\/`,
].join("|"));

/** A word as the census compares it: quotes dropped, `${X}` as `$X`, no leading `./`. */
const bare = (w = "") => w.replace(/["']/g, "").replace(/\$\{(\w+)\}/g, "$$$1").replace(/^\.\//, "");
const base = (w = "") => bare(w).replace(/^.*\//, "");
const words = (s: string): string[] => s.match(/(?:[^\s"']+|"(?:\\.|[^"\\])*"|'[^']*')+/g) ?? [];

/** The words from the command name on: keywords, `VAR=value` prefixes and wrappers like sudo skipped. */
function commandOf(ws: string[]): string[] {
  let i = 0;
  while (i < ws.length) {
    const w = ws[i];
    if (LEAD.has(w) || /^[A-Za-z_]\w*=/.test(w)) { i += 1; continue; }
    if (!WRAP.test(w)) break;
    i += 1;
    while (i < ws.length && (/^-/.test(ws[i]) || /^[A-Za-z_]\w*=/.test(ws[i]))) i += 1;
    if (w === "timeout") i += 1;
  }
  return ws.slice(i);
}

/** A run: block as bash reads it: comments dropped line by line, then continuations joined. */
function logicalLines(run: string): string[] {
  const strip = (l: string): string => {
    let q = "";
    for (let i = 0; i < l.length; i += 1) {
      const c = l[i];
      if (q) { if (c === "\\" && q === '"') i += 1; else if (c === q) q = ""; continue; }
      if (c === "'" || c === '"') q = c;
      else if (c === "\\") i += 1;
      else if (c === "#" && (i === 0 || /\s/.test(l[i - 1]))) return l.slice(0, i).trimEnd();
    }
    return l;
  };
  return run.split("\n").map(strip).join("\n").replace(/\\\n/g, " ").split("\n").filter((l) => l.trim() !== "");
}

/** A line's simple commands, each with the separator after it and, inside `$(…)`/`<(…)`, whom it feeds. */
function commands(line: string): Simple[] {
  const out: Simple[] = [];
  const stack: Array<{ buf: string; parent: string[]; q: string }> = [{ buf: "", parent: [], q: "" }];
  let q = "";
  const flush = (next: string) => {
    const top = stack[stack.length - 1];
    if (top.buf.trim()) out.push({ words: words(top.buf), raw: top.buf.trim(), next, parent: top.parent });
    top.buf = "";
  };
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    const two = line.slice(i, i + 2);
    const top = stack[stack.length - 1];
    if (q === "'") { top.buf += c; if (c === "'") q = ""; continue; }
    if (c === "\\") { top.buf += two; i += 1; continue; }
    if (two === "$(" || (!q && two === "<(")) { stack.push({ buf: "", parent: commandOf(words(top.buf)), q }); q = ""; i += 1; continue; }
    if (q === '"') { top.buf += c; if (c === '"') q = ""; continue; }
    if (c === "'" || c === '"') { q = c; top.buf += c; continue; }
    if (c === ")" && stack.length > 1) { flush(")"); q = stack.pop()?.q ?? ""; stack[stack.length - 1].buf += "SUB"; continue; }
    if (two === "||" || two === "&&") { flush(two); i += 1; continue; }
    if (c === "|" || c === ";" || (c === "&" && line[i - 1] !== ">" && line[i + 1] !== ">")) { flush(c); continue; }
    top.buf += c;
  }
  while (stack.length > 1) { flush(")"); stack.pop(); }
  flush("");
  return out;
}

/** The file a curl or wget writes ("" for stdout, "?" for a name only the server knows), and its URLs. */
function destination(cmd: string, args: string[]): { file: string; urls: string[] } {
  let file = "";
  let remote = cmd === "wget";
  let dir = "";
  const urls: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    const arg = () => args[(i += 1)] ?? "";
    if (/^(?:https?|ftp):\/\//.test(bare(a))) urls.push(bare(a));
    else if (/^[0-9]*>&|^2>/.test(a)) { if (a === "2>") i += 1; }
    else if (a === ">" || a === ">>" || a === "&>") { file = arg(); remote = false; }
    else if (/^(?:>>?|&>)./.test(a)) { file = a.replace(/^(?:>>?|&>)/, ""); remote = false; }
    else if (cmd === "curl" && (a === "-o" || a === "--output" || /^-[a-zA-Z]+o$/.test(a))) file = arg();
    else if (cmd === "curl" && a.startsWith("--output=")) file = a.slice(9);
    else if (cmd === "curl" && /^-o./.test(a)) file = a.slice(2);
    else if (cmd === "curl" && (a === "--remote-name" || a === "--remote-name-all" || /^-[a-zA-Z]*O[a-zA-Z]*$/.test(a))) remote = true;
    else if (cmd === "curl" && a === "--output-dir") dir = arg();
    else if (cmd === "wget" && (a === "-O" || a === "--output-document" || /^-[a-zA-Z]+O$/.test(a))) { file = arg(); remote = false; }
    else if (cmd === "wget" && a.startsWith("--output-document=")) { file = a.slice(18); remote = false; }
    else if (cmd === "wget" && /^-[a-zA-Z]*O./.test(a)) { file = a.replace(/^-[a-zA-Z]*O/, ""); remote = false; }
    else if (cmd === "wget" && (a === "-P" || a === "--directory-prefix")) dir = arg();
  }
  if (!file && remote) file = urls.length ? `${dir ? `${dir}/` : ""}${urls[0].replace(/[?#].*$/, "").replace(/^.*\//, "")}` : "?";
  return { file: bare(file), urls };
}

/**
 * The first line at or after the fetch (after its own command) that runs, unpacks or chmods the file, -1 if
 * none, and every name the file has had by then, each with the line it arrived on: `mv`, `cp` and `ln` give
 * it another name, a use of any name is a use, a bare command named like one is one (a file moved onto the
 * PATH), and so is a pipe from it into anything but a reader.
 */
function firstUse(lines: Line[], at: number, k: number, file: string): { use: number; born: Map<string, number> } {
  const born = new Map([[file, at]]);
  const named = (w: string) => born.has(bare(w).replace(/^</, ""));
  for (let i = at; i < lines.length; i += 1) {
    const cmds = commands(lines[i].text);
    for (let j = i === at ? k + 1 : 0; j < cmds.length; j += 1) {
      const cw = commandOf(cmds[j].words);
      if (!cw.length) continue;
      const args = cw.slice(1).filter((w) => !w.startsWith("-"));
      if (MOVES.has(base(cw[0])) && args.length >= 2 && args.slice(0, -1).some(named)) {
        const dest = bare(args[args.length - 1]).replace(/\/$/, "");
        for (const src of args.slice(0, -1).filter(named)) for (const n of [dest, `${dest}/${base(src)}`]) if (!born.has(n)) born.set(n, i);
        continue;
      }
      const name = bare(cw[0]);
      if (born.has(name) || (!name.includes("/") && [...born.keys()].some((n) => base(n) === name))) return { use: i, born };
      if (RUNS.has(base(cw[0])) && cw.slice(1).some(named)) return { use: i, born };
      if (cmds[j].next === "|" && cw.slice(1).some(named)) {
        for (let p = j + 1; p < cmds.length; p += 1) {
          if (!READS.has(base(commandOf(cmds[p].words)[0]))) return { use: i, born };
          if (cmds[p].next !== "|") break;
        }
      }
    }
  }
  return { use: -1, born };
}

/**
 * Each logical line's nesting: the if/case/loops/braces/functions open around it, and whether it is a
 * heredoc's body (text written somewhere, not a command this shell runs).
 */
function nesting(ls: string[]): Array<{ depth: number; doc: boolean }> {
  let depth = 0;
  let doc: string | null = null;
  return ls.map((l) => {
    if (doc !== null) { if (l.trim() === doc) doc = null; return { depth, doc: true }; }
    const at = depth;
    for (const s of commands(l)) {
      const w = s.words[0] ?? "";
      const last = s.words[s.words.length - 1] ?? "";
      if (/^(?:if|case|for|while|until|select|\{|\()$/.test(w) || (/^[\w-]+\(\)$/.test(w) && s.words.includes("{"))) depth += 1;
      if (/^(?:fi|esac|done|\}|\))$/.test(w) || (last === ")" && s.words.length > 1)) depth = Math.max(0, depth - 1);
    }
    doc = /(?<!<)<<(?!<)-?\s*(['"]?)([A-Za-z_]\w*)\1/.exec(l)?.[2] ?? null;
    return { depth: at, doc: false };
  });
}

/**
 * The line, strictly between the fetch and the first use, that checks a name the file holds there against a
 * committed sum and refuses — and only where nothing can skip it: a bare echo or printf opening its line (no
 * `!`, no subshell), at the top level of its step, outside a heredoc, in a step with no `if:` unless it is the
 * fetch's own, and with no continue-on-error unless it is the use's own.
 */
function checkOf(lines: Line[], units: Unit[], from: number, to: number, born: Map<string, number>): string | null {
  const refuses = (h: string) => /^\s*(?:\{(?:\$\{[^}]*\}|[^}])*?\bexit\s+[1-9]\d*\s*;?\s*\}|exit\s+[1-9]\d*)/.test(h);
  const sumIn = (t: string, consts: Set<string>) => /\b[0-9a-f]{64}\b/.test(t) || [...consts].some((c) => new RegExp(`\\$\\{?${c}\\b`).test(t));
  const holds = (w: string, i: number) => (born.get(w) ?? Infinity) <= i;
  let computed = "";
  for (let i = from + 1; i < to; i += 1) {
    const { text, consts, unit, depth, doc } = lines[i];
    const firm = depth === 0 && !doc && (unit === lines[from].unit || !units[unit].cond)
      && (!units[unit].soft || (to < lines.length && unit === lines[to].unit));
    const c = /^(.*)\|\s*sha256sum\s+([^|;&]*?)\s*\|\|(.*)$/.exec(text);
    const before = c ? commands(c[1]) : [];
    const feed = before.length === 1 ? before[0] : undefined;
    if (firm && c && feed && words(c[2]).every((w) => w.startsWith("-")) && words(c[2]).some((w) => w === "--check" || /^-[a-z]*c[a-z]*$/.test(w))
      && ["echo", "printf"].includes(feed.words[0] ?? "") && bare(feed.raw).split(/\s+/).some((w) => holds(w, i))
      && sumIn(feed.raw, consts) && refuses(c[3])) {
      return text.trim();
    }
    const a = /\b([A-Za-z_]\w*)=\$\(\s*(?:sha256sum|shasum\s+-a\s*256)\s+(?:-\S+\s+)*("[^"]*"|'[^']*'|[^\s|)]+)/.exec(text);
    if (a && holds(bare(a[2]), i)) computed = a[1];
    const t = /^\s*(?:test|\[\[?)\s+(.*?)\s*(?:\]\]?)?\s*\|\|(.*)$/.exec(text);
    if (firm && computed && t && new RegExp(`\\$\\{?${computed}\\b`).test(t[1]) && /\s==?\s/.test(t[1]) && sumIn(t[1], consts) && refuses(t[2])) return text.trim();
  }
  return null;
}

/** Every fetch in the jobs given (each a list of run: units in step order), classified. */
function downloads(jobs: Unit[][]): Downloads {
  const res: Downloads = { findings: [], verified: [], data: [] };
  const assigns = /(?:^|[\s;&|(])(?:export\s+|readonly\s+|local\s+)?([A-Za-z_]\w*)=(\S*)/g;
  for (const units of jobs) {
    const lines: Line[] = units.flatMap((u, unit) => {
      const ls = logicalLines(u.run);
      const consts = new Set(u.consts);
      for (const l of ls) for (const m of l.matchAll(assigns)) if (SUM.test(bare(m[2]))) consts.add(m[1]);
      for (const l of ls) for (const m of l.matchAll(assigns)) if (!SUM.test(bare(m[2]))) consts.delete(m[1]);
      const nest = nesting(ls);
      return ls.map((text, i) => ({ label: u.label, text, consts, unit, depth: nest[i].depth, doc: nest[i].doc }));
    });
    lines.forEach((ln, at) => {
      const cmds = commands(ln.text);
      if (OTHER_FETCH_TEXT.test(ln.text)) res.findings.push(`${ln.label}: ${ln.text.trim().slice(0, 110)} — a fetch this census does not follow: fetch with curl -o and check a committed SHA-256`);
      cmds.forEach((s, k) => {
        const cw = commandOf(s.words);
        const tool = base(cw[0]).replace(/\.exe$/i, "");
        const where = `${ln.label}: ${s.raw.slice(0, 110)}`;
        if (OTHER_FETCHERS.test(tool)) { res.findings.push(`${where} — fetched by ${tool}, which this census does not follow: fetch with curl -o and check a committed SHA-256`); return; }
        const cmd = tool.toLowerCase();
        if (cmd !== "curl" && cmd !== "wget") return;
        if (s.parent.length && RUNS.has(base(s.parent[0]))) { res.findings.push(`${where} — handed to ${base(s.parent[0])} before any check can read it`); return; }
        if (s.next === "|") {
          const piped: string[] = [];
          for (let j = k + 1; j < cmds.length; j += 1) { piped.push(base(commandOf(cmds[j].words)[0])); if (cmds[j].next !== "|") break; }
          const into = piped.find((p) => !READS.has(p));
          if (into !== undefined) res.findings.push(`${where} — piped into ${into}: those bytes run before any check can read them`);
          else res.data.push(where);
          return;
        }
        const { file, urls } = destination(cmd, cw.slice(1));
        if (file === "/dev/null") return;
        if (file === "" || file === "-") { res.data.push(where); return; }
        if (file === "?") { res.findings.push(`${where} — writes a file whose name this census cannot read: name it with -o or -O`); return; }
        const { use, born } = firstUse(lines, at, k, file);
        if (!(EXE_NAME.test(file) || urls.some((u) => EXE_NAME.test(u.replace(/[?#].*$/, ""))) || use >= 0)) { res.data.push(where); return; }
        const check = use === at ? null : checkOf(lines, units, at, use >= 0 ? use : lines.length, born);
        if (check) res.verified.push(`${where} — ${file} checked by: ${check}`);
        else res.findings.push(`${where} — ${file} is run, unpacked or made executable${use >= 0 ? ` (${lines[use].text.trim().slice(0, 80)})` : ""} with no committed SHA-256 refusing a wrong one first`);
      });
    });
  }
  return res;
}

/** A workflow's jobs as census units: each step's run: with the 64-hex env constants it can read, its env, `if:` and continue-on-error. */
function workflowUnits(text: string): Unit[][] {
  const wf = yaml.load(text) as { env?: Record<string, unknown>; jobs?: Record<string, Job> };
  const sums = (env?: Record<string, unknown>) => Object.entries(env ?? {}).filter(([, v]) => typeof v === "string" && SUM.test(v)).map(([k]) => k);
  const strings = (...envs: Array<Record<string, unknown> | undefined>) =>
    new Map(envs.flatMap((e) => Object.entries(e ?? {})).filter((kv): kv is [string, string] => typeof kv[1] === "string"));
  return Object.entries(wf?.jobs ?? {}).map(([id, job]) => (job?.steps ?? []).flatMap((s, n) => (typeof s?.run === "string"
    ? [{
      label: `${id} / ${typeof s.name === "string" ? s.name : `step ${n + 1}`}`, run: s.run,
      consts: new Set([...sums(wf?.env), ...sums(job?.env), ...sums(s.env)]), env: strings(wf?.env, job?.env, s.env),
      cond: s.if !== undefined, soft: s["continue-on-error"] !== undefined && s["continue-on-error"] !== false,
    }]
    : [])));
}

const SCRIPT_FILES = readdirSync(SCRIPTS).filter((f) => f.endsWith(".sh")).sort();
const scriptUnits = (label: string, run: string): Unit[][] => [[{ label, run, consts: new Set<string>(), env: new Map(), cond: false, soft: false }]];
const HEX = "a".repeat(64);
/** A one-step workflow around a run: block, with the step's env: when given. */
const wrap = (run: string, env: Record<string, string> = {}) => [
  "jobs:", "  j:", "    runs-on: ubuntu-latest", "    steps:", "      - name: planted",
  ...(Object.keys(env).length ? ["        env:", ...Object.entries(env).map(([k, v]) => `          ${k}: ${v}`)] : []),
  "        run: |", ...run.split("\n").map((l) => `          ${l}`), "",
].join("\n");

describe("no step runs bytes it downloaded before a committed SHA-256 refuses a wrong one", () => {
  it.each(FILES)("%s: every executable a step downloads is checked before its first use", (f) => {
    expect(downloads(workflowUnits(read(f))).findings, "a download runs, unpacks or pipes unchecked bytes").toEqual([]);
  });

  it.each(SCRIPT_FILES)("scripts/%s: every executable it downloads is checked before its first use", (f) => {
    expect(downloads(scriptUnits(`scripts/${f}`, readFileSync(`${SCRIPTS}/${f}`, "utf8"))).findings).toEqual([]);
  });

  it("reads the two checked downloads the workflows hold, and the feeds' read-backs as data", () => {
    const all = FILES.map((f) => ({ f, d: downloads(workflowUnits(read(f))) }));
    const verified = all.flatMap(({ f, d }) => d.verified.map((v) => `${f}: ${v}`)).join("\n");
    expect(verified.split("\n"), "the positive control: bundletool and crane are seen, each checked").toHaveLength(2);
    expect(verified).toMatch(/^android\.yml: .*\$RUNNER_TEMP\/bundletool\.jar checked by: test "\$GOT" = "\$BT_SHA256"/m);
    expect(verified).toMatch(/^ghcr-images\.yml: .*\$RUNNER_TEMP\/crane\.tar\.gz checked by: echo .*\| sha256sum -c/m);
    expect(all.find(({ f }) => f === "release-feeds.yml")?.d.data.length ?? 0, "the feeds' read-backs").toBeGreaterThanOrEqual(2);
  });

  it("refuses a planted unverified fetch in every shape it names, and admits the same fetch checked", () => {
    const t = "https://example.com/tool";
    const tgz = `curl -sSfL -o "$RUNNER_TEMP/t.tar.gz" ${t}.tar.gz`;
    const check = (f: string, h = "{ echo bad >&2; exit 1; }") => `echo "$T_SHA256  $RUNNER_TEMP/${f}" | sha256sum -c - || ${h}`;
    const unpack = `tar -xzf "$RUNNER_TEMP/t.tar.gz" -C "$RUNNER_TEMP"`;
    const planted: Array<[string, string, Record<string, string>]> = [
      ["piped to tar", `curl -fsSL ${t}.tar.gz | tar -xz -C "$RUNNER_TEMP"`, {}],
      ["piped to bash", `curl -fsSL ${t}.sh | bash`, {}],
      ["wget piped to sh", `wget -qO- ${t}.sh | sh`, {}],
      ["piped to sudo bash", `curl -fsSL ${t}.sh | sudo bash -s -- --yes`, {}],
      ["a process substitution", `bash <(curl -fsSL ${t}.sh)`, {}],
      ["a command substitution", `sh -c "$(curl -fsSL ${t}.sh)"`, {}],
      ["a file later run", `curl -fsSL -o "$RUNNER_TEMP/tool" ${t}\nchmod +x "$RUNNER_TEMP/tool"\n"$RUNNER_TEMP/tool" --version`, {}],
      ["an archive unpacked unchecked", `${tgz}\n${unpack}`, {}],
      ["a sum downloaded beside it", `${tgz}\nT_SHA256=$(curl -fsSL ${t}.sha256)\n${check("t.tar.gz")}\n${unpack}`, {}],
      ["a check after the unpack", `${tgz}\n${unpack}\n${check("t.tar.gz")}`, { T_SHA256: HEX }],
      ["a check that does not refuse", `${tgz}\n${check("t.tar.gz", "true")}\n${unpack}`, { T_SHA256: HEX }],
      ["a sum from an expression", `${tgz}\n${check("t.tar.gz")}\n${unpack}`, { T_SHA256: "${{ inputs.sum }}" }],
      ["a check of another file", `${tgz}\n${check("other.tar.gz")}\n${unpack}`, { T_SHA256: HEX }],
    ];
    for (const [what, run, env] of planted) expect(downloads(workflowUnits(wrap(run, env))).findings, what).toHaveLength(1);
    const checked = downloads(workflowUnits(wrap(`${tgz}\n${check("t.tar.gz")}\n${unpack}`, { T_SHA256: HEX })));
    expect(checked, "the positive control: the same fetch, checked first").toEqual({ findings: [], verified: [expect.any(String)], data: [] });
    const data = downloads(workflowUnits(wrap(`curl -fsSL -o feeds/latest.json "$BASE/latest.json"\njq -r .version feeds/latest.json\nsudo apt-get install -y curl wget`)));
    expect(data, "a download only jq reads, and curl as a package name").toEqual({ findings: [], verified: [], data: [expect.stringContaining("feeds/latest.json")] });
  });

  it("refuses ghcr-images.yml's crane step with its check taken out, and a planted script", () => {
    const real = read("ghcr-images.yml");
    const unchecked = real.replace(/^.*\| sha256sum -c .*\n.*\n/m, "");
    expect(unchecked, "the plant took the check out").not.toBe(real);
    expect(downloads(workflowUnits(unchecked)).findings.join("\n")).toMatch(/\$RUNNER_TEMP\/crane\.tar\.gz is run, unpacked or made executable \(tar -xzf/);
    expect(downloads(scriptUnits("scripts/planted.sh", "#!/usr/bin/env bash\nset -euo pipefail\ncurl -fsSL https://example.com/i.sh | bash\n")).findings).toHaveLength(1);
  });

  it("follows a download under every name it is given, and refuses one run under a name its check never read", () => {
    const fetch = `curl -fsSL -o "$RUNNER_TEMP/tool" https://example.com/tool`;
    const check = (f: string) => `echo "$T_SHA256  ${f}" | sha256sum -c - || { echo bad >&2; exit 1; }`;
    const planted: Array<[string, string]> = [
      ["moved, then run by its new path", `${fetch}\nmv "$RUNNER_TEMP/tool" "$RUNNER_TEMP/bin/tool"\n"$RUNNER_TEMP/bin/tool" --version`],
      ["copied into a directory, then run", `${fetch}\ncp "$RUNNER_TEMP/tool" "$RUNNER_TEMP/bin/"\n"$RUNNER_TEMP/bin/tool" --version`],
      ["linked, then run", `${fetch}\nln -sf "$RUNNER_TEMP/tool" "$RUNNER_TEMP/t2"\n"$RUNNER_TEMP/t2" --version`],
      ["moved onto the PATH, then run by its name", `${fetch}\nsudo mv "$RUNNER_TEMP/tool" /usr/local/bin/tool\ntool --version`],
      ["fed to an interpreter through a pipe", `${fetch}\ncat "$RUNNER_TEMP/tool" | bash`],
      ["checked under a name it did not hold yet", `${fetch}\n${check('"$RUNNER_TEMP/bin/tool"')}\nmv "$RUNNER_TEMP/tool" "$RUNNER_TEMP/bin/tool"\n"$RUNNER_TEMP/bin/tool"`],
    ];
    for (const [what, run] of planted) expect(downloads(workflowUnits(wrap(run, { T_SHA256: HEX }))).findings, what).toHaveLength(1);
    const admitted: Array<[string, string]> = [
      ["checked, then moved and run", `${fetch}\n${check('"$RUNNER_TEMP/tool"')}\nmv "$RUNNER_TEMP/tool" "$RUNNER_TEMP/bin/tool"\n"$RUNNER_TEMP/bin/tool"`],
      ["moved, then checked under its new name and run", `${fetch}\nmv "$RUNNER_TEMP/tool" "$RUNNER_TEMP/bin/tool"\n${check('"$RUNNER_TEMP/bin/tool"')}\n"$RUNNER_TEMP/bin/tool"`],
    ];
    for (const [what, run] of admitted) {
      expect(downloads(workflowUnits(wrap(run, { T_SHA256: HEX }))), what).toEqual({ findings: [], verified: [expect.any(String)], data: [] });
    }
  });

  it("refuses a fetch by a tool it does not follow, one plant per fetcher, and leaves a shell function named fetch alone", () => {
    const u = "https://example.com/tool";
    const planted: Array<[string, string]> = [
      ["Invoke-WebRequest", `Invoke-WebRequest -Uri ${u}.exe -OutFile tool.exe\n./tool.exe /S`],
      ["iwr", `iwr ${u}.ps1 -OutFile t.ps1\npwsh ./t.ps1`],
      ["aria2c", `aria2c -o tool.tar.gz ${u}.tar.gz\ntar -xzf tool.tar.gz`],
      ["python urllib", `python3 -c "import urllib.request; urllib.request.urlretrieve('${u}', 't.sh')"\nbash t.sh`],
      ["python requests", `python3 -c "import requests; open('t.sh', 'wb').write(requests.get('${u}').content)"\nbash t.sh`],
      ["node fetch", `node -e 'fetch(process.argv[1]).then((r) => r.text()).then(eval)' ${u}.js`],
    ];
    for (const [what, run] of planted) expect(downloads(workflowUnits(wrap(run))).findings, what).toHaveLength(1);
    const fn = downloads(workflowUnits(wrap(`fetch() {\n  curl -fsSL -o "$2" "$1"\n}\nfetch ${u}.json x.json\njq . x.json`)));
    expect(fn.findings, "the positive control: a bash function named fetch around curl").toEqual([]);
  });

  it("counts no check that can be skipped: in an if, a loop, a case, a function, a heredoc, behind another command, or a step that can be skipped or fail softly", () => {
    const tgz = `curl -sSfL -o "$RUNNER_TEMP/t.tar.gz" https://example.com/t.tar.gz`;
    const check = `echo "$T_SHA256  $RUNNER_TEMP/t.tar.gz" | sha256sum -c - || { echo bad >&2; exit 1; }`;
    const unpack = `tar -xzf "$RUNNER_TEMP/t.tar.gz" -C "$RUNNER_TEMP"`;
    const planted: Array<[string, string]> = [
      ["inside an if", `${tgz}\nif [ -n "\${VERIFY:-}" ]; then\n  ${check}\nfi\n${unpack}`],
      ["inside a one-line if", `${tgz}\nif [ -n "\${VERIFY:-}" ]; then ${check}; fi\n${unpack}`],
      ["behind another command on its line", `${tgz}\n[ -n "\${SKIP:-}" ] || ${check}\n${unpack}`],
      ["inside a loop", `${tgz}\nfor f in a; do\n  ${check}\ndone\n${unpack}`],
      ["inside a case arm", `${tgz}\ncase "\${MODE:-}" in\n  strict) ${check} ;;\nesac\n${unpack}`],
      ["inside a function nobody calls", `${tgz}\nverify() {\n  ${check}\n}\n${unpack}`],
      ["inside a heredoc", `${tgz}\ncat > /tmp/v.sh <<'EOF'\n${check}\nEOF\n${unpack}`],
      ["negated, so it refuses only a match", `${tgz}\n! ${check}\n${unpack}`],
      ["inside a subshell, whose exit leaves the step running", `${tgz}\n( ${check} )\n${unpack}`],
    ];
    for (const [what, run] of planted) expect(downloads(workflowUnits(wrap(run, { T_SHA256: HEX }))).findings, what).toHaveLength(1);
    /** Steps in one job, each `[run, extra keys]`, with the sum in the job's env. */
    const steps = (...s: Array<[string, string[]]>) => ["jobs:", "  j:", "    runs-on: ubuntu-latest", "    env:", `      T_SHA256: ${HEX}`, "    steps:",
      ...s.flatMap(([run, extra], i) => [`      - name: s${i + 1}`, ...extra.map((e) => `        ${e}`), "        run: |", ...run.split("\n").map((l) => `          ${l}`)]), ""].join("\n");
    expect(downloads(workflowUnits(steps([tgz, []], [check, ["if: inputs.verify"]], [unpack, []]))).findings, "a check in a step an if: can skip").toHaveLength(1);
    expect(downloads(workflowUnits(steps([tgz, []], [check, ["continue-on-error: true"]], [unpack, []]))).findings, "a check whose failure the job survives").toHaveLength(1);
    for (const [what, wf] of [
      ["the check in a step of its own", steps([tgz, []], [check, []], [unpack, []])],
      ["the fetch and its check skipped together", steps([`${tgz}\n${check}`, ["if: inputs.verify"]], [unpack, []])],
      ["a soft step that fails before its own use", steps([tgz, []], [`${check}\n${unpack}`, ["continue-on-error: true"]])],
    ] as Array<[string, string]>) expect(downloads(workflowUnits(wf)), what).toEqual({ findings: [], verified: [expect.any(String)], data: [] });
  });
});

/**
 * AND EVERY CONTAINER IMAGE A WORKFLOW RUNS IS NAMED BY ITS DIGEST, unless this repository built it.
 *
 * A tag can be pushed again; a digest cannot. Read from `docker run|create|pull` in run: blocks and the
 * published scripts (an image named through a variable resolved from the step's env, or refused), a job's
 * services and container, and `docker://` steps. ghcr.io/trafficflowhq/ is this repository's own: the images
 * a run builds and stages, and the third-party ones mirrored there by digest from images.lock.
 */
const OWN = /^ghcr\.io\/trafficflowhq\//;
/** The mirrored third-party images as images.lock names them: ghcr.io/trafficflowhq/<name>:<upstream tag>@<digest>. */
const LOCK = `${HERE}../deploy/selfhost/images.lock`;
const MIRRORED = new Set(readFileSync(LOCK, "utf8").split("\n").filter((l) => /^mirror-/.test(l)).map((l) => {
  const [name, upstream, digest] = l.split(/\s+/);
  return `ghcr.io/trafficflowhq/${name}:${upstream.slice(upstream.lastIndexOf(":") + 1)}@${digest}`;
}));
const MIRROR = /^ghcr\.io\/trafficflowhq\/mirror-/;
const BY_DIGEST = /^[^\s$@]+@sha256:[0-9a-f]{64}$/;
/** The docker run/create/pull options that take a value; the image is the first word after the options. */
const DOCKER_VALUE = new Set(["-a", "--attach", "--add-host", "--cap-add", "--cap-drop", "--cidfile", "--cpus", "-c", "--cpu-shares",
  "--device", "--dns", "--entrypoint", "-e", "--env", "--env-file", "--gpus", "--group-add", "--health-cmd", "-h", "--hostname", "--ipc",
  "-l", "--label", "--log-driver", "--log-opt", "-m", "--memory", "--mount", "--name", "--network", "--net", "--pid", "--platform", "-p",
  "--publish", "--pull", "--restart", "--security-opt", "--shm-size", "--stop-signal", "--tmpfs", "--ulimit", "-u", "--user", "-v",
  "--volume", "--volumes-from", "-w", "--workdir"]);
/** Image reads this census cannot follow by design, by file and command as written, each with its reason. */
const IMAGE_ALLOWED: Record<string, string> = {
  'ghcr-images.yml: docker pull -q "$REF"': "gate-boot pulls the compose's images, each asserted ghcr.io/trafficflowhq/* by the loop before it",
};
type Images = { findings: string[]; pinned: string[]; own: string[]; allowed: string[] };

/** Every image the units run, and the YAML-level ones when a workflow is given, classified. */
function images(file: string, units: Unit[][], wf?: { jobs?: Record<string, Job & { steps?: Array<{ uses?: unknown }> }> }): Images {
  const res: Images = { findings: [], pinned: [], own: [], allowed: [] };
  const judge = (where: string, ref: string) => {
    if (OWN.test(ref)) res.own.push(`${where} — ${ref}`);
    else if (BY_DIGEST.test(ref)) res.pinned.push(`${where} — ${ref}`);
    else res.findings.push(`${where} — ${ref || "no image"} is not named by a sha256 digest`);
  };
  for (const [id, job] of Object.entries(wf?.jobs ?? {})) {
    for (const [name, svc] of Object.entries(job?.services ?? {})) judge(`${file} ${id} / services.${name}`, String(svc?.image ?? ""));
    const c = job?.container;
    if (c !== undefined) judge(`${file} ${id} / container`, String(typeof c === "object" && c !== null ? (c as { image?: unknown }).image ?? "" : c));
    for (const s of job?.steps ?? []) if (String(s.uses ?? "").startsWith("docker://")) judge(`${file} ${id} / uses`, String(s.uses).slice(9));
  }
  for (const u of units.flat()) for (const line of logicalLines(u.run)) for (const s of commands(line)) {
    const cw = commandOf(s.words);
    if (base(cw[0]) !== "docker") continue;
    let i = cw[1] === "container" || cw[1] === "image" ? 2 : 1;
    if (!["run", "create", "pull"].includes(cw[i] ?? "")) continue;
    for (i += 1; i < cw.length && cw[i].startsWith("-"); i += DOCKER_VALUE.has(cw[i]) ? 2 : 1);
    const key = `${file}: ${cw.slice(0, i + 1).join(" ")}`;
    if (IMAGE_ALLOWED[key]) { res.allowed.push(key); continue; }
    const word = bare(cw[i] ?? "");
    const ref = word.replace(/\$(\w+)/g, (all, v: string) => u.env.get(v) ?? all);
    const where = `${file} ${u.label}: ${s.raw.slice(0, 90)}`;
    if (ref.includes("$") && !OWN.test(ref)) res.findings.push(`${where} — an image this census cannot read: ${word}`);
    else judge(where, ref);
  }
  return res;
}
const workflowImages = (f: string) => images(f, workflowUnits(read(f)), yaml.load(read(f)) as { jobs?: Record<string, Job> });

describe("every container image a workflow runs is named by its digest, unless this repository built it", () => {
  it.each(FILES)("%s: no image by tag", (f) => {
    expect(workflowImages(f).findings).toEqual([]);
  });

  it.each(SCRIPT_FILES)("scripts/%s: no image by tag", (f) => {
    expect(images(`scripts/${f}`, scriptUnits(`scripts/${f}`, readFileSync(`${SCRIPTS}/${f}`, "utf8"))).findings).toEqual([]);
  });

  it("reads the third-party images by digest, the mirrored and staged images as its own, and every allowed read in use", () => {
    const all = FILES.map(workflowImages);
    const imageOf = (entry: string) => entry.slice(entry.lastIndexOf(" — ") + 3);
    const pinned = [...new Set(all.flatMap((r) => r.pinned).map(imageOf))].sort();
    expect(pinned.map((i) => i.replace(/@sha256:[0-9a-f]{64}$/, "")), "the positive control: Dovecot, gitleaks, GreenMail and Fedora").toEqual([
      "dovecot/dovecot:2.3.21", "ghcr.io/gitleaks/gitleaks:v8.30.1", "greenmail/standalone:2.1.3", "registry.fedoraproject.org/fedora:42",
    ]);
    const own = all.flatMap((r) => r.own).map(imageOf);
    const mirrors = own.filter((i) => MIRROR.test(i));
    expect(mirrors.length, "the mirrored Postgres and RustFS the suite runs").toBeGreaterThan(0);
    expect(mirrors.filter((i) => !MIRRORED.has(i)), "a mirrored image images.lock does not name at that digest").toEqual([]);
    expect(MIRRORED.has(mirrors[0].replace(/[0-9a-f]{64}$/, "0".repeat(64))), "the control: another digest is not the locked one").toBe(false);
    expect(own.length - mirrors.length, "the prune check's three reads of the staged image").toBe(3);
    expect(all.flatMap((r) => r.allowed), "an allowed read no workflow makes is stale").toEqual(Object.keys(IMAGE_ALLOWED));
  });

  it("refuses a tag, an implicit latest, a variable, a service, a container and a docker:// step; admits a digest and its own", () => {
    const job = (body: string) => `jobs:\n  j:\n    runs-on: ubuntu-latest\n${body}`;
    const run = (r: string, env = "") => job(`    steps:\n      - name: s\n${env}        run: |\n          ${r}\n`);
    const of = (wf: string) => images("x.yml", workflowUnits(wf), yaml.load(wf) as { jobs?: Record<string, Job> });
    const planted: Array<[string, string]> = [
      ["a tag", run("docker run --rm node:22-bookworm-slim node --version")],
      ["a tag behind options", run('docker run -d --name x -p 1:1 -v "$PWD/a:/a:ro" dovecot/dovecot:2.3.21')],
      ["an implicit latest", run("docker pull alpine")],
      ["a variable the shell sets", run('IMG=alpine:3; docker run --rm "$IMG" true')],
      ["a variable the env sets to a tag", run('docker run --rm "$IMG" true', "        env:\n          IMG: alpine:3\n")],
      ["a service by tag", job("    services:\n      db:\n        image: postgres:16\n    steps:\n      - run: 'true'\n")],
      ["a container by tag", job("    container: node:22\n    steps:\n      - run: 'true'\n")],
      ["a docker:// step", job("    steps:\n      - uses: docker://alpine:3\n")],
    ];
    for (const [what, wf] of planted) expect(of(wf).findings, what).toHaveLength(1);
    const ok = of(run(`docker run --rm alpine@sha256:${HEX} true && docker run --rm ghcr.io/trafficflowhq/ohmail-server:stage-1 true`));
    expect([ok.findings, ok.pinned.length, ok.own.length], "the positive control: a digest, and this repository's own").toEqual([[], 1, 1]);
  });
});

/**
 * AND EVERY ACTION IS CLASSIFIED BY WHAT IT PULLS. A pinned action can still boot a moving tag: setup-buildx's
 * docker-container driver runs moby/buildkit:buildx-stable-1 unless told otherwise, and that daemon runs every
 * build step and pushes. Each action the census names is listed with the inputs that make it pull or install
 * something; a step is refused unless what it pulls is named by its digest, and an action no one has
 * classified is refused outright.
 */
type With = Record<string, unknown>;
const DIGESTED = /@sha256:[0-9a-f]{64}$/;
const ACTION_PULLS: Record<string, ((w: With) => string[]) | null> = {
  "actions/cache": null,
  "actions/checkout": null,
  "actions/download-artifact": null,
  "actions/setup-java": null,
  "actions/setup-node": null,
  "actions/upload-artifact": null,
  "docker/login-action": null,
  "docker/setup-buildx-action": (w) => {
    const out: string[] = [];
    const driver = String(w.driver ?? "docker-container");
    if (w.version !== undefined) out.push("version: installs buildx from its releases instead of the runner's own");
    if (w.append !== undefined) out.push("append: adds builder nodes whose images this census does not read");
    const image = /(?:^|[\s,])image=([^\s,]+)/.exec(String(w["driver-opts"] ?? ""))?.[1];
    if (!["docker", "remote"].includes(driver) && !(image && DIGESTED.test(image))) {
      out.push(`the ${driver} driver boots ${image ?? "moby/buildkit:buildx-stable-1"} by tag: set driver-opts image=<ref>@sha256:<digest>`);
    }
    return out;
  },
  "docker/setup-qemu-action": (w) => {
    const image = String(w.image ?? "docker.io/tonistiigi/binfmt:latest");
    return DIGESTED.test(image) ? [] : [`boots ${image} by tag: set image to <ref>@sha256:<digest>`];
  },
  "docker/build-push-action": (w) => {
    const out: string[] = [];
    const sbom = `${String(w.sbom ?? "")} ${String(w.attests ?? "")}`;
    if (/\btrue\b|type=sbom|generator=/.test(sbom) && !/generator=[^\s,]+@sha256:[0-9a-f]{64}/.test(sbom)) {
      out.push("an SBOM attestation runs its scanner image by tag: name generator=<ref>@sha256:<digest>");
    }
    const syntax = /(?:^|\s)BUILDKIT_SYNTAX=(\S+)/.exec(String(w["build-args"] ?? ""))?.[1];
    if (syntax && !DIGESTED.test(syntax)) out.push(`BUILDKIT_SYNTAX=${syntax} runs a frontend by tag`);
    return out;
  },
};

/** Every step's action in one workflow, judged by its row; an action with no row is a finding of its own. */
function actionFindings(file: string, text: string): string[] {
  const wf = yaml.load(text) as { jobs?: Record<string, { steps?: Array<{ uses?: unknown; with?: With }> }> };
  const out: string[] = [];
  for (const [id, job] of Object.entries(wf?.jobs ?? {})) {
    for (const s of job?.steps ?? []) {
      const action = /^([\w.-]+\/[\w.-]+)(?:\/[\w./-]+)?@/.exec(String(s?.uses ?? ""))?.[1];
      if (!action) continue;
      const rule = ACTION_PULLS[action];
      if (rule === undefined) out.push(`${file} ${id}: ${action} is not classified by what it pulls`);
      else if (rule) for (const f of rule(s.with ?? {})) out.push(`${file} ${id}: ${action} — ${f}`);
    }
  }
  return out;
}

describe("every action a workflow runs is classified by what it pulls, and pulls nothing by tag", () => {
  it.each(FILES)("%s: no action boots or installs anything by tag", (f) => {
    expect(actionFindings(f, read(f))).toEqual([]);
  });

  it("classifies every action the census names, and classifies none as pulling nothing that nobody runs", () => {
    const named = [...new Set(Object.values(CENSUS).flat().map((row) => row.replace(/@.*$/, "")))].sort();
    expect(named.filter((a) => !(a in ACTION_PULLS)), "an action with no row").toEqual([]);
    expect(Object.keys(ACTION_PULLS).filter((a) => ACTION_PULLS[a] === null && !named.includes(a)), "a stale pulls-nothing row").toEqual([]);
    const real = read("ghcr-images.yml");
    const bare = real.replace(/^( {6}- uses: docker\/setup-buildx-action@\S+ # v3)\n {8}with:\n {10}driver-opts: .*\n/m, "$1\n");
    expect(bare, "the plant took the driver option out").not.toBe(real);
    expect(actionFindings("ghcr-images.yml", bare).join("\n"), "the real step without its driver option boots the moving tag")
      .toMatch(/moby\/buildkit:buildx-stable-1 by tag/);
  });

  it("refuses each image an action pulls by default or by input without a digest, one plant each, and admits it by digest", () => {
    const step = (uses: string, withs: Record<string, string> = {}) => [
      "jobs:", "  j:", "    runs-on: ubuntu-latest", "    steps:", `      - uses: ${uses}@${"a".repeat(40)} # v1`,
      ...(Object.keys(withs).length ? ["        with:", ...Object.entries(withs).map(([k, v]) => `          ${k}: ${v}`)] : []), "",
    ].join("\n");
    const planted: Array<[string, string]> = [
      ["setup-buildx with no driver option", step("docker/setup-buildx-action")],
      ["setup-buildx with the daemon by tag", step("docker/setup-buildx-action", { "driver-opts": "image=moby/buildkit:v0.33.1" })],
      ["setup-buildx installing its own buildx", step("docker/setup-buildx-action", { driver: "docker", version: "latest" })],
      ["setup-buildx appending nodes", step("docker/setup-buildx-action", { driver: "docker", append: "'[{\"name\":\"n\"}]'" })],
      ["setup-qemu with its default image", step("docker/setup-qemu-action")],
      ["setup-qemu with an image by tag", step("docker/setup-qemu-action", { image: "tonistiigi/binfmt:qemu-v9" })],
      ["build-push with an SBOM", step("docker/build-push-action", { sbom: "true" })],
      ["build-push with a frontend by tag", step("docker/build-push-action", { "build-args": "BUILDKIT_SYNTAX=docker/dockerfile:1" })],
      ["an action nobody classified", step("somebody/new-action")],
    ];
    for (const [what, wf] of planted) expect(actionFindings("x.yml", wf), what).toHaveLength(1);
    const d = `@sha256:${HEX}`;
    for (const [what, wf] of [
      ["setup-buildx with the daemon by digest", step("docker/setup-buildx-action", { "driver-opts": `image=moby/buildkit:v0.33.1${d}` })],
      ["setup-buildx on the docker driver", step("docker/setup-buildx-action", { driver: "docker" })],
      ["setup-qemu with an image by digest", step("docker/setup-qemu-action", { image: `tonistiigi/binfmt${d}` })],
      ["build-push with an SBOM scanner by digest", step("docker/build-push-action", { sbom: `generator=docker/buildkit-syft-scanner${d}` })],
      ["build-push with a frontend by digest", step("docker/build-push-action", { "build-args": `BUILDKIT_SYNTAX=docker/dockerfile:1.27.1${d}` })],
    ] as Array<[string, string]>) expect(actionFindings("x.yml", wf), what).toEqual([]);
  });
});

/**
 * NO SECRET IN WHAT A PULL REQUEST ADDS. ci.yml's plan job refuses a path the BASE's ignore rules match,
 * then scans the added lines with gitleaks, by digest, once its control is found. The step runs here as
 * the runner runs it, over a pull request's merge commit, against a docker that answers as gitleaks does.
 */
describe("ci.yml's secret scan", () => {
  type Step = { uses?: string; if?: string; run?: string; env?: Record<string, string>; "continue-on-error"?: unknown };
  const plan = (yaml.load(read("ci.yml")) as { jobs: Record<string, { steps: Step[] }> }).jobs.plan!.steps;
  const scanAt = plan.findIndex((s) => /\bgitleaks\b/.test(s.run ?? ""));
  const step = plan[scanAt]!;

  it("runs on a pull request only, right after the checkout, never allowed to fail, its image named by digest", () => {
    expect([scanAt, plan[0]!.uses?.split("@")[0]]).toEqual([1, "actions/checkout"]);
    for (const event of ["pull_request", "schedule", "workflow_dispatch", "push"]) {
      expect(evalIf(step.if ?? "true", { "github.event_name": event }), event).toBe(event === "pull_request");
    }
    expect(step["continue-on-error"]).toBeUndefined();
    expect(step.env?.GITLEAKS).toMatch(/^ghcr\.io\/gitleaks\/gitleaks:v\d+\.\d+\.\d+@sha256:[0-9a-f]{64}$/);
  });

  /** A docker that records its arguments and each input, and answers the control and the change as told. */
  const DOCKER = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$STUB_DIR/args"
n=$(ls "$STUB_DIR" | grep -c '^input-' || true)
cat > "$STUB_DIR/input-$n"
both='[{"RuleID":"github-pat","StartLine":2},{"RuleID":"ohmail-key-ring","StartLine":3}]'
if grep -q secret-scan-control "$STUB_DIR/input-$n"; then printf '%s\\n' "\${STUB_CONTROL:-$both}"; exit 1; fi
printf '%s\\n' "\${STUB_CHANGE-null}"
exit "\${STUB_CHANGE_RC:-0}"
`;
  const rootFile = (p: string) => readFileSync(publicPath(p), "utf8");
  /* The step runs on the Linux runners only, with their git, jq and tar. */
  const onLinux = it.skipIf(process.platform !== "linux");

  /** The step over a merge commit of a base and a change, as GitHub checks a pull request out. */
  function runScan(change: (write: (p: string, text: string) => void) => void, stub: Record<string, string> = {}) {
    const dir = mkdtempSync(join(tmpdir(), "secret-scan-"));
    const repo = join(dir, "repo"), stubs = join(dir, "stub"), temp = join(dir, "temp");
    for (const d of [repo, stubs, temp]) mkdirSync(d);
    writeFileSync(join(stubs, "docker"), DOCKER, { mode: 0o755 });
    const env = {
      PATH: `${stubs}:${process.env.PATH ?? "/usr/bin:/bin"}`, HOME: dir, LC_ALL: "C", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid",
    };
    const git = (...a: string[]) => spawnSync("git", ["-c", "commit.gpgsign=false", ...a], { cwd: repo, env, encoding: "utf8" });
    const write = (p: string, text: string) => { mkdirSync(join(repo, p, ".."), { recursive: true }); writeFileSync(join(repo, p), text); };
    git("init", "-q", "-b", "main");
    write(".gitignore", rootFile(".gitignore"));
    write(".github/secret-scan.toml", rootFile("github/secret-scan.toml"));
    write("notes.txt", "kept line\nremoved line\n");
    git("add", "-A"); git("commit", "-q", "-m", "base");
    git("checkout", "-q", "-b", "change");
    change(write);
    git("add", "-A", "-f"); git("commit", "-q", "-m", "change");
    git("checkout", "-q", "main"); git("merge", "-q", "--no-ff", "-m", "merge", "change");
    const r = spawnSync("bash", ["-c", step.run!], {
      cwd: repo, encoding: "utf8", env: { ...env, RUNNER_TEMP: temp, STUB_DIR: stubs, GITLEAKS: step.env!.GITLEAKS!, ...stub },
    });
    const inputs = readdirSync(stubs).filter((f) => f.startsWith("input-")).sort().map((f) => readFileSync(join(stubs, f), "utf8"));
    let args: string[] = [];
    try { args = readFileSync(join(stubs, "args"), "utf8").split("\n").filter(Boolean); } catch { /* docker never ran */ }
    return { status: r.status, out: `${r.stdout}${r.stderr}`, inputs, args, repo: realpathSync(repo) };
  }
  const clean = (write: (p: string, text: string) => void) => {
    write("notes.txt", "kept line\nadded line\n");
    write("src/new.ts", "export const x = 1;\n");
  };

  onLinux("scans the control, then the added lines under their files' headers, never a removed line, in a sealed container", () => {
    const r = runScan(clean);
    expect(r.status, r.out).toBe(0);
    expect(r.inputs).toHaveLength(2);
    expect(r.inputs[0]).toMatch(/^\+\+\+ b\/secret-scan-control\n/);
    expect(r.inputs[0]).toMatch(/\bghp_[0-9a-zA-Z]{36}\b/);
    expect(r.inputs[0]).toMatch(new RegExp(`\\b${KEY_RING_V1}=[0-9a-f]{64}\\b`));
    expect(r.inputs[1]!.split("\n")).toEqual(["+++ b/notes.txt", "+added line", "+++ b/src/new.ts", "+export const x = 1;", ""]);
    for (const a of r.args) {
      expect(a).toBe(`run --rm -i --network none -v ${r.repo}/.github/secret-scan.toml:/secret-scan.toml:ro ${step.env!.GITLEAKS} `
        + "stdin --config /secret-scan.toml --redact --no-banner --report-format json --report-path -");
    }
  });

  onLinux("refuses a path the base ignores, though the change's own ignore file lets it through, before any scan", () => {
    const r = runScan((write) => {
      write("deploy/selfhost/.env", "POSTGRES_PASSWORD=x\n");
      write(".gitignore", `${rootFile(".gitignore")}!.env\n`);
    });
    expect(r.status).toBe(1);
    expect(r.out).toContain("deploy/selfhost/.env");
    expect(r.inputs).toEqual([]);
  });

  onLinux("refuses when the control is not found by both rules, before the change is scanned", () => {
    const r = runScan(clean, { STUB_CONTROL: '[{"RuleID":"github-pat","StartLine":2}]' });
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/control.*ohmail-key-ring/);
    expect(r.inputs).toHaveLength(1);
  });

  onLinux("refuses a finding by its rule and its file, and never prints what was found", () => {
    const found = '[{"RuleID":"github-pat","StartLine":4,"Match":"STUB-FOUND-VALUE"}]';
    const r = runScan(clean, { STUB_CHANGE: found, STUB_CHANGE_RC: "1" });
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/src\/new\.ts: github-pat/);
    expect(r.out).not.toContain("STUB-FOUND-VALUE");
  });

  onLinux("refuses a scan that wrote no report, whatever it exited", () => {
    for (const rc of ["0", "1"]) expect(runScan(clean, { STUB_CHANGE: "", STUB_CHANGE_RC: rc }).status, rc).toBe(1);
  });
});
