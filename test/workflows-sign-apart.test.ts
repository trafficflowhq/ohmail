import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { publicPath } from "./support/public-root.mjs";

/**
 * A JOB THAT HOLDS THE APPLE IDENTITY OR THE NOTARIZATION KEY RUNS NOTHING IT WAS HANDED.
 *
 * The macOS build runs vite, esbuild, jsdom, the Tauri CLI and cargo's build scripts and proc-macros, and a
 * poisoned version of any of them arrives by an ordinary dependency bump. While the Developer ID sat unlocked
 * in that job's keychain, such code could sign as this team or carry the identity away. So the identity and the
 * key live in a job of their own (build.yml's `macos-sign`), and this holds every workflow to the rule that
 * keeps them there. A job reading an Apple secret or the keychain password:
 *
 *   · uses download-artifact and upload-artifact, pinned to a commit, and no other action;
 *   · has no working-directory, runs its steps in bash, on a literal GitHub-hosted `macos-<n>`;
 *   · fetches by ID alone: each download's `artifact-ids` is `${{ needs.<job>.outputs.<id> || '0' }}`, the
 *     artifact-id an upload step of a job it needs returned, beside nothing but `path`. Any job of the run can
 *     write an artifact of any name, so a download by name signs whatever was written last; one written again
 *     gets a new ID, and the download fails before a key is imported. `'0'` names no artifact: an empty input
 *     would fetch every artifact of the run;
 *   · reads no other job's context (`needs`) anywhere else, a shell line, an `env:` or a step's `if:` included,
 *     but how a job it needs ended, in its own `if:`: `needs.<job>.result == '<literal>'`, a value GitHub sets
 *     and no step of any job writes. It needs one there beside `!cancelled()`: an `if:` naming no status function
 *     is `success()` over the whole needs chain, and the pull request's `changes`, skipped on a tag, skips it;
 *   · runs no package manager, build tool or interpreter, and no file it was handed: a command word with a
 *     slash outside /usr, /bin and /sbin, or one a variable or a substitution names.
 *
 * And no workflow-level env reads a secret, and no other job sets an Apple or keychain variable: the Tauri CLI
 * imports a certificate and signs with any it finds in its environment. Commands are read as bash reads them:
 * comments dropped, continuations joined, heredoc bodies skipped, split at `; && || | $( then do else`.
 */
const yaml = createRequire(import.meta.url)("js-yaml") as { load(text: string): unknown };
const DIR = publicPath("github/workflows");
const FILES = readdirSync(DIR).filter((f) => /\.ya?ml$/.test(f)).sort();
const read = (f: string) => readFileSync(`${DIR}/${f}`, "utf8");

type Step = { id?: unknown; name?: unknown; uses?: unknown; with?: Record<string, unknown>; run?: unknown; shell?: unknown; if?: unknown; env?: Record<string, unknown>; "working-directory"?: unknown };
type Defaults = { run?: { shell?: unknown; "working-directory"?: unknown } };
type Job = { "runs-on"?: unknown; uses?: unknown; if?: unknown; needs?: unknown; outputs?: Record<string, unknown>; env?: Record<string, unknown>; defaults?: Defaults; steps?: Step[] };
type Workflow = { env?: Record<string, unknown>; defaults?: Defaults; jobs?: Record<string, Job> };

/** A read of an Apple secret or the keychain password, in any spelling, or of every secret at once. */
const HOLDS = /\bsecrets\.(?:APPLE_[A-Z0-9_]+|KEYCHAIN_PASSWORD)\b|\bsecrets\[\s*['"](?:APPLE_[A-Z0-9_]+|KEYCHAIN_PASSWORD)['"]\s*\]|\btoJSON\(\s*secrets\s*\)|^\s+secrets:\s*inherit\b/m;
/** The variables the Tauri CLI signs and notarizes with, and the keychain's password. */
const APPLE_VAR = /^(?:APPLE_[A-Z0-9_]+|KEYCHAIN_PASSWORD)$/;
const ALLOWED_USES = /^actions\/(?:download|upload)-artifact@[0-9a-f]{40}$/;
const DOWNLOAD = /^actions\/download-artifact@[0-9a-f]{40}$/;
const UPLOAD = /^actions\/upload-artifact@[0-9a-f]{40}$/;
/** The one read of another job a holder takes: the ID it fetches by, `'0'` (no artifact) when that is empty. */
const BY_ID = /^\$\{\{\s*needs\.([A-Za-z_][\w-]*)\.outputs\.([A-Za-z_][\w-]*)\s*\|\|\s*'0'\s*\}\}$/;
/** A job output that is the ID an upload step of that job returned. */
const UPLOAD_ID = /^\$\{\{\s*steps\.([A-Za-z_][\w-]*)\.outputs\.artifact-id\s*\}\}$/;
/** How a job ended, against a literal: the one read of another job a holder's own `if:` takes. GitHub sets it. */
const RESULT_IS = /\bneeds\.([A-Za-z_][\w-]*)\.result\s*==\s*'(?:[^']|'')*'/g;
/** Package managers, build tools and interpreters, the ones macOS itself carries among them. */
const NEVER = new Set(["npm", "npx", "node", "corepack", "yarn", "pnpm", "bun", "deno", "cargo", "rustup", "rustc", "make",
  "python", "python3", "pip", "pip3", "brew", "curl", "wget", "bash", "sh", "zsh", "source", ".", "tauri", "vite",
  "eval", "perl", "ruby", "php", "java", "swift", "osascript"]);
const SKIP = new Set(["if", "elif", "then", "else", "do", "while", "until", "!", "{", "}", "(", ")", "((", "))", "fi", "done", "esac", "time"]);
const WRAPPERS = new Set(["sudo", "env", "exec", "command", "builtin", "nohup", "nice", "stdbuf", "xargs", "timeout"]);
const SUBST = "__SUBSTITUTION__";
/** A redirection opening a word; written alone, its target is the next word. */
const REDIRECT = /^\d*(?:<<<|<<-?|>>?\|?|<|&>>?|>&|<&)/;

/** Text without its comments (a `#` opening a word outside quotes, to the end of its line), and the quote left open. */
function scan(text: string): { code: string; open: string } {
  let q = "";
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (q) {
      out += c;
      if (c === "\\" && q === '"' && i + 1 < text.length) out += text[++i];
      else if (c === q) q = "";
      continue;
    }
    if (c === "'" || c === '"') { q = c; out += c; continue; }
    if (c === "\\" && i + 1 < text.length) { out += c + text[++i]; continue; }
    if (c === "#" && (i === 0 || /\s/.test(text[i - 1]!))) {
      const nl = text.indexOf("\n", i);
      if (nl < 0) break;
      i = nl - 1;
      continue;
    }
    out += c;
  }
  return { code: out, open: q };
}

/** The heredoc a line opens, outside quotes (`<<'X'`, `<<X`, `<<-X`; never a `<<<` string). */
function heredocOf(l: string): string | null {
  let q = "";
  for (let i = 0; i < l.length; i++) {
    const c = l[i];
    if (q) { if (c === "\\" && q === '"') i++; else if (c === q) q = ""; continue; }
    if (c === "'" || c === '"') { q = c; continue; }
    if (c === "\\") { i++; continue; }
    if (l.startsWith("<<", i) && l[i + 2] !== "<" && l[i - 1] !== "<") {
      const m = /^<<-?\s*(['"]?)([A-Za-z_]\w*)\1/.exec(l.slice(i));
      if (m) return m[2]!;
    }
  }
  return null;
}

/**
 * A run: block as bash reads it: comments dropped, continuations joined, a quote left open joined with the lines
 * it spans (an awk program, a message), heredoc bodies left out.
 */
export function logicalLines(run: string): string[] {
  const out: string[] = [];
  let held: string | null = null;
  let join = "\n";
  let doc: string | null = null;
  for (const raw of run.split("\n")) {
    if (doc !== null) { if (raw.trim() === doc) doc = null; continue; }
    const text: string = held === null ? raw : `${held}${join}${raw}`;
    const { code, open } = scan(text);
    if (open) { held = text; join = "\n"; continue; }
    if (code.endsWith("\\") && !code.endsWith("\\\\")) { held = code.slice(0, -1); join = " "; continue; }
    held = null;
    const line = code.replace(/\s+$/, "");
    if (line.trim()) out.push(line);
    doc = heredocOf(line);
  }
  if (held !== null && held.trim()) out.push(scan(held).code);
  return out;
}

const words = (s: string): string[] => s.match(/(?:[^\s"']+|"(?:\\.|[^"\\])*"|'[^']*')+/g) ?? [];
const bare = (w: string) => w.replace(/["']/g, "");

/**
 * A line's simple commands, as word lists: split at ; && || | & and at each `$(…)` or backtick, which is a command
 * of its own. An arithmetic `$((…))` is a value, not a command, though a `$(…)` inside it is one.
 */
export function simpleCommands(line: string): string[][] {
  const out: string[][] = [];
  type Frame = { buf: string; q: string; kind: "cmd" | "tick" | "arith"; depth: number };
  const stack: Frame[] = [{ buf: "", q: "", kind: "cmd", depth: 0 }];
  const top = () => stack[stack.length - 1]!;
  const flush = () => { const w = words(top().buf); if (w.length) out.push(w); top().buf = ""; };
  const close = () => { flush(); stack.pop(); top().buf += SUBST; };
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!, two = line.slice(i, i + 2), f = top();
    if (f.q === "'") { f.buf += c; if (c === "'") f.q = ""; continue; }
    if (c === "\\") { f.buf += two; i++; continue; }
    if (line.startsWith("$((", i)) { stack.push({ buf: "", q: "", kind: "arith", depth: 0 }); i += 2; continue; }
    if (two === "$(" || (!f.q && two === "<(")) { stack.push({ buf: "", q: "", kind: "cmd", depth: 0 }); i++; continue; }
    if (f.kind === "arith") {
      if (c === "(") f.depth++;
      else if (c === ")" && f.depth > 0) f.depth--;
      else if (two === "))") { stack.pop(); top().buf += "0"; i++; }
      continue;
    }
    if (c === "`") { if (f.kind === "tick") close(); else stack.push({ buf: "", q: "", kind: "tick", depth: 0 }); continue; }
    if (f.q === '"') { f.buf += c; if (c === '"') f.q = ""; continue; }
    if (c === "'" || c === '"') { f.q = c; f.buf += c; continue; }
    if (c === ")" && stack.length > 1 && f.kind === "cmd") { close(); continue; }
    if (two === "&&" || two === "||") { flush(); i++; continue; }
    if (c === ";" || c === "|" || (c === "&" && line[i - 1] !== ">" && line[i + 1] !== ">" && line[i - 1] !== "<")) { flush(); continue; }
    f.buf += c;
  }
  while (stack.length > 1) { if (top().kind === "arith") { stack.pop(); top().buf += "0"; } else close(); }
  flush();
  /* `then`, `do` and `else` open a command of their own mid-segment too: `if x; then npm ci; fi`. */
  return out.flatMap((ws) => {
    const parts: string[][] = [[]];
    for (const w of ws) if (w === "then" || w === "do" || w === "else") parts.push([]); else parts[parts.length - 1]!.push(w);
    return parts.filter((p) => p.length);
  });
}

/** The command a simple command runs: keywords, assignments, redirections, case patterns and wrappers skipped. */
export function commandWord(ws: string[]): string | null {
  let i = 0;
  while (i < ws.length) {
    const w = ws[i]!;
    if (w === "for" || w === "select") return null;
    /* A one-line `case x in pat) cmd ;;` runs its arm's command: read on past `in` and the pattern. */
    if (w === "case") { const at = ws.indexOf("in", i); if (at < 0) return null; i = at + 1; continue; }
    if (SKIP.has(w) || /^[A-Za-z_]\w*\+?=/.test(w)) { i++; continue; }
    if (REDIRECT.test(w)) { i += new RegExp(`${REDIRECT.source}$`).test(w) ? 2 : 1; continue; }
    if ((i === 0 || ws[i - 1] === "in") && /\)$/.test(w) && !w.startsWith("(")) { i++; continue; }
    if (WRAPPERS.has(w)) {
      if (w === "command" && /^-[vV]$/.test(ws[i + 1] ?? "")) return null;
      i++;
      while (i < ws.length && (/^-/.test(ws[i]!) || /^[A-Za-z_]\w*=/.test(ws[i]!))) i++;
      if (w === "timeout") i++;
      continue;
    }
    return w;
  }
  return null;
}

/** What one command line runs that a key-holding job may not, one entry per command at most. */
export function forbiddenRuns(line: string): string[] {
  const out: string[] = [];
  for (const ws of simpleCommands(line)) {
    const w = commandWord(ws);
    if (w === null) continue;
    const name = bare(w);
    if (name === "trap") { const arg = ws[ws.indexOf(w) + 1]; if (arg) out.push(...forbiddenRuns(bare(arg))); continue; }
    if (name === "find") {
      const at = ws.findIndex((x) => /^-(?:exec|execdir|ok|okdir)$/.test(x));
      if (at >= 0) out.push(...forbiddenRuns(ws.slice(at + 1).join(" ").replace(/\s\\?;\s*$|\s\+\s*$/, "")));
      continue;
    }
    if (name === "") continue;
    const base = name.replace(/^[({]+/, "").replace(/^.*\//, "");
    if (name.includes(SUBST)) out.push("runs a command a substitution names");
    else if (NEVER.has(base)) out.push(`runs ${base}`);
    else if (name.startsWith("$")) out.push(`runs a command a variable names: ${name}`);
    else if (name.includes("/") && !/^\/(?:usr|bin|sbin)\//.test(name)) out.push(`runs a file it was handed: ${name}`);
  }
  return out;
}

/** A workflow's jobs as text, comment lines dropped, keyed by id. */
function jobTexts(text: string): Map<string, string> {
  const out = new Map<string, string>();
  const from = text.indexOf("\njobs:\n");
  if (from < 0) return out;
  let cur: string | null = null;
  for (const line of text.slice(from + 7).split("\n")) {
    const key = /^ {2}([A-Za-z_][\w-]*):\s*$/.exec(line);
    if (key) { cur = key[1]!; out.set(cur, ""); continue; }
    if (cur !== null && !/^\s*#/.test(line)) out.set(cur, `${out.get(cur)}${line}\n`);
  }
  return out;
}

type Expr = { at: string[]; expr: string };

/**
 * Every expression a job evaluates, with its path: a job's or a step's `if:` whole, anything else each `${{ … }}`
 * in it. Parsed, so a YAML comment is none, and a `${{ }}` in a shell comment is one: the runner expands it.
 */
function expressions(v: unknown, at: string[] = [], out: Expr[] = []): Expr[] {
  if (typeof v === "string") {
    const isIf = at.at(-1) === "if" && (at.length === 1 || (at.length === 3 && at[0] === "steps"));
    if (isIf) out.push({ at, expr: v });
    else for (const m of v.match(/\$\{\{[\s\S]*?\}\}/g) ?? []) out.push({ at, expr: m });
  } else if (Array.isArray(v)) v.forEach((x, i) => expressions(x, [...at, String(i)], out));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) expressions(x, [...at, k], out);
  return out;
}

/** Why a holder's download is not bound to the artifact an upload of a job it needs returned; null when it is. */
function unbound(wf: Workflow, job: Job, w: Record<string, unknown>): string | null {
  const ids = w["artifact-ids"];
  if (ids === undefined) return "fetches by name, not by the ID an upload of a job it needs returned";
  const m = BY_ID.exec(String(ids));
  if (!m) return `fetches by ${String(ids)}, not by one job's output with '0' for none`;
  const from = m[1]!, out = m[2]!;
  if (![job.needs ?? []].flat().includes(from)) return `reads ${from}, a job it does not need`;
  const s = UPLOAD_ID.exec(String(wf.jobs?.[from]?.outputs?.[out] ?? ""));
  const up = s ? (wf.jobs?.[from]?.steps ?? []).find((x) => x.id === s[1]) : undefined;
  if (!up || !UPLOAD.test(String(up.uses))) return `${from}'s output ${out} is not the artifact-id of an upload step of ${from}`;
  return null;
}

export type SignApart = { holders: string[]; findings: string[] };

/** Every job of one workflow that holds the Apple identity or key, and every way the file departs from the rule. */
export function signApart(file: string, text: string): SignApart {
  const wf = (yaml.load(text) ?? {}) as Workflow;
  const texts = jobTexts(text);
  const holders: string[] = [];
  const findings: string[] = [];
  for (const [k, v] of Object.entries(wf.env ?? {})) {
    if (/\bsecrets\b/.test(String(v))) findings.push(`${file}: the workflow-level env reads a secret into every job (${k})`);
    else if (APPLE_VAR.test(k)) findings.push(`${file}: the workflow-level env sets ${k} in every job`);
  }
  for (const [id, job] of Object.entries(wf.jobs ?? {})) {
    const at = `${file} ${id}`;
    const steps = job.steps ?? [];
    if (!HOLDS.test(texts.get(id) ?? "")) {
      const envs = [job.env ?? {}, ...steps.map((s) => s.env ?? {})].flatMap((e) => Object.keys(e)).filter((k) => APPLE_VAR.test(k));
      for (const k of [...new Set(envs)]) findings.push(`${at}: sets ${k}, which the Tauri CLI signs with, outside the signing job`);
      for (const s of steps) {
        if (typeof s.run !== "string") continue;
        for (const l of logicalLines(s.run)) {
          const m = /(?:^|[\s"'])((?:APPLE_[A-Z0-9_]+|KEYCHAIN_PASSWORD))=/.exec(l);
          if (m) findings.push(`${at}: sets ${m[1]}, which the Tauri CLI signs with, outside the signing job`);
        }
      }
      continue;
    }
    holders.push(at);
    const runsOn = job["runs-on"];
    if (typeof runsOn !== "string" || !/^macos-\d+$/.test(runsOn)) findings.push(`${at}: runs on ${JSON.stringify(runsOn)}, not a literal GitHub-hosted macos-<n>`);
    if (job.uses !== undefined) findings.push(`${at}: calls the workflow ${String(job.uses)}`);
    /* A download's own artifact-ids is the one read of another job's output a holder takes; it is judged below. */
    const admitted = (p: string[]) => p.length === 4 && p[0] === "steps" && p[2] === "with" && p[3] === "artifact-ids"
      && DOWNLOAD.test(String(steps[Number(p[1])]?.uses));
    /* Its own `if:` may ask how a job it needs ended, and nothing else of another job. */
    const needed = [job.needs ?? []].flat().map(String);
    const rest = (e: Expr) => {
      if (e.at.length !== 1 || e.at[0] !== "if") return e.expr;
      for (const m of e.expr.matchAll(RESULT_IS)) if (!needed.includes(m[1]!)) findings.push(`${at}: its if: asks how ${m[1]} ended, a job it does not need`);
      return e.expr.replace(RESULT_IS, "");
    };
    const reads = expressions(job).filter((e) => !admitted(e.at) && /\bneeds\b/.test(rest(e)));
    if (reads.length) findings.push(`${at}: reads another job's context (${reads[0]!.expr.trim()})`);
    for (const [where, d] of [["the workflow", wf.defaults], ["the job", job.defaults]] as const) {
      if (d?.run?.["working-directory"] !== undefined) findings.push(`${at}: ${where}'s defaults set a working-directory`);
      if (d?.run?.shell !== undefined && d.run.shell !== "bash") findings.push(`${at}: ${where}'s defaults run its steps in ${String(d.run.shell)}`);
    }
    steps.forEach((s, n) => {
      const step = `${at} / ${typeof s.name === "string" ? s.name : typeof s.uses === "string" ? s.uses : `step ${n + 1}`}`;
      if (s.uses !== undefined && !ALLOWED_USES.test(String(s.uses))) findings.push(`${step}: uses ${String(s.uses)}`);
      if (DOWNLOAD.test(String(s.uses))) {
        const w = s.with ?? {};
        const why = unbound(wf, job, w);
        if (why) findings.push(`${step}: ${why}`);
        for (const k of Object.keys(w)) {
          if (k === "artifact-ids" || k === "path" || (k === "name" && w["artifact-ids"] === undefined)) continue;
          findings.push(`${step}: takes the download input ${k}`);
        }
      }
      if (s["working-directory"] !== undefined) findings.push(`${step}: runs in the working-directory ${String(s["working-directory"])}`);
      if (s.shell !== undefined && s.shell !== "bash") findings.push(`${step}: runs in ${String(s.shell)}`);
      if (typeof s.run !== "string") return;
      for (const l of logicalLines(s.run)) for (const r of forbiddenRuns(l)) findings.push(`${step}: ${r} (${l.trim().slice(0, 80)})`);
    });
  }
  return { holders, findings };
}

/**
 * A clean holder: two artifact actions around one step that signs with what it fetched, by the ID the build job's
 * upload returned. The build job comes after it, so a fixture's first `runs-on` or `steps:` is the holder's.
 */
const H = (n: string) => n.repeat(40);
const BY_ID_LINE = "          artifact-ids: ${{ needs.build.outputs.unsigned-id || '0' }}\n";
const CLEAN = [
  "on: push",
  "jobs:",
  "  sign:",
  "    needs: build",
  "    runs-on: macos-15",
  "    steps:",
  `      - uses: actions/download-artifact@${H("a")} # v7`,
  "        with:",
  BY_ID_LINE.trimEnd(),
  "          path: unsigned",
  "      - name: Sign",
  "        env:",
  "          APPLE_CERTIFICATE: ${{ startsWith(github.ref, 'refs/tags/v') && secrets.APPLE_CERTIFICATE || '' }}",
  "        run: |",
  "          set -euo pipefail",
  "          # npm ci, and cargo test, named in a comment",
  '          /usr/bin/security import "$CERT" -k "$KC" -T /usr/bin/codesign',
  '          codesign --force --timestamp --options runtime --sign "$ID" \\',
  '            "$APP/Contents/Resources/runtime/node"',
  '          xcrun notarytool submit "$RUNNER_TEMP/app.zip" --wait',
  '          echo "signing tools: $(xcodebuild -version 2>/dev/null | head -1)"',
  "          cat > \"$ENT\" <<'PLIST'",
  "          <key>com.apple.security.cs.allow-jit</key><true/>",
  "          npm ci",
  "          PLIST",
  '          for t in security codesign ditto; do command -v "$t" > /dev/null || exit 1; done',
  `      - uses: actions/upload-artifact@${H("b")} # v7`,
  "        with:",
  "          name: signed",
  "          path: build/ohmail.dmg",
  "  build:",
  "    runs-on: ubuntu-latest",
  "    outputs:",
  "      unsigned-id: ${{ steps.unsigned.outputs.artifact-id }}",
  "    steps:",
  "      - run: npm ci",
  "      - id: unsigned",
  `        uses: actions/upload-artifact@${H("b")} # v7`,
  "        with:",
  "          name: unsigned",
  "          path: build/ohmail.dmg",
  "",
].join("\n");
const RUN_AT = '          xcrun notarytool submit "$RUNNER_TEMP/app.zip" --wait\n';
const withLine = (line: string) => CLEAN.replace(RUN_AT, `${RUN_AT}          ${line}\n`);
const STEPS_AT = "    steps:\n";
const withStep = (step: string) => CLEAN.replace(STEPS_AT, `${STEPS_AT}${step}`);
/** The clean holder with the `if:` build.yml's macos-sign carries: it starts when the build it needs succeeded. */
const RESULT_READ = "needs.build.result == 'success'";
const CLEAN_IF = CLEAN.replace("    needs: build\n", `    needs: build\n    if: \${{ !cancelled() && ${RESULT_READ} }}\n`);

describe("the job holding the Apple identity runs nothing it was handed", () => {
  it("reads every workflow, and the one job holding the identity is build.yml's macos-sign, clean", () => {
    expect(FILES).toEqual(expect.arrayContaining(["android.yml", "build.yml", "release-feeds.yml"]));
    const all = FILES.map((f) => signApart(f, read(f)));
    expect(all.flatMap((r) => r.holders), "the census found no holder, or another one").toEqual(["build.yml macos-sign"]);
    expect(all.flatMap((r) => r.findings)).toEqual([]);
  });

  it("admits the clean shape: a fetch by the build's upload ID, absolute system tools, node as an argument, a heredoc, a comment", () => {
    expect(signApart("x.yml", CLEAN)).toEqual({ holders: ["x.yml sign"], findings: [] });
    expect(CLEAN_IF).not.toBe(CLEAN);
    expect(signApart("x.yml", CLEAN_IF), "and its own if: asking how the build it needs ended").toEqual({ holders: ["x.yml sign"], findings: [] });
  });

  /* A job's result is set by GitHub, never by a step: reading it lets no build-controlled value into the holder. */
  it("admits the holder's own if: asking how a job it needs ended, and nothing else of that job, anywhere", () => {
    const planted: Array<[string, string]> = [
      ["an output in its if", CLEAN_IF.replace(RESULT_READ, "needs.build.outputs.flag == 'true'")],
      ["an output beside the result", CLEAN_IF.replace(RESULT_READ, `${RESULT_READ} && needs.build.outputs.flag == 'true'`)],
      ["the result against an output", CLEAN_IF.replace(RESULT_READ, "needs.build.result == needs.build.outputs.flag")],
      ["the result of a job it does not need", CLEAN_IF.replace(RESULT_READ, "needs.other.result == 'success'")],
      ["every result at once", CLEAN_IF.replace(RESULT_READ, "!contains(needs.*.result, 'failure')")],
      ["the result in a step's if", CLEAN.replace("      - name: Sign\n", `      - name: Sign\n        if: ${RESULT_READ}\n`)],
      ["the result in a shell line", withLine('echo "${{ needs.build.result }}"')],
      ["the result in an env", CLEAN.replace("        env:\n", "        env:\n          R: ${{ needs.build.result }}\n")],
    ];
    for (const [what, wf] of planted) {
      expect([CLEAN, CLEAN_IF], `${what}: the plant`).not.toContain(wf);
      expect(signApart("x.yml", wf).findings, what).toHaveLength(1);
    }
    expect(signApart("x.yml", CLEAN_IF.replace(RESULT_READ, "needs.other.result == 'success'")).findings)
      .toEqual(["x.yml sign: its if: asks how other ended, a job it does not need"]);
    expect(signApart("x.yml", CLEAN_IF.replace(RESULT_READ, "needs.build.outputs.flag == 'true'")).findings)
      .toEqual(["x.yml sign: reads another job's context (${{ !cancelled() && needs.build.outputs.flag == 'true' }})"]);
  });

  it("refuses the job as it stood before the split: checkout, setup-node, npm and cargo beside the certificate", () => {
    const before = [
      "on: push", "jobs:", "  macos:", "    runs-on: macos-15", "    steps:",
      `      - uses: actions/checkout@${H("c")} # v7`,
      `      - uses: actions/setup-node@${H("d")} # v7`,
      "        with:", "          node-version: 22.23.4",
      "      - name: Install", "        run: npm ci --ignore-scripts",
      "      - name: Import", "        env:", "          APPLE_CERTIFICATE: ${{ secrets.APPLE_CERTIFICATE }}",
      "        run: |", '          /usr/bin/security import "$CERT_FILE" -k "$KC"',
      "      - name: Test", "        run: cargo test --locked", "",
    ].join("\n");
    const r = signApart("build.yml", before);
    expect(r.holders).toEqual(["build.yml macos"]);
    expect(r.findings).toEqual([
      `build.yml macos / actions/checkout@${H("c")}: uses actions/checkout@${H("c")}`,
      `build.yml macos / actions/setup-node@${H("d")}: uses actions/setup-node@${H("d")}`,
      "build.yml macos / Install: runs npm (npm ci --ignore-scripts)",
      "build.yml macos / Test: runs cargo (cargo test --locked)",
    ]);
  });

  it("refuses each planted shape with one finding", () => {
    const planted: Array<[string, string]> = [
      ["an added checkout", withStep(`      - uses: actions/checkout@${H("c")} # v7\n`)],
      ["an added cache", withStep(`      - uses: actions/cache@${H("e")} # v4\n        with:\n          path: build/vendor\n          key: k\n`)],
      ["an artifact action by tag", withStep("      - uses: actions/download-artifact@v7\n")],
      ["npm ci", withLine("npm ci --ignore-scripts")],
      ["cargo build", withLine("cargo build --locked")],
      ["node x.mjs", withLine("node x.mjs")],
      ["brew install", withLine("brew install gnu-tar")],
      ["curl -o", withLine("curl -fsSL -o x.tgz https://example.com/x.tgz")],
      ["the shipped node run", withLine('"$APP/Contents/Resources/runtime/node" --version')],
      ["a script it was handed", withLine("./unsigned/sign.sh")],
      ["a command a variable names", withLine('"$TOOL" --version')],
      ["npm behind then", withLine("if true; then npm ci; fi")],
      ["npm in a substitution", withLine('V="$(npx --version)"')],
      ["npm behind a wrapper", withLine("env CI=1 npm ci")],
      ["npm in a trap", withLine("trap 'npm ci' EXIT")],
      ["a self-hosted runner", CLEAN.replace("runs-on: macos-15", "runs-on: [self-hosted, macOS]")],
      ["a runner by expression", CLEAN.replace("runs-on: macos-15", "runs-on: ${{ vars.MAC_RUNNER }}")],
      ["another job's outputs", CLEAN.replace("        env:\n", "        env:\n          ID: ${{ needs.build.outputs.identity }}\n")],
      ["a download by name", CLEAN.replace(BY_ID_LINE, "          name: unsigned\n")],
      ["an ID with no fallback", CLEAN.replace(" || '0' }}", " }}")],
      ["an ID beside another", CLEAN.replace(" || '0' }}\n", " || '0' }},42\n")],
      ["an ID from a job it does not need", CLEAN.replace("    needs: build\n", "")],
      ["an output no upload returned", CLEAN.replace("steps.unsigned.outputs.artifact-id", "steps.look.outputs.id")],
      ["an ID from an upload by tag", CLEAN.replace(`      - id: unsigned\n        uses: actions/upload-artifact@${H("b")}`, "      - id: unsigned\n        uses: actions/upload-artifact@v7")],
      ["a token that reaches other runs", CLEAN.replace("          path: unsigned\n", "          path: unsigned\n          github-token: ${{ github.token }}\n")],
      ["the ID in a shell line", withLine('echo "${{ needs.build.outputs.unsigned-id }}"')],
      ["every output at once", withLine("echo '${{ toJSON(needs) }}'")],
      ["the ID in a step's if", CLEAN.replace("      - name: Sign\n", "      - name: Sign\n        if: needs.build.outputs.unsigned-id != ''\n")],
      ["a working-directory", CLEAN.replace("      - name: Sign\n", "      - name: Sign\n        working-directory: apps/desktop\n")],
      ["another shell", CLEAN.replace("      - name: Sign\n", "      - name: Sign\n        shell: python {0}\n")],
      ["a workflow-level env reading a secret", CLEAN.replace("on: push\n", "on: push\nenv:\n  X: ${{ secrets.APPLE_API_KEY }}\n")],
    ];
    for (const [what, wf] of planted) expect(signApart("x.yml", wf).findings, what).toHaveLength(1);
  });

  it("binds the fetch to the ID an upload of a job it needs returned, and admits that one read alone", () => {
    const fetch = `x.yml sign / actions/download-artifact@${H("a")}`;
    expect(signApart("x.yml", CLEAN.replace(BY_ID_LINE, "          name: unsigned\n")).findings)
      .toEqual([`${fetch}: fetches by name, not by the ID an upload of a job it needs returned`]);
    expect(signApart("x.yml", CLEAN.replace("steps.unsigned.outputs", "steps.look.outputs")).findings)
      .toEqual([`${fetch}: build's output unsigned-id is not the artifact-id of an upload step of build`]);
    /* The same expression anywhere else is a read of another job; a YAML comment is none. */
    expect(signApart("x.yml", withLine("echo \"${{ needs.build.outputs.unsigned-id || '0' }}\"")).findings)
      .toEqual(["x.yml sign: reads another job's context (${{ needs.build.outputs.unsigned-id || '0' }})"]);
    expect(signApart("x.yml", CLEAN.replace("    steps:\n", "    steps:\n      # ${{ needs.build.outputs.identity }}\n")).findings).toEqual([]);
    /* On anything but the pinned download, artifact-ids is no admitted read. */
    expect(signApart("x.yml", CLEAN.replace(`actions/download-artifact@${H("a")}`, "actions/download-artifact@v7")).findings).toEqual([
      "x.yml sign: reads another job's context (${{ needs.build.outputs.unsigned-id || '0' }})",
      "x.yml sign / actions/download-artifact@v7: uses actions/download-artifact@v7",
    ]);
  });

  it("refuses an Apple variable set anywhere else, where the Tauri CLI would sign with it", () => {
    const build = "on: push\njobs:\n  macos:\n    runs-on: macos-15\n    steps:\n      - name: Build\n";
    expect(signApart("x.yml", `${build}        env:\n          APPLE_SIGNING_IDENTITY: "-"\n        run: npm run app:build\n`).findings).toHaveLength(1);
    expect(signApart("x.yml", `${build}        run: echo "APPLE_API_KEY_PATH=/tmp/k.p8" >> "$GITHUB_ENV"\n`).findings).toHaveLength(1);
    expect(signApart("x.yml", "on: push\nenv:\n  APPLE_SIGNING_IDENTITY: x\njobs: {}\n").findings).toHaveLength(1);
    /* …and a build job with none of it is no holder and no finding, whatever it runs. */
    expect(signApart("x.yml", `${build}        run: npm run app:build\n`)).toEqual({ holders: [], findings: [] });
  });

  it("finds a holder however it reads the secret, and never by a comment", () => {
    const job = (env: string) => `on: push\njobs:\n  j:\n    runs-on: macos-15\n    steps:\n      - name: s\n        env:\n          X: ${env}\n        run: echo\n`;
    for (const read of ["${{ secrets.KEYCHAIN_PASSWORD }}", "${{ secrets['APPLE_API_KEY'] }}", "${{ toJSON(secrets) }}"]) {
      expect(signApart("x.yml", job(read)).holders, read).toEqual(["x.yml j"]);
    }
    expect(signApart("x.yml", job("${{ secrets.ANDROID_KEYSTORE_B64 }}")).holders).toEqual([]);
    expect(signApart("x.yml", "on: push\njobs:\n  j:\n    runs-on: macos-15\n    steps:\n      # ${{ secrets.APPLE_CERTIFICATE }}\n      - run: npm ci\n").holders).toEqual([]);
  });

  it("reads commands as bash does", () => {
    expect(logicalLines("a \\\n  b\n# c\nd # e\ncat > f <<'X'\nnpm ci\nX\ng")).toEqual(["a    b", "d", "cat > f <<'X'", "g"]);
    expect(logicalLines('echo "<<X"\nnpm ci')).toEqual(['echo "<<X"', "npm ci"]);
    const awk = logicalLines("X=\"$(awk '{ a = $0\n  if (a ~ /x/) print # not a comment\n}' f)\"\nnpm ci");
    expect(awk).toHaveLength(2);
    expect(awk[0]).toContain("# not a comment");
    expect(awk.flatMap((l) => forbiddenRuns(l))).toEqual(["runs npm"]);
    expect(forbiddenRuns('done <<< "$LIST"')).toEqual([]);
    expect(forbiddenRuns('size=$(( $(du -sk "$src" | cut -f1) * 1024 / 1000 + (1 + 20) ))')).toEqual([]);
    expect(forbiddenRuns("n=$(( $(npx x) + 1 ))")).toEqual(["runs npx"]);
    expect(simpleCommands('a && b || c; d | e "$(f | g)"').map((w) => w[0])).toEqual(["a", "b", "c", "d", "f", "g", "e"]);
    expect(forbiddenRuns('case "$x" in *) echo no >&2; exit 1 ;; esac')).toEqual([]);
    expect(forbiddenRuns('case "$x" in a) npm ci ;; esac')).toEqual(["runs npm"]);
    expect(forbiddenRuns("(npm ci)")).toEqual(["runs npm"]);
    expect(forbiddenRuns("''|*[!0-9]*) echo bad ;;")).toEqual([]);
    expect(forbiddenRuns('X="$(printf \'%s\' "$IDS" | /usr/bin/grep -m1 "Developer ID" | sed \'s/a/b/\' || true)"')).toEqual([]);
    expect(forbiddenRuns("staple_or_submit() {")).toEqual([]);
    expect(forbiddenRuns("find . -type f -exec node {} +")).toEqual(["runs node"]);
    expect(forbiddenRuns('"$(which node)" x.mjs')).toEqual(["runs a command a substitution names"]);
  });
});
