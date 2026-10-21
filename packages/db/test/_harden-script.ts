import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * `scripts/harden-staff-role.sql` as it stood before a table's stanza was added: the shipped text
 * with that one stanza taken out, from its `-- \`<table>\`` header to its last `ON public.<table> TO
 * ohmail_admin;`. A test that builds a database as it stood before that table's migration runs
 * this, because the shipped script refuses a table that does not exist yet.
 */
export const HARDEN_SCRIPT = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..", "scripts", "harden-staff-role.sql");

export function hardenScriptWithout(table: string): string {
  const script = readFileSync(HARDEN_SCRIPT, "utf8");
  const start = script.indexOf(`-- \`${table}\` (`);
  const tail = `ON public.${table} TO ohmail_admin;\n`;
  const end = script.lastIndexOf(tail);
  if (start < 0 || end < start) throw new Error(`the harden script has no stanza for ${table}`);
  const before = script.slice(0, start) + script.slice(end + tail.length);
  if (before.includes(table)) throw new Error(`taking out ${table}'s stanza left the table named elsewhere`);
  return before;
}
