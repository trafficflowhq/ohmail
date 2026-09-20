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
  fetchWithDeadline, failureOf, shortDetail, statusFailure,
  type AiKeyTransportOptions, type AiTransport, type ProbeFailure, type ProbeOutcome,
} from "./ai-transport.js";

/**
 * An OpenAI API key you own — the second hosted way a standalone install gets AI. Requests go to
 * OpenAI, billed to the key's account; this app's publisher is not in the path and receives neither
 * key nor content. Identical in kind and shape to the Anthropic provider. {@link OPENAI_BASE} is a
 * LITERAL, the same security decision: a pane naming both a key AND its host would configure key
 * exfiltration, so the provider carrying a stored secret has a fixed destination and the one with a
 * configurable one carries none (an OpenAI-compatible base URL, the most-requested setting here, is
 * served instead by the machine-local provider, whose address IS configurable because no credential
 * travels). `redirect: "error"`. What travels is the shared allow-list's, never a raw body.
 */

/** NOT configurable. See the header. */
export const OPENAI_BASE = "https://api.openai.com";

/**
 * The models a fresh install asks for.
 *
 * The same split the Anthropic defaults make, for the same reason: classification runs once per
 * message and is the cost-dominant call, so it gets the small, cheap model; drafting runs when a
 * person asks for it, so it gets the better one. Both are replaceable from the settings surface,
 * and the verification lists what the key can actually reach so the choice is made from a real
 * list rather than from memory.
 */
export const DEFAULT_OPENAI_MODELS = {
  classify: "gpt-4.1-mini",
  draft: "gpt-4.1",
} as const;

/** Kept as the name this provider's callers have always used. */
export type OpenAiTransportOptions = AiKeyTransportOptions;

/**
 * Models this account can reach that cannot answer a chat request. `GET /v1/models` lists the WHOLE
 * catalogue — embeddings, speech, images, moderation — not just what `/v1/chat/completions` accepts;
 * Anthropic's list is all chat, so copying its probe answered "working" for `text-embedding-3-small`
 * and then every classify failed 400 — a green wrong in the one direction a verification exists to
 * prevent. The API exposes no capability field, so this is a NAME test: narrow, matching families
 * unambiguously not chat models, never a list of the ones that ARE (an allow-list would refuse a
 * valid new model). Two shapes, because some families announce at the START (`text-embedding-3`) and
 * others only at the END (`gpt-4o-transcribe`); `gpt-4o-audio-preview` is NOT here (it serves chat).
 */
export const NOT_CHAT_MODELS = new RegExp([
  // Families named at the front of the id.
  "^(?:text-)?(?:embedding|moderation|omni-moderation|whisper|tts|dall-e|gpt-image|sora|davinci|babbage)\\b",
  // …and the endpoint-only capabilities named at the back of an otherwise chat-looking id.
  "(?:-transcribe|-tts|-realtime(?:-preview)?)(?:-[0-9-]+)?$",
  // Its own endpoint entirely.
  "^computer-use\\b",
].join("|"), "i");

/**
 * The JSON text a chat completion carries.
 *
 * `choices[0].message.content` is the whole of it on this API — there is no content-block array to
 * walk, which is the main structural difference from the Anthropic response. A refusal is a
 * distinct field rather than a status: a model that declines under its own safety policy answers
 * 200 with `content: null` and `refusal` set, and reading that as "no content" would report a
 * deliberate decision as a malformed response.
 */
function extractJsonText(json: unknown, what: string): string {
  const choice = (json as { choices?: Array<{ message?: unknown }> }).choices?.[0];
  const message = choice?.message as { content?: unknown; refusal?: unknown } | undefined;
  if (typeof message?.refusal === "string" && message.refusal !== "") {
    throw new Error(`${what}: the model declined to answer`);
  }
  if (typeof message?.content !== "string" || message.content === "") {
    throw new Error(`${what}: response carried no message content`);
  }
  return message.content;
}

export function openaiTransport(opts: OpenAiTransportOptions): AiTransport {
  const headers = {
    "content-type": "application/json",
    authorization: `Bearer ${opts.apiKey}`,
  };

  /**
   * The response-format envelope, which is where this API differs from the other hosted one.
   *
   * Anthropic takes the schema bare under `output_config.format`; OpenAI wants it named, and wants
   * `strict: true` to get the same guarantee — without it the schema is a hint the model may
   * ignore. The three shared schemas already satisfy what `strict` demands (`additionalProperties:
   * false`, every property listed in `required`), which is why this is an adaptation at the edge
   * and not a second set of schemas. If a future schema stops satisfying it, this call starts
   * failing loudly at verification rather than drifting silently — which is the outcome to want.
   */
  const responseFormat = (name: string, schema: unknown): Record<string, unknown> => ({
    type: "json_schema",
    json_schema: { name, strict: true, schema },
  });

  /**
   * One request to the chat-completions endpoint, and the one place a failure becomes an Error. Two
   * fields are sent, then DROPPED if the model refuses them — the same shape as Anthropic's
   * `thinking` retry, covering a growing split in this vendor's catalogue: reasoning models reject
   * `max_tokens` (in favour of `max_completion_tokens`) and `temperature` at any non-default value.
   * The model is the USER'S choice, so a person typing a reasoning model must not be told their key
   * is broken. The retry is bounded to ONE and conditional on the endpoint naming the field, so an
   * unrelated 400 stays a 400; both fields drop together because the models that refuse one refuse
   * the other, and two conditional retries would be three billable requests for one answer.
   */
  const call = async (body: Record<string, unknown>, what: string): Promise<unknown> => {
    const send = async (payload: Record<string, unknown>): Promise<Response> =>
      fetchWithDeadline(opts.fetchImpl, `${OPENAI_BASE}/v1/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        redirect: "error",
      }, opts.timeoutMs);

    let res = await send(body);
    if (res.status === 400) {
      const refusal = await res.text();
      const budgets = refusal.includes("max_tokens") || refusal.includes("max_completion_tokens");
      const temp = refusal.includes("temperature");
      if (!budgets && !temp) {
        throw new Error(`${what}: the model refused the request (400)`);
      }
      const { max_tokens: budget, temperature: _dropped, ...rest } = body;
      res = await send({ ...rest, max_completion_tokens: budget });
    }
    if (!res.ok) {
      // The status only. An error body from this endpoint quotes the request that produced it,
      // and this request carries an Authorization header — so it is read for the settings surface
      // at verification time and never on this path.
      throw new Error(`${what}: the model endpoint answered ${res.status}`);
    }
    const text = extractJsonText(await res.json(), what);
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new Error(`${what}: the model's response was not valid JSON`);
    }
  };

  /**
   * The message pair every call sends: the shared instruction, then the shared payload.
   *
   * Written once because the three calls differ only in which two constants they name. A per-call
   * copy is how one of the three eventually ships with a payload built beside the shared sink
   * instead of by it.
   */
  const turns = (system: string, payload: unknown): Array<Record<string, string>> => [
    { role: "system", content: system },
    { role: "user", content: JSON.stringify(payload) },
  ];

  return {
    async classify(input: ClassifierInput): Promise<ClassifierResult> {
      // Screens for authentication material and THROWS before a payload exists. Shared with every
      // other provider, deliberately: one sink, so there is one thing to get right.
      const userPayload = classifyUserPayload(input);
      const raw = await call({
        model: opts.classifyModel,
        max_tokens: 512,
        // Deterministic on purpose: routing the same message twice must not produce two different
        // folders. The same choice the machine-local provider makes, for the same reason.
        temperature: 0,
        messages: turns(TAXONOMY_PREFIX, userPayload),
        response_format: responseFormat("routing", CLASSIFY_RESULT_SCHEMA),
      }, "classifier");
      return coerceClassifierResult(raw);
    },

    /**
     * The screening question — the same transport, the same sink, a different question. Everything
     * that differs from {@link classify} is a constant imported from `@trafficflow/core/mail` (the
     * instruction and the answer set); nothing about the question is written here, because three ways
     * to reach a model is three chances for a second copy to give one sender two different answers,
     * each passing its own test. The CLASSIFY model answers it, matching both other providers — one
     * call per first-contact sender, same size and difficulty, so a model chosen for routing is
     * chosen for this.
     */
    async screen(input: ClassifierInput): Promise<ClassifierResult> {
      const userPayload = classifyUserPayload(input);
      const raw = await call({
        model: opts.classifyModel,
        max_tokens: 512,
        temperature: 0,
        messages: turns(SCREENING_PREFIX, userPayload),
        response_format: responseFormat("screening", SCREENING_RESULT_SCHEMA),
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
        temperature: 0,
        messages: turns(DRAFT_PREFIX, userPayload),
        response_format: responseFormat("reply_draft", DRAFT_RESULT_SCHEMA),
      }, "drafter");
      return coerceDraftResult(raw);
    },

    /**
     * Verify the key and the two models WITHOUT running inference. Listing models authenticates (a
     * wrong, revoked or empty key is a 401 here) and asking for each configured model by name is
     * exact, which a list is not — a key with limited model access lists what it can see, and the
     * typed name either resolves for that key or does not. Deliberately free, like both other
     * providers': a verification that ran a real completion would spend the account holder's money
     * every time they pressed Save.
     */
    async probe(): Promise<ProbeOutcome> {
      let models: string[] = [];
      try {
        const res = await fetchWithDeadline(opts.fetchImpl, `${OPENAI_BASE}/v1/models`, {
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
          ? body.data
              .map((m) => m.id)
              .filter((id): id is string => typeof id === "string")
              // The picker offers what could actually answer. See NOT_CHAT_MODELS.
              .filter((id) => !NOT_CHAT_MODELS.test(id))
          : [];
      } catch (err) {
        return { ok: false, reason: failureOf(err), detail: null, models: [] };
      }

      for (const model of new Set([opts.classifyModel, opts.draftModel])) {
        // Checked BEFORE the round trip: this one is answerable from the name alone, and a
        // request that would succeed and still leave the model unusable is worth not making.
        if (NOT_CHAT_MODELS.test(model)) {
          return {
            ok: false,
            reason: "model_absent",
            detail: `"${model}" is not a chat model, so it cannot answer suggestions or drafts`,
            models,
          };
        }
        try {
          const res = await fetchWithDeadline(
            opts.fetchImpl,
            `${OPENAI_BASE}/v1/models/${encodeURIComponent(model)}`,
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
