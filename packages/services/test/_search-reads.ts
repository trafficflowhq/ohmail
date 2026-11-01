import type { SQL } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

/**
 * WHAT A SEARCH READS, for the server's search tests: every statement the service sends on a handle, on the
 * handle and inside any transaction it opens (where the page runs), a query builder's too (a page's rows and
 * their DTOs are ONE builder read), so a test can ask Postgres how it ran each one under the same session.
 */
export function recording<T extends object>(target: T, seen: SQL[]): T {
  return new Proxy(target, {
    get(t, p, r) {
      if (p === "execute") return (st: SQL) => { seen.push(st); return (t as { execute: (s: SQL) => unknown }).execute(st); };
      if (p === "select") return (...a: unknown[]) => recorded((t as { select: (...x: unknown[]) => object }).select(...a), seen);
      if (p === "transaction") {
        return (fn: (tx: unknown) => Promise<unknown>) =>
          (t as { transaction: (f: (tx: object) => Promise<unknown>) => Promise<unknown> }).transaction((tx) => fn(recording(tx, seen)));
      }
      return Reflect.get(t, p, r);
    },
  });
}

/** A query builder whose statement is recorded when it runs. */
function recorded<B extends object>(b: B, seen: SQL[]): B {
  return new Proxy(b, {
    get(t, p) {
      const v = Reflect.get(t, p, t) as unknown;
      if (p === "then" && typeof v === "function") {
        seen.push((t as unknown as { getSQL: () => SQL }).getSQL());
        return (v as (...x: unknown[]) => unknown).bind(t);
      }
      if (typeof v !== "function") return v;
      return (...a: unknown[]) => {
        const out = (v as (...x: unknown[]) => unknown).apply(t, a);
        return out !== null && typeof out === "object" && ("from" in out || "getSQL" in out) ? recorded(out, seen) : out;
      };
    },
  });
}

const pg = new PgDialect();
/** A statement's text as Postgres receives it. */
export const textOf = (st: SQL): string => pg.sqlToQuery(st).sql;
/** The session's own settings: replayed before each statement, never a read of their own. */
export const isSession = (st: SQL): boolean => textOf(st).includes("set_config");
/** The service's own planner estimate is an EXPLAIN already; it is not a read to plan. */
export const isExplain = (st: SQL): boolean => /^\s*explain\b/i.test(textOf(st));

/** A handle that runs a statement in a transaction of its own. */
export interface Explaining {
  transaction<R>(f: (tx: { execute(q: SQL): Promise<unknown> }) => Promise<R>): Promise<R>;
}

/** The shared buffers (hit and read) a statement touched as it ran, under the session settings. */
export async function buffersOf(on: Explaining, st: SQL, session: readonly SQL[]): Promise<number> {
  const r = (await on.transaction(async (tx) => {
    for (const s of session) await tx.execute(s);
    return tx.execute(sql`explain (analyze, buffers, format json) ${st}`);
  })) as unknown as Array<Record<string, unknown>>;
  const top = ((r[0]!["QUERY PLAN"] as Array<Record<string, unknown>>)[0]!)["Plan"] as Record<string, unknown>;
  return Number(top["Shared Hit Blocks"] ?? 0) + Number(top["Shared Read Blocks"] ?? 0);
}

/** One statement a search sent, as Postgres received it (text and parameters), and the shared buffers it read. */
export interface Read { readonly text: string; readonly buffers: number }

/**
 * `run`'s answer and each of its statements with the shared buffers it read (`seen`, the recording handle's
 * list, is emptied first), each replayed under its session's settings; the session statements are not reads.
 */
export async function readsEachOf<T>(on: Explaining, seen: SQL[], run: () => Promise<T>): Promise<{ out: T; reads: Read[] }> {
  seen.length = 0;
  const out = await run();
  const taken = [...seen];
  const session = taken.filter(isSession);
  const reads: Read[] = [];
  for (const st of taken.filter((x) => !isSession(x) && !isExplain(x))) {
    const q = pg.sqlToQuery(st);
    reads.push({ text: `${q.sql}\u0000${JSON.stringify(q.params)}`, buffers: await buffersOf(on, st, session) });
  }
  return { out, reads };
}

/** `run`'s answer and the shared buffers all its statements read ({@link readsEachOf}). */
export async function readsOf<T>(on: Explaining, seen: SQL[], run: () => Promise<T>): Promise<{ out: T; buffers: number }> {
  const { out, reads } = await readsEachOf(on, seen, run);
  return { out, buffers: reads.reduce((n, r) => n + r.buffers, 0) };
}

/**
 * The buffers `now`'s statements read where they are not `was`'s at their place, byte for byte, beside what
 * `was`'s read at those places: a statement the same as 0.30.19's reads what it reads, on any one database.
 */
export function differing(now: readonly Read[], was: readonly Read[]): { now: number; was: number } {
  let n = 0;
  let w = 0;
  for (let i = 0; i < Math.max(now.length, was.length); i++) {
    if (now[i]?.text === was[i]?.text) continue;
    n += now[i]?.buffers ?? 0;
    w += was[i]?.buffers ?? 0;
  }
  return { now: n, was: w };
}
