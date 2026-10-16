/**
 * The OpenCode Go model IDs this desktop can drive over Chat Completions, in ONE place. A leaf with
 * no imports, so the window reads the same list and labels as the engine.
 *
 * The workspace config (ai-opencode-go.ts) says which models a workspace has, but not which API each
 * speaks; a Responses-only model is listed there too. The picker is the config's list filtered by
 * this one. README and the self-host doc point to Settings instead of copying it.
 */
export const OPENCODE_GO_MODEL_IDS = [
  "glm-5.2",
  "glm-5.3",
  "glm-5.3-flash",
  "kimi-k2.6",
  "kimi-k2.7-code",
  "kimi-k3",
  "deepseek-v4.1-flash",
  "deepseek-v4-pro",
  "longcat-2.0",
  "hy3",
  "hy4-preview",
  "space-bunny",
  "mimo-v2.5",
  "mimo-v2.5-pro",
  "mimo-v2.6-flash",
  "mimo-v2.6-pro",
  "longcat-2.5-preview-free",
  "step-5-preview-free",
  "cat-jam-free",
] as const;

/** Free and preview tiers, read off the ID the way OpenCode names them. The user's choice; labelled. */
export function opencodeGoModelTier(id: string): { free: boolean; preview: boolean } {
  return { free: /-free$/.test(id), preview: /(^|-)preview(-|$)/.test(id) };
}
