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
 * AN OPENAI API KEY YOU OWN — the second hosted way a standalone install gets AI.
 *
 * Requests go to OpenAI, billed to the account the key belongs to. This app's publisher is not in
 * the path: it operates no proxy for this, sees none of these requests, and receives neither the
 * key nor the message content. Identical in kind to the Anthropic provider next door, and
 * deliberately identical in SHAPE — the differences below are all at the wire, and none of them
 * reach the question being asked.
 *
 * ── THE ENDPOINT IS NOT CONFIGURABLE, AND THAT IS THE SAME SECURITY DECISION ────────────────
 *
 * {@link OPENAI_BASE} is a literal, for the reason `ai-anthropic.ts` states at length: a settings
 * pane that let you name both a key AND the host it is sent to would be a supported way to
 * configure key exfiltration. The rule this package holds to is that **the provider carrying a
 * stored secret has a fixed destination, and the provider with a configurable destination (a
 * model on your own machine) carries no secret. Neither one is ever both.** Adding a third
 * provider is exactly the moment that rule is most likely to be broken for convenience — an
 * OpenAI-compatible base URL is the single most requested setting in this class of app — so it is
 * written down here rather than assumed.
 *
 * That request is not unreasonable, and it is not refused for being unreasonable: it is refused
 * because THIS provider holds a key. Somebody who wants to point this install at an
 * OpenAI-compatible server they run can already do it through the machine-local provider, whose
 * address IS configurable precisely because no credential travels with it.
 *
 * `redirect: "error"` one level down, for the same reason: a 302 is a destination somebody else
 * chose, and this request carries an `Authorization` header.
 *
 * ── WHAT TRAVELS ───────────────────────────────────────────────────────────────────────────
 *
 * The sender, the subject and a short redacted snippet for a routing suggestion; the same plus the
 * thread's other snippets and knowledge-base entries you wrote, for a draft. Never a raw message
 * body — the shared allow-list in `@trafficflow/core/mail` refuses one before a request is built.
 * Mail carrying authentication material is refused outright by the same shared sink and is never
 * sent to any model, under any provider. Nothing on this path is a second copy of that rule.
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

export interface OpenAiTransportOptions {
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
   * One request to the chat-completions endpoint, and the one place a failure becomes an Error.
   *
   * ── TWO FIELDS ARE SENT, THEN DROPPED IF THE MODEL REFUSES THEM ───────────────────────────
   *
   * The same shape as the Anthropic transport's `thinking` retry, and here it covers a real and
   * growing split in this vendor's own catalogue. The reasoning models reject two things the rest
   * of the range requires:
   *
   *  · **`max_tokens`** is refused in favour of `max_completion_tokens`.
   *  · **`temperature`** is refused at any value other than the default.
   *
   * The model is the USER'S choice here, not ours — the hosted deployment can simply pick one and
   * pin the fields to it — so a person who types a reasoning model into the settings must not be
   * told their key is broken. That is a fact about the chosen model, not a fault.
   *
   * The retry is bounded to exactly ONE and is conditional on the endpoint naming the offending
   * field in its own refusal, so an unrelated 400 stays a 400 and is not retried into a second
   * charge. Both fields are dropped together on that one retry rather than probed separately: two
   * conditional retries would be up to three billable requests for one answer, and the models that
   * refuse one of these fields are the models that refuse the other.
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
     * THE SCREENING QUESTION — the same transport, the same sink, a different question.
     *
     * Everything that differs from {@link classify} is a constant imported from
     * `@trafficflow/core/mail`: the instruction and the answer set. Nothing about the question is
     * written here, and that is the point rather than a convenience — three ways to reach a model
     * is three chances for a second copy of a question to give one sender two different answers,
     * and each copy would pass its own test.
     *
     * The CLASSIFY model answers it, matching both other providers: the two questions are one call
     * per first-contact sender each, of the same size and difficulty, so a person who chose a model
     * for routing has chosen it for this.
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
     * Verify the key and the two models WITHOUT running inference.
     *
     * Listing models authenticates — a wrong, revoked or empty key is a 401 here — and asking for
     * each configured model by name is exact, which a list is not: a key with limited model access
     * lists what it can see, and the name a person typed either resolves for that key or does not.
     *
     * Deliberately free, like both other providers'. A verification that ran a real completion
     * would spend the account holder's money every time they pressed Save, which is a settings pane
     * charging for being opened.
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
          ? body.data.map((m) => m.id).filter((id): id is string => typeof id === "string")
          : [];
      } catch (err) {
        return { ok: false, reason: failureOf(err), detail: null, models: [] };
      }

      for (const model of new Set([opts.classifyModel, opts.draftModel])) {
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
