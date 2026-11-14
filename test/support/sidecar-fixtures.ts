/** The real engine and relay used behind the Desktop test harness. */
export { createSidecar, type Sidecar } from "../../apps/sidecar/src/engine.js";
export { PGLITE_STANDUP_BUDGET_MS } from "../../apps/sidecar/test/pglite-budget.js";
export { createCloudAuth } from "../../apps/sidecar/src/cloud-auth.js";
export { createWriteThroughProxy } from "../../apps/sidecar/src/cloud-proxy.js";
export type { CloudMirror } from "../../apps/sidecar/src/cloud-mirror.js";
