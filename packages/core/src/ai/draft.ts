import type { AnthropicLike } from "./classify.js";
import type { DraftCallOptions, DraftInput, DraftPort, DraftResult } from "../draft-port.js";
import {
  DRAFT_RESULT_SCHEMA, coerceDraftResult, draftSystemPrompt, draftUserPayload,
} from "../draft-prompt.js";
import { declineOf } from "../model-declined.js";
import { thinkingOffFor } from "../model-rules.js";

/**
 * The drafter implementation — the model half of the seam in `../draft-port.ts`, mirroring the
 * classifier: the PORT lives outside this directory, the implementation takes an INJECTED client,
 * no model SDK at load time. The shared prompt builder in `../draft-prompt.ts` applies the
 * input allow-list and credential redaction before preparing the provider request.
 */

/* Re-exported so that consumers importing the drafting vocabulary from this module — or from the
 * package barrel, which re-exports this file — are unaffected by the port having moved out. */
export type {
  DraftIncoming, DraftContext, DraftInput, DraftOwnWords, DraftResult, DraftPort, DraftCallOptions,
} from "../draft-port.js";
/* The question, re-exported from the leaf that now owns it. */
export {
  DRAFT_OWN_PREFIX, DRAFT_PREFIX, DRAFT_RESULT_SCHEMA, NO_LETTER, assertRedacted, coerceDraftResult, draftSystemPrompt, draftUserPayload,
} from "../draft-prompt.js";
export type { DraftUserPayload } from "../draft-prompt.js";

export interface SonnetDrafterOpts {
  model?: string;                                        // default "claude-sonnet-5-5"
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
  stream?: boolean;
}

const DEFAULT_MODEL = "claude-sonnet-5-5";

/**
 * Build the exact `messages.create` params for one draft call: cached voice/policy
 * `system` prefix + volatile user turn (incoming + retrieved context) +
 * `output_config.format` json_schema. Exported so a test can assert the request
 * shape — and that NO content beyond the passed (redacted-safe) input is serialized.
 *
 * The prompt builder asserts the input allow-list and redacts credentials before serialization.
 */
export function buildDraftParams(input: DraftInput, opts: SonnetDrafterOpts = {}): Record<string, unknown> {
  // Asserts the redaction allow-list FIRST and throws — see `draftUserPayload`. Nothing below
  // runs on a violating input, so a raw body is never assembled into a request object at all.
  const userPayload = draftUserPayload(input);
  const model = opts.model ?? DEFAULT_MODEL;
  const params: Record<string, unknown> = {
    model,
    max_tokens: opts.maxTokens ?? 1024,
    /**
     * Thinking OFF — a billing decision before a quality one. Sonnet thinks by default, and
     * `max_tokens` caps thinking plus response TOGETHER: measured live on Sonnet 5, an ordinary
     * reply came back 259 thinking + 539 text of 1024, so a longer one silently loses its ending,
     * and every thinking token is margin the model decides. Raising `max_tokens` instead waits for
     * a re-pricing decision made WITH measurements. The value is the model's own row in
     * `MODEL_REQUEST_RULES`: `between_tools` on Sonnet 5.5, where `disabled` is a 400, and legal at
     * effort `high` or below — the default, which this file keeps. An override gets its own value.
     */
    thinking: thinkingOffFor(model),
    system: [
      { type: "text", text: draftSystemPrompt(input, opts.stream), cache_control: { type: "ephemeral" } },
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
 * The ordered schema puts the body first. Decode only its available JSON string prefix,
 * holding an incomplete escape or surrogate pair until the next chunk.
 */
function draftBodyPrefix(json: string): string | undefined {
  const match = /^\s*\{\s*"body"\s*:\s*("(?:[^"\\\x00-\x1f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*)/.exec(json);
  if (match === null) return undefined;
  return (JSON.parse(`${match[1]}"`) as string).replace(/[\uD800-\uDBFF]$/, "");
}

/**
 * The injected-client Sonnet drafter (mirrors `makeHaikuClassifier`). `client` is a
 * real `new Anthropic()` in prod, a canned-JSON fake in tests. No `@anthropic-ai/sdk`
 * import lives in this module — the SDK is a deployment concern.
 */
export function makeSonnetDrafter(client: AnthropicLike, opts: SonnetDrafterOpts = {}): DraftPort {
  // At construction, so a model with no thinking-off shape fails the boot and not a person's draft.
  thinkingOffFor(opts.model ?? DEFAULT_MODEL);
  return {
    async draft(input: DraftInput, call?: DraftCallOptions): Promise<DraftResult> {
      const params = buildDraftParams(input, opts);
      let json = "";
      let preview = "";
      const resp = await client.messages.create(params, !opts.stream || call?.onPreview === undefined ? call : {
        ...call,
        onText(delta) {
          json += delta;
          const body = draftBodyPrefix(json);
          if (body === undefined || body === preview) return;
          preview = body;
          call.onPreview?.(body);
        },
      });
      // A refusal or a cut-off draft is said as one, never read as a malformed reply.
      const declined = declineOf(resp.stop_reason, resp.stop_details);
      if (declined) throw declined;
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
