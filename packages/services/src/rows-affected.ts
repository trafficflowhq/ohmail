/**
 * Rows affected by a write, across the three drivers this repo runs: postgres-js returns an array
 * carrying `.count`, PGlite returns `{ affectedRows }`, node-postgres returns `{ rowCount }`.
 *
 * ONE copy, because the second one was wrong in the way that does not fail: a helper reading only
 * `rowCount` answers 0 for every statement on postgres-js, so an erasure receipt reported "nothing
 * removed" while the rows were gone — a count nobody can tell from a no-op. Only receipts and
 * audit lines read this; no deletion depends on it.
 */
export function rowsAffected(r: unknown): number {
  if (r == null) return 0;
  const o = r as { rowCount?: unknown; affectedRows?: unknown; count?: unknown };
  if (typeof o.rowCount === "number") return o.rowCount;
  if (typeof o.affectedRows === "number") return o.affectedRows;
  if (typeof o.count === "number") return o.count;
  return Array.isArray(r) ? r.length : 0;
}
