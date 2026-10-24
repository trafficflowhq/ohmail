"use client";

/**
 * HOW MUCH OF A RULE'S MAIL A CHANGE RE-FILES — counted over the mirror, before and after a Change
 * on Settings → Rules. A Change moves the rule's own pile and nothing else: a message counts when
 * the router would name THIS rule for it (`sender-audit.ts#routedRule`, so a higher rule's mail is
 * not claimed) and it sits in the place the rule filed into (`pileOf`) where the server's refile
 * walk could move it (`refileWouldMove`), in a mailbox a walk reaches (`walkedMailboxes`).
 * `destination` null counts the pile wherever it could go;
 * a folder counts the ones not already there. `null` is "cannot count here": a header rule and a
 * body term are matched when mail is filed, never against the mirror.
 */
import {
  FOLDER_OF_VIEW, canonicalDestination, refileWouldMove, retroWalkWouldMove, walkOwed, type EngineMessage,
  type EngineMutation, type Folder, type RuleDTO,
} from "@ohmail/client-engine";
import { holderIsLive } from "@trafficflow/core/reader-refusal";
import { routedRule } from "./sender-audit";
import type { RosterState } from "./mail-state";

const PLACES: readonly Folder[] = Object.values(FOLDER_OF_VIEW);

/**
 * A Change's wire: a re-filing of the rule's pile (true), the rule alone (false), or the rule's whole
 * backlog asked again ("walk", an Undo putting back a walk that was owed). Never the server's default.
 */
export function ruleRetarget(ruleId: string, destination: Folder, refile: boolean | "walk"): EngineMutation {
  return refile === "walk" ? { kind: "rule_update", ruleId, destination, applyRetro: true }
    : refile ? { kind: "rule_update", ruleId, destination, applyRetro: false, refile: true }
      : { kind: "rule_update", ruleId, destination, applyRetro: false };
}

/** Where a Change takes the rule's mail from: a re-filing still waiting keeps its origin. */
export function pileOf(rule: RuleDTO): Folder {
  return rule.retro?.from ?? (canonicalDestination(rule.destination) as Folder);
}

/**
 * The mailboxes a Change's walk reaches: the ones this install organizes, and the ones a live install
 * holds that takes the request (`planAccountFanOut`). A mailbox only read here moves nothing. `null`
 * where no roster is known (the desktop, the demo, before the first poll): every mailbox counts.
 */
export function walkedMailboxes(roster: RosterState): ReadonlySet<string> | null {
  if (roster.kind !== "known") return null;
  const ids = new Set<string>();
  for (const m of roster.rows) {
    if (!m.id || m.status === "disabled") continue;
    const travels = m.organizerAcceptsRequests === true && holderIsLive({ by: m.organizedBy, state: m.organizerState });
    if (m.organizerRole !== "reader" || travels) ids.add(m.id);
  }
  return ids;
}

export function rulePastMail(
  rule: RuleDTO,
  rules: readonly RuleDTO[],
  messages: readonly EngineMessage[],
  destination: Folder | null,
  walked: ReadonlySet<string> | null = null,
): number | null {
  if (rule.kind === "header" || (rule.bodyContains ?? "").replace(/^[ \t\n\r\f\v]+|[ \t\n\r\f\v]+$/g, "") !== "") return null;
  // The rules as they stand AFTER the change: the destination is part of how the router ranks.
  const after = destination === null ? rules : rules.map((r) => (r.id === rule.id ? { ...r, destination } : r));
  const enabled = after.filter((r) => r.enabled);
  const from = pileOf(rule);
  // A walk still owed goes to the new place whole (`RulesService.update`): count the walk.
  const would = walkOwed(rule) ? retroWalkWouldMove : (m: EngineMessage, p: Folder) => refileWouldMove(m, from, p);
  let n = 0;
  for (const m of messages) {
    if (walked !== null && !walked.has(m.mailboxId)) continue;
    if (routedRule(enabled, m)?.id !== rule.id) continue;
    const movable = destination === null ? PLACES.some((p) => would(m, p)) : would(m, destination);
    if (movable) n += 1;
  }
  return n;
}
