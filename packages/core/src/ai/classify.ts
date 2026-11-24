import type { ClassifierInput, ClassifierResult, ClassifierPort } from "../classifier-port.js";
import type { AiCallOptions } from "../ai-call-report.js";
import {
  CLASSIFY_RESULT_SCHEMA, SCREENING_PREFIX, SCREENING_RESULT_SCHEMA, TAXONOMY_PREFIX,
  classifyUserPayload, coerceClassifierResult, coerceScreeningResult,
} from "../classify-prompt.js";
import { declineOf } from "../model-declined.js";
import { thinkingOffFor } from "../model-rules.js";

/**
 * The AI classifier seam. The PORT lives in core so the pipeline can depend on it without a
 * cycle; the Haiku implementation takes an INJECTED client, so the suite makes no network call
 * and the worker depends on core only. This file has a sensitivity flag of its own: the only
 * thing between a credential and `messages.create` used to be one boolean computed one module
 * away, so `classifyUserPayload` re-reads the payload with the same local detector and THROWS
 * rather than sending — the outbound client is structurally unreachable for recognised content.
 * The taxonomy, schema and sensitivity sink live in `../classify-prompt.ts`; left here: the model
 * id, the request shape, the client seam.
 */

/**
 * The port lives in `classifier-port.ts` and is re-exported here so this file stays the one
 * import site for everything about classification. `pipeline.ts` and `ports.ts` take it from
 * the port module directly — a type-only edge is still a module-graph edge, and theirs would
 * otherwise carry the taxonomy prompt into every consumer of the pipeline.
 */
export type { ClassifierInput, ClassifierResult, ClassifierPort } from "../classifier-port.js";
/* The question, re-exported from the leaf that now owns it. */
export {
  CLASSIFY_DESTINATIONS, CLASSIFY_RESULT_SCHEMA, SCREEN_DESTINATIONS, SCREENING_PREFIX,
  SCREENING_RESULT_SCHEMA, TAXONOMY_PREFIX,
  classifyUserPayload, coerceClassifierResult, coerceScreeningResult,
} from "../classify-prompt.js";
export type { ClassifyUserPayload } from "../classify-prompt.js";

/**
 * A narrow structural seam over `@anthropic-ai/sdk`'s `messages.create` so tests
 * inject a deterministic fake with no network. The real client (`new Anthropic()`)
 * satisfies this shape.
 */
export interface AnthropicLike {
  /** `opts.signal` ends the call, retries and the wait before one included (see `makeAnthropicClient`);
   *  `opts.onUsage` is that one call's usage hook ({@link AiCallOptions}). `stop_reason` and
   *  `stop_details` are the answer's own, read by {@link declineOf} before any content is. */
  messages: {
    create(params: unknown, opts?: { signal?: AbortSignal; onText?: (delta: string) => void } & AiCallOptions): Promise<{
      content: unknown; usage?: unknown; stop_reason?: unknown; stop_details?: unknown;
    }>;
  };
}

export interface HaikuClassifierOpts {
  client: AnthropicLike;                                 // real: new Anthropic(); test: fake returning canned JSON
  model?: string;                                        // default "claude-haiku-5-5"
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

/**
 * Classify runs once per message and is the cost-dominant AI call in the product, so the model
 * behind it is a billing input as much as a quality one. Haiku 5.5 ships one id and no dated
 * snapshot, so the dated-vs-alias choice the 4.5 pin made no longer exists: the id is the
 * pin. A model move is a price move — `MODEL_PRICES_USD_PER_MTOK` carries its row, so a
 * margin change is attributable the day it happens.
 */
const DEFAULT_MODEL = "claude-haiku-5-5";

/**
 * Build the exact `messages.create` params for one classify call: cached taxonomy
 * `system` prefix + volatile user turn + `output_config.format` json_schema. Exported
 * so a test can assert the request shape against a fake client.
 *
 * The screen runs FIRST, before `userPayload` exists. That ordering is the guarantee: there is
 * no moment at which a refused payload has been assembled, so nothing can log it, cache it or
 * hand it to a retry queue on the way out.
 */
export function buildClassifyParams(input: ClassifierInput, opts: HaikuClassifierOpts): Record<string, unknown> {
  // Screens FIRST and throws — see `classifyUserPayload`. Nothing below runs on a refused
  // payload, which is what keeps a refused one from ever existing as an assembled object.
  const userPayload = classifyUserPayload(input);
  const model = opts.model ?? DEFAULT_MODEL;
  const params: Record<string, unknown> = {
    model,
    max_tokens: opts.maxTokens ?? 512,
    /**
     * Thinking OFF. Haiku 5.5 thinks by default, and `max_tokens` caps thinking plus the JSON
     * TOGETHER — at 512 a thinking pass can eat the budget before the verdict is written, a
     * truncated classification on the per-message path. The value is the model's own row in
     * `MODEL_REQUEST_RULES`: `disabled` on Haiku 5.5, legal at effort `high` or below, and this
     * file sets no effort (default `medium`). A model that cannot turn thinking off is refused.
     */
    thinking: thinkingOffFor(model),
    system: [
      { type: "text", text: TAXONOMY_PREFIX, cache_control: { type: "ephemeral" } },
    ],
    messages: [
      { role: "user", content: JSON.stringify(userPayload) },
    ],
    output_config: {
      format: { type: "json_schema", schema: CLASSIFY_RESULT_SCHEMA },
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
  throw new Error("classifier: response carried no text content block");
}

/**
 * The same request, asking the SCREENING question instead of the routing one — a different
 * `system` prefix and schema over the same screened user payload. The payload builder is shared
 * deliberately: the outbound sensitivity screen is a property of what leaves this process, not of
 * which question it is attached to, and a second builder is how one question eventually ships
 * without it. Shared even though this is the question the AI-OPEN ruling opened — what differs is
 * carried on the INPUT (`ClassifierInput.outbound`) by the caller who did the redacting: a caller
 * that redacts and says so is served; one that says nothing is refused, here, exactly as before.
 */
export function buildScreeningParams(input: ClassifierInput, opts: HaikuClassifierOpts): Record<string, unknown> {
  const userPayload = classifyUserPayload(input);
  const model = opts.model ?? DEFAULT_MODEL;
  const params: Record<string, unknown> = {
    model,
    max_tokens: opts.maxTokens ?? 512,
    thinking: thinkingOffFor(model),                     // see `buildClassifyParams`
    system: [
      { type: "text", text: SCREENING_PREFIX, cache_control: { type: "ephemeral" } },
    ],
    messages: [
      { role: "user", content: JSON.stringify(userPayload) },
    ],
    output_config: {
      format: { type: "json_schema", schema: SCREENING_RESULT_SCHEMA },
    },
  };
  if (opts.inferenceGeo) params.inference_geo = opts.inferenceGeo;
  return params;
}

/** One structured-output round trip. Shared by both questions; only the params differ. */
async function ask(
  params: Record<string, unknown>, opts: HaikuClassifierOpts, call?: AiCallOptions,
): Promise<unknown> {
  const resp = await (call ? opts.client.messages.create(params, call) : opts.client.messages.create(params));
  // A refusal (no content) or a cut-off answer is this message's outcome, not a malformed reply:
  // thrown as its own class so no caller counts it as a provider fault.
  const declined = declineOf(resp.stop_reason, resp.stop_details);
  if (declined) throw declined;
  const text = extractJsonText(resp.content);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("classifier: response was not valid JSON");
  }
}

export function makeHaikuClassifier(opts: HaikuClassifierOpts): ClassifierPort {
  // At construction, so a model with no thinking-off shape fails the boot and not the first message.
  thinkingOffFor(opts.model ?? DEFAULT_MODEL);
  return {
    async classify(input: ClassifierInput, call?: AiCallOptions): Promise<ClassifierResult> {
      return coerceClassifierResult(await ask(buildClassifyParams(input, opts), opts, call));
    },
    async rewriteScreener(request, call) {
      const model = opts.model ?? DEFAULT_MODEL;
      return ask({
        model, max_tokens: request.maxTokens, thinking: thinkingOffFor(model),
        system: [{ type: "text", text: request.system, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: JSON.stringify(request.input) }],
        output_config: { format: { type: "json_schema", schema: request.schema } },
        ...(opts.inferenceGeo ? { inference_geo: opts.inferenceGeo } : {}),
      }, opts, call);
    },
    async screen(input: ClassifierInput, call?: AiCallOptions): Promise<ClassifierResult> {
      return coerceScreeningResult(await ask(buildScreeningParams(input, opts), opts, call));
    },
  };
}
