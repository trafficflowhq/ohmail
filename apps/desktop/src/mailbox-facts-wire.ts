/**
 * THE MAILBOX LIST, NARROWED — over an injected transport, and with no door in this module.
 *
 * `GET /mailboxes` is asked by two surfaces: the desktop window over its bridge
 * (`local-mailbox-facts.ts`) and the served host client over its bearer socket
 * (`host-client/transports.ts`), so the narrowing — which fields are forwarded, and the
 * absent-versus-null discipline — lives once for both. It imports no transport because the
 * served host client has no bridge; a file shared with the bridge binding would put the shell
 * command's name into the bundle a phone is handed, which `scan:host` refuses.
 */

import type { MailboxFacts } from "../../webapp/app/shell/mail-state";

/** What `GET /mailboxes` answers with, narrowed to the fields these two surfaces read. */
interface MailboxWire {
  id: string;
  address: string;
  /** The mailbox's user-facing label — `MailboxDTO.displayName`, null when nobody typed one. */
  displayName?: string | null;
  status: string;
  errorCode?: string | null;
  disabledReason?: string | null;
  syncBlockedReason?: string | null;
  syncBlockedSince?: string | null;
  /**
   * WHO ORGANIZES THIS MAILBOX, and whether that is this install.
   *
   * Unconditional on the polled row, so a reader is visible while `status` is `connected` —
   * which is the whole point of the split: a reader is CONNECTED AND SYNCING, not disabled.
   * Optional here because an engine older than the field is an ordinary state on a desktop that
   * updates on its own schedule; absent reads as `organizer`, which is what every install was
   * before the field existed.
   */
  organizerRole?: "organizer" | "reader";
  organizedBy?: { kind?: string | null; name?: string | null; since?: string | null } | null;
  organizerState?: "held" | "stopped" | null;
  lastSyncAt: string | null;
  initialImportCompletedAt?: string | null;
  smtpMaxSizeBytes?: number | null;
  /** Why sending is not set up, or absent/null when it is. See `MailboxFacts`. */
  sendingUnsettledReason?: string | null;
  /**
   * How many messages the ACCOUNT holds for this mailbox, as the local engine learned it from
   * the hosted mailbox list. Absent on a local-only install (there is no other copy to be
   * behind), absent before the engine's first counted refresh, and absent from any engine that
   * predates the field — all three are "cannot tell", which is what the shell's ladder does with
   * an absent number. Never confused with a count of the mirror: see `MailboxFacts`.
   */
  hostedMessageCount?: number;
  /**
   * HOW MUCH MAIL THE SERVER SAYS IS IN THIS MAILBOX — the local door's own Σ of
   * `mailbox_folders.server_exists` over the folders a cycle has opened (mail 0083).
   * It is the first pull's denominator: the mirror's own count is the numerator, and without
   * this there is no horizon — dropped, the first-run pull stage shows no remaining count, no
   * progress bar and never an ETA. Grows as the folder tree is walked, so a consumer must
   * clamp the remainder at zero rather than treat it as a fixed total (`pull-rate.ts` owns
   * that rule).
   */
  serverMessageCount?: number;
  /** When this install was told it may organize this mailbox (mail 0083); null pre-consent. */
  organizeConsentedAt?: string | null;
  /**
   * The once-only organizer notice's evidence pair, on the same rule as the quiet pair below:
   * absent is an engine that predates the columns, and the line is derived from a COMPARISON of
   * the two, so a `?? null` would turn silence into "changed, never acknowledged".
   */
  organizerEventAt?: string | null;
  organizerEventSeenAt?: string | null;
  /** When this install last gave this mailbox up on purpose — the pane's permanent line. */
  organizerReleasedAt?: string | null;
  /** The standing "stop organizing here" ask, pending until the engine's pass confirms it. */
  releaseRequestedAt?: string | null;
  /** The standing "organize here" press, spent by the gate's next pass. */
  takeoverAuthorizedAt?: string | null;
  /** Whether a decision made here would be accepted by whoever organizes this mailbox. */
  organizerAcceptsRequests?: boolean;
  /** How this mailbox is signed in — it decides one sentence about why a refusal is permanent. */
  authKind?: "password" | "oauth";
  /** OUR filings this mailbox has not applied yet — the strip's `filing` arm reads it. */
  pendingMoves?: number;
  /**
   * WHY those filings are outstanding — the count above split by the operand that decides.
   *
   * The local engine answers it like any other DTO field, with `lastCycleAt` null: there is no
   * heartbeat row here, because the organizer IS this process. The strip reads that null as
   * silence on the "last pass" clause rather than as "no pass has ever run", which is the whole
   * reason the field is nullable — a desktop must never be told its own organizer is dead.
   */
  filing?: {
    due: number;
    deferred: number;
    oldestPendingAt: string | null;
    nextAttemptAt: string | null;
    attempts: number;
    lastRefusalClass: string | null;
    asOf: string;
    lastCycleAt: string | null;
  };
  /**
   * The forwarding-detection notice's evidence pair (mail 0078): a standing quiet episode's
   * newest genuine inbound date, and this mailbox's dismissal. Absent on an engine that
   * predates the columns; forwarded by the `in`-spread below on the same rule as its
   * neighbours, because absent must render nothing rather than a false "no episode".
   */
  inboundQuietSince?: string | null;
  inboundQuietDismissedAt?: string | null;
  createdAt?: string;
}

/**
 * The same read over an INJECTED transport — the served host-client asks the identical question
 * over its bearer socket (`host-client/transports.ts`), and the absent-versus-null discipline
 * below must not be duplicated to be reused.
 */
export async function readMailboxFactsVia(
  fetchImpl: (url: string, init?: unknown) => Promise<Response>,
): Promise<MailboxFacts[]> {
  const res = await fetchImpl("/mailboxes");
  if (!res.ok) throw new Error(`the mail engine answered ${res.status} for the mailbox list`);
  const body = (await res.json()) as { items?: MailboxWire[] };
  return (body.items ?? []).map((m) => ({
    id: m.id,
    address: m.address,
    ...("displayName" in m ? { displayName: m.displayName } : {}),
    status: m.status,
    errorCode: m.errorCode ?? null,
    disabledReason: m.disabledReason ?? null,
    syncBlockedReason: m.syncBlockedReason ?? null,
    syncBlockedSince: m.syncBlockedSince ?? null,
    /* ABSENT READS AS `organizer`, deliberately: every install was one before the column existed,
       and an engine that predates it cannot have demoted anybody. The dangerous default is the
       other one — a window that assumed `reader` would put a claim banner on a mailbox this
       machine is already organizing. */
    organizerRole: m.organizerRole === "reader" ? "reader" : "organizer",
    /* ── SPREAD, BECAUSE ABSENT AND `null` ARE DIFFERENT ANSWERS HERE TOO ──────────────────
     * The DTO declares `organizedBy` non-optional (`dto/types.ts`) and the service projects it
     * unconditionally, so ABSENT can only mean an engine older than the field or a body that
     * did not answer — never "nobody organizes this mailbox". Normalizing absent to null here
     * made the first-run claim question's "no answer" arm unreachable: a lagging read took the
     * screen away and the next press authorizes a takeover. The object's own fields are still
     * normalized — a present object with missing members is a shape this narrowing owns. */
    ...("organizedBy" in m
      ? {
          organizedBy: m.organizedBy
            ? {
                kind: m.organizedBy.kind ?? null,
                name: m.organizedBy.name ?? null,
                since: m.organizedBy.since ?? null,
              }
            : null,
        }
      : {}),
    organizerState: m.organizerState ?? null,
    /* Read HERE and nowhere else: one line above coerces the absent role away, and this is the
       last point at which "the engine never sent one" can be told from "the engine said
       organizer". See `MailboxFacts.legacyStandDown`. */
    legacyStandDown: m.organizerRole === undefined && m.status === "disabled" && Boolean(m.disabledReason),
    lastSyncAt: m.lastSyncAt,
    ...("initialImportCompletedAt" in m
      ? { initialImportCompletedAt: m.initialImportCompletedAt }
      : {}),
    // WHAT THIS MAILBOX'S SUBMISSION SERVER SAID IT WILL ACCEPT (the connect-time probe's
    // RFC 1870 `SIZE`). Forwarded untouched, same rule as the line above: `null` is a server
    // that announced no ceiling, an ABSENT field is an engine that predates the column, and
    // the compose surface resolves both to the strict constant — but collapsing them here
    // would erase a distinction this shape documents. This field is the whole reason the
    // standalone door's attach cap can follow the user's own server instead of the hosted
    // constant; the engine has served it all along, and this narrowing used to drop it.
    ...("smtpMaxSizeBytes" in m ? { smtpMaxSizeBytes: m.smtpMaxSizeBytes } : {}),
    /* SPREAD, on the rule this file follows for every optional field: absent means an engine that
       predates the field and has nothing to say, which is a different answer from `null`
       ("sending is settled") even though both render the same. */
    ...("sendingUnsettledReason" in m
      ? { sendingUnsettledReason: m.sendingUnsettledReason }
      : {}),
    // THE ACCOUNT'S OWN COUNT, forwarded by the same `in` spread and for a sharper version of the
    // same reason: this is the denominator of the sentence "this device holds N of M", so a `?? 0`
    // here would not merely lose a field, it would assert that the account is empty and turn the
    // strip's comparison upside down. Absent must arrive absent. This seam has dropped a field
    // exactly once before — `smtpMaxSizeBytes`, on the line above — and it did so silently.
    ...("hostedMessageCount" in m ? { hostedMessageCount: m.hostedMessageCount } : {}),
    // ── THE FIELD THAT SAYS WHERE THE PULL ENDS ───────────────────────────────────────────
    // `serverMessageCount` is the local door's Σ of `server_exists`; unforwarded, `pullRemaining`
    // has no denominator and no surface can tell "the walk reached the end" from "still going".
    // Absent must arrive ABSENT, on `hostedMessageCount`'s rule above: a `?? 0` would claim the
    // server holds no mail — a confident wrong answer rather than a missing one.
    // A hand-written field list beside a growing wire drops fields silently, so
    // `test/desktop-facts-census.test.ts` derives the required set from `MailboxFacts` itself
    // and fails on any key this map does not forward.
    ...("serverMessageCount" in m ? { serverMessageCount: m.serverMessageCount } : {}),
    ...("organizeConsentedAt" in m ? { organizeConsentedAt: m.organizeConsentedAt } : {}),
    // THE ORGANIZER NOTICE'S PAIR, ITS RELEASE STAMP AND THE HOLDER'S ANSWER, forwarded by the
    // same `in` spread as every optional field here. The notice is a comparison of two instants
    // and the decision controls hang off the last of them, so absent must arrive absent: on an
    // engine that predates the columns the line stays silent and the controls stay withheld,
    // which is what a build that cannot tell should do.
    ...("organizerEventAt" in m ? { organizerEventAt: m.organizerEventAt } : {}),
    ...("organizerEventSeenAt" in m ? { organizerEventSeenAt: m.organizerEventSeenAt } : {}),
    ...("organizerReleasedAt" in m ? { organizerReleasedAt: m.organizerReleasedAt } : {}),
    // THE TWO PENDING ASKS, forwarded by the same `in` spread: absent is an engine that predates
    // the columns and withholds the pending sentence, which is what such an engine reports.
    ...("releaseRequestedAt" in m ? { releaseRequestedAt: m.releaseRequestedAt } : {}),
    ...("takeoverAuthorizedAt" in m ? { takeoverAuthorizedAt: m.takeoverAuthorizedAt } : {}),
    ...("organizerAcceptsRequests" in m ? { organizerAcceptsRequests: m.organizerAcceptsRequests } : {}),
    ...("authKind" in m ? { authKind: m.authKind } : {}),
    ...("pendingMoves" in m ? { pendingMoves: m.pendingMoves } : {}),
    // The filing SPLIT, by the same `in` spread and the same rule: an engine that predates it
    // must arrive with no key at all, so the strip falls back to the count alone rather than
    // rendering an arm with no reason in it.
    ...("filing" in m ? { filing: m.filing } : {}),
    // THE FORWARDING-DETECTION PAIR (mail 0078), forwarded by the same `in` spread and for the
    // same reason as every optional field above: absent is an engine that predates the columns
    // and must arrive absent, so the pane renders nothing rather than asserting "no episode".
    ...("inboundQuietSince" in m ? { inboundQuietSince: m.inboundQuietSince } : {}),
    ...("inboundQuietDismissedAt" in m ? { inboundQuietDismissedAt: m.inboundQuietDismissedAt } : {}),
    // ── NEVER `?? new Date()` ─────────────────────────────────────────────────────────────
    // `importFloorSpeaks` trusts an unwritten `initial_import_completed_at` absolutely for
    // `IMPORT_FLOOR_MAX_MS` (24 h) after `createdAt`. Defaulting an absent `createdAt` to NOW
    // re-based that window on every poll, so the bound could never elapse and the strip said
    // "Syncing your mail" for ever over a finished mirror.
    // The empty string is "the engine did not say", and every reader already treats an
    // unparseable stamp as unknown rather than as a time: `importFloorSpeaks`'s
    // `Number.isFinite` guard takes the CORROBORATED path, `earliest` skips it and
    // `minutesSince` answers null.
    createdAt: m.createdAt ?? "",
  }));
}
