import { ruleMatchKey } from "@trafficflow/core/rule-order";
import { outranks } from "./consent-cutline.js";
import { storedRuleDestination } from "./selectors.js";
import type { EngineMutation, Folder, RuleDTO } from "./types.js";

/**
 * A SUBJECT'S RULE TWINS AND WHAT A SCREENING PRESS WRITES OVER THEM — the ladder past the gate,
 * one function for the web sheet and the phone's. The twins are the enabled, term-free rules of
 * one kind naming one match; a term rule is a slice, never a twin. `already` is asked of the
 * WINNER under the router's order ({@link outranks}): a losing twin at the pressed place files
 * nothing there. The press is ONE write over the winner: the server converges the key onto the
 * row a PATCH names and deletes the others, so a second write would name a row already gone.
 */
export type TwinPressState = "created" | "retargeted" | "already";

export interface TwinPress {
  state: TwinPressState;
  /** At most one: the create, or the one PATCH over the winner (a retarget, a re-arm or a claim). */
  writes: EngineMutation[];
  /**
   * `already`, over a winner ohmail inferred: the press makes it the person's, so their automated
   * mail follows it too (`people_only` refiles an inference's). The toast says that, not "already".
   */
  claimed: boolean;
}

/** `match` is the caller's normalized address or domain — the string a created rule carries. */
export function ruleTwins(rules: readonly RuleDTO[], kind: "sender" | "domain", match: string): RuleDTO[] {
  return rules.filter((r) => r.enabled
    && r.kind === kind
    && (r.subjectContains ?? "").trim() === ""
    && (r.bodyContains ?? "").trim() === ""
    && ruleMatchKey(r.match) === match);
}

/**
 * The twins a press at `wanted` rewrites: every one filing elsewhere. The sheet's ladder and the
 * decide's overlay both read it, so what the list shows after a decide is what the server wrote.
 */
export function twinsElsewhere(
  rules: readonly RuleDTO[], kind: "sender" | "domain", match: string, wanted: Folder,
): RuleDTO[] {
  return ruleTwins(rules, kind, match).filter((r) => r.destination !== wanted);
}

/** The twin the router files the subject's mail by — the minimum under its order, input order aside. */
export function twinWinner(twins: readonly RuleDTO[]): RuleDTO | null {
  let winner: RuleDTO | null = null;
  for (const r of twins) if (winner === null || outranks(r, winner)) winner = r;
  return winner;
}

/**
 * ONE ROW PER KEY, for a ladder that writes over a list of a sender's rules: the rows grouped by
 * their four-field key, the router's winner of each group (on before paused). The server converges
 * a key onto the row a PATCH names and a DELETE takes every row under its key, so a ladder that
 * wrote once per ROW would send a second write naming a row the first already removed (404).
 */
export function oneRowPerKey(rules: readonly RuleDTO[]): RuleDTO[] {
  const groups = new Map<string, RuleDTO[]>();
  for (const r of rules) {
    const k = JSON.stringify([r.kind, ruleMatchKey(r.match), r.subjectContains ?? null, r.bodyContains ?? null]);
    const g = groups.get(k);
    if (g) g.push(r); else groups.set(k, [r]);
  }
  return [...groups.values()].map((g) => twinWinner(g.filter((r) => r.enabled)) ?? g[0]!);
}

export function pressOverTwins(
  rules: readonly RuleDTO[], kind: "sender" | "domain", match: string, wanted: Folder, applyRetro: boolean,
): TwinPress {
  const twins = ruleTwins(rules, kind, match);
  if (twins.length === 0) {
    return { state: "created", writes: [{ kind: "rule_create", ruleKind: kind, match, destination: wanted, applyRetro }], claimed: false };
  }
  // An explicit `applyRetro: true` on a PATCH that does not move the rule is the server's re-arm,
  // in the STORED spelling: a re-arm moves nothing, so it never rewrites a pre-0.22 News rule.
  // With the backlog declined, the WINNER at the place is still CLAIMED when ohmail inferred it:
  // the same PATCH with `applyRetro: false` makes it the person's and moves nothing. Over twins the
  // PATCH is written even then, because it is what collapses them; a lone manual winner at the
  // place with the backlog declined is left alone.
  const winner = twinWinner(twins)!;
  const already = winner.destination === wanted;
  const claimed = already && winner.provenance !== "manual";
  const write = !already || applyRetro || claimed || twins.length > 1;
  const writes: EngineMutation[] = write
    ? [{ kind: "rule_update", ruleId: winner.id, destination: already ? storedRuleDestination(winner) : wanted, applyRetro }]
    : [];
  return {
    state: already ? "already" : "retargeted",
    writes,
    claimed,
  };
}
