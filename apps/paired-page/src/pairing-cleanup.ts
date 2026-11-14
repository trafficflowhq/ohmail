import type { LocalSweep } from "@ohmail/app-logic/session/boot-cache";
import type { HostOutboxDiscard } from "./outbox-store.js";

/**
 * WHAT THE SWEEP COULD NOT DO IS A FACT, NOT A SHRUG. `dropLocalStorageKeys` returns a
 * verdict — which matched keys are still present, and whether the jar could be walked —
 * because a browser that refuses proves nothing by naming no survivors. Both departure paths
 * discarded it, so a private window or a refusing storage layer produced a signed-out screen
 * over mail text still on the device. This door has no toast host at the moment either path
 * runs, so the verdict goes to the console — the weakest useful thing: on record, greppable,
 * and not pretending the sweep succeeded. A visible sentence beside this door's own sign-out
 * copy is the named follow-up rather than invented here.
 */
export function reportSweep(sweep: LocalSweep): void {
  if (sweep.enumerated && sweep.survivors.length === 0) return;
  console.warn("ohmail host client: the scratch sweep did not complete", {
    enumerated: sweep.enumerated,
    survivors: sweep.survivors.length,
  });
}

/** The queued changes go with the pairing; a database that refused is on record, not done. */
export function reportDiscard(verdict: HostOutboxDiscard): void {
  if (verdict === "discarded") return;
  console.warn("ohmail host client: the queued changes kept in this browser could not be discarded");
}
