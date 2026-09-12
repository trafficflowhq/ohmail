import { ScheduleService, ServiceError } from "@trafficflow/services/mail";
import type { OrganizerKind } from "@trafficflow/core/adapters/organizer-lease";

/**
 * WHICH OUTBOUND PASSES EACH COMPOSITION OF THIS ENGINE RUNS.
 *
 * An outbound pass acts for the mailbox on its own clock, with nobody watching — so it is a
 * promise about a later moment, and a composition may only run one it can keep. A phone organizes
 * the mailbox only while ohmail is running on it, so it keeps no appointments. This table is
 * where that is said once, for the pass and the door both.
 *
 * The record is EXHAUSTIVE over the claim kinds deliberately: a fourth kind cannot reach the
 * claim without an answer here, which is the failure `organizerKind` itself was made a field to
 * prevent — a composition that is not the desktop behaving like one because nobody decided.
 */
export type OutboundPass = "scheduled-send";

export const COMPOSITION_PASSES:
  Readonly<Record<OrganizerKind, readonly OutboundPass[]>> = {
  /* The desktop standalone door. A window that is shut delays an appointment to the next
     launch's first drain, which `sendScheduled`'s own header calls the honest reading of
     "sends at 9:00" on a door that only exists while the app is open. */
  local: ["scheduled-send"],
  /* The hosted deployment does not run THIS composition — its clock is the worker's — and the
     answer is the same either way: appointments are kept. */
  cloud: ["scheduled-send"],
  /* A phone. `ScheduledSendPassDeps.mailboxIds` already carries the shape of this answer for the
     pass itself — "this caller has no mailboxes to claim for", which must claim nothing. */
  mobile: [],
};

export function runsPass(kind: OrganizerKind, pass: OutboundPass): boolean {
  return COMPOSITION_PASSES[kind].includes(pass);
}

/**
 * WHAT THE SCHEDULE DOOR SAYS on a composition that keeps no appointments.
 *
 * Server copy, under `STAND_DOWN_SEND_SENTENCES`' rule: whichever client asked quotes it inside
 * its own frame. The cause names the bound that is true however the shell keeps the app alive —
 * "while ohmail is running on it" — and the action names the two places the promise CAN be made.
 */
export const NO_APPOINTMENTS_HERE =
  "This phone organizes the mailbox only while ohmail is running on it, so it cannot promise to "
  + "send a message later. Send it now, or schedule it from a computer or ohmail Cloud.";

/**
 * THE SCHEDULE VERB, REFUSED — `POST /drafts/:id/schedule` where no pass will keep the result.
 *
 * A subclass and not a stand-in object because `ApiServices.schedules` is the class itself. CANCEL
 * is inherited on purpose: an appointment that already stands in this store must stay cancellable,
 * since taking it off is the only remedy its owner has left.
 */
export class AppointmentsRefused extends ScheduleService {
  override async schedule(): Promise<never> {
    throw new ServiceError("conflict", 409, NO_APPOINTMENTS_HERE);
  }
}
