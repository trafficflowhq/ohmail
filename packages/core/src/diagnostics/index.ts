/**
 * `@trafficflow/core/diagnostics` — the local diagnostic file, built the same way on the desktop
 * and the phone. No import here reaches the network, the store or a node builtin; the leaf is
 * bundled into a webview and a phone. A census keeps it out of the server graphs and the
 * lease.
 */
export * from "./bundle.js";
export * from "./scrub.js";
export * from "./vocab.js";
export { sha256Hex } from "./sha256.js";
