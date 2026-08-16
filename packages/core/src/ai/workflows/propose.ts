import type { AnthropicLike } from "../classify.js";
import {
  ALLOWED_TOOLS, type ToolName, type WorkflowStep, type WorkflowTrigger,
} from "../../workflow-shapes.js";

/**
 * The AI WorkflowPort seam — mirrors the Haiku
 * classifier and Sonnet drafter EXACTLY. The PORT lives in core so the worker cron
 * and ProposalsService can depend on it without a cycle; the Opus implementation
 * takes an INJECTED client (`AnthropicLike`) so the default suite mocks it and makes
 * no network call. `makeOpusProposer` NEVER imports `@anthropic-ai/sdk` at module
 * load — the concrete `new Anthropic()` client is constructed by the app/worker and
 * injected, which keeps the proposer hermetic and the test suite offline.
 *
 * REDACTION: the port's input is NON-SENSITIVE pattern METADATA ONLY —
 * sender/domain, destination, counts, provenance drawn from `learning_signals`/
 * `routing_decisions`/`rules` (already redaction-aware). It NEVER carries a body,
 * snippet, subject, or any raw message content. `buildProposeParams` STRUCTURALLY
 * asserts this: it rejects a pattern that carries any key outside the allowed
 * metadata set, so raw content can never be serialized into a model request even by
 * mistake. The caller (ProposalsService.assemblePatterns) also excludes any pattern
 * whose underlying messages are sensitivity-flagged — the port cannot see what the
 * caller never assembles.
 */

/* The pattern SHAPE is declared with the workflow grammar, in `workflow-shapes.ts`: it is also
 * what the transport layer serializes to a client, which is mail-half code, and declaring it here
 * made that path name this module. The redaction allowlist below stays with the serialization it
 * polices. Re-exported so this module's consumers are unaffected by where the shape now lives. */
export type { WorkflowPattern } from "../../workflow-shapes.js";
import type { WorkflowPattern } from "../../workflow-shapes.js";

/** The COMPLETE set of keys a {@link WorkflowPattern} may carry (the redaction allowlist). */
const ALLOWED_PATTERN_KEYS: ReadonlySet<string> = new Set([
  "kind", "senderDomain", "senderAddress", "destination", "count", "provenance",
]);

/**
 * A proposed automation the model returns. INERT: it is stored in `workflow_proposals`
 * and only becomes a (disabled, provenance='proposed') workflow when the user
 * explicitly `POST /workflows { fromProposalId }`. `steps` may only declare the three
 * allowlisted tools — the caller runs `validateSteps` and DROPS any proposal that
 * declares a tool outside file_message/draft_reply/add_kb_entry.
 */
export interface WorkflowProposal {
  name: string;
  rationale: string;
  trigger: WorkflowTrigger;
  steps: WorkflowStep[];
}

export interface WorkflowPort {                          // injected into the proposal cron / service
  propose(patterns: WorkflowPattern[]): Promise<WorkflowProposal[]>;
}

export interface OpusProposerOpts {
  model?: string;                                        // default "claude-opus-5"
  /**
   * EU inference residency. Plumbed and unset: the API plan in use does not
   * offer it yet — set this to
   * the EU value the day the plan allows, and ask Anthropic about a zero-data-
   * retention agreement at the same time. Until both land, the published copy
   * says exactly what is true: requests go to Anthropic in the USA under
   * commercial API terms, never used for training, retained briefly.
   */
  inferenceGeo?: string;
  maxTokens?: number;
}

/**
 * `claude-opus-4-8` was never a real model id — no such model has shipped. It sat here as
 * the default for the whole build, invisibly: nothing calls the proposer with a live client
 * yet (no model is connected in production), so the only thing that ever read this string
 * was a test asserting it equalled itself. The first real propose call would have been a
 * flat API error on a name that does not exist.
 *
 * Pinned to the released Opus 5. Proposal runs are rare, batched and read a whole pattern
 * set at once, so the strongest model is the right trade here — unlike classify, which runs
 * per message and is cost-dominant.
 */
const DEFAULT_MODEL = "claude-opus-5";

/**
 * The FIXED task/policy prefix. Stable across every propose call so it can be cached
 * (a `system` block with `cache_control:{type:"ephemeral"}`); the volatile per-run
 * pattern list goes in the user turn, after the cache breakpoint.
 */
const PROPOSE_PREFIX = [
  "You are the automation proposer for ohmail. You are given a list of the",
  "owner's RECURRING mail-handling patterns as NON-SENSITIVE METADATA ONLY — a sender",
  "address or domain, the destination folder it was repeatedly routed to, how many",
  "times the pattern recurred, and where it was observed. You NEVER see message bodies,",
  "subjects, or snippets.",
  "",
  "Propose a small number of useful, SAFE automations the owner may CHOOSE to enable.",
  "Each proposal is a workflow: a name, a one-line rationale, a trigger, and an ordered",
  "list of steps. A step may ONLY use one of these three typed, reversible tools:",
  `  ${ALLOWED_TOOLS.join(", ")}.`,
  "There is NO send, forward, or any exfiltrating tool — never propose one.",
  "",
  "Rules:",
  "- Only propose automations grounded in the recurring patterns you were given.",
  "- Prefer a `time` trigger (with an ISO `nextRunAt`) or a `manual` trigger.",
  "- A proposal is INERT: it is stored for the owner to review and explicitly enable;",
  "  it is never created or run automatically.",
  "Respond ONLY with the structured JSON object.",
].join("\n");

// json_schema structured output. The top-level must be an object, so proposals are
// nested under a `proposals` array (mirrors the classifier/drafter RESULT_SCHEMA).
const RESULT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["proposals"],
  properties: {
    proposals: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "rationale", "trigger", "steps"],
        properties: {
          name: { type: "string" },
          rationale: { type: "string" },
          trigger: {
            type: "object",
            additionalProperties: true,
            required: ["kind"],
            properties: { kind: { type: "string", enum: ["manual", "time", "event"] } },
          },
          steps: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["tool", "args"],
              properties: {
                tool: { type: "string", enum: ALLOWED_TOOLS as unknown as string[] },
                args: { type: "object", additionalProperties: true },
              },
            },
          },
        },
      },
    },
  },
} as const;

/**
 * The redaction gate. Throws if any pattern carries a key outside
 * {@link ALLOWED_PATTERN_KEYS} — i.e. if a body/snippet/subject ever leaked into the
 * assembled metadata. This runs BEFORE anything is serialized into the model request,
 * so a raw-content leak is a hard failure, never a silent transmission.
 */
function assertRedacted(patterns: WorkflowPattern[]): void {
  for (const p of patterns) {
    for (const key of Object.keys(p)) {
      if (!ALLOWED_PATTERN_KEYS.has(key)) {
        throw new Error(`proposer: pattern carries a non-metadata field '${key}' (redaction violation)`);
      }
    }
  }
}

/**
 * Build the exact `messages.create` params for one propose call: cached task/policy
 * `system` prefix + volatile user turn (the redacted pattern list) +
 * `output_config.format` json_schema. Exported so a test can assert the request shape
 * — model, cached prefix, and that NO raw content is present. Calls
 * {@link assertRedacted} first so the request can never carry a leaked body/snippet.
 */
export function buildProposeParams(patterns: WorkflowPattern[], opts: OpusProposerOpts = {}): Record<string, unknown> {
  assertRedacted(patterns);
  const userPayload = { patterns };
  const params: Record<string, unknown> = {
    model: opts.model ?? DEFAULT_MODEL,
    max_tokens: opts.maxTokens ?? 2048,
    /**
     * THINKING OFF — the same decision `draft.ts` makes, and for the same two reasons, except
     * that both are sharper here.
     *
     * `claude-opus-5` also runs adaptive thinking by default, and it is the most expensive
     * model this product calls ($5 / $25 per MTok). One proposal pass costs ONE credit whatever
     * it spends, and the pass is driven by a CRON rather than by a person — so an unbounded
     * per-call token spend multiplied by every account, every bucket, is the one cost in this
     * system with no natural ceiling. `max_tokens: 2048` is also the tightest budget of the
     * three ports, so it is the most likely to be eaten by thinking and truncate a proposal
     * list mid-array.
     *
     * `disabled` is accepted on Opus 5 only at effort `high` or below; `high` is the default
     * and this file sets no effort, so it is legal. If an `effort` of `xhigh`/`max` is ever
     * added here, this line has to go with it — the API answers 400 for the pair.
     */
    thinking: { type: "disabled" },
    system: [
      { type: "text", text: PROPOSE_PREFIX, cache_control: { type: "ephemeral" } },
    ],
    messages: [
      { role: "user", content: JSON.stringify(userPayload) },
    ],
    output_config: {
      format: { type: "json_schema", schema: RESULT_SCHEMA },
    },
  };
  if (opts.inferenceGeo) params.inference_geo = opts.inferenceGeo;
  return params;
}

/** Extract the JSON text a structured-output response carries in its content blocks. */
function extractJsonText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block && typeof block === "object" && (block as { type?: string }).type === "text") {
        const t = (block as { text?: unknown }).text;
        if (typeof t === "string") return t;
      }
    }
  }
  throw new Error("proposer: response carried no text content block");
}

/** Coerce one raw proposal object into a well-formed {@link WorkflowProposal}. */
function coerceProposal(raw: unknown): WorkflowProposal {
  const o = (raw ?? {}) as Record<string, unknown>;
  const name = typeof o.name === "string" ? o.name : "";
  const rationale = typeof o.rationale === "string" ? o.rationale : "";
  const trigger = coerceTrigger(o.trigger);
  const steps = Array.isArray(o.steps) ? o.steps.map(coerceStep) : [];
  return { name, rationale, trigger, steps };
}

function coerceTrigger(raw: unknown): WorkflowTrigger {
  const o = (raw ?? {}) as Record<string, unknown>;
  const kind = o.kind === "time" || o.kind === "event" ? o.kind : "manual";
  const trigger: WorkflowTrigger = { kind };
  if (typeof o.nextRunAt === "string") trigger.nextRunAt = o.nextRunAt;
  if (o.match && typeof o.match === "object" && !Array.isArray(o.match)) {
    trigger.match = o.match as Record<string, unknown>;
  }
  if (typeof o.intervalMs === "number") (trigger as unknown as Record<string, unknown>).intervalMs = o.intervalMs;
  return trigger;
}

/** Coerce one raw step; the caller's `validateSteps` is the authoritative allowlist gate. */
function coerceStep(raw: unknown): WorkflowStep {
  const o = (raw ?? {}) as Record<string, unknown>;
  const tool = (typeof o.tool === "string" ? o.tool : "") as ToolName;
  const args = o.args && typeof o.args === "object" && !Array.isArray(o.args)
    ? (o.args as Record<string, unknown>) : {};
  return { tool, args };
}

/**
 * The injected-client Opus proposer (mirrors `makeSonnetDrafter`). `client` is a real
 * `new Anthropic()` in prod, a canned-JSON fake in tests. No `@anthropic-ai/sdk`
 * import lives in this module — the SDK is a deployment concern. Returns an empty list
 * on a malformed response rather than throwing (proposals are advisory — a bad model
 * turn simply yields no suggestions, never a broken cron).
 */
export function makeOpusProposer(client: AnthropicLike, opts: OpusProposerOpts = {}): WorkflowPort {
  return {
    async propose(patterns: WorkflowPattern[]): Promise<WorkflowProposal[]> {
      if (patterns.length === 0) return [];
      const params = buildProposeParams(patterns, opts);
      const resp = await client.messages.create(params);
      let parsed: unknown;
      try {
        parsed = JSON.parse(extractJsonText(resp.content));
      } catch {
        return [];
      }
      const list = (parsed as { proposals?: unknown }).proposals;
      if (!Array.isArray(list)) return [];
      return list.map(coerceProposal);
    },
  };
}

/**
 * The no-op WorkflowPort for when no live model is configured (the 4b default, like
 * `unconfiguredDrafter`). It proposes nothing, so the proposal cron runs cleanly and
 * simply produces no suggestions until a real `makeOpusProposer(new Anthropic())` is
 * wired by deployment.
 */
export const unconfiguredProposer: WorkflowPort = {
  async propose(): Promise<WorkflowProposal[]> {
    return [];
  },
};
