import { OPENCODE_GO_MODEL_IDS } from "./ai-opencode-go-models.js";
import { fetchWithDeadline, failureOf, type ProbeOutcome } from "./ai-transport.js";

/** Fixed Go Console configuration endpoint. It is not configurable and never receives inference. */
export const OPENCODE_GO_CONFIG_URL = "https://opencode.ai/console/api/v2/config";

export interface OpenCodeGoProbeOptions {
  apiKey: string;
  models: string[];
  fetchImpl: typeof fetch;
  timeoutMs: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function failureForStatus(status: number): ProbeOutcome["reason"] {
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 402 || status === 429) return "request_rejected";
  if (status === 408 || status === 504) return "timeout";
  return "bad_response";
}

/**
 * Read only `providers.opencode-go.models`. Config elsewhere in the workspace is deliberately
 * ignored and never returned to the caller. Unknown Go model IDs are filtered before they reach UI.
 */
function goModelIds(config: unknown): string[] | null {
  if (!isRecord(config)) return null;
  const providers = config.providers;
  if (!isRecord(providers)) return null;
  const go = providers["opencode-go"];
  if (!isRecord(go)) return null;
  const models = go.models;
  if (!isRecord(models)) return null;
  return OPENCODE_GO_MODEL_IDS.filter((id) => Object.hasOwn(models, id));
}

/** A bounded, config-only key check. It does not implement any inference transport. */
export async function probeOpenCodeGo(options: OpenCodeGoProbeOptions): Promise<ProbeOutcome> {
  let response: Response;
  try {
    response = await fetchWithDeadline(
      options.fetchImpl,
      OPENCODE_GO_CONFIG_URL,
      {
        method: "GET",
        headers: {
          authorization: `Bearer ${options.apiKey}`,
          "user-agent": "ohmail-desktop",
        },
        redirect: "error",
      },
      options.timeoutMs,
    );
  } catch (error) {
    return { ok: false, reason: failureOf(error), detail: null, models: [] };
  }

  if (!response.ok) {
    return { ok: false, reason: failureForStatus(response.status), detail: null, models: [] };
  }

  let configured: string[] | null;
  try {
    configured = goModelIds(await response.json());
  } catch {
    return { ok: false, reason: "bad_response", detail: null, models: [] };
  }
  if (configured === null) {
    return { ok: false, reason: "bad_response", detail: null, models: [] };
  }
  if (configured.length === 0) {
    return { ok: false, reason: "model_absent", detail: null, models: [] };
  }

  const missing = [...new Set(options.models.filter(Boolean))].find((model) => !configured.includes(model));
  if (missing) {
    return {
      ok: false,
      reason: "model_absent",
      detail: `OpenCode Go does not list the configured model "${missing}".`,
      models: configured,
    };
  }
  return { ok: true, reason: null, detail: null, models: configured };
}
