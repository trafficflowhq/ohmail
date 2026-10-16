/**
 * `@trafficflow/core/ai-transports` — the four model providers a person runs ohmail against
 * (Anthropic, OpenAI, Ollama, OpenCode Go), each HTTP over an injected `fetch` with no SDK. The
 * desktop engine drives them today. Its own entry point, never part of `./mail` and never reached
 * from `client-engine`: what a request carries is decided by the shared sinks in `./mail`.
 */
export * from "./ai-transport.js";
export * from "./ai-anthropic.js";
export * from "./ai-openai.js";
export * from "./ai-ollama.js";
export * from "./ai-opencode-go.js";
export * from "./ai-opencode-go-chat.js";
export * from "./ai-opencode-go-models.js";
