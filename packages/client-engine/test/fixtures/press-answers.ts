import type { MutationQueued } from "@ohmail/wire";
import type { MutationResult } from "../../src/engine.js";

/**
 * THE ANSWERS BOTH SURFACES ARE DRIVEN AGAINST — one shape, imported by the webapp's tests and
 * the phone's, so a sentence that is right on one surface and wrong on the other cannot pass for
 * a difference in the fixture. These are the bodies `HttpAdapter.queuedAnswer` builds from a
 * real `202 {pending: true}` and what the engine hands a surface for each.
 */

/** The name a queued answer carries — the install that organizes the mailbox. */
export const QUEUED_HOLDER = "the laptop";

/** What an ADAPTER answers for a press the server recorded for the organizing install. */
export const queuedByOrganizer = (): MutationQueued => ({
  settlement: "queued",
  queuedWith: { name: QUEUED_HOLDER },
  requestId: "req-1",
  changes: [],
  seq: null,
});

/** …and what a SURFACE is handed for each of the four endings. */
export const RESULTS: Record<"applied" | "retry" | "organizer" | "refused", MutationResult> = {
  applied: { id: "p1", key: "k1", status: "confirmed", seq: 11 },
  retry: { id: "p2", key: "k2", status: "queued", seq: null },
  organizer: { id: "p3", key: "k3", status: "awaiting_organizer", seq: null, queuedWith: { name: QUEUED_HOLDER } },
  refused: { id: "p4", key: "k4", status: "rolled_back", seq: null },
};
