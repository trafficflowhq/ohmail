/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  THE AI PROVIDER A PHONE HAS — none, said in the engine's own vocabulary
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * `createSidecar` builds a local AI provider unconditionally, before it knows whether anything
 * will ask for one. The real one opens a store file — `join(dataDir, AI_STORE_FILE)` — at the top
 * of that call, which on a phone reaches a `path` module that is not there. So the engine failed
 * during composition, on a build where the feature it was composing is not offered at all.
 *
 * ── A SUBSTITUTED MODULE, NOT A CONFIGURATION SWITCH ──────────────────────────────────────
 *
 * The engine is deliberately unaware that there is such a thing as a phone. Which modules exist in
 * this build is the composition's question and the alias table is where it is answered — the same
 * place that decides the phone has no host door and no local Postgres. A knob inside the engine
 * would be a second place that has to agree with this one.
 *
 * ── IT ANSWERS, AND ONLY THE WRITES REFUSE ────────────────────────────────────────────────
 *
 * The rule every substitute here is held to: a module the engine CALLS at boot answers, and only
 * an unreachable one refuses. `createLocalAi` is called at boot, so it returns a provider.
 *
 * `status()` reports the state the engine already has a name for — nothing configured, which is
 * the product's floor and explicitly not a fault. `drafter()`, `classifier()` and
 * `classifierForCycle()` return `undefined`, which is the engine's own vocabulary for "this
 * install has no model": the route table answers `503 drafter_unconfigured` for an absent drafter,
 * so a phone lands on exactly the sentence a desktop with no provider lands on. A port that
 * existed and threw would give one state two names.
 *
 * The three WRITES refuse, because they are the only members whose whole purpose is to persist or
 * to reach a vendor and there is nothing here to do either with. They refuse as a typed service
 * error rather than a bare throw, and that is load-bearing: the route pipeline turns a typed error
 * into its own status and sentence, and anything else into `500 internal error` with the message
 * discarded. A person tapping Save would have been shown "internal error".
 *
 * ── NOTHING IN THIS FILE REACHES A NETWORK OR A DISK, AND THAT IS WHY IT DOES NOT IMPORT THE
 *    REAL MODULE'S DEFAULTS ──────────────────────────────────────────────────────────────
 *
 * The three model-name defaults live beside the three vendor transports. Importing them for their
 * strings would bring `fetch`-carrying transport modules for Anthropic, OpenAI and a local model
 * server back into a build whose whole claim is that they are not in it — three vendor endpoints
 * in an artifact for the sake of five words.
 *
 * So they are stated here, and a cross-file pin in `phone-engine-substitutes.test.ts` asserts they
 * are still the same values the real modules export. A test may import them; the shipped closure
 * may not. That is the same arrangement, for the same reason, that the request pipeline uses for
 * the two error classes it matches by name rather than by import.
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
