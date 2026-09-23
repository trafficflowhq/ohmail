import { ScheduleService, ServiceError } from "@trafficflow/services/mail";
import type { OrganizerKind } from "@trafficflow/core/adapters/organizer-lease";

/**
 * Which outbound passes each composition of this engine runs. An outbound pass acts for the mailbox
 * on its own clock with nobody watching — a promise about a later moment — so a composition may only
 * run one it can keep. A phone organizes the mailbox only while ohmail is running on it, so it keeps
 * no appointments. This table says that once, for the pass and the door both. The record is
 * EXHAUSTIVE over the claim kinds deliberately: a fourth kind cannot reach the claim without an
 * answer here, which is the failure `organizerKind` was made a field to prevent — a composition that
 * is not the desktop behaving like one because nobody decided.
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

/**
 * WHICH STORE-ONLY PASSES each composition schedules — work on this install's own store with no
 * mailbox connection and no promise about a later moment. `search-index-backfill` is the
 * `search_index_backfill` pass (`@trafficflow/core/mail`), gated on idle and power here
 * (`search-backfill.ts`). The hosted deployment runs it at each visit's tail in the worker, never in
 * this composition; the phone does not schedule it (search there reads rows without a document the
 * older way, which stays complete).
 */
type StorePass = "search-index-backfill";

export const COMPOSITION_STORE_PASSES:
  Readonly<Record<OrganizerKind, readonly StorePass[]>> = {
  local: ["search-index-backfill"],
  cloud: [],
  mobile: [],
};

export function runsStorePass(kind: OrganizerKind, pass: StorePass): boolean {
  return COMPOSITION_STORE_PASSES[kind].includes(pass);
}
