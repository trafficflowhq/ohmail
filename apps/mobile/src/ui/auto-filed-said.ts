import { Copy } from "../copy";

/**
 * The sentence after a Put back on the phone's "Filed automatically" panel — kept out of the
 * panel's React Native module so the node suite reads it as a function.
 */
export type AutoFiledSaid = null | { k: "done"; n: number } | { k: "requested" } | { k: "none" } | { k: "failed" };

export function autoFiledSaid(said: AutoFiledSaid): string | null {
  if (said === null) return null;
  switch (said.k) {
    case "done": return Copy.autoFiledPutBackDone(said.n);
    case "requested": return Copy.autoFiledRequested;
    case "none": return Copy.autoFiledNone;
    case "failed": return Copy.autoFiledFailed;
  }
}
