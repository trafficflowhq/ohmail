import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import ts from "typescript";

/**
 * ═══ ONE ANSWER TO "WHICH ENVIRONMENT AM I" ═══════════════════════════════════════════════════
 *
 * The organizer lease is scoped by environment on purpose: staging pointed at a production
 * mailbox is a DIFFERENT organizer, so the newcomer stands down instead of fighting for the
 * mailbox. That only works while every process in the fleet computes the environment the same
 * way, because the environment is half of the install id, and the install id is what a release
 * compares and what a claim removal matches on.
 *
 * ══ WHAT WENT WRONG, MEASURED ═════════════════════════════════════════════════════════════════
 *
 * The chain `TF_ENV ?? RAILWAY_ENVIRONMENT_NAME ?? "production"` was written out four times. Two
 * of the copies — the junk sweep and the redacted restore, both of which CLAIM THE LEASE to do
 * their repair — read `process.env.TF_ENVIRONMENT`, a variable spelled nowhere else in the repo
 * and therefore always undefined. Both fell through to `"production"` on every deployment. On
 * staging, that is a repair command taking the lease under a different identity than the worker
 * it is repairing for: `assertNoLiveTwin` compares the wrong id, and the claim it renews is not
 * the claim the worker holds.
 *
 * Nothing failed loudly. A typo in an environment variable name has no compile error, no runtime
 * error and no log line — it is indistinguishable from the variable being unset, which is the
 * normal case in production, which is where it was tested.
 *
 * ══ THE RULE ══════════════════════════════════════════════════════════════════════════════════
 *
 * `organizerEnvironment` in `packages/core/src/organizer-install.ts` is the ONLY place these
 * variable names may be read. Everything that needs the organizer's environment calls it.
 *
 * The two entries in `LABEL_READERS` are a different question that uses one of the same names,
 * and they are named here rather than quietly skipped so the distinction survives: they derive
 * the DEPLOYMENT'S OWN LABEL for configuration and logging (`TF_ENV || VERCEL_ENV`), which is not
 * the organizer's environment and must never be turned into an install id. If you find yourself
 * wanting to pass one of those values to `cloudInstallId`, that is the bug this file exists for —
 * call `resolveCloudInstallId(process.env)` instead.
 */

/* THE OVERRIDE IS PART OF THE IDENTITY, so it belongs in the same census as the environment.
   Leaving it out is what let `config.ts` read it with a truthy test while `resolveCloudInstallId`
   rejected a whitespace-only value — one variable, two predicates, two identities in one fleet. */
const NAMES = ["TF_ENV", "RAILWAY_ENVIRONMENT_NAME", "TF_ENVIRONMENT", "TF_ORGANIZER_INSTALL_ID"] as const;

/** The one function allowed to read them. */
const CANONICAL = "packages/core/src/organizer-install.ts";

/**
 * Files that read one of these names for the DEPLOYMENT LABEL rather than for the organizer
 * identity. Each is a `TF_ENV || VERCEL_ENV` pair feeding a config field, never an install id.
 */
const LABEL_READERS = new Set([
  "apps/api-vercel/src/config.ts",
  "apps/server/src/config.ts",
]);

/* `PROSE_FILES` IS GONE, and its absence is the measure of the change below.
   The text-scanning census could not tell `process.env["TF_ENV"]` from a commit message that
   mentions TF_ENV, so a catalogue of published prose had to be exempted by name. Reading the
   ACCESS instead of the text makes the distinction structural: a string is only a read when it
   is the argument of an element access on an environment object. Nothing needs exempting. */


/* `scripts/` IS SOURCE. A deploy script or a one-off that claims the lease under a hand-rolled
   identity does exactly the damage this census is about, and the walk did not look there. */
const ROOTS = ["apps", "packages", "scripts"];
const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".next", "coverage", "test", "__tests__"]);

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) { sources(full, out); continue; }
    if (/\.(ts|tsx|mts|mjs|js|cjs)$/.test(name) && !/\.(test|spec)\./.test(name)) out.push(full);
  }
  return out;
}

/**
 * ═══ THE PARSER ANSWERS THIS, NOT A PATTERN ═══════════════════════════════════════════════════
 *
 * Three attempts to decide "is this text code or a comment" by hand, three defects:
 *
 *  1. Raw text matching — failed on the COMMENT in `config.ts` that explains the `TF_ENVIRONMENT`
 *     typo, so the census failed on the documentation of the thing it guards.
 *  2. Two regexes — ERASED CODE: a bare `//` inside a string blanked the rest of the line, taking
 *     any real read after it.
 *  3. A hand-written scanner tracking strings, templates and comments — erased code too, one
 *     level subtler. `const r = /'/; const s = '//'; process.env.TF_ENV` made the regex
 *     literal's quote open a string, the real string's quote close it, and the `//` inside that
 *     string read as a comment: the prohibited access vanished and the census passed. That exact
 *     line is a fixture below.
 *
 * Each fix was a better lexer than the last and each was still a lexer written from memory of a
 * grammar. TypeScript ships the real one and is already a dependency, so this asks IT.
 *
 * The win is not only comments. An AST distinguishes an ACCESS from a MENTION, which no amount of
 * text stripping can: `process.env["TF_ENV"]` is a read and the same characters inside a commit
 * message are not. That is why the exemption list above could be deleted rather than extended.
 *
 * What counts as a read, deliberately including the indirect spellings a word search misses:
 *  · `x.TF_ENV`            — property access, however the object is spelled
 *  · `x["TF_ENV"]`         — element access with a literal key
 *  · `const { TF_ENV } = …` — destructuring, named or renamed
 *  · `read(env, "TF_ENV")`  — the name handed to a helper, which is how `apps/server` does it
 *                             and which the first cut of this walk missed entirely: it reported
 *                             that file as reading nothing, and the exemption-staleness check
 *                             below is what caught that. A guard checking its own exemptions is
 *                             worth the eight lines.
 */
interface Read { name: string; line: number }

function envReads(src: string, fileName: string): Read[] {
  const sf = ts.createSourceFile(fileName, src, ts.ScriptTarget.Latest, true);
  const hits: Read[] = [];
  const watched = new Set<string>(NAMES);
  const at = (node: ts.Node): number =>
    sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;

  /* `const NAME = "literal"` in this file, so a computed access can be resolved back to a name. */
  const constStrings = new Map<string, string>();
  const collect = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)
      && node.initializer && ts.isStringLiteralLike(node.initializer)) {
      constStrings.set(node.name.text, node.initializer.text);
    }
    ts.forEachChild(node, collect);
  };
  collect(sf);

  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) && watched.has(node.name.text)) {
      hits.push({ name: node.name.text, line: at(node) });
    } else if (ts.isElementAccessExpression(node) && node.argumentExpression) {
      const arg = node.argumentExpression;
      /* A COMPUTED KEY IS STILL A KEY, and this is where the parser was WORSE than the text
         search it replaced: `const key = "TF_ENV"; process.env[key]` has no watched name at the
         access, so an AST that looks only at the access sees nothing, while a word search over
         the file saw it. Trading one blind spot for another is not an improvement — so the
         file's own `const NAME = "…"` bindings are resolved first and the access is matched
         through them. */
      const key = ts.isStringLiteralLike(arg)
        ? arg.text
        : ts.isIdentifier(arg) ? constStrings.get(arg.text) : undefined;
      if (key !== undefined && watched.has(key)) hits.push({ name: key, line: at(node) });
    } else if (ts.isCallExpression(node)) {
      /* A NAME HANDED TO A HELPER IS A READ — but only when the call is about the environment.
         The first cut flagged ANY call argument, so `console.log("TF_ENV is a typo")` counted.
         The call must also carry the environment itself, which is what `trimmed(env, "TF_ENV")`
         and every other helper of this shape does. */
      const envish = node.arguments.some((a) =>
        (ts.isIdentifier(a) && /^(env|process)$/i.test(a.text))
        || (ts.isPropertyAccessExpression(a) && a.name.text === "env"));
      if (envish) {
        for (const arg of node.arguments) {
          if (ts.isStringLiteralLike(arg) && watched.has(arg.text)) {
            hits.push({ name: arg.text, line: at(arg) });
          }
        }
      }
    } else if (ts.isBindingElement(node)) {
      const key = node.propertyName && ts.isIdentifier(node.propertyName)
        ? node.propertyName.text
        : ts.isIdentifier(node.name) ? node.name.text : undefined;
      if (key !== undefined && watched.has(key)) hits.push({ name: key, line: at(node) });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}

describe("the organizer's environment is derived in exactly one place", () => {
  it("no source file outside the canonical function reads TF_ENV, RAILWAY_ENVIRONMENT_NAME or TF_ENVIRONMENT", () => {
    const repoRoot = process.cwd().endsWith("/test") ? join(process.cwd(), "..") : process.cwd();
    const offenders: string[] = [];
    let scanned = 0;

    for (const root of ROOTS) {
      let files: string[];
      try { files = sources(join(repoRoot, root)); } catch { continue; }
      for (const file of files) {
        const rel = relative(repoRoot, file);
        if (rel === CANONICAL || LABEL_READERS.has(rel)) continue;
        scanned += 1;
        for (const hit of envReads(readFileSync(file, "utf8"), file)) {
          offenders.push(`${rel}:${hit.line} reads ${hit.name}`);
        }
      }
    }

    // ANTI-VACUITY. A census that walked nothing reports the same clean result as a clean repo —
    // which is how a hand-maintained file list passes for months. Assert it actually looked.
    expect(scanned, "the census walked no source files, so its verdict means nothing")
      .toBeGreaterThan(200);

    expect(offenders, "call organizerEnvironment() / resolveCloudInstallId(process.env) instead")
      .toEqual([]);
    // A parse of every source file, no wait of its own: up to 4.8 s on the CI VMs, 120 s under 10% of a CPU.
  }, 180_000);

  it("the canonical function and the two label readers still exist, so the exemptions are not stale", () => {
    const repoRoot = process.cwd().endsWith("/test") ? join(process.cwd(), "..") : process.cwd();
    const canonical = readFileSync(join(repoRoot, CANONICAL), "utf8");
    expect(canonical, "the canonical file no longer derives the environment")
      .toContain("RAILWAY_ENVIRONMENT_NAME");
    for (const rel of LABEL_READERS) {
      const abs = join(repoRoot, rel);
      expect(envReads(readFileSync(abs, "utf8"), abs).length,
        `${rel} is exempted but no longer reads any of these — drop it from LABEL_READERS`)
        .toBeGreaterThan(0);
    }
  });
});

/* ══ THE ATTACK STRINGS, AS FIXTURES ═══════════════════════════════════════════════════════════
 *
 * Each of these defeated one of the three hand-written strippers this walk replaced. They are
 * here so the next person who is tempted to "simplify" the parser away has to make them pass
 * first. The prose cases matter as much as the code ones: a census that shouts about a comment
 * gets weakened until it stops shouting, and then it stops guarding.
 */
describe("the parser, on the strings that beat every hand-written stripper", () => {
  const READS = [
    ["a regex literal whose quote opened a phantom string, then // inside a real one",
     String.raw`const r = /'/; const s = '//'; process.env.TF_ENV`],
    ["a bare // inside a string, which the two-regex stripper blanked to end of line",
     `const s = "a // b"; process.env.TF_ENV;`],
    ["an element access with a literal key, which no word search over stripped text sees as a read",
     `process.env["TF_ENV"];`],
    ["a renamed destructure", `const { TF_ENV: e } = process.env;`],
    ["the name handed to a helper", `const v = trimmed(env, "TF_ENV");`],
    ["a computed key, which the PARSER missed and the text search caught",
     `const key = "TF_ENV"; const v = process.env[key];`],
    ["a division that looks like the start of a regex", `const x = a / b; process.env.TF_ENV;`],
    ["a template literal holding a quote and a slash", "const t = `it's //`; process.env.TF_ENV;"],
  ] as const;

  const QUIET = [
    ["a line comment naming the variable", `// TF_ENVIRONMENT was a typo for TF_ENV\nconst a = 1;`],
    ["a block comment naming it", `/* explains TF_ENV and TF_ORGANIZER_INSTALL_ID */\nconst a = 1;`],
    ["prose in a template literal, which is what the exemption list used to exist for",
     "const msg = `the setting TF_ORGANIZER_INSTALL_ID was read two ways`;"],
    ["a JSDoc naming it", `/** @see TF_ENV */\nexport const a = 1;`],
    ["the name as an argument to something that is not about the environment",
     `console.log("TF_ENVIRONMENT was a typo for TF_ENV");`],
  ] as const;

  for (const [what, src] of READS) {
    it(`finds the read: ${what}`, () => {
      expect(envReads(src, "probe.ts").map((h) => h.name)).toContain("TF_ENV");
    });
  }

  for (const [what, src] of QUIET) {
    it(`stays quiet: ${what}`, () => {
      expect(envReads(src, "probe.ts")).toEqual([]);
    });
  }
});
