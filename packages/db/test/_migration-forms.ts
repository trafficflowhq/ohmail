import { readFileSync } from "node:fs";
import { join } from "node:path";
import { JOURNALS, readJournalOf, type JournalSpec } from "../src/admin.js";

/**
 * ONE LEFT-TO-RIGHT PASS THAT BLANKS SQL NOISE — comments and quoted literals to spaces, never
 * deleted, so an offset a finding names is still the file's own. `scripts/lib/source-scan.mjs`
 * cannot serve here and is not imported: SQL's line comment is `--`, its block comments NEST, and
 * a string escapes its quote by doubling it. DOLLAR-QUOTED bodies are scanned THROUGH rather than
 * blanked — the one form this repository writes them in is a `DO $$ … EXCEPTION WHEN
 * duplicate_object … $$` wrapper, which is procedural code and the third idempotent form the
 * rules below admit; blanking it would hide the statement the rule has to read.
 */
export function blankSqlNoise(src: string): string {
  const out = src.split("");
  const blank = (i: number): void => { if (src[i] !== "\n") out[i] = " "; };
  for (let i = 0; i < src.length;) {
    const two = src.slice(i, i + 2);
    if (two === "--") { while (i < src.length && src[i] !== "\n") blank(i++); continue; }
    if (two === "/*") {
      const start = i;
      let depth = 0;
      while (i < src.length) {
        if (src.slice(i, i + 2) === "/*") { depth++; i += 2; }
        else if (src.slice(i, i + 2) === "*/") { depth--; i += 2; if (depth === 0) break; }
        else i++;
      }
      for (let k = start; k < i; k++) blank(k);
      continue;
    }
    if (src[i] === "'") {
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === "'" && src[j + 1] === "'") j += 2;
        else if (src[j] === "'") { j++; break; }
        else j++;
      }
      for (let k = i; k < j; k++) blank(k);
      i = j;
      continue;
    }
    const tag = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(src.slice(i, i + 64));
    if (tag) { i += tag[0].length; continue; }
    i++;
  }
  return out.join("");
}

/** One statement as drizzle's `readMigrationFiles` produces it, with its noise blanked. */
export interface Statement {
  readonly index: number;
  readonly raw: string;
  /** Noise blanked, whitespace collapsed — what every rule below reads. */
  readonly flat: string;
}

/** The exact split drizzle applies, so a census statement is a migrator statement. */
export function statementsOf(text: string): Statement[] {
  return text.split("--> statement-breakpoint")
    .map((raw, index) => ({ index, raw, flat: blankSqlNoise(raw).replace(/\s+/g, " ").trim() }))
    .filter((s) => s.flat !== "");
}

/** The statement kinds a second application refuses, named as the census reports them. */
export type FormClass =
  | "ADD CONSTRAINT" | "CREATE INDEX" | "CREATE TABLE" | "ADD COLUMN" | "CREATE TYPE"
  | "CREATE TRIGGER" | "CREATE SEQUENCE" | "CREATE SCHEMA" | "CREATE VIEW" | "INSERT";

export interface Finding {
  readonly statement: number;
  readonly form: FormClass;
  /** The object the statement names, or `""` where the form has no single name. */
  readonly object: string;
}

/** Names already dropped `IF EXISTS` earlier in the same file, by kind. */
interface Dropped { constraint: Set<string>; index: Set<string>; type: Set<string>; trigger: Set<string> }

const NAME = `"?([A-Za-z0-9_]+)"?`;
const DROP_RULES: ReadonlyArray<{ kind: keyof Dropped; re: RegExp }> = [
  { kind: "constraint", re: new RegExp(`DROP\\s+CONSTRAINT\\s+IF\\s+EXISTS\\s+${NAME}`, "gi") },
  { kind: "index", re: new RegExp(`DROP\\s+INDEX\\s+(?:CONCURRENTLY\\s+)?IF\\s+EXISTS\\s+${NAME}`, "gi") },
  { kind: "type", re: new RegExp(`DROP\\s+TYPE\\s+IF\\s+EXISTS\\s+${NAME}`, "gi") },
  { kind: "trigger", re: new RegExp(`DROP\\s+TRIGGER\\s+IF\\s+EXISTS\\s+${NAME}`, "gi") },
];

/**
 * A `DO $$ … EXCEPTION WHEN … $$` wrapper: drizzle's own idempotent form, and the third one this
 * repository writes (the other two are `IF NOT EXISTS` and a `DROP … IF EXISTS` in front). The
 * catch has to be in the SAME statement as the creation, which is why this reads the statement.
 *
 * `duplicate_object` IS NOT ENOUGH FOR A UNIQUE OR PRIMARY KEY, and the replay census is what
 * said so: such a constraint builds a backing INDEX, and a name collision on that index raises
 * `duplicate_table` (42P07), which a `duplicate_object` arm does not take. Mail 0015 carries two
 * of them and refuses its own second application although it looks wrapped.
 */
const catchesDuplicate = (flat: string): boolean => {
  if (!/\bDO\b/i.test(flat) || !/\bEXCEPTION\b/i.test(flat)) return false;
  const takesObject = /\bWHEN\s+(?:[a-z_]+\s+OR\s+)*duplicate_object\b/i.test(flat);
  const takesTable = /\bWHEN\s+(?:[a-z_]+\s+OR\s+)*duplicate_table\b/i.test(flat);
  const buildsIndex = /\b(?:UNIQUE|PRIMARY\s+KEY)\b/i.test(flat);
  return buildsIndex ? takesObject && takesTable : takesObject;
};

/**
 * A `DO` block that creates the trigger only where `pg_trigger` has no row of that name — mail
 * 0159's form, which takes no lock on a second application (a DROP TRIGGER takes an exclusive
 * one, and CREATE OR REPLACE TRIGGER needs Postgres 14). Read off the RAW statement: the guard
 * names the trigger in a string literal, which the flat text blanks. The guard must come before
 * the creation, in the same statement.
 */
const guardedByCatalog = (raw: string, name: string): boolean => {
  if (!/^\s*DO\b/i.test(raw)) return false;
  const guard = new RegExp(`IF\\s+NOT\\s+EXISTS\\s*\\(\\s*SELECT\\s+1\\s+FROM\\s+pg_trigger\\s+WHERE\\s+tgname\\s*=\\s*'${name}'`, "i").exec(raw);
  const create = new RegExp(`CREATE\\s+TRIGGER\\s+"?${name}"?`, "i").exec(raw);
  return guard !== null && create !== null && guard.index < create.index;
};

/**
 * THE DECIDING TABLE. Each rule finds a creating form and says when a SECOND application of it is
 * a no-op rather than an error. `admit` is the line a mutation control flips: weaken one and the
 * census's own reading for that migration stops agreeing with this file.
 */
const FORM_RULES: ReadonlyArray<{
  form: FormClass;
  re: RegExp;
  admit: (flat: string, name: string, dropped: Dropped, raw: string) => boolean;
}> = [
  {
    form: "ADD CONSTRAINT",
    re: new RegExp(`ADD\\s+CONSTRAINT\\s+${NAME}`, "i"),
    admit: (flat, name, d) => d.constraint.has(name) || catchesDuplicate(flat),
  },
  {
    form: "CREATE INDEX",
    re: new RegExp(`CREATE\\s+(?:UNIQUE\\s+)?INDEX\\s+(?:CONCURRENTLY\\s+)?(?:IF\\s+NOT\\s+EXISTS\\s+)?${NAME}`, "i"),
    admit: (flat, name, d) => /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?IF\s+NOT\s+EXISTS/i.test(flat)
      || d.index.has(name),
  },
  {
    form: "CREATE TABLE",
    re: new RegExp(`CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${NAME}`, "i"),
    admit: (flat) => /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS/i.test(flat),
  },
  {
    form: "ADD COLUMN",
    re: new RegExp(`ADD\\s+COLUMN\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${NAME}`, "i"),
    admit: (flat) => /ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS/i.test(flat),
  },
  {
    form: "CREATE TYPE",
    re: new RegExp(`CREATE\\s+TYPE\\s+${NAME}`, "i"),
    admit: (flat, name, d) => d.type.has(name) || catchesDuplicate(flat),
  },
  {
    form: "CREATE TRIGGER",
    re: new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?TRIGGER\\s+${NAME}`, "i"),
    admit: (flat, name, d, raw) => /CREATE\s+OR\s+REPLACE\s+TRIGGER/i.test(flat) || d.trigger.has(name)
      || guardedByCatalog(raw, name),
  },
  {
    form: "CREATE SEQUENCE",
    re: new RegExp(`CREATE\\s+SEQUENCE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${NAME}`, "i"),
    admit: (flat) => /CREATE\s+SEQUENCE\s+IF\s+NOT\s+EXISTS/i.test(flat),
  },
  {
    form: "CREATE SCHEMA",
    re: new RegExp(`CREATE\\s+SCHEMA\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${NAME}`, "i"),
    admit: (flat) => /CREATE\s+SCHEMA\s+IF\s+NOT\s+EXISTS/i.test(flat),
  },
  {
    form: "CREATE VIEW",
    re: new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?VIEW\\s+${NAME}`, "i"),
    admit: (flat) => /CREATE\s+OR\s+REPLACE\s+VIEW/i.test(flat),
  },
  {
    form: "INSERT",
    re: /INSERT\s+INTO\s+"?([A-Za-z0-9_.]+)"?/i,
    admit: (flat) => /ON\s+CONFLICT/i.test(flat) || /WHERE\s+NOT\s+EXISTS/i.test(flat),
  },
];

/** Every non-idempotent form in one migration, in statement order. */
export function nonIdempotentForms(statements: readonly Statement[]): Finding[] {
  const dropped: Dropped = { constraint: new Set(), index: new Set(), type: new Set(), trigger: new Set() };
  const out: Finding[] = [];
  for (const s of statements) {
    for (const rule of FORM_RULES) {
      const m = rule.re.exec(s.flat);
      if (m === null) continue;
      const name = m[1] ?? "";
      if (!rule.admit(s.flat, name, dropped, s.raw)) out.push({ statement: s.index, form: rule.form, object: name });
    }
    // AFTER the rules: a file that drops and re-adds in ONE statement is not made idempotent by
    // its own drop, and the pair is always two statements here.
    for (const d of DROP_RULES) {
      for (const hit of s.flat.matchAll(d.re)) dropped[d.kind].add(hit[1] ?? "");
    }
  }
  return out;
}

/** One migration of one journal, with its file read. */
export interface MigrationFile {
  readonly journal: string;
  readonly tag: string;
  readonly when: number;
  readonly path: string;
  readonly text: string;
}

/** Every migration of one journal, in journal order. */
export function migrationsOf(spec: JournalSpec): MigrationFile[] {
  return readJournalOf(spec).map((e) => {
    const path = join(spec.dir, `${e.tag}.sql`);
    return { journal: spec.name, tag: e.tag, when: e.when, path, text: readFileSync(path, "utf8") };
  });
}

/** Both journals, mail then cloud — the order `runMigrations` applies them in. */
export function allMigrations(): MigrationFile[] {
  return JOURNALS.flatMap((spec) => migrationsOf(spec));
}

/**
 * THE FLOOR ABOVE WHICH A MIGRATION IS ACTUALLY RE-EXECUTED — derived, never a literal.
 *
 * One population re-executes anything: the skip window `journal-reissue.pg` models, whose
 * watermark sits just under the folders reissue, so the migrator replays every entry above it.
 * Below the floor nothing does — `mailbox-dedup.pg`'s rewind is a fixture that drops the objects
 * it re-creates by hand — which is why an entry below it may refuse and be named instead of
 * edited, and why an entry above it may not.
 */
export function replayFloorWhen(): number {
  const reissue = allMigrations().find((m) => m.tag.endsWith("_folders_enabled_reissue"));
  if (reissue === undefined) throw new Error("[forms] the folders reissue is gone from the mail journal");
  return reissue.when;
}

/** `mail/0120_held_release_dismissed` — the key the allow list and the census report share. */
export const keyOf = (m: { journal: string; tag: string }): string => `${m.journal}/${m.tag}`;

/**
 * Every migration these rules refuse, by key, sorted. The static half asserts it against its own
 * allow list; the census asserts it against what a real second application actually RAISES, which
 * is what keeps the two halves from drifting into disagreeing about the same file.
 */
export function refusedByForm(): string[] {
  return allMigrations()
    .filter((m) => nonIdempotentForms(statementsOf(m.text)).length > 0)
    .map(keyOf)
    .sort();
}
