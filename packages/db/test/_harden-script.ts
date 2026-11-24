import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * `scripts/harden-staff-role.sql` as it stood before the named tables' stanzas were added: the
 * shipped text with each stanza taken out, from its `-- \`<table>\`` header to its last `ON
 * public.<table> TO ohmail_admin;`. A test that builds a database as it stood before those tables'
 * migrations runs this, because the shipped script refuses a table that does not exist yet.
 *
 * A name written `<table>.<column>` takes one column out of that table's grants instead: a column
 * a later migration added to a table that already stood, which the shipped script refuses the
 * same way.
 */
export const HARDEN_SCRIPT = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..", "scripts", "harden-staff-role.sql");

export function hardenScriptWithout(...names: string[]): string {
  let script = readFileSync(HARDEN_SCRIPT, "utf8");
  for (const name of names) {
    const [table, column] = name.split(".") as [string, string | undefined];
    if (column !== undefined) {
      const grants = new RegExp(String.raw`(GRANT [A-Z]+ \([^)]*), ${column}(\)\s+ON public\.${table} TO ohmail_admin;)`, "g");
      const without = script.replace(grants, "$1$2");
      if (without === script) throw new Error(`the harden script grants no ${column} on ${table}`);
      script = without;
      continue;
    }
    const start = script.indexOf(`-- \`${table}\` (`);
    const tail = `ON public.${table} TO ohmail_admin;\n`;
    const end = script.lastIndexOf(tail);
    if (start < 0 || end < start) throw new Error(`the harden script has no stanza for ${table}`);
    script = script.slice(0, start) + script.slice(end + tail.length);
    if (script.includes(table)) throw new Error(`taking out ${table}'s stanza left the table named elsewhere`);
  }
  return script;
}

/** What the 2.0 window added to the script, for a database whose Cloud journal stops before it: cloud 0102's column and 0104's table. */
export const SINCE_2_0 = ["alert_state.subject_account_id", "account_closures"] as const;
