/**
 * `@trafficflow/core/ai-provider-env` — the self-host server's and the worker's half: the one
 * reader of the AI environment and the ports a chosen transport becomes. A subpath of its own so
 * the desktop engine, which imports `./ai-transports`, never carries the hosted Anthropic client
 * this resolver validates against.
 */
export * from "./provider-env.js";
export * from "./ports.js";
