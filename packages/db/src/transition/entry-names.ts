/**
 * WHAT THE WINDOW'S ENTRIES NEED TO FIND AND NEED TO BE FREE, read out of their own statements.
 *
 * An entry of the window is written plainly: `DROP INDEX "x"`, never `IF EXISTS`, because the
 * store it runs on is known. That makes a missing name stop a journal half way, and on a store
 * that is not quite 1.0.11's (a fix that dropped an index, a leftover that took a name) the stop
 * would come after earlier entries ran. So the transition asks first: every name an entry needs
 * is read here and looked up before the first statement, and every name an entry makes is looked
 * up to be free. The lists are parsed from the statements that will run, so they cannot drift
 * from them; a fixture holds the parse, so a statement kind this reader does not know is red.
 *
 * Pure text: no driver. A statement inside a `DO` body is read like any other. A name an earlier
 * statement of the window makes is not asked of the store, and neither is the freedom of a name
 * an earlier statement dropped.
 */
export type NameKind = "table" | "column" | "index" | "constraint" | "trigger" | "function" | "statistics";

export interface EntryName {
  /** `mail` or `cloud`. */
  readonly journal: string;
  /** The entry's tag. */
  readonly entry: string;
  readonly kind: NameKind;
  /** The table a column, a constraint or a trigger belongs to; empty otherwise. */
  readonly table: string;
  readonly name: string;
}

export interface EntryNames {
  /** Must exist before the first statement. */
  readonly needed: EntryName[];
  /** Must be free before the first statement. */
  readonly made: EntryName[];
  /** Everything an entry removes, conditional drops included: what a dependent outside the map would block. */
  readonly dropped: EntryName[];
}

const ID = `"([A-Za-z0-9_]+)"`;
const keyOf = (kind: NameKind, table: string, name: string): string => `${kind}|${table}|${name}`;
/** Indexes, tables and the indexes behind a primary key or a unique share one namespace. */
const relationKey = (name: string): string => `relation||${name}`;

/** Comments out, so a name in a sentence is not a statement. */
function bare(statement: string): string {
  return statement.replace(/--[^\n]*/g, " ");
}

/** The clauses of one `ALTER TABLE`, split at top-level commas. */
function clauses(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quoted = false;
  let from = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === "'") quoted = !quoted;
    else if (!quoted && c === "(") depth++;
    else if (!quoted && c === ")") depth--;
    else if (!quoted && depth === 0 && c === ",") { out.push(body.slice(from, i)); from = i + 1; }
  }
  out.push(body.slice(from));
  return out.map((s) => s.trim()).filter((s) => s.length > 0);
}

export function namesOfWindow(
  entries: readonly { journal: string; tag: string; statements: readonly string[] }[],
): EntryNames {
  const needed = new Map<string, EntryName>();
  const made = new Map<string, EntryName>();
  const dropped = new Map<string, EntryName>();
  /** Made or dropped by an earlier statement of the window: not a question for the store. */
  const madeHere = new Set<string>();
  const droppedHere = new Set<string>();

  for (const e of entries) {
    const at = (kind: NameKind, table: string, name: string): EntryName =>
      ({ journal: e.journal, entry: e.tag, kind, table, name });
    const relation = (kind: NameKind): boolean => kind === "table" || kind === "index";
    const here = (kind: NameKind, table: string, name: string): string =>
      relation(kind) ? relationKey(name) : keyOf(kind, table, name);
    const need = (kind: NameKind, table: string, name: string): void => {
      const k = here(kind, table, name);
      if (madeHere.has(k)) return;
      needed.set(keyOf(kind, table, name), needed.get(keyOf(kind, table, name)) ?? at(kind, table, name));
    };
    const make = (kind: NameKind, table: string, name: string): void => {
      const k = here(kind, table, name);
      if (!droppedHere.has(k) && !madeHere.has(k)) made.set(keyOf(kind, table, name), at(kind, table, name));
      madeHere.add(k);
      droppedHere.delete(k);
    };
    const drop = (kind: NameKind, table: string, name: string, ifExists: boolean): void => {
      if (!ifExists) need(kind, table, name);
      dropped.set(keyOf(kind, table, name), at(kind, table, name));
      const k = here(kind, table, name);
      droppedHere.add(k);
      madeHere.delete(k);
    };

    for (const raw of e.statements) {
      const text = bare(raw);
      let m: RegExpExecArray | null;

      const createTable = new RegExp(`CREATE TABLE ${ID}\\s*\\(([\\s\\S]*?)\\)\\s*;`, "gi");
      while ((m = createTable.exec(`${text};`))) {
        make("table", "", m[1]!);
        // A primary key or a unique declared inline is an index of that name.
        const inline = new RegExp(`CONSTRAINT ${ID} (PRIMARY KEY|UNIQUE)`, "gi");
        let c: RegExpExecArray | null;
        while ((c = inline.exec(m[2]!))) make("index", "", c[1]!);
        const refs = new RegExp(`REFERENCES ${ID}`, "gi");
        while ((c = refs.exec(m[2]!))) need("table", "", c[1]!);
      }

      const dropTable = new RegExp(`DROP TABLE (IF EXISTS )?${ID}`, "gi");
      while ((m = dropTable.exec(text))) drop("table", "", m[2]!, m[1] !== undefined);

      const createIndex = new RegExp(`CREATE (?:UNIQUE )?INDEX ${ID} ON ${ID}`, "gi");
      while ((m = createIndex.exec(text))) { need("table", "", m[2]!); make("index", "", m[1]!); }

      const dropIndex = new RegExp(`DROP INDEX (IF EXISTS )?${ID}`, "gi");
      while ((m = dropIndex.exec(text))) drop("index", "", m[2]!, m[1] !== undefined);

      const dropTrigger = new RegExp(`DROP TRIGGER (IF EXISTS )?${ID} ON ${ID}`, "gi");
      while ((m = dropTrigger.exec(text))) drop("trigger", m[3]!, m[2]!, m[1] !== undefined);

      const dropFunction = new RegExp(`DROP FUNCTION (IF EXISTS )?${ID}\\s*\\(`, "gi");
      while ((m = dropFunction.exec(text))) drop("function", "", m[2]!, m[1] !== undefined);

      const statistics = new RegExp(`CREATE STATISTICS ${ID}[\\s\\S]*? FROM ${ID}`, "gi");
      while ((m = statistics.exec(text))) { need("table", "", m[2]!); make("statistics", "", m[1]!); }

      const written = new RegExp(`(?:UPDATE|INSERT INTO|DELETE FROM|ANALYZE) ${ID}`, "gi");
      while ((m = written.exec(text))) need("table", "", m[1]!);

      const alter = new RegExp(`ALTER TABLE ${ID}([\\s\\S]*?)(?:;|$)`, "gi");
      while ((m = alter.exec(text))) {
        const table = m[1]!;
        need("table", "", table);
        for (const clause of clauses(m[2]!)) {
          let c: RegExpExecArray | null;
          if ((c = new RegExp(`^ADD COLUMN ${ID}`, "i").exec(clause))) make("column", table, c[1]!);
          else if ((c = new RegExp(`^DROP COLUMN (IF EXISTS )?${ID}`, "i").exec(clause))) drop("column", table, c[2]!, c[1] !== undefined);
          else if ((c = new RegExp(`^ALTER COLUMN ${ID}`, "i").exec(clause))) need("column", table, c[1]!);
          else if ((c = new RegExp(`^DROP CONSTRAINT (IF EXISTS )?${ID}`, "i").exec(clause))) drop("constraint", table, c[2]!, c[1] !== undefined);
          else if ((c = new RegExp(`^VALIDATE CONSTRAINT ${ID}`, "i").exec(clause))) need("constraint", table, c[1]!);
          else if ((c = new RegExp(`^ADD CONSTRAINT ${ID}\\s+(UNIQUE|PRIMARY KEY|FOREIGN KEY|CHECK)`, "i").exec(clause))) {
            make("constraint", table, c[1]!);
            if (/^(UNIQUE|PRIMARY KEY)$/i.test(c[2]!)) make("index", "", c[1]!);
            const ref = new RegExp(`REFERENCES ${ID}`, "i").exec(clause);
            if (ref) need("table", "", ref[1]!);
          } else throw new Error(`${e.journal} ${e.tag}: an ALTER TABLE clause this reader does not know: ${clause.slice(0, 40)}`);
        }
      }
    }
  }
  const sorted = (rows: Map<string, EntryName>): EntryName[] => [...rows.values()];
  return { needed: sorted(needed), made: sorted(made), dropped: sorted(dropped) };
}
