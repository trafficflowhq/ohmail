import { ruleMatchKey } from "@trafficflow/core/rule-order";
import { domainOfAddress } from "./consent-cutline.js";
import type { MutationEffect } from "./mutations.js";
import { ruleTwins } from "./rule-twins.js";
import { placementOf } from "./shadow.js";
import type { EntityReader } from "./store.js";
import type { RuleDTO } from "./types.js";

/**
 * A DECISION THE WINDOW KEEPS — a confirmed `screener_decide`'s rules, held in memory past its
 * overlay until this copy holds them. A door whose drain lags the server that took the write (the
 * desktop's Cloud mirror mid-pull, a server that echoes nothing) otherwise settled the press over
 * a copy with no rule, and the sender's mail presented in the Ohbox. Never in the outbox: a
 * restart forgets it, and nothing replays.
 */
export interface KeptDecision {
  kind: "sender" | "domain";
  /** The subject as `ruleMatchKey` reads it: the address, or the domain. */
  key: string;
  /** The promoted rule's id — the server's when the confirm named it, else the overlay's own. */
  ruleId: string;
  /** Where the decision put the promoted rule ({@link placementOf}), whether or not it is still open. */
  ruleWant: string;
  /** The rules the decision retargeted, which a copy still lagging holds at their old place. */
  twinIds: ReadonlySet<string>;
  /** The queue's ask at the confirm; only the answer to a later ask can reopen the question. */
  ask: number;
  /** The rule effects the copy has not yet agreed with. */
  effects: MutationEffect[];
}

const ruleOf = (e: MutationEffect): RuleDTO | null =>
  e.type === "rule" && e.entity !== null ? (e.entity as RuleDTO) : null;

/** Does the copy hold this effect's rule where the effect put it? */
function copyAgrees(copy: EntityReader, e: MutationEffect): boolean {
  return placementOf("rule", copy.get("rule", e.id)) === placementOf("rule", e.entity);
}

/**
 * The decision a settling `screener_decide` leaves standing, or `null` when the copy already holds
 * every rule it wrote. The promoted rule is the first rule effect `derivedScreenerEffects` writes;
 * the rest are the twins it retargeted.
 */
export function keptDecisionOf(
  effects: readonly MutationEffect[], copy: EntityReader, ask: number,
): KeptDecision | null {
  const rules = effects.filter((e) => ruleOf(e) !== null);
  const promoted = rules[0];
  if (promoted === undefined) return null;
  const r = ruleOf(promoted)!;
  if (r.kind !== "sender" && r.kind !== "domain") return null;
  const open = rules.filter((e) => !copyAgrees(copy, e));
  if (open.length === 0) return null;
  return {
    kind: r.kind, key: ruleMatchKey(r.match), ruleId: promoted.id, ruleWant: placementOf("rule", r),
    twinIds: new Set(rules.filter((e) => e !== promoted).map((e) => e.id)), ask, effects: open,
  };
}

/**
 * Does a queue answer list the decision's subject again? Only an answer to an ask made after the
 * confirm counts: one asked before it may predate the decision. Listed again means the server
 * reopened the question, and the copy is the truth again.
 */
export function relistedBy(d: KeptDecision, ask: number, addresses: readonly string[]): boolean {
  if (ask <= d.ask) return false;
  return addresses.some((a) => {
    const k = ruleMatchKey(a);
    return d.kind === "sender" ? k === d.key : domainOfAddress(k) === d.key;
  });
}

/**
 * What is still kept after the copy moved: `null` retires the decision. It retires when the copy
 * holds the promoted rule in a state the decision did not write (a later word, or a delete). Each
 * effect goes once the copy agrees with it; the promoted one also goes once the copy holds any
 * bare rule of the subject that is not a twin, which covers a server whose confirm named no id.
 */
export function stillKept(
  d: KeptDecision, copy: EntityReader, record: (type: string, id: string) => boolean,
): KeptDecision | null {
  if (record("rule", d.ruleId) && placementOf("rule", copy.get("rule", d.ruleId)) !== d.ruleWant) return null;
  const subjectRuled = ruleTwins(copy.list<RuleDTO>("rule"), d.kind, d.key).some((r) => !d.twinIds.has(r.id));
  const open = d.effects.filter((e) => !copyAgrees(copy, e) && !(e.id === d.ruleId && subjectRuled));
  if (open.length === 0) return null;
  return open.length === d.effects.length ? d : { ...d, effects: open };
}

/** Does a newer verb's overlay speak about this decision's subject or one of its rules? */
export function supersededBy(d: KeptDecision, effects: readonly MutationEffect[]): boolean {
  return effects.some((e) => {
    if (e.type !== "rule") return false;
    if (e.id === d.ruleId || d.twinIds.has(e.id)) return true;
    const r = ruleOf(e);
    return r !== null && r.kind === d.kind && ruleMatchKey(r.match) === d.key
      && (r.subjectContains ?? "").trim() === "" && (r.bodyContains ?? "").trim() === "";
  });
}
