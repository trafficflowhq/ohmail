import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { withoutComments } from "../../../scripts/lib/source-scan.mjs";
import { unwrittenBySqlName } from "../../../packages/db/test/_unwritten-tables.js";

/**
 * WHICH TABLES HOLD ONE MAILBOX'S ROWS — derived from the schema, never listed by hand.
 *
 * The domain is every table with a `mailbox_id` column, plus every table a foreign key reaches
 * from one of those, in either direction, walked to a fixed point. A table in {@link KEEP} is
 * part of the domain and stops the walk: its other neighbours belong to it, not to the mailbox.
 * The removal must delete from every other table in the domain.
 */

const SCHEMA_FILE = fileURLToPath(new URL("../../../packages/db/src/schema-mail.ts", import.meta.url));
const DRIZZLE = fileURLToPath(new URL("../../../packages/db-mail/drizzle", import.meta.url));

/** The tables the removal keeps, each with the reason. Every one is a boundary of the walk. */
export const KEEP: Readonly<Record<string, string>> = {
  mailboxes:
    "the tombstone: `MailboxService.delete` disables the row and `ensureLocalWorld` reads it to "
    + "tell a removed mailbox from one never seen",
  accounts: "the account itself; the mailbox's rows hang off it and it outlives every mailbox",
  rules:
    "the account's filing rules; a routing decision names the rule that filed it, and the rule "
    + "goes on filing every other mailbox's mail",
  tags:
    "the account's tag names; a message's tag assignment is deleted with the message, the tag "
    + "stays for every other mailbox",
  // Tables nothing writes yet (`packages/db/test/_unwritten-tables.ts`): no mailbox has a row in
  // them. That list is held to the tree; a table's first writer takes it off, and it is then in
  // the domain and owed by the walk.
  ...unwrittenBySqlName(),
};

/**
 * Tables that hold a mailbox's rows under a column not called `mailbox_id` and with no key into
 * `mailboxes`, each with the column and why. The schema's text cannot show these, so they are
 * named; a table here is OWED by the removal like any other in the domain.
 */
export const KEYED_BY_ANOTHER_NAME: Readonly<Record<string, string>> = {
  pass_progress:
    "`subject_id` is the mailbox's id for a mailbox's pass (the account's for an account's); "
    + "ruled without a key into `mailboxes`, so the two erasures and this walk delete by it",
};

/** One parsed schema: every table's SQL name, which carry `mailbox_id`, and the FK edges. */
export interface SchemaGraph {
  tables: Set<string>;
  mailboxKeyed: Set<string>;
  /** `[child, parent]` pairs, from the ORM's `references()` and from the migrations' SQL. */
  edges: Array<[string, string]>;
}

/** Parse `pgTable` declarations: names, `mailbox_id` columns and `references(() => x.id)`. */
export function parseSchema(src: string): SchemaGraph {
  const lines = withoutComments(src).split("\n");
  const declared: Array<[number, string, string]> = [];
  lines.forEach((line, i) => {
    const m = /^export const (\w+) = pgTable\(\s*"([\w_]+)"/.exec(line);
    if (m) declared.push([i, m[1]!, m[2]!]);
  });
  const sqlOf = new Map(declared.map(([, name, table]) => [name, table]));
  const owning = (at: number): string | null => {
    let out: string | null = null;
    for (const [line, , table] of declared) {
      if (line <= at) out = table;
      else break;
    }
    return out;
  };
  const graph: SchemaGraph = { tables: new Set(sqlOf.values()), mailboxKeyed: new Set(), edges: [] };
  lines.forEach((line, i) => {
    const table = owning(i);
    if (!table) return;
    if (/"mailbox_id"/.test(line) || Object.hasOwn(KEYED_BY_ANOTHER_NAME, table)) graph.mailboxKeyed.add(table);
    const ref = /references\(\(\)\s*=>\s*(\w+)\./.exec(line);
    if (ref) graph.edges.push([table, sqlOf.get(ref[1]!) ?? ref[1]!]);
  });
  return graph;
}

/** The migrations' live foreign keys, replayed in journal order with DROPs honoured. */
export function sqlEdges(): Array<[string, string]> {
  const journal = JSON.parse(
    readFileSync(join(DRIZZLE, "meta", "_journal.json"), "utf8"),
  ) as { entries: Array<{ tag: string }> };
  const live = new Map<string, [string, string]>();
  for (const entry of journal.entries) {
    const stmts = readFileSync(join(DRIZZLE, `${entry.tag}.sql`), "utf8")
      .split("--> statement-breakpoint")
      .map((s) => s.replace(/^\s*--[^\n]*$/gm, ""));
    for (const s of stmts) {
      // A dropped table takes its keys with it, in both directions.
      const gone = /^\s*DROP TABLE (?:IF EXISTS )?"([a-z_]+)"/im.exec(s)?.[1];
      if (gone) {
        for (const [name, [child, parent]] of live) if (child === gone || parent === gone) live.delete(name);
        continue;
      }
      // Every constraint an ALTER drops, one clause or several.
      if (/ALTER TABLE "[a-z_]+"\s+DROP CONSTRAINT /i.test(s)) {
        for (const d of s.matchAll(/DROP CONSTRAINT (?:IF EXISTS )?"([a-z_]+)"/gi)) live.delete(d[1]!);
        continue;
      }
      const child = (/ALTER TABLE "([a-z_]+)"/i.exec(s) ?? /CREATE TABLE (?:IF NOT EXISTS )?"([a-z_]+)"/i.exec(s))?.[1];
      if (!child) continue;
      for (const m of s.matchAll(
        /CONSTRAINT "([a-z_]+)"\s+FOREIGN KEY\s*\([^)]*\)\s*REFERENCES\s+(?:"public"\.)?"([a-z_]+)"/gi,
      )) {
        live.set(m[1]!, [child, m[2]!]);
      }
    }
  }
  return [...live.values()];
}

/** The mail schema as it is today: the ORM file and the migrations, one graph. */
export function mailGraph(): SchemaGraph {
  const g = parseSchema(readFileSync(SCHEMA_FILE, "utf8"));
  g.edges.push(...sqlEdges());
  return g;
}

/** The domain: `mailbox_id` tables and `mailboxes`, closed over FK edges, not walking past `keep`. */
export function mailboxDomain(g: SchemaGraph, keep: ReadonlySet<string>): Set<string> {
  const seen = new Set<string>([...g.mailboxKeyed, "mailboxes"]);
  for (let grew = true; grew;) {
    grew = false;
    for (const [child, parent] of g.edges) {
      if (seen.has(child) && !keep.has(child) && !seen.has(parent)) { seen.add(parent); grew = true; }
      if (seen.has(parent) && !keep.has(parent) && !seen.has(child)) { seen.add(child); grew = true; }
    }
  }
  return seen;
}

/** The tables the removal owes today: the domain less {@link KEEP}, sorted. */
export function tablesTheRemovalOwes(): string[] {
  const keep = new Set(Object.keys(KEEP));
  return [...mailboxDomain(mailGraph(), keep)].filter((t) => !keep.has(t)).sort();
}
