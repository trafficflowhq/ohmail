import { refuse, type Refusal } from "../refusal";
import { consoleEngineLogSink } from "../engine/engine-log";
import type { SessionDeath } from "./bearer";

/**
 * WHAT A PERSON READS WHEN A SESSION ENDS ON THE SERVER — one sentence, and it is the same one
 * at every door. Three spellings shipped (the refused token, the swept family, the Servers
 * pane's own line): a pairing presented from two phones was refused once and described two
 * different ways, and none of the three said what to do next. The remedy is the sentence's last
 * clause and the verb beside it; the CAUSE is a maintainer's fact, so it goes to the log.
 */
export function deathRefusal(_why: SessionDeath): Refusal {
  return refuse("pairEnded");
}

/**
 * The cause, for whoever reads the device's log. It goes through the engine's sink because the
 * app has exactly one place lines leave from, and it carries a CLOSED SET of two literals and
 * nothing else — no interpolation, no free text, no identity — so it raises none of the
 * questions the engine's own logger answers (`engine/engine-log.ts`).
 */
export function noteSessionDeath(why: SessionDeath, sink = consoleEngineLogSink()): void {
  sink(why === "revoked"
    ? '{"service":"pairing","event":"session_dead","why":"revoked"}'
    : '{"service":"pairing","event":"session_dead","why":"refused"}');
}

/** Is this the pairing-ended refusal? The sites that render it offer the scan beside it. */
export function isPairEnded(r: Refusal): boolean {
  return r.say === "pairEnded";
}
