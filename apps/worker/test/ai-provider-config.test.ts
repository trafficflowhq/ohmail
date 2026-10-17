import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  makeAnthropicClient, makeHaikuClassifier, makeSonnetDrafter,
  type ClassifierInput, type DraftInput, type LogFields, type Logger,
} from "@trafficflow/core";
import { aiProviderLine, loadConfig, WorkerConfigError } from "../src/config.js";
import { anthropicKey, openAiKey } from "../../../test/support/fixture-credentials.js";

/**
 * THE WORKER'S AI BLOCK. Only ANTHROPIC_API_KEY builds the three ports exactly as 0.26.1 did —
 * the request on the wire is compared with that composition's. A self-host provider builds the
 * classifier and the drafter and no proposer. And THE LOCK: a worker that meters (ENTITLEMENTS_URL)
 * refuses any other provider, and any model override, by name.
 */

const KEY = anthropicKey("worker-ai-provider");
const ROLE = "u";
const BASE = { DATABASE_URL_SESSION: `postgres://${ROLE}:p@127.0.0.1:1/none` };
const METERED = { ENTITLEMENTS_URL: "https://plane.example", BILLING_PLANE_SECRET: "worker-ai-lock-fixture-token" };
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
/** A fetch that records what it was asked and answers each provider's shape well enough. */
function recorder(): { seen: Seen[]; fetchImpl: typeof fetch } {
  const seen: Seen[] = [];
  const fetchImpl = (async (url: string | URL | Request, init: RequestInit = {}) => {
    const body = typeof init.body === "string" ? JSON.parse(init.body) : null;
    seen.push({ url: String(url), method: init.method ?? "GET", headers: { ...(init.headers as Record<string, string>) }, body });
    const answer = JSON.stringify({ destination: "ohmail/Screener", confidence: 0.5, rationale: "r", spam: false, subject: "s", body: "b" });
    const reply = String(url).endsWith("/api/chat")
      ? { model: body?.model, message: { content: answer }, prompt_eval_count: 12, eval_count: 3 }
      : { content: [{ type: "text", text: answer }], usage: {} };
    return new Response(JSON.stringify(reply), { status: 200 });
  }) as unknown as typeof fetch;
  return { seen, fetchImpl };
}

function capturingLogger(): { log: Logger; lines: Array<{ event: string; fields: LogFields }> } {
  const lines: Array<{ event: string; fields: LogFields }> = [];
  const at = () => (event: string, fields: LogFields = {}) => { lines.push({ event, fields }); };
  const log: Logger = { level: "debug", child() { return log; }, debug: at(), info: at(), warn: at(), error: at() };
  return { log, lines };
}

const refusal = (env: Record<string, string>): WorkerConfigError => {
  try {
    loadConfig({ ...BASE, ...env });
  } catch (e) {
    if (e instanceof WorkerConfigError) return e;
    throw e;
  }
  throw new Error("expected loadConfig to refuse");
};

afterEach(() => { vi.unstubAllGlobals(); });

describe("only ANTHROPIC_API_KEY — the 0.26.1 composition, on the wire", () => {
  it("classify and draft send exactly what the hosted builders over one client sent", async () => {
    const lane = recorder();
    vi.stubGlobal("fetch", lane.fetchImpl);
    const cfg = loadConfig({ ...BASE, ANTHROPIC_API_KEY: KEY });
    expect(cfg.aiProvider).toBe("anthropic");
    expect(cfg.proposer, "the proposer is part of the Anthropic branch").toBeDefined();
    await cfg.classifier!.classify(input());
    await cfg.drafter!.draft(draftInput());

    const ref = recorder();
    const client = makeAnthropicClient({ apiKey: KEY, timeoutMs: 30_000, onUsage: () => {}, fetchImpl: ref.fetchImpl });
    await makeHaikuClassifier({ client }).classify(input());
    await makeSonnetDrafter(client).draft(draftInput());

    expect(lane.seen).toHaveLength(2);
    expect(lane.seen).toEqual(ref.seen);
  });
});

describe("a self-host provider", () => {
  it("builds the classifier and the drafter, no proposer, and its ai_call line carries no cost", async () => {
    const { seen, fetchImpl } = recorder();
    vi.stubGlobal("fetch", fetchImpl);
    const { log, lines } = capturingLogger();
    const cfg = loadConfig({ ...BASE, ...OLLAMA }, { log: () => log });
    expect(cfg.aiProvider).toBe("ollama");
    expect(cfg.proposer, "no proposer off Anthropic: the cron runs unconfigured").toBeUndefined();
    await cfg.classifier!.screen!(input());
    await cfg.drafter!.draft(draftInput());
    expect(seen.map((s) => s.url)).toEqual(["http://ollama:11434/api/chat", "http://ollama:11434/api/chat"]);
    const calls = lines.filter((l) => l.event === "ai_call").map((l) => l.fields);
    expect(calls).toHaveLength(2);
    for (const c of calls) expect(c).toMatchObject({ model: "llama3.2", ok: true, costMicroUsd: null, requestId: null });
  });

  it("refuses a model server on this network without TF_AI_ALLOW_PRIVATE, naming both", () => {
    const r = refusal({ TF_AI_PROVIDER: "ollama", OLLAMA_BASE_URL: "http://ollama:11434" });
    expect(r.configVar).toBe("OLLAMA_BASE_URL");
    expect(r.remedy).toContain("TF_AI_ALLOW_PRIVATE");
  });
});

describe("THE LOCK: a worker that meters runs Anthropic on its shipped models", () => {
  it("refuses another provider by name", () => {
    expect(refusal({ ...METERED, ...OLLAMA }).configVar).toBe("TF_AI_PROVIDER");
    expect(refusal({ ...METERED, TF_AI_PROVIDER: "openai", OPENAI_API_KEY: openAiKey("worker-lock") }).configVar)
      .toBe("TF_AI_PROVIDER");
  });

  it("refuses a model override by name, either one", () => {
    // Models the request rules know, so the resolver takes them and only the lock refuses.
    for (const [variable, model] of [["TF_AI_CLASSIFY_MODEL", "claude-haiku-4-5-20251001"], ["TF_AI_DRAFT_MODEL", "claude-sonnet-5"]]) {
      expect(loadConfig({ ...BASE, ANTHROPIC_API_KEY: KEY, [variable!]: model! }).aiProvider, `${variable} unmetered`).toBe("anthropic");
      const r = refusal({ ...METERED, ANTHROPIC_API_KEY: KEY, [variable!]: model! });
      expect([r.configVar, r.message.includes("ENTITLEMENTS_URL is set")]).toEqual([variable, true]);
    }
  });

  it("boots on Anthropic, named or not, and with no AI at all", () => {
    expect(loadConfig({ ...BASE, ...METERED, ANTHROPIC_API_KEY: KEY }).aiProvider).toBe("anthropic");
    expect(loadConfig({ ...BASE, ...METERED, TF_AI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: KEY }).aiProvider).toBe("anthropic");
    expect(loadConfig({ ...BASE, ...METERED }).aiProvider).toBeNull();
  });

  it("and the same provider boots where nothing meters", () => {
    expect(loadConfig({ ...BASE, ...OLLAMA }).classifier).toBeDefined();
  });
});

describe("the boot line: the provider, its address kind, and whether this worker meters", () => {
  it("states metered either way", () => {
    expect(aiProviderLine(loadConfig({ ...BASE, ...METERED, ANTHROPIC_API_KEY: KEY })))
      .toEqual({ kind: "anthropic", aiEndpoint: "default", metered: true });
    expect(aiProviderLine(loadConfig({ ...BASE, ANTHROPIC_API_KEY: KEY })))
      .toEqual({ kind: "anthropic", aiEndpoint: "default", metered: false });
    expect(aiProviderLine(loadConfig({ ...BASE, ...METERED }))).toEqual({ kind: "none", metered: true });
  });

  it("a gateway or a model server is custom, and the line never carries the address", () => {
    const gateway = aiProviderLine(loadConfig({ ...BASE, ANTHROPIC_API_KEY: KEY, ANTHROPIC_BASE_URL: "https://gateway.worker-line.example" }));
    const ollama = aiProviderLine(loadConfig({ ...BASE, ...OLLAMA }));
    expect(gateway).toEqual({ kind: "anthropic", aiEndpoint: "custom", metered: false });
    expect(ollama).toEqual({ kind: "ollama", aiEndpoint: "custom", metered: false });
    expect(JSON.stringify([gateway, ollama])).not.toMatch(/gateway\.worker-line|ollama:11434/);
  });

  it("the worker logs that line at boot", () => {
    const src = readFileSync(fileURLToPath(new URL("../src/index.ts", import.meta.url)), "utf8");
    expect(src).toContain('cliLog.info("ai_provider_configured", aiProviderLine(config));');
  });
});

describe("THE METER: a worker beside the billing plane never boots without ENTITLEMENTS_URL", () => {
  // BILLING_PLANE_SECRET is the marker the managed deploy alone sets; the value is a fixture.
  const MARKER = { BILLING_PLANE_SECRET: METERED.BILLING_PLANE_SECRET };

  it("the marker with ENTITLEMENTS_URL unset, empty or blank refuses by name, AI or not", () => {
    for (const url of [undefined, "", "   "]) {
      for (const ai of [{}, { ANTHROPIC_API_KEY: KEY }]) {
        const r = refusal({ ...MARKER, ...ai, ...(url === undefined ? {} : { ENTITLEMENTS_URL: url }) });
        expect([r.configVar, r.message.includes("BILLING_PLANE_SECRET"), r.remedy?.includes("ENTITLEMENTS_URL")], JSON.stringify(url))
          .toEqual(["ENTITLEMENTS_URL", true, true]);
      }
    }
  });

  it("an emptied marker is still the marker: present at all, the meter must be there", () => {
    expect(refusal({ BILLING_PLANE_SECRET: "", ANTHROPIC_API_KEY: KEY }).configVar).toBe("ENTITLEMENTS_URL");
    expect(refusal({ BILLING_PLANE_SECRET: "", ENTITLEMENTS_URL: "" }).configVar).toBe("ENTITLEMENTS_URL");
  });

  it("CONTROL: without the marker a self-hosted organizer boots unmetered; with both it meters", () => {
    expect(aiProviderLine(loadConfig({ ...BASE, ANTHROPIC_API_KEY: KEY })).metered).toBe(false);
    expect(aiProviderLine(loadConfig({ ...BASE, ENTITLEMENTS_URL: "", ANTHROPIC_API_KEY: KEY })).metered).toBe(false);
    expect(aiProviderLine(loadConfig({ ...BASE, ...METERED, ANTHROPIC_API_KEY: KEY })).metered).toBe(true);
  });
});
