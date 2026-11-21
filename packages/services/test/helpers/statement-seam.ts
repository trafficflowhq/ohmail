/**
 * A SEAM AT THE DRIZZLE BUILDER, for a race proof on a bound handle. A bound view's statements run
 * in its factory's flights, on the factory's own client under the binding, so a seam on a raw
 * postgres.js client never sees them; the builder is where they still pass. `at` is asked once for
 * each statement, with its text (and its parameters), when the statement is run (awaited or executed): it answers how to
 * run it (refuse it, hold it) or `null` to run it as it is. Every builder, a transaction's handle
 * and one opened inside it are seen the same way. Wrap the bound handle itself (never bind the
 * wrapper: the binder refuses a wrapper of a bound view on a server); its mark, its session and its
 * dialect pass through untouched.
 */
export type StatementRun = () => Promise<unknown>;
export type StatementAct = (run: StatementRun) => Promise<unknown>;

/** A statement builder's text and parameters, as the driver will be sent them, or "" and none for anything else. */
function queryOf(b: object): { sql: string; params: unknown[] } {
  const s = b as { toSQL?: () => { sql: string; params: unknown[] }; getQuery?: () => { sql: string; params: unknown[] } };
  try {
    if (typeof s.toSQL === "function") return s.toSQL();
    if (typeof s.getQuery === "function") return s.getQuery();
  } catch {
    return { sql: "", params: [] };
  }
  return { sql: "", params: [] };
}

const isObject = (v: unknown): v is object => v !== null && typeof v === "object" && !(v instanceof Promise);

type At = (text: string, params: unknown[]) => StatementAct | null;
/** Each seam and the handle it wraps, so a binding the service names on it binds that handle and keeps the seam. */
const seams = new WeakMap<object, { handle: object; at: At }>();

/** `bindDb` as the services call it, except that a seam is bound through: its own handle is bound and the view wears the same seam. */
export function bindThroughSeams<F extends (db: never, to: never) => unknown>(bind: F): F {
  return ((db: object, to: unknown) => {
    const seam = seams.get(db);
    return seam ? statementSeam(bind(seam.handle as never, to as never) as object, seam.at) : bind(db as never, to as never);
  }) as unknown as F;
}

export function statementSeam<D extends object>(handle: D, at: At): D {
  const statement = (b: object): object => new Proxy(b, {
    get(t, p) {
      const v = Reflect.get(t, p) as unknown;
      if (typeof v !== "function") return v;
      const f = v as (...a: unknown[]) => unknown;
      if (p === "then") {
        return (ok?: (x: unknown) => unknown, ko?: (e: unknown) => unknown) => {
          const run: StatementRun = () => new Promise((res, rej) => { f.call(t, res, rej); });
          const q = queryOf(t);
          const act = at(q.sql, q.params);
          return (act === null ? run() : act(run)).then(ok, ko);
        };
      }
      if (p === "execute") {
        return (...a: unknown[]) => {
          const run: StatementRun = () => Promise.resolve(f.apply(t, a));
          const q = queryOf(t);
          const act = at(q.sql, q.params);
          return act === null ? run() : act(run);
        };
      }
      return (...a: unknown[]) => {
        const r = f.apply(t, a);
        return isObject(r) ? statement(r) : r;
      };
    },
  });
  const wrap = (h: object): object => new Proxy(h, {
    get(t, p) {
      const v = Reflect.get(t, p) as unknown;
      if (typeof v !== "function") return v;
      const f = v as (...a: unknown[]) => unknown;
      if (p === "transaction") {
        return (fn: (tx: object) => Promise<unknown>, ...rest: unknown[]) =>
          f.call(t, (tx: object) => fn(wrap(tx)), ...rest);
      }
      return (...a: unknown[]) => {
        const r = f.apply(t, a);
        return isObject(r) ? statement(r) : r;
      };
    },
  });
  const seam = wrap(handle);
  seams.set(seam, { handle, at });
  return seam as D;
}
