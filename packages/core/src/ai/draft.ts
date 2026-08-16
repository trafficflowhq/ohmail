import type { AnthropicLike } from "./classify.js";
import type { DraftInput, DraftPort, DraftResult } from "../draft-port.js";
import {
  DRAFT_PREFIX, DRAFT_RESULT_SCHEMA, coerceDraftResult, draftUserPayload,
} from "../draft-prompt.js";

/**
 * THE DRAFTER IMPLEMENTATION — the model half of the seam declared in `../draft-port.ts`.
 *
 * It mirrors the classifier exactly: the PORT lives outside this directory so services can
 * depend on it without depending on a model, and the implementation here takes an INJECTED
 * client so the suite mocks it and makes no network call. This module NEVER imports a model SDK
 * at load time — the concrete client is constructed by the application and injected, which keeps
 * the drafter hermetic and the tests offline.
 *
 * The port's own file states the sensitivity guarantee, because that guarantee is a property of
 * the input SHAPE rather than of this implementation: the caller refuses to draft against a
 * message excluded from AI and excludes such messages from the surrounding context before
 * building the input, so there is no field here through which a raw body could arrive.
 *
 * ── THE QUESTION MOVED OUT; ONLY THE TRANSPORT IS LEFT ───────────────────────────────────────
 *
 * The voice and reply policy, the response schema, the redaction allow-list and the coercion now
 * live in `../draft-prompt.ts`, a leaf outside this directory. There is more than one way to
 * reach a model — a hosted deployment with its own account, and a standalone install running
 * against a key or a local model belonging to its user — and a second copy of the reply policy is
 * how those two come to write in two different voices from the same mailbox. In particular the
 * redaction sink is now SHARED rather than reimplemented: "no raw content in a draft request" is
 * a property of every drafter, not a habit each of them has to keep.
 *
 * Every name that used to be declared here is re-exported below, so no import outside this
 * package moves.
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
     * THINKING OFF, and it is a billing decision before it is a quality one.
     *
     * `claude-sonnet-5` runs ADAPTIVE THINKING BY DEFAULT when this field is omitted, and
     * `max_tokens` caps thinking plus response text TOGETHER. Two consequences, both measured
     * against the live API rather than reasoned about:
     *
     *  · **Truncation.** A real draft of an ordinary business reply came back as 259 thinking
     *    tokens + 539 text = 798 of the 1024 available. A longer reply, or a deeper think,
     *    silently loses its ending — and a truncated draft is a draft the customer paid an AI
     *    action for.
     *  · **Cost the ledger cannot see.** One credit buys one draft, so every thinking token is
     *    margin, and how many there are is the model's decision rather than ours. That is a
     *    variable this product cannot price until `onUsage` has produced real numbers.
     *    Deterministic first, tuned second.
     *
     * The alternative — keep thinking and raise `max_tokens` — is the better answer for QUALITY
     * and is deliberately deferred to a re-pricing decision made WITH measurements, not before
     * any exist. Accepted on Sonnet 5 at any effort.
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
