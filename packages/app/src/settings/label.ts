import { useTextLookup } from "../text/index.js";
import type { SettingsPane } from "./contract.js";

/** A section's name, from its catalogue key or as its host says it. One reader for every row, so no hook is conditional. */
export function usePaneName(): (pane: SettingsPane) => string {
  const lookup = useTextLookup();
  return (pane) => ("said" in pane.label ? pane.label.said : lookup(pane.label.namespace)(pane.label.key));
}
