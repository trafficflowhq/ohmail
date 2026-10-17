import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { OPENCODE_GO_MODEL_IDS } from "../../../src/ai/transports/index.js";
import { AI_PROVIDER_ENV, AiProviderEnvError, aiBootFields, aiProviderEnv } from "../../../src/ai/transports/host.js";
import { FIXTURE_SHAPES, anthropicKey, openAiKey } from "../../../../../test/support/fixture-credentials.js";

/**
 * THE ONE READER OF THE SELF-HOST AI BLOCK. The server and the worker both call it, so these
 * cases are the contract of both: an install with only ANTHROPIC_API_KEY resolves to the Anthropic
 * branch with nothing else set, a model server needs an address and the private switch to be
 * reached on the stack's network, and no refusal ever carries a value.
 */

const ANTHROPIC = anthropicKey("provider-env");
const OPENAI = openAiKey("provider-env");
const GO = "provider-env-fixture-token";

const refusal = (env: Record<string, string>): AiProviderEnvError => {
  try {
    aiProviderEnv(env);
  } catch (e) {
    if (e instanceof AiProviderEnvError) return e;
    throw e;
  }
  throw new Error("expected a refusal");
};

describe("aiProviderEnv", () => {
  it("the fixture key has the vendor's shape", () => {
    expect(ANTHROPIC).toMatch(FIXTURE_SHAPES.anthropic);
  });

  it("nothing set is no AI at all — rules only, the floor", () => {
    expect(aiProviderEnv({})).toBeNull();
    expect(aiProviderEnv({ TF_AI_PROVIDER: " ", ANTHROPIC_API_KEY: "" })).toBeNull();
  });

  it("only ANTHROPIC_API_KEY is the Anthropic branch, exactly, every choice left to the builders", () => {
    expect(aiProviderEnv({ ANTHROPIC_API_KEY: ` ${ANTHROPIC} ` })).toEqual({
      provider: "anthropic", apiKey: ANTHROPIC, baseUrl: null, allowPrivate: false,
      classifyModel: null, draftModel: null,
    });
  });

  it("names the variable it refuses, and never the value", () => {
    const bad = refusal({ ANTHROPIC_API_KEY: `xx-${ANTHROPIC}` });
    expect(bad.configVar).toBe("ANTHROPIC_API_KEY");
    expect(bad.message).not.toContain(ANTHROPIC);
    expect(refusal({ TF_AI_PROVIDER: "openai" }).configVar).toBe("OPENAI_API_KEY");
    expect(refusal({ TF_AI_PROVIDER: "gemini" }).configVar).toBe("TF_AI_PROVIDER");
    expect(refusal({ TF_AI_PROVIDER: "Anthropic", ANTHROPIC_API_KEY: ANTHROPIC }).configVar).toBe("TF_AI_PROVIDER");
  });

  it("a model server has no default address — inside a container 127.0.0.1 is the container", () => {
    expect(refusal({ TF_AI_PROVIDER: "ollama" }).configVar).toBe("OLLAMA_BASE_URL");
  });

  it("a missing vendor-named variable says the name the compose stack's .env gives it", () => {
    expect(refusal({ TF_AI_PROVIDER: "openai" }).remedy).toBe("the compose stack's .env sets it as OHMAIL_OPENAI_API_KEY");
    expect(refusal({ TF_AI_PROVIDER: "opencode-go" }).remedy).toContain("OHMAIL_OPENCODE_GO_API_KEY");
    expect(refusal({ TF_AI_PROVIDER: "ollama" }).message).toContain("OHMAIL_OLLAMA_BASE_URL");
    // ANTHROPIC_API_KEY keeps its own name everywhere, so its refusal has nothing to add.
    expect(refusal({ TF_AI_PROVIDER: "anthropic" }).remedy).toBeNull();
  });

  it("a model server on the stack's network needs TF_AI_ALLOW_PRIVATE, and the refusal names both", () => {
    const env = { TF_AI_PROVIDER: "ollama", OLLAMA_BASE_URL: "http://ollama:11434/" };
    const r = refusal(env);
    expect(r.configVar).toBe("OLLAMA_BASE_URL");
    expect(r.message).toContain("OLLAMA_BASE_URL");
    expect(r.message).toContain("TF_AI_ALLOW_PRIVATE");
    expect(r.remedy).toContain("TF_AI_ALLOW_PRIVATE=1");
    expect(r.message).not.toContain("ollama:11434");
    expect(aiProviderEnv({ ...env, TF_AI_ALLOW_PRIVATE: "1" })).toEqual({
      provider: "ollama", baseUrl: "http://ollama:11434", classifyModel: "llama3.2", draftModel: "llama3.2",
    });
    // `=== "1"` exactly, like the other private switches.
    expect(refusal({ ...env, TF_AI_ALLOW_PRIVATE: "true" }).configVar).toBe("OLLAMA_BASE_URL");
    // The switch relaxes the address, never the name spaces.
    expect(refusal({ TF_AI_PROVIDER: "ollama", OLLAMA_BASE_URL: "http://localhost:11434", TF_AI_ALLOW_PRIVATE: "1" }).configVar)
      .toBe("OLLAMA_BASE_URL");
  });

  it("OpenAI takes the desktop's defaults; OpenCode Go takes the operator's two models, from the list", () => {
    expect(aiProviderEnv({ TF_AI_PROVIDER: "openai", OPENAI_API_KEY: OPENAI })).toEqual({
      provider: "openai", apiKey: OPENAI, classifyModel: "gpt-4.1-mini", draftModel: "gpt-4.1",
    });
    expect(refusal({ TF_AI_PROVIDER: "opencode-go", OPENCODE_GO_API_KEY: GO }).configVar).toBe("TF_AI_CLASSIFY_MODEL");
    expect(refusal({
      TF_AI_PROVIDER: "opencode-go", OPENCODE_GO_API_KEY: GO, TF_AI_CLASSIFY_MODEL: "glm-5.3-flash", TF_AI_DRAFT_MODEL: "gpt-5",
    }).configVar).toBe("TF_AI_DRAFT_MODEL");
    // A free or preview model is the operator's choice and is taken like any other.
    const free = OPENCODE_GO_MODEL_IDS.find((id) => id.endsWith("-free"))!;
    expect(aiProviderEnv({
      TF_AI_PROVIDER: "opencode-go", OPENCODE_GO_API_KEY: GO, TF_AI_CLASSIFY_MODEL: free, TF_AI_DRAFT_MODEL: "kimi-k3",
    })).toEqual({ provider: "opencode-go", apiKey: GO, classifyModel: free, draftModel: "kimi-k3" });
  });

  it("an Anthropic model override is checked against the request rules before anything boots", () => {
    expect(refusal({ ANTHROPIC_API_KEY: ANTHROPIC, TF_AI_CLASSIFY_MODEL: "claude-unknown-9" }).configVar)
      .toBe("TF_AI_CLASSIFY_MODEL");
    expect(aiProviderEnv({ ANTHROPIC_API_KEY: ANTHROPIC, TF_AI_DRAFT_MODEL: "claude-sonnet-5" }))
      .toMatchObject({ provider: "anthropic", classifyModel: null, draftModel: "claude-sonnet-5" });
    expect(refusal({ TF_AI_PROVIDER: "openai", OPENAI_API_KEY: OPENAI, TF_AI_DRAFT_MODEL: "bad name" }).configVar)
      .toBe("TF_AI_DRAFT_MODEL");
  });

  it("AI_PROVIDER_ENV names every variable the reader reads, so compose and the template can be held to it", () => {
    const src = readFileSync(fileURLToPath(new URL("../../../src/ai/transports/provider-env.ts", import.meta.url)), "utf8");
    const read = new Set([...src.matchAll(/\b(?:read|required|apiKey|baseUrl|model)\("([A-Z][A-Z0-9_]+)"\)/g)].map((m) => m[1]!));
    expect(read.size, "the census read nothing").toBeGreaterThan(5);
    expect([...read].filter((v) => !(AI_PROVIDER_ENV as readonly string[]).includes(v))).toEqual([]);
  });
});

describe("aiBootFields — what the boot line says of the choice", () => {
  it("the provider, and whether its address is the default or one the operator set", () => {
    expect(aiBootFields(null)).toEqual({ kind: "none" });
    expect(aiBootFields(aiProviderEnv({ ANTHROPIC_API_KEY: ANTHROPIC }))).toEqual({ kind: "anthropic", aiEndpoint: "default" });
    expect(aiBootFields(aiProviderEnv({ TF_AI_PROVIDER: "openai", OPENAI_API_KEY: OPENAI }))).toEqual({ kind: "openai", aiEndpoint: "default" });
    expect(aiBootFields(aiProviderEnv({
      TF_AI_PROVIDER: "opencode-go", OPENCODE_GO_API_KEY: GO,
      TF_AI_CLASSIFY_MODEL: OPENCODE_GO_MODEL_IDS[0]!, TF_AI_DRAFT_MODEL: OPENCODE_GO_MODEL_IDS[0]!,
    }))).toEqual({ kind: "opencode-go", aiEndpoint: "default" });
  });

  it("a gateway or a model server is custom, and the line never carries the address", () => {
    const gateway = "https://gateway.boot-line.example";
    const viaGateway = aiBootFields(aiProviderEnv({ ANTHROPIC_API_KEY: ANTHROPIC, ANTHROPIC_BASE_URL: gateway }));
    const ollama = aiBootFields(aiProviderEnv({ TF_AI_PROVIDER: "ollama", OLLAMA_BASE_URL: "http://ollama:11434", TF_AI_ALLOW_PRIVATE: "1" }));
    expect(viaGateway).toEqual({ kind: "anthropic", aiEndpoint: "custom" });
    expect(ollama).toEqual({ kind: "ollama", aiEndpoint: "custom" });
    for (const [line, value] of [[viaGateway, "gateway.boot-line"], [ollama, "ollama:11434"]] as const) {
      expect(JSON.stringify(line)).not.toContain(value);
    }
  });
});
