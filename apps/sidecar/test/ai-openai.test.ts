import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FIXTURE_SHAPES, anthropicKey, openAiKey } from "../../../test/support/fixture-credentials.js";
import {
  CLASSIFY_RESULT_SCHEMA, DRAFT_RESULT_SCHEMA, SCREENING_PREFIX, SCREENING_RESULT_SCHEMA,
  ModelDeclinedError, StaticKeyProvider, TAXONOMY_PREFIX,
} from "@trafficflow/core/mail";
import type { ClassifierInput, DraftInput } from "@trafficflow/core/mail";
import { ANTHROPIC_BASE } from "../src/ai-anthropic.js";
import { NOT_CHAT_MODELS, OPENAI_BASE } from "../src/ai-openai.js";
import { AI_STORE_FILE, createLocalAi, type LocalAi, type LocalAiOptions } from "../src/ai-provider.js";
import { createSidecarLog } from "../src/log.js";

/**
 * AN OPENAI KEY YOU OWN — the third way a standalone install reaches a model.
 *
 * The sibling of `ai-provider.test.ts`, which establishes the rules for the seam as a whole. This
 * file asserts the things that are TRUE OF THIS PROVIDER SPECIFICALLY, and the ones worth the file
 * are the ones a second key-carrying provider makes newly possible to get wrong:
 *
 *  1. **The destination is a literal**, exactly as Anthropic's is. A provider that holds a key and
 *     takes an address is a supported way to exfiltrate the key.
 *  2. **The two hosted keys never cross.** Saving one vendor's key must not overwrite the other's,
 *     and choosing a vendor must not send it a credential belonging to the other company. This is
 *     the failure mode that did not exist while there was one hosted provider, so it is the one
 *     with the most tests.
 *  3. **The question is the shared one**, byte for byte, from `@trafficflow/core/mail`. Three ways
 *     to reach a model is three chances for a private copy of a question to give one sender two
 *     different answers — and each copy would pass its own test.
 *  4. **The wire adaptation is real and bounded.** The response envelope and the reasoning-model
 *     field split are genuine differences from Anthropic's API; they are adapted at the edge and
 *     the retry that adapts them is bounded to one, so a 400 cannot become an unbounded charge.
 *
 * The transport is injected rather than mocked at the module boundary, so every assertion is about
 * the bytes that would leave this machine — the URL, the method, the headers, the body.
 */

/** Shaped like the real thing and belonging to nobody. Never a live credential in a test. */
const OPENAI_KEY = openAiKey("ai-openai");
const ANTHROPIC_KEY = anthropicKey("ai-openai");

it("the fixture keys have the vendors' key shapes", () => {
  expect(OPENAI_KEY).toMatch(FIXTURE_SHAPES.openai);
  expect(ANTHROPIC_KEY).toMatch(FIXTURE_SHAPES.anthropic);
});

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function dataDir(): string {
  const d = mkdtempSync(join(tmpdir(), "ohmail-openai-"));
  dirs.push(d);
  return d;
}

interface Call { url: string; method: string; headers: Record<string, string>; body: string | null }

function recorder(routes: Array<[RegExp, (call: Call) => Response]>): {
  calls: Call[];
  fetchImpl: typeof fetch;
} {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[k.toLowerCase()] = v;
    }
    const call: Call = {
      url,
      method: init?.method ?? "GET",
      headers,
      body: typeof init?.body === "string" ? init.body : null,
    };
    calls.push(call);
    for (const [re, make] of routes) if (re.test(url)) return make(call);
    return new Response("no route", { status: 599 });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A chat completion carrying `text` as the model's whole answer. */
const completion = (text: unknown): Response =>
  json({ choices: [{ message: { role: "assistant", content: JSON.stringify(text) } }] });

const A_VERDICT = {
  destination: "ohmail/News", confidence: 0.9, rationale: "a newsletter", spam: false,
};

/** An OpenAI transport that verifies cleanly and answers both features. */
function openaiOk(): Array<[RegExp, (call: Call) => Response]> {
  return [
    [/\/v1\/models\/[^/]+$/, () => json({ id: "ok" })],
    [/\/v1\/models$/, () => json({ data: [{ id: "gpt-4.1-mini" }, { id: "gpt-4.1" }] })],
    [/\/v1\/chat\/completions$/, () => completion(A_VERDICT)],
  ];
}

async function make(opts: Partial<LocalAiOptions> & { dataDir: string }): Promise<LocalAi> {
  return createLocalAi({
    keyProvider: new StaticKeyProvider({ 1: Buffer.alloc(32, 7) }),
    canStoreKey: true,
    log: createSidecarLog({ sink: () => undefined }),
    ...opts,
  });
}

const anInput = (subject: string): ClassifierInput => ({
  from: { name: null, address: "news@example.test" },
  subject,
  snippet: "the weekly roundup",
  headersDigest: "list-id present",
});

const aDraftInput = (): DraftInput => ({
  incoming: { subject: "Question", from: "her@example.test", snippet: "when are you free?" },
  context: { kbEntries: [], threadMessages: [] },
});

/** Save an OpenAI configuration and return the status the write produced. */
async function configured(
  ai: LocalAi,
  extra: Record<string, unknown> = {},
): Promise<ReturnType<LocalAi["status"]>> {
  return ai.save({ provider: "openai", openai: { apiKey: OPENAI_KEY }, ...extra });
}

describe("the key goes to OpenAI, sealed, and to nowhere else", () => {
  it("saves, verifies and reports in one round trip", async () => {
    const { fetchImpl } = recorder(openaiOk());
    const ai = await make({ dataDir: dataDir(), fetchImpl });

    const status = await configured(ai);
    expect(status.provider).toBe("openai");
    expect(status.available).toBe(true);
    expect(status.unavailableReason).toBeNull();
    // The engine STATES where content goes. A window deriving it from the provider name would go
    // on saying the old thing after this line changed.
    expect(status.contentGoesTo).toBe("openai");
    expect(status.settings.openai.hasKey).toBe(true);
  });

  it("stores the key encrypted: the bytes are nowhere in the file on disk", async () => {
    const dir = dataDir();
    const { fetchImpl } = recorder(openaiOk());
    await configured(await make({ dataDir: dir, fetchImpl }));

    expect(readdirSync(dir)).toContain(AI_STORE_FILE);
    const onDisk = readFileSync(join(dir, AI_STORE_FILE), "utf8");
    expect(onDisk).not.toContain(OPENAI_KEY);
    // …and the envelope really is there, so the assertion above is not passing on an empty file.
    expect(JSON.parse(onDisk).openai.keyEnc).toEqual(expect.any(String));
  });

  it("never returns the key from any surface — only that one is stored", async () => {
    const { fetchImpl } = recorder(openaiOk());
    const ai = await make({ dataDir: dataDir(), fetchImpl });
    await configured(ai);
    expect(JSON.stringify(ai.status())).not.toContain(OPENAI_KEY);
    expect(ai.status().settings.openai.hasKey).toBe(true);
  });

  it("puts it in an Authorization: Bearer header, on a request to api.openai.com and nowhere else", async () => {
    const { calls, fetchImpl } = recorder(openaiOk());
    const ai = await make({ dataDir: dataDir(), fetchImpl });
    await configured(ai);
    await ai.classifier()!.classify(anInput("The weekly"));

    const bearing = calls.filter((c) => c.headers.authorization === `Bearer ${OPENAI_KEY}`);
    expect(bearing.length).toBeGreaterThan(0);
    for (const c of bearing) expect(c.url.startsWith(`${OPENAI_BASE}/`)).toBe(true);
    // Nothing carried the key anywhere else, under any header spelling.
    for (const c of calls) {
      if (!c.url.startsWith(`${OPENAI_BASE}/`)) {
        expect(JSON.stringify(c)).not.toContain(OPENAI_KEY);
      }
    }
  });

  it("the endpoint is a literal that no setting can move", async () => {
    const { calls, fetchImpl } = recorder(openaiOk());
    const ai = await make({ dataDir: dataDir(), fetchImpl });
    // There is no baseUrl on the OpenAI half at all. Offering one is refused as an unknown field
    // would be — the model names are read, the address is not, because it does not exist.
    await ai.save({
      provider: "openai",
      openai: { apiKey: OPENAI_KEY, baseUrl: "http://attacker.test" } as never,
    });
    await ai.classifier()!.classify(anInput("The weekly"));

    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) expect(c.url.startsWith(`${OPENAI_BASE}/`)).toBe(true);
    expect(JSON.stringify(calls)).not.toContain("attacker.test");
  });

  it("refuses to follow a redirect, because a 302 is a destination somebody else chose", async () => {
    const seen: Array<RequestInit | undefined> = [];
    const fetchImpl = (async (_i: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      seen.push(init);
      return json({ data: [] });
    }) as unknown as typeof fetch;
    const ai = await make({ dataDir: dataDir(), fetchImpl });
    await configured(ai);
    expect(seen.length).toBeGreaterThan(0);
    for (const init of seen) expect(init?.redirect).toBe("error");
  });
});

describe("two hosted vendors, two keys, and they never cross", () => {
  it("an OpenAI key does not overwrite a stored Anthropic key", async () => {
    const dir = dataDir();
    const { fetchImpl } = recorder([
      [/api\.anthropic\.com/, () => json({ data: [{ id: "claude-haiku-4-5-20251001" }] })],
      ...openaiOk(),
    ]);
    const ai = await make({ dataDir: dir, fetchImpl });

    await ai.save({ provider: "anthropic", anthropic: { apiKey: ANTHROPIC_KEY } });
    expect(ai.status().settings.anthropic.hasKey).toBe(true);

    await configured(ai);
    const status = ai.status();
    // BOTH are held. Switching provider is a choice about where to send mail, not an instruction
    // to forget a credential the person has not asked to remove.
    expect(status.settings.anthropic.hasKey).toBe(true);
    expect(status.settings.openai.hasKey).toBe(true);

    const onDisk = JSON.parse(readFileSync(join(dir, AI_STORE_FILE), "utf8"));
    expect(onDisk.anthropic.keyEnc).not.toEqual(onDisk.openai.keyEnc);
  });

  /**
   * THE ORDER OF THESE FOUR STEPS IS THE TEST, and getting it wrong makes the test vacuous.
   *
   * Saving Anthropic, calling it, saving OpenAI and calling that proves nothing about crossing:
   * the Anthropic call happened BEFORE the OpenAI key was ever written, so a `save` that seals the
   * OpenAI key into the Anthropic block has no request left to contaminate. That version of this
   * test was written first and stayed GREEN against exactly that mutation.
   *
   * The leak is only observable by going BACK. The last two steps re-select Anthropic and make a
   * request, so a key that was overwritten in between is now on the wire to the wrong company.
   */
  it("NEVER sends one vendor's key to the other, in either direction", async () => {
    const anthropicRoutes: Array<[RegExp, (call: Call) => Response]> = [
      [/api\.anthropic\.com\/v1\/models\?/, () => json({ data: [{ id: "claude-haiku-4-5-20251001" }] })],
      [/api\.anthropic\.com\/v1\/models\//, () => json({ id: "ok" })],
      [/api\.anthropic\.com\/v1\/messages$/, () =>
        json({ content: [{ type: "text", text: JSON.stringify(A_VERDICT) }] })],
    ];
    const { calls, fetchImpl } = recorder([...anthropicRoutes, ...openaiOk()]);
    const ai = await make({ dataDir: dataDir(), fetchImpl });

    await ai.save({ provider: "anthropic", anthropic: { apiKey: ANTHROPIC_KEY } });
    await ai.classifier()!.classify(anInput("one"));
    await ai.save({ provider: "openai", openai: { apiKey: OPENAI_KEY } });
    await ai.classifier()!.classify(anInput("two"));
    // …and back, which is the step that makes the crossing observable at all.
    await ai.save({ provider: "anthropic" });
    await ai.classifier()!.classify(anInput("three"));

    const anthropicCalls = calls.filter((c) => c.url.includes("api.anthropic.com"));
    const openaiCalls = calls.filter((c) => c.url.includes("api.openai.com"));
    expect(anthropicCalls.length).toBeGreaterThan(0);
    expect(openaiCalls.length).toBeGreaterThan(0);

    // The exact failure a shared key field would produce: one company receiving the other's
    // credential. Asserted on the whole recorded call, so no header spelling escapes it.
    for (const c of anthropicCalls) expect(JSON.stringify(c)).not.toContain(OPENAI_KEY);
    for (const c of openaiCalls) expect(JSON.stringify(c)).not.toContain(ANTHROPIC_KEY);

    // And the positive control: each vendor really did receive ITS OWN key, so the two loops
    // above are not passing over requests that carried no credential at all.
    expect(anthropicCalls.some((c) => c.headers["x-api-key"] === ANTHROPIC_KEY)).toBe(true);
    expect(openaiCalls.some((c) => c.headers.authorization === `Bearer ${OPENAI_KEY}`)).toBe(true);
  });

  /** The same go-back crossing with OpenCode Go as the third keyed vendor, both ways. */
  it("NEVER sends the Go key to OpenAI, nor OpenAI's key to opencode.ai", async () => {
    const GO_KEY = "fixture-go-key-ai-openai";
    const goChat = (): Response => json({
      choices: [{ finish_reason: "stop", message: { content: JSON.stringify(A_VERDICT) } }],
    });
    const { calls, fetchImpl } = recorder([
      [/^https:\/\/opencode\.ai\/console\/api\/v2\/config$/, () =>
        json({ providers: { "opencode-go": { models: { "kimi-k3": {}, "glm-5.3-flash": {} } } } })],
      [/^https:\/\/opencode\.ai\/inference\/go\/v1\/chat\/completions$/, goChat],
      ...openaiOk(),
    ]);
    const ai = await make({ dataDir: dataDir(), fetchImpl });

    await ai.save({
      provider: "opencode-go",
      opencodeGo: { apiKey: GO_KEY, classifyModel: "glm-5.3-flash", draftModel: "kimi-k3" },
    } as Parameters<LocalAi["save"]>[0]);
    await ai.classifier()!.classify(anInput("one"));
    await ai.save({ provider: "openai", openai: { apiKey: OPENAI_KEY } });
    await ai.classifier()!.classify(anInput("two"));
    await ai.save({ provider: "opencode-go" } as Parameters<LocalAi["save"]>[0]);
    await ai.classifier()!.classify(anInput("three"));

    const goCalls = calls.filter((c) => c.url.startsWith("https://opencode.ai/"));
    const openaiCalls = calls.filter((c) => c.url.includes("api.openai.com"));
    expect(goCalls.filter((c) => c.url.endsWith("/chat/completions"))).toHaveLength(2);
    expect(openaiCalls.length).toBeGreaterThan(0);
    for (const c of goCalls) expect(JSON.stringify(c)).not.toContain(OPENAI_KEY);
    for (const c of openaiCalls) expect(JSON.stringify(c)).not.toContain(GO_KEY);
    expect(goCalls.every((c) => c.headers.authorization === `Bearer ${GO_KEY}`)).toBe(true);
    expect(openaiCalls.some((c) => c.headers.authorization === `Bearer ${OPENAI_KEY}`)).toBe(true);
  });

  /**
   * The same crossing, observed at rest rather than on the wire.
   *
   * The ciphertexts differ even when the plaintexts are identical — the envelope is randomised —
   * so comparing `keyEnc` values proves nothing. Reloading the store and USING the stored key is
   * the only way to see which secret is actually in the Anthropic block.
   */
  it("a stored Anthropic key survives an OpenAI save, across a relaunch", async () => {
    const dir = dataDir();
    const { calls, fetchImpl } = recorder([
      [/api\.anthropic\.com\/v1\/models\?/, () => json({ data: [{ id: "claude-haiku-4-5-20251001" }] })],
      [/api\.anthropic\.com\/v1\/models\//, () => json({ id: "ok" })],
      [/api\.anthropic\.com\/v1\/messages$/, () =>
        json({ content: [{ type: "text", text: JSON.stringify(A_VERDICT) }] })],
      ...openaiOk(),
    ]);
    const first = await make({ dataDir: dir, fetchImpl });
    await first.save({ provider: "anthropic", anthropic: { apiKey: ANTHROPIC_KEY } });
    await first.save({ provider: "openai", openai: { apiKey: OPENAI_KEY } });

    // A second engine on the same directory — the key is read back from disk, not from memory.
    const relaunched = await make({ dataDir: dir, fetchImpl });
    await relaunched.save({ provider: "anthropic" });
    calls.length = 0;
    await relaunched.classifier()!.classify(anInput("after a relaunch"));

    const sent = calls.filter((c) => c.url.includes("api.anthropic.com"));
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.every((c) => c.headers["x-api-key"] === ANTHROPIC_KEY)).toBe(true);
    expect(JSON.stringify(sent)).not.toContain(OPENAI_KEY);
  });

  it("names the vendor actually chosen when its key is missing", async () => {
    const { fetchImpl } = recorder(openaiOk());
    const ai = await make({ dataDir: dataDir(), fetchImpl });

    // A key stored for Anthropic, and OpenAI chosen. "No API key is stored" would be true and
    // useless here; the sentence has to say WHICH.
    await ai.save({ provider: "anthropic", anthropic: { apiKey: ANTHROPIC_KEY } });
    const status = await ai.save({ provider: "openai" });

    expect(status.unavailableReason).toBe("key_absent");
    expect(status.available).toBe(false);
    await expect(async () => {
      await createLocalAi({
        dataDir: dataDir(), keyProvider: new StaticKeyProvider({ 1: Buffer.alloc(32, 7) }),
        canStoreKey: true, log: createSidecarLog({ sink: () => undefined }), fetchImpl,
      });
    }).not.toThrow();
  });

  it("says OpenAI in the refusal when OpenAI is the one with no key", async () => {
    const { fetchImpl } = recorder(openaiOk());
    const ai = await make({ dataDir: dataDir(), fetchImpl });
    await ai.save({ provider: "anthropic", anthropic: { apiKey: ANTHROPIC_KEY } });
    await ai.save({ provider: "openai" });
    // The port is withheld, so the sentence is reached through the transport rather than a port.
    expect(ai.classifier()).toBeUndefined();
    expect(ai.drafter()).toBeUndefined();
  });

  it("keeps each vendor's model choices apart", async () => {
    const { fetchImpl } = recorder([
      [/api\.anthropic\.com/, () => json({ data: [] })],
      ...openaiOk(),
    ]);
    const ai = await make({ dataDir: dataDir(), fetchImpl });
    await ai.save({
      provider: "openai",
      anthropic: { classifyModel: "claude-haiku-4-5-20251001" },
      openai: { apiKey: OPENAI_KEY, classifyModel: "gpt-4.1-mini", draftModel: "gpt-4.1" },
    });
    const s = ai.status().settings;
    expect(s.anthropic.classifyModel).toBe("claude-haiku-4-5-20251001");
    expect(s.openai.classifyModel).toBe("gpt-4.1-mini");
    expect(s.openai.draftModel).toBe("gpt-4.1");
  });
});

describe("the question is the SHARED one, not a copy written here", () => {
  const bodyOf = (calls: Call[]): Record<string, unknown> => {
    const chat = calls.filter((c) => c.url.endsWith("/v1/chat/completions"));
    expect(chat).toHaveLength(1);
    return JSON.parse(chat[0]!.body!) as Record<string, unknown>;
  };
  type Turn = { role: string; content: string };

  it("sends core's SCREENING prefix and schema, byte for byte", async () => {
    const { calls, fetchImpl } = recorder(openaiOk());
    const ai = await make({ dataDir: dataDir(), fetchImpl });
    await configured(ai);
    calls.length = 0;
    await ai.classifier()!.screen!(anInput("Your invoice"));

    const body = bodyOf(calls);
    const turns = body.messages as Turn[];
    expect(turns[0]!.role).toBe("system");
    expect(turns[0]!.content).toBe(SCREENING_PREFIX);
    expect(body.response_format).toEqual({
      type: "json_schema",
      json_schema: { name: "screening", strict: true, schema: SCREENING_RESULT_SCHEMA },
    });
  });

  it("sends core's ROUTING prefix and schema for the other question", async () => {
    const { calls, fetchImpl } = recorder(openaiOk());
    const ai = await make({ dataDir: dataDir(), fetchImpl });
    await configured(ai);
    calls.length = 0;
    await ai.classifier()!.classify(anInput("The weekly"));

    const body = bodyOf(calls);
    expect((body.messages as Turn[])[0]!.content).toBe(TAXONOMY_PREFIX);
    expect(body.response_format).toEqual({
      type: "json_schema",
      json_schema: { name: "routing", strict: true, schema: CLASSIFY_RESULT_SCHEMA },
    });
  });

  it("the two questions are DIFFERENT — this is not one prompt wearing two names", () => {
    expect(SCREENING_PREFIX).not.toBe(TAXONOMY_PREFIX);
    expect(SCREENING_RESULT_SCHEMA).not.toEqual(CLASSIFY_RESULT_SCHEMA);
  });

  it("uses the drafting prefix and schema for a draft", async () => {
    const { calls, fetchImpl } = recorder([
      [/\/v1\/models\/[^/]+$/, () => json({ id: "ok" })],
      [/\/v1\/models$/, () => json({ data: [] })],
      [/\/v1\/chat\/completions$/, () =>
        completion({ subject: "Re: Question", body: "Thursday works.", rationale: "answered it" })],
    ]);
    const ai = await make({ dataDir: dataDir(), fetchImpl });
    await configured(ai);
    calls.length = 0;
    const drafted = await ai.drafter()!.draft(aDraftInput());

    const body = bodyOf(calls);
    expect((body.response_format as { json_schema: { schema: unknown } }).json_schema.schema)
      .toEqual(DRAFT_RESULT_SCHEMA);
    expect(drafted.subject).toBe("Re: Question");
  });

  it("asks the CLASSIFY model the screening question, matching the other providers", async () => {
    const { calls, fetchImpl } = recorder(openaiOk());
    const ai = await make({ dataDir: dataDir(), fetchImpl });
    await ai.save({
      provider: "openai",
      openai: { apiKey: OPENAI_KEY, classifyModel: "gpt-4.1-mini", draftModel: "gpt-4.1" },
    });
    calls.length = 0;
    await ai.classifier()!.screen!(anInput("Your invoice"));
    expect(bodyOf(calls).model).toBe("gpt-4.1-mini");
  });

  it("the account's own words go in the USER turn, never in the shared prefix", async () => {
    const { calls, fetchImpl } = recorder(openaiOk());
    const ai = await make({ dataDir: dataDir(), fetchImpl });
    await configured(ai);
    calls.length = 0;
    await ai.classifier()!.screen!(anInput("A very distinctive subject line"));

    const turns = bodyOf(calls).messages as Turn[];
    expect(turns[0]!.content).not.toContain("A very distinctive subject line");
    expect(turns[1]!.role).toBe("user");
    expect(turns[1]!.content).toContain("A very distinctive subject line");
  });

  it("the BACKGROUND port cannot ask the screening question at all", async () => {
    const { fetchImpl } = recorder(openaiOk());
    const ai = await make({ dataDir: dataDir(), fetchImpl });
    await configured(ai);
    // Absence, not a flag: `planChange` takes a ClassifierPort and there is no argument that
    // could reach the screening question from the filing loop.
    expect((ai.classifierForCycle() as { screen?: unknown }).screen).toBeUndefined();
    expect(ai.classifier()!.screen).toBeDefined();
  });
});

describe("the wire adaptation — real differences, adapted at the edge and bounded", () => {
  it("reads the answer out of choices[0].message.content", async () => {
    const { fetchImpl } = recorder(openaiOk());
    const ai = await make({ dataDir: dataDir(), fetchImpl });
    await configured(ai);
    const result = await ai.classifier()!.classify(anInput("The weekly"));
    expect(result.destination).toBe("ohmail/News");
    expect(result.confidence).toBeCloseTo(0.9);
  });

  it("reports a model's own refusal as a decline, not as a malformed response", async () => {
    const { fetchImpl } = recorder([
      [/\/v1\/models\/[^/]+$/, () => json({ id: "ok" })],
      [/\/v1\/models$/, () => json({ data: [] })],
      [/\/v1\/chat\/completions$/, () =>
        json({ choices: [{ message: { content: null, refusal: "I can't help with that." } }] })],
    ]);
    const ai = await make({ dataDir: dataDir(), fetchImpl });
    await configured(ai);
    const err = await ai.classifier()!.classify(anInput("x")).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ModelDeclinedError);
    expect(err).toMatchObject({ stopReason: "refusal", refusalCategory: null });
  });

  it("a refusal on the background port is the message's answer: never counted, routing never withheld", async () => {
    const { fetchImpl } = recorder([
      [/\/v1\/models\/[^/]+$/, () => json({ id: "ok" })],
      [/\/v1\/models$/, () => json({ data: [] })],
      [/\/v1\/chat\/completions$/, () =>
        json({ choices: [{ message: { content: null, refusal: "I can't help with that." } }] })],
    ]);
    const ai = await make({ dataDir: dataDir(), fetchImpl, faultThreshold: 2 });
    await configured(ai);
    for (let i = 0; i < 4; i++) {
      const port = ai.classifierForCycle();
      expect(port, `routing was withheld after ${i} refusals`).toBeDefined();
      await expect(port!.classify(anInput("x"))).rejects.toBeInstanceOf(ModelDeclinedError);
    }
  });

  it("retries ONCE without the reasoning-model fields when the endpoint names one", async () => {
    let n = 0;
    const bodies: string[] = [];
    const { fetchImpl } = recorder([
      [/\/v1\/models\/[^/]+$/, () => json({ id: "ok" })],
      [/\/v1\/models$/, () => json({ data: [] })],
      [/\/v1\/chat\/completions$/, (call) => {
        bodies.push(call.body!);
        n++;
        if (n === 1) {
          return json({ error: { message: "Unsupported parameter: 'max_tokens' is not supported" } }, 400);
        }
        return completion(A_VERDICT);
      }],
    ]);
    const ai = await make({ dataDir: dataDir(), fetchImpl });
    await configured(ai);
    const result = await ai.classifier()!.classify(anInput("The weekly"));

    expect(result.destination).toBe("ohmail/News");
    expect(n).toBe(2);
    const first = JSON.parse(bodies[0]!) as Record<string, unknown>;
    const second = JSON.parse(bodies[1]!) as Record<string, unknown>;
    expect(first.max_tokens).toBe(512);
    expect(first.temperature).toBe(0);
    // The retry carries the field the reasoning models DO take, and drops the two they refuse.
    expect(second.max_completion_tokens).toBe(512);
    expect(second).not.toHaveProperty("max_tokens");
    expect(second).not.toHaveProperty("temperature");
    // …and it is still the same question, not a degraded one.
    expect((second.messages as Array<{ content: string }>)[0]!.content).toBe(TAXONOMY_PREFIX);
  });

  it("does NOT retry an unrelated 400 — one refusal must not become two charges", async () => {
    let n = 0;
    const { fetchImpl } = recorder([
      [/\/v1\/models\/[^/]+$/, () => json({ id: "ok" })],
      [/\/v1\/models$/, () => json({ data: [] })],
      [/\/v1\/chat\/completions$/, () => {
        n++;
        return json({ error: { message: "context_length_exceeded" } }, 400);
      }],
    ]);
    const ai = await make({ dataDir: dataDir(), fetchImpl });
    await configured(ai);
    await expect(ai.classifier()!.classify(anInput("x"))).rejects.toThrow(/refused the request \(400\)/);
    expect(n).toBe(1);
  });

  it("the retry is bounded to one: a second 400 is a failure, not a third request", async () => {
    let n = 0;
    const { fetchImpl } = recorder([
      [/\/v1\/models\/[^/]+$/, () => json({ id: "ok" })],
      [/\/v1\/models$/, () => json({ data: [] })],
      [/\/v1\/chat\/completions$/, () => {
        n++;
        return json({ error: { message: "Unsupported parameter: 'temperature'" } }, 400);
      }],
    ]);
    const ai = await make({ dataDir: dataDir(), fetchImpl });
    await configured(ai);
    await expect(ai.classifier()!.classify(anInput("x"))).rejects.toThrow(/answered 400/);
    expect(n).toBe(2);
  });

  it("never puts the endpoint's error prose on the model path — it quotes the request", async () => {
    const { fetchImpl } = recorder([
      [/\/v1\/models\/[^/]+$/, () => json({ id: "ok" })],
      [/\/v1\/models$/, () => json({ data: [] })],
      [/\/v1\/chat\/completions$/, () =>
        json({ error: { message: `your request with Bearer ${OPENAI_KEY} was rejected` } }, 500)],
    ]);
    const ai = await make({ dataDir: dataDir(), fetchImpl });
    await configured(ai);
    // The status and nothing else. An error body from this endpoint quotes the request, and the
    // request carries the key.
    await expect(ai.classifier()!.classify(anInput("x"))).rejects.toThrow(
      /^classifier: the model endpoint answered 500$/,
    );
  });
});

describe("verification — free, exact, and honest about which failure it was", () => {
  it("a rejected key is reported as a rejected key, not as an outage", async () => {
    const { fetchImpl } = recorder([[/\/v1\/models/, () => json({ error: "bad key" }, 401)]]);
    const ai = await make({ dataDir: dataDir(), fetchImpl });
    const status = await configured(ai);
    expect(status.available).toBe(false);
    expect(status.unavailableReason).toBe("unreachable");
    expect(status.probe?.reason).toBe("unauthorized");
  });

  it("a key that cannot reach the named model is a distinct, actionable state", async () => {
    const { fetchImpl } = recorder([
      [/\/v1\/models\/[^/]+$/, () => json({ error: "no such model" }, 404)],
      [/\/v1\/models$/, () => json({ data: [{ id: "gpt-4.1-mini" }] })],
    ]);
    const ai = await make({ dataDir: dataDir(), fetchImpl });
    const status = await ai.save({
      provider: "openai", openai: { apiKey: OPENAI_KEY, classifyModel: "gpt-9-imaginary" },
    });
    expect(status.probe?.reason).toBe("model_absent");
    expect(status.probe?.detail).toContain("gpt-9-imaginary");
  });

  it("costs nothing: it lists models and asks for one, and never runs a completion", async () => {
    const { calls, fetchImpl } = recorder(openaiOk());
    const ai = await make({ dataDir: dataDir(), fetchImpl });
    await configured(ai);
    calls.length = 0;
    await ai.verify();
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      expect(c.method).toBe("GET");
      expect(c.url).not.toContain("/chat/completions");
    }
  });

  it("populates the model picker from what the key can actually see", async () => {
    const { fetchImpl } = recorder(openaiOk());
    const ai = await make({ dataDir: dataDir(), fetchImpl });
    const status = await configured(ai);
    expect(status.probe?.models).toContain("gpt-4.1-mini");
  });

  /**
   * A MODEL THAT EXISTS AND CANNOT ANSWER IS NOT A VERIFIED MODEL.
   *
   * This vendor's `/v1/models` lists the whole catalogue the key can see — embeddings, speech,
   * moderation — not just what `/v1/chat/completions` accepts. Anthropic's list happens to be all
   * chat models, so the probe copied from it answered `ok: true` for `text-embedding-3-small`:
   * both GET requests succeed, the pane says available, the picker offers it, and then every
   * classify and every draft fails with a 400. A verification exists precisely to stop that, so a
   * green here was the one wrong answer it must never give.
   */
  it("refuses a model that exists but cannot serve chat, and says why", async () => {
    const { calls, fetchImpl } = recorder(openaiOk());
    const ai = await make({ dataDir: dataDir(), fetchImpl });
    const status = await ai.save({
      provider: "openai",
      openai: { apiKey: OPENAI_KEY, classifyModel: "text-embedding-3-small" },
    });

    expect(status.available).toBe(false);
    expect(status.probe?.reason).toBe("model_absent");
    expect(status.probe?.detail).toContain("text-embedding-3-small");
    expect(status.probe?.detail).toMatch(/not a chat model/);
    // Answerable from the name, so it costs no round trip to that model.
    expect(calls.some((c) => c.url.includes("text-embedding-3-small"))).toBe(false);
    expect(ai.classifier()).toBeUndefined();
  });

  it("keeps non-chat models out of the picker, and leaves real ones in", async () => {
    const { fetchImpl } = recorder([
      [/\/v1\/models\/[^/]+$/, () => json({ id: "ok" })],
      [/\/v1\/models$/, () => json({
        data: [
          { id: "gpt-4.1-mini" }, { id: "gpt-4.1" },
          { id: "text-embedding-3-small" }, { id: "whisper-1" },
          { id: "dall-e-3" }, { id: "omni-moderation-latest" }, { id: "tts-1" },
        ],
      })],
      [/\/v1\/chat\/completions$/, () => completion(A_VERDICT)],
    ]);
    const ai = await make({ dataDir: dataDir(), fetchImpl });
    const models = (await configured(ai)).probe?.models ?? [];
    expect(models).toEqual(["gpt-4.1-mini", "gpt-4.1"]);
  });

  it("does NOT invent a rule for names it has no business judging", () => {
    // The check is a narrow deny-list, never an allow-list: an unrecognised name must reach the
    // endpoint and be judged there, or this app becomes the reason a valid model is refused.
    const { fetchImpl } = recorder(openaiOk());
    expect(fetchImpl).toBeDefined();
    for (const ok of ["gpt-5", "o4-mini", "some-future-model-2027", "gpt-4.1-mini"]) {
      expect(NOT_CHAT_MODELS.test(ok), `${ok} must not be refused by name`).toBe(false);
    }
    for (const bad of ["text-embedding-3-small", "whisper-1", "tts-1-hd", "dall-e-3", "omni-moderation-latest"]) {
      expect(NOT_CHAT_MODELS.test(bad), `${bad} must be recognised as non-chat`).toBe(true);
    }
  });

  /**
   * THE `gpt-`-PREFIXED IDS THAT ARE STILL NOT CHAT MODELS.
   *
   * A prefix-only rule let exactly the confusable ones through: `gpt-4o-transcribe` and
   * `gpt-4o-mini-tts` look like chat models by their first three characters and are not, so they
   * stayed in the picker and passed verification — recreating the false "Working" the deny-list
   * exists to stop. These announce themselves at the END of the id instead.
   */
  it("recognises endpoint-only capabilities named at the end of a chat-looking id", () => {
    for (const bad of [
      "gpt-4o-transcribe", "gpt-4o-mini-transcribe", "gpt-4o-mini-tts",
      "gpt-4o-realtime-preview", "gpt-4o-realtime-preview-2024-12-17", "computer-use-preview",
    ]) {
      expect(NOT_CHAT_MODELS.test(bad), `${bad} must be recognised as non-chat`).toBe(true);
    }
    // …and the near-miss that DOES serve chat completions must survive. A deny-list that ate this
    // would be the failure it was written to prevent, pointed the other way.
    for (const ok of ["gpt-4o-audio-preview", "gpt-4o", "gpt-4o-mini", "gpt-4.1-mini"]) {
      expect(NOT_CHAT_MODELS.test(ok), `${ok} must not be refused by name`).toBe(false);
    }
  });

  it("changing the settings DISCARDS the verification — a new configuration is unproven", async () => {
    const { fetchImpl } = recorder(openaiOk());
    const ai = await make({ dataDir: dataDir(), fetchImpl });
    expect((await configured(ai)).available).toBe(true);

    // A model the endpoint will not confirm: the write must not inherit the old green.
    const { fetchImpl: dead } = recorder([[/\/v1\/models/, () => new Response("", { status: 503 })]]);
    const ai2 = await make({ dataDir: dataDir(), fetchImpl: dead });
    const status = await configured(ai2);
    expect(status.available).toBe(false);
    expect(status.probe?.ok).toBe(false);
  });
});

describe("the store grew a provider and old files still load", () => {
  it("reads a file written before OpenAI existed, and defaults the new block", async () => {
    const dir = dataDir();
    const { fetchImpl } = recorder(openaiOk());
    // Exactly the shape the previous release wrote: no `openai` member at all.
    const legacy = {
      version: 1,
      provider: "ollama",
      anthropic: { classifyModel: "claude-haiku-4-5-20251001", draftModel: "claude-sonnet-5", keyEnc: null, keyVersion: null },
      ollama: { baseUrl: "http://127.0.0.1:11434", classifyModel: "llama3.2", draftModel: "llama3.2" },
      probe: null,
    };
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(dir, AI_STORE_FILE), JSON.stringify(legacy));

    const ai = await make({ dataDir: dir, fetchImpl });
    const s = ai.status();
    expect(s.provider).toBe("ollama");
    expect(s.settings.openai.hasKey).toBe(false);
    expect(s.settings.openai.classifyModel).toBe("gpt-4.1-mini");
    expect(s.settings.anthropic.classifyModel).toBe("claude-haiku-4-5-20251001");
  });

  it("refuses a provider name it does not know", async () => {
    const { fetchImpl } = recorder(openaiOk());
    const ai = await make({ dataDir: dataDir(), fetchImpl });
    await expect(ai.save({ provider: "gemini" })).rejects.toThrow(/provider must be one of/);
  });

  it("clearing forgets BOTH hosted keys", async () => {
    const dir = dataDir();
    const { fetchImpl } = recorder([
      [/api\.anthropic\.com/, () => json({ data: [] })],
      ...openaiOk(),
    ]);
    const ai = await make({ dataDir: dir, fetchImpl });
    await ai.save({ provider: "anthropic", anthropic: { apiKey: ANTHROPIC_KEY } });
    await configured(ai);

    const status = await ai.clear();
    expect(status.provider).toBeNull();
    expect(status.settings.anthropic.hasKey).toBe(false);
    expect(status.settings.openai.hasKey).toBe(false);
    const onDisk = readFileSync(join(dir, AI_STORE_FILE), "utf8");
    expect(onDisk).not.toContain(OPENAI_KEY);
    expect(onDisk).not.toContain(ANTHROPIC_KEY);
  });
});

describe("degrading without a provider is the floor, not a fault", () => {
  it("an unconfigured install makes NO request, with OpenAI available as a choice", async () => {
    const { calls, fetchImpl } = recorder(openaiOk());
    const ai = await make({ dataDir: dataDir(), fetchImpl });
    expect(ai.status().unavailableReason).toBe("not_configured");
    expect(ai.drafter()).toBeUndefined();
    expect(ai.classifier()).toBeUndefined();
    expect(ai.classifierForCycle()).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it("chosen but unverified offers nothing — a form is not a capability", async () => {
    const { fetchImpl } = recorder([[/\/v1\/models/, () => new Response("", { status: 500 })]]);
    const ai = await make({ dataDir: dataDir(), fetchImpl });
    const status = await configured(ai);
    expect(status.available).toBe(false);
    expect(ai.classifier()).toBeUndefined();
    expect(ai.classifierForCycle()).toBeUndefined();
  });

  it("the ANTHROPIC endpoint is never touched when OpenAI is the choice", async () => {
    const { calls, fetchImpl } = recorder(openaiOk());
    const ai = await make({ dataDir: dataDir(), fetchImpl });
    await configured(ai);
    await ai.classifier()!.classify(anInput("The weekly"));
    expect(calls.filter((c) => c.url.startsWith(ANTHROPIC_BASE))).toHaveLength(0);
  });
});
