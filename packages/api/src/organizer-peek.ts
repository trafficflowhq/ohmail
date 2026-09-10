import { LeaseUnavailableError, readLeasePeek } from "@trafficflow/core/adapters/organizer-lease";
import { ServiceError } from "@trafficflow/services/mail";
import type { OpenAdapterOptions } from "./attachments-adapter.js";
import { isImapDoorTimeout, withinDoorBudget } from "./imap-door.js";
import type { ApiDeps } from "./deps.js";

/**
 * WHO IS ORGANIZING THIS MAILBOX RIGHT NOW — read from the mailbox, on demand.
 *
 * ── WHY THIS CANNOT BE A COLUMN ───────────────────────────────────────────────────────────
 *
 * Exactly one organizer per mailbox is enforced by a claim message in an unsubscribed
 * `ohmail/_meta` folder, because a desktop install running on its own local database and the
 * hosted service running on ours share no store except the mailbox itself. When this side loses
 * the mailbox it writes `disabled` plus a reason and stops — and a disabled mailbox is off the
 * worker's roster, so from that moment nothing re-reads the claim. The reason column therefore
 * records what was true at the instant we stood down, and only that.
 *
 * The question a person actually asks is a present-tense one: *is my laptop still organizing this,
 * or did it stop?* Answering it from the stored reason would mean answering it from a snapshot
 * that may be days old, and the answer decides which action they are offered. So it is answered by
 * looking — one short-lived connection, under the same cap every other IMAP dial from this process
 * queues behind.
 *
 * ── AND WHY IT CANNOT USE THE GATE ────────────────────────────────────────────────────────
 *
 * The gate (`runLeaseGate`) writes on every path: it creates the folder, and it either renews our
 * claim or releases it. Running it here — with any identity at all — would make opening a settings
 * pane an act of organizing. Against an empty folder it would APPEND a claim and every other
 * install would stand down for ten minutes. So this uses `leasePeekIo()`, whose object has exactly
 * one method and no way to write, and `readLeasePeek`, which returns facts and no verdict.
 *
 * Nothing here decides anything. The decision belongs to the worker's gate, later, in the process
 * that will actually do the organizing.
 */

/** One organizer, as the wire carries it. */
export interface OrganizerHolderDTO {
  /** `local` — an ohmail install on a machine of the user's. `cloud` — a hosted service. */
  kind: "local" | "cloud" | "unknown";
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
      if (err instanceof LeaseUnavailableError || isImapDoorTimeout(err)) throw leaseUnreadable();
      throw err;
    }
  };
}
