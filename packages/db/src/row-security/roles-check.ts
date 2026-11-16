import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { pgTlsOptions } from "../pg-tls.js";
import { withPgSocket } from "../pg-socket.js";

/**
 * THE RUNTIME ROLES' CHECK, before the lock step writes anything. The roles' script is a copy of
 * the deploy tools' own (`scripts/harden-runtime-roles.sql`, never edited here); its read-only half
 * is the census of what each login can effectively do. The lock is made only over logins that own
 * nothing, may not bypass and are members of nothing, so a refusal here is a refusal of the step.
 *
 * One arm is cut, by its fence: `census.relations`, which wants every table granted as the rule
 * writes. A table a release just made has no grant yet (the roles' script grants it on its next run,
 * after the setup), and the lock must be made on that table BEFORE it is granted. Read only at the
 * moment the step acts, never on a server without the logins.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
/** The copied script, from this module's place in the tree (`src` and `dist` alike). */
export const RUNTIME_ROLES_SCRIPT = join(HERE, "..", "..", "..", "..", "scripts", "harden-runtime-roles.sql");

/** The arms the lock step's check runs without. */
export const ROLES_CHECK_CUT = ["census.relations"] as const;

/**
 * The read-only stream: `BEGIN READ ONLY`, the shape section, the census section without the `cut`
 * arms, `ROLLBACK`. Throws when a marker or a fence is not there exactly once.
 */
export function rolesCheckStream(text: string, cut: readonly string[] = ROLES_CHECK_CUT): string {
  const lines = text.split("\n");
  const at = (marker: string): number => {
    const hits = lines.flatMap((l, i) => (l.trim() === marker ? [i] : []));
    if (hits.length !== 1) throw new Error(`the roles' script holds the marker '${marker}' ${hits.length} times, not once`);
    return hits[0]!;
  };
  const shape = lines.slice(at("-- @shape"), at("-- @provision"));
  let census = lines.slice(at("-- @census"), at("-- @commit"));
  for (const arm of cut) {
    const from = census.findIndex((l) => l.trim() === `-- @clause ${arm}`);
    const to = census.findIndex((l) => l.trim() === `-- @end ${arm}`);
    if (from < 0 || to < from) throw new Error(`the roles' script has no fenced arm '${arm}'`);
    census = [...census.slice(0, from), ...census.slice(to + 1)];
  }
  return ["BEGIN READ ONLY;", ...shape, ...census, "ROLLBACK;"].join("\n");
}

export interface RolesCheck {
  /** `ROLES_OK` was said and nothing was refused. */
  readonly ok: boolean;
  /** What the check refused: its `ROLES_DRIFT` and `ROLES_REFUSED` lines, catalog names only. */
  readonly refusals: readonly string[];
}

/** Run the check on a connection of its own, signed in as `url`'s role (the migrator). */
export async function runRolesCheck(url: string, scriptPath: string = RUNTIME_ROLES_SCRIPT): Promise<RolesCheck> {
  const stream = rolesCheckStream(readFileSync(scriptPath, "utf8"));
  const said: string[] = [];
  const sql = postgres(url, withPgSocket({
    ...pgTlsOptions(url), max: 1, idle_timeout: 0, onnotice: (n: postgres.Notice) => said.push(String(n.message ?? "")),
  }));
  let error = "";
  try {
    await sql.unsafe(stream).simple();
  } catch (e) {
    error = String((e as { message?: unknown }).message ?? e);
  } finally {
    await sql.end({ timeout: 5 }).catch(() => undefined);
  }
  const refusals = said.filter((m) => /^ROLES_(DRIFT|REFUSED)\b/.test(m));
  if (error !== "") refusals.push(/^ROLES_/.test(error) ? error : `the check could not run: ${error}`);
  const ok = error === "" && said.some((m) => m.startsWith("ROLES_OK"));
  return { ok, refusals: ok ? [] : refusals.length > 0 ? refusals : ["the check said no ROLES_OK"] };
}
