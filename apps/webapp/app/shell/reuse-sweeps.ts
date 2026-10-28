/** One reuse sweep as `GET /auth/session` lists it: its id, when, and the swept session's device kind or null. */
export interface ReuseSweepLine {
  id: string;
  at: string;
  client: string | null;
}

/** The `reuseSweeps` field off a session answer, entry by entry; anything not that shape is left out. */
export function reuseSweepLinesOf(value: unknown): ReuseSweepLine[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((s: { id?: unknown; at?: unknown; client?: unknown } | null): ReuseSweepLine[] =>
    typeof s?.id === "string" && typeof s.at === "string"
      ? [{ id: s.id, at: s.at, client: typeof s.client === "string" ? s.client : null }]
      : []);
}
