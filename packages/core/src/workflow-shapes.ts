// The workflow tool ALLOWLIST + step/trigger shapes, and the two storage-boundary validators the
// rules engine runs before a workflow is persisted. SECURITY INVARIANT: a step may declare
// exactly one of three typed, reversible tools — `file_message`, `draft_reply` (stored, never
// sent), `add_kb_entry`. There is deliberately NO `send` or `forward`: `validateSteps` rejects
// any tool outside `ALLOWED_TOOLS`, so a workflow can never be persisted with a step that would
// exfiltrate mail. A leaf, not under `ai/`: it names no model and carries no prompt — mail-half
// code the rules engine and storage gate use, re-exported by `@trafficflow/core/mail` — so
// `core/dist/ai/` stays, without exception, the private half.

/** The three — and only three — tools a workflow step may declare. */
export type ToolName = "file_message" | "draft_reply" | "add_kb_entry";

/** The allowlist, iterated by {@link validateSteps}. Never add `send`/`forward` here. */
export const ALLOWED_TOOLS: readonly ToolName[] = ["file_message", "draft_reply", "add_kb_entry"];

/**
 * How many steps one workflow may declare. `validateSteps` checked each step's tool and `args`
 * shape and never `steps.length`, so `POST /workflows` stored an array of any size and one run
 * made the SHARED worker execute all of it. 25: a workflow is a hand-authored automation over a
 * mail rule, and three tools do not compose into a long program — an order of magnitude above the
 * largest plausible hand-written one. Refused at WRITE time: a runner-enforced cap would leave an
 * oversized workflow stored and refused once per run; refused here, the request naming 10 000
 * steps is the one that learns the limit. The CEILING half only — the per-run budget and deadline
 * belong to the worker's scheduling.
 */
export const MAX_WORKFLOW_STEPS = 25;

/**
 * The UNDO payload stored with each executed step, replayed to reverse a run.
 *
 * One variant per allowed tool, and that correspondence is the point: an inverse exists for
 * every effect a workflow can have, because the tool grammar admits only reversible effects in
 * the first place. It is declared here, with the grammar, rather than beside the runner that
 * writes it — the service that REPLAYS an undo is mail-half code and needs to name this shape,
 * and having it live with the runner made that service declare a dependency on the module that
 * calls a model.
 */
export type WorkflowInverse =
  | { tool: "file_message"; messageId: string; toFolder: string }
  | { tool: "draft_reply"; draftId: string }
  | { tool: "add_kb_entry"; kbEntryId: string };

/**
 * A recurring, redaction-safe routing pattern: METADATA ONLY. The fields below are the COMPLETE
 * allowed surface, enforced at the boundary that serializes one — deliberately no body, snippet
 * or subject field, so raw content cannot reach a model request even by mistake; the assembling
 * caller additionally excludes any pattern whose underlying messages are flagged sensitive.
 * Declared here rather than beside the proposer because the shape is also what the transport
 * layer serializes to a client, and that path is mail-half code; the allowlist that polices the
 * shape stays with the proposer, where the serialization happens.
 */
export interface WorkflowPattern {
  /** The pattern axis: 'sender' (a specific address) or 'domain' (a whole domain). */
  kind: string;
  senderDomain?: string;
  senderAddress?: string;
  destination?: string;
  /** How many times this pattern recurred (learning signals / rule hits / decisions). */
  count: number;
  /** Where the pattern was observed: 'learning' | 'rule' | 'routing'. */
  provenance: string;
}

/** One step of a workflow: a typed tool + its opaque args (validated per-tool by the workflow runner). */
export interface WorkflowStep {
  tool: ToolName;
  args: Record<string, unknown>;
}

/** How a workflow fires. `manual` runs on `POST /run`; `time` carries `nextRunAt`; `event` matches ingested mail. */
export type TriggerKind = "manual" | "time" | "event";

export interface WorkflowTrigger {
  kind: TriggerKind;
  /** ISO timestamp the time-trigger scan compares against `now`. */
  nextRunAt?: string;
  /** Event-trigger predicate (sender/domain/…), matched by the event-trigger scan. */
  match?: Record<string, unknown>;
}

const TRIGGER_KINDS: readonly TriggerKind[] = ["manual", "time", "event"];

export type ValidationResult = { ok: true } | { ok: false; error: string };

/**
 * Validate a workflow's `steps`. Rejects a non-array, a malformed step, and
 * — the security-critical case — any step whose `tool` is not in {@link ALLOWED_TOOLS}
 * (so `{tool:'send'}` / `{tool:'forward'}` can never be stored). Returns a typed
 * result rather than throwing so the service can map it to a 400 with the message.
 */
export function validateSteps(steps: unknown): ValidationResult {
  if (!Array.isArray(steps)) return { ok: false, error: "steps must be an array" };
  // LENGTH, before the per-step loop — this validator checked every step's tool and shape and
  // never looked at how many there were. See {@link MAX_WORKFLOW_STEPS}.
  if (steps.length > MAX_WORKFLOW_STEPS) {
    return {
      ok: false,
      error: `steps names ${steps.length} steps; a workflow may declare at most ${MAX_WORKFLOW_STEPS}`,
    };
  }
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i] as { tool?: unknown; args?: unknown } | null;
    if (typeof step !== "object" || step === null) return { ok: false, error: `step ${i} must be an object` };
    if (typeof step.tool !== "string") return { ok: false, error: `step ${i} tool must be a string` };
    if (!ALLOWED_TOOLS.includes(step.tool as ToolName)) {
      return { ok: false, error: `step ${i} tool '${step.tool}' is not allowed (allowed: ${ALLOWED_TOOLS.join(", ")})` };
    }
    if (step.args !== undefined && (typeof step.args !== "object" || step.args === null || Array.isArray(step.args))) {
      return { ok: false, error: `step ${i} args must be an object` };
    }
  }
  return { ok: true };
}

/** Validate a workflow `trigger`: an object with a known `kind`. */
export function validateTrigger(trigger: unknown): ValidationResult {
  if (typeof trigger !== "object" || trigger === null || Array.isArray(trigger)) {
    return { ok: false, error: "trigger must be an object" };
  }
  const kind = (trigger as { kind?: unknown }).kind;
  if (typeof kind !== "string" || !TRIGGER_KINDS.includes(kind as TriggerKind)) {
    return { ok: false, error: `trigger kind must be one of ${TRIGGER_KINDS.join(", ")}` };
  }
  return { ok: true };
}
