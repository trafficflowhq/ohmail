import type { AnthropicLike } from "./classify.js";
import type { DraftInput, DraftPort, DraftResult } from "../draft-port.js";
import {
  DRAFT_PREFIX, DRAFT_RESULT_SCHEMA, coerceDraftResult, draftUserPayload,
} from "../draft-prompt.js";

/**
 * The drafter implementation — the model half of the seam in `../draft-port.ts`, mirroring the
 * classifier: the PORT lives outside this directory, the implementation takes an INJECTED client,
 * no model SDK at load time. The sensitivity guarantee is stated at the port, being a property of
 * the input SHAPE: the caller refuses to draft against AI-excluded messages and excludes them
 * from context, so no field here can carry a raw body. The voice, policy, schema and redaction
 * allow-list live in `../draft-prompt.ts` — a second copy of the reply policy is how two
 * deployments write in two voices from one mailbox; the redaction sink is shared rather than
 * reimplemented. Old names re-exported.
 */

/* Re-exported so that consumers importing the drafting vocabulary from this module — or from the
 * package barrel, which re-exports this file — are unaffected by the port having moved out. */
export type {
  DraftIncoming, DraftContext, DraftInput, DraftResult, DraftPort,
} from "../draft-port.js";
/* The question, re-exported from the leaf that now owns it. */
export {
  DRAFT_PREFIX, DRAFT_RESULT_SCHEMA, assertRedacted, coerceDraftResult, draftUserPayload,
} from "../draft-prompt.js";
export type { DraftUserPayload } from "../draft-prompt.js";

export interface SonnetDrafterOpts {
  model?: string;                                        // default "claude-sonnet-5"
  /**
   * EU inference residency (spec §8). Plumbed and unset: the plan we are on does
   * not offer it yet. COMMERCIAL TRACK (decision 30, non-blocking) — set this to
   * the EU value the day the plan allows, and ask Anthropic about a zero-data-
   * retention agreement at the same time. Until both land, the published copy
   * says exactly what is true: requests go to Anthropic in the USA under
   * commercial API terms, never used for training, retained briefly.
   */
  inferenceGeo?: string;
  maxTokens?: number;
}

const DEFAULT_MODEL = "claude-sonnet-5";

/**
 * Build the exact `messages.create` params for one draft call: cached voice/policy
 * `system` prefix + volatile user turn (incoming + retrieved context) +
 * `output_config.format` json_schema. Exported so a test can assert the request
 * shape — and that NO content beyond the passed (redacted-safe) input is serialized.
 *
 * Calls {@link assertRedacted} first, so the request can never carry a leaked body — a raw field
 * on the input is a thrown error here, not a silent inclusion.
 */
export function buildDraftParams(input: DraftInput, opts: SonnetDrafterOpts = {}): Record<string, unknown> {
  // Asserts the redaction allow-list FIRST and throws — see `draftUserPayload`. Nothing below
  // runs on a violating input, so a raw body is never assembled into a request object at all.
  const userPayload = draftUserPayload(input);
  const params: Record<string, unknown> = {
    model: opts.model ?? DEFAULT_MODEL,
    max_tokens: opts.maxTokens ?? 1024,
    /**
     * Thinking OFF — a billing decision before a quality one. `claude-sonnet-5` runs adaptive
     * thinking by default, and `max_tokens` caps thinking plus response TOGETHER. Measured live:
     * an ordinary business reply came back 259 thinking + 539 text of 1024, so a longer reply
     * silently loses its ending — a truncated draft the customer paid for. And every thinking
     * token is margin whose count is the model's decision — unpriceable until `onUsage` produces
     * real numbers. Deterministic first, tuned second: keeping thinking and raising `max_tokens`
     * is deferred to a re-pricing decision made WITH measurements. Accepted on Sonnet 5 at any
     * effort.
     */
    thinking: { type: "disabled" },
    system: [
      { type: "text", text: DRAFT_PREFIX, cache_control: { type: "ephemeral" } },
    ],
    messages: [
      { role: "user", content: JSON.stringify(userPayload) },
    ],
    output_config: {
      format: { type: "json_schema", schema: DRAFT_RESULT_SCHEMA },
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
  throw new Error("drafter: response carried no text content block");
}

/**
 * The injected-client Sonnet drafter (mirrors `makeHaikuClassifier`). `client` is a
 * real `new Anthropic()` in prod, a canned-JSON fake in tests. No `@anthropic-ai/sdk`
 * import lives in this module — the SDK is a deployment concern.
 */
export function makeSonnetDrafter(client: AnthropicLike, opts: SonnetDrafterOpts = {}): DraftPort {
  return {
    async draft(input: DraftInput): Promise<DraftResult> {
      const params = buildDraftParams(input, opts);
      const resp = await client.messages.create(params);
      const text = extractJsonText(resp.content);
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error("drafter: response was not valid JSON");
      }
      return coerceDraftResult(parsed);
    },
  };
}
