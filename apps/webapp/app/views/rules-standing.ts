import { domainOfAddress, ruleMatchKey, type RuleDTO, type WaitingOnOrganizerView } from "@ohmail/client-engine";
import { addressPriorityOver, compareTwins, effectForDestination } from "@trafficflow/core/rule-order";
import { canonicalDestination } from "@trafficflow/core/folder-name";

/**
 * WHAT THE RULES PAGE SAYS ABOUT EACH RULE BESIDE THE RULE ITSELF — the state the organizer acts
 * on: one row per key (the twin the router runs), what waits on the organizer, and whether an
 * address rule outranks its domain's. Pure, over the mirror's rules and the engine's waiting list.
 */

/** A rule's key: kind, `ruleMatchKey`, and both terms. Twins share one. */
export function ruleKeyOf(r: { kind: string; match: string; subjectContains?: string | null; bodyContains?: string | null }): string {
  // The terms as the organizer compares them (exactly), so two rows are twins here only where
  // a removal there takes both.
  return JSON.stringify([r.kind, ruleMatchKey(r.match), r.subjectContains ?? null, r.bodyContains ?? null]);
}

const ordered = (r: RuleDTO) => ({ ...r, effect: effectForDestination(canonicalDestination(r.destination)) });

/**
 * ONE ROW PER KEY: the twin the router runs (`compareTwins` — on before paused, then the router's
 * order, the same function the organizer's key lookup is held to), and the twins behind it.
 * `copies` counts them; `others` names them, so a twin filing elsewhere is said as a rule of its
 * own. Rows that arrived as twins collapse on the next press under their key: a Remove takes them
 * all, a change or a Screener decision converges them onto the one row it writes.
 */
export function actingRules(rules: readonly RuleDTO[]): {
  shown: RuleDTO[]; copies: ReadonlyMap<string, number>; others: ReadonlyMap<string, RuleDTO[]>;
} {
  const byKey = new Map<string, RuleDTO[]>();
  for (const r of rules) {
    const k = ruleKeyOf(r);
    const list = byKey.get(k);
    if (list) list.push(r); else byKey.set(k, [r]);
  }
  const acting = new Map<string, RuleDTO>();
  const copies = new Map<string, number>();
  const others = new Map<string, RuleDTO[]>();
  for (const list of byKey.values()) {
    const [winner, ...rest] = [...list].sort((a, b) => compareTwins(ordered(a), ordered(b)));
    acting.set(winner!.id, winner!);
    if (rest.length > 0) { copies.set(winner!.id, rest.length); others.set(winner!.id, rest); }
  }
  // The list's own order, newest first, kept: only the losing twins leave it.
  return { shown: rules.filter((r) => acting.has(r.id)), copies, others };
}

/**
 * THE WAITING LIST, SPLIT: a request about a rule this page shows rides that rule's row (by key,
 * so a twin's request reaches the acting row); the rest — a rule removed here on a mixed account,
 * a create the organizer has not made — are listed apart, at the top.
 */
export function waitingByRow(
  waiting: readonly WaitingOnOrganizerView[], shown: readonly RuleDTO[], all: readonly RuleDTO[],
): { onRow: ReadonlyMap<string, WaitingOnOrganizerView>; apart: WaitingOnOrganizerView[] } {
  const rowOfKey = new Map(shown.map((r) => [ruleKeyOf(r), r.id]));
  const keyOfId = new Map(all.map((r) => [r.id, ruleKeyOf(r)]));
  const onRow = new Map<string, WaitingOnOrganizerView>();
  const apart: WaitingOnOrganizerView[] = [];
  for (const w of waiting) {
    const t = w.target as { rule?: { kind: string; match: string; subjectContains: string | null; bodyContains: string | null } };
    const key = t.rule ? ruleKeyOf(t.rule) : w.ruleId ? keyOfId.get(w.ruleId) : undefined;
    const row = key === undefined ? undefined : rowOfKey.get(key);
    // The newest request about a row speaks for it; the list is newest first.
    if (row !== undefined) { if (!onRow.has(row)) onRow.set(row, w); } else apart.push(w);
  }
  return { onRow, apart };
}

/** An address rule against its domain's rules filing elsewhere — see {@link outrankOf}. */
export type Outrank =
  | { kind: "outranks"; domain: string; place: string }
  | { kind: "outranked"; domain: string; place: string };

/**
 * DOES THIS ADDRESS RULE STILL DECIDE ITS SENDER? `outranks` when it was lifted above a domain
 * rule filing elsewhere (said, so the lift is visible); `outranked` when such a rule now ranks
 * above it, so the domain's rule decides — the case a later change of the domain rule leaves.
 * The one reader of the order, `addressPriorityOver`, as the write's own lift asks it.
 */
export function outrankOf(rule: RuleDTO, rules: readonly RuleDTO[]): Outrank | null {
  if (rule.kind !== "sender" || !rule.enabled) return null;
  const domain = domainOfAddress(ruleMatchKey(rule.match));
  if (!domain) return null;
  const mine = canonicalDestination(rule.destination);
  const covering = rules
    .filter((r) => r.enabled && r.kind === "domain" && ruleMatchKey(r.match) === domain
      && canonicalDestination(r.destination) !== mine)
    .sort((a, b) => b.priority - a.priority);
  const top = covering[0];
  if (!top) return null;
  const need = addressPriorityOver(covering.map((r) => ({ priority: r.priority, destination: canonicalDestination(r.destination) })), mine, rule.priority);
  if (need !== null && need > rule.priority) return { kind: "outranked", domain, place: top.destination };
  return rule.priority > 0 ? { kind: "outranks", domain, place: top.destination } : null;
}

/**
 * ARE THE TWINS BEHIND A ROW COPIES, or rules of their own? Copies file where the row files and are
 * on or off with it; a twin filing elsewhere, or paused where the row is on, is a different rule
 * the person has not seen, and the page names it with its place before a Remove takes it.
 */
export function twinsDiffer(rule: RuleDTO, others: readonly RuleDTO[]): boolean {
  const mine = canonicalDestination(rule.destination);
  return others.some((o) => canonicalDestination(o.destination) !== mine || o.enabled !== rule.enabled);
}
