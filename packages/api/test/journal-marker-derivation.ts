/**
 * The journal-derived marker machinery, ONE parser and ONE count function that both the mail
 * (`mail-marker-derivation.ts`) and cloud (`cloud-marker-derivation.ts`) halves use — the mail
 * half by `MAIL_JOURNAL`, the cloud half by `CLOUD_JOURNAL`. It is derived rather than copied so
 * the two halves cannot drift apart in what "a column facet" means.
 *
 * WHY THIS EXISTS. `/health` computes `expected` from the marker LISTS, so deleting an OLDER
 * marker lowered `expected` and `markersFound` together and the probe stayed green — a database
 * with a silently missing column then read healthy, the inverted `schema_incomplete` incident.
 * These derivations read the migrations instead: the required column-marker count comes from the
 * journal plus a documented grandfather list, never from the array under test.
 *
 * The unit is the migration's own: the health markers probe ONE column per migration table facet.
 * So a "facet" is a `(creating-migration, table)` pair, and the required set is every facet the
 * journal creates minus a documented grandfather list. Indexes and CHECKs are curated by a
 * semantic the SQL does not carry (a marker exists only where a MISSING object is SILENT), so this
 * module does not derive their coverage — the anti-drift gate and the no-phantom check hold those
 * classes.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readJournalOf, type JournalSpec } from "@trafficflow/db/admin";

export interface JournalObjects {
  /** `table.column` for every column an `ALTER … ADD COLUMN` or a `CREATE TABLE` body creates. */
  columns: Set<string>;
  tables: Set<string>;
  indexes: Set<string>;
  /** CHECK-constraint names — `ADD CONSTRAINT … CHECK` and inline `CONSTRAINT … CHECK`. */
  checks: Set<string>;
  /** `table.column` → the tag of the migration that FIRST creates it (a reissue keeps the original). */
  colToTag: Map<string, string>;
  /** `"<tag>|<table>"` → the columns that migration adds to that table. */
  colFacets: Map<string, { tag: string; table: string; cols: string[] }>;
}

/**
 * Comments carry the argument and name DDL constantly, so a marker's name or a `CREATE TABLE`
 * appears in prose that is never executed — strip line comments first, exactly as
 * `baseline.ts#baselineObjects` and `health.test.ts`'s `dataOnlySql` do.
 */
export const stripLineComments = (text: string): string => text.replace(/^\s*--[^\n]*$/gm, "");

/**
 * Parse every migration of `journal` into the objects it creates.
 *
 * `identifier` is the character class an SQL identifier is matched with. It defaults to
 * `[a-z0-9_]+` — Postgres identifiers admit digits, and the cloud journal uses them
 * (`platform_signals.errors_5xx`, `push_subscriptions.p256dh`). The MAIL half pins the narrower
 * `[a-z_]+` it was written against, so its derived numbers stay byte-for-byte (widening them there
 * would newly capture `attachments.content_sha256` and move the mail count).
 */
export function parseJournalObjects(
  journal: JournalSpec,
  { identifier = "[a-z0-9_]+" }: { identifier?: string } = {},
): JournalObjects {
  const columns = new Set<string>();
  const tables = new Set<string>();
  const indexes = new Set<string>();
  const checks = new Set<string>();
  const colToTag = new Map<string, string>();
  const colFacets = new Map<string, { tag: string; table: string; cols: string[] }>();

  const addColumn = (tag: string, table: string, col: string): void => {
    const id = `${table}.${col}`;
    if (!colToTag.has(id)) colToTag.set(id, tag);
    columns.add(id);
    const key = `${tag}|${table}`;
    const facet = colFacets.get(key) ?? { tag, table, cols: [] };
    facet.cols.push(col);
    colFacets.set(key, facet);
  };

  const id = identifier;
  for (const entry of readJournalOf(journal)) {
    const sql = stripLineComments(readFileSync(join(journal.dir, `${entry.tag}.sql`), "utf8"));
    let m: RegExpExecArray | null;

    // CREATE TABLE "x" ( … ); — the table, its columns, and any inline CHECK constraints.
    const tableRe = new RegExp(`CREATE TABLE (?:IF NOT EXISTS )?"(${id})"\\s*\\(([\\s\\S]*?)\\n\\);`, "gi");
    while ((m = tableRe.exec(sql))) {
      const table = m[1]!;
      tables.add(table);
      for (const raw of m[2]!.split("\n")) {
        const line = raw.trim();
        const col = line.match(new RegExp(`^"(${id})"\\s+`));
        if (col && !new RegExp(`^"${id}"\\s+CHECK`, "i").test(line)) addColumn(entry.tag, table, col[1]!);
        const con = line.match(new RegExp(`CONSTRAINT "(${id})"\\s+CHECK`, "i"));
        if (con) checks.add(con[1]!);
      }
    }

    const colRe = new RegExp(`ALTER TABLE "(${id})"\\s+ADD COLUMN (?:IF NOT EXISTS )?"(${id})"`, "gi");
    while ((m = colRe.exec(sql))) addColumn(entry.tag, m[1]!, m[2]!);

    const idxRe = new RegExp(`CREATE (?:UNIQUE )?INDEX (?:IF NOT EXISTS )?"(${id})"`, "gi");
    while ((m = idxRe.exec(sql))) indexes.add(m[1]!);

    const conRe = new RegExp(`ADD CONSTRAINT "(${id})"\\s+CHECK`, "gi");
    while ((m = conRe.exec(sql))) checks.add(m[1]!);
  }

  // WHAT A LATER ENTRY DROPPED IS NOT THERE: no marker may name it, and a facet whose every column
  // is gone asks for none. (An object dropped and made again by one entry is replaced, not gone.)
  const { gone } = droppedByTheJournal(journal);
  for (const key of gone) {
    const [kind, name] = key.split(" ") as [string, string];
    if (kind === "index") indexes.delete(name);
    else if (kind === "constraint") checks.delete(name);
    else if (kind === "table") {
      tables.delete(name);
      for (const col of [...columns]) if (col.startsWith(`${name}.`)) columns.delete(col);
      for (const [facet, f] of [...colFacets]) if (f.table === name) colFacets.delete(facet);
    } else if (kind === "column") {
      columns.delete(name);
      const [table, col] = name.split(".") as [string, string];
      for (const [facet, f] of [...colFacets]) {
        if (f.table !== table || !f.cols.includes(col)) continue;
        f.cols = f.cols.filter((c) => c !== col);
        if (f.cols.length === 0) colFacets.delete(facet);
      }
    }
  }

  return { columns, tables, indexes, checks, colToTag, colFacets };
}

/**
 * The required number of COLUMN markers for one journal, from the journal and its two allow-lists —
 * never from the marker array's length. Every facet the journal creates that is not grandfathered
 * needs one marker, and each double-probed facet needs a second. A dropped marker leaves this
 * number unchanged, so the probe assertion it anchors turns red.
 */
export function deriveColumnMarkerCount(
  objects: JournalObjects,
  allowlist: Record<string, string>,
  doubleProbes: Record<string, string>,
): number {
  let required = 0;
  for (const key of objects.colFacets.keys()) {
    if (!(key in allowlist)) required += 1;
  }
  return required + Object.keys(doubleProbes).length;
}

// ── Which migrations the census can prove, and which /health marker pins each ────────────────

const DDL = /\b(?:CREATE|ALTER|DROP|COMMENT\s+ON|GRANT|REVOKE)\b/i;

/**
 * No DDL in its STATEMENTS: its content is data, so no catalog object records it and no marker can
 * prove it ran. Comments are stripped first; every header names DDL, and prose is never executed.
 */
export const dataOnlySql = (text: string): boolean => !DDL.test(stripLineComments(text));

/**
 * Every statement VALIDATEs an existing constraint. It flips `convalidated` and adds no object
 * (cloud 0045), so no marker class can see it. Derived from the SQL, like {@link dataOnlySql}.
 */
export const validateOnlySql = (text: string): boolean => {
  const stmts = stripLineComments(text).split(";")
    .map((t) => t.replace(/\s+/g, " ").trim()).filter((t) => t !== "");
  return stmts.length > 0
    && stmts.every((t) => /^ALTER TABLE "[a-z_]+" VALIDATE CONSTRAINT "[a-z0-9_]+"$/i.test(t));
};

/** One object an entry makes or drops: `index messages_x_idx`, `column mailboxes.kickstart_at`. */
interface NamedObject { key: string; table: string | null }

/**
 * WHAT ONE ENTRY MAKES AND WHAT IT DROPS, by name. Read per `;`-cut statement, so an `ALTER TABLE`
 * with several clauses gives each clause its table. `IF EXISTS` and `IF NOT EXISTS` forms count: a
 * guarded drop is still a drop on every store that had the object.
 */
export function entryObjects(text: string): { made: NamedObject[]; dropped: NamedObject[] } {
  const id = "[A-Za-z0-9_]+";
  const made: NamedObject[] = [];
  const dropped: NamedObject[] = [];
  const all = (s: string, re: RegExp): RegExpMatchArray[] => [...s.matchAll(re)];
  for (const stmt of stripLineComments(text).split(";")) {
    const table = new RegExp(`(?:ALTER|CREATE) TABLE (?:ONLY )?(?:IF (?:NOT )?EXISTS )?"(${id})"`, "i").exec(stmt)?.[1] ?? null;
    const on = new RegExp(`\\bON (?:ONLY )?(?:"?public"?\\.)?"?(${id})"?`, "i").exec(stmt)?.[1] ?? null;
    const created = new RegExp(`CREATE TABLE (?:IF NOT EXISTS )?"(${id})"\\s*\\(([\\s\\S]*)`, "i").exec(stmt);
    if (created) {
      made.push({ key: `table ${created[1]}`, table: created[1]! });
      for (const line of created[2]!.split("\n")) {
        const col = new RegExp(`^\\s*"(${id})"\\s+(?!CHECK)`, "i").exec(line);
        if (col) made.push({ key: `column ${created[1]}.${col[1]}`, table: created[1]! });
      }
    }
    for (const m of all(stmt, new RegExp(`ADD COLUMN (?:IF NOT EXISTS )?"(${id})"`, "gi"))) made.push({ key: `column ${table}.${m[1]}`, table });
    for (const m of all(stmt, new RegExp(`(?:ADD )?CONSTRAINT "(${id})"\\s+(?:CHECK|FOREIGN KEY|UNIQUE|PRIMARY KEY)`, "gi"))) made.push({ key: `constraint ${m[1]}`, table });
    for (const m of all(stmt, new RegExp(`CREATE (?:UNIQUE )?INDEX (?:CONCURRENTLY )?(?:IF NOT EXISTS )?"(${id})"`, "gi"))) made.push({ key: `index ${m[1]}`, table: on });
    for (const m of all(stmt, new RegExp(`CREATE (?:OR REPLACE )?FUNCTION\\s+(?:public\\.)?"?(${id})"?\\s*\\(`, "gi"))) made.push({ key: `function ${m[1]}`, table: null });
    for (const m of all(stmt, new RegExp(`CREATE (?:OR REPLACE )?(?:CONSTRAINT )?TRIGGER\\s+"?(${id})"?`, "gi"))) made.push({ key: `trigger ${m[1]}`, table: on });
    for (const m of all(stmt, new RegExp(`DROP TABLE (?:IF EXISTS )?"(${id})"`, "gi"))) dropped.push({ key: `table ${m[1]}`, table: m[1]! });
    for (const m of all(stmt, new RegExp(`DROP COLUMN (?:IF EXISTS )?"(${id})"`, "gi"))) dropped.push({ key: `column ${table}.${m[1]}`, table });
    for (const m of all(stmt, new RegExp(`DROP CONSTRAINT (?:IF EXISTS )?"(${id})"`, "gi"))) dropped.push({ key: `constraint ${m[1]}`, table });
    for (const m of all(stmt, new RegExp(`DROP INDEX (?:CONCURRENTLY )?(?:IF EXISTS )?"(${id})"`, "gi"))) dropped.push({ key: `index ${m[1]}`, table: null });
    for (const m of all(stmt, new RegExp(`DROP FUNCTION (?:IF EXISTS )?(?:public\\.)?"?(${id})"?`, "gi"))) dropped.push({ key: `function ${m[1]}`, table: null });
    for (const m of all(stmt, new RegExp(`DROP TRIGGER (?:IF EXISTS )?"?(${id})"?`, "gi"))) dropped.push({ key: `trigger ${m[1]}`, table: null });
  }
  return { made, dropped };
}

/**
 * THE OBJECTS A LATER ENTRY TOOK AWAY, and the entries they leave with nothing to prove. An object
 * is gone when the last entry that drops it stands after the last entry that makes it (a drop and
 * a re-creation in one entry is a replacement, not a drop); a dropped table takes its columns,
 * indexes, constraints and triggers with it. An entry is `retired` when it made something and all
 * of it is gone: no catalog object records it any more, so no marker can.
 */
export function droppedByTheJournal(journal: JournalSpec): { gone: Set<string>; retired: Set<string> } {
  const entries = readJournalOf(journal).map((e) => ({ tag: e.tag, ...entryObjects(readFileSync(join(journal.dir, `${e.tag}.sql`), "utf8")) }));
  const lastMade = new Map<string, number>();
  const lastDropped = new Map<string, number>();
  const tableOf = new Map<string, string | null>();
  entries.forEach((e, i) => {
    for (const o of e.made) { lastMade.set(o.key, i); tableOf.set(o.key, o.table); }
    for (const o of e.dropped) lastDropped.set(o.key, i);
  });
  const gone = new Set<string>();
  for (const [key, at] of lastMade) {
    const own = lastDropped.get(key) ?? -1;
    const table = tableOf.get(key) ?? null;
    const withTable = table === null || key === `table ${table}` ? -1 : (lastDropped.get(`table ${table}`) ?? -1);
    if (Math.max(own, withTable) > at) gone.add(key);
  }
  const retired = new Set(entries.filter((e) => e.made.length > 0 && e.made.every((o) => gone.has(o.key))).map((e) => e.tag));
  return { gone, retired };
}

/** The markers that probe an object the journal has dropped: each would hold `/health` at 503 for ever. */
export function markersOfDroppedObjects(journal: JournalSpec, markers: MarkerSet): string[] {
  const { gone } = droppedByTheJournal(journal);
  return [
    ...markers.columns.filter(([t, c]) => gone.has(`column ${t}.${c}`)).map(([t, c]) => `column ${t}.${c}`),
    ...markers.types.filter(([t, c]) => gone.has(`column ${t}.${c}`)).map(([t, c]) => `type ${t}.${c}`),
    ...markers.indexes.filter(([n]) => gone.has(`index ${n}`)).map(([n]) => `index ${n}`),
    ...markers.checks.filter((n) => gone.has(`constraint ${n}`)).map((n) => `check ${n}`),
    ...markers.definitions.filter(([n]) => gone.has(`constraint ${n}`)).map(([n]) => `definition ${n}`),
    ...markers.foreignKeys.filter(([n]) => gone.has(`constraint ${n}`)).map(([n]) => `fk ${n}`),
    ...markers.functions.filter(([n]) => gone.has(`function ${n}`)).map(([n]) => `function ${n}`),
  ];
}

/** A migration the census cannot prove: data-only or validate-only. The anti-drift gate's rule. */
export const unprobeableSql = (text: string): boolean => dataOnlySql(text) || validateOnlySql(text);

/** One tier's `/health` markers, by class, as the probe reads them. */
export interface MarkerSet {
  columns: ReadonlyArray<readonly [table: string, column: string]>;
  indexes: ReadonlyArray<readonly [indexname: string, needle: string]>;
  checks: ReadonlyArray<string>;
  definitions: ReadonlyArray<readonly [conname: string, needle: string]>;
  types: ReadonlyArray<readonly [table: string, column: string, udt: string]>;
  foreignKeys: ReadonlyArray<readonly [conname: string, needle: string]>;
  functions: ReadonlyArray<readonly [proname: string, needle: string]>;
}

/** A CHECK constraint's creations in journal order, and which of them write the marker's needle. */
export interface DefinitionHistory { marker: string; creators: string[]; writers: string[] }

export interface MigrationPins {
  /** Every PROVABLE entry, in journal order, with the markers that pin it (empty = unpinned). */
  pins: Map<string, string[]>;
  /** Markers that pin no migration: their object is created by no migration's own SQL. */
  idle: string[];
  definitions: DefinitionHistory[];
}

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * WHICH MIGRATION EACH MARKER PINS. A marker pins a migration when that migration's own SQL creates
 * the object the marker probes: a column's FIRST creator, an index's creators, a CHECK name's FIRST
 * creator (a name cannot tell a replacement from the original), a type change, a key's NEWEST creator, a function
 * body with its needle. A definition marker pins the creations that write its needle, and every
 * earlier RE-creation of that constraint as SUPERSEDED: a full re-creation rewrites the whole
 * constraint, so a database carrying the newest needle carries all an earlier one wrote.
 */
export function pinsByMigration(
  journal: JournalSpec,
  markers: MarkerSet,
  { identifier = "[a-z0-9_]+" }: { identifier?: string } = {},
): MigrationPins {
  const entries = readJournalOf(journal);
  const raw = new Map(entries.map((e) => [e.tag, readFileSync(join(journal.dir, `${e.tag}.sql`), "utf8")]));
  const sqlOf = new Map([...raw].map(([tag, text]) => [tag, stripLineComments(text)]));
  const tags = entries.map((e) => e.tag);
  const pins = new Map<string, string[]>();
  // An entry whose every object a later entry dropped has nothing left to probe (`droppedByTheJournal`).
  const { retired } = droppedByTheJournal(journal);
  for (const tag of tags) if (!unprobeableSql(raw.get(tag)!) && !retired.has(tag)) pins.set(tag, []);
  const idle: string[] = [];
  const pin = (label: string, hits: string[]): void => {
    const provable = hits.filter((tag) => pins.has(tag));
    if (provable.length === 0) idle.push(label);
    for (const tag of provable) pins.get(tag)!.push(label);
  };
  const creators = (re: RegExp): string[] => tags.filter((tag) => re.test(sqlOf.get(tag)!));
  // A CHECK's creating statement, cut at its `;`: the needle is asked of that text, not the file.
  const checkStatements = (tag: string, conname: string): string[] =>
    sqlOf.get(tag)!.split(";").filter((s) => new RegExp(`CONSTRAINT "${esc(conname)}"\\s+CHECK`, "i").test(s));

  const { colToTag } = parseJournalObjects(journal, { identifier });
  for (const [table, column] of markers.columns) {
    const tag = colToTag.get(`${table}.${column}`);
    pin(`column ${table}.${column}`, tag === undefined ? [] : [tag]);
  }
  for (const [name, needle] of markers.indexes) {
    // A needle carrying a storage parameter (`WITH (gin_pending_list_limit='256')`) also pins the
    // migration whose `ALTER INDEX … SET` writes that parameter: the definition renders it.
    const param = /WITH \((\w+)='([^']*)'\)/.exec(needle);
    const setters = param === null ? [] : creators(new RegExp(
      `ALTER INDEX (?:IF EXISTS )?"${esc(name)}" SET \\(\\s*${esc(param[1]!)}\\s*=\\s*'?${esc(param[2]!)}'?\\s*\\)`, "i"));
    pin(`index ${name}`, [
      ...creators(new RegExp(`CREATE (?:UNIQUE )?INDEX (?:CONCURRENTLY )?(?:IF NOT EXISTS )?"${esc(name)}"`, "i")),
      ...setters,
    ]);
  }
  for (const name of markers.checks)
    pin(`check ${name}`, creators(new RegExp(`CONSTRAINT "${esc(name)}"\\s+CHECK`, "i")).slice(0, 1));
  const definitions: DefinitionHistory[] = [];
  for (const [name, needle] of markers.definitions) {
    const made = tags.filter((tag) => checkStatements(tag, name).length > 0);
    const writers = made.filter((tag) => checkStatements(tag, name).some((s) => s.includes(needle)));
    definitions.push({ marker: `${name}~${needle}`, creators: made, writers });
    const last = writers.length === 0 ? -1 : made.indexOf(writers[writers.length - 1]!);
    const superseded = made.slice(1, Math.max(last, 1)).filter((tag) => !writers.includes(tag));
    pin(`definition ${name}~${needle}`, writers);
    for (const tag of superseded) pins.get(tag)?.push(`definition ${name} (superseded by ${writers[writers.length - 1]})`);
  }
  for (const [table, column, udt] of markers.types)
    pin(`type ${table}.${column}::${udt}`, creators(new RegExp(`ALTER TABLE "${esc(table)}" ALTER COLUMN "${esc(column)}" TYPE`, "i")));
  // A key recreated under its name is rewritten whole, so its marker probes the NEWEST creation.
  for (const [name] of markers.foreignKeys)
    pin(`fk ${name}`, creators(new RegExp(`CONSTRAINT "${esc(name)}"[^;]*?(?:FOREIGN KEY|REFERENCES)`, "i")).slice(-1));
  for (const [name, needle] of markers.functions)
    pin(`function ${name}`, tags.filter((tag) => {
      const s = sqlOf.get(tag)!;
      return new RegExp(`FUNCTION\\s+(?:public\\.)?"?${esc(name)}"?\\s*\\(`, "i").test(s) && s.includes(needle);
    }));
  return { pins, idle, definitions };
}

/**
 * The UNPINNED list against the pins. `missing`: provable, unpinned and not listed. `stale`: listed
 * but pinned, which would hide a later drop of the marker that pins it. `unknown`: listed but not a
 * provable entry of this journal. The list can only shrink: all three must be empty.
 */
export function unpinnedVerdict(
  { pins }: MigrationPins,
  unpinned: Record<string, string>,
): { missing: string[]; stale: string[]; unknown: string[] } {
  const listed = new Set(Object.keys(unpinned));
  return {
    missing: [...pins].filter(([tag, by]) => by.length === 0 && !listed.has(tag)).map(([tag]) => tag),
    stale: [...listed].filter((tag) => (pins.get(tag)?.length ?? 0) > 0),
    unknown: [...listed].filter((tag) => !pins.has(tag)),
  };
}
