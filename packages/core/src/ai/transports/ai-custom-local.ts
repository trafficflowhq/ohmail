import {
  CLASSIFY_RESULT_SCHEMA, DRAFT_PREFIX, DRAFT_RESULT_SCHEMA,
  SCREENING_PREFIX, SCREENING_RESULT_SCHEMA, TAXONOMY_PREFIX,
  classifyUserPayload, coerceClassifierResult, coerceDraftResult, coerceScreeningResult,
  draftUserPayload, ModelDeclinedError,
} from "../../mail.js";
import type {
  ClassifierInput, ClassifierResult, DraftInput, DraftResult,
} from "../../mail.js";
import {
  fetchWithDeadline, failureOf, shortDetail, usageMeter,
  type AiTransport, type ProbeOutcome, type TransportUsage,
} from "./ai-transport.js";

/**
 * A keyless OpenAI-compatible model server (LM Studio, vLLM, llama.cpp). Like Ollama,
 * its destination is configurable because no credential travels. Hosted OpenAI keeps
 * its fixed destination. All model payloads go through the shared refusing sinks.
 */

export const DEFAULT_CUSTOM_LOCAL = {
  baseUrl: "",
  classifyModel: "",
  draftModel: "",
} as const;

const CUSTOM_LOCAL_MAX_TOKENS = {
  classify: 512,
  draft: 2048,
} as const;

export interface CustomLocalTransportOptions {
  baseUrl: string;
  classifyModel: string;
  draftModel: string;
  fetchImpl: typeof fetch;
  timeoutMs: number;
  onUsage?: TransportUsage;
}

/** Accept an origin, an API base path, or the full chat-completions URL. */
export function resolveCustomLocalUrls(baseUrl: string): { chatUrl: string; modelsUrl: string } {
  const trimmed = baseUrl.trim().replace(/\/+$/, "").replace(/\/chat\/completions$/, "");
  const base = new URL(trimmed).pathname === "/" ? `${trimmed}/v1` : trimmed;
  return { chatUrl: `${base}/chat/completions`, modelsUrl: `${base}/models` };
}

function extractJsonText(json: unknown, what: string): string {
  const obj = json as {
    choices?: Array<{ message?: { content?: unknown; refusal?: unknown } }>;
  };
  const message = obj.choices?.[0]?.message;
  if (typeof message?.refusal === "string" && message.refusal !== "") {
    throw new ModelDeclinedError("refusal", null);
  }
  if (typeof message?.content === "string" && message.content !== "") {
    return message.content;
  }
  throw new Error(`${what}: response carried no message content`);
}

function parseJsonResponse(text: string, what: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text.trim());
    if (fenced?.[1]) {
      try {
        return JSON.parse(fenced[1]) as unknown;
      } catch {
        // Fall through to standard error below.
      }
    }
    throw new Error(`${what}: the model's response was not valid JSON`);
  }
}

export function customLocalTransport(opts: CustomLocalTransportOptions): AiTransport {
  const { chatUrl, modelsUrl } = resolveCustomLocalUrls(opts.baseUrl);
  const headers = { "content-type": "application/json" };

  const responseFormat = (name: string, schema: unknown): Record<string, unknown> => ({
    type: "json_schema",
    json_schema: { name, strict: true, schema },
  });

  const call = async (body: Record<string, unknown>, what: string): Promise<unknown> => {
    const meter = usageMeter(opts.onUsage, String(body.model));
    const send = async (payload: Record<string, unknown>): Promise<Response> => {
      meter.attempt();
      const res = await fetchWithDeadline(opts.fetchImpl, chatUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        redirect: "error",
      }, opts.timeoutMs);
      meter.answered(res);
      return res;
    };

    try {
      let res = await send(body);
      if (res.status === 400 || res.status === 422) {
        const refusal = await res.text();
        const schemaRefused = refusal.includes("response_format") || refusal.includes("json_schema");
        const budgets = refusal.includes("max_tokens") || refusal.includes("max_completion_tokens");
        const temp = refusal.includes("temperature");
        if (!schemaRefused && !budgets && !temp) {
          throw new Error(`${what}: the model refused the request (${res.status})`);
        }
        const {
          max_tokens: budget,
          temperature: droppedTemp,
          response_format: droppedFormat,
          ...rest
        } = body;
        const retryPayload: Record<string, unknown> = {
          ...rest,
          ...(budgets ? { max_completion_tokens: budget } : { max_tokens: budget }),
          ...(temp || budgets ? {} : { temperature: droppedTemp }),
          ...(schemaRefused ? {} : { response_format: droppedFormat }),
        };
        res = await send(retryPayload);
      }
      if (!res.ok) {
        throw new Error(`${what}: the local model endpoint answered ${res.status}`);
      }
      const json = (await res.json()) as {
        model?: unknown;
        usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
      };
      meter.read({
        model: json.model,
        input: json.usage?.prompt_tokens,
        output: json.usage?.completion_tokens,
      });
      const text = extractJsonText(json, what);
      return parseJsonResponse(text, what);
    } finally {
      meter.end();
    }
  };

  const turns = (system: string, payload: unknown): Array<Record<string, string>> => [
    { role: "system", content: system },
    { role: "user", content: JSON.stringify(payload) },
  ];

  return {
    async classify(input: ClassifierInput): Promise<ClassifierResult> {
      const userPayload = classifyUserPayload(input);
      const raw = await call({
        model: opts.classifyModel,
        max_tokens: CUSTOM_LOCAL_MAX_TOKENS.classify,
        temperature: 0,
        messages: turns(TAXONOMY_PREFIX, userPayload),
        response_format: responseFormat("routing", CLASSIFY_RESULT_SCHEMA),
      }, "classifier");
      return coerceClassifierResult(raw);
    },

    async screen(input: ClassifierInput): Promise<ClassifierResult> {
      const userPayload = classifyUserPayload(input);
      const raw = await call({
        model: opts.classifyModel,
        max_tokens: CUSTOM_LOCAL_MAX_TOKENS.classify,
        temperature: 0,
        messages: turns(SCREENING_PREFIX, userPayload),
        response_format: responseFormat("screening", SCREENING_RESULT_SCHEMA),
      }, "screener");
      return coerceScreeningResult(raw);
    },

    async draft(input: DraftInput): Promise<DraftResult> {
      const userPayload = draftUserPayload(input);
      const raw = await call({
        model: opts.draftModel,
        max_tokens: CUSTOM_LOCAL_MAX_TOKENS.draft,
        temperature: 0,
        messages: turns(DRAFT_PREFIX, userPayload),
        response_format: responseFormat("reply_draft", DRAFT_RESULT_SCHEMA),
      }, "drafter");
      return coerceDraftResult(raw);
    },

    /** List models without inference; a reachable server alone is not verification. */
    async probe(): Promise<ProbeOutcome> {
      let models: string[] = [];
      try {
        const res = await fetchWithDeadline(opts.fetchImpl, modelsUrl, {
          method: "GET", redirect: "error",
        }, opts.timeoutMs);
        if (!res.ok) {
          return { ok: false, reason: "bad_response", detail: shortDetail(await res.text()), models };
        }
        const body = await res.json() as { data?: Array<{ id?: unknown }> } | null;
        if (!Array.isArray(body?.data)) {
          return { ok: false, reason: "bad_response", detail: null, models };
        }
        models = [...new Set(body.data.map((m) => m?.id)
          .filter((id): id is string => typeof id === "string" && id.trim() !== ""))];
      } catch (err) {
        return { ok: false, reason: err instanceof SyntaxError ? "bad_response" : failureOf(err), detail: null, models };
      }
      for (const wanted of new Set([opts.classifyModel, opts.draftModel])) {
        if (!wanted || !models.includes(wanted)) {
          return {
            ok: false, reason: "model_absent",
            detail: `the model server does not list "${wanted}" — choose a model it serves`, models,
          };
        }
      }
      return { ok: true, reason: null, detail: null, models };
    },
  };
}
