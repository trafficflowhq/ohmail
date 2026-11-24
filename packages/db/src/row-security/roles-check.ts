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
 * Two arms are cut, by their fences. `census.relations`, which wants every table granted as the
 * rule writes: a table a release just made has no grant yet (the roles' script grants it on its
 * next run, after the setup), and the lock must be made on that table BEFORE it is granted. And
 * `census.views-grants`, which wants the logins to hold exactly their rights on the account's views
 * while one stands: the step makes the views with no grant, so a setup run again before the roles'
 * apply finds them standing ungranted, and one run after a release dropped all three finds the
 * logins' USAGE on their schema left; both are states a deploy reaches. The views' text and grants
 * are the lock's own census's to judge (`views.differ`, `views.grants`). Every other arm stays, the
 * ones that name who else reaches a view among them (`census.views-schema`, `census.views-routines`,
 * `census.views-others`, `census.views-reach`). Read only at the moment the step acts, never on a
 * server without the logins.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
/** The copied script, from this module's place in the tree (`src` and `dist` alike). */
export const RUNTIME_ROLES_SCRIPT = join(HERE, "..", "..", "..", "..", "scripts", "harden-runtime-roles.sql");

/** The arms the lock step's check runs without. */
export const ROLES_CHECK_CUT = ["census.relations", "census.views-grants"] as const;

/**
 * What the check is sent under, for its transaction alone: quote_all_identifiers off. The script
 * compares names it formats with `%I` against the names its rule writes (`ohmail.messages`, the
 * readers), and with the setting on (a database's, a role's) every name is quoted and none is the
 * rule's: the check named the three views and both readers as foreign. Pinned as the lock's own
 * reading pins it (`SPELLING_SETTINGS`); the script's bytes are not touched.
 */
export const ROLES_CHECK_PIN = "SELECT pg_catalog.set_config('quote_all_identifiers', 'off', true);";

/**
 * The read-only stream: `BEGIN READ ONLY`, the pin, the shape section, the census section without
 * the `cut` arms, `ROLLBACK`. Throws when a marker or a fence is not there exactly once.
 */
export function rolesCheckStream(text: string, cut: readonly string[] = ROLES_CHECK_CUT): string {
  return ["BEGIN READ ONLY;", ...rolesCheckSections(text, cut), "ROLLBACK;"].join("\n");
}

/**
 * THE POSTCONDITION'S STREAM: the pin, the shape section and the census section without the `cut`
 * arms, and no `BEGIN` and no `ROLLBACK`. It is sent on the lock step's own connection, inside its
 * transaction, after the step made the account's views: so the check reads the views the step has
 * not yet committed (`has_table_privilege` and the catalog answer for the transaction's own work),
 * where a check on a connection of its own reads the store without them and says nothing. The shape
 * section's settings are the transaction's own, and end with it. A refusal is the census's
 * exception, which aborts the step's transaction: the step rolls back and the views are not made.
 */
export function rolesPostconditionStream(text: string, cut: readonly string[] = ROLES_CHECK_CUT): string {
  return rolesCheckSections(text, cut).join("\n");
}

/** The pin, the shape section and the census section without the `cut` arms; throws when a marker or a fence is not there exactly once. */
function rolesCheckSections(text: string, cut: readonly string[]): string[] {
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
  return [ROLES_CHECK_PIN, ...shape, ...census];
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
  return rolesVerdict(said, error);
}

/**
 * What a check said, as a verdict: `ROLES_OK` with no error, or every `ROLES_DRIFT` and `ROLES_REFUSED`
 * line it said (the census says one WARNING a drift, by name, and then raises with their count alone).
 */
export function rolesVerdict(said: readonly string[], error: string): RolesCheck {
  const refusals = said.filter((m) => /^ROLES_(DRIFT|REFUSED)\b/.test(m));
  if (error !== "") refusals.push(/^ROLES_/.test(error) ? error : `the check could not run: ${error}`);
  const ok = error === "" && said.some((m) => m.startsWith("ROLES_OK"));
  return { ok, refusals: ok ? [] : refusals.length > 0 ? refusals : ["the check said no ROLES_OK"] };
}

/** Hear what the step's own connection says, until the returned stop: the migration session's `hear`. */
export type HearNotices = (listener: (message: string) => void) => () => void;

/**
 * THE POSTCONDITION, on `tx` (the lock step's transaction), hearing `hear` (its connection's notices):
 * the roles' check again, after the step made the views and before it commits. A role that would
 * reach a view (a membership, an ADMIN option, a default privilege at the views' birth, an entry)
 * is named by the check's WARNING lines and refuses the step.
 */
export async function runRolesPostcondition(tx: { unsafe(query: string): { simple(): Promise<unknown> } }, hear: HearNotices,
  scriptPath: string = RUNTIME_ROLES_SCRIPT): Promise<RolesCheck> {
  const stream = rolesPostconditionStream(readFileSync(scriptPath, "utf8"));
  const said: string[] = [];
  const stop = hear((m) => said.push(m));
  let error = "";
  try {
    await tx.unsafe(stream).simple();
  } catch (e) {
    error = String((e as { message?: unknown }).message ?? e);
  } finally {
    stop();
  }
  return rolesVerdict(said, error);
}
