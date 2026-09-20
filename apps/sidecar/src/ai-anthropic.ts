import {
  CLASSIFY_RESULT_SCHEMA, DRAFT_PREFIX, DRAFT_RESULT_SCHEMA,
  SCREENING_PREFIX, SCREENING_RESULT_SCHEMA, TAXONOMY_PREFIX,
  classifyUserPayload, coerceClassifierResult, coerceDraftResult, coerceScreeningResult,
  draftUserPayload,
} from "@trafficflow/core/mail";
import type {
  ClassifierInput, ClassifierResult, DraftInput, DraftResult,
} from "@trafficflow/core/mail";
import {
  fetchWithDeadline, probeKeyedCatalogue,
  type AiKeyTransportOptions, type AiTransport, type ProbeOutcome,
} from "./ai-transport.js";

/**
 * An Anthropic API key you own — the primary way a standalone install gets AI. Requests go to
 * Anthropic, billed to the key's account; this app's publisher is not in the path and receives
 * neither key nor content. {@link ANTHROPIC_BASE} is a LITERAL, a security decision: a pane that
 * let you name both a key AND its host would be a supported way to configure key exfiltration, so
 * the provider carrying a stored secret has a fixed destination and the one with a configurable
 * destination (a local model) carries none. `redirect: "error"` likewise. What travels: sender,
 * subject and a short redacted snippet (a draft adds thread snippets and knowledge-base entries) —
 * never a raw body, refused with authentication material by the shared allow-list in `@trafficflow/core/mail`.
 */

/** NOT configurable. See the header. */
export const ANTHROPIC_BASE = "https://api.anthropic.com";
/** The API version this client is written against. */
export const ANTHROPIC_VERSION = "2023-06-01";

/**
 * The models a fresh install asks for. Classification is pinned to a DATED id and drafting is not —
 * the same split the hosted deployment makes: classification runs once per message and is the
 * cost-dominant call, so the model behind it is a billing input, and an alias that silently rolls
 * to a new snapshot moves both cost and quality with a bill changing for no visible reason.
 * Drafting runs when a person asks, so freshness is worth more there than reproducibility. Both are
 * replaceable from settings, and the verification lists what the key can reach so the choice is made
 * from a real list rather than from memory.
 */
export const DEFAULT_ANTHROPIC_MODELS = {
  classify: "claude-haiku-4-5-20251001",
  draft: "claude-sonnet-5",
} as const;

/** Kept as the name this provider's callers have always used. */
export type AnthropicTransportOptions = AiKeyTransportOptions;

/** The JSON text a structured-output response carries in its content blocks. */
function extractJsonText(content: unknown, what: string): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block && typeof block === "object" && (block as { type?: string }).type === "text") {
        const t = (block as { text?: unknown }).text;
        if (typeof t === "string") return t;
      }
    }
  }
  throw new Error(`${what}: response carried no text content block`);
}

export function anthropicTransport(opts: AnthropicTransportOptions): AiTransport {
  const headers = {
    "content-type": "application/json",
    "x-api-key": opts.apiKey,
    "anthropic-version": ANTHROPIC_VERSION,
  };

  /**
   * One request to the messages endpoint, and the one place a failure becomes an Error. The
   * `thinking` field is sent, then DROPPED if the model refuses it: `max_tokens` bounds thinking and
   * response text together, so a model that thinks adaptively can spend the budget before it writes;
   * the hosted deployment disables thinking because it picks its own model, but here the model is the
   * user's choice and some refuse to run without it, answering 400 for the field. That is a fact
   * about the chosen model, so the request is remade ONCE without the field, conditional on the
   * endpoint naming `thinking` in its refusal — an unrelated 400 stays a 400 and is not retried.
   */
  const call = async (body: Record<string, unknown>, what: string): Promise<unknown> => {
    const send = async (payload: Record<string, unknown>): Promise<Response> =>
      fetchWithDeadline(opts.fetchImpl, `${ANTHROPIC_BASE}/v1/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        redirect: "error",
      }, opts.timeoutMs);

    let res = await send(body);
    if (res.status === 400 && "thinking" in body) {
      const refusal = await res.text();
      if (!refusal.includes("thinking")) {
        throw new Error(`${what}: the model refused the request (400)`);
      }
      const { thinking: _dropped, ...withoutThinking } = body;
      res = await send(withoutThinking);
    }
    if (!res.ok) {
      // The status only. An error body from this endpoint quotes the request that produced it,
      // and this request carries an API key header — so it is read for the settings surface at
      // verification time and never on this path.
      throw new Error(`${what}: the model endpoint answered ${res.status}`);
    }
    const json = (await res.json()) as { content?: unknown };
    const text = extractJsonText(json.content, what);
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new Error(`${what}: the model's response was not valid JSON`);
    }
  };

  return {
    async classify(input: ClassifierInput): Promise<ClassifierResult> {
      // Screens for authentication material and THROWS before a payload exists. Shared with the
      // hosted classifier, deliberately: one sink, so there is one thing to get right.
      const userPayload = classifyUserPayload(input);
      const raw = await call({
        model: opts.classifyModel,
        max_tokens: 512,
        system: [{ type: "text", text: TAXONOMY_PREFIX, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: JSON.stringify(userPayload) }],
        output_config: { format: { type: "json_schema", schema: CLASSIFY_RESULT_SCHEMA } },
      }, "classifier");
      return coerceClassifierResult(raw);
    },

    /**
     * The screening question — the same transport, the same sink, a different question. Everything
     * that differs from {@link classify} is a constant imported from `@trafficflow/core/mail` (the
     * instruction and the answer set); nothing about the question is written here, because a second
     * copy is how a hosted deployment and a standalone install come to give one sender two different
     * answers, each passing its own test. `classifyUserPayload` is shared for the same reason: the
     * outbound sensitivity screen is a property of what leaves this process, not of the question. The
     * CLASSIFY model answers it — one call per first-contact sender, same size and difficulty, so a
     * model chosen for routing is chosen for this.
     */
    async screen(input: ClassifierInput): Promise<ClassifierResult> {
      const userPayload = classifyUserPayload(input);
      const raw = await call({
        model: opts.classifyModel,
        max_tokens: 512,
        system: [{ type: "text", text: SCREENING_PREFIX, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: JSON.stringify(userPayload) }],
        output_config: { format: { type: "json_schema", schema: SCREENING_RESULT_SCHEMA } },
      }, "screener");
      // A label outside the five piles becomes the gate, where a person decides — never a guess.
      return coerceScreeningResult(raw);
    },

    async draft(input: DraftInput): Promise<DraftResult> {
      // Asserts the redaction allow-list and THROWS before a payload exists. Also shared.
      const userPayload = draftUserPayload(input);
      const raw = await call({
        model: opts.draftModel,
        max_tokens: 2048,
        thinking: { type: "disabled" },
        system: [{ type: "text", text: DRAFT_PREFIX, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: JSON.stringify(userPayload) }],
        output_config: { format: { type: "json_schema", schema: DRAFT_RESULT_SCHEMA } },
      }, "drafter");
      return coerceDraftResult(raw);
    },

    /** Verify the key and the two models without inference — {@link probeKeyedCatalogue}'s rule. */
    async probe(): Promise<ProbeOutcome> {
      return probeKeyedCatalogue({
        fetchImpl: opts.fetchImpl, timeoutMs: opts.timeoutMs, headers,
        listUrl: `${ANTHROPIC_BASE}/v1/models?limit=100`,
        modelUrl: (m) => `${ANTHROPIC_BASE}/v1/models/${encodeURIComponent(m)}`,
        models: [opts.classifyModel, opts.draftModel],
        // No name test: this vendor's catalogue is all chat models.
      });
    },
  };
}
