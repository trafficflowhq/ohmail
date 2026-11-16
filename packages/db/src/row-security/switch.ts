import postgres from "postgres";
import { pgTlsOptions } from "../pg-tls.js";
import { withPgSocket } from "../pg-socket.js";
import { assertExpectedHost, assertSessionUrl } from "../setup-prod.js";
import { READER_SCHEMA } from "./names.js";
import { lockDrift, lockedOf, markerOf, markerText, readLockFacts, type Exec, type LockFacts, type MarkerWhy } from "./census.js";

/**
 * THE SWITCH: the lock off, and on again, as the migrator, in one transaction each way.
 *
 * Off: row security disabled and its forcing taken off on every locked table, and the marker on the
 * readers' schema (`ohmail.lock off since=<UTC> by=<role> why=<word>`, no free text). Forcing alone
 * would release nobody: it binds only a table's owner, and the logins own nothing. On: the census
 * must read the list first (the flags and the marker aside), then every locked table is enabled and
 * forced and the marker cleared. Policies are never dropped. The marker is the schema's comment,
 * not a database setting: a role that is no superuser may not set an unknown parameter on its
 * database, and the comment needs no table and no grant, commits with the switch, and is read by
 * any role.
 *
 * Each statement takes the strongest lock on its table, so the switch waits at most a short lock
 * timeout and is retried whole; a failure changes nothing. Provisioning only: no request reaches it.
 */
export const SWITCH_LOCK_TIMEOUT_MS = 5_000;
export const SWITCH_TRIES = 3;

export interface SwitchReport {
  readonly to: "off" | "on";
  /** Locked tables switched. */
  readonly tables: number;
  /** The marker written (off) or cleared (on). */
  readonly marker: string | null;
  readonly tries: number;
}

export class LockSwitchRefused extends Error {
  constructor(readonly reason: string) {
    super(`refusing to switch the lock: ${reason}`);
    this.name = "LockSwitchRefused";
  }
}

const quote = (name: string): string => `"${name.replace(/"/g, '""')}"`;

/** Refuse unless the session is the migrator itself, owning the readers' schema and every locked table. */
function owner(facts: LockFacts): void {
  if (facts.session !== facts.user) throw new LockSwitchRefused("the session's user is not the current user");
  if (facts.schema === null) throw new LockSwitchRefused(`there is no schema ${READER_SCHEMA}: no lock was made here`);
  if (facts.schema.owner !== facts.user) throw new LockSwitchRefused(`${facts.user} does not own the schema ${READER_SCHEMA}`);
  const foreign = lockedOf(facts).filter((t) => t.owner !== facts.user).map((t) => t.name);
  if (foreign.length > 0) throw new LockSwitchRefused(`${facts.user} does not own ${foreign.length} locked tables (${foreign.slice(0, 3).join(", ")})`);
}

/** One try, in one transaction on `tx`. */
async function once(tx: Exec, to: "off" | "on", why: MarkerWhy | undefined, lockTimeoutMs: number, now: Date): Promise<Omit<SwitchReport, "tries">> {
  await tx.unsafe(`set local lock_timeout = '${lockTimeoutMs}ms'`);
  const facts = await readLockFacts(tx);
  owner(facts);
  const locked = lockedOf(facts).map((t) => t.name);
  let marker: string | null = null;
  if (to === "off") {
    marker = markerText({ since: now.toISOString(), by: facts.user, why: why! });
    const statements = locked.map((t) => `alter table public.${quote(t)} disable row level security, no force row level security`);
    await tx.unsafe([...statements, `comment on schema ${READER_SCHEMA} is '${marker.replace(/'/g, "''")}'`].join(";\n")).simple();
  } else {
    const drift = lockDrift(facts).filter((l) => !/^LOCK_DRIFT (tables\.flags|marker\.)/.test(l));
    if (drift.length > 0) throw new LockSwitchRefused(`the census is not the list's (${drift.length} lines, first: ${drift[0]})`);
    const statements = locked.map((t) => `alter table public.${quote(t)} enable row level security, force row level security`);
    await tx.unsafe([...statements, `comment on schema ${READER_SCHEMA} is null`].join(";\n")).simple();
  }
  const after = await readLockFacts(tx);
  const state = markerOf(after);
  const ok = to === "off"
    ? state !== null && state !== "unreadable" && lockedOf(after).every((t) => !t.rls && !t.forced)
    : state === null && lockDrift(after).length === 0;
  if (!ok) throw new LockSwitchRefused(`the lock did not read ${to} after the switch`);
  return { to, tables: locked.length, marker };
}

/**
 * Switch the lock `to` off (with `why`) or on, at `url`, a session address signed in as the
 * migrator. `expectedHost` pins the host as the setup does.
 */
export async function switchLock(
  url: string, to: "off" | "on",
  opts: { readonly why?: MarkerWhy; readonly expectedHost?: string; readonly lockTimeoutMs?: number; readonly tries?: number; readonly now?: () => Date } = {},
): Promise<SwitchReport> {
  assertSessionUrl(url);
  assertExpectedHost(url, opts.expectedHost);
  if (to === "off" && opts.why === undefined) throw new LockSwitchRefused("the lock is switched off only with a reason: incident, rehearsal or test");
  const sql = postgres(url, withPgSocket({ ...pgTlsOptions(url), max: 1, idle_timeout: 0, onnotice: () => {} }));
  const tries = opts.tries ?? SWITCH_TRIES;
  try {
    for (let n = 1; ; n++) {
      try {
        const done = await sql.begin((tx) => once(tx, to, opts.why, opts.lockTimeoutMs ?? SWITCH_LOCK_TIMEOUT_MS, (opts.now ?? (() => new Date()))()));
        return { ...done as Omit<SwitchReport, "tries">, tries: n };
      } catch (err) {
        // A table another transaction held: nothing changed; the whole switch is tried again.
        if ((err as { code?: string }).code !== "55P03" || n >= tries) throw err;
      }
    }
  } finally {
    await sql.end({ timeout: 5 }).catch(() => undefined);
  }
}
