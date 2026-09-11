/**
 * The AI provider a phone has — none, said in the engine's own vocabulary. `createSidecar` builds a
 * local AI provider unconditionally, and the real one opens a store file, which on a phone reaches a
 * `path` module that is not there — so the engine failed during composition on a build where the
 * feature is not offered. A substituted module, not a config switch: which modules exist is answered
 * in the alias table. It ANSWERS and only the WRITES refuse: `createLocalAi` returns a provider,
 * `status()` reports "nothing configured" (the floor, not a fault) and the ports return `undefined`,
 * so a phone lands on the same sentence a desktop with no provider does; the three writes refuse as
 * typed service errors. The model-name defaults are stated here, pinned to the real modules by test.
 */
import { ServiceError } from "@trafficflow/services/mail";

import type {
  AiStatus,
  LocalAi,
  LocalAiOptions,
  LocalAiSettings,
} from "../ai-provider.js";

/* The types the two route tables import from this specifier. Erased at build — `export type` emits
   nothing — so re-exporting them costs the artifact nothing and keeps both route modules compiling
   against the module they actually get. */
export type {
  AiProbeReport,
  AiProviderKind,
  AiStatus,
  AiUnavailableReason,
  HostedSettings,
  LocalAi,
  LocalAiOptions,
  LocalAiSettings,
  LocalAiSettingsInput,
  OllamaSettings,
} from "../ai-provider.js";

/**
 * THE SETTINGS A PHONE RENDERS: the defaults, and no key stored for anything.
 *
 * Duplicated from the modules that own them rather than imported — see the banner — and pinned
 * against them by a test, so a model rename that left this behind is a red rather than a settings
 * pane quietly describing a model nobody ships any more.
 */
export const PHONE_DEFAULT_AI_SETTINGS: LocalAiSettings = {
  provider: null,
  anthropic: { classifyModel: "claude-haiku-4-5-20251001", draftModel: "claude-sonnet-5", hasKey: false },
  openai: { classifyModel: "gpt-4.1-mini", draftModel: "gpt-4.1", hasKey: false },
  ollama: { baseUrl: "http://127.0.0.1:11434", classifyModel: "llama3.2", draftModel: "llama3.2" },
};

/**
 * WHAT A PERSON IS TOLD WHEN THEY TRY TO CONFIGURE ONE.
 *
 * It states the two facts somebody in the middle of typing an API key needs: this build cannot do
 * it, and nothing they typed went anywhere. `503` and the shared code, so every client that
 * already renders "the AI provider is unavailable" renders this without being taught a new state.
 */
export const PHONE_AI_REFUSAL =
  "AI is not available on this phone in this version; nothing was stored and nothing was sent";

function refuse(): never {
  throw new ServiceError("ai_provider_unavailable", 503, PHONE_AI_REFUSAL, undefined, false);
}

/** Nothing configured, nothing storable, and no verification to report. */
function phoneStatus(): AiStatus {
  return {
    provider: null,
    available: false,
    // AN EXISTING STATE, never a new one. "No provider chosen" is exactly what this is, and it is
    // the one unavailable reason the product treats as normal rather than as a fault.
    unavailableReason: "not_configured",
    contentGoesTo: null,
    settings: PHONE_DEFAULT_AI_SETTINGS,
    probe: null,
    // No key field is offered, because there is nowhere for a key to go and an interface must not
    // offer one it would have to refuse.
    canStoreKey: false,
  };
}

/**
 * The provider this build composes. Takes the real options so the call site is unchanged; reads
 * none of them, because there is no store to open and no endpoint to reach.
 */
export async function createLocalAi(_opts: LocalAiOptions): Promise<LocalAi> {
  return {
    status: phoneStatus,
    save: refuse,
    clear: refuse,
    verify: refuse,
    // ABSENCE, which is the engine's own word for "this install has no model" — `undefined` here
    // is what makes the route table answer `503 drafter_unconfigured`.
    drafter: () => undefined,
    classifier: () => undefined,
    classifierForCycle: () => undefined,
  };
}
