import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { lineOf, withoutComments, withoutCommentsAndLiterals } from "../scripts/lib/source-scan.mjs";

/**
 * EVERY JS READER OF A RULE'S `match` KEYS IT THROUGH `ruleMatchKey` — spaces only, the router's
 * and the queue SQL's `trim`. Seven client and server readers stripped every whitespace instead,
 * so a match padded with a tab read as that sender's there and nobody's on the router. This walks
 * every source root of every app and package; SQL text is blanked, the SQL half is not its subject.
 */
const ROOT = join(import.meta.dirname, "..");
const SOURCE_DIRS = ["src", "app", "lib"];
const SKIP = new Set(["node_modules", "dist", "build", ".next", "test"]);

/** The other trims of a `match`: its own `.trim*()`, a parenthesised one, or `senderKey`'s. */
const OTHER_TRIM = [
  /\.match\s*\??\.\s*trim(?:Start|End)?\s*\(/g,
  /\.match\s*(?:\?\?[^()]*)?\)\s*\??\.\s*trim(?:Start|End)?\s*\(/g,
  /(?<![\w$.])match\s*\??\.\s*trim(?:Start|End)?\s*\(/g,
  /\bsenderKey\s*\(\s*[\w$.!?[\]]*\.match\s*\)/g,
];

/**
 * Other trims a file is admitted, by file and count. None since the writers store the key: every
 * rule writer keys its match through `ruleMatchKey` ({@link KEYED_WRITERS}), never a trim of its own.
 */
const WRITE_NORMALIZERS: Readonly<Record<string, number>> = {};

/** The rule writers, each storing a sender/domain match as `ruleMatchKey` keys it. */
const KEYED_WRITERS = [
  "packages/db/src/request-apply.ts", "packages/services/src/rules-service.ts",
  "packages/services/src/hey-migration.ts", "packages/services/src/learning-service.ts",
  "packages/core/src/adapters/organizer-profile-store.ts",
];

/** Each hit as `file:line`, over one source text with comments and literals blanked. */
export function otherTrims(rel: string, src: string): string[] {
  const code = withoutCommentsAndLiterals(src);
  const at = new Set<number>();
  for (const re of OTHER_TRIM) for (const m of code.matchAll(re)) at.add(m.index!);
  return [...at].sort((a, b) => a - b).map((i) => `${rel}:${lineOf(code, i)}`);
}

/** The census over a tree: every hit, less each named normalizer's own count. */
export function census(files: ReadonlyMap<string, string>): string[] {
  const out: string[] = [];
  for (const [rel, src] of files) {
    const hits = otherTrims(rel, src);
    if (hits.length === (WRITE_NORMALIZERS[rel] ?? 0)) continue;
    out.push(...hits);
  }
  return out;
}

/**
 * THE SQL HALF: a `match` is keyed in SQL only by `ruleMatchKeySql`, the builder's one
 * `trim(lower(…))`. Eleven readers spelled `lower(match)` untrimmed, so a padded rule named its
 * sender on the router and nobody on the auto-apply pass or the press's twin retarget. SQL text is
 * read (comments blanked, a `-- ` SQL comment too); a column or a JSON field named `match`.
 */
const SQL_OTHER_KEY = [
  /\b(?:lower|trim)\s*\(\s*(?:\$\{\s*)?[\w$.]*\bmatch\s*\}?\s*\)/g,
  /\b(?:lower|trim)\s*\(\s*\$\{[^}]*["'`]match["'`][^}]*\}\s*\)/g,
];
// `health-markers.ts` holds the rules index's `/health` needle: what Postgres prints for the
// builder's key in `pg_indexes.indexdef` (mail 0144), a probe of the index, never a query. (Mail
// 0136's index repeated it for enabled rules alone and left with mail 0202, and its needle with it.)
const SQL_KEY_OWNERS: Readonly<Record<string, number>> = {
  "packages/db/src/rule-match-sql.ts": 1, "packages/api/src/routes/health-markers.ts": 1,
};

/**
 * A RAW-BYTE `eq(<table>.match, …)` found one row by its bytes, so a padded or re-cased row was a
 * different rule to it and the same rule to the router. Identity reads compare key to key
 * (`ruleMatchKeySql` against the key), and none is admitted.
 */
const RAW_MATCH_EQ = /\beq\s*\(\s*[\w$]+\.match\s*,/g;
const IDENTITY_LOOKUPS: Readonly<Record<string, number>> = {};
/**
 * The identity reads that used to compare bytes, each now asking the builder. The applier's, the
 * HEY import's and the learning promotion's key lookups are `rule-key.ts`'s `findRulesByKey`
 * since every writer converges.
 */
const KEYED_IDENTITY_READS = [
  "packages/db/src/rule-key.ts", "packages/db/src/learning-signal.ts",
];

export function rawMatchEqs(rel: string, src: string): string[] {
  const code = withoutCommentsAndLiterals(src);
  return [...code.matchAll(RAW_MATCH_EQ)].map((m) => `${rel}:${lineOf(code, m.index!)}`);
}

export function identityCensus(files: ReadonlyMap<string, string>): string[] {
  const out: string[] = [];
  for (const [rel, src] of files) {
    const hits = rawMatchEqs(rel, src);
    if (hits.length === (IDENTITY_LOOKUPS[rel] ?? 0)) continue;
    out.push(...hits);
  }
  return out;
}

/** Each SQL spelling as `file:line`, comments (both languages) blanked, positions kept. */
export function sqlKeyings(rel: string, src: string): string[] {
  const code = withoutComments(src).replace(/(^|\s)--\s[^\n]*/g, (m) => m.replace(/[^\n]/g, " "));
  const at = new Set<number>();
  for (const re of SQL_OTHER_KEY) for (const m of code.matchAll(re)) at.add(m.index!);
  return [...at].sort((a, b) => a - b).map((i) => `${rel}:${lineOf(code, i)}`);
}

export function sqlCensus(files: ReadonlyMap<string, string>): string[] {
  const out: string[] = [];
  for (const [rel, src] of files) {
    const hits = sqlKeyings(rel, src);
    if (hits.length === (SQL_KEY_OWNERS[rel] ?? 0)) continue;
    out.push(...hits);
  }
  return out;
}

/** The SQL readers the builder replaced a spelling in — each in the walk, each asking it. */
const SQL_READERS = [
  "apps/worker/src/gate-release.ts",
  "apps/worker/src/screener-correspondent-retro.ts", "packages/db/src/screener-apply.ts",
  "packages/db/src/screener-cutline.ts", "packages/db/src/own-mail.ts",
  "packages/services/src/sensitive-rescreen.ts", "packages/services/src/consent-seed.ts",
  "packages/services/src/consent-cutline.ts", "packages/services/src/screener-service.ts",
  "packages/services/src/held-release-service.ts", "packages/core/src/adapters/drizzle-repo.ts",
  "packages/api/src/junk-window.ts",
];

function walk(dir: string, out: Map<string, string>): void {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(?:[cm]?[jt]s|tsx)$/.test(e.name) && !/\.d\.[cm]?ts$/.test(e.name)) {
      out.set(relative(ROOT, p), readFileSync(p, "utf8"));
    }
  }
}

function tree(): Map<string, string> {
  const out = new Map<string, string>();
  for (const top of ["apps", "packages"]) {
    for (const pkg of readdirSync(join(ROOT, top), { withFileTypes: true })) {
      if (!pkg.isDirectory()) continue;
      for (const d of SOURCE_DIRS) {
        const dir = join(ROOT, top, pkg.name, d);
        if (existsSync(dir)) walk(dir, out);
      }
    }
  }
  return out;
}

/** The readers this census exists for — each must be in the walk and read the key. */
const READERS = [
  "packages/client-engine/src/press-forecast.ts", "packages/client-engine/src/rule-twins.ts",
  "packages/client-engine/src/address-rank.ts", "packages/client-engine/src/selectors.ts",
  "packages/services/src/consent-seed.ts", "apps/worker/src/rule-retro.ts",
  "apps/worker/src/screener-correspondent-retro.ts", "packages/app-logic/src/press/sender-audit.ts",
  "apps/mobile/src/state/live.ts",
];

describe("a rule's match is keyed in SQL only by ruleMatchKeySql", () => {
  const files = tree();

  it("no SQL text keys a match any other way", () => {
    expect(sqlCensus(files)).toEqual([]);
  });

  it("POSITIVE CONTROL: the owning module reads its one spelling, and every replaced reader asks the builder", () => {
    const owner = "packages/db/src/rule-match-sql.ts";
    expect(sqlKeyings(owner, files.get(owner)!)).toHaveLength(1);
    for (const rel of SQL_READERS) {
      expect(files.has(rel), `${rel} is not in the walk`).toBe(true);
      expect(withoutCommentsAndLiterals(files.get(rel)!), rel).toMatch(/\bruleMatchKeySql\s*\(|\bruleNamesSenderSql\s*\(/);
    }
  });

  it("a planted spelling reads red, in a reader and beside the owning module's own", () => {
    const planted = new Map(files);
    const reader = SQL_READERS[0]!;
    planted.set(reader, `${files.get(reader)!}\nconst twin = sql\`lower(r.match) = lower(\${x})\`;\n`);
    const owner = "packages/db/src/rule-match-sql.ts";
    planted.set(owner, `${files.get(owner)!}\nconst again = (match: SQL) => sql\`lower(\${match})\`;\n`);
    const found = sqlCensus(planted);
    expect(found.some((h) => h.startsWith(`${reader}:`))).toBe(true);
    expect(found.filter((h) => h.startsWith(`${owner}:`))).toHaveLength(2);
  });

  it("no source finds a rule by a raw-byte eq on its match", () => {
    expect(identityCensus(files)).toEqual([]);
    for (const rel of KEYED_IDENTITY_READS) {
      expect(rawMatchEqs(rel, files.get(rel)!), rel).toEqual([]);
      expect(withoutCommentsAndLiterals(files.get(rel)!), rel).toMatch(/\bruleMatchKeySql\s*\(/);
    }
    const planted = new Map(files);
    const reader = "packages/api/src/junk-window.ts";
    planted.set(reader, `${files.get(reader)!}\nconst w = eq(rulesTbl.match, addr);\n`);
    expect(identityCensus(planted)).toEqual([`${reader}:${files.get(reader)!.split("\n").length + 1}`]);
    expect(rawMatchEqs("x.ts", "// eq(r.match, a)\nconst b = eq(rules.matches, a);\n")).toEqual([]);
  });

  it("each SQL shape is caught, and an address, the builder and a comment are not", () => {
    const shapes = [
      "sql`lower(r.match) = x`", "sql`trim(lower(rg.match)) = x`", "sql`lower(${rulesTbl.match}) = x`",
      "sql`select lower(match) m from rules`", "sql`lower(${field(\"match\")}) = x`", "sql`lower(trim(r.match))`",
    ];
    for (const t of shapes) expect(sqlKeyings("x.ts", `const a = ${t};\n`), t).toHaveLength(1);
    const admitted = [
      "sql`lower(${messages.fromAddress}) = x`", "sql`lower(ls.sender_address) = ${ruleMatchKeySql(rulesTbl.match)}`",
      "sql`${ruleNamesSenderSql(d, { kind: sql`r.kind`, match: sql`r.match` }, s)}`", "s.match(/x/)",
      "sql`lower(r.subjectMatch)`",
    ];
    for (const t of admitted) expect(sqlKeyings("x.ts", `const a = ${t};\n`), t).toEqual([]);
    expect(sqlKeyings("x.ts", "// lower(r.match)\nconst q = sql`\n  -- lower(match) is the old spelling\n  select 1`;\n")).toEqual([]);
  });
});

describe("a rule's match is trimmed only by ruleMatchKey", () => {
  const files = tree();

  it("no JS source trims a match any other way", () => {
    expect(census(files)).toEqual([]);
  });

  it("POSITIVE CONTROL: the readers are in the walk and read the key through the same path", () => {
    for (const rel of READERS) {
      expect(files.has(rel), `${rel} is not in the walk`).toBe(true);
      expect(withoutCommentsAndLiterals(files.get(rel)!), rel).toMatch(/\bruleMatchKey\s*\(/);
    }
    for (const rel of KEYED_WRITERS) {
      expect(files.has(rel), `${rel} is not in the walk`).toBe(true);
      expect(withoutCommentsAndLiterals(files.get(rel)!), rel).toMatch(/\bruleMatchKey\s*\(/);
      expect(otherTrims(rel, files.get(rel)!), rel).toEqual([]);
    }
  });

  it("a planted trim reads red, in a reader and in a writer", () => {
    const planted = new Map(files);
    const reader = READERS[0]!;
    planted.set(reader, `${files.get(reader)!}\nexport const twin = (r: { match: string }) => r.match.trim();\n`);
    const normalizer = "packages/db/src/request-apply.ts";
    planted.set(normalizer, `${files.get(normalizer)!}\nconst again = (o: { match: string }) => o.match.trim();\n`);
    const found = census(planted);
    expect(found.some((h) => h.startsWith(`${reader}:`))).toBe(true);
    expect(found.filter((h) => h.startsWith(`${normalizer}:`))).toHaveLength(1);
  });

  it("each shape is caught, and the key, a comment, a string and String#match are not", () => {
    const shapes = [
      "r.match.trim().toLowerCase()", "g.rule.match.trimStart()", "(r.match ?? \"\").trim()",
      "rule.match?.trim()", "senderKey(r.match)", "senderKey(wide[0]!.match)", "match.trim()",
    ];
    for (const s of shapes) expect(otherTrims("x.ts", `const a = ${s};\n`), s).toHaveLength(1);
    const admitted = [
      "ruleMatchKey(r.match)", "r.match.toLowerCase()", "\"r.match.trim()\"", "`r.match.trim()`",
      "s.match(/x/)", "senderKey(r.from.address)", "x.matches.trim()",
    ];
    for (const s of admitted) expect(otherTrims("x.ts", `const a = ${s};\n`), s).toEqual([]);
    expect(otherTrims("x.ts", "// r.match.trim()\n/* senderKey(r.match) */\n")).toEqual([]);
  });

  it("ruleMatchKey has one definition, and the drain's one pinned copy", () => {
    const defs = [...files].filter(([, src]) =>
      /\bfunction\s+ruleMatchKey\b|\bconst\s+ruleMatchKey\s*=/.test(withoutCommentsAndLiterals(src)));
    // packages/db cannot import core, so its readers key through a copy that
    // packages/db/test/rule-match-key-twin.test.ts holds equal to this one (RULE_PRIORITY_MAX's rule).
    expect(defs.map(([rel]) => rel).sort()).toEqual(["packages/core/src/rule-order.ts", "packages/db/src/rule-match-sql.ts"]);
  });
});
