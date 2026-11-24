import type { ScreenerRow } from "../state/live";
import type { Destination } from "../state/model";

type Decide = (row: ScreenerRow, dest: Destination, read: boolean, peers: readonly ScreenerRow[], unsubscribe: readonly string[]) => unknown;
type Unsubscribe = (row: ScreenerRow, peers: readonly ScreenerRow[]) => readonly string[];

export interface SuggestedDecision {
  row: ScreenerRow;
  dest: Destination;
  unsubscribe: readonly string[];
  held: readonly string[];
}

function heldFor(row: ScreenerRow, peers: readonly ScreenerRow[]): string[] {
  const domain = row.address.split("@").at(-1)?.toLowerCase();
  return peers
    .filter((peer) => peer.routeKey === row.routeKey ||
      (row.scope === "domain" && peer.address.split("@").at(-1)?.toLowerCase() === domain))
    .flatMap((peer) => peer.held.map((letter) => letter.id)).sort();
}

export function planSuggestions(waiting: readonly ScreenerRow[], unsubscribe: Unsubscribe): SuggestedDecision[] {
  return waiting.flatMap((row) => {
    const dest = row.ai?.dest;
    if (!dest) return [];
    return [{
      row, dest, held: heldFor(row, waiting),
      unsubscribe: dest === "screened" || dest === "spam" ? unsubscribe(row, waiting) : [],
    }];
  });
}

export async function applySuggestions(plan: readonly SuggestedDecision[], current: () => readonly ScreenerRow[], decide: Decide): Promise<void> {
  const filed = new Set<string>();
  for (const item of plan) {
    const peers = current();
    const row = peers.find((peer) => peer.routeKey === item.row.routeKey);
    if (!row || row.id !== item.row.id || row.scope !== item.row.scope || row.ai?.dest !== item.dest) continue;
    const held = heldFor(row, peers);
    if (held.length !== item.held.length || held.some((id, index) => id !== item.held[index] || filed.has(id))) continue;
    held.forEach((id) => filed.add(id));
    await decide(row, item.dest, false, peers, item.unsubscribe);
  }
}
