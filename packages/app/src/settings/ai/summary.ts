import { useText } from "../../text/index.js";
import { AI_NAMESPACE } from "./namespace.js";

/** The AI entry's value in the Settings menu, from what is in memory: nothing while the flag is unknown. */
export function useAiSummary(enabled: boolean | null): { readonly value: string } | null {
  const own = useText(AI_NAMESPACE);
  return enabled === null ? null : { value: own(enabled ? "on" : "off") };
}
