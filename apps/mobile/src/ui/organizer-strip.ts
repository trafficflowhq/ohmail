/**
 * THE OHBOX'S STRIP ABOUT WHO ORGANIZES THIS MAILBOX — the Settings card's own claim, over the list.
 *
 * Derived from the SAME `claimHere(...)` the card renders and worded with the card's own label and
 * note, so the list and Settings cannot disagree. It draws only where a person needs to hear it
 * from the list — handed back, stopped here, held by another install, a stop not yet honoured —
 * and nothing over our own claim, a claim not read yet, or a paired server.
 */
import { Copy } from "../copy";
import { CLAIM_LAPSES_AFTER_MINUTES } from "../engine/standalone-door";
import { claimChipLabel, claimNoteLine, mayStartHere, type PhoneClaim } from "./standalone-form";

export interface OrganizerStrip {
  /** The card's chip, as a line. */
  readonly label: string;
  /** The card's note under it, or `null` where the card says none. */
  readonly note: string | null;
  /** The hand-back that did not land in time, said beside "Handed back". */
  readonly late: string | null;
  /** Whether Settings' start verb is offered here too — its own predicate, not a copy of it. */
  readonly start: boolean;
}

export function organizerStripOf(
  claim: PhoneClaim,
  facts: {
    /**
     * THE PERSON STOPPED ORGANIZING HERE — the row says reader and a consent is on record
     * (`lifecycle-strip.ts#stoodDown`). A mailbox nobody ever consented to is also `free`, and the
     * list does not invite anyone to start something they never started.
     */
    readonly stoppedHere: boolean;
    /** `organizerHandBackLateSaid()`. */
    readonly late: boolean;
    readonly os: string;
  },
): OrganizerStrip | null {
  const label = claimChipLabel(claim);
  if (label === null) return null;
  const said = (late: boolean): OrganizerStrip => ({
    label,
    note: claimNoteLine(claim, facts.os),
    late: late ? Copy.organizerHandBackLate(CLAIM_LAPSES_AFTER_MINUTES) : null,
    start: mayStartHere(claim),
  });
  switch (claim.k) {
    case "handedBack":
      return said(facts.late);
    case "free":
      return facts.stoppedHere ? said(false) : null;
    case "theirs":
    case "theirsUnnamed":
    case "blocked":
      return said(false);
    case "ours":
      return claim.releasePending ? said(false) : null;
    default:
      return null;
  }
}
