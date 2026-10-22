import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  allMigrations, keyOf, nonIdempotentForms, refusedByForm, statementsOf,
} from "./_migration-forms.js";

/**
 * THE STATIC HALF OF THE REPLAY CENSUS — the same question asked of the TEXT, answered before a
 * migration is ever applied and without a Postgres. The pg half executes every entry a second
 * time; this file reads the statement FORMS, refusing a creating statement unless a second
 * application of it is a no-op — `IF NOT EXISTS`, a `DROP … IF EXISTS` earlier in the same file,
 * an `ON CONFLICT`, or a `DO` block whose catch takes the error the creation actually raises. The
 * two are held together on the pg side, where the census asserts that the set this file refuses
 * is exactly the set a real second application raises on.
 */

const FIXTURES = join(__dirname, "fixtures", "migration-forms");

/**
 * MIGRATIONS THESE RULES REFUSE AND THE TREE DOES NOT EDIT, with the reason and the census's own
 * reading of each. Below the replay floor nothing re-executes an entry, so a refusal there is a
 * fact about the file: six are also below `LEGACY_CUTOFF_WHEN` and sha256-pinned against the
 * pre-split original by `journal-split.test.ts`'s permutation oracle, and two are byte-frozen by
 * `released-migrations.lock.json`. Above the floor only a fix in flight may be named, and the pg
 * half is where that is enforced — it is the side that knows each entry's `when`.
 */
const ALLOWED: Readonly<Record<string, string>> = {
  "mail/0001_cute_black_queen":
    "below the floor, below the cutoff — one bare ADD CONSTRAINT UNIQUE; census: refuses, 42P07",
  "mail/0002_wet_thunderball":
    "below the floor, below the cutoff — thirteen bare ADD COLUMN; census: refuses, 42701",
  "mail/0007_amusing_nextwave":
    "below the floor, below the cutoff — four bare ADD COLUMN; census: refuses, 42701",
  "mail/0008_hybrid_search":
    "below the floor, below the cutoff — two bare ADD COLUMN; census: refuses, 42701",
  "mail/0010_optimal_roland_deschain":
    "below the floor, below the cutoff — one bare ADD COLUMN; census: refuses, 42701",
  "mail/0015_workflow_step_dedup":
    "below the floor, below the cutoff — two ADD CONSTRAINT UNIQUE wrapped in a DO block that "
    + "catches duplicate_object only; census: refuses, 42P07 on the backing index",
};

describe("no migration is written in a form that cannot be applied twice", () => {
  it("every journal migration is either idempotent by form or allowed by name", () => {
    const refused = refusedByForm();
    const named = Object.keys(ALLOWED).sort();
    expect(refused.filter((k) => ALLOWED[k] === undefined),
      "migrations written in a non-idempotent form and not allowed by name").toEqual([]);
    // The other direction: an allow-list entry whose migration is idempotent now is a line that
    // has stopped being about anything, and it would hide the next one added under it.
    expect(named.filter((k) => !refused.includes(k)),
      "allow-list entries whose migration is idempotent now — remove them").toEqual([]);
  });

  it("the allow list names migrations that exist", () => {
    const keys = new Set(allMigrations().map(keyOf));
    expect(Object.keys(ALLOWED).filter((k) => !keys.has(k)), "allow-list keys not in a journal")
      .toEqual([]);
  });

  it("control: a bare ADD CONSTRAINT is refused, and the same file with a DROP is admitted", () => {
    const bare = nonIdempotentForms(statementsOf(
      readFileSync(join(FIXTURES, "bare-add-constraint.sql"), "utf8")));
    expect(bare.map((f) => `${f.form} ${f.object}`)).toEqual(["ADD CONSTRAINT probe_value_len"]);

    const flat = nonIdempotentForms(statementsOf(
      readFileSync(join(FIXTURES, "flat-add-constraint.sql"), "utf8")));
    expect(flat, "the flat form, which differs by one statement").toEqual([]);
  });

  it("control: a DO block admits an ADD CONSTRAINT only for the error it can raise", () => {
    const wrap = (body: string, arm: string): string =>
      `DO $$ BEGIN\n  ${body}\nEXCEPTION\n WHEN ${arm} THEN null;\nEND $$;`;
    const check = `ALTER TABLE "drafts" ADD CONSTRAINT "d_cap" CHECK (octet_length("html") <= 1);`;
    const unique = `ALTER TABLE "drafts" ADD CONSTRAINT "d_uq" UNIQUE("workflow_dedup_key");`;
    const forms = (sql: string): string[] =>
      nonIdempotentForms(statementsOf(sql)).map((f) => `${f.form} ${f.object}`);

    expect(forms(wrap(check, "duplicate_object")), "a CHECK raises duplicate_object").toEqual([]);
    expect(forms(wrap(unique, "duplicate_object")),
      "a UNIQUE's backing index raises duplicate_table, which that arm does not take")
      .toEqual(["ADD CONSTRAINT d_uq"]);
    expect(forms(wrap(unique, "duplicate_object OR duplicate_table")),
      "…and the arm that does take it is admitted").toEqual([]);
  });

  it("control: a CREATE TRIGGER is admitted behind its own pg_trigger guard, and only there", () => {
    const forms = (sql: string): string[] =>
      nonIdempotentForms(statementsOf(sql)).map((f) => `${f.form} ${f.object}`);
    const create = `CREATE TRIGGER "t_tg" BEFORE INSERT ON "drafts" FOR EACH ROW EXECUTE FUNCTION f();`;
    const guarded = (name: string): string =>
      `DO $$ BEGIN\n  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = '${name}') THEN\n    ${create}\n  END IF;\nEND $$;`;
    expect(forms(create), "bare").toEqual(["CREATE TRIGGER t_tg"]);
    expect(forms(guarded("t_tg")), "guarded by its own name").toEqual([]);
    expect(forms(guarded("other_tg")), "a guard naming another trigger").toEqual(["CREATE TRIGGER t_tg"]);
  });

  it("the comment scanner blanks SQL noise without moving a line", () => {
    const src = readFileSync(join(FIXTURES, "bare-add-constraint.sql"), "utf8");
    const statements = statementsOf(src);
    expect(statements).toHaveLength(2);
    // A word that only ever appears in a comment must not reach a rule.
    expect(statements.some((s) => /positive control/i.test(s.flat))).toBe(false);
    expect(statements[0]!.flat).toMatch(/ADD COLUMN IF NOT EXISTS/);
  });
});
