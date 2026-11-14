import { describe, it, expect } from "vitest";
import { FIXTURE_SHAPES, anthropicKey, stripeTestKey } from "../../../test/support/fixture-credentials.js";
import {
  makeAnthropicClient, assertAnthropicKey, estimateCostMicroUsd,
  AnthropicApiError, AnthropicTransportError,
  ANTHROPIC_API_VERSION, MODEL_PRICES_USD_PER_MTOK,
  buildClassifyParams, makeHaikuClassifier, makeSonnetDrafter, makeOpusProposer,
  type AnthropicCallReport,
} from "../src/index.js";
import { askScreeningQuestion } from "../src/mail.js";
import * as mailLeaf from "../src/mail.js";
import {
  MODEL_REQUEST_RULES, ModelRuleRefusal, knownRequestRules, requestRulesFor, thinkingOffFor,
} from "../src/model-rules.js";
import { BILLED_REFUSAL_CATEGORIES, unbilledRefusal } from "../src/ai/anthropic-client.js";
import { ModelDeclinedError } from "../src/model-declined.js";
import { createLogger } from "../src/log.js";

/**
 * The live model client. Every case injects `fetchImpl`, so this file — like the whole
 * default suite — makes NO network call. The one thing it cannot prove offline is that the API
 * accepts the request shape; that is what the live production smoke is for.
 */

const KEY = anthropicKey("anthropic-client");

it("the fixture keys have the vendors' key shapes", () => {
  expect(KEY).toMatch(FIXTURE_SHAPES.anthropic);
  expect(stripeTestKey("anthropic-client-wrong-row")).toMatch(FIXTURE_SHAPES.stripeTest);
});

interface Call { url: string; init: RequestInit }

/**
 * A `fetch` that replays canned responses in order and records what it was asked.
 *
 * Each entry is a FACTORY, not a `Response`: a body can only be read once, so replaying one
 * `Response` object across retries hands the second attempt an empty body — which silently
 * turns "the error type survived three attempts" into "the error type was null" and makes the
 * test agree with a bug it should catch.
 */
function fakeFetch(responses: Array<() => Response>): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  let i = 0;
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses[Math.min(i, responses.length - 1)];
    i++;
    return next();
  }) as unknown as typeof fetch;
  return { fetch: fn, calls };
}

function ok(body: unknown, headers: Record<string, string> = {}): () => Response {
  return () => new Response(JSON.stringify(body), { status: 200, headers });
}
function fail(status: number, body: unknown, headers: Record<string, string> = {}): () => Response {
  return () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers });
}

/** The usage block the real API returned for a real classify call (recorded 2026-07-31). */
const REAL_CLASSIFY_USAGE = {
  input_tokens: 516, cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
  output_tokens: 50, service_tier: "standard",
};

const noSleep = { sleep: async () => {}, random: () => 0.5 };

describe("makeAnthropicClient — the request it actually sends", () => {
  it("POSTs /v1/messages with the api key, the pinned version, and the params verbatim", async () => {
    const { fetch, calls } = fakeFetch([ok({ content: [{ type: "text", text: "{}" }], usage: REAL_CLASSIFY_USAGE })]);
    const client = makeAnthropicClient({ apiKey: KEY, fetchImpl: fetch, ...noSleep });

    await client.messages.create({ model: "claude-haiku-4-5-20251001", max_tokens: 512, messages: [] });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.anthropic.com/v1/messages");
    expect(calls[0].init.method).toBe("POST");
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe(KEY);
    expect(headers["anthropic-version"]).toBe(ANTHROPIC_API_VERSION);
    expect(headers["content-type"]).toBe("application/json");
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      model: "claude-haiku-4-5-20251001", max_tokens: 512, messages: [],
    });
  });

  it("returns `{content, usage}` — the shape `AnthropicLike` promises the ports", async () => {
    const { fetch } = fakeFetch([ok({
      model: "claude-haiku-4-5-20251001",
      content: [{ type: "text", text: '{"ok":true}' }],
      usage: REAL_CLASSIFY_USAGE,
    })]);
    const client = makeAnthropicClient({ apiKey: KEY, fetchImpl: fetch, ...noSleep });

    const resp = await client.messages.create({ model: "claude-haiku-4-5-20251001" });

    expect(resp.content).toEqual([{ type: "text", text: '{"ok":true}' }]);
    expect(resp.usage).toEqual(REAL_CLASSIFY_USAGE);
  });

  it("drives the REAL classifier end to end — the seam is satisfied, not merely shaped like it", async () => {
    const { fetch, calls } = fakeFetch([ok({
      model: "claude-haiku-4-5-20251001",
      content: [{ type: "text", text: JSON.stringify({
        destination: "ohmail/News", confidence: 0.95, rationale: "bulk newsletter", spam: false,
      }) }],
      usage: REAL_CLASSIFY_USAGE,
    })]);
    const client = makeAnthropicClient({ apiKey: KEY, fetchImpl: fetch, ...noSleep });
    const classifier = makeHaikuClassifier({ client });

    const result = await classifier.classify({
      from: { address: "news@example.com", name: "News" },
      subject: "Weekly digest", snippet: "top stories", headersDigest: "precedence:bulk",
    });

    expect(result).toEqual({
      destination: "ohmail/News", confidence: 0.95, rationale: "bulk newsletter", spam: false,
    });
    // The body is exactly what `buildClassifyParams` produces — no shim-side rewriting.
    expect(JSON.parse(calls[0].init.body as string)).toEqual(buildClassifyParams({
      from: { address: "news@example.com", name: "News" },
      subject: "Weekly digest", snippet: "top stories", headersDigest: "precedence:bulk",
    }, { client }));
  });
});

describe("makeAnthropicClient — failure, retry, and what never leaks", () => {
  it("retries a 529 and succeeds, reporting the attempt count", async () => {
    const reports: AnthropicCallReport[] = [];
    const { fetch, calls } = fakeFetch([
      fail(529, { error: { type: "overloaded_error", message: "Overloaded" } }),
      ok({ model: "claude-haiku-4-5-20251001", content: [], usage: REAL_CLASSIFY_USAGE }),
    ]);
    const client = makeAnthropicClient({
      apiKey: KEY, fetchImpl: fetch, ...noSleep, onUsage: (r) => reports.push(r),
    });

    await client.messages.create({ model: "claude-haiku-4-5-20251001" });

    expect(calls).toHaveLength(2);
    expect(reports).toHaveLength(1);
    expect(reports[0].ok).toBe(true);
    expect(reports[0].attempts).toBe(2);
  });

  it("does NOT retry a 400 — a bad request is our bug, and retrying it just spends latency", async () => {
    const { fetch, calls } = fakeFetch([fail(400, { error: { type: "invalid_request_error", message: "bad" } })]);
    const client = makeAnthropicClient({ apiKey: KEY, fetchImpl: fetch, ...noSleep });

    await expect(client.messages.create({ model: "m" })).rejects.toBeInstanceOf(AnthropicApiError);
    expect(calls).toHaveLength(1);
  });

  it("gives up after maxRetries and throws an AnthropicApiError carrying status + type + request id", async () => {
    const { fetch, calls } = fakeFetch([
      fail(500, { error: { type: "api_error", message: "boom" } }, { "request-id": "req_123" }),
    ]);
    const client = makeAnthropicClient({ apiKey: KEY, fetchImpl: fetch, maxRetries: 2, ...noSleep });

    const err = await client.messages.create({ model: "m" }).catch((e: unknown) => e);

    expect(calls).toHaveLength(3);                       // 1 attempt + 2 retries
    expect(err).toBeInstanceOf(AnthropicApiError);
    expect((err as AnthropicApiError).status).toBe(500);
    expect((err as AnthropicApiError).errorType).toBe("api_error");
    expect((err as AnthropicApiError).requestId).toBe("req_123");
  });

  it("honours `retry-after`, and caps it — a 20-minute sleep inside a sync cycle IS the outage", async () => {
    const waits: number[] = [];
    const { fetch } = fakeFetch([
      fail(429, { error: { type: "rate_limit_error" } }, { "retry-after": "3" }),
      fail(429, { error: { type: "rate_limit_error" } }, { "retry-after": "99999" }),
      ok({ content: [], usage: {} }),
    ]);
    const client = makeAnthropicClient({
      apiKey: KEY, fetchImpl: fetch, maxRetries: 3, random: () => 0.5,
      sleep: async (ms) => { waits.push(ms); },
    });

    await client.messages.create({ model: "m" });

    expect(waits[0]).toBe(3_000);
    expect(waits[1]).toBe(20_000);
  });

  /**
   * THE CALLER'S DEADLINE BINDS THE WAITS TOO (DRAFTING-ROUTE-HAS-NO-ADMISSION-ARITHMETIC). A
   * per-attempt timeout plus a 20 s `retry-after` outlived the drafting request's function; with
   * a signal, the wait ends when it fires and no further attempt starts.
   */
  it("a caller's signal ends the wait before a retry, and no second attempt starts", async () => {
    const { fetch, calls } = fakeFetch([
      fail(429, { error: { type: "rate_limit_error" } }, { "retry-after": "20" }),
      ok({ content: [], usage: {} }),
    ]);
    const client = makeAnthropicClient({
      apiKey: KEY, fetchImpl: fetch, maxRetries: 1, random: () => 0.5,
      // The 20 s wait, never finishing by itself: only the signal can end it.
      sleep: () => new Promise<void>(() => { /* waits for ever */ }),
    });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 30);
    const err = await client.messages.create({ model: "m" }, { signal: ac.signal }).catch((e: unknown) => e);
    expect(err, "the call gave up with the provider's own refusal").toBeInstanceOf(AnthropicApiError);
    expect(calls, "no attempt after the deadline").toHaveLength(1);
  });

  it("the caller's signal reaches the fetch, and an aborted one starts no attempt", async () => {
    const seen: (AbortSignal | null | undefined)[] = [];
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      seen.push(init?.signal);
      return new Response(JSON.stringify({ content: [], usage: {} }), { status: 200 });
    }) as unknown as typeof fetch;
    const client = makeAnthropicClient({ apiKey: KEY, fetchImpl, ...noSleep });
    const ac = new AbortController();
    await client.messages.create({ model: "m" }, { signal: ac.signal });
    ac.abort();
    expect(seen[0]?.aborted, "the fetch's signal follows the caller's").toBe(true);
    const err = await client.messages.create({ model: "m" }, { signal: ac.signal }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AnthropicTransportError);
    expect(seen, "nothing was sent after the deadline").toHaveLength(1);
  });

  it("wraps a transport failure and retries it", async () => {
    const boom = (): Response => { throw new TypeError("fetch failed"); };
    const { fetch, calls } = fakeFetch([boom, boom, boom]);
    const client = makeAnthropicClient({ apiKey: KEY, fetchImpl: fetch, maxRetries: 2, ...noSleep });

    const err = await client.messages.create({ model: "m" }).catch((e: unknown) => e);

    expect(calls).toHaveLength(3);
    expect(err).toBeInstanceOf(AnthropicTransportError);
  });

  it("NEVER puts the api key in an error message, even when the API echoes it back", async () => {
    const { fetch } = fakeFetch([
      fail(401, { error: { type: "authentication_error", message: `invalid key: ${KEY}` } }),
    ]);
    const client = makeAnthropicClient({ apiKey: KEY, fetchImpl: fetch, ...noSleep });

    const err = await client.messages.create({ model: "m" }).catch((e: unknown) => e);

    expect((err as Error).message).not.toContain(KEY);
    expect((err as Error).message).toContain("[REDACTED]");
  });

  it("a reporter that THROWS does not become the outcome of a successful call", async () => {
    const { fetch } = fakeFetch([ok({ content: [{ type: "text", text: "x" }], usage: REAL_CLASSIFY_USAGE })]);
    const client = makeAnthropicClient({
      apiKey: KEY, fetchImpl: fetch, ...noSleep,
      onUsage: () => { throw new Error("EPIPE"); },
    });

    await expect(client.messages.create({ model: "m" })).resolves.toBeTruthy();
  });
});

describe("usage reporting — DEFERRED #49, the per-action cost record", () => {
  it("reports the real token counts a real classify call produced", async () => {
    const reports: AnthropicCallReport[] = [];
    const { fetch } = fakeFetch([ok({
      model: "claude-haiku-4-5-20251001", content: [], usage: REAL_CLASSIFY_USAGE,
    }, { "request-id": "req_abc" })]);
    const client = makeAnthropicClient({
      apiKey: KEY, fetchImpl: fetch, ...noSleep, onUsage: (r) => reports.push(r),
    });

    await client.messages.create({ model: "claude-haiku-4-5-20251001" });

    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      model: "claude-haiku-4-5-20251001", ok: true, status: 200, attempts: 1,
      requestId: "req_abc", inputTokens: 516, outputTokens: 50,
      cacheReadTokens: 0, cacheWriteTokens: 0,
    });
    // 516 in @ $1/MTok + 50 out @ $5/MTok = 766 micro-dollars = $0.000766.
    expect(reports[0].costMicroUsd).toBe(766);
  });

  it("surfaces `thinking_tokens` — the number that says whether max_tokens is about to truncate", async () => {
    const reports: AnthropicCallReport[] = [];
    const { fetch } = fakeFetch([ok({
      model: "claude-sonnet-5", content: [],
      usage: { input_tokens: 1046, output_tokens: 798, output_tokens_details: { thinking_tokens: 259 } },
    })]);
    const client = makeAnthropicClient({
      apiKey: KEY, fetchImpl: fetch, ...noSleep, onUsage: (r) => reports.push(r),
    });

    await client.messages.create({ model: "claude-sonnet-5" });

    expect(reports[0].thinkingTokens).toBe(259);
    // 1046 @ $2 + 798 @ $10 = 2092 + 7980 = 10072 micro-dollars ⇒ $0.0101 per draft.
    expect(reports[0].costMicroUsd).toBe(10_072);
  });

  it("reports a FAILED call too, with null token counts — an outage is a cost signal as well", async () => {
    const reports: AnthropicCallReport[] = [];
    const { fetch } = fakeFetch([fail(503, { error: { type: "overloaded_error" } })]);
    const client = makeAnthropicClient({
      apiKey: KEY, fetchImpl: fetch, maxRetries: 0, ...noSleep, onUsage: (r) => reports.push(r),
    });

    await client.messages.create({ model: "claude-opus-5" }).catch(() => undefined);

    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      model: "claude-opus-5", ok: false, status: 503,
      inputTokens: null, outputTokens: null, costMicroUsd: null,
    });
  });

  it("answers `null` rather than a wrong number for a model it has no price for", () => {
    expect(estimateCostMicroUsd("claude-not-a-model", { inputTokens: 1000, outputTokens: 1000 })).toBeNull();
  });

  /**
   * A CACHE HIT IS THE MODEL'S OWN RATE. One MTok of cache-read tokens, against the published
   * per-MTok cache-hit prices: Haiku 4.5 $0.10, Haiku 5.5 $0.01, Sonnet 5 $0.20, Sonnet 5.5
   * $0.10 and Opus 5.5 $0.20 — the last two are 0.05x input, where one global 0.1x read them
   * at twice the price. A write is 1.25x input on every row.
   */
  it("prices a cache hit at the model's own rate and a cache write at 1.25x", () => {
    expect(estimateCostMicroUsd("claude-haiku-4-5", { cacheReadTokens: 1_000_000 })).toBe(100_000);
    expect(estimateCostMicroUsd("claude-haiku-5-5", { cacheReadTokens: 1_000_000 })).toBe(10_000);
    expect(estimateCostMicroUsd("claude-sonnet-5", { cacheReadTokens: 1_000_000 })).toBe(200_000);
    expect(estimateCostMicroUsd("claude-sonnet-5-5", { cacheReadTokens: 1_000_000 })).toBe(100_000);
    expect(estimateCostMicroUsd("claude-opus-5-5", { cacheReadTokens: 1_000_000 })).toBe(200_000);
    expect(estimateCostMicroUsd("claude-haiku-4-5", { cacheWriteTokens: 1_000_000 })).toBe(1_250_000);
    expect(estimateCostMicroUsd("claude-opus-5-5", { cacheWriteTokens: 1_000_000 })).toBe(5_000_000);
  });

  /** Usage the API returned on 2026-10-12: a Haiku 5.5 classify reading its cached prefix, an Opus 5.5 proposal writing it. */
  it("prices two recorded 5.5 calls by their rows", () => {
    // 134 in @ $0.10 + 803 cache read @ $0.01 + 80 out @ $0.50 = 13.4 + 8.03 + 40 = 61.43 ⇒ 61.
    expect(estimateCostMicroUsd("claude-haiku-5-5",
      { inputTokens: 134, cacheReadTokens: 803, cacheWriteTokens: 0, outputTokens: 80 })).toBe(61);
    // Input at its rate + cache write at its rate + output at its rate, summed in micro-dollars.
    expect(estimateCostMicroUsd("claude-opus-5-5",
      { inputTokens: 1302, cacheReadTokens: 0, cacheWriteTokens: 1019, outputTokens: 489 })).toBe(20_083);
  });

  /**
   * THE WHOLE TABLE, BY LITERAL. The defaults are the three 5.5 rows; the older rows stay so an
   * override still prices. The billing program keeps a twin of this table pinned to this literal,
   * so a row moved here is a row owed there in the same release.
   */
  it("prices every model a port can call, by literal", () => {
    expect(MODEL_PRICES_USD_PER_MTOK).toEqual({
      "claude-haiku-4-5": { input: 1, output: 5, cacheReadMultiplier: 0.1 },
      "claude-haiku-4-5-20251001": { input: 1, output: 5, cacheReadMultiplier: 0.1 },
      "claude-sonnet-5": { input: 2, output: 10, cacheReadMultiplier: 0.1 },
      "claude-opus-5": { input: 5, output: 25, cacheReadMultiplier: 0.1 },
      "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheReadMultiplier: 0.1 },
      "claude-sonnet-5-5": { input: 2, output: 10, cacheReadMultiplier: 0.05 },
      "claude-opus-5-5": { input: 4, output: 20, cacheReadMultiplier: 0.05 },
    });
  });

  it("the price table and the request rules name the same models", () => {
    expect(Object.keys(MODEL_PRICES_USD_PER_MTOK).sort()).toEqual(Object.keys(MODEL_REQUEST_RULES).sort());
  });
});

describe("the request rules — one row per model, a refusal by name for anything else", () => {
  it("answers each default's own thinking-off value and effort rule", () => {
    expect(thinkingOffFor("claude-haiku-5-5")).toEqual({ type: "disabled" });
    expect(thinkingOffFor("claude-sonnet-5-5")).toEqual({ type: "between_tools" });
    expect(requestRulesFor("claude-opus-5-5")).toEqual({ thinkingOff: null, effort: true });
    expect(requestRulesFor("claude-haiku-4-5-20251001").effort).toBe(false);
  });

  it("refuses an id with no row — a prototype key included — and a model that cannot turn thinking off", () => {
    for (const model of ["claude-not-a-model", "constructor", "toString", "__proto__"]) {
      let thrown: unknown;
      try { requestRulesFor(model); } catch (e) { thrown = e; }
      expect(thrown, model).toBeInstanceOf(ModelRuleRefusal);
      expect((thrown as ModelRuleRefusal).reason).toBe("no_rules");
    }
    expect(() => thinkingOffFor("claude-opus-5-5")).toThrow(/cannot turn thinking off/);
  });

  it("hands out a copy, so a request that edits its thinking field cannot edit the table", () => {
    const off = thinkingOffFor("claude-haiku-5-5") as { type: string };
    off.type = "adaptive";
    expect(thinkingOffFor("claude-haiku-5-5")).toEqual({ type: "disabled" });
  });

  it("the own-key lookup answers the row or null — a prototype key is null, never a row", () => {
    expect(knownRequestRules("claude-sonnet-5-5")).toBe(MODEL_REQUEST_RULES["claude-sonnet-5-5"]);
    for (const model of ["claude-not-a-model", "constructor", "toString", "__proto__"]) {
      expect(knownRequestRules(model), model).toBeNull();
    }
  });

  it("the mail leaf hands out the same table and lookup the hosted builders read", () => {
    expect(mailLeaf.MODEL_REQUEST_RULES).toBe(MODEL_REQUEST_RULES);
    expect(mailLeaf.knownRequestRules).toBe(knownRequestRules);
  });
});

describe("the per-call usage hook — one call's report, handed to that call's caller", () => {
  /** Records the ORDER the two hooks saw the report in, and whether it was the same object. */
  function ordered(): { seen: string[]; objects: AnthropicCallReport[]; own: (r: AnthropicCallReport) => void;
    process: (r: AnthropicCallReport) => void } {
    const seen: string[] = [];
    const objects: AnthropicCallReport[] = [];
    return {
      seen, objects,
      own: (r) => { seen.push("own"); objects.push(r); },
      process: (r) => { seen.push("process"); objects.push(r); },
    };
  }

  it("fires the call's own hook BEFORE the process reporter, on the SAME object (success)", async () => {
    const h = ordered();
    const { fetch } = fakeFetch([ok({ model: "claude-haiku-4-5-20251001", content: [], usage: REAL_CLASSIFY_USAGE })]);
    const client = makeAnthropicClient({ apiKey: KEY, fetchImpl: fetch, ...noSleep, onUsage: h.process });
    await client.messages.create({ model: "claude-haiku-4-5-20251001" }, { onUsage: h.own });
    expect(h.seen).toEqual(["own", "process"]);
    expect(h.objects[0]).toBe(h.objects[1]);
  });

  it("fires in the same order on a FAILED call, whose report carries null tokens", async () => {
    const h = ordered();
    const { fetch } = fakeFetch([fail(503, { error: { type: "overloaded_error" } })]);
    const client = makeAnthropicClient({
      apiKey: KEY, fetchImpl: fetch, maxRetries: 0, ...noSleep, onUsage: h.process,
    });
    await client.messages.create({ model: "claude-opus-5" }, { onUsage: h.own }).catch(() => undefined);
    expect(h.seen).toEqual(["own", "process"]);
    expect(h.objects[0]).toBe(h.objects[1]);
    expect(h.objects[0]).toMatchObject({ ok: false, inputTokens: null, outputTokens: null });
  });

  it("a hook that throws is not the outcome, and the process reporter still runs", async () => {
    const seen: string[] = [];
    const { fetch } = fakeFetch([ok({ content: [], usage: REAL_CLASSIFY_USAGE })]);
    const client = makeAnthropicClient({
      apiKey: KEY, fetchImpl: fetch, ...noSleep, onUsage: () => { seen.push("process"); },
    });
    const res = await client.messages.create({ model: "claude-haiku-4-5" }, {
      onUsage: () => { throw new Error("hook failed"); },
    });
    expect(res.content).toEqual([]);
    expect(seen).toEqual(["process"]);
  });

  it("the report names no account and no action: exactly its thirteen fields", async () => {
    // Attribution stays with the caller that holds the closure; a field added here would put it
    // inside the AI package. `stopReason` is the answer's own word, not an attribution.
    let got: AnthropicCallReport | undefined;
    const { fetch } = fakeFetch([ok({ content: [], usage: REAL_CLASSIFY_USAGE })]);
    const client = makeAnthropicClient({ apiKey: KEY, fetchImpl: fetch, ...noSleep, onUsage: () => {} });
    await client.messages.create({ model: "claude-haiku-4-5" }, { onUsage: (r) => { got = r; } });
    expect(Object.keys(got!).sort()).toEqual([
      "attempts", "cacheReadTokens", "cacheWriteTokens", "costMicroUsd", "inputTokens", "latencyMs",
      "model", "ok", "outputTokens", "requestId", "status", "stopReason", "thinkingTokens",
    ]);
  });

  it("reaches the hook from every factory: classify, screen, askScreeningQuestion, draft, propose", async () => {
    const answer = (text: string) => ok({ model: "m", content: [{ type: "text", text }], usage: REAL_CLASSIFY_USAGE });
    const verdict = JSON.stringify({ destination: "ohmail/News", confidence: 0.9, rationale: "r", spam: false });
    const screening = JSON.stringify({ destination: "ohmail/Ohbox", confidence: 0.9, rationale: "r", spam: false });
    const draft = JSON.stringify({ subject: "s", body: "b", rationale: "r" });
    const proposals = JSON.stringify({ proposals: [] });
    const { fetch } = fakeFetch([answer(verdict), answer(screening), answer(screening), answer(draft), answer(proposals)]);
    const client = makeAnthropicClient({ apiKey: KEY, fetchImpl: fetch, ...noSleep, onUsage: () => {} });
    const hits: string[] = [];
    const hook = (name: string) => ({ onUsage: () => { hits.push(name); } });
    const classifier = makeHaikuClassifier({ client });
    const input = {
      from: { address: "news@example.com", name: null }, subject: "Weekly", snippet: "top stories",
      headersDigest: "", outbound: "prescreened" as const,
    };
    await classifier.classify(input, hook("classify"));
    await classifier.screen!(input, hook("screen"));
    await askScreeningQuestion(classifier, { fromAddress: "a@b.example", subject: "Hi", snippet: "hello" }, {
      ...hook("ask"), beforeDispatch: async () => undefined,
    });
    await makeSonnetDrafter(client).draft({
      incoming: { subject: "q", from: "c@acme.example", snippet: "s" },
      context: { kbEntries: [], threadMessages: [] },
    }, hook("draft"));
    await makeOpusProposer(client).propose([
      { kind: "domain", senderDomain: "billing.example", destination: "ohmail/Receipts", count: 4, provenance: "rule" },
    ], hook("propose"));
    expect(hits).toEqual(["classify", "screen", "ask", "draft", "propose"]);
  });

  it("a port called WITHOUT a hook calls the client exactly as before — one argument", async () => {
    const args: number[] = [];
    const spy = { messages: { async create(...a: unknown[]) {
      args.push(a.length);
      return { content: [{ type: "text", text: JSON.stringify({ destination: "ohmail/News", confidence: 0.9, rationale: "r", spam: false }) }] };
    } } };
    await makeHaikuClassifier({ client: spy }).classify({
      from: { address: "news@example.com", name: null }, subject: "s", snippet: "t", headersDigest: "",
    });
    expect(args).toEqual([1]);
  });
});

/**
 * A DECLINE, AS THE CLIENT REPORTS AND PRICES IT. Anthropic's refusal is HTTP 200 with no content
 * and `stop_reason: "refusal"`; before `cyber`, `general_harms` or an unnamed category it is not
 * billed, after any output or in `bio` / `frontier_llm` / `reasoning_extraction` it is (refusals
 * page, read 2026-10-12). The report says which happened; the port sees the stop and raises it.
 */
describe("the client reports stop_reason and prices a decline as Anthropic bills it", () => {
  const refusal = (category: string | null, output = 0) => ok({
    id: "msg_r", type: "message", role: "assistant", model: "claude-haiku-5-5", content: [],
    stop_reason: "refusal", stop_details: { type: "refusal", category, explanation: category ? "declined" : null },
    usage: { input_tokens: 900, output_tokens: output },
  });
  const reportOf = async (answer: () => Response): Promise<AnthropicCallReport> => {
    let got: AnthropicCallReport | undefined;
    const { fetch } = fakeFetch([answer]);
    const client = makeAnthropicClient({ apiKey: KEY, fetchImpl: fetch, ...noSleep, onUsage: (r) => { got = r; } });
    await client.messages.create({ model: "claude-haiku-5-5" });
    return got!;
  };

  it("a refusal through the REAL client and classifier: ModelDeclinedError, ok, unpriced", async () => {
    const reports: AnthropicCallReport[] = [];
    const { fetch } = fakeFetch([refusal("cyber")]);
    const client = makeAnthropicClient({ apiKey: KEY, fetchImpl: fetch, ...noSleep, onUsage: (r) => { reports.push(r); } });
    const err = await makeHaikuClassifier({ client }).classify({
      from: { address: "news@example.com", name: null }, subject: "Weekly", snippet: "top", headersDigest: "",
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ModelDeclinedError);
    expect(err).toMatchObject({ stopReason: "refusal", refusalCategory: "cyber" });
    expect(reports[0]).toMatchObject({ ok: true, status: 200, stopReason: "refusal", costMicroUsd: null, inputTokens: 900 });
  });

  it("unbilled before output: cyber, general_harms and an unnamed category are unpriced", async () => {
    for (const category of ["cyber", "general_harms", null]) {
      expect((await reportOf(refusal(category))).costMicroUsd, String(category)).toBeNull();
    }
  });

  it("billed: bio, frontier_llm and reasoning_extraction are priced, as is a refusal after output", async () => {
    for (const category of ["bio", "frontier_llm", "reasoning_extraction"]) {
      // 900 input tokens at $0.10/MTok = 90 micro-USD.
      expect((await reportOf(refusal(category))).costMicroUsd, category).toBe(90);
    }
    // Mid-answer: 900 in + 40 out at $0.50/MTok = 90 + 20 = 110.
    expect((await reportOf(refusal("cyber", 40))).costMicroUsd).toBe(110);
  });

  it("an ordinary answer and a cut-off one are priced and say which they were", async () => {
    const answer = (stop: string) => ok({
      model: "claude-haiku-5-5", content: [{ type: "text", text: "{}" }], stop_reason: stop,
      usage: { input_tokens: 900, output_tokens: 40 },
    });
    expect(await reportOf(answer("end_turn"))).toMatchObject({ stopReason: "end_turn", costMicroUsd: 110 });
    expect(await reportOf(answer("max_tokens"))).toMatchObject({ stopReason: "max_tokens", costMicroUsd: 110 });
  });

  it("a failed call reports no stop reason", async () => {
    const reports: AnthropicCallReport[] = [];
    const { fetch } = fakeFetch([fail(400, { error: { type: "invalid_request_error", message: "bad" } })]);
    const client = makeAnthropicClient({ apiKey: KEY, fetchImpl: fetch, ...noSleep, onUsage: (r) => { reports.push(r); } });
    await client.messages.create({ model: "m" }).catch(() => undefined);
    expect(reports[0]).toMatchObject({ ok: false, stopReason: null, costMicroUsd: null });
  });

  it("the billed set, by literal — the rule `unbilledRefusal` reads", () => {
    expect([...BILLED_REFUSAL_CATEGORIES].sort()).toEqual(["bio", "frontier_llm", "reasoning_extraction"]);
    expect(unbilledRefusal("refusal", { category: "cyber" }, 0)).toBe(true);
    expect(unbilledRefusal("refusal", { category: "bio" }, 0)).toBe(false);
    expect(unbilledRefusal("end_turn", { category: "cyber" }, 0)).toBe(false);
  });

  it("the `ai_call` line carries stopReason past the logger's field census — nothing dropped", async () => {
    const lines: string[] = [];
    const log = createLogger({ service: "worker", sink: (l) => { lines.push(l); }, now: () => new Date(0) });
    const { fetch } = fakeFetch([refusal("cyber")]);
    await makeAnthropicClient({ apiKey: KEY, fetchImpl: fetch, ...noSleep, log }).messages.create({ model: "claude-haiku-5-5" });
    const line = JSON.parse(lines.find((l) => l.includes("\"ai_call\""))!) as Record<string, unknown>;
    expect(line.stopReason).toBe("refusal");
    expect(line.droppedFields).toBeUndefined();
    // And the decline lines' own fields, as the circuit and the passes write them.
    lines.length = 0;
    log.info("classifier_declined", { stopReason: "refusal", refusalCategory: "cyber" });
    expect(JSON.parse(lines[0]!)).toMatchObject({ stopReason: "refusal", refusalCategory: "cyber" });
    expect((JSON.parse(lines[0]!) as Record<string, unknown>).droppedFields).toBeUndefined();
  });
});

describe("the pins the review asked for", () => {
  /** `Math.round`, and not floor or ceil: 0.7 micro-USD is 1, 0.4 is 0. */
  it("rounds the micro-dollar sum once, to the nearest", () => {
    expect(estimateCostMicroUsd("claude-haiku-5-5", { inputTokens: 7 })).toBe(1);
    expect(estimateCostMicroUsd("claude-haiku-5-5", { inputTokens: 4 })).toBe(0);
  });

  it("MODEL_REQUEST_RULES, by literal", () => {
    expect(MODEL_REQUEST_RULES).toEqual({
      "claude-haiku-4-5": { thinkingOff: { type: "disabled" }, effort: false },
      "claude-haiku-4-5-20251001": { thinkingOff: { type: "disabled" }, effort: false },
      "claude-sonnet-5": { thinkingOff: { type: "disabled" }, effort: true },
      "claude-opus-5": { thinkingOff: { type: "disabled" }, effort: true },
      "claude-haiku-5-5": { thinkingOff: { type: "disabled" }, effort: true },
      "claude-sonnet-5-5": { thinkingOff: { type: "between_tools" }, effort: true },
      "claude-opus-5-5": { thinkingOff: null, effort: true },
    });
  });

  it("a prototype name has no price — null, never NaN", () => {
    for (const model of ["constructor", "toString", "__proto__"]) {
      expect(estimateCostMicroUsd(model, { inputTokens: 1000 }), model).toBeNull();
    }
  });
});

describe("assertAnthropicKey — a wrong secret must fail the DEPLOYMENT, not the mail", () => {
  it("accepts a well-formed key and trims it", () => {
    expect(assertAnthropicKey(`  ${KEY}  `)).toBe(KEY);
  });

  it("refuses anything that is not an Anthropic key, naming the VARIABLE and never the VALUE", () => {
    // The realistic mistake: another product's secret pasted into the wrong Vercel row.
    for (const wrong of [
      stripeTestKey("anthropic-client-wrong-row"), "re_EXAMPLE_NOT_A_REAL_KEY",
      "whsec_EXAMPLE_NOT_A_REAL_KEY", "",
    ]) {
      const err = (() => {
        try { assertAnthropicKey(wrong); return null; } catch (e) { return e as Error; }
      })();
      expect(err, `expected ${wrong || "(empty)"} to be refused`).not.toBeNull();
      expect(err!.message).toContain("ANTHROPIC_API_KEY");            // the variable — actionable
      if (wrong !== "") expect(err!.message).not.toContain(wrong);    // never the secret
    }
  });
});

it("does not follow redirects on guarded requests", async () => {
  const { fetch, calls } = fakeFetch([fail(307, {}, { location: "https://elsewhere.invalid/submit" })]);
  const client = makeAnthropicClient({ apiKey: KEY, fetchImpl: fetch, maxRetries: 0 });
  await expect(client.messages.create({ model: "fixture" }, {
    beforeDispatch: async () => undefined,
  })).rejects.toBeInstanceOf(AnthropicApiError);
  expect(calls).toHaveLength(1);
  expect(calls[0]?.init.redirect).toBe("error");
});

it.each([
  { body: { error: { type: "invalid_request_error", message: "Private draft excerpt" } }, type: "invalid_request_error" },
  { body: { error: { type: "Private draft excerpt", message: "Private draft excerpt" } }, type: null },
  { body: "Private draft excerpt", type: null },
])("guarded errors retain only fixed diagnostics ($type)", async ({ body, type }) => {
  const { fetch } = fakeFetch([fail(400, body, { "request-id": "Private draft excerpt" })]);
  const client = makeAnthropicClient({ apiKey: KEY, fetchImpl: fetch, maxRetries: 0 });
  await expect(client.messages.create({ model: "fixture" }, {
    beforeDispatch: async () => undefined,
  })).rejects.toMatchObject({
    name: "AnthropicApiError", status: 400, errorType: type, requestId: null,
    message: "The model provider rejected the request.",
  });
});

it("reports a guarded unreadable success without the response fragment", async () => {
  const { fetch } = fakeFetch([fail(200, "Private draft excerpt")]);
  const client = makeAnthropicClient({ apiKey: KEY, fetchImpl: fetch, maxRetries: 0 });
  await expect(client.messages.create({ model: "fixture" }, {
    beforeDispatch: async () => undefined,
  })).rejects.toMatchObject({
    name: "AnthropicApiError", status: 200,
    message: "The model provider returned an unreadable response.",
  });
});

it("reports a guarded transport failure without storing its cause", async () => {
  const client = makeAnthropicClient({
    apiKey: KEY, maxRetries: 0,
    fetchImpl: async () => { throw new Error("Private draft excerpt"); },
  });
  const err = await client.messages.create({ model: "fixture" }, {
    beforeDispatch: async () => undefined,
  }).catch((error: unknown) => error);
  expect(err).toBeInstanceOf(AnthropicTransportError);
  expect(err).toMatchObject({ message: "The model provider could not be reached.", cause: undefined });
});
