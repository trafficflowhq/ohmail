"use client";

/**
 * HOW MUCH OF A RULE'S MAIL A CHANGE ASKS THE PASS TO MOVE — counted over the mirror, before and
 * after a Change on Settings → Rules. A message counts when the router would name THIS rule for it
 * (`sender-audit.ts#routedRule`, so a higher rule's mail is not claimed) and the server pass could
 * move it (`retroPassWouldMove`). `destination` null counts every such message wherever it sits;
 * a folder counts the ones not already there. `null` is "cannot count here": a header rule and a
 * body term are matched when mail is filed, never against the mirror.
 */
import {
  FOLDER_OF_VIEW, retroPassWouldMove, type EngineMessage, type EngineMutation, type Folder, type RuleDTO,
} from "@ohmail/client-engine";
import { routedRule } from "./sender-audit";

const PLACES: readonly Folder[] = Object.values(FOLDER_OF_VIEW);

/** A Change's wire. The answer always rides: absent, the server re-arms the past mail itself. */
export function ruleRetarget(ruleId: string, destination: Folder, applyRetro: boolean): EngineMutation {
  return { kind: "rule_update", ruleId, destination, applyRetro };
}

export function rulePastMail(
  rule: RuleDTO,
  rules: readonly RuleDTO[],
  messages: readonly EngineMessage[],
  destination: Folder | null,
): number | null {
  if (rule.kind === "header" || (rule.bodyContains ?? "").replace(/^[ \t\n\r\f\v]+|[ \t\n\r\f\v]+$/g, "") !== "") return null;
  // The rules as they stand AFTER the change: the destination is part of how the router ranks.
  const after = destination === null ? rules : rules.map((r) => (r.id === rule.id ? { ...r, destination } : r));
  const enabled = after.filter((r) => r.enabled);
  let n = 0;
  for (const m of messages) {
    if (routedRule(enabled, m)?.id !== rule.id) continue;
    const movable = destination === null
      ? PLACES.some((p) => retroPassWouldMove(m, p))
      : retroPassWouldMove(m, destination);
    if (movable) n += 1;
  }
  return n;
}
