/** Calls to the actual Desktop bridge from the Sidecar integration rig. */
export { bridgeFetch } from "../../apps/desktop/src/bridge-fetch.js";
export { readAiStatus, saveAiSettings } from "../../apps/desktop/src/local-ai.js";
export { hydrateSuggestions, runSuggest, CHUNK, type SuggestionRow } from "../../apps/desktop/src/local-suggest-run.js";
export { cloudSuggestWire } from "../../apps/desktop/src/cloud-suggest.js";
export { consentOverBridge } from "../../apps/desktop/src/local-consent.js";
