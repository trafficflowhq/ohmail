import type { MutationEffect } from "./mutations.js";
import type { EntityReader } from "./store.js";
import type { EngineMessage, EngineMutation } from "./types.js";

/**
 * THE ROWS A VERB ACTS ON — the one verb → affected-entity registry the shadow reads. A confirmed
 * verb's effect on these types keeps masking the mirror's copy until that copy AGREES with it
 * ({@link placementOf}); a drain that succeeded is not proof, because the door it read can lag the
 * server that took the write. `[]`: the verb moves no list row, or owns its own confirm path.
 * Keyed by every kind, so a new verb does not compile without a decision here.
 */
export const SHADOWED_ROWS = {
  move: ["message"],
  message_delete: ["message"],
  triage_set: ["message", "message_state"],
  screener_decide: ["message", "screener_sender"],
  tag_assign: ["message"],
  feed_mark_seen: ["message"],
  mark_seen: ["message", "message_state"],
  draft_accept: ["draft"],
  draft_schedule_cancel: ["draft"],
  draft_save: ["draft"],
  draft_discard: ["draft"],
  draft_resolve: ["draft"],
  mail_send: [],
  tag_create: [],
  tag_rename: [],
  tag_recolor: [],
  tag_delete: [],
  folder_create: [],
  folder_rename: [],
  folder_delete: [],
  folder_op_dismiss: [],
  rule_delete: [],
  rule_update: [],
  rule_create: [],
} as const satisfies Record<EngineMutation["kind"], readonly string[]>;

/**
 * THE MESSAGES A VERB NAMES BY ID — the rows a History or Search list can act on whether or not
 * the mirror holds them. A verb whose every named row is in neither the mirror nor the page cache
 * (a deep link) is still sent: it has no local effect to show, and only the server may answer
 * that the row is gone. `null`: the verb names no message row, so empty effects stay a refusal.
 */
export const VERB_TARGETS = {
  move: (m) => [m.messageId],
  message_delete: (m) => [m.messageId],
  triage_set: (m) => [m.messageId],
  tag_assign: (m) => [m.messageId],
  mark_seen: (m) => (m.messageIds.length > 0 ? m.messageIds : null),
  screener_decide: () => null,
  feed_mark_seen: () => null,
  draft_accept: () => null,
  draft_schedule_cancel: () => null,
  draft_save: () => null,
  draft_discard: () => null,
  draft_resolve: () => null,
  mail_send: () => null,
  tag_create: () => null,
  tag_rename: () => null,
  tag_recolor: () => null,
  tag_delete: () => null,
  folder_create: () => null,
  folder_rename: () => null,
  folder_delete: () => null,
  folder_op_dismiss: () => null,
  rule_delete: () => null,
  rule_update: () => null,
  rule_create: () => null,
} as const satisfies { [K in EngineMutation["kind"]]: (m: Extract<EngineMutation, { kind: K }>) => readonly string[] | null };

/** {@link VERB_TARGETS} for one verb, by its own kind. */
export function verbTargetsOf(m: EngineMutation): readonly string[] | null {
  return (VERB_TARGETS[m.kind] as (x: EngineMutation) => readonly string[] | null)(m);
}

/**
 * How many successful drains after the confirm a DISAGREEING shadow survives. The overlay predicts
 * the server's answer; a no-op, a divergence or another device's later change never agrees, and
 * after this bound the mirror is the truth whatever it says. Counted in drains, never a clock.
 */
export const SHADOW_DRAIN_BOUND = 3;

/** One masked entity and the placement the verb asked for. */
export interface ShadowKey {
  type: string;
  id: string;
  want: string;
}

const instant = (iso: unknown): number | null => {
  const t = typeof iso === "string" ? Date.parse(iso) : NaN;
  return Number.isNaN(t) ? null : t;
};

/**
 * WHERE A LIST PUTS THIS ENTITY — the fields a verb changes and a view files by, nothing that a
 * server stamps on its own (`updatedAt`, `setAt`, `lastReadAt`). A tombstone and an absent record
 * are both `gone`. Instants compare by value: the wire and the overlay spell one moment differently.
 */
export function placementOf(type: string, e: unknown): string {
  if (e === null || e === undefined) return "gone";
  if (type === "message") {
    const m = e as EngineMessage;
    const st = (m.triage?.state as string | undefined) ?? "none";
    return JSON.stringify([m.folder, st, st === "bubbled_up" ? instant(m.triage?.bubbleUpAt) : null,
      m.unread === true, [...(m.labels ?? [])].sort()]);
  }
  if (type === "message_state") {
    const s = e as { state?: string; bubbleUpAt?: string | null };
    return JSON.stringify([s.state ?? "none", s.state === "bubbled_up" ? instant(s.bubbleUpAt) : null]);
  }
  if (type === "draft") return JSON.stringify([(e as { status?: string }).status ?? null]);
  if (type === "screener_sender") return JSON.stringify([(e as { segment?: string }).segment ?? null]);
  return "held";
}

/**
 * The keys of one confirmed verb: its effects on the registry's types over entities the mirror
 * HOLDS. A created entity has no stale copy to mask, and a client-minted id the server re-keys
 * would never agree — both retire with the reconcile as before.
 */
export function shadowKeysOf(
  m: Pick<EngineMutation, "kind">,
  effects: readonly MutationEffect[],
  held: (type: string, id: string) => boolean,
): ShadowKey[] {
  const types: readonly string[] = SHADOWED_ROWS[m.kind];
  const keys: ShadowKey[] = [];
  for (const e of effects) {
    if (!types.includes(e.type) || !held(e.type, e.id)) continue;
    keys.push({ type: e.type, id: e.id, want: placementOf(e.type, e.entity) });
  }
  return keys;
}

/** Does the mirror, read through its one-source projection, agree with every key? */
export function shadowAgrees(keys: readonly ShadowKey[], truth: EntityReader): boolean {
  return keys.every((k) => placementOf(k.type, truth.get(k.type, k.id)) === k.want);
}
