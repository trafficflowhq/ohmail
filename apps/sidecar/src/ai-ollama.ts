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
  type AiTransport, type ProbeOutcome,
} from "./ai-transport.js";
// The ONE matcher this question has. The desktop's provider form imports the same module to
// decide which name its picker shows; a copy here is how the picker and the verdict disagree.
import { hasInstalledModel } from "@trafficflow/core/model-name";

/**
 * A model running on this machine — the second way a standalone install gets AI. Ollama serves
 * models over plain HTTP on the machine it runs on; content goes there and no further (no account,
 * no key, no third party). The address IS configurable here, safe because no secret travels: the
 * mirror image of the API-key provider, which carries a credential and so has a fixed destination —
 * a configurable destination WITH a stored credential would redirect a live key, so neither is ever
 * both. The address is narrowed to an http(s) origin and requests refuse redirects. Both calls pass
 * the shared response schema as Ollama's `format` (smaller local models drift further producing
 * JSON alone), and `@trafficflow/core/mail`'s coercion is a floor: an unrecognised label lands at the Screener.
 */

/** Where a default install of Ollama listens, and the models a fresh configuration asks for. */
export const DEFAULT_OLLAMA = {
  baseUrl: "http://127.0.0.1:11434",
  classifyModel: "llama3.2",
  draftModel: "llama3.2",
} as const;

/**
 * How many tokens a local answer may run to, and why its absence was a hang. The two hosted
 * providers bound their own answers (512 for a verdict, 2048 for a draft); this sent no bound, and
 * Ollama generates until the context window is exhausted, so the ceiling was the client deadline.
 * Measured against a real daemon: `qwen2.5:0.5b` fell into a repetition loop and never emitted a
 * stop token — unbounded it ran past 300 s; bounded at 2048 it stopped in 21 s with `done_reason:
 * "length"`. Small models drift this way far more readily, and this is the provider whose models are
 * small by definition. The numbers deliberately MATCH the hosted providers': the same question
 * deserves the same room, and a per-provider budget is a second thing that makes installs differ.
 */
const OLLAMA_MAX_TOKENS = {
  classify: 512,
  draft: 2048,
} as const;

export interface OllamaTransportOptions {
  baseUrl: string;
  classifyModel: string;
  draftModel: string;
  fetchImpl: typeof fetch;
  timeoutMs: number;
}

export function ollamaTransport(opts: OllamaTransportOptions): AiTransport {
  const chat = async (
    model: string,
    system: string,
    payload: unknown,
    schema: unknown,
    what: string,
    maxTokens: number,
  ): Promise<unknown> => {
    const res = await fetchWithDeadline(opts.fetchImpl, `${opts.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        stream: false,
        // The same schema the hosted path constrains its answer to.
        format: schema,
        messages: [
          { role: "system", content: system },
          { role: "user", content: JSON.stringify(payload) },
        ],
        options: {
          // Deterministic on purpose: routing the same message twice must not produce two
          // different folders, and a draft is reviewed before it is sent, so novelty buys nothing.
          temperature: 0,
          // The ceiling. See OLLAMA_MAX_TOKENS — without it a model that never stops is bounded
          // only by the client deadline, which is a hang rather than a refusal.
          num_predict: maxTokens,
        },
      }),
      redirect: "error",
    }, opts.timeoutMs);
    if (!res.ok) {
      throw new Error(`${what}: the local model server answered ${res.status}`);
    }
    const body = (await res.json()) as { message?: { content?: unknown }; done_reason?: unknown };
    const text = body.message?.content;
    if (typeof text !== "string") {
      throw new Error(`${what}: the local model server returned no message content`);
    }
    /**
     * Parse first — hitting the ceiling is not the same as failing. `done_reason: "length"` means
     * the model was still going when the budget ran out, and the intuitive reading ("truncated,
     * refuse it") is wrong often enough to matter: when the last allowed token closes the object the
     * content is complete and schema-valid, the model simply had not emitted its stop token. Refusing
     * that throws away a good verdict, and MORE often on the small models this provider exists for.
     * So the ceiling is only ever a DIAGNOSIS for content that does not parse, never a verdict on
     * content that does.
     */
    try {
      return JSON.parse(text) as unknown;
    } catch {
      /**
       * It did not parse — and now `done_reason` says WHICH failure this is.
       *
       * Both end in unusable content, and they need different fixes: a model that ran out of room
       * wants a larger model, and a model that emitted nonsense wants investigating. Without this
       * branch both surface as "not valid JSON", which is true and sends somebody to debug a model
       * server that is working exactly as configured.
       */
      if (body.done_reason === "length") {
        throw new Error(
          `${what}: the model did not finish within ${maxTokens} tokens — it is probably too small `
          + `for this task, or repeating itself`,
        );
      }
      throw new Error(`${what}: the model's response was not valid JSON`);
    }
  };

  return {
    async classify(input: ClassifierInput): Promise<ClassifierResult> {
      // Screens for authentication material and THROWS before a payload exists. Shared with
      // every other provider — one sink, so there is one thing to get right.
      const userPayload = classifyUserPayload(input);
      return coerceClassifierResult(
        await chat(opts.classifyModel, TAXONOMY_PREFIX, userPayload, CLASSIFY_RESULT_SCHEMA, "classifier", OLLAMA_MAX_TOKENS.classify),
      );
    },

    /**
     * The screening question, on a model running on this machine. The same two constants the API-key
     * provider next door sends, from the same module — so the question a person gets does not depend
     * on where their model runs; a per-provider copy passes its own test while the two hosts answer
     * one sender differently. The five-pile schema goes over as Ollama's `format`, which matters more
     * here than on the hosted path (smaller local models drift further producing JSON alone), and
     * `coerceScreeningResult` is the floor beneath it — an unrecognised label lands at the gate.
     */
    async screen(input: ClassifierInput): Promise<ClassifierResult> {
      const userPayload = classifyUserPayload(input);
      return coerceScreeningResult(
        await chat(opts.classifyModel, SCREENING_PREFIX, userPayload, SCREENING_RESULT_SCHEMA, "screener", OLLAMA_MAX_TOKENS.classify),
      );
    },

    async draft(input: DraftInput): Promise<DraftResult> {
      // Asserts the redaction allow-list and THROWS before a payload exists. Also shared.
      const userPayload = draftUserPayload(input);
      return coerceDraftResult(
        await chat(opts.draftModel, DRAFT_PREFIX, userPayload, DRAFT_RESULT_SCHEMA, "drafter", OLLAMA_MAX_TOKENS.draft),
      );
    },

    /**
     * Ask the server what it has, and check the configured models are among them.
     *
     * A running server with the model not pulled is the single most common way this is set up
     * wrongly, and it is indistinguishable from a working configuration until the first message
     * arrives — which is exactly the discovery this verification exists to move forward, to the
     * moment somebody is still looking at the settings.
     *
     * Free, like the other provider's: listing is not inference.
     */
    async probe(): Promise<ProbeOutcome> {
      let models: string[] = [];
      try {
        const res = await fetchWithDeadline(opts.fetchImpl, `${opts.baseUrl}/api/tags`, {
          method: "GET", redirect: "error",
        }, opts.timeoutMs);
        if (!res.ok) {
          return { ok: false, reason: "bad_response", detail: shortDetail(await res.text()), models: [] };
        }
        const body = (await res.json()) as { models?: Array<{ name?: unknown; model?: unknown }> };
        models = Array.isArray(body.models)
          ? body.models
              .map((m) => (typeof m.name === "string" ? m.name : m.model))
              .filter((n): n is string => typeof n === "string")
          : [];
      } catch (err) {
        return { ok: false, reason: failureOf(err), detail: null, models: [] };
      }

      for (const wanted of new Set([opts.classifyModel, opts.draftModel])) {
        if (!hasInstalledModel(models, wanted)) {
          return {
            ok: false,
            reason: "model_absent",
            detail: `the model server is running and does not have "${wanted}"`,
            models,
          };
        }
      }
      return { ok: true, reason: null, detail: null, models };
    },
  };
}
