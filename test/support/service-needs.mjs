/**
 * WHICH TEST SERVICES A TEST FILE NEEDS, read from its text: the runner (`test/setup/service-gate.runner.ts`)
 * skips a file that needs a service the run's probe found absent, unless the file gates that service
 * itself. Plain .mjs (the runner, the census and ci-shards read it); paths are repo-relative with `/`.
 *
 * A need is a signal in the file's own code (comments stripped), or in a test helper it imports by a
 * relative path, followed on through helpers and stopped at package source: a file that only uses
 * `makeTestDb` needs nothing. Dovecot is read from the file's own code only, by ci-shards' DOVECOT_TEXT
 * (the GreenMail helper names the CONDSTORE probe, and every importer would turn Dovecot).
 *
 * A file gates a service itself when its own code calls `serviceUp("<name>"`, `realPgAvailable(` (pg)
 * or `probeCondstore(` (dovecot). Markers, in a comment: `@services: none — <reason>` for a file
 * that only names a service as data; `@services: <name>[, <name>]` for a need the text does not show.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, posix, relative } from "node:path";
import { code } from "../../scripts/lib/pg-url-own.mjs";
import { DOVECOT_TEXT, SERVICE_GATE_PREFIX } from "./ci-shards.mjs";

/** The start of a runner skip's describe name; ci-shards' verify verbs refuse a report holding one. */
export { SERVICE_GATE_PREFIX };
export const SERVICES = ["pg", "greenmail", "dovecot", "rustfs"];

const SIGNALS = {
  pg: [
    /\bPG_TEST_URL\b/, /\bpgTestUrl\s*\(/, /\bdbUrlFor\s*\(/, /\brealPgAvailable\s*\(/, /\bprepareIsolatedDb\b/,
    /\bthrowawayDb\s*\(/, /\bcloneFromTemplate\s*\(/, /\bjournalDrift\s*\(/,
    /\bprocess\.env\.DATABASE_URL_(?:PG_TEST|SESSION)\b(?!\s*=[^=])/, /:5433\b/, /\bserviceUp\(\s*["']pg["']/,
  ],
  greenmail: [
    /\bgreenmailConfig\s*\(/, /\bgreenmailPorts\s*\(/, /\bgreenmailEndpoint\s*\(/,
    /\bprocess\.env\.(?:IMAP|SMTP)_(?:HOST|PORT)\b/, /\b(?:3143|3025)\b/, /\bserviceUp\(\s*["']greenmail["']/,
  ],
  rustfs: [/RUSTFS_URL\b/, /:3902\b/, /\bserviceUp\(\s*["']rustfs["']/],
};
const NAME_SIGNALS = { pg: /\.pg\.test\.tsx?$/, greenmail: /\.greenmail\.test\.tsx?$/ };
const DOVECOT_OWN = [DOVECOT_TEXT, /\bserviceUp\(\s*["']dovecot["']/];
/* A call, never the definition: `function probeCondstore(` is the helper itself. */
const GATES = {
  pg: /(?<!function\s+)\brealPgAvailable\s*\(/,
  dovecot: /(?<!function\s+)\bprobeCondstore\s*\(/,
};
const SERVICE_UP_CALL = /\bserviceUp\(\s*["'](pg|greenmail|dovecot|rustfs)["']/g;
const MARKER = /^[ \t]*(?:\/\/|\/?\*+)[ \t]*@services:[ \t]*([^\n]*)/gm;
const IMPORT = /\b(?:import|export)\s[^'"`;]*?\bfrom\s*["'](\.{1,2}\/[^"']+)["']|\bimport\s*\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)|^\s*import\s*["'](\.{1,2}\/[^"']+)["']/gm;
/** Test-helper modules: what a relative import may be followed into. */
const HELPER = /^(?:(?:apps|packages)\/[^/]+\/)?test\//;
/** The probe's own modules name every service and dial none. */
const NOT_FOLLOWED = new Set(["test/support/services.ts", "test/support/service-needs.mjs"]);

const posixRel = (root, abs) => relative(root, abs).split("\\").join("/");

/** The markers in a file's comments: `none` (with its reason) and the services added. */
export function markersOf(raw, rel = "") {
  const out = { none: false, add: [] };
  for (const m of raw.matchAll(MARKER)) {
    const text = m[1].trim();
    if (/^none\b/.test(text)) {
      if (!/^none\s*[—–-]+\s*\S/.test(text)) throw new Error(`${rel}: @services: none needs its reason (@services: none — <why>)`);
      out.none = true;
      continue;
    }
    for (const name of text.split(/[\s,]+/).filter(Boolean)) {
      if (!SERVICES.includes(name)) throw new Error(`${rel}: @services: ${name} is not a test service (${SERVICES.join(", ")})`);
      out.add.push(name);
    }
  }
  return out;
}

/** The services a source text names in its own code, and the ones it gates itself. */
export function ownSignals(raw, rel = "") {
  const src = code(raw);
  const needs = new Set();
  for (const [name, res] of Object.entries(SIGNALS)) if (res.some((re) => re.test(src))) needs.add(name);
  for (const [name, re] of Object.entries(NAME_SIGNALS)) if (re.test(rel)) needs.add(name);
  if (DOVECOT_OWN.some((re) => re.test(src))) needs.add("dovecot");
  const gated = new Set();
  for (const [name, re] of Object.entries(GATES)) if (re.test(src)) gated.add(name);
  for (const m of src.matchAll(SERVICE_UP_CALL)) gated.add(m[1]);
  const marks = markersOf(raw, rel);
  if (marks.none) needs.clear();
  for (const name of marks.add) needs.add(name);
  return { src, needs, gated };
}

/** The relative imports of a source, resolved to repo-relative files that exist. */
export function relativeImports(src, rel, root) {
  const out = [];
  for (const m of src.matchAll(IMPORT)) {
    const spec = m[1] ?? m[2] ?? m[3];
    const base = posix.normalize(posix.join(posix.dirname(rel), spec)).replace(/\.(?:m?js|jsx)$/, "");
    const hit = [base, `${base}.ts`, `${base}.tsx`, `${base}.mts`, `${base}.mjs`, `${base}.js`, `${base}/index.ts`]
      .find((c) => /\.(?:[cm]?[jt]sx?)$/.test(c) && existsSync(join(root, c)));
    if (hit !== undefined) out.push(hit);
  }
  return out;
}

/**
 * A file's needs, its own and its helpers' (Dovecot its own only); `gated`, the services it checks
 * for itself; `gate`, what the runner checks for it. `rel` is repo-relative, `\` or `/`.
 */
export function classify(rel, root, memo = new Map()) {
  rel = rel.split("\\").join("/");
  const own = ownSignals(readFileSync(join(root, rel), "utf8"), rel);
  const needs = new Set(own.needs);
  for (const name of helperNeeds(rel, own.src, root, memo, new Set([rel]))) needs.add(name);
  const gated = [...own.gated].filter((s) => needs.has(s)).sort();
  return { needs: [...needs].sort(), gated, gate: [...needs].filter((s) => !own.gated.has(s)).sort() };
}

function helperNeeds(rel, src, root, memo, seen) {
  const out = new Set();
  for (const dep of relativeImports(src, rel, root)) {
    if (!HELPER.test(dep) || NOT_FOLLOWED.has(dep) || seen.has(dep)) continue;
    seen.add(dep);
    if (!memo.has(dep)) {
      const o = ownSignals(readFileSync(join(root, dep), "utf8"), dep);
      const n = new Set([...o.needs].filter((s) => s !== "dovecot"));
      for (const s of helperNeeds(dep, o.src, root, memo, seen)) n.add(s);
      memo.set(dep, n);
    }
    for (const s of memo.get(dep)) out.add(s);
  }
  return out;
}

/** {@link classify} for an absolute path (the runner's), under `root`. */
export function classifyPath(abs, root, memo) {
  return classify(posixRel(root, abs), root, memo);
}

/**
 * A HOME-MADE PROBE: a file deciding for itself whether a service is up, instead of reading the run's
 * one probe — a function named like one, an awaited connect at the top level, or a raw connect to a
 * service's address. Returns the shape found, or null.
 */
export function homeMadeProbe(raw) {
  const src = code(raw);
  const named = /\b(?:function\s+(imapAnswers|imapUp|greenmailUp|serverUp|rustfsAvailable|up)\s*\(|(?:const|let)\s+(imapAnswers|imapUp|greenmailUp|serverUp|rustfsAvailable|up)\s*=\s*(?:async\b|\())/.exec(src);
  if (named) return `a probe function ${named[1] ?? named[2]}()`;
  if (/^(?:export\s+)?const\s+\w+\s*=\s*await\s*\(\s*async\s*\(\s*\)\s*=>\s*\{[^]*?\.connect\(/m.test(src)) return "an awaited top-level connect";
  if (/\b(?:net\.connect|netConnect|createConnection|connect)\(\s*\{\s*host:\s*(?:HOST|GM|IMAP_HOST|GREENMAIL\.host|DOVECOT\.host|CONDSTORE_HOST)\b/.test(src)) {
    return "a raw connect to a service address";
  }
  return null;
}
