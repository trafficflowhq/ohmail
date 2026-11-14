/**
 * WHO IS OPEN AFTER A DECISION: the undecided row that takes the decided row's place, else the nearest one above it,
 * else nobody. Never a sender already decided, and never the top of the list, where a sender who just arrived sits.
 */
export function nextAfterDecision(
  ids: readonly string[],
  currentId: string,
  open: (id: string) => boolean,
): string | null {
  const at = ids.indexOf(currentId);
  if (at < 0) return null;
  const below = ids.slice(at + 1);
  const above = ids.slice(0, at).reverse();
  return [...below, ...above].find((id) => id !== currentId && open(id)) ?? null;
}
