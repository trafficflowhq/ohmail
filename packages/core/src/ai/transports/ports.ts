import type { ClassifierInput, ClassifierPort } from "../../classifier-port.js";
import type { DraftInput, DraftPort } from "../../draft-port.js";
import { ollamaTransport } from "./ai-ollama.js";
import { openaiTransport } from "./ai-openai.js";
import { opencodeGoTransport } from "./ai-opencode-go-chat.js";
import type { AiTransport, TransportUsage } from "./ai-transport.js";
import type { AiProviderEnv } from "./provider-env.js";

/**
 * A transport as the two ports a host takes. `screen` is optional on `ClassifierPort` and a port
 * without it still compiles while the Screener falls back to `classify` — so this one is held to
 * `Required<ClassifierPort>`. The per-call usage hook is not forwarded: these providers only run
 * where nothing meters (the worker refuses them when it does), and the port contract allows it.
 */
export function portsOf(t: AiTransport): { classifier: Required<ClassifierPort>; drafter: DraftPort } {
  const classifier = {
    classify: (input: ClassifierInput) => t.classify(input),
    screen: (input: ClassifierInput) => t.screen(input),
  } satisfies Required<ClassifierPort>;
  return { classifier, drafter: { draft: (input: DraftInput) => t.draft(input) } };
}

/** The transport a resolved non-Anthropic choice names; Anthropic keeps the hosted client. */
export function transportFor(
  ai: Exclude<AiProviderEnv, { provider: "anthropic" }>,
  opts: { fetchImpl: typeof fetch; timeoutMs: number; onUsage?: TransportUsage },
): AiTransport {
  const models = { classifyModel: ai.classifyModel, draftModel: ai.draftModel };
  switch (ai.provider) {
    case "openai": return openaiTransport({ apiKey: ai.apiKey, ...models, ...opts });
    case "opencode-go": return opencodeGoTransport({ apiKey: ai.apiKey, ...models, ...opts });
    case "ollama": return ollamaTransport({ baseUrl: ai.baseUrl, ...models, ...opts });
  }
}
