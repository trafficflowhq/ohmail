import { randomUUID } from "node:crypto";
import {
  CLASSIFY_RESULT_SCHEMA, DRAFT_PREFIX, DRAFT_RESULT_SCHEMA, ModelDeclinedError,
  SCREENING_PREFIX, SCREENING_RESULT_SCHEMA, TAXONOMY_PREFIX,
  classifyUserPayload, coerceClassifierResult, coerceDraftResult, coerceScreeningResult,
  draftUserPayload,
} from "../../mail.js";
import type {
  ClassifierInput, ClassifierResult, DraftInput, DraftResult,
} from "../../mail.js";
import { probeOpenCodeGo } from "./ai-opencode-go.js";
import {
  fetchWithDeadline, usageMeter, type AiKeyTransportOptions, type AiTransport, type ProbeOutcome,
} from "./ai-transport.js";

/** Fixed OpenCode Go Chat Completions destination; no user-configurable URL or provider fallback. */
export const OPENCODE_GO_CHAT_URL = "https://opencode.ai/inference/go/v1/chat/completions";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

type StrictObjectSchema = {
  type: "object";
  additionalProperties: false;
  required: readonly string[];
  properties: Record<string, { type: "string" | "number" | "boolean"; enum?: readonly unknown[] }>;
};
function finalText(response: unknown, what: string): string {
  const choices = isRecord(response) && Array.isArray(response.choices) ? response.choices : null;
  if (!choices || choices.length !== 1) {
    throw new Error(`${what}: response did not contain one final choice`);
  }
  const choice = choices[0];
  const message = isRecord(choice) && isRecord(choice.message) ? choice.message : null;
  if (!message) throw new Error(`${what}: response carried no final JSON content`);
  if (message.refusal !== undefined && message.refusal !== null && message.refusal !== "") {
    throw new ModelDeclinedError("refusal", null);
  }
  if (isRecord(choice) && choice.finish_reason === "length") {
    throw new ModelDeclinedError("max_tokens", null);
  }
  if (!isRecord(choice) || choice.finish_reason !== "stop") {
    throw new Error(`${what}: response did not finish with a complete final answer`);
  }
  if (typeof message.content !== "string") {
    throw new Error(`${what}: response carried no final JSON content`);
  }
  return message.content;
}

function validateFinalResult(value: unknown, schema: StrictObjectSchema, what: string): void {
  const invalid = (): never => {
    throw new Error(`${what}: final JSON did not match the required schema`);
  };
  if (!isRecord(value) || schema.type !== "object" || schema.additionalProperties !== false) return invalid();

  const fields = Object.keys(schema.properties);
  const required = new Set(schema.required);
  if (required.size !== schema.required.length
    || fields.length !== schema.required.length
    || fields.some((field) => !required.has(field))) return invalid();

  const actualFields = Object.keys(value);
  if (actualFields.length !== schema.required.length
    || actualFields.some((field) => !required.has(field))
    || schema.required.some((field) => !Object.hasOwn(value, field))) return invalid();

  for (const field of schema.required) {
    const property = schema.properties[field];
    const actual = value[field];
    if (!property) return invalid();
    if (property.type === "string" && typeof actual !== "string") return invalid();
    if (property.type === "number" && (typeof actual !== "number" || !Number.isFinite(actual))) return invalid();
    if (property.type === "boolean" && typeof actual !== "boolean") return invalid();
    if (property.enum && !property.enum.includes(actual)) return invalid();
  }
}

function responseFormat(name: string, schema: StrictObjectSchema): Record<string, unknown> {
  return { type: "json_schema", json_schema: { name, strict: true, schema } };
}

/** A Go service-account key and two verified bare model IDs, over Chat Completions only. */
export function opencodeGoTransport(opts: AiKeyTransportOptions): AiTransport {
  const headers = {
    "content-type": "application/json",
    authorization: `Bearer ${opts.apiKey}`,
    "user-agent": "ohmail-desktop",
    "x-opencode-client": "ohmail",
  };

  const turns = (system: string, payload: unknown): Array<Record<string, string>> => [
    { role: "system", content: system },
    { role: "user", content: JSON.stringify(payload) },
  ];

  const call = async (
    model: string,
    maxTokens: number,
    system: string,
    payload: unknown,
    name: string,
    schema: StrictObjectSchema,
    what: string,
  ): Promise<unknown> => {
    /* Each call is a self-contained prompt with its full context; no follow-up turn reuses it.
       Give that one-shot conversation an opaque Go session, never a mail/thread ID or content. */
    const session = `ohmail-${randomUUID()}`;
    const meter = usageMeter(opts.onUsage, model);
    let envelope: unknown;
    try {
      meter.attempt();
      const response = await fetchWithDeadline(opts.fetchImpl, OPENCODE_GO_CHAT_URL, {
        method: "POST",
        headers: { ...headers, "x-opencode-session": session },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          temperature: 0,
          messages: turns(system, payload),
          response_format: responseFormat(name, schema),
        }),
        redirect: "error",
      }, opts.timeoutMs);
      meter.answered(response);
      if (!response.ok) throw new Error(`${what}: OpenCode Go answered ${response.status}`);

      try {
        envelope = await response.json();
      } catch {
        throw new Error(`${what}: OpenCode Go returned an unreadable response`);
      }
      const used = isRecord(envelope) && isRecord(envelope.usage) ? envelope.usage : {};
      meter.read({ model: isRecord(envelope) ? envelope.model : undefined, input: used.prompt_tokens, output: used.completion_tokens });
    } finally {
      meter.end();
    }
    const text = finalText(envelope, what);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      throw new Error(`${what}: the final response was not valid JSON`);
    }
    validateFinalResult(parsed, schema, what);
    return parsed;
  };

  return {
    async classify(input: ClassifierInput): Promise<ClassifierResult> {
      const payload = classifyUserPayload(input);
      const raw = await call(
        opts.classifyModel, 512, TAXONOMY_PREFIX, payload,
        "routing", CLASSIFY_RESULT_SCHEMA, "classifier",
      );
      return coerceClassifierResult(raw);
    },

    async screen(input: ClassifierInput): Promise<ClassifierResult> {
      const payload = classifyUserPayload(input);
      const raw = await call(
        opts.classifyModel, 512, SCREENING_PREFIX, payload,
        "screening", SCREENING_RESULT_SCHEMA, "screener",
      );
      return coerceScreeningResult(raw);
    },

    async draft(input: DraftInput): Promise<DraftResult> {
      const payload = draftUserPayload(input);
      const raw = await call(
        opts.draftModel, 2048, DRAFT_PREFIX, payload,
        "reply_draft", DRAFT_RESULT_SCHEMA, "drafter",
      );
      return coerceDraftResult(raw);
    },

    async probe(): Promise<ProbeOutcome> {
      return probeOpenCodeGo({
        apiKey: opts.apiKey,
        models: [opts.classifyModel, opts.draftModel],
        fetchImpl: opts.fetchImpl,
        timeoutMs: opts.timeoutMs,
      });
    },
  };
}
