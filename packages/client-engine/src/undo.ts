import type { EntityReader } from "./store.js";
import type { EngineMessage, EngineMutation, MutationKind } from "./types.js";

/**
 * How a user verb is taken back — the one classification every surface reads. "inverse":
 * {@link inverseMutations} builds the wire's own reversal, dispatched through the ordinary
 * `engine.mutate`. "window": the press is a DELAYED COMMIT with a durable intent (the delete
 * key's `delete-undo.ts`, the Screener's `screener-state.ts`) because the wire has no inverse
 * once sent. "none": no undo is offered — a toast for these kinds carries no Undo action.
 * `Record<MutationKind, …>` on purpose: a new verb does not compile until it declares its class,
 * so a verb that silently moves mail with no way back is unrepresentable rather than censused.
 */
export type UndoClass = "inverse" | "window" | "none";

/**
 * A PLAN IS A SUBJECT TOO, and the routing verbs are why. Move, File and Junk are not one
 * mutation: they are a screening PLAN — a rule written or retargeted, sometimes a Screener
 * decision, and a capped pass over mail already filed — and the plan's undo class is not any
 * member's. Every `rule_*` stays `"none"` because no rule mutation has a wire inverse; the PLAN
 * is `"window"` because it is held before it is sent (`routing-window.ts`), which is a different
 * question about a different thing. One table so a surface asks once, and the table is what
 * decides whether a toast carries Undo — never a flag the call site passes.
 */
export type RoutingPlanKind = "routing_plan";

/** What {@link UNDO_CLASS} can be asked about: one mutation, or one plan. */
export type UndoSubject = MutationKind | RoutingPlanKind;

export const UNDO_CLASS: Record<UndoSubject, UndoClass> = {
  /** The routing plan — held for the undo window, then committed exactly as it always was. */
  routing_plan: "window",
  move: "inverse",
  triage_set: "inverse",
  mark_seen: "inverse",
  tag_assign: "inverse",
  /** Delayed-commit windows — the undo cancels a mutation that has not been sent. */
  message_delete: "window",
  screener_decide: "window",
  /** A glance is not a press — the dwell mark and the leave commit offer no undo. */
  feed_mark_seen: "none",
  /** Mail that left the building cannot be recalled; drafts have their own doors. */
  mail_send: "none",
  draft_save: "none",
  draft_discard: "none",
  draft_resolve: "none",
  draft_accept: "none",
  draft_schedule_cancel: "none",
  /** Admin verbs confirmed by their own surfaces; ids are server-minted on create. */
  tag_create: "none",
  tag_rename: "none",
  tag_recolor: "none",
  tag_delete: "none",
  folder_create: "none",
  folder_rename: "none",
  folder_delete: "none",
  folder_op_dismiss: "none",
  rule_create: "none",
  rule_update: "none",
  rule_delete: "none",
};

/** The prior triage put back, or `"none"` for a message that carried no pile state. */
function triageRestore(msg: EngineMessage): EngineMutation {
  const prior = msg.triage;
  if (!prior || prior.state === "none") {
    return { kind: "triage_set", messageId: msg.id, state: "none" };
  }
  if (prior.state === "bubbled_up") {
    return { kind: "triage_set", messageId: msg.id, state: "bubbled_up", bubbleUpAt: prior.bubbleUpAt ?? null };
  }
  /* `resurfaced` and the plain piles take no `bubbleUpAt` — the server forces it null. */
  return { kind: "triage_set", messageId: msg.id, state: prior.state };
}

/** Whether this deliberate press spends a resurfaced pin (`mutations.ts#spentResurface`). */
function spendsPin(msg: EngineMessage): boolean {
  return (msg.triage?.state as string | undefined) === "resurfaced";
}

/**
 * THE INVERSE OF A VERB, read off the mirror BEFORE the verb is dispatched. Returns the
 * mutation(s) that put the visible state back, in dispatch order; `[]` means the wire has no
 * inverse here and the caller MUST NOT offer Undo (the classes above say which kinds ever
 * answer). Undo = dispatch each returned mutation through the ordinary `engine.mutate` — the
 * optimistic overlay, the outbox and the refusal vocabulary all apply, never a local state hack.
 * A press that changes nothing answers `[]` too: an "Undo" over it would CHANGE state.
 */
export function inverseMutations(reader: EntityReader, m: EngineMutation): EngineMutation[] {
  switch (m.kind) {
    case "move": {
      const msg = reader.get<EngineMessage>("message", m.messageId);
      if (!msg || msg.folder === m.folder) return [];
      const out: EngineMutation[] = [{ kind: "move", messageId: msg.id, folder: msg.folder }];
      /* The move spends a resurfaced pin in the same transaction; the reversal re-pins AFTER
         the move back, so the row returns to the exact group it left. */
      if (spendsPin(msg)) out.push({ kind: "triage_set", messageId: msg.id, state: "resurfaced" });
      return out;
    }
    case "triage_set": {
      const msg = reader.get<EngineMessage>("message", m.messageId);
      if (!msg) return [];
      return [triageRestore(msg)];
    }
    case "mark_seen": {
      /* Only the ids this press actually flips — mail already in the target state stays put,
         and flipping it "back" would change state the press never touched. */
      const known = m.messageIds
        .map((id) => reader.get<EngineMessage>("message", id))
        .filter((x): x is EngineMessage => x != null);
      const flipped = known.filter((msg) => msg.unread !== m.unread).map((msg) => msg.id);
      const out: EngineMutation[] = [];
      if (flipped.length > 0) out.push({ kind: "mark_seen", messageIds: flipped, unread: !m.unread });
      /* A deliberate read spends resurfaced pins; the reversal re-pins each spent row. */
      if (!m.unread && m.via !== "glance") {
        for (const msg of known.filter(spendsPin)) {
          out.push({ kind: "triage_set", messageId: msg.id, state: "resurfaced" });
        }
      }
      return out;
    }
    case "tag_assign": {
      const msg = reader.get<EngineMessage>("message", m.messageId);
      if (!msg || msg.labels.includes(m.tagId) === m.assigned) return [];
      /* Undo of tag-or-create unassigns; the minted tag row stands — deleting it is a
         different act with its own verb and its own confirm. */
      return [{ kind: "tag_assign", messageId: msg.id, tagId: m.tagId, assigned: !m.assigned }];
    }
    default:
      return [];
  }
}
