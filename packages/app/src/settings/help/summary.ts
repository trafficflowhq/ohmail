import { useText } from "../../text/index.js";
import type { PaneSummary } from "../contract.js";

export function useHelpSummary(): PaneSummary {
  const t = useText("help");
  return { detail: `${t("write")} · ${t("diag")}` };
}
