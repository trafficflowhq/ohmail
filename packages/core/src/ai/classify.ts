import type { ClassifierInput, ClassifierResult, ClassifierPort } from "../classifier-port.js";
import {
  CLASSIFY_RESULT_SCHEMA, SCREENING_PREFIX, SCREENING_RESULT_SCHEMA, TAXONOMY_PREFIX,
  classifyUserPayload, coerceClassifierResult, coerceScreeningResult,
} from "../classify-prompt.js";

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
  SCREENING_RESULT_SCHEMA, SensitivePayloadRefusal, TAXONOMY_PREFIX,
  classifyUserPayload, coerceClassifierResult, coerceScreeningResult,
} from "../classify-prompt.js";
export type { ClassifyUserPayload } from "../classify-prompt.js";

/**
 * A narrow structural seam over `@anthropic-ai/sdk`'s `messages.create` so tests
 * inject a deterministic fake with no network. The real client (`new Anthropic()`)
 * satisfies this shape.
 */
export interface AnthropicLike {
  messages: { create(params: unknown): Promise<{ content: unknown; usage?: unknown }> };
}

export interface HaikuClassifierOpts {
  client: AnthropicLike;                                 // real: new Anthropic(); test: fake returning canned JSON
  model?: string;                                        // default "claude-haiku-4-5-20251001"
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
 * Pinned to the DATED id rather than the `claude-haiku-4-5` alias. Classify runs once per
 * message and is the cost-dominant AI call in the product, so the model behind it is a
 * billing input as much as a quality one: an alias that silently rolls to a new snapshot
 * moves both, and the first evidence would be a margin change nobody could attribute.
 * `draft.ts` keeps the `claude-sonnet-5` alias deliberately — it runs on human request, not
 * per message, so freshness is worth more there than reproducibility.
 */
const DEFAULT_MODEL = "claude-haiku-4-5-20251001";

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
  const params: Record<string, unknown> = {
    model: opts.model ?? DEFAULT_MODEL,
    max_tokens: opts.maxTokens ?? 512,
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
  const params: Record<string, unknown> = {
    model: opts.model ?? DEFAULT_MODEL,
    max_tokens: opts.maxTokens ?? 512,
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
async function ask(params: Record<string, unknown>, opts: HaikuClassifierOpts): Promise<unknown> {
  const resp = await opts.client.messages.create(params);
  const text = extractJsonText(resp.content);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("classifier: response was not valid JSON");
  }
}

export function makeHaikuClassifier(opts: HaikuClassifierOpts): ClassifierPort {
  return {
    async classify(input: ClassifierInput): Promise<ClassifierResult> {
      return coerceClassifierResult(await ask(buildClassifyParams(input, opts), opts));
    },
    async screen(input: ClassifierInput): Promise<ClassifierResult> {
      return coerceScreeningResult(await ask(buildScreeningParams(input, opts), opts));
    },
  };
}
