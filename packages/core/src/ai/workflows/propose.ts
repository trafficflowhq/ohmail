import type { ToolName, WorkflowPattern, WorkflowStep, WorkflowTrigger } from "@ohmail/wire";
import type { AnthropicLike } from "../classify.js";
import type { AiCallOptions } from "../../ai-call-report.js";
import {
  MAX_WORKFLOW_STEPS,
} from "../../workflow-shapes.js";
import { declineOf } from "../../model-declined.js";
import { DESTINATIONS } from "../../types.js";
import { requestRulesFor } from "../../model-rules.js";

/**
 * The AI WorkflowPort seam — mirrors the classifier and drafter: the PORT lives in core so the
 * worker cron and ProposalsService depend on it without a cycle; `makeOpusProposer` takes an
 * INJECTED client and never imports a model SDK at load. REDACTION: the input is non-sensitive
 * pattern METADATA only — sender/domain, destination, counts, provenance — never a body, snippet
 * or subject. `buildProposeParams` STRUCTURALLY asserts this: it rejects a pattern carrying any
 * key outside the allowed metadata set, so raw content cannot be serialized into a request even
 * by mistake; the caller also excludes patterns whose messages are sensitivity-flagged — the port
 * cannot see what the caller never assembles.
 */

/* The pattern SHAPE is declared with the workflow grammar, in `workflow-shapes.ts`: it is also
 * what the transport layer serializes to a client, which is mail-half code, and declaring it here
 * made that path name this module. The redaction allowlist below stays with the serialization it
 * polices. Re-exported so this module's consumers are unaffected by where the shape now lives. */

/** The COMPLETE set of keys a {@link WorkflowPattern} may carry (the redaction allowlist). */
const ALLOWED_PATTERN_KEYS: ReadonlySet<string> = new Set([
  "kind", "senderDomain", "senderAddress", "destination", "count", "provenance",
]);

/**
 * What the model answers for one proposal: a pattern by its position in the list it was given, a
 * name, a rationale, and the tools in order — nothing a step needs to run. The schema is closed
 * everywhere, but this is still the MODEL's word, so {@link deriveProposals} reads each answer as
 * `unknown` and drops anything else (a `trigger`, an `args`, a `messageId`) rather than store it.
 */
export interface ProposalAnswer {
  pattern: number;
  name: string;
  rationale: string;
  steps: Array<{ tool: string }>;
}

/**
 * A proposal as stored: INERT in `workflow_proposals` until the person materializes it. The server
 * DERIVES `trigger` and every step's `args` from `sourcePattern` through {@link PROPOSAL_TOOLS}; no
 * field here is the model's except `name` and `rationale`. No `messageId` anywhere: every tool
 * needs one per run, and nothing binds an arriving message to an `event` workflow yet.
 */
export interface WorkflowProposal {
  name: string;
  rationale: string;
  trigger: WorkflowTrigger;
  steps: WorkflowStep[];
  sourcePattern: WorkflowPattern;
}

export interface WorkflowPort {                          // injected into the proposal cron / service
  /** `call` is this one call's usage hook ({@link AiCallOptions}); a port may ignore it. */
  propose(patterns: WorkflowPattern[], call?: AiCallOptions): Promise<ProposalAnswer[]>;
}

export interface OpusProposerOpts {
  model?: string;                                        // default "claude-opus-5-5"
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
 * `claude-opus-4-8` was never a real model id — no such model has shipped. It sat as the default
 * for the whole build, invisibly: nothing calls the proposer with a live client yet, so the only
 * reader was a test asserting it equalled itself, and the first real propose call would have been
 * a flat API error. Pinned to the released Opus 5.5: proposal runs are rare, batched, and read a
 * whole pattern set at once, so the strongest model is the right trade — unlike classify, which
 * runs per message and is cost-dominant.
 */
const DEFAULT_MODEL = "claude-opus-5-5";

/**
 * THE ONE TABLE of what a proposal may do — the schema's tool enum, the prompt's tool list and the
 * server's derivation all read it. Each row derives a step's `args` from the pattern alone; `null`
 * means this pattern cannot carry the tool, and the proposal is dropped. `add_kb_entry` is absent
 * on purpose: its args are a title and content, and the model sees metadata only, so anything it
 * wrote would be invented and stored as the person's own words.
 */
export const PROPOSAL_TOOLS = {
  file_message: {
    says: "file the arriving message into the pattern's destination folder",
    args: (p: WorkflowPattern): Record<string, unknown> | null =>
      p.destination !== undefined && (DESTINATIONS as readonly string[]).includes(p.destination)
        ? { toFolder: p.destination } : null,
  },
  draft_reply: {
    says: "prepare a reply draft for the person to review; it is never sent",
    args: (): Record<string, unknown> | null => ({}),
  },
} as const satisfies Partial<Record<ToolName, {
  says: string; args: (p: WorkflowPattern) => Record<string, unknown> | null;
}>>;

type ProposalTool = keyof typeof PROPOSAL_TOOLS;
const PROPOSAL_TOOL_NAMES = Object.keys(PROPOSAL_TOOLS) as ProposalTool[];

/** At most this many proposals are stored per pass, one per pattern; the rest are dropped. */
export const MAX_PROPOSALS_PER_PASS = 10;

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
  "Each proposal names ONE pattern by its zero-based position in the `patterns` list, and gives",
  "a short name, a one-line rationale, and an ordered list of steps. Each one runs when mail from",
  "that pattern's sender or domain arrives. A step names one of these tools and nothing else:",
  ...PROPOSAL_TOOL_NAMES.map((t) => `  ${t}: ${PROPOSAL_TOOLS[t].says}.`),
  "There is NO send, forward, or any exfiltrating tool — never propose one.",
  "",
  "Rules:",
  "- Only propose automations grounded in the recurring patterns you were given.",
  "- At most one proposal per pattern.",
  "- A pattern whose provenance is \"rule\" is already filed by a rule the owner set; propose",
  "  for it only if the proposal does more than file it.",
  "- A proposal is INERT: it is stored for the owner to review and explicitly enable;",
  "  it is never created or run automatically.",
  "Respond ONLY with the structured JSON object.",
].join("\n");

/**
 * The json_schema the propose request carries. CLOSED EVERYWHERE, every property required: the API
 * refuses `additionalProperties: true` with a 400, which is how the first shape never ran once.
 * Nothing in it can name a message, a folder or a trigger — the server derives those.
 */
export const PROPOSE_RESULT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["proposals"],
  properties: {
    proposals: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["pattern", "name", "rationale", "steps"],
        properties: {
          pattern: { type: "integer" },
          name: { type: "string" },
          rationale: { type: "string" },
          steps: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["tool"],
              properties: { tool: { type: "string", enum: PROPOSAL_TOOL_NAMES } },
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
  const model = opts.model ?? DEFAULT_MODEL;
  const rules = requestRulesFor(model);
  const params: Record<string, unknown> = {
    model,
    /**
     * Thinking as LOW as the model allows — `draft.ts`'s decision. Opus is the most expensive model
     * this product calls; one proposal pass costs one credit whatever it spends, and the pass
     * sweeps every served account, so an unbounded per-call spend multiplied by them is the one cost with
     * no natural ceiling. Opus 5.5 cannot turn thinking off (`disabled` is a 400 at every effort):
     * its row has no thinking value, so the field is omitted and effort `low` is the lever, below
     * its `medium` default. Thinking shares `max_tokens` with the list, hence 8192 where Opus 5
     * had 2048. A model that can turn thinking off gets its own value from `MODEL_REQUEST_RULES`.
     */
    max_tokens: opts.maxTokens ?? 8192,
    ...(rules.thinkingOff ? { thinking: { ...rules.thinkingOff } } : {}),
    system: [
      { type: "text", text: PROPOSE_PREFIX, cache_control: { type: "ephemeral" } },
    ],
    messages: [
      { role: "user", content: JSON.stringify(userPayload) },
    ],
    output_config: {
      ...(rules.effort ? { effort: "low" } : {}),
      format: { type: "json_schema", schema: PROPOSE_RESULT_SCHEMA },
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

/**
 * The injected-client Opus proposer (mirrors `makeSonnetDrafter`). `client` is a real
 * `new Anthropic()` in prod, a canned-JSON fake in tests. No `@anthropic-ai/sdk`
 * import lives in this module — the SDK is a deployment concern. Returns an empty list
 * on a malformed response rather than throwing (proposals are advisory — a bad model
 * turn simply yields no suggestions, never a broken cron); a decline throws
 * `ModelDeclinedError`, so the pass keeps the open set and refunds.
 */
export function makeOpusProposer(client: AnthropicLike, opts: OpusProposerOpts = {}): WorkflowPort {
  // At construction, so a model with no row fails the boot and not the proposal cron.
  requestRulesFor(opts.model ?? DEFAULT_MODEL);
  return {
    async propose(patterns: WorkflowPattern[], call?: AiCallOptions): Promise<ProposalAnswer[]> {
      if (patterns.length === 0) return [];
      const params = buildProposeParams(patterns, opts);
      const resp = await (call ? client.messages.create(params, call) : client.messages.create(params));
      // THROWN, never `[]`: an empty list replaces the account's open proposals, and a refusal or
      // a list cut off at `max_tokens` says nothing about which of them still hold.
      const declined = declineOf(resp.stop_reason, resp.stop_details);
      if (declined) throw declined;
      let parsed: unknown;
      try {
        parsed = JSON.parse(extractJsonText(resp.content));
      } catch {
        return [];
      }
      const list = (parsed as { proposals?: unknown } | null)?.proposals;
      // Handed on unread: `deriveProposals` is the one validator, and it reads each as `unknown`.
      return Array.isArray(list) ? (list as ProposalAnswer[]) : [];
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
  async propose(): Promise<ProposalAnswer[]> {
    return [];
  },
};

/** Why an answer was not stored. Counted per pass and logged by class, never with content. */
export const PROPOSAL_DROP_CLASSES = [
  "malformed", "foreign_key", "pattern_out_of_range", "empty_steps", "too_many_steps",
  "tool_not_offered", "duplicate_pattern", "pattern_unbound", "destination_not_canonical",
  "rule_duplicate", "over_cap",
] as const;
export type ProposalDropClass = typeof PROPOSAL_DROP_CLASSES[number];

const ANSWER_KEYS: ReadonlySet<string> = new Set(["pattern", "name", "rationale", "steps"]);
const STEP_KEYS: ReadonlySet<string> = new Set(["tool"]);

const plainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const onlyKeys = (o: Record<string, unknown>, allowed: ReadonlySet<string>): boolean =>
  Object.keys(o).every((k) => allowed.has(k));

/** The event trigger a pattern implies: its own sender, else its own domain, else none. */
function triggerFor(p: WorkflowPattern): WorkflowTrigger | null {
  if (p.kind === "sender" && p.senderAddress) return { kind: "event", match: { senderAddress: p.senderAddress } };
  if (p.kind === "domain" && p.senderDomain) return { kind: "event", match: { senderDomain: p.senderDomain } };
  return null;
}

/** One answer, admitted as a stored proposal or refused with its class. Never throws. */
function deriveOne(
  raw: unknown, patterns: WorkflowPattern[], taken: ReadonlySet<number>,
): WorkflowProposal | ProposalDropClass {
  if (!plainObject(raw)) return "malformed";
  if (!onlyKeys(raw, ANSWER_KEYS)) return "foreign_key";
  const { pattern: index, name, rationale, steps } = raw;
  if (typeof name !== "string" || name.trim().length === 0 || typeof rationale !== "string"
    || !Array.isArray(steps)) return "malformed";
  if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= patterns.length) {
    return "pattern_out_of_range";
  }
  if (steps.length === 0) return "empty_steps";
  if (steps.length > MAX_WORKFLOW_STEPS) return "too_many_steps";
  const tools: ProposalTool[] = [];
  for (const step of steps) {
    if (!plainObject(step)) return "malformed";
    if (!onlyKeys(step, STEP_KEYS)) return "foreign_key";
    if (typeof step.tool !== "string" || !Object.hasOwn(PROPOSAL_TOOLS, step.tool)) return "tool_not_offered";
    tools.push(step.tool as ProposalTool);
  }
  if (taken.has(index)) return "duplicate_pattern";
  const source = patterns[index]!;
  const trigger = triggerFor(source);
  if (!trigger) return "pattern_unbound";
  const derived: WorkflowStep[] = [];
  for (const tool of tools) {
    const args = PROPOSAL_TOOLS[tool].args(source);
    if (!args) return "destination_not_canonical";
    derived.push({ tool, args });
  }
  // The rule already files this sender there; a proposal that only repeats it adds nothing.
  if (source.provenance === "rule" && tools.length === 1 && tools[0] === "file_message") return "rule_duplicate";
  return { name, rationale, trigger, steps: derived, sourcePattern: source };
}

/**
 * THE DERIVATION, which is also the validation: everything a stored proposal carries beyond its
 * name and rationale comes from the pattern the answer names, through {@link PROPOSAL_TOOLS}. An
 * answer that is not exactly the schema's shape, names a pattern out of range or twice, offers no
 * step, or names a tool the table lacks is DROPPED and counted — never thrown, so one bad answer
 * neither refunds the pass nor costs the person the proposals that were good.
 */
export function deriveProposals(
  answers: readonly unknown[], patterns: WorkflowPattern[],
): { proposals: WorkflowProposal[]; dropped: Partial<Record<ProposalDropClass, number>> } {
  const proposals: WorkflowProposal[] = [];
  const dropped: Partial<Record<ProposalDropClass, number>> = {};
  const taken = new Set<number>();
  for (const raw of answers) {
    let out = deriveOne(raw, patterns, taken);
    if (typeof out !== "string" && proposals.length >= MAX_PROPOSALS_PER_PASS) out = "over_cap";
    if (typeof out === "string") { dropped[out] = (dropped[out] ?? 0) + 1; continue; }
    taken.add((raw as ProposalAnswer).pattern);
    proposals.push(out);
  }
  return { proposals, dropped };
}
