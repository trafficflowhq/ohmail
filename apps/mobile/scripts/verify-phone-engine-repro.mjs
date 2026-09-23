#!/usr/bin/env node
/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  THE PHONE ENGINE THAT SHIPS IS THE ENGINE THAT WAS MEASURED — the gate, in the tree that ships
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 *     OHMAIL_ESBUILD_FROM=<dir> node apps/mobile/scripts/verify-phone-engine-repro.mjs
 *
 * The app carries its mail engine as one pre-bundled file, and everything anybody knows about that
 * file — how big it is, which of this repository's sources ship inside it, that it names no build
 * machine — was measured where the bundle is built. This runs the same readings HERE, against the
 * artifact this tree just produced, because a build is only as honest as the tree it was made in:
 * how a tree resolves its own packages decides which files the bundler reads, so two trees at one
 * commit can build two different artifacts and a reading of one says nothing about the other. The
 * four readings travel with the build.
 *
 *   1. DETERMINISM. The same source, built twice here, byte for byte — and the artifact on disk is
 *      one of those bytes-for-bytes, so what ships is what was read.
 *   2. THE SIZE CEILING. The bundle rides inside every APK and IPA.
 *   3. THE DIALECT ARM, at ZERO. Every source file whose bytes reach the bundle, censused for a
 *      construct only the server's store accepts — on a phone the store is SQLite, and one of
 *      those is a statement that fails or, worse, answers a different question.
 *   4. THE SENTINELS. No build machine's paths, no `node:` builtin left to resolve at load, and
 *      exactly the two native modules left for the app's bundler.
 *
 * It BUILDS rather than finds, twice, and refuses an absent artifact instead of skipping: a gate
 * with no subject reports a pass.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import aliases from "../../sidecar/src/phone/aliases.js";
import {
  BUNDLE,
  MACHINE_PATH_PREFIXES,
  PACKAGED_DIR,
  REPO,
  TYPES,
  buildPhoneEngine,
  externalsIn,
  nodeSpecifiersIn,
} from "./bundle-engine.mjs";

/**
 * THE CEILING, MIRRORED from the packaging check that owns the number and states what raising it
 * means. It is repeated here because that check does not travel with the published tree and this
 * gate must still have a ceiling; the two are asserted equal, so they cannot drift apart.
 */
export const SIZE_CEILING = 6_880_000;

/**
 * The floor under it, for the same reason the ceiling has one: a truncated or half-written bundle
 * is comfortably under any ceiling, and a size check that only looks up passes it.
 */
export const SIZE_FLOOR = Math.round(SIZE_CEILING * 0.6);

/* ── the dialect tables ───────────────────────────────────────────────────────────────────── */

/**
 * THE CONSTRUCTS THE TWO STORES SPELL DIFFERENTLY, mirrored from the census that owns them,
 * where every pattern's reasoning is written down.
 *
 * They are repeated here because the census is a test and tests do not travel with the published
 * tree, while this reading has to run exactly where the artifact nobody has measured is built.
 * Both tables are asserted identical to that census's, pattern by pattern, AND the two counters
 * are compared file by file over the real bundle — so a
 * table edited in one place and not the other is red rather than quietly weaker here.
 *
 * Split by SUBJECT: a builder call renders its clause without ever spelling it, so it is read over
 * the file with comments blanked; everything else is read over the SQL the file emits, where there
 * is no prose and no JavaScript to be confused by.
 */
export const DIALECT_TOKENS = {
  "for(update) builder": /\.for\(\s*["'](?:update|share|no key update|key share)["']/gi,
  "skipLocked builder": /\.for\(\s*["'][^"']*["']\s*,\s*\{[^}]*skipLocked\s*:\s*true|(?<![.\w])skipLocked\s*\(/g,
  "distinctOn builder": /\b(?:select)?[Dd]istinctOn\s*\(/g,
  "raw execute": /\b(?:db|tx)\.execute\s*(?:<[^()]*?>)?\s*\((?!\s*pgOnly\s*\()/g,
};

/** @see DIALECT_TOKENS — the same table, read over the SQL a file emits rather than over the file. */
export const SQL_CONTEXT_TOKENS = {
  "FOR UPDATE": /\bfor\s+(?:update|share|no\s+key\s+update|key\s+share)\b/gi,
  "SKIP LOCKED": /\bskip\s+locked\b/gi,
  "pg_advisory": /pg_advisory\w*/g,
  "pg_notify": /pg_notify/g,
  "cast": /::\s*"?[a-z][a-z_ ]*"?(?:\[\])?/g,
  "ILIKE": /\bilike\b/gi,
  "now()": /\bnow\(\)/g,
  "INTERVAL": /\binterval\s+'/gi,
  "DISTINCT ON": /\bdistinct\s+on\b/gi,
  "to_tsvector": /to_tsvector|tsvector|websearch_to_tsquery|ts_rank|to_tsquery/g,
  "ON CONFLICT ON CONSTRAINT": /on\s+conflict\s+on\s+constraint/gi,
  "word_similarity": /word_similarity/g,
  "xmax": /\bxmax\b/g,
  "pg-only function": /\b(?:date_trunc|age|make_interval|greatest|least|gen_random_uuid|uuid_generate_v\d|array_agg|array_length|string_agg|string_to_array|bool_or|bool_and|strpos|to_char|btrim|char_length|left|right|overlay|to_timestamp|regexp_replace|regexp_matches|unnest|generate_series|jsonb_object_keys|jsonb_array_elements|jsonb_each|jsonb_build_object|jsonb_agg|to_jsonb|jsonb_set|jsonb_insert|jsonb_strip_nulls|row_to_json|to_regprocedure)\s*\(|extract\s*\(\s*epoch|=\s*any\s*\(/gi,
  "pg-only operator": /@>|<@|#>>|#>|\?\||\?&|!~\*?|~\*/g,
  "regex match (~)": /(?<![!~])~(?![~*])/g,
  "json key exists (?)": /\?\s*'/g,
  "position(x in y)": /\bposition\s*\([^()]*\bin\b/gi,
  "substring(x from n)": /\bsubstring\s*\([^()]*\bfrom\b/gi,
};

/** The seam whose job is knowing the difference, and the two modules a device never runs. */
export const DIALECT_EXEMPT =
  /^packages\/db\/src\/(?:dialect\/|baseline\.ts$|mailbox-dedup\.ts$)/;

/**
 * A file's source with every comment blanked out, same length and same lines.
 *
 * A scanner rather than a regular expression: a `//` inside a string literal is not a comment, and
 * truncating the line there would hide the rest of it. Blanking rather than deleting is what lets
 * the query scan run over this and still name real positions.
 */
export function stripComments(source) {
  let out = "";
  let i = 0;
  const blank = (from, to) => {
    for (let k = from; k < to; k++) out += source[k] === "\n" ? "\n" : " ";
  };
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end === -1 ? source.length : end + 2;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (ch === "/" && next === "/") {
      const end = source.indexOf("\n", i);
      const stop = end === -1 ? source.length : end;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      out += ch;
      i++;
      while (i < source.length) {
        const c = source[i];
        out += c;
        i++;
        if (c === "\\") { if (i < source.length) { out += source[i]; i++; } continue; }
        if (c === quote) break;
      }
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * The text inside every `sql` tagged template, interpolations removed — and NOT the one template
 * that declares itself: `pgOnly(sql`…`)` is an arm reached only when the handle says Postgres, so
 * the construct in it never travels to a device. Everything else a template inserts is JavaScript
 * and is censused wherever it is written instead.
 */
export function sqlTemplates(raw) {
  const source = stripComments(raw);
  const out = [];
  // `sql.raw(`…`)` too: a raw string handed to the driver is SQL, as the census reads it.
  for (const m of source.matchAll(/\bsql(?:\.raw(?:\(\s*)?)?(?:<[^<>()]*>)?`/g)) {
    if (/pgOnly\(\s*$/.test(source.slice(Math.max(0, m.index - 40), m.index))) continue;
    let i = m.index + m[0].length;
    let text = "";
    let depth = 0;
    for (; i < source.length; i++) {
      const ch = source[i];
      if (ch === "\\") { i++; continue; }
      if (depth === 0 && ch === "`") break;
      if (ch === "$" && source[i + 1] === "{") { depth++; i++; continue; }
      if (depth > 0) {
        if (ch === "{") depth++;
        else if (ch === "}") depth--;
        continue;
      }
      text += ch;
    }
    out.push(text);
  }
  return out;
}

/** Count each construct in one file's source: the builder table over the code, the rest over its SQL. */
export function countTokens(source) {
  const out = {};
  const add = (name, hits) => {
    if (hits && hits.length > 0) out[name] = (out[name] ?? 0) + hits.length;
  };
  const code = stripComments(source);
  for (const [name, pattern] of Object.entries(DIALECT_TOKENS)) {
    add(name, code.match(new RegExp(pattern.source, pattern.flags)));
  }
  const queries = sqlTemplates(source).join("\n");
  for (const [name, pattern] of Object.entries(SQL_CONTEXT_TOKENS)) {
    add(name, queries.match(new RegExp(pattern.source, pattern.flags)));
  }
  return out;
}

/* ── what the bundle loads ────────────────────────────────────────────────────────────────── */

/** An input that belongs to this repository rather than to a dependency. */
const OWN_INPUT = /^(packages|apps)\/[^/]+\/(dist|src)\//;

/**
 * `packages/x/dist/a/b.js` → `packages/x/src/a/b.ts`; a `src` input is already its own source.
 *
 * THE MAPPING IS WHY THIS GATE IS WORTH RUNNING WHEREVER THE ENGINE IS BUILT. A tree whose
 * packages resolve through their build output and one whose packages resolve through their sources
 * hand the bundler different inputs for the same code, and this is where the two answers meet:
 * both become the source file, so the same census asks the same question of either artifact.
 */
export function sourceForInput(input) {
  if (!input.includes("/dist/")) return input;
  return input.replace("/dist/", "/src/").replace(/\.js$/, ".ts");
}

/**
 * The source files whose BYTES reached the bundle — not the files the bundler merely parsed.
 *
 * A barrel re-exports modules nothing uses; esbuild records them as inputs and ships none of their
 * code, and a construct in one of those never runs on a phone. `bytesInOutput` is the distinction.
 * The metafile comes from the build this process just ran, so it cannot describe another tree.
 */
export function loadedSources(metafile, root = REPO) {
  const keys = Object.keys(metafile.outputs ?? {});
  if (keys.length !== 1) {
    throw new Error(
      `this build recorded ${keys.length} outputs, so "the bundle" is ambiguous:\n` +
      keys.slice(0, 20).map((k) => `    ${k}`).join("\n"));
  }
  const shipped = new Set();
  for (const [input, record] of Object.entries(metafile.outputs[keys[0]].inputs ?? {})) {
    if (!OWN_INPUT.test(input)) continue;
    if ((record?.bytesInOutput ?? 0) > 0) shipped.add(sourceForInput(input));
  }
  return [...shipped]
    .filter((f) => !DIALECT_EXEMPT.test(f) && existsSync(join(root, f)))
    .sort();
}

/**
 * THE VACUOUS-GREEN GUARD, and it is the first thing the dialect arm asks.
 *
 * Every way of reading the artifact wrongly ends in the same place: a short list and a clean run.
 * So the size and two named members are checked before anything is measured — the two are files
 * the engine cannot run without, one from each of the packages that carry the store.
 */
export const DIALECT_FLOOR = 150;
export const DIALECT_ANCHORS = [
  "packages/core/src/adapters/drizzle-repo.ts",
  "packages/db/src/storage.ts",
];

/**
 * Every loaded file carrying a construct only the server accepts, cited by file and token.
 * Empty is the only admitted answer: the phone's store is SQLite and nothing here is grandfathered.
 */
export function dialectHits(loaded, root = REPO) {
  const carrying = [];
  for (const file of loaded) {
    const counts = countTokens(readFileSync(join(root, file), "utf8"));
    const names = Object.keys(counts);
    if (names.length === 0) continue;
    carrying.push(`${file} — ${names.map((t) => `${t} x${counts[t]}`).join(", ")}`);
  }
  return carrying;
}

/* ── the sentinels ────────────────────────────────────────────────────────────────────────── */

/**
 * EVERY MODULE THE ARTIFACT ASKS ITS HOST FOR, read off the artifact rather than off the graph.
 *
 * The metafile's `external` flag cannot answer this in both trees. A tree resolving through built
 * JavaScript records only real requires; a tree resolving through TypeScript SOURCE also
 * records an edge for every ERASED type-only import (`import { type Tx } from "…"`) — three of
 * them here — and a gate reading that flag would refuse the published tree's ordinary build for
 * imports that ship no code at all. What runs on a device is the `require` in the bytes, so that
 * is what is counted: this artifact is CommonJS, and a module it did not bundle is a call by name.
 */
export function requiresIn(text) {
  const found = new Set();
  for (const m of text.matchAll(/\brequire\(\s*"([^"]+)"\s*\)/g)) found.add(m[1]);
  return [...found].sort();
}

/** Every line naming a path only the machine that built this could have. */
export function machinePathsIn(text, root = REPO) {
  const needles = [...MACHINE_PATH_PREFIXES, `${root}/`];
  const hits = [];
  for (const [i, line] of text.split("\n").entries()) {
    for (const needle of needles) {
      if (line.includes(needle)) hits.push(`line ${i + 1}: ${line.slice(0, 120)}`);
    }
  }
  return hits;
}

/** The first difference between two builds, located — a gate that says only "they differ" is work. */
export function firstDifference(a, b) {
  if (a === b) return null;
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  const line = a.slice(0, i).split("\n").length;
  return {
    offset: i,
    line,
    first: a.slice(i, i + 120),
    second: b.slice(i, i + 120),
    lengths: [Buffer.byteLength(a), Buffer.byteLength(b)],
  };
}

/* ── the run ──────────────────────────────────────────────────────────────────────────────── */

/**
 * The four readings, over two builds of this tree. Returns one refusal per problem, each naming
 * what to do about it; an empty list is the pass.
 */
export async function verifyPhoneEngineRepro({ root = REPO, artifact = BUNDLE } = {}) {
  const refusals = [];
  const notes = [];

  /* The artifact FIRST, because the whole claim is about the file that ships. Built by the step
     before this one; absent means this gate has no subject, which is a refusal and never a skip. */
  if (!existsSync(artifact)) {
    return {
      refusals: [
        `the phone engine has not been built, so there is nothing to check:\n` +
        `    ${artifact}\n` +
        `  Run the bundler first:  node apps/mobile/scripts/bundle-engine.mjs`,
      ],
      notes,
    };
  }
  const shipped = readFileSync(artifact, "utf8");

  const first = await buildPhoneEngine({ write: false });
  const second = await buildPhoneEngine({ write: false });

  /* 1 — DETERMINISM, both halves: the two builds against each other, and the artifact on disk
     against them. The second half is the one that makes the other three mean anything. */
  const between = firstDifference(first.text, second.text);
  if (between) {
    refusals.push(
      `two builds of the same source produced different bytes (${between.lengths[0]} and ` +
      `${between.lengths[1]}), first differing at line ${between.line}:\n` +
      `    first:  ${JSON.stringify(between.first)}\n` +
      `    second: ${JSON.stringify(between.second)}\n` +
      `  A rebuild that does not match proves nothing, because it never would have.`);
  }
  const againstDisk = firstDifference(shipped, first.text);
  if (againstDisk) {
    refusals.push(
      `the artifact on disk is not what this tree builds (${againstDisk.lengths[0]} bytes on disk, ` +
      `${againstDisk.lengths[1]} built), first differing at line ${againstDisk.line}:\n` +
      `    on disk: ${JSON.stringify(againstDisk.first)}\n` +
      `    built:   ${JSON.stringify(againstDisk.second)}\n` +
      `  Everything below measures the build; the app ships the file. Rebuild it.`);
  }

  /* 2 — THE CEILING, over the file that ships. */
  const bytes = statSync(artifact).size;
  notes.push(`size: ${bytes} bytes (ceiling ${SIZE_CEILING})`);
  if (bytes > SIZE_CEILING) {
    refusals.push(
      `the phone engine is ${bytes} bytes, over the ${SIZE_CEILING}-byte ceiling.\n` +
      `  It rides inside every APK and every IPA. Raising the ceiling is a decision about what the\n` +
      `  app costs somebody on a phone, and it belongs in a diff that says so.`);
  }
  if (bytes < SIZE_FLOOR) {
    refusals.push(
      `the phone engine is only ${bytes} bytes, far under the ${SIZE_FLOOR}-byte floor — this is a\n` +
      `  partial or truncated bundle, and every check under a ceiling would pass it.`);
  }

  /* 3 — THE DIALECT ARM, at zero, over the files whose bytes ship. */
  const loaded = loadedSources(first.metafile, root);
  notes.push(`the bundle loads ${loaded.length} of this repository's source files`);
  const missingAnchors = DIALECT_ANCHORS.filter((a) => !loaded.includes(a));
  if (loaded.length < DIALECT_FLOOR || missingAnchors.length > 0) {
    refusals.push(
      `the loaded set is not plausibly the engine a phone runs — ${loaded.length} file(s), floor ` +
      `${DIALECT_FLOOR}${missingAnchors.length ? `, missing ${missingAnchors.join(", ")}` : ""}.\n` +
      `  Censusing that set would answer "nothing carries anything", which is an empty reading\n` +
      `  reporting as a pass.`);
  } else {
    const carrying = dialectHits(loaded, root);
    if (carrying.length > 0) {
      refusals.push(
        `${carrying.length} file(s) the bundle LOADS carry a construct only the server's store\n` +
        `  accepts. On a phone the store is SQLite, so each one fails there — or answers a\n` +
        `  different question, which is worse:\n` +
        carrying.map((c) => `    ${c}`).join("\n"));
    }
  }

  /* 4 — THE SENTINELS, over the shipped bytes and over the graph. */
  for (const file of [artifact, TYPES, join(PACKAGED_DIR, "package.json")]) {
    if (!existsSync(file)) continue;
    const hits = machinePathsIn(readFileSync(file, "utf8"), root);
    if (hits.length > 0) {
      refusals.push(
        `${file} names the machine that built it, on ${hits.length} line(s):\n` +
        hits.slice(0, 5).map((h) => `    ${h}`).join("\n"));
    }
  }
  const asked = requiresIn(shipped);
  const expected = [...aliases.EXTERNAL].sort();
  const builtins = asked.filter((m) => m.startsWith("node:"));
  if (builtins.length > 0) {
    refusals.push(
      `the artifact asks its host for ${builtins.length} Node builtin(s): ${builtins.join(", ")}\n` +
      `  A phone has no Node. Each one fails at load, and the alias table is where it is answered.`);
  }
  const unexpected = asked.filter((m) => !expected.includes(m) && !m.startsWith("node:"));
  if (unexpected.length > 0 || asked.length !== expected.length + builtins.length) {
    refusals.push(
      `the artifact asks its host for ${asked.join(", ") || "(nothing)"} and should ask for exactly ` +
      `${expected.join(", ")}.\n` +
      `  A third one is a native dependency nobody decided to add — or a module that should have\n` +
      `  been bundled and was left for a device to find.`);
  }
  notes.push(`asks its host for: ${asked.join(", ") || "(nothing)"}`);
  notes.push(
    `the graph records ${nodeSpecifiersIn(first.metafile).length} \`node:\` edge(s) and ` +
    `${externalsIn(first.metafile).length} unbundled edge(s) — the bundler's own \`externals:\` ` +
    `line, which counts erased type-only imports and is not what the artifact asks for`);

  /* The floor under every reading above: a bundle that built and exported nothing would pass a
     ceiling, a census over no files and a require list that is empty. */
  for (const name of ["startPhoneEngine", "startPhoneEngineFromSealed"]) {
    if (!shipped.includes(`${name}:`)) {
      refusals.push(
        `the artifact does not export ${name}, so the app's fourth door has nothing to register.`);
    }
  }

  return { refusals, notes };
}

/* `pathToFileURL`, never `file://${argv[1]}`: false for any path needing percent-encoding
 * (a space in the checkout path), and the verifier then verifies nothing at rc 0. */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(`verifying the phone engine in ${REPO}`);
  const { refusals, notes } = await verifyPhoneEngineRepro();
  for (const n of notes) console.log(`  ${n}`);
  if (refusals.length > 0) {
    console.error(`\nREFUSED: ${refusals.length} problem(s) with the engine this tree would ship.\n`);
    for (const r of refusals) console.error(`- ${r}\n`);
    process.exit(1);
  }
  console.log("\nthe phone engine builds byte-identically, ships what was built, and measures clean");
}
