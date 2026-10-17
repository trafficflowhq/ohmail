import { assertAnthropicKey, assertModelBaseUrl } from "../anthropic-client.js";
import { thinkingOffFor } from "../../model-rules.js";
import { DEFAULT_OLLAMA, type OllamaTransportOptions } from "./ai-ollama.js";
import { DEFAULT_OPENAI_MODELS } from "./ai-openai.js";
import { OPENCODE_GO_MODEL_IDS } from "./ai-opencode-go-models.js";
import type { AiKeyTransportOptions } from "./ai-transport.js";

/**
 * THE SELF-HOST AI CHOICE, read from the environment by the server and the worker alike — one
 * reader, so the two processes cannot accept different spellings (`msOAuthEnv`'s rule). Unset
 * `TF_AI_PROVIDER` with an `ANTHROPIC_API_KEY` is the Anthropic branch exactly as before. The
 * managed API never calls this; the worker refuses anything but Anthropic when it meters.
 * Every refusal names a variable and never a value.
 */
export const AI_PROVIDER_ENV = [
  "TF_AI_PROVIDER", "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "OPENAI_API_KEY", "OPENCODE_GO_API_KEY",
  "OLLAMA_BASE_URL", "TF_AI_CLASSIFY_MODEL", "TF_AI_DRAFT_MODEL", "TF_AI_ALLOW_PRIVATE",
] as const;

export const AI_PROVIDERS = ["anthropic", "openai", "ollama", "opencode-go"] as const;
export type AiProvider = (typeof AI_PROVIDERS)[number];

/** The names other model tools read too. The compose file takes these four from OHMAIL_ ones, so a
 *  shell exporting one for another tool cannot redirect the stack; a refusal says so. */
export const AI_VENDOR_NAMED = ["ANTHROPIC_BASE_URL", "OPENAI_API_KEY", "OPENCODE_GO_API_KEY", "OLLAMA_BASE_URL"] as const;
const composeName = (k: string): string | null =>
  ((AI_VENDOR_NAMED as readonly string[]).includes(k) ? `the compose stack's .env sets it as OHMAIL_${k}` : null);

/** A transport's option bag less what the host supplies: the bag stays declared once. */
type Chosen<T> = Omit<T, "fetchImpl" | "timeoutMs" | "onUsage">;

export type AiProviderEnv =
  | {
    provider: "anthropic"; apiKey: string; baseUrl: string | null; allowPrivate: boolean;
    /** `null` keeps the hosted builders' own models. */
    classifyModel: string | null; draftModel: string | null;
  }
  | ({ provider: "openai" } & Chosen<AiKeyTransportOptions>)
  | ({ provider: "opencode-go" } & Chosen<AiKeyTransportOptions>)
  | ({ provider: "ollama" } & Chosen<OllamaTransportOptions>);

/** What a boot line says of the choice: the provider, and whether its address is the default or
 *  one the operator set (Ollama's always is) — never the address, never a key. `aiEndpoint`, not
 *  `endpoint`: the logger's allowlist is global, and a bare `endpoint` would admit a push URL. */
export function aiBootFields(ai: AiProviderEnv | null): { kind: AiProvider | "none"; aiEndpoint?: "default" | "custom" } {
  if (ai === null) return { kind: "none" };
  const custom = ai.provider === "ollama" || (ai.provider === "anthropic" && ai.baseUrl !== null);
  return { kind: ai.provider, aiEndpoint: custom ? "custom" : "default" };
}

/** A refused AI block. `remedy` is a fixed sentence naming variables, safe to log. */
export class AiProviderEnvError extends Error {
  override readonly name = "AiProviderEnvError";
  constructor(readonly configVar: string, message: string, readonly remedy: string | null = null) {
    super(remedy ? `${message} — ${remedy}` : message);
  }
}

/** A model name as the desktop's settings accept one: it becomes part of a request body. */
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const PRIVATE_REMEDY =
  "a model server on a private or loopback address, or over plain http, needs TF_AI_ALLOW_PRIVATE=1";

export function aiProviderEnv(env: Record<string, string | undefined>): AiProviderEnv | null {
  const read = (k: string): string => (typeof env[k] === "string" ? env[k]!.trim() : "");
  const chosen = read("TF_AI_PROVIDER");
  if (chosen === "" && read("ANTHROPIC_API_KEY") === "") return null;
  const provider = chosen === "" ? "anthropic" : chosen;
  const allowPrivate = read("TF_AI_ALLOW_PRIVATE") === "1";
  const required = (k: string): string => {
    const v = read(k);
    if (v === "") throw new AiProviderEnvError(k, `TF_AI_PROVIDER=${provider} needs ${k}`, composeName(k));
    return v;
  };
  const apiKey = (k: string): string => {
    const v = required(k);
    // Shape only, never a prefix: a key's format is its issuer's (the desktop's rule).
    if (v.length < 16 || v.length > 512 || /\s/.test(v)) throw new AiProviderEnvError(k, `${k} does not look like an API key`);
    return v;
  };
  const baseUrl = (k: string): string => {
    try {
      return assertModelBaseUrl(required(k).replace(/\/+$/, ""), allowPrivate, k);
    } catch (e) {
      if (e instanceof AiProviderEnvError) throw e;
      throw new AiProviderEnvError(k, (e as Error).message, allowPrivate ? null : PRIVATE_REMEDY);
    }
  };
  const model = (k: "TF_AI_CLASSIFY_MODEL" | "TF_AI_DRAFT_MODEL"): string | null => {
    const v = read(k);
    if (v !== "" && !MODEL_RE.test(v)) throw new AiProviderEnvError(k, `${k} is not a model name`);
    return v === "" ? null : v;
  };
  const classifyModel = model("TF_AI_CLASSIFY_MODEL");
  const draftModel = model("TF_AI_DRAFT_MODEL");
  switch (provider) {
    case "anthropic": {
      let key: string;
      try {
        key = assertAnthropicKey(required("ANTHROPIC_API_KEY"));
      } catch (e) {
        if (e instanceof AiProviderEnvError) throw e;
        throw new AiProviderEnvError("ANTHROPIC_API_KEY", (e as Error).message);
      }
      // The hosted builders refuse a model with no thinking-off row at construction; asked here,
      // so the refusal names the variable and comes before the server migrates anything.
      for (const [k, m] of [["TF_AI_CLASSIFY_MODEL", classifyModel], ["TF_AI_DRAFT_MODEL", draftModel]] as const) {
        if (m === null) continue;
        try { thinkingOffFor(m); } catch {
          throw new AiProviderEnvError(k, `${k} names a model this build has no request rules for`);
        }
      }
      return {
        provider, apiKey: key, allowPrivate, classifyModel, draftModel,
        baseUrl: read("ANTHROPIC_BASE_URL") === "" ? null : baseUrl("ANTHROPIC_BASE_URL"),
      };
    }
    case "openai":
      return {
        provider, apiKey: apiKey("OPENAI_API_KEY"),
        classifyModel: classifyModel ?? DEFAULT_OPENAI_MODELS.classify,
        draftModel: draftModel ?? DEFAULT_OPENAI_MODELS.draft,
      };
    case "opencode-go": {
      const go = (k: string, m: string | null): string => {
        if (m !== null && (OPENCODE_GO_MODEL_IDS as readonly string[]).includes(m)) return m;
        throw new AiProviderEnvError(k, `TF_AI_PROVIDER=opencode-go needs ${k}, one of ${OPENCODE_GO_MODEL_IDS.join(", ")}`);
      };
      return {
        provider, apiKey: apiKey("OPENCODE_GO_API_KEY"),
        classifyModel: go("TF_AI_CLASSIFY_MODEL", classifyModel), draftModel: go("TF_AI_DRAFT_MODEL", draftModel),
      };
    }
    case "ollama":
      // No default address: the desktop's 127.0.0.1:11434 is the container itself on this stack.
      return {
        provider, baseUrl: baseUrl("OLLAMA_BASE_URL"),
        classifyModel: classifyModel ?? DEFAULT_OLLAMA.classifyModel,
        draftModel: draftModel ?? DEFAULT_OLLAMA.draftModel,
      };
    default:
      throw new AiProviderEnvError("TF_AI_PROVIDER", `TF_AI_PROVIDER must be one of ${AI_PROVIDERS.join(", ")}, or unset`);
  }
}
