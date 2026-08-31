// ─────────────────────────────────────────────────────────────────────────────
// The workflow tool ALLOWLIST + step/trigger shapes, and the two storage-boundary
// validators the rules engine runs before a workflow is persisted.
//
// SECURITY INVARIANT: a workflow step may declare EXACTLY one of three typed,
// reversible tools — `file_message` (desired-state move), `draft_reply` (a STORED,
// never-sent draft), `add_kb_entry` (a KB write). There is deliberately NO `send`,
// `forward`, or any exfiltrating tool: `validateSteps` REJECTS any step whose
// `tool` is outside `ALLOWED_TOOLS`, so a workflow can NEVER be persisted with a
// step that would send or forward mail. This validator is the storage-boundary gate
// WorkflowsService.create/update run before any INSERT.
//
// ── WHY THIS IS A LEAF, AND NOT UNDER `ai/` ──────────────────────────────────
//
// This module names no model and carries no prompt: it is the step/trigger grammar
// plus the two validators. It is mail-half code — the rules engine and the storage
// gate use it — so the local mail engine legitimately carries it, and `@trafficflow/
// core/mail` re-exports it. It used to live under `ai/workflows/`, next to the
// proposer and the workflow runner that DO call a model; a bundle census that (correctly)
// treats everything under `ai/` as the private model half then could not tell this
// apart from a prompt. It is a leaf here so that `core/dist/ai/` is, without
// exception, the private half — and the one grammar the mail engine needs is not.
// ─────────────────────────────────────────────────────────────────────────────

/** The three — and only three — tools a workflow step may declare. */
export type ToolName = "file_message" | "draft_reply" | "add_kb_entry";

/** The allowlist, iterated by {@link validateSteps}. Never add `send`/`forward` here. */
export const ALLOWED_TOOLS: readonly ToolName[] = ["file_message", "draft_reply", "add_kb_entry"];

/**
 * HOW MANY STEPS ONE WORKFLOW MAY DECLARE.
 *
 * `validateSteps` checked each step's tool against {@link ALLOWED_TOOLS} and its `args` shape,
 * and never looked at `steps.length` — so `POST /workflows` would store an array of any size and
 * one `POST /workflows/:id/run` made the SHARED worker execute every element of it to
 * completion. The tool allowlist bounded what a step may DO; nothing bounded how many.
 *
 * 25. A workflow is a hand-authored automation over a mail rule — file it, draft a reply, write
 * a KB note — and three tools do not compose into a long program. The number is set an order of
 * magnitude above the largest plausible hand-written one so that no real workflow meets it, and
 * two orders below what would make one run's execution time interesting to a caller.
 *
 * **Refused at WRITE time, which is the earlier of the two places it could be.** A cap enforced
 * by the runner would leave an oversized workflow stored and refused once per run, discovered
 * from the worker's logs; refused here, the request that names 10 000 steps is the one that
 * learns the limit. This is the CEILING half only — the per-run step
 * budget and wall-clock deadline that row also asks for belong to the worker's own scheduling
 * and are not this constant.
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
 * A recurring, redaction-safe routing pattern: METADATA ONLY.
 *
 * The fields below are the COMPLETE allowed surface, and that completeness is enforced at the
 * boundary that serializes one — there is deliberately no body, snippet or subject field, so raw
 * content cannot be serialized into a model request even by mistake. The assembling caller
 * additionally excludes any pattern whose underlying messages are flagged sensitive.
 *
 * It is declared here rather than beside the proposer that reasons over it because the shape is
 * also what the transport layer serializes to a client, and that path is mail-half code. The
 * allowlist that polices the shape stays with the proposer, where the serialization happens.
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
