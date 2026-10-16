import { describe, expect, it } from "vitest";
import type { AnthropicCallReport, ClassifierInput, DraftInput } from "../../../src/mail.js";
import { ollamaTransport, openaiTransport, type AiTransport } from "../../../src/ai/transports/index.js";
import { aiProviderEnv, portsOf, transportFor } from "../../../src/ai/transports/host.js";
import { openAiKey } from "../../../../../test/support/fixture-credentials.js";

/**
 * WHAT THE SERVER AND THE WORKER HOLD: a transport as two ports. `screen` is optional on the
 * classifier port and a port without it falls back to `classify` with no error, so `portsOf` is
 * held to forward the SCREENING question to the transport's own `screen`. The usage report is the
 * hosted client's shape with the request id and the cost unknown.
 */

const input = (): ClassifierInput => ({
  from: { name: null, address: "news@example.test" }, subject: "This week's roundup",
  snippet: "the weekly roundup", headersDigest: "list-id present",
});
const draftInput = (): DraftInput => ({
  incoming: { subject: "Question", from: "her@example.test", snippet: "when are you free?" },
  context: { kbEntries: [], threadMessages: [] },
});
const VERDICT = { destination: "ohmail/Screener", confidence: 0.5, rationale: "r", spam: false };
const DRAFT = { subject: "s", body: "b", rationale: "r" };

describe("portsOf", () => {
  it("is a full classifier port, and each question reaches its own method", async () => {
    const asked: string[] = [];
    const t: AiTransport = {
      classify: async () => { asked.push("classify"); return VERDICT; },
      screen: async () => { asked.push("screen"); return VERDICT; },
      draft: async () => { asked.push("draft"); return DRAFT; },
      probe: async () => ({ ok: true, reason: null, detail: null, models: [] }),
    };
    const { classifier, drafter } = portsOf(t);
    expect(typeof classifier.screen, "a port without `screen` asks the Screener the routing question").toBe("function");
    await classifier.classify(input());
    await classifier.screen(input());
    await drafter.draft(draftInput());
    expect(asked).toEqual(["classify", "screen", "draft"]);
  });
});

/** A chat-completions answer (OpenAI's shape, which OpenCode Go speaks too) or an Ollama one. */
function answering(kind: "chat" | "ollama", content: unknown): { urls: string[]; fetchImpl: typeof fetch } {
  const urls: string[] = [];
  const fetchImpl = (async (url: string | URL | Request, init: RequestInit = {}) => {
    urls.push(String(url));
    const { model } = JSON.parse(String(init.body)) as { model: string };
    const text = JSON.stringify(content);
    const reply = kind === "ollama"
      ? { model, message: { content: text }, prompt_eval_count: 40, eval_count: 9 }
      : { model: `${model}-2026`, choices: [{ message: { content: text }, finish_reason: "stop" }], usage: { prompt_tokens: 40, completion_tokens: 9 } };
    return new Response(JSON.stringify(reply), { status: 200 });
  }) as unknown as typeof fetch;
  return { urls, fetchImpl };
}

describe("the usage report a transport hands its host", () => {
  it("names the model that answered and the tokens it counted, with no request id and no cost", async () => {
    const reports: AnthropicCallReport[] = [];
    const t = openaiTransport({
      apiKey: openAiKey("transport-usage"), classifyModel: "gpt-4.1-mini", draftModel: "gpt-4.1",
      fetchImpl: answering("chat", VERDICT).fetchImpl, timeoutMs: 2000, onUsage: (r) => { reports.push(r); },
    });
    await t.classify(input());
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      model: "gpt-4.1-mini-2026", ok: true, status: 200, attempts: 1, requestId: null,
      inputTokens: 40, outputTokens: 9, costMicroUsd: null,
    });
  });

  it("reports a failed call too, once, and a reporter that throws is not the call's outcome", async () => {
    const reports: AnthropicCallReport[] = [];
    const failing = (async () => new Response("{}", { status: 503 })) as unknown as typeof fetch;
    const t = ollamaTransport({
      baseUrl: "http://ollama:11434", classifyModel: "llama3.2", draftModel: "llama3.2", fetchImpl: failing, timeoutMs: 2000,
      onUsage: (r) => { reports.push(r); throw new Error("a broken reporter"); },
    });
    await expect(t.screen(input())).rejects.toThrow(/503/);
    expect(reports.map((r) => [r.ok, r.status, r.costMicroUsd])).toEqual([[false, 503, null]]);
  });
});

describe("transportFor", () => {
  it("takes each resolved choice to its own transport and nowhere else", async () => {
    const go = aiProviderEnv({
      TF_AI_PROVIDER: "opencode-go", OPENCODE_GO_API_KEY: "transport-for-fixture-token",
      TF_AI_CLASSIFY_MODEL: "glm-5.3-flash", TF_AI_DRAFT_MODEL: "kimi-k3",
    });
    const ollama = aiProviderEnv({ TF_AI_PROVIDER: "ollama", OLLAMA_BASE_URL: "http://ollama:11434", TF_AI_ALLOW_PRIVATE: "1" });
    const cases = [
      [go, "chat", "https://opencode.ai/inference/go/v1/chat/completions"],
      [ollama, "ollama", "http://ollama:11434/api/chat"],
    ] as const;
    for (const [ai, kind, url] of cases) {
      if (ai === null || ai.provider === "anthropic") throw new Error("resolved to the wrong branch");
      const { urls, fetchImpl } = answering(kind, DRAFT);
      expect(await transportFor(ai, { fetchImpl, timeoutMs: 2000 }).draft(draftInput())).toEqual(DRAFT);
      expect(urls).toEqual([url]);
    }
  });
});
