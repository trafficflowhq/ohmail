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
  fetchWithDeadline, failureOf, shortDetail,
  type AiTransport, type ProbeFailure, type ProbeOutcome,
} from "./ai-transport.js";

/**
 * AN ANTHROPIC API KEY YOU OWN — the primary way a standalone install gets AI.
 *
 * Requests go to Anthropic, billed to the account the key belongs to. This app's publisher is
 * not in the path: it operates no proxy for this, sees none of these requests, and receives
 * neither the key nor the message content. That is the whole point of the option, and the two
 * constants immediately below are what make it structurally true rather than a promise.
 *
 * ── THE ENDPOINT IS NOT CONFIGURABLE, AND THAT IS A SECURITY DECISION ───────────────────────
 *
 * {@link ANTHROPIC_BASE} is a literal. A settings pane that let you name both a key AND the host
 * it is sent to would be a supported way to configure key exfiltration — anything that could
 * write the settings file could redirect a live credential to a host of its choosing, and every
 * request would look exactly like normal operation. The provider that carries a stored secret
 * has a fixed destination; the provider with a configurable destination (a model on your own
 * machine) carries no secret. Neither one is ever both.
 *
 * `redirect: "error"` for the same reason one level down: a 302 is a destination somebody else
 * chose, and this request carries an API key header.
 *
 * ── WHAT TRAVELS ───────────────────────────────────────────────────────────────────────────
 *
 * The sender, the subject and a short redacted snippet for a routing suggestion; the same plus
 * the thread's other snippets and knowledge-base entries you wrote, for a draft. Never a raw
 * message body — the shared allow-list in `@trafficflow/core/mail` refuses one before a request
 * is built. Mail that carries authentication material is refused outright by the same shared
 * sink and is never sent to any model, under any provider.
 */

/** NOT configurable. See the header. */
export const ANTHROPIC_BASE = "https://api.anthropic.com";
/** The API version this client is written against. */
export const ANTHROPIC_VERSION = "2023-06-01";

/**
 * The models a fresh install asks for.
 *
 * Classification is pinned to a DATED id and drafting is not, which is the same split the hosted
 * deployment makes and for the same reason. Classification runs once per message and is the
 * cost-dominant call, so the model behind it is a billing input as much as a quality one: an
 * alias that silently rolls to a new snapshot moves both, and the first evidence would be a bill
 * changing for no visible reason. Drafting runs when a person asks for it, so freshness is worth
 * more there than reproducibility.
 *
 * Both are replaceable from the settings surface, and the verification lists what the key can
 * actually reach so the choice is made from a real list rather than from memory.
 */
export const DEFAULT_ANTHROPIC_MODELS = {
  classify: "claude-haiku-4-5-20251001",
  draft: "claude-sonnet-5",
} as const;

export interface AnthropicTransportOptions {
  apiKey: string;
  classifyModel: string;
  draftModel: string;
  fetchImpl: typeof fetch;
  timeoutMs: number;
}

/** What a non-2xx answer was about, without reading its prose. */
function statusFailure(status: number): ProbeFailure {
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 404) return "model_absent";
  if (status === 408 || status === 504) return "timeout";
  return "bad_response";
}

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
   * One request to the messages endpoint, and the one place a failure becomes an Error.
   *
   * ── THE THINKING FIELD IS SENT, THEN DROPPED IF THE MODEL REFUSES IT ──────────────────────
   *
   * Turning thinking off is a cost and truncation decision: `max_tokens` bounds thinking and
   * response text TOGETHER, so a model that thinks adaptively can spend most of the budget
   * before it starts writing and lose the end of a reply. The hosted deployment can simply
   * disable it, because it chooses its own model. Here the model is the user's choice, and some
   * models refuse to run without thinking and answer 400 for the field rather than ignoring it.
   *
   * That is a fact about the chosen model, not a fault, so the request is made ONCE MORE without
   * the field instead of being reported as a failure. The retry is bounded to exactly one and is
   * conditional on the endpoint naming `thinking` in its own refusal, so an unrelated 400 is
   * still a 400 and is not retried into a second charge.
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
     * THE SCREENING QUESTION — the same transport, the same sink, a different question.
     *
     * Everything that differs from {@link classify} is a constant imported from
     * `@trafficflow/core/mail`: the instruction and the answer set. Nothing about the question is
     * written here, and that is the point rather than a convenience — a hosted deployment and a
     * standalone install are two ways to reach a model, and a second copy of a question is how the
     * two come to give one sender two different answers. Each copy would pass its own test.
     *
     * `classifyUserPayload` is shared with the routing question above for the same reason it is
     * shared with the hosted classifier: the outbound sensitivity screen is a property of what
     * leaves this process, not of which question it is attached to. A second builder here is how
     * one of the two questions eventually ships without one.
     *
     * The CLASSIFY model answers it. The two questions are one call per first-contact sender each,
     * of the same size and the same difficulty, so a person who chose a model for routing has
     * chosen it for this — and a second model setting would be a second thing to get wrong for no
     * decision anybody wants to make.
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

    /**
     * Verify the key and the two models WITHOUT running inference.
     *
     * Listing models authenticates — a wrong, revoked or empty key is a 401 here — and asking for
     * each configured model by name is exact, which a list is not: aliases and dated snapshots do
     * not both have to appear in one page for both to be valid.
     *
     * Deliberately free. A verification that ran a real completion would spend the account
     * holder's money every time they pressed Save, which is a settings pane charging for being
     * opened.
     */
    async probe(): Promise<ProbeOutcome> {
      let models: string[] = [];
      try {
        const res = await fetchWithDeadline(opts.fetchImpl, `${ANTHROPIC_BASE}/v1/models?limit=100`, {
          method: "GET", headers, redirect: "error",
        }, opts.timeoutMs);
        if (!res.ok) {
          return {
            ok: false,
            reason: statusFailure(res.status),
            detail: shortDetail(await res.text()),
            models: [],
          };
        }
        const body = (await res.json()) as { data?: Array<{ id?: unknown }> };
        models = Array.isArray(body.data)
          ? body.data.map((m) => m.id).filter((id): id is string => typeof id === "string")
          : [];
      } catch (err) {
        return { ok: false, reason: failureOf(err), detail: null, models: [] };
      }

      for (const model of new Set([opts.classifyModel, opts.draftModel])) {
        try {
          const res = await fetchWithDeadline(
            opts.fetchImpl,
            `${ANTHROPIC_BASE}/v1/models/${encodeURIComponent(model)}`,
            { method: "GET", headers, redirect: "error" },
            opts.timeoutMs,
          );
          if (!res.ok) {
            return {
              ok: false,
              reason: statusFailure(res.status),
              detail: `the key cannot reach the model "${model}"`,
              models,
            };
          }
        } catch (err) {
          return { ok: false, reason: failureOf(err), detail: null, models };
        }
      }
      return { ok: true, reason: null, detail: null, models };
    },
  };
}
