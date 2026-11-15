import type postgres from "postgres";
import {
  codePhrase, expectedPolicies, isLogin, isPartitioned, lockDrift, lockedOf, loginsOf, markerOf, partitionPhrase, policyDifferences,
  readLockFacts, readerDifferences, readerOf, viewDifferences, viewGrants, viewOf, viewsStand, type LockFacts, type LockMarker,
} from "./census.js";
import { LOCK_READERS, READER_SCHEMA } from "./names.js";
import { tableClass } from "./policies.js";
import { ACCOUNT_VIEWS, viewName } from "./views.js";

/**
 * THE LOCK'S CHECK: what the catalog says about the lock, and the verdict a handle is built on.
 * The reading is `readLock`; the verdict is the pure `lockVerdict` over it, so each state is a case
 * without a server.
 *
 * | Locked tables              | Marker  | Verdict        |
 * |----------------------------|---------|----------------|
 * | all on and forced          | none    | `locked`       |
 * | none on, none forced       | present | `off`          |
 * | all on and forced          | present | `stale_marker` |
 * | anything else, or a public table in no class, a partitioned table or a partition, code on a table that runs with its owner's rights, or an unreadable marker | either | `broken` |
 * | no runtime login, nothing on, no marker | — | `absent` |
 *
 * Asked for an expected role (the host names it: the Cloud's API says `ohmail_api`), the connected
 * role must be it, may not bypass, owns nothing, is a member of nothing, can reach no view,
 * materialized view or foreign table of `public` by any grant, on it or on one of its columns, to
 * read or write (each answers with another role's rights: its owner's, or its user mapping's), and
 * run no SECURITY DEFINER routine there, and the policies
 * naming it, a policy to PUBLIC among them, are the list's, each as listed and as the step made
 * it; otherwise `broken`. So the check fails closed for that role on a policy naming it on a locked
 * table that is ALTERED (its catalog spelling no longer has the digest recorded when the step made
 * it), UNRECORDED (no record of the lock's, or one of another row of the list), restrictive, or of
 * another verb or roles (the dispatcher's ruling, 2026-11-15). A policy nobody touched compares
 * equal by construction: the recorded digest is of the catalog's own spelling, read back right
 * after the step made it (a fresh lock, and a dump restored onto a server with the roles, read
 * equal on 16 and 17). An owner who rewrites a policy's record after altering the policy, or a
 * view's after making the view again, is outside what this check claims: it holds the catalog's
 * spelling against the record, and an owner can rewrite both. Unjudged, the policies are the
 * census's lines.
 *
 * THE SPELLING IS PINNED. An interval constant prints as IntervalStyle says (the worker's horizon
 * policies), and every identifier and type name as quote_all_identifiers says (every policy, the
 * readers' return type): read under a session's, a database's or a role's other value of either,
 * an untouched lock read broken. So the reading pins, for its transaction alone, the settings the
 * catalog's spelling follows (`SPELLING_SETTINGS` in `census.ts`: an empty search path,
 * IntervalStyle `postgres`, quote_all_identifiers off, and DateStyle `ISO, MDY` and TimeZone UTC
 * for the day a policy carries a date), and the step records each policy's spelling under the same
 * pins. This loosens nothing: the spelling becomes the catalog's alone, and a policy that differs
 * still differs. A setting that moves the spelling of a constant the list carries none of (a float
 * by extra_float_digits, a backslash in a string by standard_conforming_strings, a bytea by
 * bytea_output) is not pinned: a policy that carries one brings its pin.
 *
 * Whatever role reads, these are `broken` always: a policy to PUBLIC on a locked table (it names
 * every role); code on a table of `public` that runs with its owner's rights, whoever fires it (a
 * rewrite rule; a trigger, a default or generated column, a constraint or an index that calls a
 * SECURITY DEFINER routine, whatever the routine's schema and grants: a table's owner bypasses, so
 * it reads and writes past the lock); where the runtime logins exist, a reader that is missing or
 * not the list's (one made IMMUTABLE answers the account a cached plan was made under to the next
 * transaction), USAGE on the readers' schema for any role but the two logins (theirs is the rule's
 * while one of the account's views stands there), one of the account's views that is not as listed
 * (its kind, owner, options, columns or text, code on it (a rule beside its `_RETURN`, a trigger, a
 * default on a column: a rule or an INSTEAD OF trigger takes its writes away from the check option
 * for every holder of a verb), a security label, or the step's record on it), and any right on one
 * of those views beyond the two logins' SELECT (another role's, PUBLIC's, a login's other verb,
 * its grant option, a column grant: through a view an insert … on conflict do update by a login
 * holding both verbs takes another account's row, and a holder of the grant option hands the view
 * to anybody); and a role- or database-level value of the binding's settings (it would bind every
 * session to one account). A
 * view the list names that is missing is the census's line: the next setup makes it again, and
 * meanwhile a read of it fails. Asked for a role, the role must also reach nothing of the readers'
 * schema beside the account's views (no other relation, no SECURITY DEFINER routine).
 *
 * Code on a table is read where it depends on the routine itself (`pg_depend`): a routine reached
 * at one remove (through an operator, a domain, a type, or another routine's body) is outside what
 * this check claims. So is an event trigger: it is on no table, only a superuser makes one, and its
 * function, a SECURITY DEFINER one among them, runs for whatever session runs DDL (a login's
 * temporary table fires it); no runtime path runs DDL, and a definer event trigger a host ships
 * reads past the lock for the session that fires it.
 *
 * THE VIEWS answer a row to the two runtime logins alone, each to its bound account, and refuse an
 * insert from anybody else. Their check option keeps an update or a delete through a view inside the
 * bound account; an insert … on conflict do update is not held by it (the view's condition is not
 * asked of the row the conflict finds), and a rule or a trigger on a view voids it for every holder of
 * a verb: so any right on a view beyond the two logins' SELECT, and any code on one, is broken above.
 * They are not a barrier. A statement run as a login may have its own function, operator or cast
 * given a row of another account in any shape of statement (a plain WHERE is enough); any other role
 * that holds SELECT on a view, only below an outer join; and while it plans, a value the statistics
 * kept: before the account and the reader are compared. Who holds SELECT there is held by the runtime
 * roles' census at each release and by this step's postcondition. A role given it between two checks
 * is outside what this check claims, until the next.
 *
 * Armed later: `locked`, `off` and `stale_marker` serve.
 */
export type LockVerdictWord = "absent" | "locked" | "off" | "stale_marker" | "broken";

/** How the catalog's facts name the pseudo-role every role is a member of (`polroles` holds 0). */
const PUBLIC = "public";

export interface LockReading {
  readonly verdict: LockVerdictWord;
  /** Why `broken`, in catalog names. */
  readonly why: readonly string[];
  readonly listed: number;
  readonly on: number;
  readonly forced: number;
  readonly marker: LockMarker | null;
  /** The connected role, and whether the policies naming it are the list's (`not-judged` when no role was expected). */
  readonly role: { readonly name: string; readonly bypass: boolean; readonly owns: number; readonly member: number; readonly policies: "equal" | "differ" | "not-judged" };
  /** Lines of the census: the catalog against the list. A difference alone is no verdict. */
  readonly census: number;
  /** The account's views standing as listed (of the list's three). */
  readonly views: number;
}

/** The verdict over `facts`; `expect` names the role the host means to serve as. */
export function lockVerdict(facts: LockFacts, expect?: { readonly role: string }): LockReading {
  const why: string[] = [];
  const locked = lockedOf(facts);
  const marker = markerOf(facts);
  const on = locked.filter((t) => t.rls).length;
  const forced = locked.filter((t) => t.forced).length;
  const allLocked = locked.every((t) => t.rls && t.forced);
  const noneLocked = locked.every((t) => !t.rls && !t.forced);
  for (const t of facts.tables) {
    if (isPartitioned(t)) why.push(`${t.name} is ${partitionPhrase(t)}`);
    else if (tableClass(t.name, t.account) === null) why.push(`a table of public in no class: ${t.name}`);
  }
  for (const c of facts.code) why.push(`on ${c.table}, ${codePhrase(c)}`);
  if (marker === "unreadable") why.push("the marker cannot be read");
  for (const b of facts.bindingSettings) why.push(`the binding's setting stands on a role or a database: ${b}`);
  const lockedNames = new Set(locked.map((t) => t.name));
  for (const p of facts.policies) if (lockedNames.has(p.table) && p.roles.includes(PUBLIC)) why.push(`a policy names PUBLIC: ${p.table}.${p.name}`);
  if (loginsOf(facts).length > 0) {
    if (facts.schema === null) why.push(`the readers' schema ${READER_SCHEMA} is missing`);
    else {
      for (const r of LOCK_READERS) {
        const f = readerOf(facts, r);
        const differs = f === undefined ? null : readerDifferences(f, r, facts.schema.owner);
        if (differs === null) why.push(`the reader ${READER_SCHEMA}.${r.name} is missing`);
        else if (differs.length > 0) why.push(`the reader ${READER_SCHEMA}.${r.name} differs: ${differs.join(", ")}`);
      }
      // A login's USAGE is the rule's while one of the account's views stands there.
      const standing = viewsStand(facts);
      for (const role of facts.schema.usage) if (!(standing && isLogin(role))) why.push(`${role} holds USAGE on the schema ${READER_SCHEMA}`);
      for (const v of ACCOUNT_VIEWS) {
        const f = viewOf(facts, v);
        if (f === undefined) continue;
        const differs = viewDifferences(f, v, facts.schema.owner, facts);
        if (differs.length > 0) why.push(`the view ${viewName(v)} differs: ${differs.join(", ")}`);
        const granted = viewGrants(f);
        if (granted.length > 0) why.push(`the view ${viewName(v)} is granted beyond the two logins' SELECT: ${granted.join("; ")}`);
      }
    }
  }

  let state: LockVerdictWord;
  if (loginsOf(facts).length === 0) {
    state = noneLocked && marker === null ? "absent" : "broken";
    if (state === "broken") why.push("tables are locked or marked on a server without the runtime logins");
  } else if (marker === null) {
    state = allLocked ? "locked" : "broken";
    if (!allLocked) why.push(`${on} of ${locked.length} locked tables on and ${forced} forced, with no marker`);
  } else if (marker === "unreadable") {
    state = "broken";
  } else if (noneLocked) {
    state = "off";
  } else if (allLocked) {
    state = "stale_marker";
  } else {
    state = "broken";
    why.push(`${on} of ${locked.length} locked tables on and ${forced} forced, with the marker`);
  }

  let policies: LockReading["role"]["policies"] = "not-judged";
  const c = facts.connected;
  if (expect !== undefined) {
    if (c.name !== expect.role) why.push(`connected as ${c.name}, not ${expect.role}`);
    if (c.bypass || c.super) why.push(`${c.name} may bypass row security`);
    if (c.owns > 0) why.push(`${c.name} owns objects`);
    if (c.member > 0) why.push(`${c.name} is a member of a role`);
    if (c.views > 0) why.push(`${c.name} may reach a view or a foreign table of public`);
    if (c.definers > 0) why.push(`${c.name} may run a SECURITY DEFINER routine of public`);
    if (c.ohmail > 0) why.push(`${c.name} may reach a relation of the schema ${READER_SCHEMA} beside the account's views, or run a SECURITY DEFINER routine there`);
    const rows = expectedPolicies(facts);
    const listed = new Map(rows.map((r) => [`${r.table}.${r.name}`, r]));
    // A policy to PUBLIC names this role too; the list never writes one.
    const naming = facts.policies.filter((p) => p.roles.includes(expect.role) || p.roles.includes(PUBLIC));
    // Each listed policy naming the role, on a locked table, as the list has it and as it was made.
    let asListed = true;
    for (const p of naming) {
      const r = listed.get(`${p.table}.${p.name}`);
      if (r === undefined || !lockedNames.has(p.table)) continue;
      const differs = policyDifferences(p, r);
      if (differs.length === 0) continue;
      asListed = false;
      why.push(`the policy ${p.table}.${p.name} naming ${expect.role} is not as listed: ${differs.map((d) => d.detail).join("; ")}`);
    }
    const wanted = rows.filter((r) => r.roles.includes(expect.role as never)).map((r) => `${r.table}.${r.name}`).sort();
    const held = naming.map((p) => `${p.table}.${p.name}`).sort();
    const sameNames = wanted.length === held.length && wanted.every((w, i) => w === held[i]);
    if (!sameNames) why.push(`the policies naming ${expect.role} are not the list's`);
    policies = sameNames && asListed ? "equal" : "differ";
  }
  const verdict: LockVerdictWord = why.length > 0 ? "broken" : state;
  return {
    verdict, why, listed: locked.length, on, forced, marker: marker === "unreadable" ? null : marker,
    role: { name: c.name, bypass: c.bypass || c.super, owns: c.owns, member: c.member, policies },
    census: lockDrift(facts).length,
    views: facts.schema === null ? 0 : ACCOUNT_VIEWS.filter((v) => {
      const f = viewOf(facts, v);
      return f !== undefined && viewDifferences(f, v, facts.schema!.owner, facts).length === 0;
    }).length,
  };
}

/** Read the lock in a read-only transaction of its own, and give its verdict. */
export async function readLock(sql: Pick<postgres.Sql, "begin">, expect?: { readonly role: string }): Promise<LockReading> {
  return await sql.begin("read only", async (tx) => lockVerdict(await readLockFacts(tx), expect)) as LockReading;
}

/**
 * What the health answer publishes of a reading: the verdict, the counts, the census, which relations
 * this instance's index-driven reads go through, and when off, since when, by whom and why.
 */
export interface LockHealthLine {
  readonly verdict: LockVerdictWord;
  readonly role: string;
  readonly listed: number;
  readonly forced: number;
  readonly census: "equal" | "drift";
  readonly policies: "equal" | "differ" | "not-judged";
  /** The account's views standing as listed: the store's. */
  readonly views: number;
  /**
   * The instance's own road: the relations its pool's index-driven reads were answered (`accountRows`),
   * `unasked` before its first. A pool made while the views stood unreadable reads `tables` for its life.
   */
  readonly reads: "views" | "tables" | "unasked";
  readonly since?: string;
  readonly by?: string;
  readonly why?: string;
}

/** The health line of reading `r`, with `reads`: the road the instance's pool was answered (`accountRowsAnswered`), `null` before it was. */
export function lockHealthLine(r: LockReading, reads: "views" | "tables" | null = null): LockHealthLine {
  return {
    verdict: r.verdict, role: r.role.name, listed: r.listed, forced: r.forced,
    census: r.census === 0 ? "equal" : "drift", policies: r.role.policies, views: r.views, reads: reads ?? "unasked",
    ...(r.marker === null ? {} : { since: r.marker.since, by: r.marker.by, why: r.marker.why }),
  };
}
