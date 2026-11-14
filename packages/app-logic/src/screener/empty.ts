/**
 * WHAT A SECTION WITH NO ROWS MAY SAY: the shared reading of a list's surface (`listSurface`), the one the Ohbox and
 * the phone read. "No one's waiting" is a fact about senders, never said before the queue is read; a list withheld
 * for an import or a count this device cannot list says why.
 */
import { listSurface, mirrorCountInput, waitingSurfaceInput } from "@ohmail/client-engine";
import type { ScreenerState } from "./screener-state.js";

export interface ScreenerFacts {
  /** Has any drain completed over this mirror? */
  readonly settled: boolean;
  /** Is the account still owed mail this device has not taken in? */
  readonly owed: boolean;
  /** Does the store say its import of the account is still open? */
  readonly storeImportOpen: boolean;
}

export type ScreenerEmpty =
  | { readonly kind: "rows" }
  | { readonly kind: "loading" }
  | { readonly kind: "withheld"; readonly why: "importing" | "listing" }
  | { readonly kind: "empty" };

export function emptyOf(
  segment: "waiting" | "screened" | "spam",
  state: Pick<ScreenerState, "waitingSource" | "waitingCount" | "queueAnswered" | "copyBehind">,
  facts: ScreenerFacts,
  count: number,
): ScreenerEmpty {
  if (segment === "waiting") {
    const input = waitingSurfaceInput({
      source: state.waitingSource,
      storeTotal: state.waitingCount,
      queueAnswered: state.queueAnswered === true,
      settled: facts.settled,
      owed: facts.owed,
      storeImportOpen: facts.storeImportOpen,
      count,
    });
    const surface = listSurface(input);
    if (surface === "content") return { kind: "rows" };
    if (surface === "skeleton") return { kind: "loading" };
    if (surface === "pending")
      return { kind: "withheld", why: input.why === "listing" ? "listing" : "importing" };
    return { kind: "empty" };
  }
  const surface = listSurface(
    mirrorCountInput({
      settled: facts.settled,
      owed: facts.owed,
      copyBehind: state.copyBehind === true,
      count,
    }),
  );
  if (surface === "content") return { kind: "rows" };
  if (surface === "empty") return { kind: "empty" };
  return surface === "pending" ? { kind: "withheld", why: "importing" } : { kind: "loading" };
}
