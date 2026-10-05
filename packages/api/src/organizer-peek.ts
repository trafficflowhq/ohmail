import {
  LeaseUnavailableError, readLeasePeek, type OrganizerKind,
} from "@trafficflow/core/adapters/organizer-lease";
import { ServiceError } from "@trafficflow/services/mail";
import type { OpenAdapterOptions } from "./attachments-adapter.js";
import { isImapDoorTimeout, withinDoorBudget } from "./imap-door.js";
import type { ApiDeps } from "./deps.js";

/**
 * Who is organizing this mailbox right now — read from the mailbox, on demand. Not a column: one
 * organizer per mailbox is enforced by a claim message in an unsubscribed `ohmail/_meta` folder,
 * and a stood-down install stops re-reading the claim — the stored reason is a snapshot, while
 * the question is present-tense. So it is answered by looking: one short-lived connection under
 * the same cap as every other IMAP dial. It cannot use the gate: `runLeaseGate` writes on every
 * path — against an empty folder it would append a claim and stand every other install down for
 * ten minutes. `leasePeekIo()` has one method and no way to write; `readLeasePeek` returns facts,
 * no verdict.
 */

/** One organizer, as the wire carries it. */
export interface OrganizerHolderDTO {
  /**
   * `local` — an ohmail install on a machine of the user's. `cloud` — a hosted service.
   * `mobile` — a phone, which organizes only while the app is open on it.
   *
   * `OrganizerKind` itself, so this cannot fall behind the set the engine parses: spelled as
   * literals here it went a release without `mobile`, and a phone's claim then reached the pane
   * as `unknown`.
   */
  kind: OrganizerKind | "unknown";
  /**
   * The machine, as its own install named itself, or `null` when the claim carried no name.
   *
   * It is the user's own machine name, returned only to the account that owns the mailbox. It is
   * NEVER logged: it comes off a mail server, and this module inherits the probe's rule that
   * nothing a server hands us reaches a log line.
   */
  displayName: string | null;
  /** Last renew, ISO. */
  heartbeatAt: string;
  /** Still renewing, judged against the same staleness window the worker's gate uses. */
  active: boolean;
}

export interface OrganizerPeekDTO {
  /**
   * `none` — no claim in the mailbox; nobody has ever organized it.
   * `held` — at least one organizer is still renewing.
   * `stopped` — somebody was organizing and nothing has renewed since.
   */
  state: "none" | "held" | "stopped";
  /** Freshest first. */
  holders: OrganizerHolderDTO[];
  /**
   * Claims present but unreadable — a newer format, or a damaged message.
   *
   * Surfaced rather than swallowed because it is evidence somebody claimed, and `state` is
   * `stopped` rather than `none` when it is the only evidence there is.
   */
  unreadable: number;
}

/**
 * The mailbox could not be read, so the answer is unknown — never "nobody holds it".
 *
 * A 502 and not an empty result, and that distinction is the whole safety property: a surface that
 * rendered an empty organizer panel because a FETCH timed out would invite somebody to take over a
 * mailbox their own laptop is actively organizing, which is the one outcome the lease exists to
 * prevent.
 */
const leaseUnreadable = (): ServiceError => new ServiceError(
  "organizer_unreadable", 502,
  "The mailbox could not be checked for other ohmail installs. Try again.",
);

/**
 * A FOLDER THE LOOK COULD READ NO ANSWER FROM FOR A NAMED REASON — still a 502, never "nobody holds
 * it", but under its own code: `meta_folder_full` (too full to read) and `meta_undeletable` (the
 * server keeps refusing our deletes). Every other lease fault stays `organizer_unreadable`.
 */
const NAMED_LEASE_REFUSALS: Readonly<Record<string, string>> = {
  meta_folder_full: "The mailbox could not be checked for other ohmail installs: the ohmail/_meta folder on that "
    + "server holds more messages than ohmail can read. Move mail that was filed into it to another folder and "
    + "leave the messages ohmail wrote.",
  meta_undeletable: "The mailbox could not be checked for other ohmail installs: the mail server will not let ohmail "
    + "remove its own messages from ohmail/_meta. Give that folder delete permission, or ask your provider.",
};

/** What a failed look answers: a named lease refusal, `organizer_unreadable`, or `null` (rethrow). */
export function organizerPeekRefusal(err: unknown): ServiceError | null {
  if (err instanceof LeaseUnavailableError) {
    const said = NAMED_LEASE_REFUSALS[err.op];
    return said === undefined ? leaseUnreadable() : new ServiceError(err.op, 502, said);
  }
  return isImapDoorTimeout(err) ? leaseUnreadable() : null;
}

export type OrganizerPeek = (mailboxId: string) => Promise<OrganizerPeekDTO>;

/**
 * Build the peek. Per request, from `deps`, so it inherits the deadline, the IMAP admission
 * counter and the tightened client timeouts rather than re-deriving any of them — the same seam
 * and the same reason as `makeImapProbe` and `makeOpenAdapter`.
 */
export function makeOrganizerPeek(deps: ApiDeps, opts: OpenAdapterOptions = {}): OrganizerPeek {
  return async (mailboxId: string): Promise<OrganizerPeekDTO> => {
    try {
      // UNDER THE DOOR BUDGET. This read had no wall clock: a server that accepted the FETCH and
      // answered a byte a minute held the socket and this mailbox's admission slot for as long as
      // it liked, and the `finally` written to release them queued its LOGOUT behind the same
      // hung command. A breach destroys the socket and reads as "could not check", never as
      // "nobody holds it" — the one answer this surface must never give wrongly.
      const peek = await withinDoorBudget(
        deps, mailboxId,
        (adapter) => readLeasePeek({
          io: adapter.leasePeekIo(),
          now: deps.now?.() ?? new Date(),
        }),
        { open: opts },
      );
      return {
        state: peek.state,
        holders: peek.holders.map((h) => ({
          kind: h.kind,
          // Empty is not a name. `null` so the copy layer has one thing to test rather than two,
          // and so a claim written by an install that had no machine name does not render as a
          // blank where a name belongs.
          displayName: h.displayName.trim() === "" ? null : h.displayName,
          heartbeatAt: h.heartbeat.toISOString(),
          active: h.fresh,
        })),
        unreadable: peek.unreadable,
      };
    } catch (err) {
      // BY CLASS, exactly as the worker exempts it by class. `LeaseUnavailableError` is the one
      // error that means "could not look", and it must not be reachable from "nobody is there".
      // OUR clock running out is the same fact from the other side, so it gets the same answer:
      // a 504 here would be a second spelling of "could not check" for one caller to learn.
      throw organizerPeekRefusal(err) ?? err;
    }
  };
}
