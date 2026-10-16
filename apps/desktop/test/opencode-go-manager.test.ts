/**
 * @vitest-environment node
 *
 * OpenCode Go setup is tested through the real sidecar manager. The only provider boundary is an
 * injected fetch, and storage, key encryption and diagnostics are real manager dependencies backed
 * by a temporary directory and synthetic test values. No live provider call or inference occurs.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createLocalAi, AI_STORE_FILE, type LocalAiSettingsInput } from "../../sidecar/src/ai-provider.js";
import { OPENCODE_GO_MODEL_IDS } from "../../../packages/core/src/ai/transports/ai-opencode-go-models.js";
import type { KeyProvider } from "../../../packages/core/src/crypto.js";
import {
  CLASSIFY_RESULT_SCHEMA, DRAFT_PREFIX, DRAFT_RESULT_SCHEMA, ModelDeclinedError,
  SCREENING_PREFIX, SCREENING_RESULT_SCHEMA, SensitivePayloadRefusal, TAXONOMY_PREFIX,
} from "@trafficflow/core/mail";

const TEST_KEY = "fixture-key-that-is-not-a-provider-credential";
const DOCUMENTED_GO_CHAT_MODELS: string[] = [...OPENCODE_GO_MODEL_IDS];
const CONFIG = {
  account: { privateMarker: "discard-this-workspace-setting" },
  providers: {
    "opencode-go": {
      models: Object.fromEntries([
        ...DOCUMENTED_GO_CHAT_MODELS.map((id) => [id, { name: id }]),
        ["grok-4.6", { name: "Responses-only model" }],
        ["undocumented-private-model", { name: "Must not be exposed" }],
      ]),
    },
    unrelated: { models: { "other-provider-private-model": { name: "Discard" } } },
  },
};

type RequestRecord = {
  url: string;
  method: string;
  authorization: string | null;
  userAgent: string | null;
  opencodeClient: string | null;
  opencodeSession: string | null;
  redirect: RequestRedirect | undefined;
  body: BodyInit | null | undefined;
  signal: AbortSignal | null;
};

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function goWrite(input: { apiKey?: string; classifyModel?: string; draftModel?: string } = {}): LocalAiSettingsInput {
  return {
    provider: "opencode-go",
    opencodeGo: input,
  } as unknown as LocalAiSettingsInput;
}

interface ManagerOptions {
  status?: number;
  responseBody?: string;
  fetchResponder?: typeof fetch;
  canStoreKey?: boolean;
  timeoutMs?: number;
  faultThreshold?: number;
  cooldownMs?: number;
  seed?: unknown;
}

async function managerWithConfig(config: unknown = CONFIG, options: ManagerOptions = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), "ohmail-opencode-go-"));
  directories.push(dataDir);
  if (options.seed !== undefined) {
    await writeFile(join(dataDir, AI_STORE_FILE), JSON.stringify(options.seed), "utf8");
  }
  const requests: RequestRecord[] = [];
  const diagnostics: Array<{ event: string; detail: Record<string, unknown> }> = [];
  const keyProvider: KeyProvider = {
    async encrypt(plaintext) {
      return { ciphertext: `test-sealed:${Buffer.from(plaintext).toString("base64")}`, keyVersion: 4 };
    },
    async decrypt(ciphertext) {
      return Buffer.from(ciphertext.slice("test-sealed:".length), "base64").toString("utf8");
    },
    currentKeyVersion: () => 4,
    deriveSubkey: () => Buffer.alloc(32),
  };
  const ai = await createLocalAi({
    dataDir,
    keyProvider,
    canStoreKey: options.canStoreKey ?? true,
    timeoutMs: options.timeoutMs,
    faultThreshold: options.faultThreshold,
    cooldownMs: options.cooldownMs,
    now: () => new Date("2026-10-15T12:00:00.000Z"),
    log: (event, detail) => diagnostics.push({ event, detail }),
    fetchImpl: async (input, init) => {
      const headers = new Headers(init?.headers);
      requests.push({
        url: String(input),
        method: init?.method ?? "GET",
        authorization: headers.get("authorization"),
        userAgent: headers.get("user-agent"),
        opencodeClient: headers.get("x-opencode-client"),
        opencodeSession: headers.get("x-opencode-session"),
        redirect: init?.redirect,
        body: init?.body,
        signal: init?.signal ?? null,
      });
      if (options.fetchResponder) return options.fetchResponder(input, init);
      return new Response(options.responseBody ?? JSON.stringify(config), { status: options.status ?? 200 });
    },
  });
  return { ai, dataDir, requests, diagnostics };
}

function chatReply(content: string | null, options: { finishReason?: string; refusal?: unknown } = {}) {
  return {
    choices: [{
      finish_reason: options.finishReason ?? "stop",
      message: { content, ...(options.refusal === undefined ? {} : { refusal: options.refusal }) },
    }],
  };
}

function goInferenceResponder(reply: unknown, status = 200): typeof fetch {
  return async (input) => String(input) === "https://opencode.ai/console/api/v2/config"
    ? new Response(JSON.stringify(CONFIG), { status: 200 })
    : new Response(JSON.stringify(reply), { status });
}

const SYNTHETIC_CLASSIFIER_INPUT = {
  from: { name: "Synthetic sender", address: "sender@example.test" },
  subject: "Synthetic subject", snippet: "Synthetic snippet", headersDigest: "fixture headers", fewShot: [],
};

describe("OpenCode Go configuration verification through the local-AI manager", () => {
  it("uses the verified Go key and shared classify, screen, and draft contracts", async () => {
    const classifyResult = {
      destination: "ohmail/Receipts", confidence: 0.8, rationale: "A synthetic receipt.", spam: false,
    };
    const screenResult = {
      destination: "ohmail/Quarantine", confidence: 0.9, rationale: "Synthetic unwanted mail.", spam: true,
    };
    const draftResult = {
      subject: "Re: synthetic question", body: "A synthetic reply.", rationale: "Uses the supplied fixture.",
    };
    const responder: typeof fetch = async (input, init) => {
      if (String(input) === "https://opencode.ai/console/api/v2/config") {
        return new Response(JSON.stringify(CONFIG), { status: 200 });
      }
      const body = JSON.parse(String(init?.body)) as {
        messages?: Array<{ role?: string; content?: string }>;
      };
      const prompt = body.messages?.[0]?.content;
      const answer = prompt === TAXONOMY_PREFIX ? classifyResult
        : prompt === SCREENING_PREFIX ? screenResult
          : prompt === DRAFT_PREFIX ? draftResult : null;
      return new Response(JSON.stringify({
        choices: [{ finish_reason: "stop", message: { content: JSON.stringify(answer) } }],
      }), { status: 200 });
    };
    const { ai, requests } = await managerWithConfig(CONFIG, { fetchResponder: responder });
    const status = await ai.save(goWrite({
      apiKey: TEST_KEY, classifyModel: "deepseek-v4.1-flash", draftModel: "kimi-k3",
    }));

    expect(status.available).toBe(true);
    expect(status.unavailableReason).toBeNull();
    expect(status.contentGoesTo).toBe("opencode-go");
    const classifier = ai.classifier();
    expect(classifier).toBeTruthy();
    const classifyInput = {
      from: { name: "Synthetic sender", address: "sender@example.test" },
      subject: "Synthetic subject", snippet: "Synthetic snippet", headersDigest: "fixture headers", fewShot: [],
    };
    const classification = await classifier!.classify(classifyInput);
    const screening = await classifier!.screen!(classifyInput);
    const draft = await ai.drafter()!.draft({
      incoming: { subject: "Synthetic question", from: "sender@example.test", snippet: "Synthetic context" },
      context: { kbEntries: [], threadMessages: [] },
    });

    expect(classification).toEqual(classifyResult);
    expect(screening).toEqual(screenResult);
    expect(draft).toEqual(draftResult);
    const inference = requests.slice(1);
    expect(inference).toHaveLength(3);
    expect(inference.map(({ url, method, authorization, userAgent, opencodeClient, redirect }) => ({
      url, method, authorization, userAgent, opencodeClient, redirect,
    }))).toEqual(Array.from({ length: 3 }, () => ({
      url: "https://opencode.ai/inference/go/v1/chat/completions",
      method: "POST",
      authorization: `Bearer ${TEST_KEY}`,
      userAgent: "ohmail-desktop",
      opencodeClient: "ohmail",
      redirect: "error",
    })));
    expect(inference.map(({ opencodeSession }) => opencodeSession)).toEqual(
      Array.from({ length: 3 }, () => expect.stringMatching(/^ohmail-[0-9a-f-]{36}$/i)),
    );
    const [classifyBody, screenBody, draftBody] = inference.map((request) =>
      JSON.parse(String(request.body)) as Record<string, unknown>);
    expect(classifyBody).toMatchObject({
      model: "deepseek-v4.1-flash",
      max_tokens: 512,
      temperature: 0,
      response_format: { type: "json_schema", json_schema: { name: "routing", strict: true, schema: CLASSIFY_RESULT_SCHEMA } },
    });
    expect((classifyBody.messages as Array<Record<string, string>>)[0]).toEqual({ role: "system", content: TAXONOMY_PREFIX });
    expect(screenBody).toMatchObject({
      model: "deepseek-v4.1-flash",
      max_tokens: 512,
      temperature: 0,
      response_format: { type: "json_schema", json_schema: { name: "screening", strict: true, schema: SCREENING_RESULT_SCHEMA } },
    });
    expect((screenBody.messages as Array<Record<string, string>>)[0]).toEqual({ role: "system", content: SCREENING_PREFIX });
    expect(draftBody).toMatchObject({
      model: "kimi-k3",
      max_tokens: 2048,
      temperature: 0,
      response_format: { type: "json_schema", json_schema: { name: "reply_draft", strict: true, schema: DRAFT_RESULT_SCHEMA } },
    });
    expect((draftBody.messages as Array<Record<string, string>>)[0]).toEqual({ role: "system", content: DRAFT_PREFIX });
  });

  it.each([
    ["an extra property", JSON.stringify({ destination: "ohmail/Receipts", confidence: 0.8, rationale: "fixture", spam: false, extra: "discard me" })],
    ["a missing property", JSON.stringify({ destination: "ohmail/Receipts", confidence: 0.8, rationale: "fixture" })],
    ["a wrong property type", JSON.stringify({ destination: "ohmail/Receipts", confidence: "0.8", rationale: "fixture", spam: false })],
    ["an unknown destination", JSON.stringify({ destination: "opencode-go/unknown", confidence: 0.8, rationale: "fixture", spam: false })],
    ["a non-finite number", '{"destination":"ohmail/Receipts","confidence":1e999,"rationale":"fixture","spam":false}'],
    ["reasoning without final JSON", "Let me think through the message before answering."],
  ])("rejects classifier output with %s instead of coercing it", async (_case, content) => {
    const { ai } = await managerWithConfig(CONFIG, {
      fetchResponder: goInferenceResponder(chatReply(content)),
    });
    await ai.save(goWrite({
      apiKey: TEST_KEY, classifyModel: "deepseek-v4.1-flash", draftModel: "kimi-k3",
    }));

    await expect(ai.classifier()!.classify(SYNTHETIC_CLASSIFIER_INPUT)).rejects.toThrow();
  });

  it("rejects screening output outside its distinct screening schema", async () => {
    const routingOnly = JSON.stringify({
      destination: "ohmail/Screener", confidence: 0.8, rationale: "fixture", spam: false,
    });
    const { ai } = await managerWithConfig(CONFIG, {
      fetchResponder: goInferenceResponder(chatReply(routingOnly)),
    });
    await ai.save(goWrite({
      apiKey: TEST_KEY, classifyModel: "deepseek-v4.1-flash", draftModel: "kimi-k3",
    }));

    await expect(ai.classifier()!.screen!(SYNTHETIC_CLASSIFIER_INPUT)).rejects.toThrow();
  });

  it("rejects incomplete draft output rather than filling missing fields during coercion", async () => {
    const incompleteDraft = JSON.stringify({ subject: "Re: fixture", rationale: "fixture" });
    const { ai } = await managerWithConfig(CONFIG, {
      fetchResponder: goInferenceResponder(chatReply(incompleteDraft)),
    });
    await ai.save(goWrite({
      apiKey: TEST_KEY, classifyModel: "deepseek-v4.1-flash", draftModel: "kimi-k3",
    }));

    await expect(ai.drafter()!.draft({
      incoming: { subject: "Synthetic question", from: "sender@example.test", snippet: "Synthetic context" },
      context: { kbEntries: [], threadMessages: [] },
    })).rejects.toThrow();
  });

  it.each([
    ["a refusal", chatReply(JSON.stringify({ destination: "ohmail/Receipts", confidence: 0.8, rationale: "fixture", spam: false }), { refusal: "synthetic refusal text" })],
    ["a truncated final answer", chatReply(JSON.stringify({ destination: "ohmail/Receipts", confidence: 0.8, rationale: "fixture", spam: false }), { finishReason: "length" })],
  ])("fails closed on %s without treating it as valid JSON", async (_case, reply) => {
    const { ai } = await managerWithConfig(CONFIG, { fetchResponder: goInferenceResponder(reply) });
    await ai.save(goWrite({
      apiKey: TEST_KEY, classifyModel: "deepseek-v4.1-flash", draftModel: "kimi-k3",
    }));

    await expect(ai.classifier()!.classify(SYNTHETIC_CLASSIFIER_INPUT))
      .rejects.toBeInstanceOf(ModelDeclinedError);
  });

  it("keeps refusal content and synthetic mailbox context out of errors and background diagnostics", async () => {
    const refusalMarker = "private-refusal-body-fixture";
    const mailboxMarker = "synthetic-private-mail-context";
    const validJson = JSON.stringify({
      destination: "ohmail/Receipts", confidence: 0.8, rationale: "fixture", spam: false,
    });
    const { ai, requests, diagnostics } = await managerWithConfig(CONFIG, {
      fetchResponder: goInferenceResponder(chatReply(validJson, { refusal: refusalMarker })),
    });
    await ai.save(goWrite({
      apiKey: TEST_KEY, classifyModel: "deepseek-v4.1-flash", draftModel: "kimi-k3",
    }));

    const cycle = ai.classifierForCycle();
    expect(cycle).toBeTruthy();
    let failure: unknown;
    try {
      await cycle!.classify({ ...SYNTHETIC_CLASSIFIER_INPUT, subject: mailboxMarker });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(ModelDeclinedError);
    expect(String(failure)).not.toContain(refusalMarker);
    expect(String(failure)).not.toContain(mailboxMarker);
    expect(JSON.stringify(diagnostics)).not.toContain(refusalMarker);
    expect(JSON.stringify(diagnostics)).not.toContain(mailboxMarker);
    expect(JSON.stringify(diagnostics)).not.toContain(TEST_KEY);
    expect(requests).toHaveLength(2);
  });

  it("reports an inference failure without response-body leakage, retry, or provider fallback", async () => {
    const responseMarker = "private-inference-error-body-fixture";
    const { ai, requests, diagnostics } = await managerWithConfig(CONFIG, {
      fetchResponder: async (input) => String(input) === "https://opencode.ai/console/api/v2/config"
        ? new Response(JSON.stringify(CONFIG), { status: 200 })
        : new Response(responseMarker, { status: 429 }),
    });
    await ai.save(goWrite({
      apiKey: TEST_KEY, classifyModel: "deepseek-v4.1-flash", draftModel: "kimi-k3",
    }));

    let directFailure: unknown;
    try {
      await ai.classifier()!.classify(SYNTHETIC_CLASSIFIER_INPUT);
    } catch (error) {
      directFailure = error;
    }
    expect(directFailure).toBeInstanceOf(Error);
    expect(String(directFailure)).toContain("429");
    expect(String(directFailure)).not.toContain(responseMarker);
    expect(String(directFailure)).not.toContain(TEST_KEY);

    const cycle = ai.classifierForCycle();
    expect(cycle).toBeTruthy();
    let cycleFailure: unknown;
    try {
      await cycle!.classify(SYNTHETIC_CLASSIFIER_INPUT);
    } catch (error) {
      cycleFailure = error;
    }
    expect(cycleFailure).toBeInstanceOf(Error);
    expect(String(cycleFailure)).not.toContain(responseMarker);
    expect(String(cycleFailure)).not.toContain(TEST_KEY);

    expect(requests).toHaveLength(3);
    expect(requests.map(({ url }) => url)).toEqual([
      "https://opencode.ai/console/api/v2/config",
      "https://opencode.ai/inference/go/v1/chat/completions",
      "https://opencode.ai/inference/go/v1/chat/completions",
    ]);
    const diagnosticText = diagnostics.map(({ event, detail }) => `${event} ${String(detail.err ?? "")}`).join(" ");
    expect(diagnosticText).toContain("429");
    expect(diagnosticText).not.toContain(responseMarker);
    expect(diagnosticText).not.toContain(TEST_KEY);
    expect(diagnosticText).not.toContain(SYNTHETIC_CLASSIFIER_INPUT.subject);
  });

  it("bounds Go inference with the configured deadline and exposes no transport details", async () => {
    const { ai, requests } = await managerWithConfig(CONFIG, {
      timeoutMs: 5,
      fetchResponder: async (input, init) => {
        if (String(input) === "https://opencode.ai/console/api/v2/config") {
          return new Response(JSON.stringify(CONFIG), { status: 200 });
        }
        return new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (!signal) {
            reject(new Error("request missing deadline"));
          } else if (signal.aborted) {
            reject(signal.reason);
          } else {
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          }
        });
      },
    });
    await ai.save(goWrite({
      apiKey: TEST_KEY, classifyModel: "deepseek-v4.1-flash", draftModel: "kimi-k3",
    }));

    let failure: unknown;
    try {
      await ai.classifier()!.classify(SYNTHETIC_CLASSIFIER_INPUT);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect(failure).toMatchObject({ name: "TimeoutError" });
    expect(String(failure)).not.toContain(TEST_KEY);
    expect(String(failure)).not.toContain(SYNTHETIC_CLASSIFIER_INPUT.subject);
    expect(requests).toHaveLength(2);
    expect(requests[1]).toMatchObject({
      url: "https://opencode.ai/inference/go/v1/chat/completions",
      redirect: "error",
    });
    expect(requests[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("keeps Go background faults inside the existing cooldown and rules-only degradation gate", async () => {
    const { ai } = await managerWithConfig(CONFIG, {
      faultThreshold: 1,
      cooldownMs: 60_000,
      fetchResponder: async (input) => String(input) === "https://opencode.ai/console/api/v2/config"
        ? new Response(JSON.stringify(CONFIG), { status: 200 })
        : new Response("synthetic provider failure", { status: 503 }),
    });
    const status = await ai.save(goWrite({
      apiKey: TEST_KEY, classifyModel: "deepseek-v4.1-flash", draftModel: "kimi-k3",
    }));
    expect(status.available).toBe(true);

    const cycle = ai.classifierForCycle();
    expect(cycle).toBeTruthy();
    await expect(cycle!.classify(SYNTHETIC_CLASSIFIER_INPUT)).rejects.toThrow("classifier call failed");
    expect(ai.classifierForCycle()).toBeUndefined();
  });

  it("saves the dedicated key and reads only Go model IDs from the fixed config endpoint", async () => {
    const { ai, dataDir, requests, diagnostics } = await managerWithConfig();

    const status = await ai.save(goWrite({ apiKey: TEST_KEY }));

    expect(status.provider).toBe("opencode-go");
    expect(status.contentGoesTo).toBe("opencode-go");
    expect(status.settings.opencodeGo).toEqual({ classifyModel: "", draftModel: "", hasKey: true });
    expect(status.probe).toMatchObject({
      ok: true,
      reason: null,
      detail: null,
      models: DOCUMENTED_GO_CHAT_MODELS,
    });
    expect(status.available).toBe(false);
    expect(status.unavailableReason).toBe("unverified");
    expect(JSON.stringify(status)).not.toContain(TEST_KEY);
    expect(ai.classifier()).toBeUndefined();
    expect(ai.drafter()).toBeUndefined();
    expect(ai.classifierForCycle()).toBeUndefined();

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      url: "https://opencode.ai/console/api/v2/config",
      method: "GET",
      authorization: `Bearer ${TEST_KEY}`,
      userAgent: "ohmail-desktop",
      redirect: "error",
      body: undefined,
    });
    expect(status.probe?.models).toContain("glm-5.3-flash");
    expect(status.probe?.models).not.toContain("grok-4.6");
    expect(status.probe?.models).not.toContain("undocumented-private-model");
    expect(status.probe?.models).not.toContain("other-provider-private-model");
    expect(JSON.stringify(status)).not.toContain("discard-this-workspace-setting");

    const saved = await readFile(join(dataDir, AI_STORE_FILE), "utf8");
    expect(JSON.parse(saved)).toMatchObject({ version: 1, provider: "opencode-go" });
    expect(saved).not.toContain(TEST_KEY);
    expect(saved).not.toContain("discard-this-workspace-setting");
    expect(saved).not.toContain("other-provider-private-model");
    expect(JSON.stringify(diagnostics)).not.toContain(TEST_KEY);

    // Rendering/status is a local read. Explicit Verify repeats the same config-only request.
    expect(ai.status().probe?.ok).toBe(true);
    expect(ai.status().unavailableReason).toBe("unverified");
    expect(requests).toHaveLength(1);
    const verified = await ai.verify();
    expect(verified.probe?.ok).toBe(true);
    expect(verified.unavailableReason).toBe("unverified");
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request).toMatchObject({
        url: "https://opencode.ai/console/api/v2/config",
        method: "GET",
        authorization: `Bearer ${TEST_KEY}`,
        userAgent: "ohmail-desktop",
        redirect: "error",
        body: undefined,
      });
      expect(request.signal).toBeInstanceOf(AbortSignal);
    }
    expect(JSON.stringify(diagnostics)).not.toContain("discard-this-workspace-setting");
  });

  it("fails safely when the workspace does not list a configured supported model", async () => {
    const config = {
      providers: {
        "opencode-go": { models: { "deepseek-v4.1-flash": { name: "Flash" } } },
      },
      account: { privateMarker: "never-retain-this" },
    };
    const { ai, requests, diagnostics } = await managerWithConfig(config);

    const status = await ai.save(goWrite({ apiKey: TEST_KEY, draftModel: "kimi-k3" }));

    expect(status.probe).toMatchObject({
      ok: false,
      reason: "model_absent",
      models: ["deepseek-v4.1-flash"],
    });
    expect(status.available).toBe(false);
    expect(status.unavailableReason).toBe("unreachable");
    expect(ai.classifier()).toBeUndefined();
    expect(ai.drafter()).toBeUndefined();
    expect(requests).toHaveLength(1);
    expect(JSON.stringify(status)).not.toContain("never-retain-this");
    expect(JSON.stringify(diagnostics)).not.toContain("never-retain-this");
  });

  it.each([
    ["not-json", "bad_response"],
    [JSON.stringify({ providers: [] }), "bad_response"],
    [JSON.stringify({ providers: { "opencode-go": { models: [] } } }), "bad_response"],
    [JSON.stringify({ providers: { "opencode-go": { models: { "undocumented-private-model": {} } } } }), "model_absent"],
  ] as const)("rejects malformed or unsupported workspace config %s safely", async (body, reason) => {
    const { ai, diagnostics } = await managerWithConfig(CONFIG, { responseBody: body });

    const status = await ai.save(goWrite({ apiKey: TEST_KEY }));

    expect(status.probe).toMatchObject({ ok: false, reason, models: [] });
    expect(JSON.stringify(status)).not.toContain("undocumented-private-model");
    expect(JSON.stringify(diagnostics)).not.toContain(body);
  });

  it("rejects undocumented Go model IDs before storing them", async () => {
    const { ai, requests } = await managerWithConfig();

    await expect(ai.save(goWrite({ classifyModel: "opencode-go/deepseek-v4.1-flash" })))
      .rejects.toMatchObject({ code: "invalid_request" });

    expect(requests).toHaveLength(0);
  });

  it.each([
    [401, "unauthorized"],
    [403, "unauthorized"],
    [402, "request_rejected"],
    [429, "request_rejected"],
    [404, "bad_response"],
    [500, "bad_response"],
    [503, "bad_response"],
    [504, "timeout"],
  ] as const)("does not retain or display raw response bodies for HTTP %i", async (httpStatus, reason) => {
    const marker = "private-upstream-response-body-fixture";
    const { ai, requests, diagnostics } = await managerWithConfig(CONFIG, {
      status: httpStatus,
      responseBody: marker,
    });

    const status = await ai.save(goWrite({ apiKey: TEST_KEY }));

    expect(status.probe).toMatchObject({ ok: false, reason, models: [] });
    expect(requests).toHaveLength(1);
    expect(JSON.stringify(status)).not.toContain(marker);
    expect(JSON.stringify(diagnostics)).not.toContain(marker);
  });

  it("maps a bounded request timeout without exposing the thrown transport message", async () => {
    const marker = "private-transport-error-fixture";
    const { ai, diagnostics } = await managerWithConfig(CONFIG, {
      timeoutMs: 5,
      fetchResponder: async (_input, init) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException(marker, "TimeoutError")), { once: true });
      }),
    });

    const status = await ai.save(goWrite({ apiKey: TEST_KEY }));

    expect(status.probe).toMatchObject({ ok: false, reason: "timeout", detail: null, models: [] });
    expect(JSON.stringify(status)).not.toContain(marker);
    expect(JSON.stringify(diagnostics)).not.toContain(marker);
  });

  it("adds Go defaults to v1 settings, preserves other provider envelopes, and forgets stored keys", async () => {
    const existingOpenAiKey = "existing-openai-key-fixture";
    const sealedOpenAiKey = `test-sealed:${Buffer.from(existingOpenAiKey).toString("base64")}`;
    const legacy = {
      version: 1,
      provider: "openai",
      openai: {
        classifyModel: "legacy-classifier",
        draftModel: "legacy-drafter",
        keyEnc: sealedOpenAiKey,
        keyVersion: 4,
      },
      probe: null,
    };
    const { ai, dataDir, requests } = await managerWithConfig(CONFIG, { seed: legacy });

    expect(ai.status().settings.opencodeGo).toEqual({ classifyModel: "", draftModel: "", hasKey: false });
    expect(ai.status().settings.openai).toEqual({
      classifyModel: "legacy-classifier", draftModel: "legacy-drafter", hasKey: true,
    });
    expect(requests).toHaveLength(0);

    const saved = await ai.save(goWrite({ apiKey: TEST_KEY, classifyModel: "deepseek-v4.1-flash", draftModel: "kimi-k3" }));
    expect(saved.settings.opencodeGo).toEqual({
      classifyModel: "deepseek-v4.1-flash", draftModel: "kimi-k3", hasKey: true,
    });
    expect(saved.settings.openai).toEqual({
      classifyModel: "legacy-classifier", draftModel: "legacy-drafter", hasKey: true,
    });
    const persisted = JSON.parse(await readFile(join(dataDir, AI_STORE_FILE), "utf8"));
    expect(persisted.version).toBe(1);
    expect(persisted.openai).toMatchObject({ keyEnc: sealedOpenAiKey, keyVersion: 4 });
    expect(persisted.opencodeGo.keyEnc).toBe(`test-sealed:${Buffer.from(TEST_KEY).toString("base64")}`);
    expect(JSON.stringify(persisted)).not.toContain(TEST_KEY);
    expect(JSON.stringify(persisted)).not.toContain(existingOpenAiKey);

    const blankKeyModelSave = await ai.save(goWrite({
      apiKey: "",
      classifyModel: "deepseek-v4.1-flash",
      draftModel: "kimi-k3",
    }));
    expect(blankKeyModelSave.settings.opencodeGo.hasKey).toBe(true);
    expect(requests).toHaveLength(2);

    const noProvider = await ai.save({ provider: null });
    expect(noProvider.provider).toBeNull();
    expect(noProvider.settings.opencodeGo.hasKey).toBe(true);
    const forgotten = await ai.clear();
    expect(forgotten.settings.opencodeGo.hasKey).toBe(false);
    expect(forgotten.settings.openai.hasKey).toBe(false);
    expect(JSON.stringify(JSON.parse(await readFile(join(dataDir, AI_STORE_FILE), "utf8")))).not.toContain(TEST_KEY);
  });

  it("refuses to store a Go key when the install has no durable key", async () => {
    const { ai, dataDir, requests } = await managerWithConfig(CONFIG, { canStoreKey: false });

    await expect(ai.save(goWrite({ apiKey: TEST_KEY }))).rejects.toMatchObject({ code: "install_key_absent" });

    expect(requests).toHaveLength(0);
    expect(ai.status().settings.opencodeGo.hasKey).toBe(false);
    await expect(readFile(join(dataDir, AI_STORE_FILE), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("the automatic classify path with Go configured", () => {
  /* The sync cycle classifies every new message through classifierForCycle() without a press.
     A subject carrying a one-time code must stop at the shared payload builder: refused before
     anything is sent, so opencode.ai sees no inference request at all. */
  it("sends nothing to opencode.ai for a subject carrying a one-time code", async () => {
    const reply = chatReply(JSON.stringify({
      destination: "ohmail/Receipts", confidence: 0.8, rationale: "synthetic", spam: false,
    }));
    const { ai, requests } = await managerWithConfig(CONFIG, { fetchResponder: goInferenceResponder(reply) });
    const status = await ai.save(goWrite({
      apiKey: TEST_KEY, classifyModel: "deepseek-v4.1-flash", draftModel: "kimi-k3",
    }));
    expect(status.available).toBe(true);
    const before = requests.length;

    const cycle = ai.classifierForCycle();
    expect(cycle).toBeDefined();
    await expect(cycle!.classify({ ...SYNTHETIC_CLASSIFIER_INPUT, subject: "Your login code is 991823" }))
      .rejects.toBeInstanceOf(SensitivePayloadRefusal);
    expect(requests.slice(before)).toEqual([]);

    // The control: the same path with an ordinary subject does reach the chat endpoint.
    await cycle!.classify(SYNTHETIC_CLASSIFIER_INPUT);
    expect(requests.slice(before).map((r) => r.url)).toEqual([
      "https://opencode.ai/inference/go/v1/chat/completions",
    ]);
  });
});
