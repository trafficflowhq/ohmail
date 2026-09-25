import { outranks } from "./consent-cutline.js";
import type { EngineMutation, Folder, RuleDTO } from "./types.js";

/**
 * A SUBJECT'S RULE TWINS AND WHAT A SCREENING PRESS WRITES OVER THEM — the ladder past the gate,
 * one function for the web sheet and the phone's. The twins are the enabled, term-free rules of
 * one kind naming one match; a term rule is a slice, never a twin. `already` is asked of the
 * WINNER under the router's order ({@link outranks}): a losing twin at the pressed place files
 * nothing there. The write leaves every twin at that place — each one elsewhere retargeted, each
 * one there re-armed when the backlog answer is yes — so the Rules page shows what was pressed.
 */
export type TwinPressState = "created" | "retargeted" | "already";

export interface TwinPress {
  state: TwinPressState;
  /** In dispatch order: the retargets, then the re-arms, or the one create. */
  writes: EngineMutation[];
}

/** `match` is the caller's normalized address or domain — the string a created rule carries. */
export function ruleTwins(rules: readonly RuleDTO[], kind: "sender" | "domain", match: string): RuleDTO[] {
  return rules.filter((r) => r.enabled
    && r.kind === kind
    && (r.subjectContains ?? "").trim() === ""
    && (r.bodyContains ?? "").trim() === ""
    && r.match.trim().toLowerCase() === match);
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

export function pressOverTwins(
  rules: readonly RuleDTO[], kind: "sender" | "domain", match: string, wanted: Folder, applyRetro: boolean,
): TwinPress {
  const twins = ruleTwins(rules, kind, match);
  if (twins.length === 0) {
    return { state: "created", writes: [{ kind: "rule_create", ruleKind: kind, match, destination: wanted, applyRetro }] };
  }
  const retargets: EngineMutation[] = twinsElsewhere(twins, kind, match, wanted)
    .map((r) => ({ kind: "rule_update", ruleId: r.id, destination: wanted, applyRetro }));
  // An explicit `applyRetro: true` on a PATCH that does not move the rule is the server's re-arm.
  const rearms: EngineMutation[] = applyRetro
    ? twins.filter((r) => r.destination === wanted)
      .map((r) => ({ kind: "rule_update", ruleId: r.id, destination: wanted, applyRetro: true }))
    : [];
  return {
    state: twinWinner(twins)!.destination === wanted ? "already" : "retargeted",
    writes: [...retargets, ...rearms],
  };
}
