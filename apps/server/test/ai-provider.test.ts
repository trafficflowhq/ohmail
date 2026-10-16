import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  makeAnthropicClient, makeHaikuClassifier, makeSonnetDrafter, silentLogger,
  type AnthropicCallReport, type ClassifierInput, type DraftInput,
} from "@trafficflow/core";
import { loadServerConfig } from "../src/config.js";
import { buildDeps, serverAiPorts, type ServerRuntime } from "../src/deps.js";
import { KEY_RING_V1 } from "../../../test/support/key-ring-env.js";
import { anthropicKey } from "../../../test/support/fixture-credentials.js";

/**
 * THE SERVER'S AI BLOCK. Only ANTHROPIC_API_KEY arms the classifier and the drafter exactly as
 * 0.26.1 did — compared on the wire with that composition, two clients at 10 s and 25 s with one
 * retry. A self-host provider arms both through the shared transports, its `ai_call` reports
 * carry the model and no cost, and `/hello` says `ai: true` without saying which.
 */

const KEY = anthropicKey("server-ai-provider");
const DB_ROLE = "ohmail";
const env = (over: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  OHMAIL_ORIGIN: "https://mail.example.com",
  DATABASE_URL: `postgres://${DB_ROLE}:pw@db:5432/ohmail`,
  [KEY_RING_V1]: "ab".repeat(32),
  ...over,
} as NodeJS.ProcessEnv);
const OLLAMA = { TF_AI_PROVIDER: "ollama", OLLAMA_BASE_URL: "http://ollama:11434", TF_AI_ALLOW_PRIVATE: "1" };

const input = (): ClassifierInput => ({
  from: { name: null, address: "news@example.test" }, subject: "This week's roundup",
  snippet: "the weekly roundup", headersDigest: "list-id present",
});
const draftInput = (): DraftInput => ({
  incoming: { subject: "Question", from: "her@example.test", snippet: "when are you free?" },
  context: { kbEntries: [], threadMessages: [] },
});

interface Seen { url: string; method: string; headers: Record<string, string>; body: unknown }
function recorder(): { seen: Seen[]; fetchImpl: typeof fetch } {
  const seen: Seen[] = [];
  const fetchImpl = (async (url: string | URL | Request, init: RequestInit = {}) => {
    const body = typeof init.body === "string" ? JSON.parse(init.body) : null;
    seen.push({ url: String(url), method: init.method ?? "GET", headers: { ...(init.headers as Record<string, string>) }, body });
    const answer = JSON.stringify({ destination: "ohmail/Screener", confidence: 0.5, rationale: "r", spam: false, subject: "s", body: "b" });
    const reply = String(url).endsWith("/api/chat")
      ? { model: body?.model, message: { content: answer } }
      : { content: [{ type: "text", text: answer }], usage: {} };
    return new Response(JSON.stringify(reply), { status: 200 });
  }) as unknown as typeof fetch;
  return { seen, fetchImpl };
}

describe("only ANTHROPIC_API_KEY — the 0.26.1 composition", () => {
  it("resolves to the Anthropic branch with nothing else set", () => {
    const cfg = loadServerConfig(env({ ANTHROPIC_API_KEY: KEY }));
    expect(cfg.ai).toEqual({
      provider: "anthropic", apiKey: KEY, baseUrl: null, allowPrivate: false, classifyModel: null, draftModel: null,
    });
    expect(cfg.aiTimeoutMs).toBeNull();
  });

  it("a suggestion and a draft send exactly what the two hosted clients sent", async () => {
    const cfg = loadServerConfig(env({ ANTHROPIC_API_KEY: KEY }));
    const lane = recorder();
    const ports = serverAiPorts(cfg, () => {}, lane.fetchImpl);
    await ports.classifier!.screen!(input());
    await ports.drafter!.draft(draftInput());

    const ref = recorder();
    const client = (timeoutMs: number) =>
      makeAnthropicClient({ apiKey: KEY, timeoutMs, maxRetries: 1, onUsage: () => {}, fetchImpl: ref.fetchImpl });
    await makeHaikuClassifier({ client: client(10_000) }).screen!(input());
    await makeSonnetDrafter(client(25_000)).draft(draftInput());

    expect(lane.seen).toHaveLength(2);
    expect(lane.seen).toEqual(ref.seen);
  });

  it("a suggestion gets 10 s an attempt and a draft 25 s, each with one retry", async () => {
    const cfg = loadServerConfig(env({ ANTHROPIC_API_KEY: KEY }));
    let attempts = 0;
    // Overloaded, retry at once: every attempt the client is allowed is made, and none answers.
    const busy = (async () => {
      attempts += 1;
      return new Response("{}", { status: 529, headers: { "retry-after": "0" } });
    }) as unknown as typeof fetch;
    const ports = serverAiPorts(cfg, () => {}, busy);
    const deadlines = vi.spyOn(AbortSignal, "timeout");
    try {
      await expect(ports.classifier!.screen!(input())).rejects.toThrow();
      expect([attempts, deadlines.mock.calls.map(([ms]) => ms)]).toEqual([2, [10_000, 10_000]]);
      attempts = 0;
      deadlines.mockClear();
      await expect(ports.drafter!.draft(draftInput())).rejects.toThrow();
      expect([attempts, deadlines.mock.calls.map(([ms]) => ms)]).toEqual([2, [25_000, 25_000]]);
    } finally {
      deadlines.mockRestore();
    }
  });

  it("no key, no provider: no ports, and /hello says so", () => {
    const cfg = loadServerConfig(env());
    expect(cfg.ai).toBeNull();
    expect(serverAiPorts(cfg, () => {})).toEqual({});
    expect(helloAi(cfg)).toBe(false);
  });
});

describe("a self-host provider", () => {
  it("arms both ports through the transport, and reports the model with no cost", async () => {
    const cfg = loadServerConfig(env(OLLAMA));
    const { seen, fetchImpl } = recorder();
    const reports: AnthropicCallReport[] = [];
    const ports = serverAiPorts(cfg, (r) => { reports.push(r); }, fetchImpl);
    await ports.classifier!.screen!(input());
    await ports.drafter!.draft(draftInput());
    expect(seen.map((s) => s.url)).toEqual(["http://ollama:11434/api/chat", "http://ollama:11434/api/chat"]);
    expect(reports.map((r) => [r.model, r.ok, r.costMicroUsd, r.requestId])).toEqual([
      ["llama3.2", true, null, null], ["llama3.2", true, null, null],
    ]);
    expect(helloAi(cfg), "/hello names a model is configured, never which").toBe(true);
  });

  it("refuses the boot on a model server it may not reach, naming both variables", () => {
    let message = "";
    try { loadServerConfig(env({ TF_AI_PROVIDER: "ollama", OLLAMA_BASE_URL: "http://ollama:11434" })); } catch (e) { message = (e as Error).message; }
    expect(message).toContain("OLLAMA_BASE_URL");
    expect(message).toContain("TF_AI_ALLOW_PRIVATE");
  });

  it("reads TF_AI_TIMEOUT_MS, and refuses one that is not a number without echoing it", () => {
    expect(loadServerConfig(env({ ...OLLAMA, TF_AI_TIMEOUT_MS: "90000" })).aiTimeoutMs).toBe(90_000);
    let message = "";
    try { loadServerConfig(env({ ...OLLAMA, TF_AI_TIMEOUT_MS: "soon" })); } catch (e) { message = (e as Error).message; }
    expect(message).toContain("TF_AI_TIMEOUT_MS");
    expect(message).not.toContain("soon");
  });
});

describe("the boot line", () => {
  it("the server logs ai_provider_configured from the resolved choice, before it migrates", () => {
    const src = readFileSync(fileURLToPath(new URL("../src/index.ts", import.meta.url)), "utf8");
    const at = src.indexOf('logger.info("ai_provider_configured", aiBootFields(cfg.ai));');
    expect(at, "the boot line is not logged from aiBootFields(cfg.ai)").toBeGreaterThan(0);
    expect(at).toBeLessThan(src.indexOf('logger.info("boot_migrating")'));
  });
});

/** `/hello`'s `features.ai` for a config, through the real descriptor builder. */
function helloAi(cfg: ReturnType<typeof loadServerConfig>): boolean {
  const rt = {
    cfg, db: {} as never, services: {} as never, changeWake: null, oauth: {} as never,
    onSetupTokenMinted: () => {}, logger: silentLogger,
  } as unknown as ServerRuntime;
  return buildDeps(new Request("https://mail.example.com/hello"), rt).hello!.features.ai;
}
