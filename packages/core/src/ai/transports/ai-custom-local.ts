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
 * A user-configured OpenAI/Anthropic-compatible local runtime (such as Bionic, LM Studio, or vLLM).
 *
 * Unlike the hosted providers (whose destination is fixed) or the Ollama provider (which speaks
 * Ollama's `/api/chat` and `/api/tags` protocol), this transport speaks standard
 * `/v1/chat/completions` against a configurable Base URL and Model ID, with an optional local or
 * dummy API token that never triggers a remote cloud validation handshake.
 */

export const DEFAULT_CUSTOM_LOCAL = {
  baseUrl: "http://127.0.0.1:1235/v1",
  classifyModel: "google/gemma-4-e2b",
  draftModel: "google/gemma-4-e2b",
} as const;

const CUSTOM_LOCAL_MAX_TOKENS = {
  classify: 512,
  draft: 2048,
} as const;

export interface CustomLocalTransportOptions {
  baseUrl: string;
  classifyModel: string;
  draftModel: string;
  apiKey?: string | null;
  fetchImpl: typeof fetch;
  timeoutMs: number;
  onUsage?: TransportUsage;
}

/**
 * Resolve the `/v1/chat/completions` and `/v1/models` URLs from a user-supplied base URL.
 * Accepts base URLs with or without a trailing `/v1` or `/v1/chat/completions` suffix.
 */
export function resolveCustomLocalUrls(baseUrl: string): { chatUrl: string; modelsUrl: string } {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (trimmed.endsWith("/chat/completions")) {
    return {
      chatUrl: trimmed,
      modelsUrl: trimmed.replace(/\/chat\/completions$/, "/models"),
    };
  }
  if (trimmed.endsWith("/v1")) {
    return {
      chatUrl: `${trimmed}/chat/completions`,
      modelsUrl: `${trimmed}/models`,
    };
  }
  return {
    chatUrl: `${trimmed}/v1/chat/completions`,
    modelsUrl: `${trimmed}/v1/models`,
  };
}

function extractJsonText(json: unknown, what: string): string {
  const obj = json as {
    choices?: Array<{ message?: { content?: unknown; refusal?: unknown } }>;
    content?: Array<{ type?: unknown; text?: unknown }>;
    message?: { content?: unknown };
  };
  const message = obj.choices?.[0]?.message;
  if (typeof message?.refusal === "string" && message.refusal !== "") {
    throw new ModelDeclinedError("refusal", null);
  }
  if (typeof message?.content === "string" && message.content !== "") {
    return message.content;
  }
  if (Array.isArray(obj.content)) {
    const block = obj.content.find((b) => b?.type === "text" && typeof b.text === "string" && b.text !== "");
    if (block && typeof block.text === "string") {
      return block.text;
    }
  }
  if (typeof obj.message?.content === "string" && obj.message.content !== "") {
    return obj.message.content;
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
  const trimmedKey = typeof opts.apiKey === "string" ? opts.apiKey.trim() : "";
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...(trimmedKey !== "" ? { authorization: `Bearer ${trimmedKey}` } : {}),
  };

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
        usage?: { prompt_tokens?: unknown; completion_tokens?: unknown; input_tokens?: unknown; output_tokens?: unknown };
      };
      meter.read({
        model: json.model,
        input: json.usage?.prompt_tokens ?? json.usage?.input_tokens,
        output: json.usage?.completion_tokens ?? json.usage?.output_tokens,
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

    /**
     * Probe the local endpoint without running remote cloud key validation.
     *
     * Local OpenAI-compatible servers may return an OpenAI-style `{ data: [{ id }] }` list on
     * `/v1/models`, an Ollama-style `{ models: [{ name }] }` list, or `404`/`405` when only
     * `/v1/chat/completions` is mounted. Any reachable local HTTP response (2xx or 404/405 on the
     * catalogue route) is treated as a valid local connection so custom model IDs and dummy tokens
     * work out of the box.
     */
    async probe(): Promise<ProbeOutcome> {
      const configured = Array.from(
        new Set([opts.classifyModel, opts.draftModel].map((m) => m.trim()).filter((m) => m !== "")),
      );
      try {
        const res = await fetchWithDeadline(opts.fetchImpl, modelsUrl, {
          method: "GET",
          headers,
          redirect: "error",
        }, opts.timeoutMs);

        if (res.status === 404 || res.status === 405) {
          return { ok: true, reason: null, detail: null, models: configured };
        }
        if (!res.ok) {
          return {
            ok: false,
            reason: res.status === 408 || res.status === 504 ? "timeout" : "bad_response",
            detail: shortDetail(await res.text()),
            models: [],
          };
        }

        let discovered: string[] = [];
        try {
          const body = (await res.json()) as {
            data?: Array<{ id?: unknown }>;
            models?: Array<{ id?: unknown; name?: unknown; model?: unknown }>;
          };
          if (Array.isArray(body.data)) {
            discovered = body.data
              .map((m) => m.id)
              .filter((id): id is string => typeof id === "string" && id.trim() !== "");
          } else if (Array.isArray(body.models)) {
            discovered = body.models
              .map((m) => (typeof m.id === "string" ? m.id : typeof m.name === "string" ? m.name : m.model))
              .filter((id): id is string => typeof id === "string" && id.trim() !== "");
          }
        } catch {
          // Non-JSON 2xx from local health/models endpoint still proves local reachability.
        }

        const models = Array.from(new Set([...discovered, ...configured]));
        return { ok: true, reason: null, detail: null, models };
      } catch (err) {
        return { ok: false, reason: failureOf(err), detail: null, models: [] };
      }
    },
  };
}
