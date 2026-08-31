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

/**
 * A MODEL RUNNING ON THIS MACHINE — the second way a standalone install gets AI.
 *
 * Ollama serves models over plain HTTP on the machine it runs on. Message content goes to that
 * address and no further: no account, no API key, no third party, and nothing that leaves the
 * machine unless the address names another one.
 *
 * ── THE ADDRESS IS CONFIGURABLE HERE, AND THAT IS SAFE BECAUSE NO SECRET TRAVELS ────────────
 *
 * The mirror image of the API-key provider next door, and the pairing is deliberate: that one
 * carries a stored credential and therefore has a fixed destination; this one has a
 * configurable destination and therefore carries no credential. A configurable destination
 * WITH a stored credential would be a supported way to redirect a live key, so neither provider
 * is ever both.
 *
 * The address is still narrowed to an http(s) origin when it is saved, and requests refuse to
 * follow redirects — a model server that answers with a 302 is not a model server.
 *
 * ── STRUCTURED OUTPUT, NOT PROSE PARSING ────────────────────────────────────────────────────
 *
 * Both calls pass the shared response schema as Ollama's `format`, so the answer is constrained
 * to the same object the hosted path constrains it to. Smaller local models drift much further
 * than large hosted ones when asked to produce JSON by instruction alone, and the coercion in
 * `@trafficflow/core/mail` is a floor rather than a substitute: an unrecognised routing label
 * lands at the Screener, where a person decides, and never auto-files.
 */

/** Where a default install of Ollama listens, and the models a fresh configuration asks for. */
export const DEFAULT_OLLAMA = {
  baseUrl: "http://127.0.0.1:11434",
  classifyModel: "llama3.2",
  draftModel: "llama3.2",
} as const;

/**
 * HOW MANY TOKENS A LOCAL ANSWER MAY RUN TO, and why the absence of this was a hang.
 *
 * The two hosted providers bound their own answers (`max_tokens`: 512 for a routing or screening
 * verdict, 2048 for a draft). This one sent no bound at all, and Ollama's default is to generate
 * until the context window is exhausted — so the ceiling was the client deadline rather than a
 * number anybody chose.
 *
 * That is not a theoretical gap. Measured against a real daemon: `qwen2.5:0.5b`, greedy-decoded
 * under the drafting schema, fell into a repetition loop — `"Are you free Thursday? - Re: Are you
 * free Thursday? - …"` — and never emitted a stopping token. Unbounded it ran past 45 s and past
 * 300 s; bounded at 2048 it stopped in 21 s with `done_reason: "length"`. Small models drift this
 * way far more readily than large ones, and this is the provider whose models are small by
 * definition, on hardware whose owner is paying for the electricity.
 *
 * The numbers deliberately MATCH the hosted providers' rather than being tuned for local models:
 * the same question deserves the same room to answer it, and a budget that differed per provider
 * would be a second thing that makes one install answer differently from another.
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

/**
 * Does the server have this model?
 *
 * Ollama names a model `family:tag` and reports the fully-qualified name, while a person types
 * the family alone far more often than not. `llama3.2` therefore has to match `llama3.2:latest`,
 * and it must NOT match `llama3.2-vision:latest` — so the comparison is on the family segment
 * and the tag, never a prefix.
 */
export function ollamaHasModel(installed: readonly string[], wanted: string): boolean {
  const [wantFamily, wantTag] = wanted.split(":", 2);
  return installed.some((name) => {
    const [family, tag] = name.split(":", 2);
    if (family !== wantFamily) return false;
    return wantTag === undefined ? true : tag === wantTag;
  });
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
     * A TRUNCATED ANSWER IS NAMED, not left to fail as malformed JSON.
     *
     * Hitting the ceiling leaves the content cut mid-string, so `JSON.parse` below would throw and
     * report "not valid JSON" — true, and the wrong diagnosis. It sends somebody looking for a
     * broken model server when what actually happened is that their model would not stop talking,
     * which is a different problem with a different fix (use a larger model). The distinction is
     * only visible here, where `done_reason` is still in hand.
     */
    if (body.done_reason === "length") {
      throw new Error(
        `${what}: the model did not finish within ${maxTokens} tokens — it is probably too small `
        + `for this task, or repeating itself`,
      );
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
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
     * THE SCREENING QUESTION, on a model running on this machine.
     *
     * The same two constants the API-key provider next door sends, from the same module — so the
     * question a person gets does not depend on where their model happens to run. That is the whole
     * claim of a shared prompt, and it is the one a per-provider copy would quietly break: each
     * copy passes its own test while the two hosts answer one sender differently.
     *
     * The five-pile schema goes over as Ollama's `format`, which matters more here than it does on
     * the hosted path: smaller local models drift much further when asked to produce JSON by
     * instruction alone. `coerceScreeningResult` is still the floor beneath it — an unrecognised
     * label lands at the gate, where a person decides, and never auto-files.
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
        if (!ollamaHasModel(models, wanted)) {
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
